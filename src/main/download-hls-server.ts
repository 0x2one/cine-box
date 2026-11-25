import { createReadStream, existsSync, statSync } from 'fs'
import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { extname, resolve, sep } from 'path'
import type { DownloadRecord } from './download-store'

/**
 * 本机 HLS 播放服务。
 *
 * 缓存的 HLS 包不适合用自定义协议喂给 hls.js（XHR / fetch 对自定义 scheme 的 CORS
 * 行为跟 Electron 版本相关），所以在 127.0.0.1 上起一个临时 HTTP 服务：
 * - 只监听 loopback，随机端口，应用退出就关；
 * - 只服务下载记录里登记过的 hls 包（路径里带记录 id）；
 * - 只做 GET，不列目录，拒绝路径穿越；
 * - 播放列表与分片都是普通文件，hls.js 按相对路径取。
 */

export interface DownloadHlsServerOptions {
  findRecord: (id: string) => DownloadRecord | null
}

export interface DownloadHlsServer {
  /** 记录可播时返回本机 playlist 地址；记录不存在 / 文件缺失 / 服务起不来返回 null */
  urlFor: (id: string) => Promise<string | null>
  dispose: () => void
}

const MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.vtt': 'text/vtt',
  '.key': 'application/octet-stream',
  '.bin': 'application/octet-stream'
}

function mimeOf(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function createDownloadHlsServer(options: DownloadHlsServerOptions): DownloadHlsServer {
  let server: Server | null = null
  let port = 0
  let starting: Promise<number | null> | null = null

  function handle(request: IncomingMessage, response: ServerResponse): void {
    const fail = (status: number): void => {
      response.writeHead(status, { 'Cache-Control': 'no-store' })
      response.end()
    }
    try {
      // 只接受我们给出的地址：Host 必须是 loopback 上的这个端口，挡 DNS rebinding
      const expectedHost = `127.0.0.1:${port}`
      if ((request.headers.host ?? '') !== expectedHost) return fail(403)
      if (request.method !== 'GET') return fail(405)

      const url = new URL(request.url ?? '/', `http://${expectedHost}`)
      const parts = url.pathname.split('/').filter(Boolean)
      // /pkg/<recordId>/<relative...>
      if (parts.length < 3 || parts[0] !== 'pkg') return fail(404)
      const recordId = decodeURIComponent(parts[1])
      const record = options.findRecord(recordId)
      if (!record || record.kind !== 'hls' || !record.packageDir) return fail(404)

      const relatives: string[] = []
      for (const part of parts.slice(2)) {
        const decoded = decodeURIComponent(part)
        if (
          !decoded ||
          decoded === '.' ||
          decoded === '..' ||
          decoded.includes('/') ||
          decoded.includes('\\')
        ) {
          return fail(404)
        }
        relatives.push(decoded)
      }
      if (relatives.length === 0) return fail(404)

      const root = resolve(record.packageDir)
      const target = resolve(root, ...relatives)
      if (target === root || !target.startsWith(root + sep)) return fail(404)
      if (!existsSync(target)) return fail(404)
      const info = statSync(target)
      if (!info.isFile()) return fail(404)

      response.writeHead(200, {
        'Content-Type': mimeOf(target),
        'Content-Length': String(info.size),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff'
      })
      const stream = createReadStream(target)
      stream.on('error', () => response.destroy())
      stream.pipe(response)
    } catch {
      fail(400)
    }
  }

  function start(): Promise<number | null> {
    if (port > 0) return Promise.resolve(port)
    if (starting) return starting
    starting = new Promise<number | null>((resolveStart) => {
      const httpServer = createServer(handle)
      httpServer.once('error', () => {
        starting = null
        resolveStart(null)
      })
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address()
        if (!address || typeof address !== 'object') {
          httpServer.close()
          starting = null
          resolveStart(null)
          return
        }
        port = address.port
        server = httpServer
        resolveStart(port)
      })
    })
    return starting
  }

  return {
    urlFor: async (id) => {
      const record = options.findRecord(String(id))
      if (!record || record.kind !== 'hls' || !record.packageDir) return null
      if (!existsSync(record.path)) return null
      const actualPort = await start()
      if (!actualPort) return null
      return `http://127.0.0.1:${actualPort}/pkg/${encodeURIComponent(record.id)}/index.m3u8`
    },
    dispose: () => {
      const current = server
      server = null
      port = 0
      starting = null
      if (!current) return
      current.close()
      current.closeAllConnections?.()
    }
  }
}
