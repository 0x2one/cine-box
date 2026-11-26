/** 视频缓存相关的主进程类型：IPC、采集器、缓存库与渲染层类型声明共用同一套语义 */

/**
 * 采集模式：增量 / 全量按页翻列表，检索按片名（`wd`）在线检索。
 * 检索是「按关键词补充入库」，不做全量替换，同一站点只保留一条进度记录。
 */
export type CollectMode = 'incremental' | 'full' | 'search'
/** 定时计划只支持按列表翻页的两种：检索需要关键词，不能定时 */
export type ScheduleMode = 'incremental' | 'full'
export type FetchRange = 'all' | '24h' | '48h'
export type CollectStatus =
  'idle' | 'queued' | 'running' | 'paused' | 'replacing' | 'done' | 'error'
export type CollectOrigin = 'manual' | 'schedule'
export type LogLevel = 'info' | 'warn' | 'error'

export const COLLECT_MODES: CollectMode[] = ['incremental', 'full', 'search']
export const FETCH_RANGES: FetchRange[] = ['all', '24h', '48h']

/** 在线检索交互页每站请求的页大小（搜索页等不了太久，一页就够展示） */
export const ONLINE_SEARCH_PAGE_SIZE = 20
/** 检索采集任务每个关键词、每个站点最多入库的条数 */
export const SEARCH_MAX_ITEMS = 200

/** 检索进度上绑定的一个关键词及其采集状态 */
export type SearchWordStatus = 'pending' | 'running' | 'done' | 'error'

export interface CollectSearchWord {
  word: string
  status: SearchWordStatus
  /** 这个词已经抓到的条数（达到上限时停在上限） */
  fetched: number
  error: string
  updatedAt: string
}

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
  /** 只有 mode = search 的行才带：这条进度绑定的关键词（去重后按最近改动排序） */
  words?: CollectSearchWord[]
}

/** 定时方式：按间隔，或每天固定时间点 */
export type ScheduleTiming = 'interval' | 'daily'

export interface VideoSchedule {
  siteId: string
  mode: ScheduleMode
  fetchRange: FetchRange
  timing: ScheduleTiming
  intervalMinutes: number
  /** timing = daily 时的时间点（HH:mm） */
  dailyTime: string
  enabled: boolean
  /** 采集时是否顺带生成详情缓存 */
  cacheDetail: boolean
  /** 保存计划时探测到的真实每页条数；0 = 未知，采集时按默认 100 */
  pageSize: number
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
  mode: ScheduleMode
  fetchRange: FetchRange
  cacheDetail?: boolean
  /** 探测结果由主进程写入，渲染层不传 */
  pageSize?: number
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
  /** 没有任何来源的视频（正常流程不会留下）；只有按站点统计那一档才数，概览恒为 0 */
  orphanCount: number
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

/** 容量页「清理无来源视频」的结果 */
export interface VideoOrphanPurgeResult {
  /** 删掉的视频行 */
  videos: number
  /** 跟着一起删掉的人工编辑行 */
  edits: number
}

/**
 * 容量页「删除站点数据」的结果：这个站点的来源、只属于它的视频、详情文件、
 * 采集进度与采集日志全部删掉，站点与分类 / 绑定 / 计划不动。
 */
export interface VideoSitePurgeResult {
  ok: boolean
  error?: string
  /** 删掉的来源行 */
  sources: number
  /** 跟着一起删掉的视频（只在这个站点有来源的那些） */
  videos: number
  /** 与其它站点共有、只重新挑主来源的视频数 */
  shared: number
  /** 顺带删掉的详情文件数 / 体积 */
  detailCount: number
  detailBytes: number
  /** 一起清掉的采集日志条数 */
  logs: number
}

/** 批量重写 videos.pic 的进度（主进程推给控制台「封面」页） */
export interface PicCleanProgress {
  processed: number
  total: number
  changed: number
  /** 有人工封面、只更新了基图、显示不会变的条数 */
  skipped: number
  percent: number
}

/** 批量重写 videos.pic 的结果 */
export interface PicCleanResult {
  ok: boolean
  error?: string
  total: number
  changed: number
  /** 人工封面视频里，基图被顺带更新的条数（显示端不变） */
  skipped: number
  cancelled: boolean
}

/** 最近一次同步的完整记录：重进页面时用它回显，而不是只剩一个 toast */
export interface PicCleanOutcome extends PicCleanResult {
  siteId: string
  startedAt: string
  finishedAt: string
  durationMs: number
}

/** 同步任务状态：渲染层重新进入页面时回填进度 / 取消中 / 上次结果 */
export interface PicCleanStatus {
  ok: boolean
  running: boolean
  cancelling: boolean
  progress: PicCleanProgress | null
  siteId: string
  startedAt: string
  lastResult: PicCleanOutcome | null
}

/** 每个站点能提供封面的视频数：控制台的来源选项直接展示覆盖率 */
export interface PicSiteCoverage {
  siteId: string
  covered: number
}

/** 一部视频的封面预览：当前封面 vs 应用规则后的封面 */
export interface PicSample {
  videoId: number
  name: string
  currentPic: string
  nextPic: string
  changed: boolean
  manual: boolean
}

/** 封面规则统计：来源覆盖率、待同步数、无封面数与抽样 */
export interface PicCleanStats {
  ok: boolean
  error?: string
  /** 本次统计采用的来源 id，空串 = 主来源优先 */
  siteId: string
  total: number
  /** 该站点有非空封面、规则会取到它的视频数 */
  covered: number
  /** 非人工封面里，同步后会变的视频数 */
  stale: number
  /** 规则与人工封面都给不出图的视频数 */
  empty: number
  /** 有人工封面的视频数（同步不会改显示） */
  manual: number
  sites: PicSiteCoverage[]
  samples: PicSample[]
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
  /** 探测到的真实每页条数；省略时主进程会先探测，探测失败按默认 100 */
  pageSize?: number
  /**
   * 检索模式要采集的关键词：同一个站点只有一条检索进度，多次提交会累积成
   * 一份去重列表（已经存在的关键词重置为待检索，重新采一次）。
   */
  words?: string[]
}

export interface VideoCollectStartResult {
  ok: boolean
  error?: string
  progress?: VideoCollectProgress
  /** 本次任务实际使用的每页条数 */
  pageSize?: number
}

export interface VideoListQuery {
  keyword?: string
  /** 本地视频分类：先由业务库解析成在线分类，再在缓存库过滤 */
  categoryId?: string
  /** 多个本地分类的并集（列表页「全部」用）：传了就按这些分类的子树一起过滤 */
  categoryIds?: string[]
  /** 1 起的页码，配合 pageSize 做服务端分页 */
  page?: number
  pageSize?: number
  /** 按隐藏状态过滤；默认 all（控制台里隐藏的也要能看到并改回来） */
  visibility?: 'all' | 'shown' | 'hidden'
  /**
   * 是否需要总数。默认 true；传 false 时跳过那条 `COUNT(*)`（十几万条的视频库上
   * 它要扫一整张表），返回的 total 为 0，调用方不要展示它。
   */
  withTotal?: boolean
  /**
   * 是否连同禁用站点的视频一起返回。默认 false：禁用站点的来源不算数，
   * 只被禁用站点收录的视频在列表 / 搜索里查不到。控制台「视频」页传 true，
   * 管理员仍然能看到并编辑这些视频。
   */
  includeDisabledSites?: boolean
  /**
   * 是否连同类 18+ 的视频一起返回。默认 false：设置里关闭 18+ 内容时，
   * 标记为 18+ 的站点 / 分类 / 视频在展示端一律查不到；控制台传 true 才能看到并管理。
   * 设置里打开 18+ 内容后，主进程会把「隐藏 18+」整个关掉，这个字段就不再起作用。
   */
  includeAdult?: boolean
}

export interface VideoListItem {
  id: number
  name: string
  pic: string
  /** 封面加载失败时可依次尝试的其它来源封面（默认来源优先、去重） */
  picCandidates: string[]
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
  /** 被标记为 18+（人工标记 / 来源站点 / 绑定分类任一命中） */
  adult: boolean
  /** 人工标记了 18+（只看 video_edits.adult；控制台编辑弹窗用） */
  adultManual: boolean
  /** 备注 / 简介 / 主演 / 类型 / 封面被手动改过 */
  edited: boolean
  /** 已在首页海报叠层里（控制台视频列表用，由 IPC 层补齐） */
  inPoster?: boolean
  /** 已在哪些首页分类里推荐（控制台视频列表用，由 IPC 层补齐） */
  homeSections?: { categoryId: string; title: string }[]
  /** 已加入搜索页底部推荐（控制台视频列表用，由 IPC 层补齐） */
  inSearch?: boolean
  /** 视频所属的本地一级分类（按绑定关系推导，顺序跟分类树一致；推荐只允许进这些分类） */
  boundCategoryIds?: string[]
  /** 绑定后的本地分类路径；展示侧只统计启用站点，控制台 includeDisabledSites 时包含禁用站点 */
  localCategoryPaths?: string[]
}

export interface VideoListResult {
  ok: boolean
  items: VideoListItem[]
  total: number
  page: number
  pageSize: number
  error?: string
}

/** 在线检索自检里的一条命中：只给界面看，不写缓存库 */
export interface SiteSearchTestItem {
  sourceVideoId: string
  name: string
  note: string
  sourceTime: string
}

/**
 * 站点「在线检索」自检结果：发一次真实的 `wd` 请求，只看返回、不写库。
 * 老部署会静默忽略 `wd` 仍返回整页数据，所以除了条数，还要看结果里
 * 有没有片名真的包含关键词（`matched`）才能判断接口到底支不支持。
 */
export interface SiteSearchTestResult {
  /** 请求 + 解析是否成功（verdict 为 empty / ignored 时也是 true） */
  ok: boolean
  /** NOT_FOUND / INVALID_INPUT / NETWORK / HTTP_xxx / PARSE / CLOSED / AUTH */
  error?: string
  siteId: string
  keyword: string
  /** 实际请求的地址，排查时直接复制 */
  url: string
  elapsedMs: number
  /** HTTP 状态码，网络失败时为 0 */
  status: number
  /** 站点报告的总命中数，0 = 未知 */
  recordCount: number
  pageCount: number
  pageSize: number
  /** 本页解析出的条数 */
  count: number
  /** 本页片名包含关键词的条数 */
  matched: number
  /** 前几条命中，最多 10 条 */
  items: SiteSearchTestItem[]
  verdict: 'supported' | 'ignored' | 'empty' | 'failed'
  message: string
}

/** 只问数量时的结果（不取行）：控制台概览的「隐藏了多少」用它 */
export interface VideoCountResult {
  ok: boolean
  total: number
  error?: string
}

/** 在线检索里单个站点的结果 */
export interface VideoOnlineSearchSite {
  siteId: string
  ok: boolean
  /** 该站点本次返回的条数（≤ ONLINE_SEARCH_PAGE_SIZE） */
  count: number
  /** 站点报告的总命中数，0 = 未知；大于 count 时说明后台还会继续采 */
  recordCount: number
  /** NETWORK / HTTP_xxx / PARSE / CLOSED / AUTH */
  error?: string
}

/** 展示端搜索页「在线」模式的一次检索结果 */
export interface VideoOnlineSearchResult {
  ok: boolean
  /** CACHE_UNAVAILABLE / INVALID_INPUT */
  error?: string
  keyword: string
  /** 参与检索的站点数（支持在线检索、且没有正在清理缓存） */
  siteCount: number
  items: VideoListItem[]
  /** 合并后的命中总数（items 可能被截断） */
  total: number
  truncated: boolean
  sites: VideoOnlineSearchSite[]
  /** 成功入队的检索采集任务数 */
  queued: number
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
  /** 人工标记 18+：设置里关闭 18+ 内容时展示端不再出现 */
  adult?: boolean
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
  /** 封面加载失败时可依次尝试的其它来源封面 */
  picCandidates: string[]
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
  /** 被标记为 18+（人工标记 / 来源站点 / 绑定分类任一命中） */
  adult: boolean
  /** 人工标记了 18+（只看 video_edits.adult） */
  adultManual: boolean
  /** 存在手动修改的字段 */
  edited: boolean
  /** 封面取自哪个站点（手动换图时记录），空串表示用主来源 */
  picSiteId: string
  /** 各来源绑定的本地分类路径（如「电影 / 动作片」）；只统计启用站点，由 IPC 层按绑定关系补齐 */
  localCategoryPaths?: string[]
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
