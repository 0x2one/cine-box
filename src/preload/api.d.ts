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

interface AppSettings {
  openAtLogin: boolean
  closeToTray: boolean
  autoDownload: boolean
  /** 全局快捷键，空字符串表示未启用 */
  showShortcut: string
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

interface Api {
  app: { info: () => Promise<AppInfo> }
  settings: SettingsApi
  sites: SitesApi
  categories: CategoriesApi
  bindings: BindingsApi
  cache: CacheApi
  updater: UpdaterApi
  windowControls: WindowControls
}

interface Window {
  electron: import('@electron-toolkit/preload').ElectronAPI
  api: Api
}
