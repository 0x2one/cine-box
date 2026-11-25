/**
 * 局域网影院：主进程 HTTP 服务、控制台 IPC 与网页端共用的数据形状。
 * 渲染层看到的那一份手写在 `src/preload/api.d.ts`（项目约定：IPC 类型不跨进程导入）。
 */

export interface LanAddress {
  /** 网卡名称，如「WLAN」「以太网」；回环地址固定叫「本机」 */
  name: string
  address: string
  /** 回环地址只能本机访问，手机扫码扫不到 */
  loopback: boolean
}

/** 绑定全部网卡时用这个地址，和 Node 的 listen 语义一致 */
export const LAN_ALL_INTERFACES = '0.0.0.0'
export const LAN_DEFAULT_PORT = 8090
export const LAN_MIN_PORT = 1024
export const LAN_MAX_PORT = 65535

export interface LanServiceState {
  running: boolean
  /** 当前监听 / 上次保存的地址；`0.0.0.0` 表示全部网卡 */
  host: string
  port: number
  /** 浏览器可访问的地址（第一项用于二维码）；服务没启动时是「启动后可用」的预览 */
  urls: string[]
  /** 当前机器上的 IPv4 地址，控制台的下拉框用 */
  addresses: LanAddress[]
  /** 最近一次启动失败的原因码，成功启动后清空 */
  error?: string
  /** ISO 8601；服务没启动时为空串 */
  startedAt: string
}

export type LanStartError =
  | 'INVALID_HOST'
  | 'INVALID_PORT'
  | 'PORT_IN_USE'
  | 'ADDRESS_UNAVAILABLE'
  | 'PERMISSION'
  | 'START_FAILED'

export interface LanStartResult {
  ok: boolean
  error?: LanStartError
  state: LanServiceState
}

export interface LanVideoCard {
  id: number
  name: string
  pic: string
  /** 封面加载失败时依次尝试的其它来源封面 */
  picCandidates: string[]
  note: string
  intro: string
  sourceCount: number
  vodClass: string
  vodActor: string
  /** 采集站给出的更新时间（可能已经是格式化好的字符串） */
  latestTime: string
}

/** 在线检索里单个站点的情况，展示「参与 / 成功 / 失败」 */
export interface LanSearchSite {
  siteId: string
  /** 站点显示名（主进程从业务库补），网页端展示分站结果用 */
  siteName: string
  ok: boolean
  count: number
  recordCount: number
  error?: string
}

export interface LanSearchPayload {
  ok: boolean
  error?: string
  mode: 'local' | 'online'
  keyword: string
  items: LanVideoCard[]
  total: number
  page: number
  pageSize: number
  /** 在线检索：参与站点数、分站结果、后台入队任务数 */
  siteCount?: number
  sites?: LanSearchSite[]
  queued?: number
  /** 在线结果超过上限时只返回前 N 条 */
  truncated?: boolean
}

export interface LanLatestPayload {
  ok: boolean
  error?: string
  items: LanVideoCard[]
  page: number
  pageSize: number
}

/** 网页端「找片看」用的分类：只给展示端可见的分类（隐藏的父分类连同子树一起不返回） */
export interface LanCategory {
  id: string
  /** 一级分类为 null */
  parentId: string | null
  name: string
  sortOrder: number
}

export interface LanCategoriesPayload {
  ok: boolean
  error?: string
  categories: LanCategory[]
}

export interface LanBrowseQuery {
  /** 选中的本地分类（一级或子分类）；空串表示「全部」= 所有可见一级分类的并集 */
  categoryId: string
  page: number
  pageSize: number
}

export interface LanBrowsePayload {
  ok: boolean
  error?: string
  items: LanVideoCard[]
  page: number
  pageSize: number
  /** 回显这次筛选的分类，空串表示「全部」 */
  categoryId: string
}

export interface LanPlayEpisode {
  name: string
  url: string
  /**
   * 网页播放器只播 m3u8：主进程已经过滤掉直链 / 分享页，目前恒为 hls；
   * 保留这个字段是为了以后扩展其它播放协议。
   */
  kind: 'hls' | 'file'
}

export interface LanPlayLine {
  /** 采集站给的线路名，空串表示默认线路 */
  flag: string
  episodes: LanPlayEpisode[]
}

export interface LanVideoSource {
  id: number
  siteName: string
  lines: LanPlayLine[]
}

export interface LanVideoDetail {
  id: number
  name: string
  pic: string
  picCandidates: string[]
  note: string
  intro: string
  vodActor: string
  vodClass: string
  year: string
  area: string
  sourceCount: number
  sources: LanVideoSource[]
}

export interface LanDetailPayload {
  ok: boolean
  error?: string
  video?: LanVideoDetail
}

/**
 * 下载中心里的「本机缓存」：网页端只读，一个条目就是一条已完成的缓存记录。
 * 同一部视频的多集由网页端按 videoId 聚合成分组。
 */
export interface LanCacheItem {
  /** 下载记录 id（32 位十六进制） */
  id: string
  videoId: number
  title: string
  episodeName: string
  sourceName: string
  lineIndex: number
  episodeIndex: number
  /** 缓存包总字节数 */
  size: number
  updatedAt: string
  /** 网页播放器用的播放列表地址，和页面同源 */
  playUrl: string
}

export interface LanDownloadsPayload {
  ok: boolean
  error?: string
  items: LanCacheItem[]
}

/** 网页端取缓存包里的一个文件（playlist / 分片 / 密钥 / init） */
export interface LanCacheFile {
  /** 磁盘上的绝对路径 */
  file: string
  contentType: string
  size: number
}

/** 由主进程注入的数据读取器：HTTP 服务本身不碰 SQLite，方便单独测试 */
export interface LanServiceDeps {
  /** 本地片库搜索（主进程负责隐藏 / 禁用站点的过滤） */
  searchLocal: (keyword: string, page: number, pageSize: number) => LanSearchPayload
  /** 在线检索：复用展示端「在线」模式那套逻辑 */
  searchOnline: (keyword: string) => Promise<LanSearchPayload>
  /** 首页「最近收录」 */
  latest: (page: number, pageSize: number) => LanLatestPayload
  /** 找片看：展示端可见的本地分类 */
  categories: () => LanCategoriesPayload
  /** 找片看：按分类分页取视频（空分类 = 所有可见一级分类的并集） */
  browse: (query: LanBrowseQuery) => LanBrowsePayload
  /** 播放页详情：详情缓存优先，缺的时候由主进程负责抓取 */
  detail: (videoId: number) => Promise<LanDetailPayload>
  /** 下载中心：本机已缓存完成的剧集（传 videoId 只取这一部） */
  downloads: (videoId?: number) => LanDownloadsPayload
  /** 读取缓存包里的文件；记录不可播 / 路径非法时返回 null */
  cachedFile: (recordId: string, relativePath: string) => Promise<LanCacheFile | null>
  /** 服务状态变化（启动 / 停止 / 意外退出）时通知控制台 */
  onChange?: (state: LanServiceState) => void
}

/** 代理请求用的 fetch：由主进程传 net.fetch，测试时可以换成 Node 的 fetch */
export type LanFetch = (input: string, init?: RequestInit) => Promise<Response>
