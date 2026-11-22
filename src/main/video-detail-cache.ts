import { createHash, randomUUID } from 'crypto'
import { existsSync, promises as fs } from 'fs'
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
  /**
   * 采集时用列表页响应里的详情字段直接落盘（整页模式 ac=detail 已带回简介与播放线路），
   * 不再按 id 重复请求；返回没能直接落盘、需要联网补抓的来源
   */
  warmFromPage: (
    sources: DetailSourceRow[],
    items: Map<string, CollectedVideo>
  ) => Promise<{ cached: number; failed: number; fallback: DetailSourceRow[] }>
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

/**
 * 详情内容指纹：只算「库里没有、只存在于详情文件」的两样——完整简介和播放线路。
 * `video_sources` 里不存线路，所以「只有播放地址变了」靠 `source_ts` / 备注是发现不了的；
 * 采集时用这次响应算出指纹跟缓存里的比，不一致就重写缓存。
 */
function detailFingerprint(detail: Pick<CachedVideoDetail, 'intro' | 'playLines'>): string {
  return createHash('sha1')
    .update(JSON.stringify({ intro: detail.intro, playLines: detail.playLines }))
    .digest('hex')
}

/**
 * 详情大到会被 `writeCached` 截断时，落盘的内容和这份对象不一样、指纹必然对不上，
 * 这种条目干脆不做指纹比对（保留现有缓存），否则每次采集都会白重写一遍两兆的文件。
 * 只按字符串长度粗估，不序列化，常见详情几微秒。
 */
function mightTruncate(detail: Pick<CachedVideoDetail, 'intro' | 'playLines'>): boolean {
  let size = detail.intro.length
  for (const line of detail.playLines) {
    size += line.flag.length
    for (const episode of line.episodes) {
      size += episode.name.length + episode.url.length + 40
      if (size > MAX_FILE_SIZE) return true
    }
  }
  return false
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
  /**
   * 回收目录：整目录先 rename 到这里，再后台慢慢删。
   * 同一卷上 rename 是瞬时的，而删 5 万个文件要好几分钟——清缓存 / 删站点之后马上开始的
   * 采集不该等这一步；挪走之后新写入也不会被在途删除误伤。
   */
  const trashDir = join(dirname(rootDir), 'videos-trash')
  // 上次退出时没删完的（崩溃 / 强杀）在后台清掉，不阻塞启动
  void fs.rm(trashDir, { recursive: true, force: true }).catch(() => {})
  const inflightRead = new Map<number, Promise<VideoDetailResult>>()
  const inflightRefresh = new Map<number, Promise<VideoDetailRefreshResult>>()
  /**
   * 已经 mkdir 过的目录：采集一页 100 条都在同一个站点目录下，逐条 mkdir 白花
   * 100 次系统调用（实测 9ms/页）。清空 / 删站点时把对应项删掉，否则会往删掉的目录里写。
   */
  const createdDirs = new Set<string>()

  /** 目录被整体删掉之后要忘记它，下次写入重新 mkdir */
  function forgetDirs(prefix: string): void {
    for (const dir of createdDirs) {
      if (prefix === '' || dir === prefix || dir.startsWith(prefix + sep)) createdDirs.delete(dir)
    }
  }

  /**
   * 删掉一个目录：先整体 rename 到回收目录（瞬时），真正的删除在后台跑。
   * rename 失败（跨卷 / 被占用）时退回原地删除，保证清理最终一定完成。
   */
  async function discardDirectory(target: string): Promise<void> {
    const staged = join(trashDir, randomUUID())
    try {
      await fs.mkdir(trashDir, { recursive: true })
      await fs.rename(target, staged)
    } catch {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      return
    }
    void fs.rm(staged, { recursive: true, force: true }).catch(() => {})
  }

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

  /**
   * 只读详情文件算指纹，不碰索引 / 访问时间。
   * 采集回填指纹（老库 `detail_hash` 为空）时用：读 + 解析约 70µs，重写一个文件约 1.7ms，
   * 5 万条缓存下来差 80 秒左右。
   */
  async function readFileFingerprint(source: DetailSourceRow): Promise<string | null> {
    const target = pathOf(source)
    try {
      const stats = await fs.lstat(target.absolute)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_SIZE) return null
      const parsed = JSON.parse(await fs.readFile(target.absolute, 'utf8')) as unknown
      const detail = parseCachedDetail(parsed, source.siteId, source.sourceVideoId)
      return detail ? detailFingerprint(detail) : null
    } catch {
      return null
    }
  }

  async function writeCached(
    source: DetailSourceRow,
    detail: CachedVideoDetail,
    /** 调用方已经算过的指纹，省一次序列化 + sha1 */
    fingerprint = detailFingerprint(detail)
  ): Promise<number> {
    const startedEpoch = epoch()
    const target = pathOf(source)
    const dir = dirname(target.absolute)
    if (!createdDirs.has(dir)) {
      await fs.mkdir(dir, { recursive: true })
      createdDirs.add(dir)
    }

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
    // 落盘大小就是这段字节数，不用再 stat 一次拿 size
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_FILE_SIZE) throw new Error('TOO_LARGE')
    // 被截断过的话指纹必须按落盘的这份算，否则下次采集读回文件会一直对不上、每次重写
    const hash = body === detail ? fingerprint : detailFingerprint(body)

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

    if (startedEpoch !== epoch()) throw new Error('ABORT')
    const current = store.getDetailSource(source.id)
    if (!current) throw new Error('NOT_FOUND')
    const now = new Date().toISOString()
    store.setDetailIndex(source.id, {
      detailPath: target.relative,
      detailSize: bytes,
      detailCachedAt: now,
      detailAccessedAt: now,
      detailSourceTs: body.sourceTs || source.sourceTs,
      detailNote: body.note || source.note,
      detailStale: false,
      detailError: '',
      detailHash: hash
    })
    return bytes
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
    forgetDirs(resolve(target))
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
    const target = resolve(rootDir, safeSiteSegment(siteId))
    forgetDirs(target)
    if (existsSync(target)) await discardDirectory(target)
  }

  async function removeAll(): Promise<void> {
    bumpEpoch()
    forgetDirs(rootDir)
    if (!existsSync(rootDir)) return
    await discardDirectory(rootDir)
    // 回收目录已经接管旧文件，这里把空目录补回来，后续写入照常
    await fs.mkdir(rootDir, { recursive: true }).catch(() => {})
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

  /**
   * 列表页已经是 ac=detail 整页模式，响应里的每条都带了完整简介与播放线路，
   * 直接 buildDetail + 写文件即可，省掉「每 10 个 id 再抓一次」的重复下载。
   * 整页响应里缺条目、或简介与线路都为空时，说明这站的整页模式可能不给详情，
   * 交回给 warm() 按 id 补抓，行为与改造前一致。
   *
   * 「要不要重写」的判断：有新内容、已过期、或者内容指纹和缓存里的不一样。
   * 最后一条正是为了「播放线路换了但 source_ts 没变」——这种情况库里的字段一个都没动，
   * 只能靠这里比对详情内容本身；指纹一致就跳过，避免每次采集都重写几万个文件。
   */
  async function warmFromPage(
    sources: DetailSourceRow[],
    items: Map<string, CollectedVideo>
  ): Promise<{ cached: number; failed: number; fallback: DetailSourceRow[] }> {
    const fallback: DetailSourceRow[] = []
    /** 老库回填：只是补指纹，文件内容不变，攒一页一次性写库 */
    const backfill: { id: number; hash: string }[] = []
    let cached = 0
    let failed = 0
    for (const source of sources) {
      const item = items.get(source.sourceVideoId)
      if (!item || (item.playLines.length === 0 && item.intro === '')) {
        fallback.push(source)
        continue
      }
      const detail = buildDetail(item, source)
      const fingerprint = detailFingerprint(detail)
      const hasFile =
        source.detailCachedAt !== '' && source.detailPath !== '' && !source.detailStale
      // 超大详情会被落盘截断，指纹比不准，直接保留现有缓存（别每次重写 2MB）
      if (hasFile && mightTruncate(detail)) continue
      if (hasFile) {
        if (source.detailHash !== '') {
          if (source.detailHash === fingerprint) continue
        } else {
          // 老库还没有指纹：读一下现有文件对比，内容一致就只补指纹，不重写文件
          if ((await readFileFingerprint(source)) === fingerprint) {
            backfill.push({ id: source.id, hash: fingerprint })
            continue
          }
        }
      }
      try {
        await writeCached(source, detail, fingerprint)
        cached += 1
      } catch (error) {
        const code = errorOf(error)
        failed += 1
        store.setDetailIndex(source.id, { detailError: code })
        // 缓存库正在清空 / 应用退出，后面的也不用写了
        if (code === 'ABORT') break
      }
    }
    if (backfill.length > 0) {
      try {
        store.setDetailHashes(backfill)
      } catch {
        // 缓存库已关闭 / 正在重建：指纹下次再补，不影响本次采集
      }
    }
    return { cached, failed, fallback }
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
    warm,
    warmFromPage
  }
}
