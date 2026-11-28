import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { isHttpUrl } from './lan-media-url'
import type { LanFetch, LanVideoDetail } from './lan-types'

export const PROXY_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UPSTREAM_TIMEOUT = 20_000
const IMAGE_TIMEOUT = 30_000
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_ALLOWED_ORIGINS = 400
const MAX_IMAGE_ORIGINS = 1200

/** 这些标签里的 URI 指向另一份播放列表；其余标签（KEY / MAP / PART…）都是分片或密钥 */
const PLAYLIST_URI_TAGS = new Set([
  '#EXT-X-MEDIA',
  '#EXT-X-I-FRAME-STREAM-INF',
  '#EXT-X-IMAGE-STREAM-INF',
  '#EXT-X-RENDITION-REPORT'
])

const FORWARDED_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control'
]

export interface MediaProxy {
  /** 播放页打开详情后登记这份视频的播放地址来源，之后才允许代理 */
  allowDetail: (video: LanVideoDetail) => void
  /** 直接登记若干播放地址的来源（投屏会话用：只放行当前这一集所在的域） */
  allowUrls: (urls: string[]) => void
  /** 列表 / 检索 / 详情返回后登记封面来源，网页端的封面代理只放行这些域 */
  allowImages: (payload: unknown) => void
  handlePlaylist: (req: IncomingMessage, res: ServerResponse, target: URL) => Promise<void>
  handleStream: (req: IncomingMessage, res: ServerResponse, target: URL) => Promise<void>
  handleImage: (req: IncomingMessage, res: ServerResponse, target: URL) => Promise<void>
}

interface Upstream {
  response: Response
  controller: AbortController
}

function tagName(line: string): string {
  const index = line.indexOf(':')
  return index < 0 ? line : line.slice(0, index)
}

function resolveHttp(value: string, base: string): string {
  try {
    const resolved = new URL(value, base)
    return isHttpUrl(resolved.href) ? resolved.href : ''
  } catch {
    return ''
  }
}

function proxyPath(kind: 'play' | 'stream', url: string): string {
  // 播放列表故意带 .m3u8 后缀：iOS Safari 原生 HLS 对扩展名更友好
  return `/${kind === 'play' ? 'api/play.m3u8' : 'api/stream'}?u=${encodeURIComponent(url)}`
}

function sendProxyError(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ ok: false, error })
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

/**
 * HLS / 视频字节代理。
 *
 * 网页端和桌面端不同：浏览器会受 CORS、Referer 防盗链、混合内容限制，第三方播放地址
 * 直连不一定能播。这里由主进程用 Chromium 的网络栈去取，再把播放列表里的相对地址
 * 全部改写成走本服务的绝对路径。为了不变成任人使唤的公网代理，只代理「播放页详情里
 * 出现过的来源域」以及这些播放列表里引用到的域。
 */
export function createMediaProxy(fetch: LanFetch): MediaProxy {
  const allowedOrigins = new Set<string>()

  const rememberOrigin = (url: string): void => {
    try {
      const parsed = new URL(url)
      if (!isHttpUrl(parsed.href)) return
      if (allowedOrigins.size >= MAX_ALLOWED_ORIGINS) {
        const first = allowedOrigins.values().next().value
        if (first) allowedOrigins.delete(first)
      }
      allowedOrigins.add(parsed.origin)
    } catch {
      // 相对地址 / data: 地址不用登记
    }
  }

  const isAllowed = (target: URL): boolean =>
    isHttpUrl(target.href) && allowedOrigins.has(target.origin)

  /* ── 封面代理 ──
   * 网页端跑在别人的浏览器里，直连封面既不受桌面端代理控制，也常被防盗链拦住。
   * 列表 / 检索 / 详情都返回封面地址，这里顺手登记来源域，网页端的 /api/image
   * 只放行登记过的域，避免这个接口变成公网图片代理。 */
  const imageOrigins = new Set<string>()

  const rememberImageOrigin = (value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return
    try {
      const parsed = new URL(value)
      if (!isHttpUrl(parsed.href)) return
      if (imageOrigins.size >= MAX_IMAGE_ORIGINS) {
        const first = imageOrigins.values().next().value
        if (first) imageOrigins.delete(first)
      }
      imageOrigins.add(parsed.origin)
    } catch {
      // data: / 相对地址不用登记
    }
  }

  const rememberImageValues = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) rememberImageValues(item, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    rememberImageOrigin(record.pic)
    if (Array.isArray(record.picCandidates)) {
      for (const item of record.picCandidates.slice(0, 50)) rememberImageOrigin(item)
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') rememberImageValues(child, depth + 1)
    }
  }

  const allowImages: MediaProxy['allowImages'] = (payload) => {
    rememberImageValues(payload, 0)
  }

  const isAllowedImage = (target: URL): boolean =>
    isHttpUrl(target.href) && imageOrigins.has(target.origin)

  const isPrivateIpv4 = (host: string): boolean => {
    const parts = host.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
    const [a, b] = parts
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }

  /** 本机 / 内网 / .local：不允许局域网页面借图片代理访问（SSRF 防护的最低限度） */
  const isLocalOrPrivateHost = (hostname: string): boolean => {
    const host = hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
    if (!host) return true
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
      return true
    }
    const family = isIP(host)
    if (family === 0) return false
    if (family === 4) return isPrivateIpv4(host)
    if (host === '::' || host === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
    if (mapped) return isPrivateIpv4(mapped[1])
    return false
  }

  const upstreamHeaders = (
    target: URL,
    options: { range?: string; accept?: string; noCache?: boolean }
  ): Headers => {
    const headers = new Headers({
      'User-Agent': PROXY_USER_AGENT,
      Accept: options.accept ?? '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${target.origin}/`
    })
    if (options.range) headers.set('Range', options.range)
    if (options.noCache) headers.set('Cache-Control', 'no-cache')
    return headers
  }

  const openUpstream = async (
    target: URL,
    options: { range?: string; accept?: string; method?: 'GET' | 'HEAD'; noCache?: boolean }
  ): Promise<Upstream> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT)
    try {
      const response = await fetch(target.href, {
        method: options.method ?? 'GET',
        headers: upstreamHeaders(target, options),
        redirect: 'follow',
        signal: controller.signal
      })
      return { response, controller }
    } finally {
      clearTimeout(timer)
    }
  }

  const rewriteLine = (line: string, isMaster: boolean, base: string): string => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (trimmed.startsWith('#')) {
      if (!trimmed.includes('URI="')) return line
      const playlistTag = PLAYLIST_URI_TAGS.has(tagName(trimmed).toUpperCase())
      return trimmed.replace(/URI="([^"]*)"/gi, (whole, raw: string) => {
        const absolute = resolveHttp(raw, base)
        if (!absolute) return whole
        rememberOrigin(absolute)
        return `URI="${proxyPath(playlistTag ? 'play' : 'stream', absolute)}"`
      })
    }
    const absolute = resolveHttp(trimmed, base)
    if (!absolute) return line
    rememberOrigin(absolute)
    // 主播放列表里的裸地址都是子播放列表（清晰度 / 音轨），媒体播放列表里的是分片
    return proxyPath(isMaster ? 'play' : 'stream', absolute)
  }

  /** 把播放列表里的地址改写成走代理；同时把引用到的域登记进允许列表 */
  const rewritePlaylist = (text: string, base: string): string => {
    const lines = text.split(/\r\n|\n|\r/)
    const isMaster = lines.some((line) =>
      line.trimStart().toUpperCase().startsWith('#EXT-X-STREAM-INF')
    )
    return lines.map((line) => rewriteLine(line, isMaster, base)).join('\n')
  }

  const allowDetail: MediaProxy['allowDetail'] = (video) => {
    allowImages(video)
    for (const source of video.sources) {
      for (const line of source.lines) {
        for (const episode of line.episodes) rememberOrigin(episode.url)
      }
    }
  }

  const allowUrls: MediaProxy['allowUrls'] = (urls) => {
    for (const url of urls) rememberOrigin(url)
  }

  /**
   * 封面：由主进程取字节再下发，网页端的远程封面因此也走桌面端代理。
   * 只放行列表 / 检索 / 详情里出现过的来源域，且目标不能是本机 / 内网地址。
   */
  const handleImage: MediaProxy['handleImage'] = async (req, res, target) => {
    if (!isAllowedImage(target)) {
      sendProxyError(res, 403, 'FORBIDDEN')
      return
    }
    if (isLocalOrPrivateHost(target.hostname)) {
      sendProxyError(res, 403, 'PRIVATE_HOST')
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT)
    try {
      const response = await fetch(target.href, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: {
          'User-Agent': PROXY_USER_AGENT,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        redirect: 'follow',
        signal: controller.signal
      })
      if (!response.ok) {
        sendProxyError(res, 502, `UPSTREAM_HTTP_${response.status}`)
        return
      }
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_IMAGE_BYTES) {
        sendProxyError(res, 413, 'IMAGE_TOO_LARGE')
        return
      }
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      const looksLikeImage =
        contentType.startsWith('image/') ||
        contentType === '' ||
        contentType === 'application/octet-stream' ||
        contentType === 'binary/octet-stream'
      if (!looksLikeImage) {
        sendProxyError(res, 415, 'NOT_IMAGE')
        return
      }
      const headers: Record<string, string | number> = {
        'Content-Type': contentType || 'application/octet-stream',
        // 封面基本不变，放浏览器缓存一会儿，减少每次翻页都回源
        'Cache-Control': 'public, max-age=600',
        'Referrer-Policy': 'no-referrer'
      }
      // net.fetch 会自动解压：此时上游的 content-length 是压缩后的长度，不能原样转发
      if (declared > 0 && !response.headers.get('content-encoding')) {
        headers['Content-Length'] = declared
      }
      // 声明为图片时禁止嗅探；octet-stream 交给浏览器嗅探，否则 <img> 不认
      if (contentType.startsWith('image/')) headers['X-Content-Type-Options'] = 'nosniff'
      res.writeHead(200, headers)
      res.on('close', () => controller.abort())
      if (req.method === 'HEAD' || !response.body) {
        res.end()
        return
      }
      const reader = response.body.getReader()
      let received = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > MAX_IMAGE_BYTES) {
            res.destroy()
            controller.abort()
            return
          }
          if (!res.write(value)) await waitDrain(res)
        }
        res.end()
      } catch {
        res.destroy()
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // reader 已经 cancel
        }
      }
    } catch {
      if (!res.headersSent) sendProxyError(res, 502, 'UPSTREAM_FAILED')
      else res.destroy()
    } finally {
      clearTimeout(timer)
    }
  }

  const handlePlaylist: MediaProxy['handlePlaylist'] = async (req, res, target) => {
    if (!isAllowed(target)) {
      sendProxyError(res, 403, 'FORBIDDEN')
      return
    }
    let upstream: Upstream
    try {
      upstream = await openUpstream(target, {
        accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        noCache: true
      })
    } catch {
      sendProxyError(res, 502, 'UPSTREAM_FAILED')
      return
    }
    const { response, controller } = upstream
    res.on('close', () => controller.abort())
    if (!response.ok) {
      sendProxyError(res, 502, `UPSTREAM_HTTP_${response.status}`)
      return
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_PLAYLIST_BYTES) {
      sendProxyError(res, 502, 'PLAYLIST_TOO_LARGE')
      return
    }
    let text: string
    try {
      text = await response.text()
    } catch {
      sendProxyError(res, 502, 'UPSTREAM_FAILED')
      return
    }
    if (Buffer.byteLength(text, 'utf-8') > MAX_PLAYLIST_BYTES) {
      sendProxyError(res, 502, 'PLAYLIST_TOO_LARGE')
      return
    }
    const base = response.url || target.href
    const rewritten = rewritePlaylist(text, base)
    const body = Buffer.from(rewritten, 'utf-8')
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  }

  const handleStream: MediaProxy['handleStream'] = async (req, res, target) => {
    if (!isAllowed(target)) {
      sendProxyError(res, 403, 'FORBIDDEN')
      return
    }
    const range = typeof req.headers.range === 'string' ? req.headers.range : ''
    let upstream: Upstream
    try {
      upstream = await openUpstream(target, {
        range: range || undefined,
        method: req.method === 'HEAD' ? 'HEAD' : 'GET'
      })
    } catch {
      sendProxyError(res, 502, 'UPSTREAM_FAILED')
      return
    }
    const { response, controller } = upstream
    res.on('close', () => controller.abort())

    const headers: Record<string, string | number> = {
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff'
    }
    // net.fetch 会自动解压；此时上游的 content-length 是压缩后的长度，不能原样转发
    const encoded = Boolean(response.headers.get('content-encoding'))
    for (const name of FORWARDED_HEADERS) {
      if (encoded && name === 'content-length') continue
      const value = response.headers.get(name)
      if (value) headers[name] = value
    }
    res.writeHead(response.status, headers)
    if (req.method === 'HEAD' || !response.body) {
      res.end()
      return
    }

    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(value)) await waitDrain(res)
      }
      res.end()
    } catch {
      res.destroy()
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // reader 已经被 cancel，忽略
      }
    }
  }

  return { allowDetail, allowUrls, allowImages, handlePlaylist, handleStream, handleImage }
}
