import { existsSync, rmSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { closeDatabase, inTransaction, openDatabase } from './database'
import type { CollectedVideo } from './video-collect-parser'
import { makeExcerpt, makeFtsQuery, makeNameKey, makeSearchText, truncate } from './video-text'
import type {
  CollectMode,
  CollectStatus,
  FetchRange,
  VideoCapacity,
  VideoCapacitySite,
  VideoCollectProgress,
  VideoDetail,
  VideoDetailSource,
  VideoListQuery,
  VideoListItem,
  VideoListResult,
  VideoStats,
  VideoUpdateInput,
  VideoUpdateResult
} from './video-types'

/** 单页写入的计数，与 collect_progress 的计数器语义一致 */
export interface PageWriteResult {
  fetched: number
  inserted: number
  updated: number
  failed: number
  /** 本页写入（新增或更新）的来源 id，供采集时预热详情缓存 */
  sourceIds: number[]
}

export interface ProgressPatch {
  status?: CollectStatus
  page?: number
  pageCount?: number
  recordCount?: number
  pageSize?: number
  fetchedDelta?: number
  insertedDelta?: number
  updatedDelta?: number
  failedDelta?: number
  deletedDelta?: number
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface StaleSource {
  id: number
  sourceVideoId: string
  videoId: number
}

export interface DetailSourceRow {
  id: number
  siteId: string
  sourceVideoId: string
  videoId: number
  name: string
  pic: string
  note: string
  sourceTime: string
  sourceTs: number
  categoryId: string
  categoryName: string
  vodActor: string
  vodClass: string
  detailPath: string
  detailSize: number
  detailCachedAt: string
  detailAccessedAt: string
  detailSourceTs: number
  detailNote: string
  detailStale: boolean
  detailError: string
}

export interface DetailIndexPatch {
  detailPath?: string
  detailSize?: number
  detailCachedAt?: string
  detailAccessedAt?: string
  detailSourceTs?: number
  detailNote?: string
  detailStale?: boolean
  detailError?: string
}

export interface VideoCacheStore {
  init: () => Promise<void>
  close: () => void
  connection: () => DatabaseSync
  /** 清空缓存库文件并重新建表（不处理详情目录，由调用方负责） */
  rebuild: () => Promise<void>
  ensureSite: (site: { id: string; address: string; format: string }) => void
  listCacheSites: () => { siteId: string; address: string; format: string }[]
  removeSite: (siteId: string) => { sources: number; videos: number }
  /** 清掉没有任何来源的视频与它们的人工编辑（容量页的手动修复入口） */
  purgeOrphanVideos: () => { videos: number; edits: number }
  writePage: (
    siteId: string,
    items: CollectedVideo[],
    runToken: string,
    fullAll: boolean
  ) => PageWriteResult
  listStaleSources: (
    siteId: string,
    runToken: string,
    runStartTs: number,
    limit: number
  ) => StaleSource[]
  deleteSources: (ids: number[]) => number
  recomputeVideos: (videoIds: number[]) => void
  listVideos: (
    query: VideoListQuery,
    categoryFilters?: { siteId: string; categoryId: string }[]
  ) => VideoListResult
  /** 只数总数、不取行（控制台概览的「隐藏了多少」）：条件与 `listVideos` 完全一致 */
  countVideos: (
    query: Pick<VideoListQuery, 'keyword' | 'visibility'>,
    categoryFilters?: { siteId: string; categoryId: string }[]
  ) => number
  /** 按 id 批量取视频（首页海报 / 推荐条目用，可能不在分类前 100 条里） */
  listVideosByIds: (videoIds: number[]) => VideoListItem[]
  /** 指定视频各来源的在线分类，列表页据此解析绑定后的本地分类 */
  listSourceCategories: (
    videoIds: number[]
  ) => { videoId: number; siteId: string; categoryId: string }[]
  updateVideo: (videoId: number, patch: VideoUpdateInput) => VideoUpdateResult
  stats: () => VideoStats
  /** withSites = false 时跳过「按站点分组」的统计（十几万条来源要 100ms+，概览用不到） */
  capacity: (siteNames?: Map<string, string>, withSites?: boolean) => VideoCapacity
  getProgress: (id: string) => VideoCollectProgress | null
  listProgress: (siteId?: string) => VideoCollectProgress[]
  prepareTask: (input: {
    siteId: string
    mode: CollectMode
    fetchRange: FetchRange
    restart?: boolean
    /** 任务实际使用的每页条数：写进进度，首屏就能显示「每页 N 条」 */
    pageSize?: number
  }) => VideoCollectProgress
  updateProgress: (id: string, patch: ProgressPatch) => VideoCollectProgress | null
  resetInterrupted: () => void
  getVideoDetail: (videoId: number) => VideoDetail | null
  getDetailSource: (sourceId: number) => DetailSourceRow | null
  setDetailIndex: (sourceId: number, patch: DetailIndexPatch) => void
  touchDetailAccess: (sourceId: number, at: string, thresholdMs: number) => void
  clearDetailIndex: (sourceId: number) => void
  resetDetailIndex: (siteId?: string) => number
  listIndexedDetailSources: (siteId?: string) => { id: number; siteId: string; path: string }[]
}

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  search_text TEXT NOT NULL,
  latest_ts INTEGER NOT NULL DEFAULT 0,
  latest_time TEXT NOT NULL DEFAULT '',
  primary_source_id INTEGER,
  source_count INTEGER NOT NULL DEFAULT 0,
  pic TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  vod_actor TEXT NOT NULL DEFAULT '',
  vod_class TEXT NOT NULL DEFAULT '',
  intro_excerpt TEXT NOT NULL DEFAULT '',
  intro_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_latest ON videos (latest_ts DESC, id DESC);

CREATE TABLE IF NOT EXISTS video_sources (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  source_video_id TEXT NOT NULL,
  video_id INTEGER NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pic TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  intro_excerpt TEXT NOT NULL DEFAULT '',
  intro_truncated INTEGER NOT NULL DEFAULT 0,
  source_time TEXT NOT NULL DEFAULT '',
  source_ts INTEGER NOT NULL DEFAULT 0,
  category_id TEXT NOT NULL DEFAULT '',
  category_name TEXT NOT NULL DEFAULT '',
  vod_actor TEXT NOT NULL DEFAULT '',
  vod_class TEXT NOT NULL DEFAULT '',
  detail_path TEXT NOT NULL DEFAULT '',
  detail_size INTEGER NOT NULL DEFAULT 0,
  detail_cached_at TEXT NOT NULL DEFAULT '',
  detail_accessed_at TEXT NOT NULL DEFAULT '',
  detail_source_ts INTEGER NOT NULL DEFAULT 0,
  detail_note TEXT NOT NULL DEFAULT '',
  detail_stale INTEGER NOT NULL DEFAULT 0,
  detail_error TEXT NOT NULL DEFAULT '',
  last_full_run TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, source_video_id)
);
CREATE INDEX IF NOT EXISTS idx_video_sources_video ON video_sources (video_id);
CREATE INDEX IF NOT EXISTS idx_video_sources_category ON video_sources (site_id, category_id);
CREATE INDEX IF NOT EXISTS idx_video_sources_site_time ON video_sources (site_id, source_ts DESC);
CREATE INDEX IF NOT EXISTS idx_video_sources_full_run
  ON video_sources (site_id, last_full_run, source_ts);
CREATE INDEX IF NOT EXISTS idx_video_sources_detail
  ON video_sources (site_id, detail_cached_at, detail_size)
  WHERE detail_cached_at <> '';

CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
  search_text,
  content='videos',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS videos_ai AFTER INSERT ON videos BEGIN
  INSERT INTO videos_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS videos_ad AFTER DELETE ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS videos_au AFTER UPDATE OF search_text ON videos BEGIN
  INSERT INTO videos_fts(videos_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
  INSERT INTO videos_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

CREATE TABLE IF NOT EXISTS cache_sites (
  site_id TEXT PRIMARY KEY,
  address TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collect_progress (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
  fetch_range TEXT NOT NULL DEFAULT 'all' CHECK (fetch_range IN ('all', '24h', '48h')),
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'queued', 'running', 'paused', 'replacing', 'done', 'error')),
  page INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  page_size INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, mode, fetch_range)
);
CREATE INDEX IF NOT EXISTS idx_collect_progress_site
  ON collect_progress (site_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS collect_logs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  site_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  fetch_range TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_collect_logs_created ON collect_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_collect_logs_site ON collect_logs (site_id, created_at DESC);

-- 人工编辑：NULL 表示沿用采集值；hidden 单独控制展示端是否隐藏，默认 0（显示）
CREATE TABLE IF NOT EXISTS video_edits (
  video_id INTEGER PRIMARY KEY,
  note TEXT,
  intro TEXT,
  vod_actor TEXT,
  vod_class TEXT,
  pic TEXT,
  pic_site_id TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`

const PRAGMAS = `
PRAGMA cache_size = -32768;
PRAGMA mmap_size = 67108864;
PRAGMA journal_size_limit = 67108864;
PRAGMA wal_autocheckpoint = 1000;
`

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function progressKey(siteId: string, mode: CollectMode, fetchRange: FetchRange): string {
  return `${siteId}:${mode}:${fetchRange}`
}

function rowToProgress(row: Record<string, unknown> | undefined): VideoCollectProgress | null {
  if (!row) return null
  return {
    id: text(row.id),
    siteId: text(row.site_id),
    mode: row.mode === 'full' ? 'full' : 'incremental',
    fetchRange: row.fetch_range === '24h' || row.fetch_range === '48h' ? row.fetch_range : 'all',
    status: text(row.status, 'idle') as CollectStatus,
    page: num(row.page),
    pageCount: num(row.page_count),
    recordCount: num(row.record_count),
    pageSize: num(row.page_size),
    fetched: num(row.fetched),
    inserted: num(row.inserted),
    updated: num(row.updated),
    failed: num(row.failed),
    deleted: num(row.deleted),
    error: text(row.error),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
    updatedAt: text(row.updated_at)
  }
}

function rowToDetailSource(row: Record<string, unknown>): DetailSourceRow {
  return {
    id: num(row.id),
    siteId: text(row.site_id),
    sourceVideoId: text(row.source_video_id),
    videoId: num(row.video_id),
    name: text(row.name),
    pic: text(row.pic),
    note: text(row.note),
    sourceTime: text(row.source_time),
    sourceTs: num(row.source_ts),
    categoryId: text(row.category_id),
    categoryName: text(row.category_name),
    vodActor: text(row.vod_actor),
    vodClass: text(row.vod_class),
    detailPath: text(row.detail_path),
    detailSize: num(row.detail_size),
    detailCachedAt: text(row.detail_cached_at),
    detailAccessedAt: text(row.detail_accessed_at),
    detailSourceTs: num(row.detail_source_ts),
    detailNote: text(row.detail_note),
    detailStale: num(row.detail_stale) !== 0,
    detailError: text(row.detail_error)
  }
}

/**
 * 列表项的统一查询片段：视频库的列表、按 id 批量取（首页推荐）共用，
 * 保证「人工编辑的覆盖值 + 隐藏 + 已编辑」在两处的口径完全一致。
 */
const VIDEO_ITEM_SELECT = `
  SELECT v.id, v.name,
         COALESCE(e.pic, v.pic) AS pic,
         COALESCE(e.note, v.note) AS note,
         COALESCE(e.intro, v.intro_excerpt) AS intro_excerpt,
         CASE WHEN e.intro IS NOT NULL THEN 0 ELSE v.intro_truncated END AS intro_truncated,
         v.latest_ts, v.latest_time, v.source_count,
         COALESCE(e.vod_actor, v.vod_actor) AS vod_actor,
         COALESCE(e.vod_class, v.vod_class) AS vod_class,
         s.site_id, s.source_video_id, s.category_id, s.category_name,
         COALESCE(e.hidden, 0) AS hidden,
         CASE WHEN e.note IS NOT NULL OR e.intro IS NOT NULL OR e.vod_actor IS NOT NULL
                OR e.vod_class IS NOT NULL OR e.pic IS NOT NULL
              THEN 1 ELSE 0 END AS edited`

const VIDEO_ITEM_FROM = `
  FROM videos v
  JOIN video_sources s ON s.id = v.primary_source_id
  LEFT JOIN video_edits e ON e.video_id = v.id`

function rowToVideoItem(raw: Record<string, unknown>): VideoListItem {
  return {
    id: num(raw.id),
    name: text(raw.name),
    pic: text(raw.pic),
    note: text(raw.note),
    introExcerpt: text(raw.intro_excerpt),
    introTruncated: num(raw.intro_truncated) !== 0,
    latestTs: num(raw.latest_ts),
    latestTime: text(raw.latest_time),
    sourceCount: num(raw.source_count),
    vodActor: text(raw.vod_actor),
    vodClass: text(raw.vod_class),
    siteId: text(raw.site_id),
    sourceVideoId: text(raw.source_video_id),
    categoryId: text(raw.category_id),
    categoryName: text(raw.category_name),
    hidden: num(raw.hidden) !== 0,
    edited: num(raw.edited) !== 0
  }
}

/**
 * 视频缓存库：列表、搜索、多站合并、进度、详情索引与容量统计。
 * 详情正文不在这里，只有 video_sources.detail_* 索引。
 */
export function createVideoCacheStore(file: string): VideoCacheStore {
  let db: DatabaseSync | null = null

  function database(): DatabaseSync {
    if (!db) throw new Error('视频缓存库尚未初始化')
    return db
  }

  function initSchema(connection: DatabaseSync): void {
    connection.exec(PRAGMAS)
    connection.exec(CREATE_SCHEMA)
    connection.exec('PRAGMA user_version = 1')
  }

  function ensureSite(site: { id: string; address: string; format: string }): void {
    database()
      .prepare(
        `INSERT INTO cache_sites (site_id, address, format, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (site_id) DO UPDATE SET
           address = excluded.address,
           format = excluded.format,
           updated_at = excluded.updated_at`
      )
      .run(site.id, site.address, site.format, new Date().toISOString())
  }

  function recomputeVideo(connection: DatabaseSync, videoId: number, now: string): void {
    const sources = connection
      .prepare(
        `SELECT id, name, pic, note, intro_excerpt, intro_truncated, source_ts, source_time,
                vod_actor, vod_class
         FROM video_sources
         WHERE video_id = ?
         ORDER BY source_ts DESC, id ASC`
      )
      .all(videoId) as Record<string, unknown>[]

    if (sources.length === 0) {
      connection.prepare('DELETE FROM video_edits WHERE video_id = ?').run(videoId)
      connection.prepare('DELETE FROM videos WHERE id = ?').run(videoId)
      return
    }

    const primary = sources[0]
    const pick = (field: string): unknown => {
      const own = primary[field]
      if (own !== '' && own !== null && own !== undefined) return own
      for (const source of sources) {
        const value = source[field]
        if (value !== '' && value !== null && value !== undefined) return value
      }
      return own ?? ''
    }
    const primaryName = text(primary.name)
    const searchText = makeSearchText(primaryName)
    const latestTs = Math.max(...sources.map((source) => num(source.source_ts)))
    const introSource = sources.find((source) => text(source.intro_excerpt)) ?? primary
    const next = {
      name: primaryName,
      searchText,
      latestTs,
      latestTime: text(pick('source_time')),
      primarySourceId: num(primary.id),
      sourceCount: sources.length,
      pic: text(pick('pic')),
      note: text(pick('note')),
      vodActor: text(pick('vod_actor')),
      vodClass: text(pick('vod_class')),
      introExcerpt: text(introSource.intro_excerpt),
      introTruncated: num(introSource.intro_truncated) !== 0 ? 1 : 0
    }

    const old = connection
      .prepare(
        `SELECT name, search_text, latest_ts, latest_time, primary_source_id, source_count,
                pic, note, vod_actor, vod_class, intro_excerpt, intro_truncated
         FROM videos WHERE id = ?`
      )
      .get(videoId) as Record<string, unknown> | undefined
    if (!old) return

    const changed =
      text(old.name) !== next.name ||
      text(old.search_text) !== next.searchText ||
      num(old.latest_ts) !== next.latestTs ||
      text(old.latest_time) !== next.latestTime ||
      num(old.primary_source_id) !== next.primarySourceId ||
      num(old.source_count) !== next.sourceCount ||
      text(old.pic) !== next.pic ||
      text(old.note) !== next.note ||
      text(old.vod_actor) !== next.vodActor ||
      text(old.vod_class) !== next.vodClass ||
      text(old.intro_excerpt) !== next.introExcerpt ||
      num(old.intro_truncated) !== next.introTruncated
    if (!changed) return

    const columns: string[] = []
    const values: (string | number | null)[] = []
    if (text(old.name) !== next.name) {
      columns.push('name = ?')
      values.push(next.name)
    }
    if (text(old.search_text) !== next.searchText) {
      columns.push('search_text = ?')
      values.push(next.searchText)
    }
    columns.push(
      'latest_ts = ?',
      'latest_time = ?',
      'primary_source_id = ?',
      'source_count = ?',
      'pic = ?',
      'note = ?',
      'vod_actor = ?',
      'vod_class = ?',
      'intro_excerpt = ?',
      'intro_truncated = ?',
      'updated_at = ?'
    )
    values.push(
      next.latestTs,
      next.latestTime,
      next.primarySourceId,
      next.sourceCount,
      next.pic,
      next.note,
      next.vodActor,
      next.vodClass,
      next.introExcerpt,
      next.introTruncated,
      now,
      videoId
    )
    connection.prepare(`UPDATE videos SET ${columns.join(', ')} WHERE id = ?`).run(...values)
  }

  function recomputeVideos(videoIds: number[]): void {
    if (videoIds.length === 0) return
    const connection = database()
    const now = new Date().toISOString()
    inTransaction(connection, (tx) => {
      for (const id of new Set(videoIds)) recomputeVideo(tx, id, now)
    })
  }

  function writePage(
    siteId: string,
    items: CollectedVideo[],
    runToken: string,
    fullAll: boolean
  ): PageWriteResult {
    const connection = database()
    const now = new Date().toISOString()
    const nowTs = Date.now()
    const result: PageWriteResult = {
      fetched: items.length,
      inserted: 0,
      updated: 0,
      failed: 0,
      sourceIds: []
    }
    const affected = new Set<number>()

    inTransaction(connection, (tx) => {
      const selectVideo = tx.prepare('SELECT id FROM videos WHERE name_key = ?')
      const insertVideo = tx.prepare(
        `INSERT INTO videos
           (name, name_key, search_text, latest_ts, latest_time, primary_source_id, source_count,
            pic, note, vod_actor, vod_class, intro_excerpt, intro_truncated, created_at, updated_at)
         VALUES (?, ?, ?, 0, '', NULL, 0, '', '', '', '', '', 0, ?, ?)`
      )
      const selectSource = tx.prepare(
        `SELECT id, video_id, name, pic, note, intro_excerpt, intro_truncated, source_time,
                source_ts, category_id, category_name, vod_actor, vod_class,
                detail_cached_at, detail_source_ts, detail_note, last_full_run
         FROM video_sources WHERE site_id = ? AND source_video_id = ?`
      )
      const insertSource = tx.prepare(
        `INSERT INTO video_sources
           (site_id, source_video_id, video_id, name, pic, note, intro_excerpt, intro_truncated,
            source_time, source_ts, category_id, category_name, vod_actor, vod_class,
            last_full_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const updateSource = tx.prepare(
        `UPDATE video_sources SET
           video_id = ?, name = ?, pic = ?, note = ?, intro_excerpt = ?, intro_truncated = ?,
           source_time = ?, source_ts = ?, category_id = ?, category_name = ?,
           vod_actor = ?, vod_class = ?,
           detail_stale = CASE WHEN ? = 1 THEN 1 ELSE detail_stale END,
           last_full_run = CASE WHEN ? = 1 THEN ? ELSE last_full_run END,
           updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END
         WHERE id = ?`
      )
      const updateRunToken = tx.prepare('UPDATE video_sources SET last_full_run = ? WHERE id = ?')

      for (const item of items) {
        const sourceVideoId = truncate(String(item.sourceVideoId ?? '').trim(), 128)
        const name = truncate(String(item.name ?? '').trim(), 300)
        if (!sourceVideoId || !name) {
          result.failed += 1
          continue
        }

        const nameKey = makeNameKey(name) || name
        let videoId: number
        const existingVideo = selectVideo.get(nameKey) as Record<string, unknown> | undefined
        if (existingVideo) {
          videoId = num(existingVideo.id)
        } else {
          const inserted = insertVideo.run(name, nameKey, makeSearchText(name), now, now)
          videoId = num(inserted.lastInsertRowid)
        }

        const intro = makeExcerpt(item.intro ?? '')
        const sourceTime = truncate(String(item.sourceTime ?? '').trim(), 40)
        const sourceTs = item.sourceTs > 0 ? item.sourceTs : nowTs
        const categoryId = truncate(String(item.categoryId ?? '').trim(), 64)
        const categoryName = truncate(String(item.categoryName ?? '').trim(), 120)
        const pic = truncate(String(item.pic ?? '').trim(), 2048)
        const note = truncate(String(item.note ?? '').trim(), 500)
        const vodActor = truncate(String(item.actor ?? '').trim(), 1000)
        const vodClass = truncate(String(item.vodClass ?? '').trim(), 500)

        const existing = selectSource.get(siteId, sourceVideoId) as
          Record<string, unknown> | undefined
        if (!existing) {
          const inserted = insertSource.run(
            siteId,
            sourceVideoId,
            videoId,
            name,
            pic,
            note,
            intro.text,
            intro.truncated ? 1 : 0,
            sourceTime,
            sourceTs,
            categoryId,
            categoryName,
            vodActor,
            vodClass,
            fullAll ? runToken : '',
            now,
            now
          )
          result.inserted += 1
          result.sourceIds.push(num(inserted.lastInsertRowid))
          affected.add(videoId)
          continue
        }

        const sourceId = num(existing.id)
        result.sourceIds.push(sourceId)
        const oldVideoId = num(existing.video_id)
        const merged = {
          videoId,
          name,
          pic: pic || text(existing.pic),
          note: note || text(existing.note),
          introExcerpt: intro.text || text(existing.intro_excerpt),
          introTruncated: intro.text ? (intro.truncated ? 1 : 0) : num(existing.intro_truncated),
          sourceTime: sourceTime || text(existing.source_time),
          sourceTs: item.sourceTs > 0 ? sourceTs : num(existing.source_ts, nowTs),
          categoryId: categoryId || text(existing.category_id),
          categoryName: categoryName || text(existing.category_name),
          vodActor: vodActor || text(existing.vod_actor),
          vodClass: vodClass || text(existing.vod_class)
        }
        const changed =
          oldVideoId !== merged.videoId ||
          text(existing.name) !== merged.name ||
          text(existing.pic) !== merged.pic ||
          text(existing.note) !== merged.note ||
          text(existing.intro_excerpt) !== merged.introExcerpt ||
          num(existing.intro_truncated) !== merged.introTruncated ||
          text(existing.source_time) !== merged.sourceTime ||
          num(existing.source_ts) !== merged.sourceTs ||
          text(existing.category_id) !== merged.categoryId ||
          text(existing.category_name) !== merged.categoryName ||
          text(existing.vod_actor) !== merged.vodActor ||
          text(existing.vod_class) !== merged.vodClass
        const stale =
          text(existing.detail_cached_at) !== '' &&
          (merged.sourceTs !== num(existing.detail_source_ts) ||
            merged.note !== text(existing.detail_note))
        const tokenChanged = fullAll && text(existing.last_full_run) !== runToken

        if (changed || stale || tokenChanged) {
          updateSource.run(
            merged.videoId,
            merged.name,
            merged.pic,
            merged.note,
            merged.introExcerpt,
            merged.introTruncated,
            merged.sourceTime,
            merged.sourceTs,
            merged.categoryId,
            merged.categoryName,
            merged.vodActor,
            merged.vodClass,
            stale ? 1 : 0,
            fullAll ? 1 : 0,
            runToken,
            changed ? 1 : 0,
            now,
            sourceId
          )
        } else if (fullAll) {
          updateRunToken.run(runToken, sourceId)
        }
        if (changed) result.updated += 1
        // 只有这条来源的内容 / 归属真的变了才需要重算视频聚合值；
        // 未变（或只更新全量 token、只标详情过期）时重算结果一定相同，白白多 2 条 SELECT
        if (changed) {
          if (oldVideoId !== merged.videoId) affected.add(oldVideoId)
          affected.add(merged.videoId)
        }
      }

      for (const id of affected) recomputeVideo(tx, id, now)
    })

    return result
  }

  function listStaleSources(
    siteId: string,
    runToken: string,
    runStartTs: number,
    limit: number
  ): StaleSource[] {
    return database()
      .prepare(
        `SELECT id, source_video_id, video_id
         FROM video_sources
         WHERE site_id = ? AND last_full_run <> ? AND source_ts <= ?
         LIMIT ?`
      )
      .all(siteId, runToken, runStartTs, limit)
      .map((row) => {
        const raw = row as Record<string, unknown>
        return {
          id: num(raw.id),
          sourceVideoId: text(raw.source_video_id),
          videoId: num(raw.video_id)
        }
      })
  }

  function deleteSources(ids: number[]): number {
    if (ids.length === 0) return 0
    const connection = database()
    let deleted = 0
    const videoIds = new Set<number>()
    inTransaction(connection, (tx) => {
      const select = tx.prepare('SELECT video_id FROM video_sources WHERE id = ?')
      const remove = tx.prepare('DELETE FROM video_sources WHERE id = ?')
      for (const id of ids) {
        const row = select.get(id) as Record<string, unknown> | undefined
        if (!row) continue
        videoIds.add(num(row.video_id))
        deleted += Number(remove.run(id).changes)
      }
      const now = new Date().toISOString()
      for (const videoId of videoIds) recomputeVideo(tx, videoId, now)
    })
    return deleted
  }

  function listCacheSites(): { siteId: string; address: string; format: string }[] {
    return (
      database().prepare('SELECT site_id, address, format FROM cache_sites').all() as Record<
        string,
        unknown
      >[]
    ).map((row) => ({
      siteId: text(row.site_id),
      address: text(row.address),
      format: text(row.format)
    }))
  }

  /**
   * 清掉已经没有任何来源的视频，连同它们的人工编辑一起。
   *
   * 正常流程（`removeSite`、`deleteSources`、`writePage`）都不会留下这种行，所以这里只在
   * 两处用到：删站点兜底，以及容量页那个手动修复入口。`videos_ad` 触发器会同步清 FTS 索引。
   * 顺序不能反：`video_edits` 没有外键，视频删掉之后再找编辑就找不到 id 了。
   */
  function deleteOrphanVideos(connection: DatabaseSync): { videos: number; edits: number } {
    const orphan = `SELECT v.id FROM videos v
                    WHERE NOT EXISTS (SELECT 1 FROM video_sources s WHERE s.video_id = v.id)`
    const edits = Number(
      connection
        .prepare(
          `DELETE FROM video_edits
            WHERE video_id NOT IN (SELECT id FROM videos) OR video_id IN (${orphan})`
        )
        .run().changes
    )
    const videos = Number(
      connection.prepare(`DELETE FROM videos WHERE id IN (${orphan})`).run().changes
    )
    return { videos, edits }
  }

  /**
   * 删掉一个站点的全部来源，并处理因此失去来源的视频。
   *
   * 早先的写法是对 `SELECT DISTINCT video_id` 出来的每一部视频都跑一次 `recomputeVideo`：
   * 实测 5.5 万部要 6.2s，占整个清理的八成，但这些视频里绝大多数删完来源后一条来源都不剩
   * （只有跨站同名合并的那几百部还有别的站点来源）。所以先把这批 video_id 记进临时表，
   * 删完来源后只重算「还有来源」的那一部分，其余孤儿视频走 `deleteOrphanVideos` 整批删掉：
   * 同一份数据 7.7s → 1.4s。
   */
  function removeSite(siteId: string): { sources: number; videos: number } {
    const connection = database()
    let sources = 0
    let affected = 0
    inTransaction(connection, (tx) => {
      // 临时表属于这个连接（不写进库文件），每次清理前清空
      tx.exec('CREATE TEMP TABLE IF NOT EXISTS purge_videos (id INTEGER PRIMARY KEY)')
      tx.exec('DELETE FROM purge_videos')
      tx.prepare(
        `INSERT OR IGNORE INTO purge_videos (id)
         SELECT DISTINCT video_id FROM video_sources WHERE site_id = ?`
      ).run(siteId)
      const counted = tx.prepare('SELECT COUNT(*) AS n FROM purge_videos').get() as Record<
        string,
        unknown
      >
      affected = num(counted?.n)
      sources = Number(
        tx.prepare('DELETE FROM video_sources WHERE site_id = ?').run(siteId).changes
      )
      tx.prepare('DELETE FROM collect_progress WHERE site_id = ?').run(siteId)
      tx.prepare('DELETE FROM cache_sites WHERE site_id = ?').run(siteId)
      // 还有别的站点来源的才需要重新挑主来源（片名、封面、简介都跟着变）
      const survivors = tx
        .prepare(
          `SELECT DISTINCT s.video_id AS id
             FROM video_sources s JOIN purge_videos p ON p.id = s.video_id`
        )
        .all() as Record<string, unknown>[]
      const now = new Date().toISOString()
      for (const row of survivors) recomputeVideo(tx, num(row.id), now)
      deleteOrphanVideos(tx)
    })
    return { sources, videos: affected }
  }

  /** 容量页的手动修复：一次清掉库里所有没有来源的视频 */
  function purgeOrphanVideos(): { videos: number; edits: number } {
    const connection = database()
    let result = { videos: 0, edits: 0 }
    inTransaction(connection, (tx) => {
      result = deleteOrphanVideos(tx)
    })
    return result
  }

  /**
   * 列表总数的轻量算法：有分类过滤时直接数 `video_sources` 里命中的来源视频 id（去重），
   * 不扫整张 `videos` 表。`COUNT(*)` 那版每条过滤都要全表扫 + 逐行 EXISTS（十几万条时
   * 一条 200ms 上下，过滤条件越多越慢）；这里只碰命中的来源行——单个大类最慢 100ms，
   * 大部分分类在 25ms 以内，没有分类过滤时只数 videos 表（几毫秒）。
   * 结果与 `COUNT(*)` 版一致：列表的 WHERE 是「分类命中 + 隐藏过滤」，而「主来源必须存在」
   * 那层 JOIN 在正常库里恒真（`recomputeVideo` 保证 videos 一定有来源、主来源 id 有效）。
   * 关键词检索走 FTS，不在这个范围里，仍按完整条件数（见 `listVideos`）。
   */
  function countVideos(
    connection: DatabaseSync,
    filters: { siteId: string; categoryId: string }[] | undefined,
    visibility: 'all' | 'shown' | 'hidden'
  ): number {
    if (filters && filters.length > 0) {
      const hiddenSql =
        visibility === 'shown'
          ? 'AND video_id NOT IN (SELECT video_id FROM video_edits WHERE hidden = 1)'
          : visibility === 'hidden'
            ? 'AND video_id IN (SELECT video_id FROM video_edits WHERE hidden = 1)'
            : ''
      const clauses = filters.map(() => '(site_id = ? AND category_id = ?)').join(' OR ')
      const params: string[] = []
      for (const filter of filters) params.push(filter.siteId, filter.categoryId)
      const counted = connection
        .prepare(
          `SELECT COUNT(DISTINCT video_id) AS n FROM video_sources WHERE (${clauses}) ${hiddenSql}`
        )
        .get(...params) as Record<string, unknown> | undefined
      return num(counted?.n)
    }
    const hiddenSql =
      visibility === 'shown'
        ? 'AND id NOT IN (SELECT video_id FROM video_edits WHERE hidden = 1)'
        : visibility === 'hidden'
          ? 'AND id IN (SELECT video_id FROM video_edits WHERE hidden = 1)'
          : ''
    const counted = connection
      .prepare(`SELECT COUNT(*) AS n FROM videos WHERE 1 = 1 ${hiddenSql}`)
      .get() as Record<string, unknown> | undefined
    return num(counted?.n)
  }

  /**
   * 列表与「只数总数」共用的 WHERE 片段。关键词拼不出合法 FTS 查询时返回 null（= 空结果）。
   * 返回的 `keyword` 决定总数要不要走带 FTS 的完整条件。
   */
  function buildListWhere(
    query: Pick<VideoListQuery, 'keyword' | 'visibility'>,
    categoryFilters?: { siteId: string; categoryId: string }[]
  ): { keyword: string; where: string[]; params: (string | number)[] } | null {
    const keyword = query.keyword?.trim() ?? ''
    const where: string[] = []
    const params: (string | number)[] = []
    if (keyword) {
      const match = makeFtsQuery(keyword)
      if (!match) return null
      where.push('v.id IN (SELECT rowid FROM videos_fts WHERE videos_fts MATCH ?)')
      params.push(match)
    }
    if (categoryFilters && categoryFilters.length > 0) {
      const clauses = categoryFilters
        .map(() => '(f.site_id = ? AND f.category_id = ?)')
        .join(' OR ')
      where.push(`EXISTS (SELECT 1 FROM video_sources f WHERE f.video_id = v.id AND (${clauses}))`)
      for (const filter of categoryFilters) params.push(filter.siteId, filter.categoryId)
    }
    const visibility = query.visibility ?? 'all'
    if (visibility === 'hidden') where.push('COALESCE(e.hidden, 0) = 1')
    if (visibility === 'shown') where.push('COALESCE(e.hidden, 0) = 0')
    return { keyword, where, params }
  }

  /**
   * 只数总数、不取行：控制台概览的「隐藏了多少」只要这个数。
   * 以前是 `videos:list` 取一页凑 total，`visibility: 'hidden'` 又没有命中行时
   * 会为了找 1 条把整张 videos 表连着两个 JOIN 扫一遍（实测 140–175ms）。
   */
  function countMatching(
    query: Pick<VideoListQuery, 'keyword' | 'visibility'>,
    categoryFilters?: { siteId: string; categoryId: string }[]
  ): number {
    const built = buildListWhere(query, categoryFilters)
    if (!built) return 0
    if (!built.keyword) {
      return countVideos(database(), categoryFilters, query.visibility ?? 'all')
    }
    const from = `${VIDEO_ITEM_FROM}${built.where.length ? ` WHERE ${built.where.join(' AND ')}` : ''}`
    const counted = database()
      .prepare(`SELECT COUNT(*) AS n ${from}`)
      .get(...built.params) as Record<string, unknown> | undefined
    return num(counted?.n)
  }

  function listVideos(
    query: VideoListQuery,
    categoryFilters?: { siteId: string; categoryId: string }[]
  ): VideoListResult {
    const connection = database()
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 10, 1), 100)
    const page = Math.max(Number(query.page) || 1, 1)
    const offset = (page - 1) * pageSize
    const built = buildListWhere(query, categoryFilters)
    if (!built) return { ok: true, items: [], total: 0, page, pageSize }
    const { keyword, where, params } = built

    const from = `
      ${VIDEO_ITEM_FROM}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`
    const selectSql = `
      ${VIDEO_ITEM_SELECT}
      ${from}
      ORDER BY v.latest_ts DESC, v.id DESC
      LIMIT ? OFFSET ?`

    let rows: Record<string, unknown>[]
    let total: number
    try {
      rows = connection.prepare(selectSql).all(...params, pageSize, offset) as Record<
        string,
        unknown
      >[]
      // 调用方不看总数时跳过统计；有关键词时走 FTS 的完整条件，
      // 其余情况用只碰来源行的轻量数法（见 countVideos）
      if (query.withTotal === false) {
        total = 0
      } else if (keyword) {
        const counted = connection.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as
          Record<string, unknown> | undefined
        total = num(counted?.n)
      } else {
        total = countVideos(connection, categoryFilters, query.visibility ?? 'all')
      }
    } catch {
      // FTS 语法错误 / 索引异常时返回空，而不是把异常抛给渲染层
      return { ok: false, items: [], total: 0, page, pageSize, error: 'DB' }
    }

    const items: VideoListItem[] = rows.map(rowToVideoItem)
    return { ok: true, items, total, page, pageSize }
  }

  /**
   * 按 id 批量取列表项，顺序不保证（调用方自己按配置排）。
   * 不存在的 id 直接缺席——首页把它显示成「视频已丢失」，不会整块报错。
   */
  function listVideosByIds(videoIds: number[]): VideoListItem[] {
    const ids = [...new Set(videoIds.filter((id) => Number.isInteger(id) && id > 0))]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    try {
      const rows = database()
        .prepare(`${VIDEO_ITEM_SELECT} ${VIDEO_ITEM_FROM} WHERE v.id IN (${placeholders})`)
        .all(...ids) as Record<string, unknown>[]
      return rows.map(rowToVideoItem)
    } catch {
      return []
    }
  }

  /** 指定视频各来源的在线分类（一个视频可能来自多个站点、多个分类） */
  function listSourceCategories(
    videoIds: number[]
  ): { videoId: number; siteId: string; categoryId: string }[] {
    const ids = [...new Set(videoIds.filter((id) => Number.isFinite(id)))]
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = database()
      .prepare(
        `SELECT video_id, site_id, category_id FROM video_sources
         WHERE video_id IN (${placeholders})`
      )
      .all(...ids) as Record<string, unknown>[]
    return rows.map((row) => ({
      videoId: num(row.video_id),
      siteId: text(row.site_id),
      categoryId: text(row.category_id)
    }))
  }

  /**
   * 保存人工编辑：空串表示清掉这条覆盖、回落到采集值；hidden 始终写入。
   * 名称是合并键，不在可改字段里。
   */
  function updateVideo(videoId: number, patch: VideoUpdateInput): VideoUpdateResult {
    const connection = database()
    const exists = connection.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)
    if (!exists) return { ok: false, error: 'NOT_FOUND' }

    const pickPic = (): { pic: string | null | undefined; siteId: string } | { error: string } => {
      if (patch.pic === undefined) return { pic: undefined, siteId: '' }
      const wanted = patch.pic.trim()
      if (!wanted) return { pic: null, siteId: '' }
      const row = connection
        .prepare('SELECT site_id FROM video_sources WHERE video_id = ? AND pic = ? LIMIT 1')
        .get(videoId, wanted) as Record<string, unknown> | undefined
      if (!row) return { error: 'INVALID_PIC' }
      return { pic: truncate(wanted, 2000), siteId: text(row.site_id) }
    }
    const picResult = pickPic()
    if ('error' in picResult) return { ok: false, error: picResult.error }

    const current = connection
      .prepare(
        'SELECT note, intro, vod_actor, vod_class, pic, pic_site_id, hidden FROM video_edits WHERE video_id = ?'
      )
      .get(videoId) as Record<string, unknown> | undefined

    const merge = (next: string | undefined, existing: unknown): string | null => {
      if (next === undefined) return typeof existing === 'string' ? existing : null
      const value = truncate(next.trim(), 4000)
      return value === '' ? null : value
    }
    const note = merge(patch.note, current?.note)
    const intro = merge(patch.intro, current?.intro)
    const vodActor = merge(patch.vodActor, current?.vod_actor)
    const vodClass = merge(patch.vodClass, current?.vod_class)
    let pic: string | null
    let picSiteId: string
    if (patch.pic === undefined) {
      pic = typeof current?.pic === 'string' ? current.pic : null
      picSiteId = text(current?.pic_site_id)
    } else {
      pic = picResult.pic ?? null
      picSiteId = pic ? picResult.siteId : ''
    }
    const hidden = patch.hidden === undefined ? num(current?.hidden) !== 0 : Boolean(patch.hidden)

    const empty = !note && !intro && !vodActor && !vodClass && !pic
    if (empty && !hidden) {
      connection.prepare('DELETE FROM video_edits WHERE video_id = ?').run(videoId)
      return { ok: true }
    }
    connection
      .prepare(
        `INSERT INTO video_edits
           (video_id, note, intro, vod_actor, vod_class, pic, pic_site_id, hidden, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (video_id) DO UPDATE SET
           note = excluded.note,
           intro = excluded.intro,
           vod_actor = excluded.vod_actor,
           vod_class = excluded.vod_class,
           pic = excluded.pic,
           pic_site_id = excluded.pic_site_id,
           hidden = excluded.hidden,
           updated_at = excluded.updated_at`
      )
      .run(
        videoId,
        note,
        intro,
        vodActor,
        vodClass,
        pic,
        picSiteId,
        hidden ? 1 : 0,
        new Date().toISOString()
      )
    return { ok: true }
  }

  function stats(): VideoStats {
    const connection = database()
    const videos = connection.prepare('SELECT COUNT(*) AS n FROM videos').get() as Record<
      string,
      unknown
    >
    const sources = connection.prepare('SELECT COUNT(*) AS n FROM video_sources').get() as Record<
      string,
      unknown
    >
    const last = connection
      .prepare(
        "SELECT MAX(finished_at) AS at FROM collect_progress WHERE status = 'done' AND finished_at <> ''"
      )
      .get() as Record<string, unknown>
    return {
      videoCount: num(videos.n),
      sourceCount: num(sources.n),
      lastCollectedAt: text(last.at)
    }
  }

  function fileSize(path: string): number {
    try {
      return existsSync(path) ? statSync(path).size : 0
    } catch {
      return 0
    }
  }

  function capacity(siteNames?: Map<string, string>, withSites = true): VideoCapacity {
    const connection = database()
    const videoCount = num(
      (connection.prepare('SELECT COUNT(*) AS n FROM videos').get() as Record<string, unknown>).n
    )
    const sourceCount = num(
      (
        connection.prepare('SELECT COUNT(*) AS n FROM video_sources').get() as Record<
          string,
          unknown
        >
      ).n
    )
    const detail = connection
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(detail_size), 0) AS bytes
         FROM video_sources WHERE detail_cached_at <> ''`
      )
      .get() as Record<string, unknown>
    const logCount = num(
      (
        connection.prepare('SELECT COUNT(*) AS n FROM collect_logs').get() as Record<
          string,
          unknown
        >
      ).n
    )
    const siteCount = num(
      (connection.prepare('SELECT COUNT(*) AS n FROM cache_sites').get() as Record<string, unknown>)
        .n
    )
    const last = connection
      .prepare(
        "SELECT MAX(finished_at) AS at FROM collect_progress WHERE status = 'done' AND finished_at <> ''"
      )
      .get() as Record<string, unknown>

    // 「按站点分组」要扫全部来源行（十几万条时 100ms+），只有容量页需要；
    // 无来源视频同样只在这条路径上数（概览的 capacity({ sites: false }) 不付这个开销）
    const siteRows =
      withSites === false
        ? []
        : (connection
            .prepare(
              `SELECT site_id,
                      COUNT(DISTINCT video_id) AS videos,
                      COUNT(*) AS sources,
                      SUM(CASE WHEN detail_cached_at <> '' THEN 1 ELSE 0 END) AS detail_count,
                      SUM(CASE WHEN detail_cached_at <> '' THEN detail_size ELSE 0 END) AS detail_bytes
               FROM video_sources
               GROUP BY site_id
               HAVING SUM(CASE WHEN detail_cached_at <> '' THEN 1 ELSE 0 END) > 0`
            )
            .all() as Record<string, unknown>[])
    const orphanCount =
      withSites === false
        ? 0
        : num(
            (
              connection
                .prepare(
                  `SELECT COUNT(*) AS n FROM videos v
                    WHERE NOT EXISTS (SELECT 1 FROM video_sources s WHERE s.video_id = v.id)`
                )
                .get() as Record<string, unknown>
            ).n
          )
    const sites: VideoCapacitySite[] = siteRows.map((raw) => {
      const siteId = text(raw.site_id)
      return {
        siteId,
        siteName: siteNames?.get(siteId) ?? '',
        videoCount: num(raw.videos),
        sourceCount: num(raw.sources),
        detailCount: num(raw.detail_count),
        detailBytes: num(raw.detail_bytes)
      }
    })
    sites.sort(
      (left, right) =>
        right.detailBytes - left.detailBytes || left.siteId.localeCompare(right.siteId)
    )

    const dbFileBytes = fileSize(file)
    const walBytes = fileSize(`${file}-wal`)
    const shmBytes = fileSize(`${file}-shm`)
    return {
      dbBytes: dbFileBytes + walBytes + shmBytes,
      dbFileBytes,
      walBytes,
      shmBytes,
      videoCount,
      sourceCount,
      detailCount: num(detail.n),
      detailBytes: num(detail.bytes),
      logCount,
      siteCount,
      orphanCount,
      lastCollectedAt: text(last.at),
      sites
    }
  }

  function getProgress(id: string): VideoCollectProgress | null {
    return rowToProgress(
      database().prepare('SELECT * FROM collect_progress WHERE id = ?').get(id) as
        Record<string, unknown> | undefined
    )
  }

  function listProgress(siteId?: string): VideoCollectProgress[] {
    const connection = database()
    const rows = siteId
      ? connection
          .prepare('SELECT * FROM collect_progress WHERE site_id = ? ORDER BY updated_at DESC')
          .all(siteId)
      : connection.prepare('SELECT * FROM collect_progress ORDER BY updated_at DESC').all()
    return rows
      .map((row) => rowToProgress(row as Record<string, unknown>))
      .filter((row): row is VideoCollectProgress => row !== null)
  }

  function prepareTask(input: {
    siteId: string
    mode: CollectMode
    fetchRange: FetchRange
    restart?: boolean
    /** 任务实际使用的每页条数：写进进度，首屏就能显示「每页 N 条」 */
    pageSize?: number
  }): VideoCollectProgress {
    const connection = database()
    const id = progressKey(input.siteId, input.mode, input.fetchRange)
    const now = new Date().toISOString()
    const pageSize = Math.max(0, Math.floor(Number(input.pageSize) || 0))
    const existing = getProgress(id)
    if (!existing) {
      connection
        .prepare(
          `INSERT INTO collect_progress
             (id, site_id, mode, fetch_range, status, page, page_count, record_count, page_size,
              fetched, inserted, updated, failed, deleted, error, started_at, finished_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', 0, 0, 0, ?, 0, 0, 0, 0, 0, '', ?, '', ?)`
        )
        .run(id, input.siteId, input.mode, input.fetchRange, pageSize, now, now)
    } else if (input.restart || existing.status === 'done' || existing.status === 'idle') {
      connection
        .prepare(
          `UPDATE collect_progress SET
             status = 'queued', page = 0, page_count = 0, record_count = 0, page_size = ?,
             fetched = 0, inserted = 0, updated = 0, failed = 0, deleted = 0,
             error = '', started_at = ?, finished_at = '', updated_at = ?
           WHERE id = ?`
        )
        .run(pageSize, now, now, id)
    } else {
      // paused / error / replacing 续采：保留 page、计数和 started_at（全量替换 token）
      connection
        .prepare(
          `UPDATE collect_progress SET status = 'queued', error = '', finished_at = '',
             page_size = CASE WHEN ? > 0 THEN ? ELSE page_size END, updated_at = ?
           WHERE id = ?`
        )
        .run(pageSize, pageSize, now, id)
    }
    return getProgress(id) as VideoCollectProgress
  }

  function updateProgress(id: string, patch: ProgressPatch): VideoCollectProgress | null {
    const assignments: string[] = []
    const values: (string | number)[] = []
    const set = (column: string, value: string | number | undefined): void => {
      if (value === undefined) return
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    set('status', patch.status)
    set('page', patch.page)
    set('page_count', patch.pageCount)
    set('record_count', patch.recordCount)
    set('page_size', patch.pageSize)
    set('error', patch.error)
    set('started_at', patch.startedAt)
    set('finished_at', patch.finishedAt)
    if (patch.fetchedDelta) {
      assignments.push('fetched = fetched + ?')
      values.push(patch.fetchedDelta)
    }
    if (patch.insertedDelta) {
      assignments.push('inserted = inserted + ?')
      values.push(patch.insertedDelta)
    }
    if (patch.updatedDelta) {
      assignments.push('updated = updated + ?')
      values.push(patch.updatedDelta)
    }
    if (patch.failedDelta) {
      assignments.push('failed = failed + ?')
      values.push(patch.failedDelta)
    }
    if (patch.deletedDelta) {
      assignments.push('deleted = deleted + ?')
      values.push(patch.deletedDelta)
    }
    assignments.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)
    database()
      .prepare(`UPDATE collect_progress SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values)
    return getProgress(id)
  }

  function resetInterrupted(): void {
    const connection = database()
    const now = new Date().toISOString()
    connection
      .prepare(
        "UPDATE collect_progress SET status = 'idle', updated_at = ? WHERE status = 'queued'"
      )
      .run(now)
    connection
      .prepare(
        `UPDATE collect_progress SET status = 'paused',
           error = CASE WHEN error = '' THEN 'INTERRUPTED' ELSE error END,
           updated_at = ?
         WHERE status = 'running'`
      )
      .run(now)
  }

  function getVideoDetail(videoId: number): VideoDetail | null {
    const connection = database()
    const video = connection
      .prepare(
        `SELECT v.id, v.name, COALESCE(e.pic, v.pic) AS pic, COALESCE(e.note, v.note) AS note,
                COALESCE(e.intro, v.intro_excerpt) AS intro_excerpt,
                CASE WHEN e.intro IS NOT NULL THEN 0 ELSE v.intro_truncated END AS intro_truncated,
                v.latest_ts, v.latest_time,
                COALESCE(e.vod_actor, v.vod_actor) AS vod_actor,
                COALESCE(e.vod_class, v.vod_class) AS vod_class,
                v.source_count, COALESCE(e.hidden, 0) AS hidden, COALESCE(e.pic_site_id, '') AS pic_site_id,
                CASE WHEN e.note IS NOT NULL OR e.intro IS NOT NULL OR e.vod_actor IS NOT NULL
                       OR e.vod_class IS NOT NULL OR e.pic IS NOT NULL
                     THEN 1 ELSE 0 END AS edited
         FROM videos v LEFT JOIN video_edits e ON e.video_id = v.id
         WHERE v.id = ?`
      )
      .get(videoId) as Record<string, unknown> | undefined
    if (!video) return null
    const rows = connection
      .prepare(
        `SELECT id, site_id, source_video_id, video_id, name, pic, note, source_time, source_ts,
                category_id, category_name, vod_actor, vod_class,
                detail_path, detail_size, detail_cached_at, detail_accessed_at,
                detail_source_ts, detail_note, detail_stale, detail_error
         FROM video_sources WHERE video_id = ? ORDER BY source_ts DESC, id ASC`
      )
      .all(videoId) as Record<string, unknown>[]
    const sources: VideoDetailSource[] = rows.map((row) => {
      const source = rowToDetailSource(row)
      return {
        id: source.id,
        siteId: source.siteId,
        siteName: '',
        sourceVideoId: source.sourceVideoId,
        name: source.name,
        pic: source.pic,
        note: source.note,
        sourceTime: source.sourceTime,
        sourceTs: source.sourceTs,
        categoryId: source.categoryId,
        categoryName: source.categoryName,
        vodActor: source.vodActor,
        vodClass: source.vodClass,
        detailAvailable: false,
        detailStale: source.detailStale,
        detailCachedAt: source.detailCachedAt,
        detailSize: source.detailSize,
        detailAccessedAt: source.detailAccessedAt,
        detailError: source.detailError
      }
    })
    return {
      id: num(video.id),
      name: text(video.name),
      pic: text(video.pic),
      note: text(video.note),
      introExcerpt: text(video.intro_excerpt),
      introTruncated: num(video.intro_truncated) !== 0,
      latestTs: num(video.latest_ts),
      latestTime: text(video.latest_time),
      vodActor: text(video.vod_actor),
      vodClass: text(video.vod_class),
      sourceCount: num(video.source_count),
      sources,
      hidden: num(video.hidden) !== 0,
      edited: num(video.edited) !== 0,
      picSiteId: text(video.pic_site_id)
    }
  }

  function getDetailSource(sourceId: number): DetailSourceRow | null {
    const row = database()
      .prepare(
        `SELECT id, site_id, source_video_id, video_id, name, pic, note, source_time, source_ts,
                category_id, category_name, vod_actor, vod_class,
                detail_path, detail_size, detail_cached_at, detail_accessed_at,
                detail_source_ts, detail_note, detail_stale, detail_error
         FROM video_sources WHERE id = ?`
      )
      .get(sourceId) as Record<string, unknown> | undefined
    return row ? rowToDetailSource(row) : null
  }

  function setDetailIndex(sourceId: number, patch: DetailIndexPatch): void {
    const assignments: string[] = []
    const values: (string | number)[] = []
    const set = (column: string, value: string | number | undefined): void => {
      if (value === undefined) return
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    set('detail_path', patch.detailPath)
    set('detail_size', patch.detailSize)
    set('detail_cached_at', patch.detailCachedAt)
    set('detail_accessed_at', patch.detailAccessedAt)
    set('detail_source_ts', patch.detailSourceTs)
    set('detail_note', patch.detailNote)
    if (patch.detailStale !== undefined) {
      assignments.push('detail_stale = ?')
      values.push(patch.detailStale ? 1 : 0)
    }
    set('detail_error', patch.detailError)
    if (assignments.length === 0) return
    values.push(sourceId)
    database()
      .prepare(`UPDATE video_sources SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  function touchDetailAccess(sourceId: number, at: string, thresholdMs: number): void {
    const row = database()
      .prepare('SELECT detail_accessed_at FROM video_sources WHERE id = ?')
      .get(sourceId) as Record<string, unknown> | undefined
    if (!row) return
    const previous = text(row.detail_accessed_at)
    if (previous && Date.now() - Date.parse(previous) < thresholdMs) return
    database()
      .prepare('UPDATE video_sources SET detail_accessed_at = ? WHERE id = ?')
      .run(at, sourceId)
  }

  function clearDetailIndex(sourceId: number): void {
    database()
      .prepare(
        `UPDATE video_sources SET
           detail_path = '', detail_size = 0, detail_cached_at = '', detail_accessed_at = '',
           detail_source_ts = 0, detail_note = '', detail_stale = 0, detail_error = ''
         WHERE id = ?`
      )
      .run(sourceId)
  }

  function resetDetailIndex(siteId?: string): number {
    const connection = database()
    const sql = siteId
      ? `UPDATE video_sources SET
           detail_path = '', detail_size = 0, detail_cached_at = '', detail_accessed_at = '',
           detail_source_ts = 0, detail_note = '', detail_stale = 0, detail_error = ''
         WHERE site_id = ? AND (detail_path <> '' OR detail_cached_at <> '' OR detail_error <> '')`
      : `UPDATE video_sources SET
           detail_path = '', detail_size = 0, detail_cached_at = '', detail_accessed_at = '',
           detail_source_ts = 0, detail_note = '', detail_stale = 0, detail_error = ''
         WHERE detail_path <> '' OR detail_cached_at <> '' OR detail_error <> ''`
    return Number(
      (siteId ? connection.prepare(sql).run(siteId) : connection.prepare(sql).run()).changes
    )
  }

  function listIndexedDetailSources(
    siteId?: string
  ): { id: number; siteId: string; path: string }[] {
    const connection = database()
    const rows = siteId
      ? connection
          .prepare(
            `SELECT id, site_id, detail_path FROM video_sources
             WHERE site_id = ? AND detail_cached_at <> ''`
          )
          .all(siteId)
      : connection
          .prepare(
            `SELECT id, site_id, detail_path FROM video_sources WHERE detail_cached_at <> ''`
          )
          .all()
    return rows.map((row) => {
      const raw = row as Record<string, unknown>
      return { id: num(raw.id), siteId: text(raw.site_id), path: text(raw.detail_path) }
    })
  }

  return {
    init: async () => {
      if (db) return
      const connection = openDatabase(file)
      try {
        initSchema(connection)
        db = connection
      } catch (error) {
        closeDatabase(file)
        db = null
        throw error
      }
    },
    close: () => {
      closeDatabase(file)
      db = null
    },
    connection: database,
    rebuild: async () => {
      closeDatabase(file)
      db = null
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          if (existsSync(`${file}${suffix}`)) {
            rmSync(`${file}${suffix}`, { force: true })
          }
        } catch {
          // 文件被占用时不假装清理成功，让界面提示失败而不是继续用旧库
          throw new Error('DB')
        }
      }
      const connection = openDatabase(file)
      initSchema(connection)
      db = connection
    },
    ensureSite,
    listCacheSites,
    removeSite,
    purgeOrphanVideos,
    writePage,
    listStaleSources,
    deleteSources,
    recomputeVideos,
    listVideos,
    countVideos: countMatching,
    listVideosByIds,
    listSourceCategories,
    updateVideo,
    stats,
    capacity,
    getProgress,
    listProgress,
    prepareTask,
    updateProgress,
    resetInterrupted,
    getVideoDetail,
    getDetailSource,
    setDetailIndex,
    touchDetailAccess,
    clearDetailIndex,
    resetDetailIndex,
    listIndexedDetailSources
  }
}
