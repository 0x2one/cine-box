import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { fetchCollectText } from './collect-http'
import { parseCollectPage, type CollectedVideo } from './video-collect-parser'
import type { Site } from './site-store'
import type { DetailSourceRow, VideoCacheStore } from './video-cache-store'
import type {
  CachedVideoDetail,
  DetailClearResult,
  VideoCapacityDrift,
  VideoDetailRefreshResult,
  VideoDetailResult,
  VideoDetailSource,
  VideoPlayLine
} from './video-types'

const DETAIL_FORMAT = 'cine-box-video-detail'
const DETAIL_VERSION = 1
const MAX_FILE_SIZE = 2 * 1024 * 1024
const MAX_INTRO = 8000
const MAX_EPISODES = 5000
const ACCESS_THROTTLE_MS = 60 * 60 * 1000
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/
const SAFE_SITE = /^[A-Za-z0-9_-]{1,64}$/

type DetailErrorCode =
  | 'FILE_MISSING'
  | 'FILE_CORRUPT'
  | 'TOO_LARGE'
  | 'FILE_WRITE_FAILED'
  | 'NETWORK'
  | 'HTTP'
  | 'PARSE'
  | 'CLOSED'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'ABORT'

interface ReadCachedResult {
  ok: boolean
  detail?: CachedVideoDetail
  error?: DetailErrorCode
}

export interface VideoDetailCache {
  /** 索引优先：命中读文件，未命中 / 文件丢失时按 autoFetch 决定是否实时抓取 */
  read: (videoId: number, autoFetch: boolean) => Promise<VideoDetailResult>
  /** 刷新过期 / 缺失 / 损坏的详情 */
  refresh: (videoId: number, force: boolean) => Promise<VideoDetailRefreshResult>
  clear: (siteId?: string) => Promise<DetailClearResult>
  /** 删除单个站点的详情目录（删站点时调用） */
  removeSite: (siteId: string) => Promise<void>
  /** 删除整个详情目录（清空全部缓存时调用） */
  removeAll: () => Promise<void>
  scan: (fixMissing: boolean) => Promise<VideoCapacityDrift>
  /** 供采集全量替换时按来源删除详情文件 */
  removeSourceFile: (source: DetailSourceRow) => Promise<void>
  /** 采集时预热详情：只抓缺失 / 过期的来源，失败只记索引错误 */
  warm: (sources: DetailSourceRow[]) => Promise<{ cached: number; failed: number }>
}

function safeSegment(value: string): string {
  return SAFE_ID.test(value) ? value : createHash('sha1').update(value).digest('hex').slice(0, 32)
}

function safeSiteSegment(value: string): string {
  return SAFE_SITE.test(value) ? value : createHash('sha1').update(value).digest('hex').slice(0, 32)
}

/** 详情相对路径：`siteId/safeSourceVideoId.json`，统一用正斜杠存库 */
function relativePathOf(siteId: string, sourceVideoId: string): string {
  return `${safeSiteSegment(siteId)}/${safeSegment(sourceVideoId)}.json`
}

function playLinesOf(item: CollectedVideo): VideoPlayLine[] {
  return item.playLines
    .slice(0, 20)
    .map((line) => ({
      flag: line.flag.slice(0, 80),
      episodes: line.episodes.slice(0, MAX_EPISODES).map((episode) => ({
        name: episode.name.slice(0, 200),
        url: episode.url.slice(0, 4096)
      }))
    }))
    .filter((line) => line.episodes.length > 0)
}

function buildDetail(item: CollectedVideo, source: DetailSourceRow): CachedVideoDetail {
  return {
    format: DETAIL_FORMAT,
    version: DETAIL_VERSION,
    siteId: source.siteId,
    sourceVideoId: source.sourceVideoId,
    fetchedAt: new Date().toISOString(),
    sourceTime: item.sourceTime || source.sourceTime,
    sourceTs: item.sourceTs || source.sourceTs,
    name: item.name || source.name,
    pic: item.pic || source.pic,
    note: item.note || source.note,
    intro: (item.intro || '').slice(0, MAX_INTRO),
    state: item.state.slice(0, 80),
    year: item.year.slice(0, 20),
    area: item.area.slice(0, 80),
    lang: item.lang.slice(0, 80),
    actor: (item.actor || source.vodActor).slice(0, 1000),
    vodClass: (item.vodClass || source.vodClass).slice(0, 500),
    director: item.director.slice(0, 500),
    category: {
      id: (item.categoryId || source.categoryId).slice(0, 64),
      name: (item.categoryName || source.categoryName).slice(0, 120)
    },
    playLines: playLinesOf(item)
  }
}

function asString(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function parseCachedDetail(
  raw: unknown,
  siteId: string,
  sourceVideoId: string
): CachedVideoDetail | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  if (data.format !== DETAIL_FORMAT || data.version !== DETAIL_VERSION) return null
  if (data.siteId !== siteId || data.sourceVideoId !== sourceVideoId) return null
  const categoryRaw =
    data.category && typeof data.category === 'object' && !Array.isArray(data.category)
      ? (data.category as Record<string, unknown>)
      : {}
  const linesRaw = Array.isArray(data.playLines) ? data.playLines : []
  const playLines: VideoPlayLine[] = []
  for (const line of linesRaw.slice(0, 20)) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) continue
    const lineRaw = line as Record<string, unknown>
    const episodesRaw = Array.isArray(lineRaw.episodes) ? lineRaw.episodes : []
    const episodes = episodesRaw
      .slice(0, MAX_EPISODES)
      .map((episode) => {
        if (!episode || typeof episode !== 'object' || Array.isArray(episode)) return null
        const value = episode as Record<string, unknown>
        const url = asString(value.url, 4096)
        if (!url) return null
        return { name: asString(value.name, 200), url }
      })
      .filter((episode): episode is { name: string; url: string } => episode !== null)
    if (episodes.length > 0) {
      playLines.push({ flag: asString(lineRaw.flag, 80), episodes })
    }
  }
  return {
    format: DETAIL_FORMAT,
    version: DETAIL_VERSION,
    siteId,
    sourceVideoId,
    fetchedAt: asString(data.fetchedAt, 40),
    sourceTime: asString(data.sourceTime, 40),
    sourceTs: Number(data.sourceTs) || 0,
    name: asString(data.name, 300),
    pic: asString(data.pic, 2048),
    note: asString(data.note, 500),
    intro: asString(data.intro, MAX_INTRO),
    state: asString(data.state, 80),
    year: asString(data.year, 20),
    area: asString(data.area, 80),
    lang: asString(data.lang, 80),
    actor: asString(data.actor, 1000),
    vodClass: asString(data.vodClass, 500),
    director: asString(data.director, 500),
    category: { id: asString(categoryRaw.id, 64), name: asString(categoryRaw.name, 120) },
    playLines
  }
}

function errorOf(error: unknown): DetailErrorCode {
  const code = String((error as Error)?.message ?? error)
  const known: DetailErrorCode[] = [
    'FILE_MISSING',
    'FILE_CORRUPT',
    'TOO_LARGE',
    'FILE_WRITE_FAILED',
    'NETWORK',
    'HTTP',
    'PARSE',
    'CLOSED',
    'AUTH',
    'NOT_FOUND',
    'ABORT'
  ]
  return known.includes(code as DetailErrorCode) ? (code as DetailErrorCode) : 'FILE_WRITE_FAILED'
}

/** 详情文件缓存：文件正文 + SQLite 索引，索引优先、未命中实时抓取 */
export function createVideoDetailCache(options: {
  rootDir: string
  store: VideoCacheStore
  listSites: () => Site[]
  /** 清空 / 删站点时递增，阻止在途写入落盘 */
  epoch: () => number
  bumpEpoch: () => void
}): VideoDetailCache {
  const { rootDir, store, listSites, epoch, bumpEpoch } = options
  const inflightRead = new Map<number, Promise<VideoDetailResult>>()
  const inflightRefresh = new Map<number, Promise<VideoDetailRefreshResult>>()

  function siteById(siteId: string): Site | null {
    return listSites().find((site) => site.id === siteId) ?? null
  }

  function siteNames(): Map<string, string> {
    return new Map(listSites().map((site) => [site.id, site.display || site.name]))
  }

  function resolveRelative(relative: string): string | null {
    const parts = relative.split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..')
    if (parts.length === 0) return null
    const target = resolve(rootDir, ...parts)
    if (target !== rootDir && !target.startsWith(rootDir + sep)) return null
    return target
  }

  function pathOf(source: DetailSourceRow): { relative: string; absolute: string } {
    const relative = source.detailPath || relativePathOf(source.siteId, source.sourceVideoId)
    const absolute = resolveRelative(relative)
    return {
      relative,
      absolute: absolute ?? resolve(rootDir, relativePathOf(source.siteId, source.sourceVideoId))
    }
  }

  async function readCached(source: DetailSourceRow): Promise<ReadCachedResult> {
    const target = pathOf(source)
    try {
      const stats = await fs.lstat(target.absolute)
      if (!stats.isFile() || stats.isSymbolicLink()) return { ok: false, error: 'FILE_CORRUPT' }
      if (stats.size > MAX_FILE_SIZE) return { ok: false, error: 'TOO_LARGE' }
      const raw = await fs.readFile(target.absolute, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, error: 'FILE_CORRUPT' }
      }
      const detail = parseCachedDetail(parsed, source.siteId, source.sourceVideoId)
      if (!detail) return { ok: false, error: 'FILE_CORRUPT' }
      store.touchDetailAccess(source.id, new Date().toISOString(), ACCESS_THROTTLE_MS)
      return { ok: true, detail }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'FILE_MISSING' }
      return { ok: false, error: 'FILE_CORRUPT' }
    }
  }

  async function writeCached(source: DetailSourceRow, detail: CachedVideoDetail): Promise<number> {
    const startedEpoch = epoch()
    const target = pathOf(source)
    await fs.mkdir(dirname(target.absolute), { recursive: true })

    let body = detail
    let serialized = JSON.stringify(body)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_SIZE) {
      body = {
        ...body,
        intro: body.intro.slice(0, 2000),
        playLines: body.playLines.map((line) => ({
          flag: line.flag,
          episodes: line.episodes.slice(0, 2000)
        }))
      }
      serialized = JSON.stringify(body)
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_SIZE) throw new Error('TOO_LARGE')

    const temp = `${target.absolute}.tmp-${randomUUID()}`
    try {
      await fs.writeFile(temp, serialized, 'utf8')
      if (startedEpoch !== epoch()) {
        await fs.unlink(temp).catch(() => {})
        throw new Error('ABORT')
      }
      try {
        await fs.rename(temp, target.absolute)
      } catch {
        // Windows 上目标被占用时 rename 会失败，先删目标再重试一次
        await fs.unlink(target.absolute).catch(() => {})
        await fs.rename(temp, target.absolute)
      }
    } catch (error) {
      await fs.unlink(temp).catch(() => {})
      throw error instanceof Error ? error : new Error('FILE_WRITE_FAILED')
    }

    const stats = await fs.stat(target.absolute).catch(() => null)
    if (startedEpoch !== epoch()) throw new Error('ABORT')
    const current = store.getDetailSource(source.id)
    if (!current) throw new Error('NOT_FOUND')
    const now = new Date().toISOString()
    store.setDetailIndex(source.id, {
      detailPath: target.relative,
      detailSize: stats?.size ?? Buffer.byteLength(serialized, 'utf8'),
      detailCachedAt: now,
      detailAccessedAt: now,
      detailSourceTs: body.sourceTs || source.sourceTs,
      detailNote: body.note || source.note,
      detailStale: false,
      detailError: ''
    })
    return stats?.size ?? Buffer.byteLength(serialized, 'utf8')
  }

  function detailUrl(site: Site, ids: string[]): string {
    const url = new URL(site.address)
    url.searchParams.set('ac', 'detail')
    url.searchParams.set('ids', ids.join(','))
    if (site.format === 'xml') url.searchParams.set('at', 'xml')
    else url.searchParams.delete('at')
    return url.toString()
  }

  async function fetchBatch(
    site: Site,
    targets: DetailSourceRow[]
  ): Promise<{ details: Map<number, CachedVideoDetail>; failed: Map<number, string> }> {
    const details = new Map<number, CachedVideoDetail>()
    const failed = new Map<number, string>()
    const response = await fetchCollectText(
      detailUrl(
        site,
        targets.map((source) => source.sourceVideoId)
      )
    )
    if (!response.ok) {
      for (const source of targets) failed.set(source.id, response.error)
      return { details, failed }
    }
    let parsed: ReturnType<typeof parseCollectPage>
    try {
      parsed = parseCollectPage(response.text, site.format)
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? 'PARSE')
      for (const source of targets) failed.set(source.id, code)
      return { details, failed }
    }
    const byId = new Map(parsed.items.map((item) => [item.sourceVideoId, item]))
    for (const source of targets) {
      const item = byId.get(source.sourceVideoId)
      if (!item) {
        failed.set(source.id, 'NOT_FOUND')
        continue
      }
      try {
        const detail = buildDetail(item, source)
        await writeCached(source, detail)
        details.set(source.id, detail)
      } catch (error) {
        failed.set(source.id, errorOf(error))
      }
    }
    return { details, failed }
  }

  async function fetchSources(targets: DetailSourceRow[]): Promise<{
    details: Map<number, CachedVideoDetail>
    failed: Map<number, string>
  }> {
    const details = new Map<number, CachedVideoDetail>()
    const failed = new Map<number, string>()
    const groups = new Map<string, DetailSourceRow[]>()
    for (const source of targets) {
      const list = groups.get(source.siteId) ?? []
      list.push(source)
      groups.set(source.siteId, list)
    }
    for (const [siteId, sources] of groups) {
      const site = siteById(siteId)
      if (!site) {
        for (const source of sources) failed.set(source.id, 'NOT_FOUND')
        continue
      }
      for (let index = 0; index < sources.length; index += 10) {
        const batch = sources.slice(index, index + 10)
        const result = await fetchBatch(site, batch)
        for (const [id, detail] of result.details) details.set(id, detail)
        for (const [id, error] of result.failed) {
          failed.set(id, error)
          store.setDetailIndex(id, { detailError: error })
        }
      }
    }
    return { details, failed }
  }

  function assemble(videoId: number, details: Map<number, CachedVideoDetail>): VideoDetailResult {
    const video = store.getVideoDetail(videoId)
    if (!video) return { ok: false, error: 'NOT_FOUND' }
    const names = siteNames()
    const sources: VideoDetailSource[] = video.sources.map((source) => ({
      ...source,
      siteName: names.get(source.siteId) ?? '',
      detailAvailable: details.has(source.id),
      detail: details.get(source.id)
    }))
    return { ok: true, video: { ...video, sources } }
  }

  async function read(videoId: number, autoFetch: boolean): Promise<VideoDetailResult> {
    const existing = store.getVideoDetail(videoId)
    if (!existing) return { ok: false, error: 'NOT_FOUND' }
    const details = new Map<number, CachedVideoDetail>()
    const targets: DetailSourceRow[] = []
    for (const source of existing.sources) {
      const row = store.getDetailSource(source.id)
      if (!row) continue
      if (row.detailCachedAt !== '' && row.detailPath !== '') {
        const cached = await readCached(row)
        if (cached.ok && cached.detail) {
          details.set(row.id, cached.detail)
          if (row.detailError) store.setDetailIndex(row.id, { detailError: '' })
          continue
        }
        if (autoFetch) {
          store.clearDetailIndex(row.id)
          targets.push({ ...row, detailPath: '', detailCachedAt: '' })
        } else if (row.detailCachedAt !== '') {
          // 只读模式不写库：已有索引但文件坏了才记录错误，未缓存直接返回不可用
          store.setDetailIndex(row.id, { detailError: cached.error ?? 'FILE_MISSING' })
        }
        continue
      }
      if (autoFetch) targets.push(row)
      else if (row.detailCachedAt !== '') {
        store.setDetailIndex(row.id, { detailError: 'FILE_MISSING' })
      }
    }
    if (targets.length > 0) {
      const result = await fetchSources(targets)
      for (const [id, detail] of result.details) details.set(id, detail)
    }
    return assemble(videoId, details)
  }

  async function refresh(videoId: number, force: boolean): Promise<VideoDetailRefreshResult> {
    const existing = store.getVideoDetail(videoId)
    if (!existing) return { ok: false, error: 'NOT_FOUND', refreshed: 0, failed: 0 }
    const targets: DetailSourceRow[] = []
    for (const source of existing.sources) {
      const row = store.getDetailSource(source.id)
      if (!row) continue
      if (!force && row.detailCachedAt !== '' && row.detailPath !== '' && !row.detailStale) {
        const cached = await readCached(row)
        if (cached.ok) {
          if (row.detailError) store.setDetailIndex(row.id, { detailError: '' })
          continue
        }
      }
      targets.push(row)
    }
    let refreshed = 0
    let failed = 0
    if (targets.length > 0) {
      const result = await fetchSources(targets)
      refreshed = result.details.size
      failed = targets.length - refreshed
    }
    const latest = await read(videoId, false)
    return { ...latest, refreshed, failed }
  }

  async function directoryStats(
    target: string
  ): Promise<{ files: number; bytes: number; temp: number }> {
    const result = { files: 0, bytes: 0, temp: 0 }
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(target, { withFileTypes: true })
    } catch {
      return result
    }
    for (const entry of entries) {
      const child = join(target, entry.name)
      if (entry.isDirectory()) {
        const nested = await directoryStats(child)
        result.files += nested.files
        result.bytes += nested.bytes
        result.temp += nested.temp
      } else if (entry.isFile()) {
        if (entry.name.includes('.tmp-')) {
          result.temp += 1
          continue
        }
        const stats = await fs.stat(child).catch(() => null)
        if (!stats) continue
        result.files += 1
        result.bytes += stats.size
      }
    }
    return result
  }

  async function clear(siteId?: string): Promise<DetailClearResult> {
    bumpEpoch()
    const target = siteId ? join(rootDir, safeSiteSegment(siteId)) : rootDir
    const stats = await directoryStats(target)
    try {
      await fs.rm(target, { recursive: true, force: true })
    } catch {
      // 文件被占用时仍然重置索引，避免详情页继续指向坏文件
      store.resetDetailIndex(siteId)
      return {
        ok: false,
        freedBytes: stats.bytes,
        removedFiles: stats.files,
        error: 'FILE_DELETE_FAILED'
      }
    }
    store.resetDetailIndex(siteId)
    return { ok: true, freedBytes: stats.bytes, removedFiles: stats.files }
  }

  async function removeSite(siteId: string): Promise<void> {
    bumpEpoch()
    await fs
      .rm(join(rootDir, safeSiteSegment(siteId)), { recursive: true, force: true })
      .catch(() => {})
  }

  async function removeAll(): Promise<void> {
    bumpEpoch()
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }

  async function removeSourceFile(source: DetailSourceRow): Promise<void> {
    const target = pathOf(source)
    await fs.unlink(target.absolute).catch(() => {})
  }

  async function scan(fixMissing: boolean): Promise<VideoCapacityDrift> {
    const files = new Set<string>()
    let fileCount = 0
    let fileBytes = 0
    let tempFiles = 0
    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const child = join(directory, entry.name)
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(child, relative)
        } else if (entry.isFile()) {
          if (entry.name.includes('.tmp-')) {
            tempFiles += 1
            continue
          }
          if (!entry.name.endsWith('.json')) continue
          const stats = await fs.stat(child).catch(() => null)
          if (!stats) continue
          fileCount += 1
          fileBytes += stats.size
          files.add(relative)
        }
      }
    }
    await walk(rootDir, '')

    const indexed = store.listIndexedDetailSources()
    let missing = 0
    let fixed = 0
    const indexedPaths = new Set<string>()
    for (const row of indexed) {
      const relative = row.path.replace(/\\/g, '/')
      if (relative) indexedPaths.add(relative)
      const exists = relative ? files.has(relative) : false
      if (!exists) {
        missing += 1
        if (fixMissing) {
          store.clearDetailIndex(row.id)
          fixed += 1
        }
      }
    }
    let orphan = 0
    for (const path of files) {
      if (!indexedPaths.has(path)) orphan += 1
    }
    return {
      indexCount: indexed.length,
      indexBytes: store.capacity().detailBytes,
      fileCount,
      fileBytes,
      missing,
      orphan,
      tempFiles,
      fixed,
      scannedAt: new Date().toISOString()
    }
  }

  async function warm(sources: DetailSourceRow[]): Promise<{ cached: number; failed: number }> {
    const targets = sources.filter((source) => source.detailCachedAt === '' || source.detailStale)
    if (targets.length === 0) return { cached: 0, failed: 0 }
    const { details, failed } = await fetchSources(targets)
    return { cached: details.size, failed: failed.size }
  }

  return {
    read: (videoId, autoFetch) => {
      const running = inflightRead.get(videoId)
      if (running) return running
      const promise = read(videoId, autoFetch).finally(() => inflightRead.delete(videoId))
      inflightRead.set(videoId, promise)
      return promise
    },
    refresh: (videoId, force) => {
      const running = inflightRefresh.get(videoId)
      if (running) return running
      const promise = refresh(videoId, force).finally(() => inflightRefresh.delete(videoId))
      inflightRefresh.set(videoId, promise)
      return promise
    },
    clear,
    removeSite,
    removeAll,
    scan,
    removeSourceFile,
    warm
  }
}
