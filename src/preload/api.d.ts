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
  id: string
  name: string
}

interface SiteCategoriesResult {
  ok: boolean
  /** NOT_FOUND：站点已被删除；NETWORK：连接失败 / 超时；HTTP：站点返回非 2xx；PARSE：返回内容无法解析 */
  error?: 'NOT_FOUND' | 'NETWORK' | 'HTTP' | 'PARSE'
  message?: string
  categories?: SiteCategory[]
}

interface SitesApi {
  list: () => Promise<Site[]>
  add: (input: SiteInput) => Promise<AddSiteResult>
  update: (id: string, input: SiteInput) => Promise<UpdateSiteResult>
  remove: (id: string) => Promise<RemoveSiteResult>
  /** 按站点保存的格式请求 ac=list，返回该站点的视频分类 */
  categories: (id: string) => Promise<SiteCategoriesResult>
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
  updater: UpdaterApi
  windowControls: WindowControls
}

interface Window {
  electron: import('@electron-toolkit/preload').ElectronAPI
  api: Api
}
