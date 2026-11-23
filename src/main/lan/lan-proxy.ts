import type { IncomingMessage, ServerResponse } from 'node:http'
import { isHttpUrl } from './lan-media-url'
import type { LanFetch, LanVideoDetail } from './lan-types'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const UPSTREAM_TIMEOUT = 20_000
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
const MAX_ALLOWED_ORIGINS = 400

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
  handlePlaylist: (req: IncomingMessage, res: ServerResponse, target: URL) => Promise<void>
  handleStream: (req: IncomingMessage, res: ServerResponse, target: URL) => Promise<void>
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

  const upstreamHeaders = (
    target: URL,
    options: { range?: string; accept?: string; noCache?: boolean }
  ): Headers => {
    const headers = new Headers({
      'User-Agent': USER_AGENT,
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
    for (const source of video.sources) {
      for (const line of source.lines) {
        for (const episode of line.episodes) rememberOrigin(episode.url)
      }
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

  return { allowDetail, handlePlaylist, handleStream }
}
