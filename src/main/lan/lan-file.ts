/**
 * 局域网 / 投屏共用的文件下发：缓存包分片整取为主，个别播放器会发 Range
 * （mp4 init / 拖动预览），所以按单段 Range 处理，超出范围回 416。
 * 缓存内容会随删除 / 重新缓存变化，一律 no-store。
 */

import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LanCacheFile } from './lan-types'

export function sendLanFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: LanCacheFile
): void {
  const size = file.size
  let start = 0
  let end = size - 1
  let partial = false
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    const startText = match?.[1] ?? ''
    const endText = match?.[2] ?? ''
    if (!match || (startText === '' && endText === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    if (startText === '') {
      // bytes=-N：最后 N 个字节
      const length = Number(endText)
      if (!Number.isFinite(length) || length <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      start = Math.max(0, size - Math.trunc(length))
    } else {
      start = Math.trunc(Number(startText))
      end = endText === '' ? size - 1 : Math.trunc(Number(endText))
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    end = Math.min(end, size - 1)
    partial = true
  }

  const headers: Record<string, string | number> = {
    'Content-Type': file.contentType,
    'Content-Length': size === 0 ? 0 : end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(partial ? 206 : 200, headers)
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  const stream = createReadStream(file.file, { start, end })
  stream.on('error', () => {
    // 读盘失败（文件刚被删 / 被占用）：已经发了响应头，只能掐断连接
    res.destroy()
  })
  stream.pipe(res)
}

/** 内存里的文本 / 字节（净化后的播放列表）也按同一套 Range 规则下发 */
export function sendLanBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  contentType: string,
  cacheControl = 'no-store'
): void {
  const size = body.byteLength
  let start = 0
  let end = size - 1
  let partial = false
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    const startText = match?.[1] ?? ''
    const endText = match?.[2] ?? ''
    if (!match || (startText === '' && endText === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    if (startText === '') {
      const length = Number(endText)
      if (!Number.isFinite(length) || length <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      start = Math.max(0, size - Math.trunc(length))
    } else {
      start = Math.trunc(Number(startText))
      end = endText === '' ? size - 1 : Math.trunc(Number(endText))
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    end = Math.min(end, size - 1)
    partial = true
  }

  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': size === 0 ? 0 : end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(partial ? 206 : 200, headers)
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  res.end(partial ? body.subarray(start, end + 1) : body)
}
