/** 视频缓存相关的主进程类型：IPC、采集器、缓存库与渲染层类型声明共用同一套语义 */

export type CollectMode = 'incremental' | 'full'
export type FetchRange = 'all' | '24h' | '48h'
export type CollectStatus =
  'idle' | 'queued' | 'running' | 'paused' | 'replacing' | 'done' | 'error'
export type CollectOrigin = 'manual' | 'schedule'
export type LogLevel = 'info' | 'warn' | 'error'

export const COLLECT_MODES: CollectMode[] = ['incremental', 'full']
export const FETCH_RANGES: FetchRange[] = ['all', '24h', '48h']

export interface VideoCollectProgress {
  /** `${siteId}:${mode}:${fetchRange}` */
  id: string
  siteId: string
  mode: CollectMode
  fetchRange: FetchRange
  status: CollectStatus
  page: number
  pageCount: number
  recordCount: number
  pageSize: number
  fetched: number
  inserted: number
  updated: number
  failed: number
  deleted: number
  error: string
  startedAt: string
  finishedAt: string
  updatedAt: string
}

/** 定时方式：按间隔，或每天固定时间点 */
export type ScheduleTiming = 'interval' | 'daily'

export interface VideoSchedule {
  siteId: string
  mode: CollectMode
  fetchRange: FetchRange
  timing: ScheduleTiming
  intervalMinutes: number
  /** timing = daily 时的时间点（HH:mm） */
  dailyTime: string
  enabled: boolean
  /** 采集时是否顺带生成详情缓存 */
  cacheDetail: boolean
  nextRunAt: string
  lastRunAt: string
  createdAt: string
  updatedAt: string
}

export interface VideoScheduleInput {
  siteId: string
  enabled: boolean
  timing: ScheduleTiming
  intervalMinutes: number
  dailyTime: string
  mode: CollectMode
  fetchRange: FetchRange
  cacheDetail?: boolean
}

export interface VideoCollectLog {
  id: number
  createdAt: string
  level: LogLevel
  siteId: string
  mode: string
  fetchRange: string
  message: string
  detail: string
}

export interface VideoCapacitySite {
  siteId: string
  siteName: string
  videoCount: number
  sourceCount: number
  detailCount: number
  detailBytes: number
}

export interface VideoCapacity {
  /** video-cache.db + -wal + -shm */
  dbBytes: number
  /** 主库文件 */
  dbFileBytes: number
  walBytes: number
  shmBytes: number
  videoCount: number
  sourceCount: number
  detailCount: number
  detailBytes: number
  logCount: number
  siteCount: number
  /** 最近一次成功采集完成时间 */
  lastCollectedAt: string
  sites: VideoCapacitySite[]
}

export interface VideoCapacityDrift {
  indexCount: number
  indexBytes: number
  fileCount: number
  fileBytes: number
  /** 索引有、文件不存在 */
  missing: number
  /** 文件存在、索引没有 */
  orphan: number
  /** 未完成的 .tmp-* 文件 */
  tempFiles: number
  /** 本次清空索引的行数 */
  fixed: number
  scannedAt: string
}

export interface VideoCapacityScanResult extends VideoCapacity {
  drift: VideoCapacityDrift
}

export interface VideoCollectStartInput {
  siteId: string
  mode: CollectMode
  fetchRange: FetchRange
  restart?: boolean
  maxPages?: number
  allowEmpty?: boolean
  /** 采集时顺带把详情文件也抓下来（默认只写列表索引） */
  cacheDetail?: boolean
}

export interface VideoCollectStartResult {
  ok: boolean
  error?: string
  progress?: VideoCollectProgress
}

export interface VideoListQuery {
  keyword?: string
  /** 本地视频分类：先由业务库解析成在线分类，再在缓存库过滤 */
  categoryId?: string
  /** 1 起的页码，配合 pageSize 做服务端分页 */
  page?: number
  pageSize?: number
  /** 按隐藏状态过滤；默认 all（控制台里隐藏的也要能看到并改回来） */
  visibility?: 'all' | 'shown' | 'hidden'
}

export interface VideoListItem {
  id: number
  name: string
  pic: string
  note: string
  introExcerpt: string
  introTruncated: boolean
  latestTs: number
  latestTime: string
  sourceCount: number
  vodActor: string
  vodClass: string
  siteId: string
  sourceVideoId: string
  categoryId: string
  categoryName: string
  /** 展示端隐藏；默认 false（显示） */
  hidden: boolean
  /** 备注 / 简介 / 主演 / 类型 / 封面被手动改过 */
  edited: boolean
}

export interface VideoListResult {
  ok: boolean
  items: VideoListItem[]
  total: number
  page: number
  pageSize: number
  error?: string
}

/** 只允许改这些字段：名称是合并键，不提供修改入口 */
export interface VideoUpdateInput {
  note?: string
  intro?: string
  vodActor?: string
  vodClass?: string
  /** 选中的封面地址（必须来自该视频的某个来源），空串表示恢复主来源封面 */
  pic?: string
  /** 封面来自哪个站点，仅用于界面回显 */
  picSiteId?: string
  hidden?: boolean
}

export interface VideoUpdateResult {
  ok: boolean
  error?: string
}

export interface VideoStats {
  videoCount: number
  sourceCount: number
  lastCollectedAt: string
}

export interface VideoPlayEpisode {
  name: string
  url: string
}

export interface VideoPlayLine {
  flag: string
  episodes: VideoPlayEpisode[]
}

export interface CachedVideoDetail {
  format: string
  version: number
  siteId: string
  sourceVideoId: string
  fetchedAt: string
  sourceTime: string
  sourceTs: number
  name: string
  pic: string
  note: string
  intro: string
  state: string
  year: string
  area: string
  lang: string
  actor: string
  vodClass: string
  director: string
  category: { id: string; name: string }
  playLines: VideoPlayLine[]
}

export interface VideoDetailSource {
  id: number
  siteId: string
  siteName: string
  sourceVideoId: string
  name: string
  pic: string
  note: string
  sourceTime: string
  sourceTs: number
  categoryId: string
  categoryName: string
  vodActor: string
  vodClass: string
  detailAvailable: boolean
  detailStale: boolean
  detailCachedAt: string
  detailSize: number
  detailAccessedAt: string
  detailError: string
  detail?: CachedVideoDetail
}

export interface VideoDetail {
  id: number
  name: string
  pic: string
  note: string
  introExcerpt: string
  introTruncated: boolean
  latestTs: number
  latestTime: string
  vodActor: string
  vodClass: string
  sourceCount: number
  sources: VideoDetailSource[]
  /** 展示端隐藏；默认 false */
  hidden: boolean
  /** 存在手动修改的字段 */
  edited: boolean
  /** 封面取自哪个站点（手动换图时记录），空串表示用主来源 */
  picSiteId: string
}

export interface VideoDetailResult {
  ok: boolean
  video?: VideoDetail
  error?: string
}

export interface VideoDetailRefreshResult extends VideoDetailResult {
  refreshed: number
  failed: number
}

export interface DetailClearResult {
  ok: boolean
  freedBytes?: number
  removedFiles?: number
  error?: string
}

export interface CacheClearResult {
  ok: boolean
  freedBytes?: number
  error?: string
}
