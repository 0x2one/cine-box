import { session } from 'electron'
import {
  describeNetwork,
  isValidProxyEndpoint,
  networkProxyKey,
  normalizeNetworkSettings,
  proxyAddress,
  resolveTestUrl,
  type NetworkSettings
} from './network-types'
import { startProxyBridge, type ProxyBridge, type ProxyBridgeError } from './proxy-bridge'

/**
 * 把「设置 › 网络」的代理配置套到 Chromium 网络栈上。
 *
 * - 禁用：显式 `direct`，保证系统代理开着也不走；
 * - 系统代理：交给 Chromium 读操作系统设置；
 * - 自定义：本机代理桥接（见 proxy-bridge.ts）+ 无认证 SOCKS5 本地入口，
 *   HTTP / HTTPS / 视频分片 / 页面封面全部经由它在内网与本机之外转发。
 *
 * 本地数据（cine-img / cine-file 自定义协议、SQLite、下载缓存包、本机播放服务、
 * 局域网服务自身的监听）不经过 Chromium 网络栈，天然不受代理影响；回环地址与
 * 局域网网段另外写进 bypass 规则，保证 127.0.0.1 上的本机服务始终直连。
 */

/** 这些地址永远直连：本机播放服务、局域网共享页、内网资源 */
const BYPASS_RULES = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  '<local>',
  '.local',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16'
].join(',')

/** 代理验证的独立内存会话：不碰默认会话的缓存与连接池 */
const TEST_PARTITION = 'cinebox-network-test'
const VERIFY_TIMEOUT = 20_000

export type NetworkApplyError = 'INVALID_PROXY' | 'BRIDGE_FAILED'

export interface NetworkApplyResult {
  ok: boolean
  error?: NetworkApplyError
  message?: string
}

export type NetworkTestError =
  | 'INVALID_URL'
  | 'INVALID_PROXY'
  | 'PROXY_UNREACHABLE'
  | 'PROXY_AUTH'
  | 'PROXY_CONNECT_FAILED'
  | 'PROXY_PROTOCOL'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BRIDGE_FAILED'

export interface NetworkTestResult {
  ok: boolean
  /** 实际验证的地址 */
  url: string
  /** HTTP 状态码，没拿到响应时为 0 */
  status: number
  elapsedMs: number
  /** 这次验证使用的代理说明 */
  proxy: string
  error?: NetworkTestError
  message: string
}

export interface NetworkManager {
  /** 套用配置；重复套用同一份配置不会断开现有连接 */
  apply: (settings: NetworkSettings) => Promise<NetworkApplyResult>
  /** 用当前草稿配置（未保存也可以）验证代理链路 */
  test: (settings: unknown, url?: unknown) => Promise<NetworkTestResult>
  dispose: () => Promise<void>
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? 'UNKNOWN')
}

function mapBridgeFailure(failure: ProxyBridgeError, settings: NetworkSettings): NetworkTestResult {
  const base = { ok: false, url: '', status: 0, elapsedMs: 0, proxy: describeNetwork(settings) }
  switch (failure.code) {
    case 'AUTH':
      return { ...base, error: 'PROXY_AUTH', message: failure.message }
    case 'UNREACHABLE':
      return {
        ...base,
        error: 'PROXY_UNREACHABLE',
        message: `${failure.message}（${proxyAddress(settings)}）`
      }
    case 'CONNECT_FAILED':
      return { ...base, error: 'PROXY_CONNECT_FAILED', message: failure.message }
    case 'TIMEOUT':
      return { ...base, error: 'TIMEOUT', message: failure.message }
    default:
      return { ...base, error: 'PROXY_PROTOCOL', message: failure.message }
  }
}

export function createNetworkManager(): NetworkManager {
  let bridge: ProxyBridge | null = null
  let appliedKey = ''
  /** 套用配置必须串行（要替换本机桥接），验证用的是独立会话，可以各走各的 */
  let applyQueue: Promise<unknown> = Promise.resolve()
  let testQueue: Promise<unknown> = Promise.resolve()

  const serialize = <T>(target: 'apply' | 'test', task: () => Promise<T>): Promise<T> => {
    const current = target === 'apply' ? applyQueue : testQueue
    const next = current.then(task, task)
    if (target === 'apply') applyQueue = next.catch(() => {})
    else testQueue = next.catch(() => {})
    return next
  }

  const releaseBridge = async (target: ProxyBridge | null): Promise<void> => {
    if (!target) return
    try {
      await target.dispose()
    } catch {
      // 已经关闭
    }
  }

  const applyInternal = async (raw: NetworkSettings): Promise<NetworkApplyResult> => {
    const settings = normalizeNetworkSettings(raw)
    const key = networkProxyKey(settings)
    if (key === appliedKey) return { ok: true }

    const ses = session.defaultSession
    const previous = bridge
    bridge = null
    await releaseBridge(previous)

    try {
      if (settings.mode === 'custom') {
        if (!isValidProxyEndpoint(settings)) {
          await ses.setProxy({ mode: 'direct' })
          await ses.closeAllConnections().catch(() => {})
          appliedKey = ''
          return {
            ok: false,
            error: 'INVALID_PROXY',
            message: '代理服务器地址或端口不完整，已改为直连'
          }
        }
        const started = await startProxyBridge({
          type: settings.type,
          host: settings.host,
          port: settings.port,
          authEnabled: settings.authEnabled,
          username: settings.username,
          password: settings.password
        })
        bridge = started
        await ses.setProxy({
          mode: 'fixed_servers',
          proxyRules: `socks5://127.0.0.1:${started.port}`,
          proxyBypassRules: BYPASS_RULES
        })
      } else if (settings.mode === 'system') {
        await ses.setProxy({ mode: 'system' })
      } else {
        await ses.setProxy({ mode: 'direct' })
      }
      // 旧配置下已经建立的连接可能还走旧线路：断掉，后续请求按新配置重连
      await ses.closeAllConnections().catch(() => {})
      appliedKey = key
      return { ok: true }
    } catch (error) {
      await releaseBridge(bridge)
      bridge = null
      // 套用失败时退回直连：宁可暂时不代理，也不要让整个应用断网
      await ses.setProxy({ mode: 'direct' }).catch(() => {})
      await ses.closeAllConnections().catch(() => {})
      appliedKey = ''
      return {
        ok: false,
        error: 'BRIDGE_FAILED',
        message: `代理启用失败，已临时改为直连：${describeUnknownError(error)}`
      }
    }
  }

  const testInternal = async (raw: unknown, rawUrl: unknown): Promise<NetworkTestResult> => {
    const settings = normalizeNetworkSettings(raw)
    const url = resolveTestUrl(typeof rawUrl === 'string' ? rawUrl : settings.testUrl)
    const proxy = describeNetwork(settings)
    const started = Date.now()
    if (!url) {
      return {
        ok: false,
        url: '',
        status: 0,
        elapsedMs: 0,
        proxy,
        error: 'INVALID_URL',
        message: '验证地址必须是 http 或 https 链接'
      }
    }
    if (settings.mode === 'custom' && !isValidProxyEndpoint(settings)) {
      return {
        ok: false,
        url,
        status: 0,
        elapsedMs: 0,
        proxy,
        error: 'INVALID_PROXY',
        message: '请先填写完整的代理服务器地址和端口'
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT)
    let testBridge: ProxyBridge | null = null
    const ses = session.fromPartition(TEST_PARTITION, { cache: false })
    try {
      if (settings.mode === 'custom') {
        try {
          testBridge = await startProxyBridge({
            type: settings.type,
            host: settings.host,
            port: settings.port,
            authEnabled: settings.authEnabled,
            username: settings.username,
            password: settings.password
          })
        } catch (error) {
          return {
            ok: false,
            url,
            status: 0,
            elapsedMs: Date.now() - started,
            proxy,
            error: 'BRIDGE_FAILED',
            message: `本机代理入口启动失败：${describeUnknownError(error)}`
          }
        }
        await ses.setProxy({
          mode: 'fixed_servers',
          proxyRules: `socks5://127.0.0.1:${testBridge.port}`
        })
      } else if (settings.mode === 'system') {
        await ses.setProxy({ mode: 'system' })
      } else {
        await ses.setProxy({ mode: 'direct' })
      }

      const response = await ses.fetch(url, { cache: 'no-store', signal: controller.signal })
      const elapsedMs = Date.now() - started
      const status = response.status
      await response.body?.cancel().catch(() => {})
      const reachable = status >= 200 && status < 400
      return {
        ok: true,
        url,
        status,
        elapsedMs,
        proxy,
        message: reachable
          ? `代理连接正常（HTTP ${status}）· 用时 ${elapsedMs} ms`
          : `代理已连通，目标返回 HTTP ${status} · 用时 ${elapsedMs} ms`
      }
    } catch (error) {
      const elapsedMs = Date.now() - started
      if (controller.signal.aborted) {
        return {
          ok: false,
          url,
          status: 0,
          elapsedMs,
          proxy,
          error: 'TIMEOUT',
          message: `验证超时（${Math.round(VERIFY_TIMEOUT / 1000)} 秒），请检查代理服务器与验证地址`
        }
      }
      const failure = testBridge?.lastError()
      if (failure) {
        return { ...mapBridgeFailure(failure, settings), url, elapsedMs }
      }
      const text = describeUnknownError(error)
      return {
        ok: false,
        url,
        status: 0,
        elapsedMs,
        proxy,
        error: 'NETWORK',
        message:
          settings.mode === 'custom' ? `无法通过代理完成请求：${text}` : `网络请求失败：${text}`
      }
    } finally {
      clearTimeout(timer)
      await releaseBridge(testBridge)
      await ses.setProxy({ mode: 'direct' }).catch(() => {})
      await ses.closeAllConnections().catch(() => {})
    }
  }

  return {
    apply: (settings) => serialize('apply', () => applyInternal(settings)),
    test: (settings, url) => serialize('test', () => testInternal(settings, url)),
    dispose: async () => {
      await releaseBridge(bridge)
      bridge = null
      appliedKey = ''
    }
  }
}
