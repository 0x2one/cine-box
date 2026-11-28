/**
 * 投屏会话状态机。
 *
 * 负责：发现缓存 → 解析片源（委托给 index.ts，主进程校验 URL / 缓存记录）→
 * 起临时 HTTP 服务 → 挑同网段 IP → SetAVTransportURI + Play → 轮询电视状态。
 *
 * 电视只看到 `http://<lan-ip>:<port>/cast/...`，第三方地址 / 缓存路径都由这里接管。
 */

import { networkInterfaces } from 'node:os'
import { isIPv4 } from 'node:net'
import type { LanCacheFile } from '../lan/lan-types'
import { createCastControl, pickHlsContentType, type CastControl } from './cast-control'
import { createCastDiscovery, type CastDiscovery } from './cast-discover'
import { resolveMediaPlaylist } from './cast-playlist'
import { createCastServer, type CastServer } from './cast-server'
import type {
  CastDevice,
  CastDeviceListResult,
  CastDeviceView,
  CastErrorCode,
  CastFetch,
  CastResolveResult,
  CastStartInput,
  CastStartResult,
  CastState
} from './cast-types'

const POLL_INTERVAL = 2000
const START_TIMEOUT = 12_000
const MAX_POLL_FAILURES = 3

const MESSAGES: Record<CastErrorCode, string> = {
  INVALID_INPUT: '投屏参数不完整',
  NO_DEVICE: '找不到这台设备，刷新设备列表后重试',
  DEVICE_OFFLINE: '电视已离线，投屏结束',
  NOT_FOUND: '这一集已失效，重新打开后再投',
  NOT_HLS: '这条线路不是 m3u8，暂不支持投屏',
  ADULT_HIDDEN: '该内容已被隐藏，无法投屏',
  NO_LAN_ADDRESS: '电脑没有局域网地址，检查 Wi-Fi / 网线',
  SERVER_FAILED: '启动投屏服务失败，检查防火墙或端口占用',
  SOAP_FAILED: '电视拒绝了投屏请求',
  TIMEOUT: '等待电视响应超时',
  UNSUPPORTED: '电视没有开始播放，可能不支持当前片源'
}

export interface CastMediaInput {
  kind: 'remote' | 'cache'
  videoId?: number
  url?: string
  recordId?: string
}

export interface CastServiceOptions {
  fetch: CastFetch
  /** 由 index.ts 提供：校验 URL 归属 / 缓存记录，并补片名 */
  resolveMedia: (input: CastMediaInput) => Promise<CastResolveResult>
  cachedFile: (recordId: string, relativePath: string) => Promise<LanCacheFile | null>
  onChange?: (state: CastState) => void
  /** 测试注入（不传就按生产实现创建） */
  discovery?: CastDiscovery
  control?: CastControl
  server?: CastServer
}

export interface CastService {
  state: () => CastState
  devices: (input?: { refresh?: boolean }) => Promise<CastDeviceListResult>
  start: (input: CastStartInput) => Promise<CastStartResult>
  stop: () => Promise<CastState>
  pause: () => Promise<CastState>
  resume: () => Promise<CastState>
  seek: (seconds: number) => Promise<CastState>
  dispose: () => void
}

function idleState(position = 0, duration = 0): CastState {
  return { active: false, status: 'idle', position, duration }
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function isVirtualInterface(name: string): boolean {
  return /(vethernet|vmware|virtualbox|hyper-v|wsl|docker|veth|br-|bridge|utun|awdl|llw|tailscale|zerotier|radmin|tap|tun|ppp|bluetooth|本地连接\*|loopback)/i.test(
    name
  )
}

/**
 * 选一块和电视同网段的本机 IPv4。
 * 多网卡（含热点 / 虚拟机网卡）下不能只拿第一块，找同网段最稳。
 */
export function pickLocalAddress(remoteHost: string): string | null {
  const candidates: Array<{ name: string; address: string; netmask: string }> = []
  try {
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== 'IPv4') continue
        candidates.push({ name, address: entry.address, netmask: entry.netmask })
      }
    }
  } catch {
    return null
  }
  if (candidates.length === 0) return null

  if (isIPv4(remoteHost)) {
    const remote = ipv4ToInt(remoteHost)
    if (remote !== null) {
      for (const item of candidates) {
        const local = ipv4ToInt(item.address)
        const mask = ipv4ToInt(item.netmask)
        if (local === null || mask === null) continue
        if ((local & mask) === (remote & mask)) return item.address
      }
    }
  }

  const real = candidates.find((item) => !isVirtualInterface(item.name))
  return real?.address ?? candidates[0].address
}

function toView(device: CastDevice): CastDeviceView {
  return {
    id: device.id,
    name: device.name,
    modelDescription: device.modelDescription,
    host: device.host,
    port: device.port
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function createCastService(options: CastServiceOptions): CastService {
  const discovery =
    options.discovery ??
    createCastDiscovery({
      fetch: options.fetch
    })
  const control =
    options.control ??
    createCastControl({
      fetch: options.fetch
    })
  const server =
    options.server ??
    createCastServer({
      fetch: options.fetch,
      cachedFile: options.cachedFile
    })

  let state: CastState = idleState()
  let device: CastDevice | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let starting = false
  let sawPlaying = false
  let startedAt = 0
  let pollFailures = 0
  /** 每次 start 递增；stop / dispose 也递增，用来丢弃已取消的启动流程 */
  let generation = 0

  const emit = (): void => {
    try {
      options.onChange?.({ ...state })
    } catch {
      // 渲染层已销毁时忽略
    }
  }

  const setState = (patch: Partial<CastState>): void => {
    state = { ...state, ...patch }
    emit()
  }

  const clearPoll = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const fail = (code: CastErrorCode, patch?: Partial<CastState>): CastStartResult => {
    const message = MESSAGES[code]
    state = { ...idleState(), ...patch, active: false, status: 'error', error: message }
    emit()
    return { ok: false, error: code, message, state }
  }

  /** 结束会话：停轮询、关服务、停电视（尽力），可带一条错误说明 */
  const endSession = async (message?: string): Promise<void> => {
    clearPoll()
    const current = device
    device = null
    if (current) {
      try {
        await control.stop(current)
      } catch {
        // 设备已经离线 / 拒绝，忽略
      }
    }
    server.closeSession()
    try {
      await server.stop()
    } catch {
      // 已经关闭
    }
    const position = state.position
    const duration = state.duration
    state = message
      ? { active: false, status: 'error', position, duration, error: message }
      : idleState(position, duration)
    emit()
  }

  const poll = async (): Promise<void> => {
    const current = device
    if (!current) return
    try {
      const [info, position] = await Promise.all([
        control.getTransportInfo(current),
        control.getPositionInfo(current).catch(() => null)
      ])
      pollFailures = 0
      const transport = info.state
      if (transport === 'PLAYING') {
        sawPlaying = true
        setState({
          status: 'playing',
          error: undefined,
          position: position?.position ?? state.position,
          duration: position?.duration || state.duration
        })
        return
      }
      if (transport === 'PAUSED_PLAYBACK' || transport === 'PAUSED_RECORDING') {
        setState({
          status: 'paused',
          position: position?.position ?? state.position,
          duration: position?.duration || state.duration
        })
        return
      }
      if (!sawPlaying && Date.now() - startedAt > START_TIMEOUT) {
        clearPoll()
        await endSession(MESSAGES.UNSUPPORTED)
        return
      }
      if (sawPlaying && (transport === 'STOPPED' || transport === 'NO_MEDIA_PRESENT')) {
        clearPoll()
        await endSession('电视已停止播放')
        return
      }
      setState({
        position: position?.position ?? state.position,
        duration: position?.duration || state.duration
      })
    } catch {
      pollFailures += 1
      if (pollFailures >= MAX_POLL_FAILURES) {
        clearPoll()
        await endSession(MESSAGES.DEVICE_OFFLINE)
      }
    }
  }

  const beginPolling = (): void => {
    clearPoll()
    pollTimer = setInterval(() => {
      void poll()
    }, POLL_INTERVAL)
  }

  const devices = async (input?: { refresh?: boolean }): Promise<CastDeviceListResult> => {
    try {
      const list = await discovery.discover({ refresh: input?.refresh })
      return { ok: true, devices: list.map(toView) }
    } catch {
      return { ok: false, devices: [], error: '搜索投屏设备失败，检查网络后重试' }
    }
  }

  const start = async (input: CastStartInput): Promise<CastStartResult> => {
    if (starting) return { ok: false, error: 'INVALID_INPUT', message: '正在连接电视，请稍候', state }
    const deviceId = typeof input?.deviceId === 'string' ? input.deviceId.trim() : ''
    if (!deviceId) return fail('INVALID_INPUT')
    if (input.kind === 'remote') {
      if (!Number.isInteger(input.videoId) || input.videoId <= 0 || !input.url) {
        return fail('INVALID_INPUT')
      }
    } else if (input.kind === 'cache') {
      if (!/^[0-9a-f]{32}$/i.test(input.recordId ?? '')) return fail('INVALID_INPUT')
    } else {
      return fail('INVALID_INPUT')
    }

    starting = true
    const run = ++generation
    const cancelled = (): boolean => run !== generation
    const cancelResult = (): CastStartResult => ({
      ok: false,
      error: 'INVALID_INPUT',
      message: '投屏已取消',
      state
    })
    try {
      if (state.active) await endSession()

      let target = discovery.find(deviceId)
      if (!target) {
        await discovery.discover({ refresh: true })
        target = discovery.find(deviceId)
      }
      if (!target) return fail('NO_DEVICE')

      const resolved = await options.resolveMedia(
        input.kind === 'remote'
          ? { kind: 'remote', videoId: input.videoId, url: input.url }
          : { kind: 'cache', recordId: input.recordId }
      )
      if (cancelled()) return cancelResult()
      if (!resolved.ok || !resolved.media) {
        return fail(resolved.error ?? 'NOT_FOUND', { error: resolved.message })
      }
      const media = resolved.media

      const localAddress = pickLocalAddress(target.host)
      if (!localAddress) return fail('NO_LAN_ADDRESS')

      // master playlist 先压成一条媒体列表，很多 DLNA 渲染器不会自己选变体
      const castUrl =
        media.mode === 'hls' && media.url
          ? await resolveMediaPlaylist(options.fetch, media.url)
          : undefined
      if (cancelled()) return cancelResult()

      let port: number
      try {
        port = await server.start()
      } catch {
        return fail('SERVER_FAILED')
      }
      if (cancelled()) {
        await server.stop()
        return cancelResult()
      }

      const path = server.openSession({
        kind: media.mode === 'cache' ? 'cache' : 'remote',
        url: castUrl,
        recordId: media.recordId,
        title: media.title,
        episodeName: media.episodeName
      })
      const mediaUrl = `http://${localAddress}:${port}${path}`

      device = target
      sawPlaying = false
      pollFailures = 0
      startedAt = Date.now()
      const startPosition = Number(input.position)
      const resumeAt =
        Number.isFinite(startPosition) && startPosition > 1 ? Math.floor(startPosition) : 0
      state = {
        active: true,
        status: 'starting',
        deviceId: target.id,
        deviceName: target.name,
        mode: media.mode,
        title: media.title,
        episodeName: media.episodeName,
        position: resumeAt,
        duration: 0
      }
      emit()

      let sink: string[] = []
      try {
        sink = await withTimeout(control.getProtocolInfo(target), 5000)
      } catch {
        sink = []
      }
      const contentType = pickHlsContentType(sink)
      const didlTitle = [media.title, media.episodeName].filter(Boolean).join(' · ')

      if (cancelled()) {
        await endSession()
        return cancelResult()
      }
      try {
        await control.setAVTransportURI(target, mediaUrl, didlTitle, contentType)
        await control.play(target)
      } catch (error) {
        const message = error instanceof Error ? error.message : MESSAGES.SOAP_FAILED
        await endSession(message || MESSAGES.SOAP_FAILED)
        return { ok: false, error: 'SOAP_FAILED', message: state.error, state }
      }
      // 电视起播后再跳进度：刚 SetURI 时部分设备会忽略 Seek
      if (resumeAt > 0) {
        setTimeout(() => {
          if (cancelled()) return
          void control.seek(target, resumeAt).catch(() => {})
        }, 600)
      }
      if (cancelled()) {
        await endSession()
        return cancelResult()
      }

      beginPolling()
      // 给设备一点起播时间，第一次轮询失败也不会立刻判死
      void poll()
      return { ok: true, state }
    } catch (error) {
      const message = error instanceof Error ? error.message : MESSAGES.SOAP_FAILED
      await endSession(message)
      return { ok: false, error: 'SOAP_FAILED', message, state }
    } finally {
      starting = false
    }
  }

  const stop = async (): Promise<CastState> => {
    generation += 1
    await endSession()
    return state
  }

  const pause = async (): Promise<CastState> => {
    if (!device || !state.active) return state
    try {
      await control.pause(device)
      setState({ status: 'paused' })
    } catch (error) {
      const message = error instanceof Error ? error.message : MESSAGES.SOAP_FAILED
      setState({ status: 'error', error: message })
    }
    return state
  }

  const resume = async (): Promise<CastState> => {
    if (!device || !state.active) return state
    try {
      await control.play(device)
      setState({ status: 'playing', error: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : MESSAGES.SOAP_FAILED
      setState({ status: 'error', error: message })
    }
    return state
  }

  const seek = async (seconds: number): Promise<CastState> => {
    if (!device || !state.active) return state
    const target = Number(seconds)
    if (!Number.isFinite(target) || target < 0) return state
    try {
      await control.seek(device, target)
      setState({ position: target })
    } catch {
      // 有的设备不支持 Seek，保持原状态
    }
    return state
  }

  return {
    state: () => ({ ...state }),
    devices,
    start,
    stop,
    pause,
    resume,
    seek,
    dispose: () => {
      generation += 1
      clearPoll()
      device = null
      server.dispose()
      state = idleState(state.position, state.duration)
    }
  }
}
