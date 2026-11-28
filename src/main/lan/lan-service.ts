import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  createLanConfigStore,
  isValidLanHost,
  isValidLanPort,
  listLanAddresses,
  urlsFor
} from './lan-config'
import { createMediaProxy } from './lan-proxy'
import { sendLanFile } from './lan-file'
import { LAN_ASSETS, LAN_HTML, type LanAsset } from './lan-web-assets'
import type {
  LanFetch,
  LanSearchPayload,
  LanServiceDeps,
  LanServiceState,
  LanStartError,
  LanStartResult
} from './lan-types'

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  'worker-src blob:',
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ')

export interface CreateLanServiceOptions {
  /** userData/Data：配置存在 <dataDir>/Lan/config.json */
  dataDir: string
  /** 由主进程传 net.fetch（Chromium 网络栈，第三方播放地址的兼容性更好） */
  fetch: LanFetch
  deps: LanServiceDeps
}

export interface LanService {
  state: () => LanServiceState
  start: (input: { host: string; port: number }) => Promise<LanStartResult>
  stop: () => Promise<LanServiceState>
  /** 应用退出时同步关掉监听，不等在途请求 */
  dispose: () => void
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function mapListenError(error: unknown): LanStartError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return 'PORT_IN_USE'
  if (code === 'EACCES') return 'PERMISSION'
  if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND') return 'ADDRESS_UNAVAILABLE'
  return 'START_FAILED'
}

export function createLanService(options: CreateLanServiceOptions): LanService {
  const { deps } = options
  const configStore = createLanConfigStore(options.dataDir)
  const proxy = createMediaProxy(options.fetch)

  let server: Server | null = null
  let listeningConfig: { host: string; port: number } | null = null
  let startedAt = ''
  let lastError: LanStartError | '' = ''
  let disposed = false
  /** 串行化 start / stop：连点按钮时不会同时 listen 两个端口 */
  let transition: Promise<unknown> = Promise.resolve()

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = transition.then(task, task)
    transition = next.catch(() => {})
    return next
  }

  const buildState = (): LanServiceState => {
    const config = listeningConfig ?? configStore.get()
    const addresses = listLanAddresses()
    return {
      running: Boolean(server?.listening),
      host: config.host,
      port: config.port,
      urls: urlsFor(config.host, config.port, addresses),
      addresses,
      error: lastError || undefined,
      startedAt
    }
  }

  const notify = (): void => {
    if (disposed) return
    try {
      deps.onChange?.(buildState())
    } catch {
      // 渲染层已销毁时忽略
    }
  }

  const sendText = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: string,
    contentType: string,
    cache: string
  ): void => {
    const buffer = Buffer.from(body, 'utf-8')
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': buffer.byteLength,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    })
    res.end(req.method === 'HEAD' ? undefined : buffer)
  }

  const sendHtml = (req: IncomingMessage, res: ServerResponse): void => {
    const buffer = Buffer.from(LAN_HTML, 'utf-8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buffer.byteLength,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    })
    res.end(req.method === 'HEAD' ? undefined : buffer)
  }

  const sendJson = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    payload: unknown
  ): void => {
    sendText(
      req,
      res,
      status,
      JSON.stringify(payload),
      'application/json; charset=utf-8',
      'no-store'
    )
  }

  const sendAsset = (req: IncomingMessage, res: ServerResponse, asset: LanAsset): void => {
    const buffer = Buffer.from(asset.body, 'utf-8')
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': buffer.byteLength,
      'Cache-Control': asset.cache,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    })
    res.end(req.method === 'HEAD' ? undefined : buffer)
  }

  const handleSearch = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> => {
    const keyword = (url.searchParams.get('q') ?? '').trim().slice(0, 60)
    if (!keyword) {
      sendJson(req, res, 400, { ok: false, error: 'INVALID_INPUT' })
      return
    }
    const mode = url.searchParams.get('mode') === 'online' ? 'online' : 'local'
    try {
      if (mode === 'online') {
        const payload = await deps.searchOnline(keyword)
        proxy.allowImages(payload)
        sendJson(req, res, 200, payload)
        return
      }
      const page = clampInt(url.searchParams.get('page'), 1, 1, 10_000)
      const pageSize = clampInt(url.searchParams.get('pageSize'), 20, 1, 50)
      const payload: LanSearchPayload = deps.searchLocal(keyword, page, pageSize)
      proxy.allowImages(payload)
      sendJson(req, res, 200, payload)
    } catch {
      sendJson(req, res, 500, { ok: false, error: 'SEARCH_FAILED' })
    }
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(req, res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendJson(req, res, 400, { ok: false, error: 'BAD_REQUEST' })
      return
    }
    const pathname = url.pathname

    if (pathname === '/' || pathname === '/index.html') {
      sendHtml(req, res)
      return
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    const asset = LAN_ASSETS[pathname]
    if (asset) {
      sendAsset(req, res, asset)
      return
    }

    if (pathname === '/api/latest') {
      try {
        const page = clampInt(url.searchParams.get('page'), 1, 1, 10_000)
        const pageSize = clampInt(url.searchParams.get('pageSize'), 12, 1, 30)
        const payload = deps.latest(page, pageSize)
        proxy.allowImages(payload)
        sendJson(req, res, 200, payload)
      } catch {
        sendJson(req, res, 500, { ok: false, error: 'LATEST_FAILED' })
      }
      return
    }
    if (pathname === '/api/categories') {
      try {
        sendJson(req, res, 200, deps.categories())
      } catch {
        sendJson(req, res, 500, { ok: false, error: 'CATEGORIES_FAILED' })
      }
      return
    }
    if (pathname === '/api/browse') {
      // 本地分类 id 是 32 位十六进制；空串 = 全部（服务端自己取可见一级分类的并集）
      const categoryId = (url.searchParams.get('cat') ?? '').trim()
      if (categoryId && !/^[0-9a-f]{32}$/i.test(categoryId)) {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_INPUT' })
        return
      }
      const page = clampInt(url.searchParams.get('page'), 1, 1, 10_000)
      const pageSize = clampInt(url.searchParams.get('pageSize'), 30, 1, 50)
      try {
        const payload = deps.browse({ categoryId, page, pageSize })
        proxy.allowImages(payload)
        sendJson(req, res, 200, payload)
      } catch {
        sendJson(req, res, 500, { ok: false, error: 'BROWSE_FAILED' })
      }
      return
    }
    if (pathname === '/api/search') {
      await handleSearch(req, res, url)
      return
    }
    if (pathname === '/api/image') {
      const raw = url.searchParams.get('u')
      if (!raw) {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_INPUT' })
        return
      }
      let target: URL
      try {
        target = new URL(raw)
      } catch {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_URL' })
        return
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_URL' })
        return
      }
      await proxy.handleImage(req, res, target)
      return
    }
    if (pathname === '/api/downloads') {
      const raw = url.searchParams.get('video')
      let videoId: number | undefined
      if (raw !== null && raw.trim() !== '') {
        const parsed = Number(raw)
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          sendJson(req, res, 400, { ok: false, error: 'INVALID_INPUT' })
          return
        }
        videoId = parsed
      }
      try {
        sendJson(req, res, 200, deps.downloads(videoId))
      } catch {
        sendJson(req, res, 500, { ok: false, error: 'DOWNLOADS_FAILED' })
      }
      return
    }
    const cachedMatch = /^\/api\/cached\/([0-9a-f]{32})\/(.+)$/i.exec(pathname)
    if (cachedMatch) {
      let relativePath: string
      try {
        relativePath = decodeURIComponent(cachedMatch[2])
      } catch {
        sendJson(req, res, 400, { ok: false, error: 'BAD_REQUEST' })
        return
      }
      const file = await deps.cachedFile(cachedMatch[1], relativePath)
      if (!file) {
        sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
        return
      }
      sendLanFile(req, res, file)
      return
    }
    const detailMatch = /^\/api\/video\/(\d+)$/.exec(pathname)
    if (detailMatch) {
      const videoId = Number(detailMatch[1])
      if (!Number.isSafeInteger(videoId) || videoId <= 0) {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_INPUT' })
        return
      }
      try {
        const payload = await deps.detail(videoId)
        if (payload.ok && payload.video) proxy.allowDetail(payload.video)
        sendJson(req, res, 200, payload)
      } catch {
        sendJson(req, res, 500, { ok: false, error: 'DETAIL_FAILED' })
      }
      return
    }
    if (pathname === '/api/play' || pathname === '/api/play.m3u8' || pathname === '/api/stream') {
      const raw = url.searchParams.get('u')
      if (!raw) {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_INPUT' })
        return
      }
      let target: URL
      try {
        target = new URL(raw)
      } catch {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_URL' })
        return
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_URL' })
        return
      }
      if (pathname === '/api/play' || pathname === '/api/play.m3u8') {
        await proxy.handlePlaylist(req, res, target)
      } else {
        await proxy.handleStream(req, res, target)
      }
      return
    }
    if (pathname.startsWith('/api/')) {
      sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
  }

  const closeServer = (active: Server): Promise<void> => {
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, 1500)
      timer.unref?.()
      active.close(finish)
      // 在途的视频流可能是长连接，不能等它们自己结束
      active.closeAllConnections?.()
    })
  }

  const stopInternal = async (): Promise<void> => {
    const active = server
    if (!active) return
    server = null
    listeningConfig = null
    startedAt = ''
    await closeServer(active)
  }

  const start = async (input: { host: string; port: number }): Promise<LanStartResult> => {
    return serialize(async () => {
      const host = typeof input?.host === 'string' ? input.host.trim() : ''
      const port = Number(input?.port)
      if (!isValidLanHost(host)) {
        return { ok: false, error: 'INVALID_HOST', state: buildState() }
      }
      if (!isValidLanPort(port)) {
        return { ok: false, error: 'INVALID_PORT', state: buildState() }
      }
      if (
        server?.listening &&
        listeningConfig &&
        listeningConfig.host === host &&
        listeningConfig.port === port
      ) {
        lastError = ''
        return { ok: true, state: buildState() }
      }
      if (server) await stopInternal()
      lastError = ''

      const candidate = createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
          console.error('局域网服务处理请求失败', error)
          if (!response.headersSent) {
            try {
              sendJson(request, response, 500, { ok: false, error: 'SERVER_ERROR' })
            } catch {
              response.destroy()
            }
          } else {
            response.destroy()
          }
        })
      })
      candidate.keepAliveTimeout = 65_000
      candidate.headersTimeout = 70_000
      candidate.on('clientError', (_error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      })

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException): void => {
            candidate.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            candidate.off('error', onError)
            resolve()
          }
          candidate.once('error', onError)
          candidate.once('listening', onListening)
          candidate.listen(port, host)
        })
      } catch (error) {
        lastError = mapListenError(error)
        try {
          candidate.close()
        } catch {
          // 没进入监听状态时 close 会抛 ERR_SERVER_NOT_RUNNING
        }
        notify()
        return { ok: false, error: lastError, state: buildState() }
      }

      server = candidate
      listeningConfig = { host, port }
      startedAt = new Date().toISOString()
      configStore.save({ host, port })
      // listen 之后的错误（例如网卡被拔掉）：关掉服务并通知控制台，不要留一个假运行状态
      candidate.on('error', (error) => {
        if (server !== candidate) return
        lastError = mapListenError(error)
        server = null
        listeningConfig = null
        startedAt = ''
        try {
          candidate.close()
          candidate.closeAllConnections?.()
        } catch {
          // 已经关闭
        }
        notify()
      })
      notify()
      return { ok: true, state: buildState() }
    })
  }

  const stop = async (): Promise<LanServiceState> => {
    return serialize(async () => {
      lastError = ''
      if (!server) return buildState()
      await stopInternal()
      notify()
      return buildState()
    })
  }

  const dispose = (): void => {
    disposed = true
    const active = server
    server = null
    listeningConfig = null
    startedAt = ''
    if (active) {
      try {
        active.close()
      } catch {
        // 已经关闭
      }
      active.closeAllConnections?.()
    }
  }

  return { state: buildState, start, stop, dispose }
}
