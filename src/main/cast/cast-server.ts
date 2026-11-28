/**
 * 投屏专用 HTTP 服务。
 *
 * 电视只访问这个服务（局域网地址），不接触第三方播放地址：
 * - 在线集：播放列表 / 分片全部经 `createMediaProxy` 转发，上游请求走主进程的
 *   `net.fetch`，因此和采集 / 局域网共享共用「设置 › 网络」的代理配置；
 * - 缓存集：直接下发本机缓存包，播放列表先去掉 `#EXT-X-DISCONTINUITY`
 *   （当贝这类渲染器会因为它跳段），分片支持 Range。
 *
 * 服务只在投屏期间存在，用随机 token / 下载记录 id 限定可访问的资源，
 * 不暴露片库接口，也不做任意 URL 代理。
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { sendLanBuffer, sendLanFile } from '../lan/lan-file'
import { createMediaProxy } from '../lan/lan-proxy'
import type { LanCacheFile } from '../lan/lan-types'
import { stripDiscontinuity } from './cast-xml'
import type { CastFetch } from './cast-types'

const SESSION_ID = /^[0-9a-f]{32}$/i
const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl'

export interface CastSession {
  /** 随机 32 位十六进制；在线集的入口路径用它 */
  token: string
  kind: 'remote' | 'cache'
  /** 在线集的原始 m3u8 */
  url?: string
  /** 缓存集的下载记录 id */
  recordId?: string
  title: string
  episodeName: string
}

export interface CastServerOptions {
  fetch: CastFetch
  /** 解析缓存包里的文件；由下载中心提供，非法路径 / 记录不可播时返回 null */
  cachedFile: (recordId: string, relativePath: string) => Promise<LanCacheFile | null>
}

export interface CastServer {
  /** 开始监听，返回实际端口 */
  start: () => Promise<number>
  /** 注册当前会话并返回电视可访问的路径（不含 host） */
  openSession: (session: Omit<CastSession, 'token'> & { token?: string }) => string
  /** 结束当前会话；服务本身等到 stop() 才关，方便界面立刻恢复 */
  closeSession: () => void
  /** 关闭监听（投屏结束时调用） */
  stop: () => Promise<void>
  /** 应用退出：同步关掉 */
  dispose: () => void
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: unknown
): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function readMethod(req: IncomingMessage): 'GET' | 'HEAD' | null {
  return req.method === 'GET' || req.method === 'HEAD' ? req.method : null
}

export function createCastServer(options: CastServerOptions): CastServer {
  const proxy = createMediaProxy(options.fetch)
  let server: Server | null = null
  let port = 0
  let session: CastSession | null = null
  let starting: Promise<number> | null = null

  const sessionPath = (current: CastSession): string =>
    current.kind === 'remote'
      ? `/cast/${current.token}/index.m3u8`
      : `/cast/cache/${current.recordId}/index.m3u8`

  const handlePlaylist = async (
    req: IncomingMessage,
    res: ServerResponse,
    current: CastSession
  ): Promise<void> => {
    if (current.kind === 'remote' && current.url) {
      let target: URL
      try {
        target = new URL(current.url)
      } catch {
        sendJson(req, res, 400, { ok: false, error: 'INVALID_URL' })
        return
      }
      await proxy.handlePlaylist(req, res, target)
      return
    }

    const recordId = current.recordId ?? ''
    if (!SESSION_ID.test(recordId)) {
      sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    const file = await options.cachedFile(recordId, 'index.m3u8')
    if (!file) {
      sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    let text: string
    try {
      text = await readFile(file.file, 'utf-8')
    } catch {
      sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    const cleaned = stripDiscontinuity(text)
    const withEnd = /^#EXT-X-ENDLIST/m.test(cleaned) ? cleaned : `${cleaned}\n#EXT-X-ENDLIST\n`
    sendLanBuffer(req, res, Buffer.from(withEnd, 'utf-8'), PLAYLIST_CONTENT_TYPE)
  }

  const handleCachedFile = async (
    req: IncomingMessage,
    res: ServerResponse,
    recordId: string,
    rawPath: string
  ): Promise<void> => {
    if (!SESSION_ID.test(recordId)) {
      sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    let relativePath: string
    try {
      relativePath = decodeURIComponent(rawPath)
    } catch {
      sendJson(req, res, 400, { ok: false, error: 'BAD_REQUEST' })
      return
    }
    const file = await options.cachedFile(recordId, relativePath)
    if (!file) {
      sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
    sendLanFile(req, res, file)
  }

  const handleProxy = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL
  ): Promise<void> => {
    if (!session || session.kind !== 'remote') {
      sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
      return
    }
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
    if (pathname === '/api/play.m3u8' || pathname === '/api/play') {
      await proxy.handlePlaylist(req, res, target)
      return
    }
    await proxy.handleStream(req, res, target)
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = readMethod(req)
    if (!method) {
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

    if (pathname === '/api/play' || pathname === '/api/play.m3u8' || pathname === '/api/stream') {
      await handleProxy(req, res, pathname, url)
      return
    }

    const cacheMatch = /^\/cast\/cache\/([0-9a-f]{32})\/(.+)$/i.exec(pathname)
    if (cacheMatch) {
      const recordId = cacheMatch[1]
      if (session?.kind !== 'cache' || session.recordId !== recordId) {
        sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
        return
      }
      const relativePath = cacheMatch[2]
      if (relativePath === 'index.m3u8') {
        await handlePlaylist(req, res, session)
        return
      }
      await handleCachedFile(req, res, recordId, relativePath)
      return
    }

    const remoteMatch = /^\/cast\/([0-9a-f]{32})\/index\.m3u8$/i.exec(pathname)
    if (remoteMatch) {
      if (!session || session.kind !== 'remote' || session.token !== remoteMatch[1]) {
        sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
        return
      }
      await handlePlaylist(req, res, session)
      return
    }

    sendJson(req, res, 404, { ok: false, error: 'NOT_FOUND' })
  }

  const start = (): Promise<number> => {
    if (server?.listening) return Promise.resolve(port)
    if (starting) return starting
    starting = new Promise<number>((resolve, reject) => {
      const candidate = createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
          console.error('[cast] 处理请求失败', error)
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
      candidate.once('error', (error) => {
        starting = null
        reject(error)
      })
      candidate.listen(0, '0.0.0.0', () => {
        const address = candidate.address()
        if (!address || typeof address !== 'object') {
          candidate.close()
          starting = null
          reject(new Error('没有拿到监听端口'))
          return
        }
        server = candidate
        port = address.port
        resolve(port)
      })
    }).finally(() => {
      starting = null
    })
    return starting
  }

  const closeServer = (active: Server): Promise<void> =>
    new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, 1200)
      timer.unref?.()
      active.close(finish)
      active.closeAllConnections?.()
    })

  const stop = async (): Promise<void> => {
    session = null
    const active = server
    server = null
    port = 0
    if (active) await closeServer(active)
  }

  const openSession = (input: Omit<CastSession, 'token'> & { token?: string }): string => {
    const token = input.token ?? randomBytes(16).toString('hex')
    session = { ...input, token }
    if (session.kind === 'remote' && session.url) proxy.allowUrls([session.url])
    return sessionPath(session)
  }

  return {
    start,
    openSession,
    closeSession: () => {
      session = null
    },
    stop,
    dispose: () => {
      session = null
      const active = server
      server = null
      port = 0
      if (!active) return
      try {
        active.close()
      } catch {
        // 已经关闭
      }
      active.closeAllConnections?.()
    }
  }
}
