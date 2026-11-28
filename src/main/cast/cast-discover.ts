/**
 * DLNA 投屏的设备发现。
 *
 * 只做「够用」的 UPnP：SSDP M-SEARCH 找 MediaRenderer，拉设备描述，取 AVTransport /
 * RenderingControl / ConnectionManager 的控制地址。不做 GENA 事件订阅，状态由上层轮询。
 *
 * 两个实测出来的硬性要求：
 * - **每块网卡各绑一个 socket**。绑在 0.0.0.0 再用 setMulticastInterface 指定网卡，
 *   在 Windows 多网卡（含手机热点虚拟网卡）下会一台设备都发现不了。
 * - **多轮 M-SEARCH**。SSDP 是 UDP，单次搜索经常丢，实测同一网络会从 2 台变成 0 台。
 */

import dgram from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { xmlBlocks, xmlText } from './cast-xml'
import type { CastDevice, CastFetch } from './cast-types'

const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900
const MEDIA_RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1'
const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1'
const RENDERING_CONTROL = 'urn:schemas-upnp-org:service:RenderingControl:1'
const CONNECTION_MANAGER = 'urn:schemas-upnp-org:service:ConnectionManager:1'

/** 设备列表缓存：打开投屏面板时先给旧的，15 秒内不重复发 SSDP */
const DEVICE_CACHE_MS = 15_000
const MAX_DEVICES = 16

interface SsdpResponse {
  location: string
  usn: string
  server: string
}

function localIPv4(): string[] {
  const addresses: string[] = []
  const seen = new Set<string>()
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== 'IPv4') continue
        if (seen.has(entry.address)) continue
        seen.add(entry.address)
        addresses.push(entry.address)
      }
    }
  } catch {
    // 拿不到网卡列表时按「没有局域网地址」处理
  }
  return addresses
}

function searchPacket(st: string): Buffer {
  return Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 2',
      `ST: ${st}`,
      'USER-AGENT: Windows/10 UPnP/1.1 cine-box/1.0',
      '',
      ''
    ].join('\r\n')
  )
}

function parseHeaders(message: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of message.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return headers
}

/** 发 3 轮 M-SEARCH，收齐超时内的响应；同一 LOCATION 只留一条 */
function searchSsdp(timeoutMs: number): Promise<SsdpResponse[]> {
  const addresses = localIPv4()
  if (addresses.length === 0) return Promise.resolve([])

  return new Promise((resolve) => {
    const found = new Map<string, SsdpResponse>()
    const sockets: dgram.Socket[] = []
    const timers: NodeJS.Timeout[] = []
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) {
        try {
          socket.close()
        } catch {
          // 已经关掉
        }
      }
      resolve([...found.values()])
    }

    timers.push(setTimeout(finish, timeoutMs))

    for (const address of addresses) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      sockets.push(socket)
      socket.on('error', () => {})
      socket.on('message', (message) => {
        const text = message.toString('utf-8')
        if (!/^HTTP\/1\.1 200/i.test(text)) return
        const headers = parseHeaders(text)
        if (!headers.location) return
        if (found.has(headers.location)) return
        found.set(headers.location, {
          location: headers.location,
          usn: headers.usn ?? '',
          server: headers.server ?? ''
        })
      })
      socket.bind(0, address, () => {
        try {
          socket.setMulticastTTL(2)
        } catch {
          // 个别网卡不支持设置 TTL，不影响发送
        }
        for (let round = 0; round < 3; round += 1) {
          timers.push(
            setTimeout(() => {
              if (settled) return
              for (const st of [MEDIA_RENDERER, AV_TRANSPORT]) {
                const packet = searchPacket(st)
                try {
                  socket.send(packet, 0, packet.length, SSDP_PORT, SSDP_ADDRESS, () => {})
                } catch {
                  // 网卡被拔掉 / socket 已关闭
                }
              }
            }, round * 500)
          )
        }
      })
    }
  })
}

/** 拉设备描述，解析出名称和控制地址；不是 MediaRenderer 或缺 AVTransport 时返回 null */
async function readDevice(
  entry: SsdpResponse,
  fetchFn: CastFetch,
  timeoutMs: number
): Promise<CastDevice | null> {
  let response: Response
  try {
    response = await fetchFn(entry.location, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return null
  }
  if (!response.ok) return null
  let xml: string
  try {
    xml = await response.text()
  } catch {
    return null
  }

  const services = xmlBlocks(xml, 'service').map((block) => ({
    serviceType: xmlText(block, 'serviceType'),
    controlURL: xmlText(block, 'controlURL')
  }))
  const controlOf = (type: string): string =>
    services.find((item) => item.serviceType.toLowerCase() === type.toLowerCase())?.controlURL ?? ''
  const resolve = (value: string): string => {
    if (!value) return ''
    try {
      return new URL(value, entry.location).href
    } catch {
      return ''
    }
  }

  const avTransport = resolve(controlOf(AV_TRANSPORT))
  if (!avTransport) return null

  let host: string
  try {
    host = new URL(entry.location).hostname
  } catch {
    return null
  }

  const udn = xmlText(xml, 'UDN')
  const model = xmlText(xml, 'modelName')
  const manufacturer = xmlText(xml, 'manufacturer')
  const friendly = xmlText(xml, 'friendlyName')
  return {
    id: udn || entry.location,
    name: friendly || model || manufacturer || host,
    model,
    manufacturer,
    host,
    location: entry.location,
    avTransport,
    renderingControl: resolve(controlOf(RENDERING_CONTROL)),
    connectionManager: resolve(controlOf(CONNECTION_MANAGER))
  }
}

export interface CastDiscovery {
  /** 发现设备；refresh=true 时忽略缓存 */
  discover: (options?: { refresh?: boolean }) => Promise<CastDevice[]>
  /** 当前缓存里的设备；投屏开始时按 id 找控制地址 */
  find: (id: string) => CastDevice | null
  /** 最近一次发现的设备（不触发搜索） */
  devices: () => CastDevice[]
}

export interface CreateCastDiscoveryOptions {
  fetch: CastFetch
  /** SSDP 等响应的时长 */
  timeoutMs?: number
  /** 单个设备描述的请求超时 */
  descriptionTimeoutMs?: number
}

export function createCastDiscovery(options: CreateCastDiscoveryOptions): CastDiscovery {
  const timeoutMs = options.timeoutMs ?? 3200
  const descriptionTimeoutMs = options.descriptionTimeoutMs ?? 4000
  let cached: CastDevice[] = []
  let cachedAt = 0
  let inFlight: Promise<CastDevice[]> | null = null

  const run = async (): Promise<CastDevice[]> => {
    const entries = await searchSsdp(timeoutMs)
    const devices = await Promise.all(
      entries
        .slice(0, MAX_DEVICES)
        .map((entry) => readDevice(entry, options.fetch, descriptionTimeoutMs).catch(() => null))
    )
    const byId = new Map<string, CastDevice>()
    for (const device of devices) {
      if (device && !byId.has(device.id)) byId.set(device.id, device)
    }
    cached = [...byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN')
    )
    cachedAt = Date.now()
    return cached
  }

  const discover = async (input?: { refresh?: boolean }): Promise<CastDevice[]> => {
    if (!input?.refresh && cached.length > 0 && Date.now() - cachedAt < DEVICE_CACHE_MS) {
      return cached
    }
    if (inFlight) return inFlight
    inFlight = run().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    discover,
    find: (id) => cached.find((device) => device.id === id) ?? null,
    devices: () => cached
  }
}
