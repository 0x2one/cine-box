import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { extname, join } from 'path'

/**
 * HLS 点播流下载：把 master / media playlist、分片、密钥和 init 分片落成
 * 一份自包含的本地 HLS 包，playlist 里的地址全部改写成本地相对文件名。
 *
 * 这里不 import electron，`fetch` 由调用方注入：
 * 生产环境用 `net.fetch`（走 Chromium 网络栈，代理 / 证书行为一致），
 * 冒烟测试用全局 fetch。所有路径都是相对包根目录的正斜杠路径。
 */

/** 单个 playlist 文本上限 */
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
/** 单个分片 / init / 密钥上限 */
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024
/** 一条线路最多多少分片（不同码率的变体 / 字幕轨合计） */
const MAX_SEGMENTS = 20000
/** 单个 playlist 内部同时下载多少个分片 */
const SEGMENT_CONCURRENCY = 3
const REQUEST_TIMEOUT = 30_000
const REQUEST_RETRIES = 2
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export type HlsFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface HlsDownloadProgress {
  /** 已下载分片数 */
  downloaded: number
  /** 目前发现的全部 playlist 的分片数（含音轨 / 字幕） */
  total: number
  /** 已落盘字节数 */
  receivedBytes: number
}

export interface HlsDownloadOptions {
  /** 入口 m3u8 地址（master 或 media 都行） */
  url: string
  /** 缓存包目录（本函数会 mkdir） */
  dir: string
  signal: AbortSignal
  fetchImpl: HlsFetch
  onProgress?: (progress: HlsDownloadProgress) => void
  /** 单个 playlist 内部的分片并发数，默认 3 */
  concurrency?: number
}

export interface HlsDownloadResult {
  bytes: number
  segments: number
  /** 最终 playlist 的绝对路径（包根目录的 index.m3u8） */
  playlistFile: string
}

/** 下载失败原因：引擎负责映射成中文提示 */
export class HlsDownloadError extends Error {
  code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'HlsDownloadError'
    this.code = code
  }
}

interface SegmentJob {
  url: string
  /** `bytes=start-end` 里的值；没有 Range 时为 undefined */
  range?: string
  /** 服务器忽略 Range、返回整段时在本地切片 */
  byteRange?: { start: number; length: number }
  /** 相对包根目录的输出路径 */
  rel: string
}

interface Variant {
  tagIndex: number
  uriIndex: number
  bandwidth: number
  uri: string
}

interface DownloadContext {
  dir: string
  fetchImpl: HlsFetch
  signal: AbortSignal
  concurrency: number
  onProgress?: (progress: HlsDownloadProgress) => void
  downloaded: number
  totalSegments: number
  receivedBytes: number
  createdDirs: Set<string>
  /** `${dirRel}\u0000${url}` → 同目录下的本地文件名 */
  auxCache: Map<string, string>
  auxCounters: Map<string, number>
  /** 同一个资源连续 EXT-X-BYTERANGE 时，缺省 offset 接着上一段走 */
  byteRangeEnds: Map<string, number>
  mediaCounters: Map<string, number>
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new HlsDownloadError('ABORT', '下载已取消')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** 从当前 playlist 所在目录引用包内目标时的相对路径 */
function relativeFrom(dirRel: string, targetRel: string): string {
  const from = dirRel ? dirRel.split('/') : []
  const target = targetRel.split('/')
  for (let index = 0; index < from.length; index += 1) {
    if (target[index] !== from[index]) return targetRel
  }
  return target.slice(from.length).join('/')
}

function resolveUrl(base: string, uri: string): string {
  try {
    return new URL(uri, base).toString()
  } catch {
    throw new HlsDownloadError('PLAYLIST', `播放地址不合法：${uri.slice(0, 200)}`)
  }
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}

const SEGMENT_EXTENSIONS = new Set(['.ts', '.m4s', '.mp4', '.aac', '.m4a', '.vtt'])

function extensionOf(url: string, fallback: string): string {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase()
    if (SEGMENT_EXTENSIONS.has(ext)) return ext
  } catch {
    // 不是标准 URL：用兜底扩展名
  }
  return fallback
}

function segmentExtension(url: string): string {
  return extensionOf(url, '.ts')
}

/** 解析 `KEY=VALUE,KEY="VALUE,WITH,COMMAS"` 形式的标签属性 */
function parseAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {}
  let index = 0
  while (index < input.length) {
    while (input[index] === ',' || input[index] === ' ') index += 1
    const eq = input.indexOf('=', index)
    if (eq < 0) break
    const key = input.slice(index, eq).trim().toUpperCase()
    let value: string
    let cursor = eq + 1
    if (input[cursor] === '"') {
      cursor += 1
      const start = cursor
      while (cursor < input.length && input[cursor] !== '"') cursor += 1
      value = input.slice(start, cursor)
      cursor += 1
    } else {
      const start = cursor
      while (cursor < input.length && input[cursor] !== ',') cursor += 1
      value = input.slice(start, cursor).trim()
    }
    if (key) result[key] = value
    while (cursor < input.length && input[cursor] !== ',') cursor += 1
    index = cursor + 1
  }
  return result
}

function replaceUri(line: string, local: string): string {
  return line.replace(/URI="[^"]*"/i, `URI="${local}"`)
}

function dropAttribute(line: string, name: string): string {
  return line.replace(new RegExp(`,\\s*${name}="[^"]*"`, 'i'), '')
}

function requestHeaders(url: string, range?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'identity'
  }
  const origin = originOf(url)
  if (origin) headers.Referer = `${origin}/`
  if (range) headers.Range = `bytes=${range}`
  return headers
}

/** 带超时 / 重试 / 取消的 GET；返回字节、状态码和最终地址（跟随重定向后的 base） */
async function fetchResource(
  ctx: DownloadContext,
  url: string,
  range?: string
): Promise<{ bytes: Uint8Array; status: number; url: string }> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(ctx.signal)
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
    try {
      const response = await ctx.fetchImpl(url, {
        headers: requestHeaders(url, range),
        signal: controller.signal
      })
      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500
        if (retryable && attempt < REQUEST_RETRIES) {
          await wait(400 * (attempt + 1))
          continue
        }
        throw new HlsDownloadError(`HTTP_${response.status}`, `HTTP ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_RESOURCE_BYTES) {
        throw new HlsDownloadError('TOO_LARGE', '单个分片超过大小上限')
      }
      return { bytes, status: response.status, url: response.url || url }
    } catch (error) {
      if (ctx.signal.aborted) throw new HlsDownloadError('ABORT', '下载已取消')
      if (error instanceof HlsDownloadError) throw error
      // 超时 / 网络抖动：重试
      if (attempt < REQUEST_RETRIES) {
        await wait(400 * (attempt + 1))
        continue
      }
      throw new HlsDownloadError('NETWORK', (error as Error)?.message ?? '网络错误')
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }
}

async function fetchText(
  ctx: DownloadContext,
  url: string
): Promise<{ text: string; url: string }> {
  const { bytes, url: finalUrl } = await fetchResource(ctx, url)
  if (bytes.byteLength > MAX_PLAYLIST_BYTES) {
    throw new HlsDownloadError('TOO_LARGE', '播放列表超过大小上限')
  }
  return { text: new TextDecoder('utf-8').decode(bytes), url: finalUrl }
}

async function ensureDir(ctx: DownloadContext, dirRel: string): Promise<void> {
  if (!dirRel || ctx.createdDirs.has(dirRel)) return
  await fsp.mkdir(join(ctx.dir, ...dirRel.split('/')), { recursive: true })
  ctx.createdDirs.add(dirRel)
}

function fileRel(ctx: DownloadContext, rel: string): string {
  return join(ctx.dir, ...rel.split('/'))
}

/** 已存在的文件大小；不存在 / 不是文件返回 null（断点续传用） */
async function existingFileSize(ctx: DownloadContext, rel: string): Promise<number | null> {
  try {
    const info = await fsp.stat(fileRel(ctx, rel))
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** 清掉上次中断留下的临时文件：只有 rename 成功的文件才算完成 */
async function cleanTempFiles(dir: string): Promise<void> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await cleanTempFiles(full)
      continue
    }
    if (entry.isFile() && /\.tmp(?:-|$)/.test(entry.name)) {
      await fsp.unlink(full).catch(() => {})
    }
  }
}

async function writeFileRel(ctx: DownloadContext, rel: string, bytes: Uint8Array): Promise<void> {
  const parts = rel.split('/')
  const dirRel = parts.slice(0, -1).join('/')
  await ensureDir(ctx, dirRel)
  const target = fileRel(ctx, rel)
  // 先写临时文件再 rename：暂停 / 崩溃时不会留下半截文件，重进任务可以按文件是否存在续传
  const temp = `${target}.tmp-${randomUUID()}`
  await fsp.writeFile(temp, bytes)
  try {
    await fsp.rename(temp, target)
  } catch {
    // Windows 上目标已存在 / 被占用时 rename 会失败：先删目标再重试一次
    await fsp.unlink(target).catch(() => {})
    await fsp.rename(temp, target)
  }
}

async function writePlaylist(
  ctx: DownloadContext,
  dirRel: string,
  lines: string[]
): Promise<string> {
  await ensureDir(ctx, dirRel)
  const text = `${lines.filter((line) => line !== '').join('\n')}\n`
  const target = join(ctx.dir, ...dirRel.split('/'), 'index.m3u8')
  const temp = `${target}.tmp`
  await fsp.writeFile(temp, text, 'utf8')
  try {
    await fsp.rename(temp, target)
  } catch {
    // Windows 上目标已存在 / 被占用时 rename 会失败：先删目标再重试一次
    await fsp.unlink(target).catch(() => {})
    await fsp.rename(temp, target)
  }
  return joinRel(dirRel, 'index.m3u8')
}

/** 固定并发的任务池：有一个失败就停止领取新任务 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  let failed: unknown = null
  const run = async (): Promise<void> => {
    while (!failed) {
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        await worker(items[index])
      } catch (error) {
        failed = error
        return
      }
    }
  }
  const count = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: count }, () => run()))
  if (failed) throw failed
}

function reportProgress(ctx: DownloadContext): void {
  ctx.onProgress?.({
    downloaded: ctx.downloaded,
    total: ctx.totalSegments,
    receivedBytes: ctx.receivedBytes
  })
}

async function downloadAux(
  ctx: DownloadContext,
  url: string,
  dirRel: string,
  prefix: string,
  fallbackExt: string
): Promise<string> {
  const cacheKey = `${dirRel}\u0000${url}`
  const cached = ctx.auxCache.get(cacheKey)
  if (cached) return cached
  const counter = (ctx.auxCounters.get(prefix) ?? 0) + 1
  ctx.auxCounters.set(prefix, counter)
  const name = `${prefix}-${String(counter).padStart(6, '0')}${extensionOf(url, fallbackExt)}`
  const rel = joinRel(dirRel, name)
  const existing = await existingFileSize(ctx, rel)
  if (existing !== null) {
    // 断点续传：上次已经落盘的密钥 / init 直接用
    ctx.auxCache.set(cacheKey, name)
    ctx.receivedBytes += existing
    return name
  }
  const { bytes } = await fetchResource(ctx, url)
  // 密钥 / init 也算进包体积，下载中心的「实际大小」才对得上
  ctx.receivedBytes += bytes.byteLength
  await writeFileRel(ctx, rel, bytes)
  ctx.auxCache.set(cacheKey, name)
  return name
}

function isMasterPlaylist(lines: string[]): boolean {
  return lines.some((line) => line.trim().toUpperCase().startsWith('#EXT-X-STREAM-INF'))
}

function parseVariants(lines: string[]): Variant[] {
  const variants: Variant[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().toUpperCase().startsWith('#EXT-X-STREAM-INF')) continue
    let uriIndex = index + 1
    while (
      uriIndex < lines.length &&
      (!lines[uriIndex].trim() || lines[uriIndex].trim().startsWith('#'))
    ) {
      uriIndex += 1
    }
    if (uriIndex >= lines.length) continue
    const bandwidth = Number(
      parseAttributes(lines[index].slice(lines[index].indexOf(':') + 1)).BANDWIDTH
    )
    variants.push({
      tagIndex: index,
      uriIndex,
      bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
      uri: lines[uriIndex].trim()
    })
  }
  return variants
}

/** 下载 master 里带 URI 的音轨 / 字幕轨，返回 lineIndex → 改写后的行 */
async function localizeRenditions(
  ctx: DownloadContext,
  url: string,
  dirRel: string,
  lines: string[],
  depth: number
): Promise<Map<number, string>> {
  const rewrites = new Map<number, string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.toUpperCase().startsWith('#EXT-X-MEDIA:')) continue
    const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))
    const uri = attrs.URI
    const type = (attrs.TYPE ?? 'media').toLowerCase()
    if (!uri || type === 'closed-captions') continue
    const counter = (ctx.mediaCounters.get(type) ?? 0) + 1
    ctx.mediaCounters.set(type, counter)
    const childRel = await localizePlaylist(
      ctx,
      resolveUrl(url, uri),
      joinRel(dirRel, `${type}-${counter}`),
      depth + 1
    )
    rewrites.set(index, replaceUri(line, relativeFrom(dirRel, childRel)))
  }
  return rewrites
}

async function localizeMaster(
  ctx: DownloadContext,
  url: string,
  dirRel: string,
  lines: string[],
  depth: number
): Promise<string> {
  const variants = parseVariants(lines)
  if (variants.length === 0) throw new HlsDownloadError('PLAYLIST', 'master 播放列表里没有码率')
  const chosen = variants.reduce((best, item) => (item.bandwidth > best.bandwidth ? item : best))

  // 先下音轨 / 字幕（量小），再下视频变体：进度总量尽早确定，视频分片占大头
  const renditionRewrites = await localizeRenditions(ctx, url, dirRel, lines, depth)
  const variantRel = await localizePlaylist(
    ctx,
    resolveUrl(url, chosen.uri),
    joinRel(dirRel, 'variant'),
    depth + 1
  )

  const skip = new Set<number>()
  for (const variant of variants) {
    if (variant === chosen) continue
    skip.add(variant.tagIndex)
    skip.add(variant.uriIndex)
  }
  const out: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    if (line.toUpperCase().startsWith('#EXT-X-I-FRAME-STREAM-INF')) continue
    if (skip.has(index)) continue
    if (index === chosen.uriIndex) {
      out.push(relativeFrom(dirRel, variantRel))
      continue
    }
    const rewrite = renditionRewrites.get(index)
    out.push(rewrite ?? line)
  }
  return writePlaylist(ctx, dirRel, out)
}

async function localizeMedia(
  ctx: DownloadContext,
  url: string,
  dirRel: string,
  lines: string[]
): Promise<string> {
  const out: string[] = []
  const jobs: SegmentJob[] = []
  let endList = false
  let segmentIndex = 0
  let pendingRange: { length: number; offset?: number } | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (!line.startsWith('#')) {
      segmentIndex += 1
      const absolute = resolveUrl(url, line)
      const name = `seg-${String(segmentIndex).padStart(6, '0')}${segmentExtension(absolute)}`
      const job: SegmentJob = { url: absolute, rel: joinRel(dirRel, name) }
      if (pendingRange) {
        const start = pendingRange.offset ?? ctx.byteRangeEnds.get(absolute) ?? 0
        const end = start + pendingRange.length - 1
        job.range = `${start}-${end}`
        job.byteRange = { start, length: pendingRange.length }
        ctx.byteRangeEnds.set(absolute, end + 1)
        pendingRange = null
      }
      jobs.push(job)
      out.push(name)
      continue
    }

    if (line.toUpperCase().startsWith('#EXT-X-ENDLIST')) {
      endList = true
      out.push(line)
      continue
    }
    if (line.toUpperCase().startsWith('#EXT-X-BYTERANGE:')) {
      const value = line.slice(line.indexOf(':') + 1).trim()
      const [lengthText, offsetText] = value.split('@')
      const length = Number(lengthText)
      const offset = offsetText !== undefined ? Number(offsetText) : undefined
      if (Number.isFinite(length) && length > 0) {
        pendingRange = {
          length,
          offset: Number.isFinite(offset) ? offset : undefined
        }
      }
      continue
    }
    if (line.toUpperCase().startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))
      const method = (attrs.METHOD ?? '').toUpperCase()
      if (method === '' || method === 'NONE') {
        out.push(line)
        continue
      }
      if (method !== 'AES-128') {
        throw new HlsDownloadError('ENCRYPTED', `不支持的加密方式：${method}`)
      }
      if (!attrs.URI) throw new HlsDownloadError('PLAYLIST', '密钥地址缺失')
      const local = await downloadAux(ctx, resolveUrl(url, attrs.URI), dirRel, 'key', '.bin')
      out.push(replaceUri(line, local))
      continue
    }
    if (line.toUpperCase().startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))
      if (!attrs.URI) throw new HlsDownloadError('PLAYLIST', 'init 分片地址缺失')
      const local = await downloadAux(ctx, resolveUrl(url, attrs.URI), dirRel, 'init', '.mp4')
      out.push(dropAttribute(replaceUri(line, local), 'BYTERANGE'))
      continue
    }
    out.push(line)
  }

  if (!endList) throw new HlsDownloadError('LIVE', '直播流不支持缓存')
  if (jobs.length === 0) throw new HlsDownloadError('NO_SEGMENTS', '播放列表里没有分片')
  ctx.totalSegments += jobs.length
  if (ctx.totalSegments > MAX_SEGMENTS) {
    throw new HlsDownloadError('TOO_LARGE', '分片数量超过上限')
  }

  await runPool(jobs, ctx.concurrency, async (job) => {
    throwIfAborted(ctx.signal)
    // 断点续传：本地已经有这个文件就跳过（文件是 rename 出来的，存在即完整）
    const existing = await existingFileSize(ctx, job.rel)
    if (existing !== null) {
      ctx.downloaded += 1
      ctx.receivedBytes += existing
      reportProgress(ctx)
      return
    }
    const { bytes, status } = await fetchResource(ctx, job.url, job.range)
    let body = bytes
    if (job.byteRange && status === 200 && bytes.byteLength > job.byteRange.length) {
      body = bytes.slice(job.byteRange.start, job.byteRange.start + job.byteRange.length)
    }
    await writeFileRel(ctx, job.rel, body)
    ctx.downloaded += 1
    ctx.receivedBytes += body.byteLength
    reportProgress(ctx)
  })

  return writePlaylist(ctx, dirRel, out)
}

/** 递归本地化一个 playlist；返回值是相对包根目录的 playlist 路径 */
async function localizePlaylist(
  ctx: DownloadContext,
  url: string,
  dirRel: string,
  depth: number
): Promise<string> {
  throwIfAborted(ctx.signal)
  if (depth > 3) throw new HlsDownloadError('PLAYLIST', '播放列表嵌套过深')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HlsDownloadError('PLAYLIST', '播放地址不合法')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HlsDownloadError('PLAYLIST', '只支持 http(s) 播放地址')
  }
  const { text, url: finalUrl } = await fetchText(ctx, url)
  const lines = text.split(/\r?\n/)
  // 相对分片要按重定向后的最终地址解析，否则 http → https / 换域名的站会全部 404
  return isMasterPlaylist(lines)
    ? localizeMaster(ctx, finalUrl, dirRel, lines, depth)
    : localizeMedia(ctx, finalUrl, dirRel, lines)
}

/** 下载一整套 HLS 点播流到 dir；失败时抛出 HlsDownloadError（调用方负责清理目录） */
export async function downloadHlsPackage(options: HlsDownloadOptions): Promise<HlsDownloadResult> {
  if (!options.url || !options.dir) {
    throw new HlsDownloadError('PLAYLIST', '缺少播放地址或保存目录')
  }
  await fsp.mkdir(options.dir, { recursive: true })
  // 暂停 / 崩溃留下的临时文件先清掉，剩下的成品文件就是断点
  await cleanTempFiles(options.dir)
  const ctx: DownloadContext = {
    dir: options.dir,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    concurrency: Math.max(1, options.concurrency ?? SEGMENT_CONCURRENCY),
    onProgress: options.onProgress,
    downloaded: 0,
    totalSegments: 0,
    receivedBytes: 0,
    createdDirs: new Set(),
    auxCache: new Map(),
    auxCounters: new Map(),
    byteRangeEnds: new Map(),
    mediaCounters: new Map()
  }
  const playlistRel = await localizePlaylist(ctx, options.url, '', 0)
  return {
    bytes: ctx.receivedBytes,
    segments: ctx.downloaded,
    playlistFile: join(options.dir, ...playlistRel.split('/'))
  }
}
