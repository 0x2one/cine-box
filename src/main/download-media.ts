import { createReadStream, statSync } from 'fs'
import { extname } from 'path'
import { Readable } from 'stream'

/**
 * 本地下载文件的自定义协议。
 *
 * 播放页在独立窗口里跑，开发模式下页面源是 http://localhost，直接给 file:// 会被
 * CSP 的 media-src 拦掉；所以走 cine-file://downloads/<encodeURIComponent(绝对路径)>，
 * 由主进程按 Range 转发文件字节。协议只放行下载记录里登记过的路径（见 index.ts），
 * 不是任意本地文件读取器。
 */
export const DOWNLOAD_MEDIA_SCHEME = 'cine-file'

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg'
}

/** 绝对路径 → cine-file:// 地址 */
export function downloadMediaUrl(file: string): string {
  return `${DOWNLOAD_MEDIA_SCHEME}://downloads/${encodeURIComponent(file)}`
}

/** 绝对路径 → 媒体 MIME 类型（未知扩展名按通用二进制下发） */
export function downloadMediaType(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function toWebStream(file: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const stream = createReadStream(file, start === undefined ? undefined : { start, end })
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>
}

/**
 * 把文件作为 HTTP 响应发出去，支持 Range：
 * <video> 拖动进度条时会发 `Range: bytes=…`，不回 206 就没法跳转 / 部分加载。
 */
export function serveDownloadFile(file: string, request: Request): Response {
  const info = statSync(file)
  if (!info.isFile()) return new Response('Not found', { status: 404 })

  const size = info.size
  const type = downloadMediaType(file)
  const range = request.headers.get('range')

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match) {
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : size - 1
      if (match[1] === '' && match[2]) {
        // `bytes=-500`：最后 500 字节
        start = Math.max(size - Number(match[2]), 0)
        end = size - 1
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` }
        })
      }
      end = Math.min(end, size - 1)
      return new Response(toWebStream(file, start, end), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    }
  }

  return new Response(toWebStream(file), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }
  })
}
