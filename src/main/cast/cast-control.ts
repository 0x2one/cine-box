/**
 * DLNA 的 SOAP 控制：AVTransport / RenderingControl / ConnectionManager。
 *
 * 全部是普通 HTTP + XML，不需要原生模块。只实现投屏用得到的动作，
 * 状态由上层轮询（GENA 事件订阅留到以后）。
 */

import { escapeXml, xmlText } from './cast-xml'
import type { CastDevice, CastFetch } from './cast-types'

const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1'
const CONNECTION_MANAGER = 'urn:schemas-upnp-org:service:ConnectionManager:1'

const DEFAULT_TIMEOUT = 8000
const DEFAULT_HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl'

export interface CastTransportInfo {
  /** PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING / NO_MEDIA_PRESENT */
  state: string
  status: string
}

export interface CastPositionInfo {
  /** 秒 */
  position: number
  /** 秒；未知为 0 */
  duration: number
  rel: string
  durationText: string
}

export interface CastControl {
  getProtocolInfo: (device: CastDevice) => Promise<string[]>
  setAVTransportURI: (
    device: CastDevice,
    url: string,
    title: string,
    contentType: string
  ) => Promise<void>
  play: (device: CastDevice) => Promise<void>
  pause: (device: CastDevice) => Promise<void>
  stop: (device: CastDevice) => Promise<void>
  seek: (device: CastDevice, seconds: number) => Promise<void>
  getTransportInfo: (device: CastDevice) => Promise<CastTransportInfo>
  getPositionInfo: (device: CastDevice) => Promise<CastPositionInfo>
}

export interface CreateCastControlOptions {
  fetch: CastFetch
  timeoutMs?: number
}

/** 把 `00:12:34.567` / `0:00:01` 这类时间码转成秒 */
export function clockSeconds(value: string): number {
  const text = value.trim()
  if (!text || /^not[_-]?implemented$/i.test(text)) return 0
  const parts = text.split(':')
  const numbers = parts.map((part) => Number(part))
  if (numbers.some((number) => !Number.isFinite(number))) return 0
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1]
  return numbers[0] ?? 0
}

/** 秒 → `HH:MM:SS`，Seek 的 REL_TIME 参数 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(rest)}`
}

/** 从设备声明的 Sink 里挑一个它认的 HLS MIME；没声明就用标准值 */
export function pickHlsContentType(sink: string[]): string {
  const types = sink
    .map((item) => (item.split(':')[2] ?? '').trim())
    .filter((item) => Boolean(item))
  const hls = types.filter((item) => /(mpegurl|m3u8)/i.test(item))
  if (hls.length === 0) return DEFAULT_HLS_CONTENT_TYPE
  const preferred = [
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'application/mpegurl',
    'video/m3u8'
  ]
  for (const mime of preferred) {
    const hit = hls.find((item) => item.toLowerCase() === mime)
    if (hit) return hit
  }
  return hls[0]
}

/** DIDL-Lite 元数据：标题 + 视频类目 + 带 protocolInfo 的资源地址 */
export function buildDidl(title: string, url: string, contentType: string): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:${escapeXml(contentType)}:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  )
}

interface SoapError extends Error {
  code?: string
}

async function soap(
  controlUrl: string,
  serviceType: string,
  action: string,
  args: Record<string, string>,
  fetchFn: CastFetch,
  timeoutMs: number
): Promise<string> {
  if (!controlUrl) throw new Error(`${action} 失败：设备没有提供控制地址`)
  const inner = Object.entries(args)
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join('')
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`

  let response: Response
  try {
    response = await fetchFn(controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"${serviceType}#${action}"`,
        'User-Agent': 'Windows/10 UPnP/1.1 cine-box/1.0'
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${action} 请求失败：${reason}`, { cause: error })
  }

  let text = ''
  try {
    text = await response.text()
  } catch {
    // 少数设备会在错误响应里直接断连接，按下面的状态码处理
  }
  if (!response.ok) {
    const code = xmlText(text, 'errorCode')
    const description = xmlText(text, 'errorDescription')
    const failure: SoapError = new Error(
      description || `HTTP ${response.status}`
    )
    failure.code = code || `HTTP_${response.status}`
    throw failure
  }
  return text
}

export function createCastControl(options: CreateCastControlOptions): CastControl {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const call = (
    controlUrl: string,
    serviceType: string,
    action: string,
    args: Record<string, string>
  ): Promise<string> => soap(controlUrl, serviceType, action, args, options.fetch, timeoutMs)

  return {
    getProtocolInfo: async (device) => {
      if (!device.connectionManager) return []
      const xml = await call(device.connectionManager, CONNECTION_MANAGER, 'GetProtocolInfo', {})
      return xmlText(xml, 'Sink')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => Boolean(item))
    },

    setAVTransportURI: async (device, url, title, contentType) => {
      const metadata = buildDidl(title, url, contentType)
      await call(device.avTransport, AV_TRANSPORT, 'SetAVTransportURI', {
        InstanceID: '0',
        CurrentURI: url,
        CurrentURIMetaData: metadata
      })
    },

    play: async (device) => {
      await call(device.avTransport, AV_TRANSPORT, 'Play', {
        InstanceID: '0',
        Speed: '1'
      })
    },

    pause: async (device) => {
      await call(device.avTransport, AV_TRANSPORT, 'Pause', { InstanceID: '0' })
    },

    stop: async (device) => {
      await call(device.avTransport, AV_TRANSPORT, 'Stop', { InstanceID: '0' })
    },

    seek: async (device, seconds) => {
      await call(device.avTransport, AV_TRANSPORT, 'Seek', {
        InstanceID: '0',
        Unit: 'REL_TIME',
        Target: formatClock(seconds)
      })
    },

    getTransportInfo: async (device) => {
      const xml = await call(device.avTransport, AV_TRANSPORT, 'GetTransportInfo', {
        InstanceID: '0'
      })
      return {
        state: xmlText(xml, 'CurrentTransportState') || 'UNKNOWN',
        status: xmlText(xml, 'CurrentTransportStatus')
      }
    },

    getPositionInfo: async (device) => {
      const xml = await call(device.avTransport, AV_TRANSPORT, 'GetPositionInfo', {
        InstanceID: '0'
      })
      const rel = xmlText(xml, 'RelTime')
      const durationText = xmlText(xml, 'TrackDuration')
      return {
        position: clockSeconds(rel),
        duration: clockSeconds(durationText),
        rel,
        durationText
      }
    }
  }
}
