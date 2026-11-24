interface WindowControls {
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onMaximizeChange: (callback: (maximized: boolean) => void) => () => void
}

interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  /** 是否已打包（开发模式下不触发自动更新） */
  packaged: boolean
  /** 是否支持检查更新（开发模式可用 CINEBOX_DEV_UPDATE=1 联调） */
  canUpdate: boolean
}

/** 启动时打开的页面：推荐（首页）或搜索视频 */
type AppStartView = 'home' | 'search'

/** 启动时主窗口的大小：适中 / 大屏 / 超大 */
type AppWindowSize = 'medium' | 'large' | 'xlarge'

interface AppApi {
  info: () => Promise<AppInfo>
  /** 启动时打开的页面（主进程通过启动参数传入，同步读取） */
  startView: () => AppStartView
}

/** 渲染层点某一集时传给播放窗的信息：详情由播放页自己按 videoId 取 */
interface PlayerOpenInput {
  videoId: number
  /** 优先起播的来源（VideoDetailSource.id） */
  sourceId?: number
  /** 来源里的线路下标（playLines 原始下标） */
  lineIndex?: number
  /** 线路里的集数下标（episodes 原始下标） */
  episodeIndex?: number
  /** 详情加载前先显示的片名 / 集数 */
  title?: string
  episodeName?: string
}

interface PlayerPayload extends Omit<PlayerOpenInput, 'videoId'> {
  /** 每次打开都递增：播放页靠它重新取详情、重新起播 */
  token: number
  /** 库里的视频 id；播下载到本机的文件时没有 */
  videoId?: number
  /**
   * 本机文件（下载中心）的 cine-file:// 地址：有它时播放页直接播，
   * 不再按 videoId 取详情。只有主进程的 downloads:play 会填。
   */
  fileUrl?: string
  /** 本机文件名，详情加载前先当标题用 */
  fileName?: string
}

interface PlayerOpenResult {
  ok: boolean
  /** INVALID_INPUT：videoId 不合法 */
  error?: string
}

interface PlayerApi {
  open: (input: PlayerOpenInput) => Promise<PlayerOpenResult>
  payload: () => Promise<PlayerPayload | null>
  onLoad: (callback: (payload: PlayerPayload) => void) => () => void
}

/**
 * 播放窗需要跟随的外观：播放页固定深色（不跟主窗口明暗主题），
 * 只需要主窗口当前选中的强调色；底色由主进程固定成深色。
 */
interface PlayerAppearance {
  /** 强调色 key（见 theme/appearance.ts 的 ACCENTS） */
  accent: string
}

interface AppearanceApi {
  /** 播放窗挂载时取当前外观；主窗口还没上报过时为 null */
  get: () => Promise<PlayerAppearance | null>
  /** 主窗口每次应用主题后上报，主进程中转给已打开的播放窗 */
  set: (value: PlayerAppearance) => Promise<void>
  onChange: (callback: (value: PlayerAppearance) => void) => () => void
}

interface AppSettings {
  openAtLogin: boolean
  closeToTray: boolean
  autoDownload: boolean
  /** 全局快捷键，空字符串表示未启用 */
  showShortcut: string
  /** 默认首页：启动映盒剧场时打开的页面 */
  startView: AppStartView
  /** 启动时主窗口的大小 */
  windowSize: AppWindowSize
  /** 采集时优先使用哪个站点的 pic 填 videos.pic，空串表示不指定 */
  defaultPicSiteId: string
  /** 同时采集的站点数（1–4）：跨站并行，同一站点始终串行 */
  collectConcurrency: number
  /** 下载文件的保存目录（绝对路径） */
  downloadPath: string
  /** 同时下载的任务数（1–5） */
  downloadConcurrency: number
}

interface SetShortcutResult {
  ok: boolean
  /** CONFLICT：被其它程序占用；INVALID：无法识别的组合键 */
  error?: string
  shortcut: string
}

interface SettingsApi {
  get: () => Promise<AppSettings>
  setOpenAtLogin: (value: boolean) => Promise<AppSettings>
  setCloseToTray: (value: boolean) => Promise<AppSettings>
  setAutoDownload: (value: boolean) => Promise<AppSettings>
  setShowShortcut: (value: string | null) => Promise<SetShortcutResult>
  resetShowShortcut: () => Promise<SetShortcutResult>
  /** 设置默认首页，返回保存后的设置；下次启动生效 */
  setStartView: (value: AppStartView) => Promise<AppSettings>
  /** 设置启动时的窗口大小，返回保存后的设置；下次启动生效 */
  setWindowSize: (value: AppWindowSize) => Promise<AppSettings>
  /** 设置默认 pic 来源站点（空串 = 不指定），立即影响后续采集 */
  setDefaultPicSite: (value: string) => Promise<AppSettings>
  /** 设置同时采集的站点数（1–4），返回保存后的设置；立即影响填槽，不打断在跑任务 */
  setCollectConcurrency: (value: number) => Promise<AppSettings>
}

type SiteFormat = 'xml' | 'json'

interface Site {
  /** 唯一 ID：UUID 去掉横线（32 位十六进制） */
  id: string
  /** 站点名称 */
  name: string
  /** 显示名称，留空表示沿用名称 */
  display: string
  /** 采集站地址 */
  address: string
  format: SiteFormat
  /** 备注 */
  remark: string
  /**
   * 是否支持在线检索：开启后搜索页可以切到「在线」，
   * 控制台「采集」里也多出「检索」这种采集方式。
   */
  onlineSearch: boolean
  /**
   * 是否禁用：禁用后仍然可以编辑，但不再采集、不参与搜索（本地 / 在线），
   * 推荐页与列表页也不再显示只属于它的视频；缓存数据保留，重新启用即恢复。
   */
  disabled: boolean
  /** ISO 8601 */
  createdAt: string
  updatedAt: string
}

interface SiteInput {
  name: string
  display?: string
  address: string
  format?: SiteFormat
  remark?: string
  onlineSearch?: boolean
  disabled?: boolean
}

interface AddSiteResult {
  ok: boolean
  /** INVALID_NAME：名称为空；INVALID_ADDRESS：地址不是 http(s)；INVALID_FORMAT：格式不合法 */
  error?: 'INVALID_NAME' | 'INVALID_ADDRESS' | 'INVALID_FORMAT'
  site?: Site
}

interface UpdateSiteResult {
  ok: boolean
  /** 同上，另有 NOT_FOUND：站点已被删除 */
  error?: 'INVALID_NAME' | 'INVALID_ADDRESS' | 'INVALID_FORMAT' | 'NOT_FOUND'
  site?: Site
}

interface RemoveSiteResult {
  ok: boolean
  /** 删除后剩余的站点列表 */
  sites: Site[]
}

/** 在线检索自检里的一条命中（只给界面看，不写缓存库） */
interface SiteSearchTestItem {
  sourceVideoId: string
  name: string
  note: string
  sourceTime: string
}

/**
 * 站点「在线检索」自检结果：发一次真实的 wd 请求，只看返回。
 * 老部署会忽略 wd 仍返回整页数据，所以要看结果里有没有片名真的包含关键词。
 */
interface SiteSearchTestResult {
  /** 请求 + 解析是否成功（verdict 为 empty / ignored 时也是 true） */
  ok: boolean
  /** NOT_FOUND / INVALID_INPUT / NETWORK / HTTP_xxx / PARSE / CLOSED / AUTH */
  error?: string
  siteId: string
  keyword: string
  /** 实际请求地址，可复制出来排查 */
  url: string
  elapsedMs: number
  /** HTTP 状态码，网络失败时为 0 */
  status: number
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

interface SiteCategory {
  /** 主进程生成的 32 位十六进制 ID */
  id: string
  /** 所属站点 ID */
  siteId: string
  /** 采集接口返回的分类 ID（苹果 CMS type_id / RSS <ty id>） */
  sourceId: string
  name: string
  /** 创建 / 更新时间，ISO 8601 */
  createdAt: string
  updatedAt: string
}

interface SiteCategoriesResult {
  ok: boolean
  /** NOT_FOUND：站点已被删除；NETWORK：连接失败 / 超时；HTTP：站点返回非 2xx；PARSE：返回内容无法解析 */
  error?: 'NOT_FOUND' | 'NETWORK' | 'HTTP' | 'PARSE'
  message?: string
  categories?: SiteCategory[]
}

/** 新增 / 消失的分类 */
interface SiteCategoryChange {
  /** 采集接口返回的分类 ID */
  sourceId: string
  name: string
}

/** 来源 ID 不变、名称变化的分类 */
interface SiteCategoryRename {
  sourceId: string
  /** 库内原名称 */
  from: string
  /** 本次抓取的新名称 */
  to: string
}

interface SiteCategoryDiff {
  /** 新增：库中没有、本次抓取到 */
  added: SiteCategoryChange[]
  /** 消失：库中有、本次未返回（增量更新时保留） */
  removed: SiteCategoryChange[]
  /** 改名 */
  renamed: SiteCategoryRename[]
}

interface SiteCategoriesRefreshResult {
  ok: boolean
  /** NOT_FOUND：站点已被删除；NETWORK / HTTP / PARSE：抓取失败 */
  error?: 'NOT_FOUND' | 'NETWORK' | 'HTTP' | 'PARSE'
  message?: string
  /** 与库内数据相比是否有变化 */
  hasChanges?: boolean
  diff?: SiteCategoryDiff
}

interface SiteCategoriesApplyResult {
  ok: boolean
  /** EXPIRED：抓取结果已过期，需要重新获取；INVALID_MODE：更新方式不合法；NOT_FOUND：站点已删除 */
  error?: 'EXPIRED' | 'INVALID_MODE' | 'NOT_FOUND'
  categories?: SiteCategory[]
}

interface SitesApi {
  list: () => Promise<Site[]>
  add: (input: SiteInput) => Promise<AddSiteResult>
  update: (id: string, input: SiteInput) => Promise<UpdateSiteResult>
  remove: (id: string) => Promise<RemoveSiteResult>
  /** 在线检索自检：真实发一次 wd 请求，只解析不写缓存库，用来确认站点支不支持按片名检索 */
  testSearch: (input: { siteId: string; keyword: string }) => Promise<SiteSearchTestResult>
  /** 已入库就直接读库；库里没有时抓取 ac=list 并全量入库 */
  categories: (id: string) => Promise<SiteCategoriesResult>
  /** 重新抓取并与库内对比，只返回差异，不写库 */
  refreshCategories: (id: string) => Promise<SiteCategoriesRefreshResult>
  /** 用户确认后按增量 / 全量写入 */
  applyCategories: (id: string, mode: 'incremental' | 'full') => Promise<SiteCategoriesApplyResult>
}

/** 本地视频分类：树形结构，parentId 为空表示一级分类 */
interface VideoCategory {
  /** 主进程生成的 32 位十六进制 ID */
  id: string
  /** 上级分类 ID，一级分类为 null */
  parentId: string | null
  name: string
  /** 同级排序，从 0 开始连续编号 */
  sortOrder: number
  /** 是否在展示端显示：关闭后该分类及其整棵子树都不再展示，管理页仍会列出 */
  visible: boolean
  /** 创建 / 更新时间，ISO 8601 */
  createdAt: string
  updatedAt: string
}

interface VideoCategoryInput {
  name: string
  /** 上级分类：新增时不传即一级分类；编辑时不传表示保持原样，传 null 表示移到一级分类 */
  parentId?: string | null
}

/** 拖拽落点：目标之前 / 成为目标的子分类 / 目标之后 */
type CategoryPlacement = 'before' | 'inside' | 'after'

interface VideoCategoryResult {
  ok: boolean
  /** INVALID_NAME：名称为空；INVALID_PARENT：上级不存在；INVALID_PLACEMENT：落点不合法；
   * DUPLICATE_NAME：同级同名；CYCLE：移动到自己的子分类下；NOT_FOUND：分类已被删除 */
  error?:
    | 'INVALID_NAME'
    | 'INVALID_PARENT'
    | 'INVALID_PLACEMENT'
    | 'DUPLICATE_NAME'
    | 'CYCLE'
    | 'NOT_FOUND'
  /** 变更后的完整分类列表，已按同级顺序排好 */
  categories?: VideoCategory[]
}

interface CategoriesApi {
  list: () => Promise<VideoCategory[]>
  create: (input: VideoCategoryInput) => Promise<VideoCategoryResult>
  update: (id: string, input: VideoCategoryInput) => Promise<VideoCategoryResult>
  /** 切换展示端的显示状态：关闭父分类会让整棵子树一起隐藏（管理页始终返回全部分类） */
  setVisible: (id: string, visible: boolean) => Promise<VideoCategoryResult>
  /** 拖拽移动：改变上级并插入到指定位置 */
  move: (
    id: string,
    targetId: string | null,
    placement: CategoryPlacement
  ) => Promise<VideoCategoryResult>
  /** 删除分类及其所有子分类 */
  remove: (id: string) => Promise<VideoCategoryResult>
}

/** 绑定定位：站点 + 在线分类，唯一键就是这两个字段的组合 */
interface BindingTarget {
  siteId: string
  siteCategoryId: string
}

/** 站点分类弹窗用：某个在线分类绑到了哪个本地分类 */
interface SiteCategoryBinding {
  siteCategoryId: string
  /** 绑定的本地分类 */
  categoryId: string
  /** 本地分类完整路径，如「电影 / 动作片」 */
  categoryPath: string
}

/** 分类页只读列表用：某个本地分类收了哪些在线分类 */
interface CategoryBinding {
  id: string
  siteId: string
  /** 站点显示名（display 为空时取 name） */
  siteName: string
  siteCategoryId: string
  /** 采集接口返回的分类 ID */
  sourceId: string
  /** 在线分类名，读取时 join 取最新值 */
  name: string
  createdAt: string
}

interface BindingResult {
  ok: boolean
  /** INVALID_INPUT：入参不合法，或 siteId 与在线分类对不上；NOT_FOUND：本地分类 / 在线分类已被删除 */
  error?: 'INVALID_INPUT' | 'NOT_FOUND'
}

interface BindingsApi {
  /** 某个站点已绑定的在线分类 */
  forSite: (siteId: string) => Promise<SiteCategoryBinding[]>
  /** 某个本地分类已绑定的在线分类 */
  forCategory: (categoryId: string) => Promise<CategoryBinding[]>
  /** 每个本地分类的绑定数量，未绑定的不出现 */
  counts: () => Promise<Record<string, number>>
  /** 把一批在线分类绑到指定本地分类，已绑定的直接改绑 */
  bind: (items: BindingTarget[], categoryId: string) => Promise<BindingResult>
  unbind: (items: BindingTarget[]) => Promise<BindingResult>
}

/** 一份备份里包含的数据量 */
interface BackupCounts {
  sites: number
  siteCategories: number
  categories: number
  bindings: number
  schedules: number
}

/** 备份记录：备份目录里的一个 JSON 文件 */
interface BackupRecord {
  /** 备份文件名，同时作为记录 ID */
  id: string
  /** 生成备份的时间，ISO 8601 */
  createdAt: string
  /** 生成备份时的应用版本 */
  appVersion: string
  /** 文件大小（字节） */
  size: number
  counts: BackupCounts
  /** 恢复前自动生成的安全备份 */
  auto: boolean
}

interface BackupListResult {
  /** 备份目录绝对路径 */
  directory: string
  records: BackupRecord[]
}

interface BackupCreateResult {
  ok: boolean
  /** EMPTY：当前没有可备份的数据；WRITE_FAILED：写入备份文件失败 */
  error?: 'EMPTY' | 'WRITE_FAILED'
  record?: BackupRecord
}

interface BackupRemoveResult {
  ok: boolean
}

interface BackupExportResult {
  ok: boolean
  /** 用户取消了保存对话框 */
  canceled?: boolean
  /** NOT_FOUND：记录已不存在；WRITE_FAILED：复制失败 */
  error?: 'NOT_FOUND' | 'WRITE_FAILED'
  /** 用户选择的目标路径 */
  path?: string
}

interface BackupPickResult {
  ok: boolean
  /** 用户取消了选择对话框 */
  canceled?: boolean
  /** NOT_FOUND：文件不存在；INVALID：不是有效备份；UNSUPPORTED：备份版本更高；READ_FAILED：读取失败 */
  error?: 'NOT_FOUND' | 'INVALID' | 'UNSUPPORTED' | 'READ_FAILED'
  /** 用户选中的文件绝对路径，确认恢复时原样传回 */
  path?: string
  record?: BackupRecord
}

interface BackupRestoreResult {
  ok: boolean
  /** NOT_FOUND：记录或文件不存在；INVALID：文件内容不合法；UNSUPPORTED：版本更高；
   * READ_FAILED：读取失败；WRITE_FAILED：写入备份或恢复前备份失败 */
  error?: 'NOT_FOUND' | 'INVALID' | 'UNSUPPORTED' | 'READ_FAILED' | 'WRITE_FAILED'
  /** 备份里的数据量，用于恢复成功的提示 */
  counts?: BackupCounts
  /** 恢复前自动备份的当前数据；当前库为空时没有 */
  safety?: BackupRecord
}

/** 恢复来源：库内备份记录，或用户自定义的文件路径 */
interface RestoreSource {
  id?: string
  path?: string
}

interface BackupApi {
  list: () => Promise<BackupListResult>
  /** 把当前站点、在线分类、本地分类与绑定关系写成一份备份 */
  create: () => Promise<BackupCreateResult>
  remove: (id: string) => Promise<BackupRemoveResult>
  /** 另存到用户选择的位置，便于分享 */
  export: (id: string) => Promise<BackupExportResult>
  /** 打开备份目录 */
  openFolder: () => Promise<boolean>
  /** 选择自定义备份文件并解析，不写库 */
  pick: () => Promise<BackupPickResult>
  /** 用备份覆盖当前数据，恢复前自动备份现状 */
  restore: (source: RestoreSource) => Promise<BackupRestoreResult>
}

type CachePhase = 'enumerate' | 'measure' | 'clear'

interface CacheProgress {
  /** enumerate：统计文件数量；measure：计算体积；clear：正在清理 */
  phase: CachePhase
  /** 0-100，enumerate 阶段没有总量，固定为 0 */
  percent: number
  /** 已统计到的缓存体积（字节） */
  bytes: number
  /** 已处理的文件数（enumerate 阶段为已发现的文件数） */
  files: number
  /** 当前缓存目录的中文名称 */
  current: string
}

interface CacheSummary {
  /** 缓存总字节数 */
  size: number
  /** 缓存文件总数 */
  files: number
  /** ISO 8601，本次扫描完成时间 */
  scannedAt: string
}

interface CacheClearResult extends CacheSummary {
  /** 本次清理掉的字节数 */
  freed: number
  /** 清理失败、仍被占用的缓存目录数 */
  locked: number
}

interface CacheApi {
  /** 扫描缓存目录并返回体积，过程中通过 onProgress 推送进度 */
  scan: () => Promise<CacheSummary>
  /** 清理全部缓存，返回清理后的体积与释放量 */
  clear: () => Promise<CacheClearResult>
  onProgress: (callback: (progress: CacheProgress) => void) => () => void
}

/** 采集模式：增量 / 全量按列表翻页，检索按片名（wd）在线检索 */
type CollectMode = 'incremental' | 'full' | 'search'
/** 定时计划只支持按列表翻页的两种 */
type ScheduleMode = 'incremental' | 'full'
type FetchRange = 'all' | '24h' | '48h'
type ScheduleTiming = 'interval' | 'daily'
type CollectStatus = 'idle' | 'queued' | 'running' | 'paused' | 'replacing' | 'done' | 'error'
type CollectOrigin = 'manual' | 'schedule'
type LogLevel = 'info' | 'warn' | 'error'
type SearchWordStatus = 'pending' | 'running' | 'done' | 'error'

/** 检索进度里绑定的一个关键词及其采集状态 */
interface CollectSearchWord {
  word: string
  status: SearchWordStatus
  /** 已经抓到的条数（达到上限时停在上限） */
  fetched: number
  error: string
  updatedAt: string
}

interface VideoCollectProgress {
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
  /** 只有 mode = search 才有：这条进度绑定的关键词与各自的采集状态 */
  words?: CollectSearchWord[]
}

interface VideoCollectStartInput {
  siteId: string
  mode: CollectMode
  fetchRange: FetchRange
  restart?: boolean
  maxPages?: number
  allowEmpty?: boolean
  /** 采集时顺带把详情文件也抓下来（默认只写列表索引） */
  cacheDetail?: boolean
  /** 探测到的真实每页条数；省略时主进程先探测，失败按默认 100 */
  pageSize?: number
  /** 检索模式要采集的关键词：同一站点一条进度，多次提交累积成去重列表 */
  words?: string[]
}

interface VideoCollectStartResult {
  ok: boolean
  error?: string
  progress?: VideoCollectProgress
  /** 本次任务实际使用的每页条数 */
  pageSize?: number
}

interface VideoSchedule {
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
  /** 保存计划时探测到的真实每页条数；0 = 未知 */
  pageSize: number
  nextRunAt: string
  lastRunAt: string
  createdAt: string
  updatedAt: string
}

interface VideoScheduleInput {
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

interface VideoScheduleListResult {
  ok: boolean
  error?: string
  schedules: VideoSchedule[]
}

interface VideoScheduleSaveResult {
  ok: boolean
  error?: 'INVALID_INPUT' | 'NOT_FOUND' | 'CACHE_UNAVAILABLE'
  schedule?: VideoSchedule
}

interface VideoCollectLog {
  id: number
  createdAt: string
  level: LogLevel
  siteId: string
  mode: string
  fetchRange: string
  message: string
  detail: string
}

interface VideoLogQuery {
  siteId?: string
  level?: LogLevel
  /** 只取该 ISO 时间之后的日志 */
  since?: string
  /** newest：最新一批（倒序返回）；oldest：最早一批（正序返回） */
  order?: 'newest' | 'oldest'
  limit?: number
}

interface VideoLogListResult {
  ok: boolean
  error?: string
  logs: VideoCollectLog[]
}

interface VideoCapacitySite {
  siteId: string
  siteName: string
  videoCount: number
  sourceCount: number
  detailCount: number
  detailBytes: number
}

interface VideoCapacity {
  dbBytes: number
  dbFileBytes: number
  walBytes: number
  shmBytes: number
  videoCount: number
  sourceCount: number
  detailCount: number
  detailBytes: number
  logCount: number
  siteCount: number
  /** 没有任何来源的视频；只有按站点统计那一档才数，概览恒为 0 */
  orphanCount: number
  lastCollectedAt: string
  sites: VideoCapacitySite[]
}

interface VideoCapacityDrift {
  indexCount: number
  indexBytes: number
  fileCount: number
  fileBytes: number
  missing: number
  orphan: number
  tempFiles: number
  fixed: number
  scannedAt: string
}

interface VideoCapacityScanResult extends VideoCapacity {
  drift: VideoCapacityDrift | null
}

/** 容量页「清理无来源视频」的结果 */
interface VideoOrphanPurgeResult {
  ok: boolean
  error?: string
  videos: number
  edits: number
}

interface VideoStats {
  videoCount: number
  sourceCount: number
  lastCollectedAt: string
}

interface VideoListQuery {
  keyword?: string
  categoryId?: string
  /** 多个本地分类的并集（列表页「全部」用）：传了就按这些分类的子树一起过滤 */
  categoryIds?: string[]
  page?: number
  pageSize?: number
  visibility?: 'all' | 'shown' | 'hidden'
  /**
   * 是否需要总数。默认 true；分页取第 2 页及以后时传 false，省掉一次统计，
   * 此时返回的 total 为 0，不要拿它覆盖已经知道的总数。
   */
  withTotal?: boolean
  /**
   * 是否连同禁用站点的视频一起返回。默认 false：禁用站点的来源不算数，
   * 只被禁用站点收录的视频查不到；控制台「视频」页传 true 才能看到全部。
   */
  includeDisabledSites?: boolean
}

interface VideoListItem {
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
  sourceCount: number
  vodActor: string
  vodClass: string
  siteId: string
  sourceVideoId: string
  categoryId: string
  categoryName: string
  /** 绑定后的本地分类路径（如「电影 / 动作片」），未绑定时为空数组 */
  localCategoryPaths: string[]
  hidden: boolean
  edited: boolean
  /** 已在首页海报叠层里 */
  inPoster?: boolean
  /** 已在哪些首页分类里推荐 */
  homeSections?: { categoryId: string; title: string }[]
  /** 已加入搜索页底部推荐 */
  inSearch?: boolean
  /** 视频所属的本地一级分类 id（按绑定关系推导，推荐只能进这些分类） */
  boundCategoryIds?: string[]
}

interface VideoListResult {
  ok: boolean
  items: VideoListItem[]
  total: number
  page: number
  pageSize: number
  error?: string
}

/** 只问数量时的结果（不取行） */
interface VideoCountResult {
  ok: boolean
  total: number
  error?: string
}

/** 在线检索里单个站点的情况 */
interface VideoOnlineSearchSite {
  siteId: string
  ok: boolean
  /** 该站点本次返回的条数（≤ 20） */
  count: number
  /** 站点报告的总命中数，0 = 未知；大于 count 说明后台还会继续采 */
  recordCount: number
  /** NETWORK / HTTP_xxx / PARSE / CLOSED / AUTH / DB */
  error?: string
}

/** 展示端搜索页「在线」模式的一次检索结果 */
interface VideoOnlineSearchResult {
  ok: boolean
  /** CACHE_UNAVAILABLE / INVALID_INPUT */
  error?: string
  keyword: string
  /** 参与检索的站点数 */
  siteCount: number
  items: VideoListItem[]
  /** 合并后的命中总数（items 可能被截断） */
  total: number
  truncated: boolean
  sites: VideoOnlineSearchSite[]
  /** 成功入队的检索采集任务数 */
  queued: number
}

interface VideoUpdateInput {
  note?: string
  intro?: string
  vodActor?: string
  vodClass?: string
  pic?: string
  picSiteId?: string
  hidden?: boolean
}

interface VideoUpdateResult {
  ok: boolean
  error?: string
}

interface VideoPlayEpisode {
  name: string
  url: string
}

interface VideoPlayLine {
  flag: string
  episodes: VideoPlayEpisode[]
}

interface CachedVideoDetail {
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

interface VideoDetailSource {
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

interface VideoDetail {
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
  hidden: boolean
  edited: boolean
  picSiteId: string
}

interface VideoDetailResult {
  ok: boolean
  error?: string
  video?: VideoDetail
}

interface VideoDetailRefreshResult extends VideoDetailResult {
  refreshed: number
  failed: number
}

interface DetailClearResult {
  ok: boolean
  freedBytes?: number
  removedFiles?: number
  error?: string
}

/** 容量页「删除站点数据」的结果 */
interface VideoSitePurgeResult {
  ok: boolean
  error?: string
  /** 删掉的来源行 */
  sources: number
  /** 跟着一起删掉的视频（只在这个站点有来源的那些） */
  videos: number
  /** 与其它站点共有、只重新挑主来源的视频数 */
  shared: number
  detailCount: number
  detailBytes: number
  /** 一起清掉的采集日志条数 */
  logs: number
}

/** 批量重写 videos.pic 的进度 */
interface PicCleanProgress {
  processed: number
  total: number
  changed: number
  /** 人工封面视频里，基图被顺带更新的条数（显示端不变） */
  skipped: number
  percent: number
}

/** 批量重写 videos.pic 的结果 */
interface PicCleanResult {
  ok: boolean
  error?: string
  total: number
  changed: number
  skipped: number
  cancelled: boolean
}

/** 最近一次同步的完整记录 */
interface PicCleanOutcome extends PicCleanResult {
  siteId: string
  startedAt: string
  finishedAt: string
  durationMs: number
}

/** 同步任务状态：重新进入页面时回填进度、取消中状态和上次结果 */
interface PicCleanStatus {
  ok: boolean
  running: boolean
  cancelling: boolean
  progress: PicCleanProgress | null
  siteId: string
  startedAt: string
  lastResult: PicCleanOutcome | null
}

interface PicSiteCoverage {
  siteId: string
  covered: number
}

interface PicSample {
  videoId: number
  name: string
  currentPic: string
  nextPic: string
  changed: boolean
  manual: boolean
}

interface PicCleanStats {
  ok: boolean
  error?: string
  siteId: string
  total: number
  covered: number
  stale: number
  empty: number
  manual: number
  sites: PicSiteCoverage[]
  samples: PicSample[]
}

interface VideoCacheClearResult {
  ok: boolean
  freedBytes?: number
  error?: string
}

interface VideosApi {
  list: (query: VideoListQuery) => Promise<VideoListResult>
  /** 只问数量、不取行 */
  count: (query: VideoListQuery) => Promise<VideoCountResult>
  update: (videoId: number, patch: VideoUpdateInput) => Promise<VideoUpdateResult>
  detail: (videoId: number, options?: { autoFetch?: boolean }) => Promise<VideoDetailResult>
  refreshDetail: (
    videoId: number,
    options?: { force?: boolean }
  ) => Promise<VideoDetailRefreshResult>
  stats: () => Promise<VideoStats>
  /** { sites: false } 跳过按站点分组的统计 */
  capacity: (options?: { sites?: boolean }) => Promise<VideoCapacity>
  scanCapacity: (options?: { fixMissing?: boolean }) => Promise<VideoCapacityScanResult>
  /** 清掉没有任何来源的视频（容量页的手动修复入口） */
  clearOrphans: () => Promise<VideoOrphanPurgeResult>
  clearDetails: (options?: { siteId?: string }) => Promise<DetailClearResult>
  /** 按选定来源批量重写 videos.pic */
  cleanPics: (input?: { siteId?: string }) => Promise<PicCleanResult>
  cancelPicsClean: () => Promise<void>
  onPicsCleanProgress: (callback: (progress: PicCleanProgress) => void) => () => void
  /** 同步任务状态：页面重新进入时回填进度与上次结果 */
  picsCleanStatus: () => Promise<PicCleanStatus>
  /** 封面规则统计 + 效果抽样；siteId 可以传未保存的候选来源 */
  picsStats: (options?: { siteId?: string }) => Promise<PicCleanStats>
  /** 删除一个站点的全部缓存数据（来源 / 视频 / 详情 / 进度 / 日志） */
  purgeSite: (input: { siteId: string }) => Promise<VideoSitePurgeResult>
  progress: (siteId?: string) => Promise<VideoCollectProgress[]>
  /** 一键清空采集进度（含检索关键词）；有任务在跑 / 排队时返回 BUSY */
  clearProgress: () => Promise<{ ok: boolean; removed?: number; error?: string }>
  /** 展示端搜索页「在线」模式：只查开启在线检索的站点，每站 1 页 20 条，合并排序后返回 */
  searchOnline: (input: { keyword: string }) => Promise<VideoOnlineSearchResult>
  collect: (input: VideoCollectStartInput) => Promise<VideoCollectStartResult>
  cancelCollect: (input: {
    siteId: string
    mode?: CollectMode
    fetchRange?: FetchRange
  }) => Promise<{ ok: boolean; error?: string }>
  schedules: () => Promise<VideoScheduleListResult>
  saveSchedule: (input: VideoScheduleInput) => Promise<VideoScheduleSaveResult>
  removeSchedule: (siteId: string) => Promise<{ ok: boolean; error?: string }>
  logs: (query?: VideoLogQuery) => Promise<VideoLogListResult>
  clearLogs: (options?: { siteId?: string }) => Promise<{ ok: boolean; removed?: number }>
  clear: () => Promise<VideoCacheClearResult>
  onProgress: (callback: (progress: VideoCollectProgress) => void) => () => void
  onLogAppend: (callback: (log: VideoCollectLog) => void) => () => void
}

/** 首页分类推荐规则：manual 用视频列表里「推荐」进来的视频，latest 按更新时间取前 N 部 */
type HomeRule = 'manual' | 'latest'

/** 图片裁剪：原图中要显示的区域，按原图宽高归一化到 0–1 */
interface HomeCrop {
  x: number
  y: number
  w: number
  h: number
}

/** 条目的展示覆盖字段：空串表示沿用视频库里的值 */
interface HomeItemFields {
  title: string
  note: string
  actors: string
  intro: string
  /** 自定义图片：http(s) 或 cine-img://home/<文件名>，空串表示用视频封面 */
  pic: string
  crop: HomeCrop
  hidden: boolean
}

/** 条目可改字段的补丁，未传的字段保持原样 */
type HomeItemPatch = Partial<HomeItemFields>

interface HomeSectionPatch {
  visible?: boolean
  title?: string
  rule?: HomeRule
  topN?: number
}

/** 搜索页底部推荐只有规则和条数可改 */
interface HomeSearchPatch {
  rule?: HomeRule
  topN?: number
}

/** 首页条目 + 视频库解析结果 */
interface HomeItemView {
  videoId: number
  title: string
  note: string
  actors: string
  intro: string
  pic: string
  /** 当前 pic 加载失败时可依次尝试的其它来源封面 */
  picCandidates: string[]
  crop: HomeCrop
  /** 是否自定义了图片（决定要不要按 crop 裁剪） */
  customPic: boolean
  hidden: boolean
  /** 是否由配置指定；false 表示 latest 自动带出来的 */
  pinned: boolean
  /** 视频在「视频」页被隐藏，展示端不出现 */
  videoHidden: boolean
  /** 视频已不在缓存库里 */
  missing: boolean
  videoName: string
  videoPic: string
  videoNote: string
  videoActors: string
  videoIntro: string
  latestTime: string
  vodClass: string
}

interface HomeSectionView {
  categoryId: string
  /** 分类原名 */
  name: string
  /** 首页显示名 */
  title: string
  visible: boolean
  categoryVisible: boolean
  rule: HomeRule
  topN: number
  /** 「自定义」列表是否被编辑过：编辑过之后切回自定义不再用 TOP 覆盖 */
  customized: boolean
  /** latest：分类里的视频总数；manual：推荐条数；display 口径不统计，恒为 0 */
  total: number
  items: HomeItemView[]
  /** latest 规则下被移除的视频，可以恢复 */
  removedItems: HomeItemView[]
}

/** 搜索页初始状态底部的推荐：结构跟分类推荐一样，只是没有分类字段 */
interface HomeSearchView {
  rule: HomeRule
  topN: number
  customized: boolean
  /** latest：片库里展示中的视频总数；manual：推荐条数 */
  total: number
  items: HomeItemView[]
  /** latest 规则下被移除的视频，可以恢复 */
  removedItems: HomeItemView[]
}

/**
 * feed 口径：display = 推荐页只要渲染需要的东西（不算每条轨道的总数、不含隐藏轨道、
 * 不带搜索推荐位）；console = 控制台「推荐」页，总数与隐藏轨道都要。
 */
type HomeFeedView = 'display' | 'console'

interface HomeFeed {
  posters: HomeItemView[]
  sections: HomeSectionView[]
  /** 搜索页底部推荐位：只有 console 口径会带，推荐页不显示 */
  search?: HomeSearchView
}

interface HomeFeedResult {
  ok: boolean
  error?: string
  feed?: HomeFeed
}

interface HomeSearchResult {
  ok: boolean
  error?: string
  search?: HomeSearchView
}

interface HomeActionResult {
  ok: boolean
  /** NOT_FOUND / DUPLICATE / INVALID_INPUT / FULL / CACHE_UNAVAILABLE */
  error?: string
}

interface HomeImageResult {
  ok: boolean
  canceled?: boolean
  error?: string
  /** cine-img://home/<文件名> */
  url?: string
}

interface HomeApi {
  /** 推荐页传 { view: 'display' }（默认），控制台不传 */
  get: (options?: { view?: HomeFeedView }) => Promise<HomeFeedResult>
  addPoster: (videoId: number) => Promise<HomeActionResult>
  updatePoster: (videoId: number, patch: HomeItemPatch) => Promise<HomeActionResult>
  removePoster: (videoId: number) => Promise<HomeActionResult>
  reorderPosters: (videoIds: number[]) => Promise<HomeActionResult>
  saveSection: (categoryId: string, patch: HomeSectionPatch) => Promise<HomeActionResult>
  addSectionItem: (categoryId: string, videoId: number) => Promise<HomeActionResult>
  updateSectionItem: (
    categoryId: string,
    videoId: number,
    patch: HomeItemPatch
  ) => Promise<HomeActionResult>
  removeSectionItem: (categoryId: string, videoId: number) => Promise<HomeActionResult>
  restoreSectionItem: (categoryId: string, videoId: number) => Promise<HomeActionResult>
  reorderSectionItems: (categoryId: string, videoIds: number[]) => Promise<HomeActionResult>
  /** 清空「自定义」轨道的全部推荐 */
  clearSectionItems: (categoryId: string) => Promise<HomeActionResult>
  /** 搜索页底部推荐 */
  getSearch: () => Promise<HomeSearchResult>
  saveSearch: (patch: HomeSearchPatch) => Promise<HomeActionResult>
  addSearchItem: (videoId: number) => Promise<HomeActionResult>
  updateSearchItem: (videoId: number, patch: HomeItemPatch) => Promise<HomeActionResult>
  removeSearchItem: (videoId: number) => Promise<HomeActionResult>
  restoreSearchItem: (videoId: number) => Promise<HomeActionResult>
  reorderSearchItems: (videoIds: number[]) => Promise<HomeActionResult>
  /** 清空「自定义」的搜索推荐 */
  clearSearchItems: () => Promise<HomeActionResult>
  pickImage: () => Promise<HomeImageResult>
}

/** 局域网服务可以绑定的一个网卡地址 */
interface LanAddress {
  /** 网卡名称，如「WLAN」「以太网」；回环地址叫「本机」 */
  name: string
  address: string
  /** 回环地址只能本机访问，手机扫码扫不到 */
  loopback: boolean
}

/**
 * 局域网影院服务状态：控制台据此渲染开关、二维码与地址列表。
 * 服务没启动时 host / port 是上次保存的配置，urls 是「启动后可用」的预览。
 */
interface LanServiceState {
  running: boolean
  /** `0.0.0.0` 表示监听全部网卡 */
  host: string
  port: number
  /** 浏览器可访问的地址（第一项用于二维码） */
  urls: string[]
  addresses: LanAddress[]
  /** 最近一次启动失败的原因码，成功启动后清空 */
  error?: string
  /** ISO 8601；服务没启动时为空串 */
  startedAt: string
}

type LanStartError =
  | 'INVALID_HOST'
  | 'INVALID_PORT'
  | 'PORT_IN_USE'
  | 'ADDRESS_UNAVAILABLE'
  | 'PERMISSION'
  | 'START_FAILED'

interface LanStartResult {
  ok: boolean
  error?: LanStartError
  state: LanServiceState
}

interface LanApi {
  state: () => Promise<LanServiceState>
  /** 启动 / 换地址重启：成功后配置落盘 */
  start: (input: { host: string; port: number }) => Promise<LanStartResult>
  stop: () => Promise<LanServiceState>
  /** 用系统默认浏览器打开当前访问地址 */
  open: () => Promise<boolean>
  /** 服务在别处启动 / 停止 / 意外退出时推送最新状态 */
  onChange: (callback: (state: LanServiceState) => void) => () => void
}

type UpdaterState =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'

interface UpdaterProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

interface UpdaterStatus {
  state: UpdaterState
  version?: string
  releaseNotes?: string
  progress?: UpdaterProgress
  error?: string
}

interface UpdaterApi {
  check: () => Promise<UpdaterStatus>
  download: () => Promise<UpdaterStatus>
  install: () => Promise<boolean>
  getStatus: () => Promise<UpdaterStatus>
  onStatus: (callback: (status: UpdaterStatus) => void) => () => void
}

/** 下载任务状态：等待 / 下载中 / 暂停 / 完成 / 失败 / 取消 */
type DownloadStatus = 'waiting' | 'downloading' | 'paused' | 'done' | 'failed' | 'canceled'

interface DownloadRecord {
  id: string
  /** 来源视频 id；纯直链下载时没有 */
  videoId?: number
  title: string
  /** 集名 / 版本名，单集下载为空串 */
  episodeName: string
  /** 文件名 */
  fileName: string
  /** 保存的绝对路径 */
  path: string
  status: DownloadStatus
  /** 0–100 */
  progress: number
  receivedBytes: number
  totalBytes: number
  /** 失败原因 */
  error: string
  /** ISO 8601 */
  createdAt: string
  updatedAt: string
  /** 完成时间，未完成时为空串 */
  completedAt: string
}

/** 列表里的记录：多带磁盘上的真实状态（文件可能被手动删掉 / 挪走） */
interface DownloadRecordView extends DownloadRecord {
  exists: boolean
  /** 磁盘上的实际大小；文件不在时为 0 */
  size: number
}

interface DownloadRemoveResult {
  records: DownloadRecordView[]
  /** 真的删掉的文件数 */
  deletedFiles: number
  /** 想删但没删的文件数（不在下载目录 / 删除失败） */
  keptFiles: number
}

interface DownloadPathResult {
  ok: boolean
  /** INVALID_PATH：不是绝对路径；NOT_WRITABLE：目录建不出来 */
  error?: 'INVALID_PATH' | 'NOT_WRITABLE'
  settings: AppSettings
}

/** 下载目录的占用与所在磁盘的容量（`downloads:usage`） */
interface DownloadUsage {
  /** 实际扫描的目录 */
  path: string
  /** 目录里的文件数（递归） */
  files: number
  /** 目录里所有文件的总字节数 */
  size: number
  /** 所在磁盘总容量；读不到时为 0 */
  total: number
  /** 所在磁盘剩余可用空间；读不到时为 0 */
  free: number
}

interface DownloadsApi {
  list: () => Promise<DownloadRecordView[]>
  /** 下载目录占用 + 磁盘容量；读取失败时 ok 为假 */
  usage: () => Promise<{ ok: boolean; usage?: DownloadUsage }>
  /** 用播放窗播本机文件；文件被删 / 记录不存在时返回 ok: false */
  play: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** 不带 id 打开下载目录，带 id 在文件管理器里定位该文件 */
  openFolder: (id?: string) => Promise<{ ok: boolean }>
  remove: (input: { ids: string[]; deleteFiles?: boolean }) => Promise<DownloadRemoveResult>
  clearFinished: (input?: { deleteFiles?: boolean }) => Promise<DownloadRemoveResult>
  pickPath: () => Promise<{ ok: boolean; canceled?: boolean; path?: string }>
  setPath: (value: string) => Promise<DownloadPathResult>
  /** 设置同时下载的任务数（1–5），返回保存后的设置 */
  setConcurrency: (value: number) => Promise<AppSettings>
  onChange: (callback: () => void) => () => void
}

interface Api {
  app: AppApi
  player: PlayerApi
  appearance: AppearanceApi
  settings: SettingsApi
  downloads: DownloadsApi
  sites: SitesApi
  categories: CategoriesApi
  bindings: BindingsApi
  backup: BackupApi
  home: HomeApi
  videos: VideosApi
  cache: CacheApi
  updater: UpdaterApi
  lan: LanApi
  windowControls: WindowControls
}

interface Window {
  electron: import('@electron-toolkit/preload').ElectronAPI
  api: Api
}
