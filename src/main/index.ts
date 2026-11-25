import {
  app,
  shell,
  dialog,
  BrowserWindow,
  ipcMain,
  nativeImage,
  Menu,
  net,
  protocol,
  Tray,
  globalShortcut,
  screen
} from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { isAbsolute, join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createAppSettingsStore, DEFAULT_SHOW_SHORTCUT } from './app-settings'
import { createCacheManager } from './app-cache'
import { createBackupStore, type RestoreSource } from './backup-store'
import { createBindingStore, type BindingTarget } from './binding-store'
import {
  createCategoryStore,
  type CategoryPlacement,
  type VideoCategory,
  type VideoCategoryInput
} from './category-store'
import { createCollectLogStore } from './collect-log-store'
import { createCollectScheduleStore } from './collect-schedule-store'
import { createCollectScheduler } from './collect-scheduler'
import { downloadMediaUrl, DOWNLOAD_MEDIA_SCHEME, serveDownloadFile } from './download-media'
import { createDownloadEngine } from './download-engine'
import { createDownloadHlsServer } from './download-hls-server'
import { createDownloadStore } from './download-store'
import type { DownloadRecord, DownloadStatus } from './download-store'
import { readDownloadUsage } from './download-usage'
import { buildHomeFeed, buildSearchSection } from './home-feed'
import { boundTopCategories, syncRecommendations } from './home-recommend'
import { createHomeStore } from './home-store'
import { createLanService } from './lan/lan-service'
import { isHlsUrl } from './lan/lan-media-url'
import type {
  LanBrowsePayload,
  LanBrowseQuery,
  LanCategoriesPayload,
  LanCategory,
  LanDetailPayload,
  LanLatestPayload,
  LanSearchPayload,
  LanVideoCard
} from './lan/lan-types'
import { createPlayerWindowManager } from './player-window'
import type {
  HomeFeed,
  HomeFeedResult,
  HomeFeedView,
  HomeItemPatch,
  HomeSearchPatch,
  HomeSearchResult,
  HomeSectionPatch
} from './home-types'
import { fetchSiteCategories } from './site-categories'
import { fetchCollectText } from './collect-http'
import { clampPageSize, DEFAULT_PAGE_SIZE, probePageSize } from './video-collect-probe'
import { parseCollectPage } from './video-collect-parser'
import type { CollectedPage } from './video-collect-parser'
import { makeNameKey, nameMatchRank } from './video-text'
import {
  createSiteStore,
  isSameSiteHost,
  type CategoryUpdateMode,
  type Site,
  type SiteCategoryInput,
  type SiteInput
} from './site-store'
import { createUpdater } from './updater'
import { createVideoCacheStore } from './video-cache-store'
import type { DetailSourceRow } from './video-cache-store'
import { createVideoCollector } from './video-collector'
import { createVideoDetailCache } from './video-detail-cache'
import { resolveWindowSize, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from './window-size'
import {
  ONLINE_SEARCH_PAGE_SIZE,
  type CollectMode,
  type FetchRange,
  type PicCleanOutcome,
  type PicCleanProgress,
  type PicCleanStats,
  type PicCleanStatus,
  type SiteSearchTestResult,
  type VideoCollectStartInput,
  type VideoListQuery,
  type VideoListItem,
  type VideoOnlineSearchResult,
  type VideoOnlineSearchSite,
  type VideoScheduleInput,
  type VideoSitePurgeResult,
  type VideoUpdateInput
} from './video-types'

const gotTheLock = app.requestSingleInstanceLock()

// 首页自定义图片走自己的协议，避免把图片整段塞进配置 JSON 或放开 file://
// 下载到本机的视频也用独立协议：播放窗按 Range 取字节，只放行下载记录里登记过的文件
protocol.registerSchemesAsPrivileged([
  { scheme: 'cine-img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: DOWNLOAD_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 真正退出（而不是收进托盘）时的标记 */
let isQuitting = false
/** 当前已注册的全局快捷键 */
let registeredShortcut: string | null = null

const appSettingsStore = createAppSettingsStore()
// 应用数据存 SQLite：userData/Data/cine-box.db，站点与视频分类共用这一个库
const databaseFile = join(app.getPath('userData'), 'Data', 'cine-box.db')
const siteStore = createSiteStore(databaseFile)
const categoryStore = createCategoryStore(databaseFile)
const bindingStore = createBindingStore(databaseFile)
// 备份文件与数据库同目录：userData/Data/Backups
const backupStore = createBackupStore(databaseFile, app.getVersion())
// 视频缓存库与详情文件单独存放，可整体清理，不影响站点/分类/计划
const videoCacheFile = join(app.getPath('userData'), 'Data', 'video-cache.db')
const videoRoot = join(app.getPath('userData'), 'Data', 'videos')
const videoStore = createVideoCacheStore(videoCacheFile, {
  // 采集重算 pic 时读当前配置，改配置立即生效、不用重启
  defaultPicSiteId: () => appSettingsStore.get().defaultPicSiteId
})
const scheduleStore = createCollectScheduleStore(databaseFile)
const collectLogs = createCollectLogStore(
  () => videoStore.connection(),
  (log) => sendToRenderer('videos:logs:onAppend', log)
)
let cacheEpoch = 0
const detailCache = createVideoDetailCache({
  rootDir: videoRoot,
  store: videoStore,
  listSites: () => siteStore.list(),
  epoch: () => cacheEpoch,
  bumpEpoch: () => {
    cacheEpoch += 1
  }
})
const collector = createVideoCollector({
  store: videoStore,
  details: detailCache,
  logs: collectLogs,
  listSites: () => siteStore.list(),
  // 站点缓存正在后台清理时，采集要等它删完再入队
  waitForSite: (siteId) => waitSiteCachePurge(siteId),
  // 每次填槽都读一次设置：进度页调完并发立刻生效，不用重启
  getConcurrency: () => appSettingsStore.get().collectConcurrency,
  emitProgress: (progress) => {
    // 采集每落一页都会推一次进度：新片进来推荐页的轨道就该变，缓存作废
    invalidateHomeFeed()
    sendToRenderer('videos:collect:progress', progress)
  }
})
const scheduler = createCollectScheduler({
  schedules: scheduleStore,
  collector,
  logs: collectLogs,
  // 禁用的站点不跑定时采集：照常推进 next_run_at，只补一条日志
  isSiteDisabled: (siteId) => siteStore.list().some((site) => site.id === siteId && site.disabled)
})
// 首页配置（海报叠层 + 分类推荐）与自定义图片：userData/Data/Home
const homeStore = createHomeStore(join(app.getPath('userData'), 'Data', 'Home'))
// 下载中心的记录固定存 userData/Data/Downloads，媒体文件放在设置里的下载目录
const downloadStore = createDownloadStore({
  directory: () => appSettingsStore.get().downloadPath,
  // 结构变化（增 / 删）才重拉列表；进度走轻量的 downloads:progress，避免整页重排
  onChange: () => broadcastRenderer('downloads:changed'),
  onProgress: (record) => broadcastRenderer('downloads:progress', record)
})
// 离线缓存队列：并发读「设置 › 下载」，进度事件也广播给已打开的播放窗
const downloadEngine = createDownloadEngine({
  store: downloadStore,
  getConcurrency: () => appSettingsStore.get().downloadConcurrency
})
// 缓存包的本机播放服务：hls.js 走普通 http，避免自定义协议在 CORS 上的版本差异
const downloadHlsServer = createDownloadHlsServer({
  findRecord: (id) => downloadStore.find(id)
})
/** 缓存库初始化失败时不影响应用启动，视频相关 IPC 返回 CACHE_UNAVAILABLE */
let videoCacheReady = false
/** 「重新获取」的抓取结果，等用户选择增量 / 全量后再写库，保证确认内容与实际写入一致 */
const pendingCategoryRefresh = new Map<string, { categories: SiteCategoryInput[]; at: number }>()
const PENDING_CATEGORY_TTL = 5 * 60 * 1000
const updater = createUpdater(sendToRenderer, () => appSettingsStore.get().autoDownload)
const cacheManager = createCacheManager()
// 播放页跑在独立的无边框暗色窗口里，不复用主窗口（IPC 由它自己注册）
const playerWindows = createPlayerWindowManager({
  preload: join(__dirname, '../preload/index.js'),
  icon
})

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
}

/** 同时发给主窗口和播放窗：下载进度、缓存增删都要让播放页的缓存状态跟上 */
function broadcastRenderer(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(channel, ...args)
  }
}

function siteNameMap(): Map<string, string> {
  return new Map(siteStore.list().map((site) => [site.id, site.display || site.name]))
}

/** 启动 / 恢复备份后按 cache_sites 对账，不扫 video_sources 大表 */
async function reconcileVideoCache(): Promise<void> {
  if (!videoCacheReady) return
  const sites = new Map(siteStore.list().map((site) => [site.id, site]))
  for (const row of videoStore.listCacheSites()) {
    const site = sites.get(row.siteId)
    // 只按 host 比：同一个域名下改路径 / 补斜杠不算换站点，缓存继续用
    if (!site || !isSameSiteHost(site.address, row.address) || site.format !== row.format) {
      videoStore.removeSite(row.siteId)
      await detailCache.removeSite(row.siteId)
    }
  }
}

/**
 * 站点缓存的后台清理队列（key = 站点 id）。
 *
 * 改地址 / 删站点之后旧来源、旧视频和详情文件都要丢掉：5.5 万条来源的站点实测
 * 1.4s 删库（SQLite 同步，会占满主进程）+ 4s 删 5.5 万个详情文件，全程十几秒。
 * 所以它不堵在 IPC 的返回路径上——调用方立刻拿到结果，这里排队慢慢清；
 * 同一站点连续触发时串行执行，第二次不会插到第一次中间。
 */
type SiteCachePurgeStats = { sources: number; videos: number; shared: number }

const siteCachePurges = new Map<string, Promise<SiteCachePurgeStats | null>>()

async function purgeSiteCache(siteId: string): Promise<SiteCachePurgeStats | null> {
  // 先停掉这个站点的采集并等它退出：只置取消标记的话，在途那一页会在删完之后写回来
  await collector.stopAndWait(siteId)
  // 先作废推荐页那份缓存：清理期间重建也不会再看到这个站点的视频
  invalidateHomeFeed()
  if (!videoCacheReady) return null
  let removed: SiteCachePurgeStats
  try {
    removed = videoStore.removeSite(siteId)
  } catch (error) {
    console.error('清理站点视频缓存失败', error)
    return null
  }
  await detailCache.removeSite(siteId).catch(() => {})
  invalidateHomeFeed()
  return removed
}

/**
 * 排队清理一个站点的缓存。返回的是这次（含前面排着的同站点清理）的 Promise：
 * `sites:update` / `sites:remove` 不关心结果，容量页的「删除站点数据」要等它删完报数字。
 */
function scheduleSiteCachePurge(siteId: string): Promise<SiteCachePurgeStats | null> {
  const next = (siteCachePurges.get(siteId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => purgeSiteCache(siteId))
    .finally(() => {
      if (siteCachePurges.get(siteId) === next) siteCachePurges.delete(siteId)
    })
  siteCachePurges.set(siteId, next)
  return next
}

/** 采集 / 清空缓存 / 恢复备份前先等后台清理做完，否则刚写进去的数据会被它删掉 */
function waitSiteCachePurge(siteId?: string): Promise<void> {
  const pending = siteId ? [siteCachePurges.get(siteId)] : [...siteCachePurges.values()]
  return Promise.all(pending.map((item) => item?.catch(() => {}))).then(() => undefined)
}

function cacheUnavailable(): { ok: false; error: string } {
  return { ok: false, error: 'CACHE_UNAVAILABLE' }
}

/**
 * 推荐页 feed 的缓存：只缓存展示端口径那一份。
 * 展示端每次切回「推荐」都会重新挂载并要一份 feed，而视频库、分类、绑定基本不变，
 * 所以缓存后重复进入是 0 次查询。所有写操作都会 invalidateHomeFeed()，
 * TTL 只是「漏掉某个写入口」时的兜底，不是刷新策略。
 */
const DISPLAY_FEED_TTL = 60 * 1000
let displayFeed: { at: number; feed: HomeFeed } | null = null
/** 封面统计的短缓存：一次规则统计要扫全库（11 万部约 260ms），换一批只重算抽样 */
type PicCounts = Omit<PicCleanStats, 'ok' | 'error' | 'siteId' | 'samples'>
let picCountsCache: { key: string; at: number; counts: PicCounts } | null = null

function invalidateHomeFeed(): void {
  displayFeed = null
  picCountsCache = null
}

/**
 * 把「禁用的站点」同步给缓存库：列表 / 搜索 / 首页默认只返回「还有启用站点来源」的视频，
 * 只被禁用站点收录的视频等于不存在；多个来源时只要还有一个启用站点就照常显示。
 * 站点增删改、恢复备份之后都要调一次。
 */
function refreshDisabledSites(): void {
  if (!videoCacheReady) return
  videoStore.setDisabledSites(
    siteStore
      .list()
      .filter((site) => site.disabled)
      .map((site) => site.id)
  )
  invalidateHomeFeed()
}

/**
 * 首页数据：配置 + 分类绑定 + 视频库解析成一份可以直接渲染的 feed。
 * 展示端取 'display'（不算总数、不含隐藏轨道、不带搜索推荐位），控制台取 'console'。
 */
function readHomeFeed(view: HomeFeedView): HomeFeedResult {
  if (view === 'display' && displayFeed && Date.now() - displayFeed.at < DISPLAY_FEED_TTL) {
    return { ok: true, feed: displayFeed.feed }
  }
  try {
    const feed = buildHomeFeed(
      {
        config: homeStore.get(),
        categories: categoryStore.list(),
        bindingsFor: (categoryId) => bindingStore.forCategory(categoryId),
        // 控制台要把禁用站点的条目也读出来（否则会显示成「视频已丢失」）；展示端按可见口径
        videosByIds: (videoIds) =>
          videoStore.listVideosByIds(videoIds, { includeDisabledSites: view === 'console' }),
        listVideos: (query, filters) => videoStore.listVideos(query, filters),
        cacheReady: videoCacheReady
      },
      view
    )
    if (view === 'display') displayFeed = { at: Date.now(), feed }
    return { ok: true, feed }
  } catch (error) {
    console.error('读取首页数据失败', error)
    return { ok: false, error: 'DB' }
  }
}

/** 搜索页底部的推荐位：单独读，控制台和搜索页看到的是同一份结果 */
function readHomeSearch(): HomeSearchResult {
  try {
    const search = buildSearchSection({
      config: homeStore.get().search,
      videosByIds: (videoIds) => videoStore.listVideosByIds(videoIds),
      listVideos: (query, filters) => videoStore.listVideos(query, filters),
      cacheReady: videoCacheReady
    })
    return { ok: true, search }
  } catch (error) {
    console.error('读取搜索推荐失败', error)
    return { ok: false, error: 'DB' }
  }
}

/* ── 首页推荐：只能推荐到视频实际绑定的大类 ── */

/**
 * 视频 → 它所属的本地一级分类（按绑定关系推导，顺序跟分类树一致）。
 * 「推荐到首页」只能进这些分类；绑定变了推荐要跟着搬家，彻底解绑就删掉。
 */
function boundTopCategoriesByVideo(videoIds: number[]): Map<number, string[]> {
  if (!videoCacheReady || videoIds.length === 0) return new Map()
  return boundTopCategories(
    categoryStore.list(),
    bindingStore.pathsForSourceCategories(),
    videoStore.listSourceCategories(videoIds)
  )
}

/**
 * 绑定 / 分类结构变了之后，把推荐条目挪到视频现在所属的大类：
 * 还绑着别的分类就搬过去（保留原来的覆盖字段），彻底解绑的直接从推荐里删掉。
 */
function syncHomeRecommendations(): void {
  if (!videoCacheReady) return
  syncRecommendations({
    config: homeStore.get(),
    categories: categoryStore.list(),
    bindings: bindingStore.pathsForSourceCategories(),
    loadVideoData: (videoIds) => ({
      sources: videoStore.listSourceCategories(videoIds),
      knownVideoIds: videoStore.listVideosByIds(videoIds).map((video) => video.id)
    }),
    move: (fromCategoryId, toCategoryId, videoId) =>
      homeStore.moveSectionItem(fromCategoryId, toCategoryId, videoId)
  })
  // 推荐条目可能被挪到别的大类里，展示端的缓存跟着作废
  invalidateHomeFeed()
}

/* ── 主窗口显示 / 隐藏 ── */

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.setSkipTaskbar(false)
  mainWindow.show()
  mainWindow.focus()
}

function hideMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 只有存在托盘图标时才从任务栏移除，否则用户没法再找回来
  if (appSettingsStore.get().closeToTray) {
    mainWindow.setSkipTaskbar(true)
  }
  mainWindow.hide()
}

function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  // 快捷键再次按下时：窗口在前台 → 收起
  if (
    mainWindow.isVisible() &&
    (mainWindow.isFocused() || BrowserWindow.getFocusedWindow() === mainWindow)
  ) {
    hideMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.setSkipTaskbar(false)
  mainWindow.show()
  mainWindow.focus()
}

/* ── 全局快捷键 ── */

function tryRegisterAccel(accel: string): 'ok' | 'conflict' | 'invalid' {
  try {
    if (globalShortcut.register(accel, () => toggleMainWindow())) {
      registeredShortcut = accel
      return 'ok'
    }
    // 已被其它程序 / 系统占用，注册请求会被静默丢弃
    return 'conflict'
  } catch {
    return 'invalid'
  }
}

function applyShowShortcut(accel: string | null): {
  ok: boolean
  error?: string
  shortcut: string
} {
  const prev = registeredShortcut
  const trimmed = accel?.trim() ?? ''
  if (prev) {
    globalShortcut.unregister(prev)
    registeredShortcut = null
  }
  if (!trimmed) return { ok: true, shortcut: '' }
  const result = tryRegisterAccel(trimmed)
  if (result === 'ok') return { ok: true, shortcut: trimmed }
  // 注册失败（多为冲突）时回滚到上一个快捷键，并说明原因
  if (prev) tryRegisterAccel(prev)
  return { ok: false, error: result === 'conflict' ? 'CONFLICT' : 'INVALID', shortcut: prev ?? '' }
}

/* ── 托盘 ── */

function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}

function createTray(): void {
  if (tray) return
  const trayIcon = nativeImage.createFromPath(icon)
  tray = new Tray(
    trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon.resize({ width: 16, height: 16 })
  )
  tray.setToolTip('映盒剧场')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '检查更新', click: () => updater.checkForUpdates() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

function syncTrayWithSettings(): void {
  if (appSettingsStore.get().closeToTray) {
    createTray()
  } else {
    destroyTray()
  }
}

/**
 * 无边框窗口没有系统菜单，仍需保留最小菜单以提供编辑（复制 / 粘贴 / 全选）能力。
 */
function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }, { role: 'windowMenu' }] as const) : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ── 主窗口 ── */

function createWindow(): void {
  // 启动尺寸取偏好设置里的三档之一；屏幕放不下时按主显示器工作区收缩，不顶满屏幕
  const { width, height } = resolveWindowSize(
    appSettingsStore.get().windowSize,
    screen.getPrimaryDisplay().workAreaSize
  )
  const winOptions: Electron.BrowserWindowConstructorOptions = {
    width,
    height,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    // 任务栏 / 窗口图标：Windows、Linux 生效，macOS 走 Dock 图标（见下）
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 首屏打开哪一页由主进程在启动时决定，preload 同步读取，避免先渲染推荐页再跳搜索
      additionalArguments: [`--cinebox-start-view=${appSettingsStore.get().startView}`]
    }
  }
  if (process.platform === 'darwin') {
    // macOS 保留左上角原生红绿灯，其余内容由自定义标题栏绘制
    winOptions.titleBarStyle = 'hiddenInset'
    winOptions.trafficLightPosition = { x: 15, y: 15 }
  } else {
    // Windows / Linux：隐藏系统标题栏，改用自绘操作栏
    winOptions.frame = false
  }
  mainWindow = new BrowserWindow(winOptions)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting && appSettingsStore.get().closeToTray) {
      event.preventDefault()
      mainWindow?.setSkipTaskbar(true)
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('maximize', () => {
    sendToRenderer('window:maximize-change', true)
  })

  mainWindow.on('unmaximize', () => {
    sendToRenderer('window:maximize-change', false)
  })

  if (process.platform === 'win32') {
    // 无边框窗口丢掉了系统自带的「双击标题栏最大化」，用窗口消息补回来。
    // 只在标题栏拖拽区生效，避免双击右侧按钮时误触；中间的展示端导航是 no-drag 区，也排除掉。
    const WM_LBUTTONDBLCLK = 0x0203
    const TITLE_BAR_HEIGHT = 44
    const BRAND_ZONE_WIDTH = 150
    // 右侧操作区：下载 / 控制台 / 设置三颗 30px 图标按钮 + 分隔线 + 三个 46px 窗口按钮，
    // 加间距约 253px（改动 TitleBar 的按钮数量时这里要跟着改）
    const ACTIONS_ZONE_WIDTH = 254
    // 与 TitleBar 中间「推荐 / 搜索 / 找片看」胶囊的实际宽度对齐（main.css 的 .titlebar-nav）：
    // 内边距 3+3、边框 1+1、两侧等宽按钮 82×2、搜索框 200、三处间距 6×2
    const CENTER_NAV_WIDTH = 384
    mainWindow.hookWindowMessage(WM_LBUTTONDBLCLK, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const cursor = screen.getCursorScreenPoint()
      const bounds = mainWindow.getBounds()
      const centerLeft = bounds.x + (bounds.width - CENTER_NAV_WIDTH) / 2
      const inTitleBar = cursor.y >= bounds.y && cursor.y <= bounds.y + TITLE_BAR_HEIGHT
      const inDragZone =
        cursor.x >= bounds.x + BRAND_ZONE_WIDTH &&
        cursor.x <= bounds.x + bounds.width - ACTIONS_ZONE_WIDTH &&
        (cursor.x < centerLeft || cursor.x > centerLeft + CENTER_NAV_WIDTH)
      if (!inTitleBar || !inDragZone) return
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow.maximize()
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/* ── IPC：窗口控制 ── */

/** 窗口控制按调用方定位：主窗口和播放窗口共用同一套通道 */
function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

ipcMain.handle('window:minimize', (event) => {
  senderWindow(event)?.minimize()
})

ipcMain.handle('window:maximize', (event) => {
  const window = senderWindow(event)
  if (!window) return
  if (window.isMaximized()) {
    window.unmaximize()
  } else {
    window.maximize()
  }
})

ipcMain.handle('window:close', (event) => {
  senderWindow(event)?.close()
})

ipcMain.handle('window:isMaximized', (event) => senderWindow(event)?.isMaximized() ?? false)

/* ── IPC：应用设置 ── */

ipcMain.handle('settings:get', () => appSettingsStore.get())

ipcMain.handle('settings:setOpenAtLogin', (_event, value: boolean) =>
  appSettingsStore.setOpenAtLogin(Boolean(value))
)

ipcMain.handle('settings:setCloseToTray', (_event, value: boolean) => {
  const settings = appSettingsStore.setCloseToTray(Boolean(value))
  syncTrayWithSettings()
  // 关掉「最小化到托盘」时，如果窗口正藏在托盘里就把它拉回来
  if (!settings.closeToTray && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    showMainWindow()
  }
  return settings
})

ipcMain.handle('settings:setAutoDownload', (_event, value: boolean) =>
  appSettingsStore.setAutoDownload(Boolean(value))
)

ipcMain.handle('settings:setShowShortcut', (_event, value: string | null) => {
  const result = applyShowShortcut(value)
  if (result.ok) appSettingsStore.setShowShortcut(result.shortcut)
  return result
})

ipcMain.handle('settings:resetShowShortcut', () => {
  const result = applyShowShortcut(DEFAULT_SHOW_SHORTCUT)
  if (result.ok) appSettingsStore.setShowShortcut(result.shortcut)
  return result
})

ipcMain.handle('settings:setStartView', (_event, value: string) =>
  appSettingsStore.setStartView(value)
)

ipcMain.handle('settings:setWindowSize', (_event, value: string) =>
  appSettingsStore.setWindowSize(value)
)

ipcMain.handle('settings:setDefaultPicSite', (_event, value: string) => {
  // 站点可能刚被删掉：失效的 id 直接回落成「不指定」，不让配置指向悬空站点
  const siteId = typeof value === 'string' ? value.trim() : ''
  const valid = siteId && siteStore.list().some((site) => site.id === siteId) ? siteId : ''
  return appSettingsStore.setDefaultPicSite(valid)
})

ipcMain.handle('settings:setCollectConcurrency', (_event, value: number) => {
  const settings = appSettingsStore.setCollectConcurrency(value)
  // 调大后立刻把排队任务填进新槽位；调小不打断正在采集的任务
  collector.wake()
  collectLogs.append({
    level: 'info',
    message: `采集并发已调整为 ${settings.collectConcurrency} 路`
  })
  return settings
})

/* ── IPC：下载中心 ── */

interface CacheEpisodeInput {
  videoId?: number
  sourceId?: number
  lineIndex?: number
  episodeIndexes?: number[]
}

interface CacheEpisodeItem {
  videoId: number
  title: string
  episodeName: string
  sourceId: number
  sourceName: string
  lineIndex: number
  episodeIndex: number
  url: string
}

/**
 * 播放页只传「视频 + 来源 + 线路 + 集下标」，真正的 m3u8 地址由主进程按详情缓存解析：
 * 渲染层不能借缓存接口下载任意 URL；多选批量一次解析多集。
 */
async function resolveCacheEpisodes(
  input: CacheEpisodeInput | undefined
): Promise<{ ok: true; items: CacheEpisodeItem[] } | { ok: false; error: string }> {
  const videoId = Number(input?.videoId)
  const sourceId = Number(input?.sourceId)
  const lineIndex = Number(input?.lineIndex)
  const rawIndexes = Array.isArray(input?.episodeIndexes) ? input.episodeIndexes : []
  const indexes = [
    ...new Set(
      rawIndexes
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0)
    )
  ]
  if (
    !Number.isInteger(videoId) ||
    videoId <= 0 ||
    !Number.isInteger(sourceId) ||
    sourceId <= 0 ||
    !Number.isInteger(lineIndex) ||
    lineIndex < 0 ||
    indexes.length === 0
  ) {
    return { ok: false, error: 'INVALID_INPUT' }
  }
  if (!videoCacheReady) return { ok: false, error: 'CACHE_UNAVAILABLE' }

  const detail = await detailCache.read(videoId, true)
  if (!detail.ok || !detail.video) return { ok: false, error: detail.error ?? 'NOT_FOUND' }
  const source = detail.video.sources.find((item) => item.id === sourceId)
  const line = source?.detail?.playLines?.[lineIndex]
  if (!source || !line) return { ok: false, error: 'NO_EPISODE' }

  const title = detail.video.name?.trim() || source.name?.trim() || '未命名视频'
  const sourceName = source.siteName?.trim() ?? ''
  const items: CacheEpisodeItem[] = []
  for (const index of indexes) {
    const episode = line.episodes[index]
    if (!episode) continue
    const url = episode.url.trim()
    if (!isHlsUrl(url)) continue
    items.push({
      videoId,
      title,
      episodeName: episode.name.trim() || `第 ${index + 1} 集`,
      sourceId,
      sourceName,
      lineIndex,
      episodeIndex: index,
      url
    })
  }
  if (items.length === 0) return { ok: false, error: 'NOT_M3U8' }
  return { ok: true, items }
}

/**
 * 暂停 / 失败后继续下载前，尽量拿一次新鲜地址：站点的 m3u8 常带时效签名，
 * 拿着几小时前的旧地址续传会直接 403。解析失败仍用记录里的旧地址兜底。
 */
async function refreshDownloadUrl(record: DownloadRecord): Promise<void> {
  if (
    typeof record.videoId !== 'number' ||
    typeof record.sourceId !== 'number' ||
    typeof record.lineIndex !== 'number' ||
    typeof record.episodeIndex !== 'number'
  ) {
    return
  }
  try {
    const resolved = await resolveCacheEpisodes({
      videoId: record.videoId,
      sourceId: record.sourceId,
      lineIndex: record.lineIndex,
      episodeIndexes: [record.episodeIndex]
    })
    if (resolved.ok && resolved.items[0]) {
      downloadStore.update(record.id, { url: resolved.items[0].url }, { persist: true })
    }
  } catch {
    // 详情缓存拿不到就继续用旧地址
  }
}

ipcMain.handle('downloads:list', () => downloadStore.list())

// 目录占用 + 磁盘容量：设置页的「下载」分区用它画概览，扫描放在 IPC 里不堵界面
ipcMain.handle('downloads:usage', async () => {
  try {
    return { ok: true, usage: await readDownloadUsage(downloadStore.ensureDirectory()) }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('downloads:pickPath', async () => {
  const options: Electron.OpenDialogOptions = {
    title: '选择下载目录',
    defaultPath: appSettingsStore.get().downloadPath,
    properties: ['openDirectory', 'createDirectory']
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
  return { ok: true, path: result.filePaths[0] }
})

ipcMain.handle('downloads:setPath', (_event, value: string) => {
  const next = typeof value === 'string' ? value.trim() : ''
  if (!next || !isAbsolute(next)) {
    return { ok: false, error: 'INVALID_PATH', settings: appSettingsStore.get() }
  }
  try {
    // 目录不存在时直接建出来：用户选的目录可能刚被删掉，没必要让他先去资源管理器建
    mkdirSync(next, { recursive: true })
  } catch {
    return { ok: false, error: 'NOT_WRITABLE', settings: appSettingsStore.get() }
  }
  return { ok: true, settings: appSettingsStore.setDownloadPath(next) }
})

ipcMain.handle('downloads:setConcurrency', (_event, value: number) => {
  // 下载引擎每次填槽都读一次设置：这里落盘后立刻补槽，不打断正在下载的任务
  const settings = appSettingsStore.setDownloadConcurrency(value)
  downloadEngine.wake()
  return settings
})

ipcMain.handle(
  'downloads:remove',
  async (_event, input: { ids?: string[]; deleteFiles?: boolean }) => {
    const ids = Array.isArray(input?.ids) ? input.ids.map(String) : []
    // 先让在跑的任务停下来、把文件句柄放掉，再删记录和缓存包
    await downloadEngine.cancelMany(ids)
    return downloadStore.remove(ids, { deleteFiles: Boolean(input?.deleteFiles) })
  }
)

ipcMain.handle('downloads:clearFinished', (_event, input?: { deleteFiles?: boolean }) =>
  downloadStore.clearFinished({ deleteFiles: Boolean(input?.deleteFiles) })
)

ipcMain.handle('downloads:openFolder', async (_event, id?: string) => {
  const record = id ? downloadStore.find(String(id)) : null
  // 文件还在就定位到它；hls 缓存包在写 playlist 之前先打开包目录
  if (record && existsSync(record.path)) {
    shell.showItemInFolder(record.path)
    return { ok: true }
  }
  if (record?.kind === 'hls' && record.packageDir && existsSync(record.packageDir)) {
    try {
      const error = await shell.openPath(record.packageDir)
      return { ok: error === '' }
    } catch {
      return { ok: false }
    }
  }
  try {
    const error = await shell.openPath(downloadStore.ensureDirectory())
    return { ok: error === '' }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('downloads:play', async (_event, id: string) => {
  const record = downloadStore.find(String(id))
  if (!record) return { ok: false, error: 'NOT_FOUND' }
  if (!existsSync(record.path)) return { ok: false, error: 'FILE_MISSING' }
  if (record.kind === 'hls') {
    // 缓存包走本机 http 服务，播放页按 HLS 播
    const url = await downloadHlsServer.urlFor(record.id)
    if (!url) return { ok: false, error: 'SERVICE_FAILED' }
    return playerWindows.open({
      fileUrl: url,
      hls: true,
      fileName: record.fileName,
      title: record.title,
      episodeName: record.episodeName
    })
  }
  // 本机文件在播放窗里直接播，不按 videoId 取详情
  return playerWindows.open({
    fileUrl: downloadMediaUrl(record.path),
    fileName: record.fileName,
    title: record.title,
    episodeName: record.episodeName
  })
})

/* ── IPC：播放页离线缓存 ── */

ipcMain.handle('downloads:cache', async (_event, input: CacheEpisodeInput) => {
  const resolved = await resolveCacheEpisodes(input)
  if (!resolved.ok) return resolved
  try {
    const result = await downloadEngine.enqueueMany(resolved.items)
    return { ok: true, ...result }
  } catch (error) {
    console.error('加入缓存队列失败', error)
    return { ok: false, error: 'NOT_WRITABLE' }
  }
})

// 播放页按视频取已缓存 / 缓存中的集：只查内存，不逐条 stat
ipcMain.handle('downloads:cachedEpisodes', (_event, videoId: number) => {
  const id = Number(videoId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, items: [] }
  const items: {
    recordId: string
    sourceId: number
    lineIndex: number
    episodeIndex: number
    status: DownloadStatus
    progress: number
    speed: number
  }[] = []
  for (const record of downloadStore.listByVideo(id)) {
    if (record.kind !== 'hls') continue
    if (
      typeof record.sourceId !== 'number' ||
      typeof record.lineIndex !== 'number' ||
      typeof record.episodeIndex !== 'number'
    ) {
      continue
    }
    items.push({
      recordId: record.id,
      sourceId: record.sourceId,
      lineIndex: record.lineIndex,
      episodeIndex: record.episodeIndex,
      status: record.status,
      progress: record.progress,
      speed: record.speed
    })
  }
  return { ok: true, items }
})

// 播放页「优先缓存」：拿到本机 playlist 地址；不可播时让页面回退在线地址
ipcMain.handle('downloads:playbackUrl', async (_event, id: string) => {
  const record = downloadStore.find(String(id))
  if (!record || record.kind !== 'hls') return { ok: false, error: 'NOT_FOUND' }
  if (record.status !== 'done') return { ok: false, error: 'NOT_READY' }
  if (!existsSync(record.path)) return { ok: false, error: 'FILE_MISSING' }
  const url = await downloadHlsServer.urlFor(record.id)
  return url ? { ok: true, url } : { ok: false, error: 'SERVICE_FAILED' }
})

ipcMain.handle('downloads:cancel', async (_event, id: string) => {
  await downloadEngine.cancel(String(id))
  return { ok: true }
})

ipcMain.handle('downloads:pause', (_event, id: string) => downloadEngine.pause(String(id)))

ipcMain.handle('downloads:resume', async (_event, id: string) => {
  const record = downloadStore.find(String(id))
  if (!record) return { ok: false, error: 'NOT_FOUND' }
  if (record.status !== 'paused') return { ok: false, error: 'NOT_PAUSED' }
  await refreshDownloadUrl(record)
  return downloadEngine.resume(record.id)
})

ipcMain.handle('downloads:retry', async (_event, id: string) => {
  const record = downloadStore.find(String(id))
  if (!record) return { ok: false, error: 'NOT_FOUND' }
  // 失败 / 取消的记录重试前也刷一次地址；已暂停走 resume，不走这里
  if (record.status === 'failed' || record.status === 'canceled') {
    await refreshDownloadUrl(record)
  }
  return downloadEngine.restart(record.id)
})

/* ── IPC：缓存管理 ── */

ipcMain.handle('cache:scan', (event) =>
  cacheManager.scan((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('cache:progress', progress)
  })
)

ipcMain.handle('cache:clear', (event) =>
  cacheManager.clear((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('cache:progress', progress)
  })
)

/* ── IPC：视频缓存 ── */

/**
 * 把渲染层传的分类 id 解析成缓存库的（站点 + 在线分类）过滤条件。
 * empty = true 表示「这次筛选没有任何可查的分类」（显式传了空数组 / 子树一条绑定都没有），
 * 调用方要直接返回空结果，不能退化成查全库。
 */
function resolveVideoFilters(query: VideoListQuery | undefined): {
  filters?: { siteId: string; categoryId: string }[]
  empty: boolean
} {
  // 列表页「全部」会一次传多个一级分类，把它们各自的子树一起解析成绑定过滤
  const rawCategoryIds = query?.categoryIds
  const categoryIds: string[] = Array.isArray(rawCategoryIds)
    ? rawCategoryIds.filter((id) => typeof id === 'string' && id !== '')
    : query && query.categoryId
      ? [query.categoryId]
      : []
  // 显式传了空数组（没有任何可见分类）：直接空结果，不要退化成全库
  if (Array.isArray(rawCategoryIds) && categoryIds.length === 0) return { empty: true }
  if (categoryIds.length === 0) return { empty: false }
  const seen = new Set<string>()
  const filters: { siteId: string; categoryId: string }[] = []
  for (const categoryId of categoryIds) {
    // 选中的是父分类时，把它下面各级子分类的绑定一起算进来
    for (const binding of bindingStore.forCategories(categoryStore.subtreeIds(categoryId))) {
      const key = `${binding.siteId}\u0000${binding.sourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      filters.push({ siteId: binding.siteId, categoryId: binding.sourceId })
    }
  }
  return { filters, empty: filters.length === 0 }
}

/**
 * 给视频行补齐列表侧信息：绑定后的本地分类路径、可推荐的一级分类、
 * 是否在首页海报 / 分类推荐 / 搜索推荐里。控制台「视频」页与搜索页在线结果共用。
 * 都是按本页的 id 批量查，多查几条 SELECT，不影响主查询。
 */
function enrichVideoItems(items: VideoListItem[]): VideoListItem[] {
  if (items.length === 0) return items
  // 列表要显示「绑定后类型」：把本页视频各来源的在线分类映射成本地分类路径
  const bindingPaths = new Map(
    bindingStore
      .pathsForSourceCategories()
      .map((row) => [`${row.siteId}\u0000${row.sourceCategoryId}`, row.categoryPath])
  )
  const byVideo = new Map<number, string[]>()
  for (const source of videoStore.listSourceCategories(items.map((item) => item.id))) {
    const path = bindingPaths.get(`${source.siteId}\u0000${source.categoryId}`)
    if (!path) continue
    const paths = byVideo.get(source.videoId) ?? []
    if (!paths.includes(path)) paths.push(path)
    byVideo.set(source.videoId, paths)
  }

  // 首页状态：已加进海报 / 已推荐到哪些分类，视频列表直接显示出来，不用再点开看
  const homeConfig = homeStore.get()
  // 推荐只能进视频绑定的大类，弹窗按这个列表给可选目标
  const boundTops = boundTopCategoriesByVideo(items.map((item) => item.id))
  const posterIds = new Set(homeConfig.posters.map((poster) => poster.videoId))
  // 搜索页底部的推荐位没有分类，人工加进来的单独标一下
  const searchRecommendIds = new Set(
    homeConfig.search.items
      .filter((item) => item.pinned && !item.removed)
      .map((item) => item.videoId)
  )
  const categoryNames = new Map(
    categoryStore.list().map((category) => [category.id, category.name])
  )
  const sectionsByVideo = new Map<number, { categoryId: string; title: string }[]>()
  for (const section of homeConfig.sections) {
    const title = section.title || categoryNames.get(section.categoryId) || ''
    for (const item of section.items) {
      // 只有人工指定的才算「推荐」：latest 里自动出现的条目即使被改过图 / 隐藏也不打这个标
      if (item.removed || !item.pinned) continue
      const list = sectionsByVideo.get(item.videoId) ?? []
      if (!list.some((entry) => entry.categoryId === section.categoryId)) {
        list.push({ categoryId: section.categoryId, title })
      }
      sectionsByVideo.set(item.videoId, list)
    }
  }

  return items.map((item) => ({
    ...item,
    localCategoryPaths: (byVideo.get(item.id) ?? []).sort((left, right) =>
      left.localeCompare(right, 'zh-Hans-CN')
    ),
    boundCategoryIds: boundTops.get(item.id) ?? [],
    inPoster: posterIds.has(item.id),
    homeSections: sectionsByVideo.get(item.id) ?? [],
    inSearch: searchRecommendIds.has(item.id)
  }))
}

ipcMain.handle('videos:list', (_event, query: VideoListQuery) => {
  if (!videoCacheReady) return { ...cacheUnavailable(), items: [], total: 0, page: 1, pageSize: 10 }
  const { filters, empty } = resolveVideoFilters(query)
  if (empty) return { ok: true, items: [], total: 0, page: 1, pageSize: 10 }
  const result = videoStore.listVideos(query ?? {}, filters)
  if (!result.ok || result.items.length === 0) return result
  return { ...result, items: enrichVideoItems(result.items) }
})

ipcMain.handle('videos:count', (_event, query: VideoListQuery) => {
  if (!videoCacheReady) return { ...cacheUnavailable(), total: 0 }
  const { filters, empty } = resolveVideoFilters(query)
  if (empty) return { ok: true, total: 0 }
  return { ok: true, total: videoStore.countVideos(query ?? {}, filters) }
})

ipcMain.handle('videos:update', (_event, videoId: number, patch: VideoUpdateInput) => {
  if (!videoCacheReady) return { ok: false, error: 'DB' }
  const result = videoStore.updateVideo(Number(videoId), patch ?? {})
  // 隐藏 / 换封面 / 改文案都会改变推荐页上的卡片，展示端缓存作废
  invalidateHomeFeed()
  return result
})

ipcMain.handle(
  'videos:detail',
  async (_event, videoId: number, options?: { autoFetch?: boolean }) => {
    if (!videoCacheReady) return cacheUnavailable()
    return detailCache.read(Number(videoId), options?.autoFetch !== false)
  }
)

ipcMain.handle(
  'videos:detail:refresh',
  async (_event, videoId: number, options?: { force?: boolean }) => {
    if (!videoCacheReady) return { ...cacheUnavailable(), refreshed: 0, failed: 0 }
    return detailCache.refresh(Number(videoId), Boolean(options?.force))
  }
)

ipcMain.handle('videos:stats', () => {
  if (!videoCacheReady) return { videoCount: 0, sourceCount: 0, lastCollectedAt: '' }
  return videoStore.stats()
})

ipcMain.handle('videos:capacity', (_event, options?: { sites?: boolean }) => {
  if (!videoCacheReady) {
    return {
      dbBytes: 0,
      dbFileBytes: 0,
      walBytes: 0,
      shmBytes: 0,
      videoCount: 0,
      sourceCount: 0,
      detailCount: 0,
      detailBytes: 0,
      logCount: 0,
      siteCount: 0,
      orphanCount: 0,
      lastCollectedAt: '',
      sites: []
    }
  }
  // 概览只要总量，传 { sites: false } 跳过分站统计（十几万条来源要 100ms 上下）
  const withSites = options?.sites !== false
  return videoStore.capacity(withSites ? siteNameMap() : undefined, withSites)
})

ipcMain.handle('videos:capacity:scan', async (_event, options?: { fixMissing?: boolean }) => {
  if (!videoCacheReady) return { ...cacheUnavailable(), drift: null }
  const drift = await detailCache.scan(Boolean(options?.fixMissing))
  return { ...videoStore.capacity(siteNameMap()), drift }
})

/**
 * 容量页的「清理无来源视频」：正常流程（删站点 / 全量替换 / 采集重算）都不会留下这种行，
 * 只有旧版本、中断或手工改库才会出现。一次事务删完，数量很少，所以直接同步返回。
 */
ipcMain.handle('videos:orphans:clear', () => {
  if (!videoCacheReady) return { ...cacheUnavailable(), videos: 0, edits: 0 }
  const result = videoStore.purgeOrphanVideos()
  if (result.videos > 0) invalidateHomeFeed()
  return { ok: true, ...result }
})

ipcMain.handle('videos:details:clear', async (_event, options?: { siteId?: string }) => {
  if (!videoCacheReady) return cacheUnavailable()
  return detailCache.clear(options?.siteId ? String(options.siteId) : undefined)
})

/**
 * 控制台「封面」分区的批量同步：把已有 videos.pic 按选定来源重写一遍。
 * 单次运行；进度推给发起的渲染进程（节流，完成那条不丢），取消在批次边界生效。
 * 状态同时保存在主进程里，页面切走再回来可以回填，不会出现「按钮点不动」。
 */
let picsCleanRunning = false
let picsCleanCancelled = false
let picsCleanSiteId = ''
let picsCleanStartedAt = ''
let picsCleanProgress: PicCleanProgress | null = null
let picsCleanLast: PicCleanOutcome | null = null

/** 当前选中的来源：传了就用传的（页面可以先预览未保存的来源），失效 id 回落到主来源 */
function resolvePicRuleSite(requested?: string): string {
  const siteId = (requested ?? appSettingsStore.get().defaultPicSiteId).trim()
  if (siteId && siteStore.list().some((site) => site.id === siteId)) return siteId
  return ''
}

ipcMain.handle('videos:pics:clean', async (event, input?: { siteId?: string }) => {
  if (!videoCacheReady) {
    return {
      ok: false,
      error: 'CACHE_UNAVAILABLE',
      total: 0,
      changed: 0,
      skipped: 0,
      cancelled: false
    }
  }
  if (picsCleanRunning) {
    return {
      ok: false,
      error: 'ALREADY_RUNNING',
      total: 0,
      changed: 0,
      skipped: 0,
      cancelled: false
    }
  }
  const siteId = resolvePicRuleSite(input?.siteId)
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  picsCleanRunning = true
  picsCleanCancelled = false
  picsCleanSiteId = siteId
  picsCleanStartedAt = startedAt
  picsCleanProgress = { processed: 0, total: 0, changed: 0, skipped: 0, percent: 0 }
  picsCleanLast = null
  let lastReport = 0
  try {
    const result = await videoStore.cleanPics(
      siteId,
      (progress) => {
        picsCleanProgress = progress
        const now = Date.now()
        if (progress.percent < 100 && now - lastReport < 100) return
        lastReport = now
        if (!event.sender.isDestroyed()) event.sender.send('videos:pics:clean:progress', progress)
      },
      () => picsCleanCancelled
    )
    picsCleanLast = {
      ...result,
      siteId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs
    }
    if (result.changed > 0 || result.cancelled) invalidateHomeFeed()
    return result
  } catch (error) {
    console.error('同步封面失败', error)
    return { ok: false, error: 'DB', total: 0, changed: 0, skipped: 0, cancelled: false }
  } finally {
    picsCleanRunning = false
    picsCleanCancelled = false
    picsCleanProgress = null
  }
})

ipcMain.handle('videos:pics:clean:status', (): PicCleanStatus => {
  return {
    ok: true,
    running: picsCleanRunning,
    cancelling: picsCleanCancelled,
    progress: picsCleanProgress,
    siteId: picsCleanSiteId,
    startedAt: picsCleanStartedAt,
    lastResult: picsCleanLast
  }
})

ipcMain.handle('videos:pics:clean:cancel', () => {
  picsCleanCancelled = true
})

/**
 * 封面规则统计 + 效果抽样。规则统计扫全库（11 万部约 260ms），按来源缓存 30s；
 * 抽样每次重算（随机换一批），所以「换一批」不需要再等一次全库统计。
 */
ipcMain.handle('videos:pics:stats', (_event, options?: { siteId?: string }): PicCleanStats => {
  if (!videoCacheReady) {
    return {
      ok: false,
      error: 'CACHE_UNAVAILABLE',
      siteId: '',
      total: 0,
      covered: 0,
      stale: 0,
      empty: 0,
      manual: 0,
      sites: [],
      samples: []
    }
  }
  try {
    const siteId = resolvePicRuleSite(options?.siteId)
    const cache = picCountsCache
    const hit = cache && cache.key === siteId && Date.now() - cache.at < 30_000 ? cache : null
    const counts = hit ? hit.counts : videoStore.picStats(siteId)
    if (!hit) picCountsCache = { key: siteId, at: Date.now(), counts }
    return { ok: true, siteId, ...counts, samples: videoStore.picSamples(siteId) }
  } catch (error) {
    console.error('读取封面统计失败', error)
    return {
      ok: false,
      error: 'DB',
      siteId: '',
      total: 0,
      covered: 0,
      stale: 0,
      empty: 0,
      manual: 0,
      sites: [],
      samples: []
    }
  }
})

/**
 * 容量页「删除站点数据」：这个站点的来源、只属于它的视频（连人工编辑）、详情文件、
 * 采集进度与采集日志一次清掉。站点本身、在线 / 本地分类、绑定与定时计划在业务库里，不动。
 * 走和改地址 / 删站点同一条清理队列（按站点串行），所以采集器入队时也能等到它删完。
 */
ipcMain.handle(
  'videos:site:purge',
  async (_event, input?: { siteId?: string }): Promise<VideoSitePurgeResult> => {
    const empty: VideoSitePurgeResult = {
      ok: false,
      sources: 0,
      videos: 0,
      shared: 0,
      detailCount: 0,
      detailBytes: 0,
      logs: 0
    }
    if (!videoCacheReady) return { ...empty, error: 'CACHE_UNAVAILABLE' }
    const siteId = String(input?.siteId ?? '').trim()
    if (!siteId) return { ...empty, error: 'INVALID_INPUT' }
    // 先量好这个站点的详情体积，删完就查不到了
    const before = videoStore.capacity(siteNameMap()).sites.find((row) => row.siteId === siteId)
    const removed = await scheduleSiteCachePurge(siteId)
    if (!removed) return { ...empty, error: 'DB' }
    const logs = collectLogs.clear(siteId)
    return {
      ok: true,
      sources: removed.sources,
      videos: removed.videos,
      shared: removed.shared,
      detailCount: before?.detailCount ?? 0,
      detailBytes: before?.detailBytes ?? 0,
      logs
    }
  }
)

ipcMain.handle('videos:progress', (_event, siteId?: string) => {
  if (!videoCacheReady) return []
  return videoStore.listProgress(siteId ? String(siteId) : undefined)
})

/**
 * 一键清空采集进度：只在没有任务在跑 / 排队时允许。
 * 检索关键词跟着进度一起清，已采集的视频、详情、日志都不动。
 */
ipcMain.handle('videos:progress:clear', () => {
  if (!videoCacheReady) return { ok: false, error: 'CACHE_UNAVAILABLE' }
  const busy = videoStore
    .listProgress()
    .some(
      (row) => row.status === 'queued' || row.status === 'running' || row.status === 'replacing'
    )
  if (busy) return { ok: false, error: 'BUSY' }
  return { ok: true, removed: videoStore.clearProgress() }
})

/* ── 在线检索（展示端搜索页的「在线」模式） ── */

/**
 * 在线检索的请求地址：`ac=detail&wd=<词>&pg=N&pagesize=N`。
 * 站点地址里残留的 ids / h 会让结果跑偏，这里一并去掉。
 */
function buildOnlineSearchUrl(site: Site, keyword: string, page: number, pageSize: number): string {
  const url = new URL(site.address)
  url.searchParams.set('ac', 'detail')
  url.searchParams.set('wd', keyword)
  url.searchParams.set('pg', String(page))
  url.searchParams.set('pagesize', String(Math.min(Math.max(pageSize, 1), 100)))
  url.searchParams.delete('ids')
  url.searchParams.delete('h')
  if (site.format === 'xml') url.searchParams.set('at', 'xml')
  else url.searchParams.delete('at')
  return url.toString()
}

/** 单站点的在线检索请求：交互式检索最多等 12s、重试 1 次，别让慢站点拖住整页结果 */
async function fetchOnlineSearchPage(
  site: Site,
  keyword: string
): Promise<{ ok: true; page: CollectedPage } | { ok: false; error: string }> {
  const response = await fetchCollectText(
    buildOnlineSearchUrl(site, keyword, 1, ONLINE_SEARCH_PAGE_SIZE),
    undefined,
    { timeoutMs: 12000, retries: 1 }
  )
  if (!response.ok) {
    return {
      ok: false,
      error: response.error === 'HTTP' ? `HTTP_${response.status ?? 0}` : 'NETWORK'
    }
  }
  try {
    return { ok: true, page: parseCollectPage(response.text, site.format) }
  } catch (error) {
    return { ok: false, error: String((error as { code?: string })?.code ?? 'PARSE') }
  }
}

/** 一个站点的在线检索结果：写入缓存（合并靠 writePage 的 name_key）并落详情文件 */
async function searchOneSite(
  site: Site,
  keyword: string
): Promise<{ summary: VideoOnlineSearchSite; videoIds: number[]; pageSize: number }> {
  const fetched = await fetchOnlineSearchPage(site, keyword)
  if (!fetched.ok) {
    return {
      summary: {
        siteId: site.id,
        ok: false,
        count: 0,
        recordCount: 0,
        error: fetched.error
      },
      videoIds: [],
      pageSize: 0
    }
  }
  const page = fetched.page
  try {
    const write = videoStore.writePage(site.id, page.items, '', false)
    if (write.sourceIds.length > 0) {
      // 整页就是 ac=detail：简介 / 播放线路直接落成详情文件，点开播放页不用再等一次请求
      const itemsById = new Map(page.items.map((entry) => [entry.sourceVideoId, entry]))
      const sources = write.sourceIds
        .map((id) => videoStore.getDetailSource(id))
        .filter((row): row is DetailSourceRow => row !== null)
      await detailCache.warmFromPage(sources, itemsById).catch(() => {})
    }
    return {
      summary: {
        siteId: site.id,
        ok: true,
        count: write.fetched,
        recordCount: page.recordCount
      },
      videoIds: write.videoIds,
      pageSize: page.pageSize
    }
  } catch {
    return {
      summary: { siteId: site.id, ok: false, count: 0, recordCount: 0, error: 'DB' },
      videoIds: [],
      pageSize: 0
    }
  }
}

/** 在线结果最多展示这么多条（每站 20 条，站点多时也得限一下） */
const ONLINE_RESULT_LIMIT = 200

/**
 * 展示端搜索页「在线」模式：
 * 1. 只向开启了「支持在线检索」的站点发 `wd` 检索，每个站点取第 1 页（20 条）；
 * 2. 写进缓存库（writePage 按 name_key 合并跨站同名视频），再回读合并后的行；
 * 3. 过滤隐藏、按相关性排序后返回（最多 200 条）；
 * 4. 顺手把关键词追加到各站点的「检索」采集任务，后台继续把该词采完（每词最多 200 条）。
 */
async function performOnlineSearch(input?: { keyword?: string }): Promise<VideoOnlineSearchResult> {
  const keyword = String(input?.keyword ?? '')
    .trim()
    .slice(0, 60)
  const empty: VideoOnlineSearchResult = {
    ok: true,
    keyword,
    siteCount: 0,
    items: [],
    total: 0,
    truncated: false,
    sites: [],
    queued: 0
  }
  if (!videoCacheReady) return { ...empty, ok: false, error: 'CACHE_UNAVAILABLE' }
  if (!keyword) return empty
  // 正在后台清理缓存的站点先跳过：刚写进去的来源会被清理一起删掉；禁用的站点也不问
  const sites = siteStore
    .list()
    .filter((site) => site.onlineSearch && !site.disabled && !siteCachePurges.has(site.id))
  if (sites.length === 0) return empty

  const results = await Promise.all(sites.map((site) => searchOneSite(site, keyword)))
  const videoIds: number[] = []
  for (const result of results) videoIds.push(...result.videoIds)
  const ids = [...new Set(videoIds)]
  const merged =
    ids.length > 0 ? videoStore.listVideosByIds(ids).filter((item) => !item.hidden) : []
  // 相关性：精确 > 前缀 > 包含，其次多站合并（来源越多越可信）、片名更短、更新时间更新
  merged.sort((left, right) => {
    const byRank = nameMatchRank(left.name, keyword) - nameMatchRank(right.name, keyword)
    if (byRank !== 0) return byRank
    if (left.sourceCount !== right.sourceCount) return right.sourceCount - left.sourceCount
    if (left.name.length !== right.name.length) return left.name.length - right.name.length
    if (left.latestTs !== right.latestTs) return right.latestTs - left.latestTs
    return left.id - right.id
  })
  const items = enrichVideoItems(merged.slice(0, ONLINE_RESULT_LIMIT))

  // 后台检索任务：带上响应里的真实页大小，省掉一次探测请求
  let queued = 0
  for (const result of results) {
    if (!result.summary.ok) continue
    const enqueued = await collector.enqueue(
      {
        siteId: result.summary.siteId,
        mode: 'search',
        fetchRange: 'all',
        words: [keyword],
        cacheDetail: true,
        pageSize: result.pageSize || undefined
      },
      'manual'
    )
    if (enqueued.ok) queued += 1
  }
  // 在线检索会往库里写新视频，推荐页缓存作废
  invalidateHomeFeed()
  return {
    ok: true,
    keyword,
    siteCount: sites.length,
    items,
    total: merged.length,
    truncated: merged.length > items.length,
    sites: results.map((result) => result.summary),
    queued
  }
}

ipcMain.handle('videos:search:online', (_event, input?: { keyword?: string }) =>
  performOnlineSearch(input)
)

/* ── 局域网影院（网页端 + HTTP 服务） ── */

/** 网页端只需要列表卡片字段，不要把控制台用的推荐 / 编辑状态一起带出去 */
function toLanCard(item: VideoListItem): LanVideoCard {
  return {
    id: item.id,
    name: item.name,
    pic: item.pic,
    picCandidates: item.picCandidates,
    note: item.note,
    intro: item.introExcerpt,
    sourceCount: item.sourceCount,
    vodClass: item.vodClass,
    vodActor: item.vodActor,
    latestTime: item.latestTime
  }
}

function lanSearchLocal(keyword: string, page: number, pageSize: number): LanSearchPayload {
  const base: LanSearchPayload = {
    ok: true,
    mode: 'local',
    keyword,
    items: [],
    total: 0,
    page,
    pageSize
  }
  if (!videoCacheReady) return { ...base, ok: false, error: 'CACHE_UNAVAILABLE' }
  const result = videoStore.listVideos({ keyword, page, pageSize, visibility: 'shown' })
  return {
    ...base,
    ok: result.ok,
    error: result.error,
    items: result.items.map(toLanCard),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize
  }
}

function lanLatest(page: number, pageSize: number): LanLatestPayload {
  if (!videoCacheReady) {
    return { ok: false, error: 'CACHE_UNAVAILABLE', items: [], page, pageSize }
  }
  const result = videoStore.listVideos({ page, pageSize, visibility: 'shown', withTotal: false })
  return {
    ok: result.ok,
    error: result.error,
    items: result.items.map(toLanCard),
    page: result.page,
    pageSize: result.pageSize
  }
}

/**
 * 展示端可见的分类：自身开关打开，且所有上级都打开。
 * 与渲染层 `lib/category-tree.ts` 的 `visibleCategoryIds` 同一套口径
 * （主进程不能 import 渲染层代码，所以这里保留一份）。
 */
function lanVisibleCategoryIds(rows: VideoCategory[]): Set<string> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const visible = new Set<string>()
  for (const row of rows) {
    const chain: string[] = []
    const seen = new Set<string>()
    let cursor: VideoCategory | undefined = row
    let ok = true
    while (cursor) {
      if (seen.has(cursor.id)) {
        ok = false
        break
      }
      seen.add(cursor.id)
      if (!cursor.visible) {
        ok = false
        break
      }
      chain.push(cursor.id)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    if (ok) for (const id of chain) visible.add(id)
  }
  return visible
}

/** 找片看：只把展示端可见的分类给网页，隐藏的父分类连同整棵子树一起不返回 */
function lanCategories(): LanCategoriesPayload {
  const rows = categoryStore.list()
  const visible = lanVisibleCategoryIds(rows)
  const categories: LanCategory[] = rows
    .filter((row) => visible.has(row.id))
    .map((row) => ({
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      sortOrder: row.sortOrder
    }))
  return { ok: true, categories }
}

/**
 * 找片看列表：空分类 = 所有可见一级分类的并集（和展示端列表页「全部」一致，
 * 只绑在隐藏分类里的视频不会漏出来）；指定分类时按它的整棵子树过滤。
 * 不统计总数：全库统计一次要一百多毫秒，翻到底用「这一页不满」判断。
 */
function lanBrowse(query: LanBrowseQuery): LanBrowsePayload {
  const base: LanBrowsePayload = {
    ok: true,
    items: [],
    page: query.page,
    pageSize: query.pageSize,
    categoryId: query.categoryId
  }
  if (!videoCacheReady) return { ...base, ok: false, error: 'CACHE_UNAVAILABLE' }
  const rows = categoryStore.list()
  const visible = lanVisibleCategoryIds(rows)

  let listQuery: VideoListQuery
  if (query.categoryId) {
    // 隐藏 / 已删除的分类返回空列表，不退回全库
    if (!visible.has(query.categoryId)) return base
    listQuery = {
      categoryId: query.categoryId,
      page: query.page,
      pageSize: query.pageSize,
      visibility: 'shown',
      withTotal: false
    }
  } else {
    const topIds = rows
      .filter((row) => row.parentId === null && visible.has(row.id))
      .map((row) => row.id)
    // 没有可见分类：和显式空数组一样直接空结果，不能退化成查全库
    if (topIds.length === 0) return base
    listQuery = {
      categoryIds: topIds,
      page: query.page,
      pageSize: query.pageSize,
      visibility: 'shown',
      withTotal: false
    }
  }

  const { filters, empty } = resolveVideoFilters(listQuery)
  if (empty) return base
  const result = videoStore.listVideos(listQuery, filters)
  return {
    ok: result.ok,
    error: result.error,
    items: result.items.map(toLanCard),
    page: result.page,
    pageSize: result.pageSize,
    categoryId: query.categoryId
  }
}

async function lanSearchOnline(keyword: string): Promise<LanSearchPayload> {
  const result = await performOnlineSearch({ keyword })
  const names = siteNameMap()
  return {
    ok: result.ok,
    error: result.error,
    mode: 'online',
    keyword: result.keyword,
    items: result.items.map(toLanCard),
    total: result.total,
    page: 1,
    pageSize: result.items.length,
    truncated: result.truncated,
    siteCount: result.siteCount,
    sites: result.sites.map((site) => ({
      siteId: site.siteId,
      siteName: names.get(site.siteId) ?? '',
      ok: site.ok,
      count: site.count,
      recordCount: site.recordCount,
      error: site.error
    })),
    queued: result.queued
  }
}

/** 网页播放页的详情：只保留 m3u8 线路与展示字段（和桌面播放页一致，直链 / 分享页在浏览器里放不了） */
async function lanVideoDetail(videoId: number): Promise<LanDetailPayload> {
  if (!videoCacheReady) return { ok: false, error: 'CACHE_UNAVAILABLE' }
  try {
    const result = await detailCache.read(videoId, true)
    if (!result.ok || !result.video) {
      return { ok: false, error: result.error ?? 'NOT_FOUND' }
    }
    const video = result.video
    const primary = video.sources.find((source) => source.detail)?.detail
    const sources = video.sources
      .map((source) => ({
        id: source.id,
        siteName: source.siteName,
        lines: (source.detail?.playLines ?? [])
          .map((line) => ({
            flag: line.flag.trim(),
            episodes: line.episodes
              .map((episode) => ({ name: episode.name.trim(), url: episode.url.trim() }))
              // 只要 m3u8：mp4 / flv / 分享页这类直链不在浏览器播放器里出现
              .filter((episode) => isHlsUrl(episode.url))
              .map((episode) => ({
                name: episode.name,
                url: episode.url,
                kind: 'hls' as const
              }))
          }))
          .filter((line) => line.episodes.length > 0)
      }))
      .filter((source) => source.lines.length > 0)
    return {
      ok: true,
      video: {
        id: video.id,
        name: video.name,
        pic: video.pic,
        picCandidates: video.picCandidates,
        note: video.note,
        intro: primary?.intro || video.introExcerpt,
        vodActor: video.vodActor,
        vodClass: video.vodClass,
        year: primary?.year ?? '',
        area: primary?.area ?? '',
        // 只数真正有 m3u8 线路的来源，和线路面板一致
        sourceCount: sources.length,
        sources
      }
    }
  } catch {
    return { ok: false, error: 'DETAIL_FAILED' }
  }
}

const lanService = createLanService({
  dataDir: join(app.getPath('userData'), 'Data'),
  fetch: (url, init) => net.fetch(url, init),
  deps: {
    searchLocal: lanSearchLocal,
    searchOnline: lanSearchOnline,
    latest: lanLatest,
    categories: lanCategories,
    browse: lanBrowse,
    detail: lanVideoDetail,
    onChange: (state) => sendToRenderer('lan:changed', state)
  }
})

/**
 * 该站点历史任务已经确认过的真实每页条数：同模式 + 同采集方式优先，
 * 其次取最近一条有值的记录（listProgress 已按 updated_at 倒序）。
 * 有历史值就不再联网探测；清空缓存会连带清掉进度，之后才会重新探测。
 */
function knownPageSize(siteId: string, mode?: CollectMode, fetchRange?: FetchRange): number {
  if (!videoCacheReady || !siteId) return 0
  const rows = videoStore.listProgress(siteId)
  const exact = rows.find(
    (row) => row.mode === mode && row.fetchRange === fetchRange && row.pageSize > 0
  )
  if (exact) return exact.pageSize
  return rows.find((row) => row.pageSize > 0)?.pageSize ?? 0
}

ipcMain.handle('videos:collect:start', async (_event, input: VideoCollectStartInput) => {
  if (!videoCacheReady) return cacheUnavailable()
  const siteId = String(input?.siteId ?? '').trim()
  const isSearch = input?.mode === 'search'
  // 禁用的站点不再采集：手动 / 检索 / 定时都不入队（缓存数据保留，重新启用即可恢复）
  if (siteStore.list().find((site) => site.id === siteId)?.disabled) {
    return { ok: false, error: 'SITE_DISABLED' }
  }
  // 同一模式与方式已经在跑 / 排队时不用探测；检索走的是追加关键词，也不探测
  const range = input?.mode === 'full' || isSearch ? 'all' : input?.fetchRange
  const live = videoStore
    .listProgress(siteId)
    .some(
      (row) =>
        row.mode === input?.mode &&
        row.fetchRange === range &&
        (row.status === 'queued' || row.status === 'running' || row.status === 'replacing')
    )
  let pageSize = clampPageSize(input?.pageSize)
  if (!pageSize && !live && !isSearch) {
    // 历史任务用过真实页大小就直接复用，只有完全没记录时才试抓一页
    pageSize = knownPageSize(siteId, input?.mode, range)
    if (!pageSize) {
      const site = siteStore.list().find((item) => item.id === siteId)
      if (site) pageSize = (await probePageSize(site)).pageSize
    }
  }
  // 检索：历史值优先，没有就按默认 100；首屏响应里的 pagesize 会自愈，不必联网探测
  if (isSearch && !pageSize) pageSize = knownPageSize(siteId, 'search', 'all') || DEFAULT_PAGE_SIZE
  return collector.enqueue({ ...input, pageSize: pageSize || undefined }, 'manual')
})

ipcMain.handle(
  'videos:collect:cancel',
  (
    _event,
    input: {
      siteId: string
      mode?: VideoCollectStartInput['mode']
      fetchRange?: VideoCollectStartInput['fetchRange']
    }
  ) => {
    if (!videoCacheReady) return { ok: false, error: 'CACHE_UNAVAILABLE' }
    return collector.cancel(input)
  }
)

ipcMain.handle('videos:schedules:list', () => {
  if (!videoCacheReady) return { ...cacheUnavailable(), schedules: [] }
  return { ok: true, schedules: scheduleStore.list() }
})

ipcMain.handle('videos:schedules:save', async (_event, input: VideoScheduleInput) => {
  if (!videoCacheReady) return cacheUnavailable()
  const siteId = String(input?.siteId ?? '').trim()
  const existing = siteId ? scheduleStore.get(siteId) : null
  const site = siteId ? siteStore.list().find((item) => item.id === siteId) : undefined
  // 计划里存过、或该站历史任务确认过真实页大小就直接用；都没有才试抓一页（关闭计划不联网）
  let pageSize = existing?.pageSize || knownPageSize(siteId, input?.mode, input?.fetchRange) || 0
  if (!pageSize && site && input?.enabled) pageSize = (await probePageSize(site)).pageSize
  return scheduleStore.save({ ...input, pageSize })
})

ipcMain.handle('videos:schedules:remove', (_event, siteId: string) => {
  if (!videoCacheReady) return { ok: false, error: 'CACHE_UNAVAILABLE' }
  return { ok: scheduleStore.remove(String(siteId)) }
})

ipcMain.handle(
  'videos:logs:list',
  (
    _event,
    query?: {
      siteId?: string
      level?: 'info' | 'warn' | 'error'
      since?: string
      order?: 'newest' | 'oldest'
      limit?: number
    }
  ) => {
    if (!videoCacheReady) return { ok: false, logs: [], error: 'CACHE_UNAVAILABLE' }
    // 日志是异步批量落库的，读之前先落完队列，避免刚发生的告警读不到
    collectLogs.flush()
    return { ok: true, logs: collectLogs.list(query ?? {}) }
  }
)

ipcMain.handle('videos:logs:clear', (_event, options?: { siteId?: string }) => {
  if (!videoCacheReady) return { ok: false }
  return {
    ok: true,
    removed: collectLogs.clear(options?.siteId ? String(options.siteId) : undefined)
  }
})

ipcMain.handle('videos:clear', async () => {
  if (!videoCacheReady) return cacheUnavailable()
  collector.suspend()
  scheduler.stop()
  await collector.cancelAll()
  // 有站点正在后台清理时先等它删完，否则它会在重建之后再去删一遍详情目录
  await waitSiteCachePurge()
  // 只为了算「释放了多少」，不需要按站点分组
  const before = videoStore.capacity(undefined, false)
  try {
    await detailCache.removeAll()
    await videoStore.rebuild()
    videoCacheReady = true
  } catch {
    videoCacheReady = false
    return { ok: false, error: 'DB' }
  }
  videoCacheReady = true
  // 清空缓存的语义是整个缓存库重建：队列里还没落库的日志一并丢弃
  collectLogs.clear()
  // 推荐配置（海报 / 分类轨道 / 搜索推荐）里的条目全指向刚删掉的视频，
  // 留着只会是一片「视频已丢失」，所以跟着一起清空（自定义图片也删）
  homeStore.clear()
  collector.resume()
  scheduler.start()
  // 缓存库整体重建，推荐页的卡片全部作废
  invalidateHomeFeed()
  return { ok: true, freedBytes: before.dbBytes + before.detailBytes }
})

/* ── IPC：采集站点 ── */

ipcMain.handle('sites:list', () => siteStore.list())

ipcMain.handle('sites:add', (_event, input: SiteInput) => {
  const result = siteStore.add(input)
  if (result.ok) refreshDisabledSites()
  return result
})

ipcMain.handle('sites:update', (_event, id: string, input: SiteInput) => {
  const siteId = String(id)
  // 地址 / 格式可能变化，之前抓取的待确认结果随之作废
  pendingCategoryRefresh.delete(siteId)
  const existing = siteStore.list().find((item) => item.id === siteId) ?? null
  const result = siteStore.update(siteId, input)
  if (!result.ok || !existing) return result

  const addressChanged = existing.address !== result.site.address
  const formatChanged = existing.format !== result.site.format
  // 地址一变，正在跑的那次采集就该停在断点：新地址返回的页混进同一次全量替换会缺页
  if (addressChanged || formatChanged) collector.cancel({ siteId })
  // 关掉「支持在线检索」就不再跑这个站点的检索任务（已经采到的视频和关键词记录保留）
  if (existing.onlineSearch && !result.site.onlineSearch) {
    collector.cancel({ siteId, mode: 'search' })
  }
  // 刚被禁用：该站点在跑 / 排队的采集都停掉；视频数据保留，重新启用即可恢复
  if (!existing.disabled && result.site.disabled) collector.cancel({ siteId })
  // 禁用状态影响列表 / 搜索 / 首页能查到哪些视频，同步给缓存库并作废 feed 缓存
  refreshDisabledSites()
  // 只有真的换了站点（域名 / 格式变了）旧缓存才不可信。同一个 domain 下改路径、补斜杠
  // 通常只是笔误，为此把几万条来源和详情文件全清掉不值当；清理本身也放到后台，不堵保存。
  if (formatChanged || !isSameSiteHost(existing.address, result.site.address)) {
    // 先同步作废推荐页那份缓存：清理是异步的，别让接下来的 home:get 还拿到旧 feed
    invalidateHomeFeed()
    void scheduleSiteCachePurge(siteId)
  }
  return result
})

ipcMain.handle('sites:remove', (_event, id: string) => {
  const siteId = String(id)
  pendingCategoryRefresh.delete(siteId)
  const result = siteStore.remove(siteId)
  if (result.ok) {
    // 先把正在跑的采集停在断点（同步），再让后台清理去删数据，避免多写进来一页
    collector.cancel({ siteId })
    // collect_schedules 由业务库外键级联删除
    scheduleStore.remove(siteId)
    // 站点的绑定被级联删掉了，推荐要按剩下的绑定重算
    syncHomeRecommendations()
    refreshDisabledSites()
    // 默认 pic 来源指向这个站点时清掉配置，别留下悬空 id
    if (appSettingsStore.get().defaultPicSiteId === siteId) {
      appSettingsStore.setDefaultPicSite('')
    }
    // 站点缓存与详情目录在后台清，几万条来源时不拖住删除操作
    void scheduleSiteCachePurge(siteId)
  }
  return result
})

/**
 * 站点在线检索自检（控制台「站点」卡片上的搜索图标）：真实发一次 `wd` 请求，
 * 只解析、**不写缓存库**，用来判断这个站点的采集接口到底支不支持按片名检索。
 * 老部署会静默忽略 `wd` 仍返回整页数据，所以除了「有没有结果」，还要看结果里
 * 有没有片名真的包含关键词：一条都没有基本就是参数没生效。
 */
ipcMain.handle(
  'sites:search:test',
  async (_event, input?: { siteId?: string; keyword?: string }): Promise<SiteSearchTestResult> => {
    const site = siteStore.list().find((row) => row.id === String(input?.siteId ?? '').trim())
    const keyword = String(input?.keyword ?? '')
      .trim()
      .slice(0, 60)
    const base: SiteSearchTestResult = {
      ok: false,
      siteId: site?.id ?? '',
      keyword,
      url: '',
      elapsedMs: 0,
      status: 0,
      recordCount: 0,
      pageCount: 0,
      pageSize: 0,
      count: 0,
      matched: 0,
      items: [],
      verdict: 'failed',
      message: ''
    }
    if (!site) return { ...base, error: 'NOT_FOUND', message: '站点不存在，可能已被删除' }
    if (!keyword) return { ...base, error: 'INVALID_INPUT', message: '请先填写要测试的片名' }

    const url = buildOnlineSearchUrl(site, keyword, 1, ONLINE_SEARCH_PAGE_SIZE)
    const startedAt = Date.now()
    const response = await fetchCollectText(url, undefined, { timeoutMs: 12000, retries: 1 })
    const elapsedMs = Date.now() - startedAt
    if (!response.ok) {
      const error = response.error === 'HTTP' ? `HTTP_${response.status ?? 0}` : 'NETWORK'
      return {
        ...base,
        siteId: site.id,
        url,
        elapsedMs,
        status: response.status ?? 0,
        error,
        message:
          error === 'NETWORK'
            ? '请求失败：连不上站点（网络 / 地址不可达）'
            : `请求失败：站点返回 ${error}`
      }
    }

    let page: CollectedPage
    try {
      page = parseCollectPage(response.text, site.format)
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? 'PARSE')
      const message =
        code === 'CLOSED'
          ? '站点采集接口已关闭（返回 closed）'
          : code === 'AUTH'
            ? '站点要求鉴权（多半是 IP 白名单）'
            : '返回内容无法解析，确认采集格式是否选对'
      return {
        ...base,
        siteId: site.id,
        url,
        elapsedMs,
        status: response.status,
        error: code,
        message
      }
    }

    const key = makeNameKey(keyword)
    const count = page.items.length
    const matched = key
      ? page.items.filter((item) => makeNameKey(item.name).includes(key)).length
      : 0
    const verdict: SiteSearchTestResult['verdict'] =
      count === 0 ? 'empty' : matched > 0 ? 'supported' : 'ignored'
    const message =
      verdict === 'supported'
        ? `接口支持按片名检索：本页 ${count} 条里有 ${matched} 条片名包含「${keyword}」`
        : verdict === 'ignored'
          ? `接口似乎忽略了关键词：返回 ${count} 条，但没有一条片名包含「${keyword}」（多半是不支持检索的老部署）`
          : '本页 0 条：换个更常见的片名再试；如果一直 0 条，接口可能不支持检索'
    return {
      ok: true,
      siteId: site.id,
      keyword,
      url,
      elapsedMs,
      status: response.status,
      recordCount: page.recordCount,
      pageCount: page.pageCount,
      pageSize: page.pageSize,
      count,
      matched,
      items: page.items.slice(0, 10).map((item) => ({
        sourceVideoId: item.sourceVideoId,
        name: item.name,
        note: item.note,
        sourceTime: item.sourceTime
      })),
      verdict,
      message
    }
  }
)

ipcMain.handle('sites:categories', async (_event, id: string) => {
  const site = siteStore.list().find((item) => item.id === String(id))
  if (!site) return { ok: false, error: 'NOT_FOUND' }
  // 已入库的直接读库，不再请求采集站
  const stored = siteStore.listCategories(site.id)
  if (stored.length > 0) return { ok: true, categories: stored }
  const result = await fetchSiteCategories(site)
  if (!result.ok) return result
  // 首次抓取：全量入库后返回带主键与时间戳的数据
  return { ok: true, categories: siteStore.applyCategories(site.id, result.categories, 'full') }
})

ipcMain.handle('sites:categories:refresh', async (_event, id: string) => {
  const site = siteStore.list().find((item) => item.id === String(id))
  if (!site) return { ok: false, error: 'NOT_FOUND' }
  const result = await fetchSiteCategories(site)
  if (!result.ok) return result
  const diff = siteStore.previewCategories(site.id, result.categories)
  const hasChanges = diff.added.length + diff.renamed.length + diff.removed.length > 0
  // 只缓存，等用户确认更新方式后再落库
  pendingCategoryRefresh.set(site.id, { categories: result.categories, at: Date.now() })
  return { ok: true, hasChanges, diff }
})

ipcMain.handle('sites:categories:apply', (_event, id: string, mode: CategoryUpdateMode) => {
  const site = siteStore.list().find((item) => item.id === String(id))
  if (!site) return { ok: false, error: 'NOT_FOUND' }
  if (mode !== 'incremental' && mode !== 'full') return { ok: false, error: 'INVALID_MODE' }
  const pending = pendingCategoryRefresh.get(site.id)
  if (!pending || Date.now() - pending.at > PENDING_CATEGORY_TTL) {
    pendingCategoryRefresh.delete(site.id)
    return { ok: false, error: 'EXPIRED' }
  }
  pendingCategoryRefresh.delete(site.id)
  const categories = siteStore.applyCategories(site.id, pending.categories, mode)
  // 全量更新会删掉线上已不存在的分类，连带删绑定：推荐跟着重算
  if (mode === 'full') syncHomeRecommendations()
  return { ok: true, categories }
})

/* ── IPC：视频分类 ── */

ipcMain.handle('categories:list', () => categoryStore.list())

ipcMain.handle('categories:create', (_event, input: VideoCategoryInput) => {
  const result = categoryStore.create(input)
  // 新分类不代表就有轨道，但「推荐在哪几条轨道上」可能变，缓存一并作废
  invalidateHomeFeed()
  return result
})

ipcMain.handle('categories:update', (_event, id: string, input: VideoCategoryInput) => {
  const result = categoryStore.update(String(id), input)
  // 改了上级分类，视频所属的大类可能跟着变
  if (result.ok && input?.parentId !== undefined) syncHomeRecommendations()
  invalidateHomeFeed()
  return result
})

ipcMain.handle('categories:setVisible', (_event, id: string, visible: boolean) => {
  const result = categoryStore.setVisible(String(id), Boolean(visible))
  // 分类的显示开关决定推荐页有没有这条轨道
  invalidateHomeFeed()
  return result
})

ipcMain.handle(
  'categories:move',
  (_event, id: string, targetId: string | null, placement: CategoryPlacement) => {
    const result = categoryStore.move(
      String(id),
      targetId === null || targetId === undefined ? null : String(targetId),
      placement
    )
    // 拖到别的大类下面（before / after 也可能换了上级），推荐跟着换分类
    if (result.ok) syncHomeRecommendations()
    invalidateHomeFeed()
    return result
  }
)

ipcMain.handle('categories:remove', (_event, id: string) => {
  const result = categoryStore.remove(String(id))
  // 分类删了，绑在它（或子树）上的视频就没有归属了，推荐一并清掉
  if (result.ok) syncHomeRecommendations()
  invalidateHomeFeed()
  return result
})

/* ── IPC：在线分类与本地分类的绑定 ── */

ipcMain.handle('bindings:forSite', (_event, siteId: string) => bindingStore.forSite(String(siteId)))

ipcMain.handle('bindings:forCategory', (_event, categoryId: string) =>
  bindingStore.forCategory(String(categoryId))
)

ipcMain.handle('bindings:counts', () => bindingStore.counts())

ipcMain.handle('bindings:bind', (_event, items: BindingTarget[], categoryId: string) => {
  const result = bindingStore.bind(items, String(categoryId))
  // 绑定关系变了：已推荐到这个在线分类的视频要跟着换大类
  if (result.ok) syncHomeRecommendations()
  invalidateHomeFeed()
  return result
})

ipcMain.handle('bindings:unbind', (_event, items: BindingTarget[]) => {
  const result = bindingStore.unbind(items)
  // 解绑后视频不再属于原来的大类，推荐会被挪到别处或直接删掉
  if (result.ok) syncHomeRecommendations()
  invalidateHomeFeed()
  return result
})

/* ── IPC：首页配置（海报叠层 + 分类推荐） ── */

// 默认给展示端那一份：推荐页是主要入口，控制台显式传 view: 'console'
ipcMain.handle('home:get', (_event, options?: { view?: HomeFeedView }) =>
  readHomeFeed(options?.view === 'console' ? 'console' : 'display')
)

ipcMain.handle('home:posters:add', (_event, videoId: number) => {
  const result = homeStore.addPoster(Number(videoId))
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:posters:update', (_event, videoId: number, patch: HomeItemPatch) => {
  const result = homeStore.updatePoster(Number(videoId), patch ?? {})
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:posters:remove', (_event, videoId: number) => {
  const result = homeStore.removePoster(Number(videoId))
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:posters:reorder', (_event, videoIds: number[]) => {
  const result = homeStore.reorderPosters(Array.isArray(videoIds) ? videoIds : [])
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:sections:save', (_event, categoryId: string, patch: HomeSectionPatch) => {
  const result = homeStore.saveSection(String(categoryId), patch ?? {})
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:sections:addItem', (_event, categoryId: string, videoId: number) => {
  const target = String(categoryId)
  const vid = Number(videoId)
  // 只能推荐到视频实际绑定的大类；解绑之后推荐会被 syncHomeRecommendations 挪走或删掉
  const allowed = boundTopCategoriesByVideo([vid]).get(vid) ?? []
  if (!allowed.includes(target)) return { ok: false, error: 'NOT_BOUND' }
  const result = homeStore.addSectionItem(target, vid)
  // 顺手把以前落在非绑定分类里的旧推荐拉回来（同一分类里会合并成一条）
  if (result.ok) syncHomeRecommendations()
  invalidateHomeFeed()
  return result
})

ipcMain.handle(
  'home:sections:updateItem',
  (_event, categoryId: string, videoId: number, patch: HomeItemPatch) => {
    const result = homeStore.updateSectionItem(String(categoryId), Number(videoId), patch ?? {})
    invalidateHomeFeed()
    return result
  }
)

ipcMain.handle('home:sections:removeItem', (_event, categoryId: string, videoId: number) => {
  const result = homeStore.removeSectionItem(String(categoryId), Number(videoId))
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:sections:restoreItem', (_event, categoryId: string, videoId: number) => {
  const result = homeStore.restoreSectionItem(String(categoryId), Number(videoId))
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:sections:reorder', (_event, categoryId: string, videoIds: number[]) => {
  const result = homeStore.reorderSectionItems(
    String(categoryId),
    Array.isArray(videoIds) ? videoIds : []
  )
  invalidateHomeFeed()
  return result
})

ipcMain.handle('home:sections:clear', (_event, categoryId: string) => {
  const result = homeStore.clearSectionItems(String(categoryId))
  invalidateHomeFeed()
  return result
})

/* ── IPC：搜索页底部推荐（没有分类归属） ── */

ipcMain.handle('home:search:get', () => readHomeSearch())

ipcMain.handle('home:search:save', (_event, patch: HomeSearchPatch) =>
  homeStore.saveSearch(patch ?? {})
)

ipcMain.handle('home:search:addItem', (_event, videoId: number) => {
  if (!videoCacheReady) return cacheUnavailable()
  const vid = Number(videoId)
  // 只接受缓存库里还在的视频；列表页的「推荐」入口本来就来自它
  if (!Number.isInteger(vid) || videoStore.listVideosByIds([vid]).length === 0) {
    return { ok: false, error: 'NOT_FOUND' }
  }
  return homeStore.addSearchItem(vid)
})

ipcMain.handle('home:search:updateItem', (_event, videoId: number, patch: HomeItemPatch) =>
  homeStore.updateSearchItem(Number(videoId), patch ?? {})
)

ipcMain.handle('home:search:removeItem', (_event, videoId: number) =>
  homeStore.removeSearchItem(Number(videoId))
)

ipcMain.handle('home:search:restoreItem', (_event, videoId: number) =>
  homeStore.restoreSearchItem(Number(videoId))
)

ipcMain.handle('home:search:reorder', (_event, videoIds: number[]) =>
  homeStore.reorderSearchItems(Array.isArray(videoIds) ? videoIds : [])
)

ipcMain.handle('home:search:clear', () => homeStore.clearSearchItems())

ipcMain.handle('home:image:pick', async () => {
  const options: Electron.OpenDialogOptions = {
    title: '选择首页图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'] }]
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
  return homeStore.importImage(result.filePaths[0])
})

/* ── IPC：备份与恢复 ── */

ipcMain.handle('backup:list', () => backupStore.list())

ipcMain.handle('backup:create', () => backupStore.create())

ipcMain.handle('backup:remove', (_event, id: string) => backupStore.remove(String(id)))

ipcMain.handle('backup:openFolder', async () => {
  // openPath 成功时返回空字符串，失败时返回错误描述
  const error = await shell.openPath(backupStore.directory())
  return error === ''
})

ipcMain.handle('backup:export', async (_event, id: string) => {
  const record = backupStore.list().records.find((item) => item.id === String(id))
  if (!record) return { ok: false, error: 'NOT_FOUND' }
  const options: Electron.SaveDialogOptions = {
    title: '保存备份文件',
    defaultPath: join(app.getPath('downloads'), record.id),
    filters: [{ name: '映盒剧场备份', extensions: ['json'] }]
  }
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  return backupStore.exportTo(record.id, result.filePath)
})

ipcMain.handle('backup:pick', async () => {
  const options: Electron.OpenDialogOptions = {
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [
      { name: '映盒剧场备份', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
  return backupStore.inspect(result.filePaths[0])
})

ipcMain.handle('backup:restore', async (_event, source: RestoreSource) => {
  const result = backupStore.restore(source)
  // 站点分类被整体替换，之前「重新获取」的待确认结果全部作废
  if (result.ok) {
    pendingCategoryRefresh.clear()
    if (videoCacheReady) await collector.cancelAll()
    // 恢复前先让后台清理收尾，避免它按旧站点 id 把刚恢复的数据删掉
    await waitSiteCachePurge()
    await reconcileVideoCache()
    // 备份里可能是另一批站点 id，失效的默认 pic 来源配置直接清掉
    const defaultPicSiteId = appSettingsStore.get().defaultPicSiteId
    if (defaultPicSiteId && !siteStore.list().some((site) => site.id === defaultPicSiteId)) {
      appSettingsStore.setDefaultPicSite('')
    }
    // 分类 / 绑定被整体替换，推荐页那份缓存不再可信；禁用站点状态也要重新灌一次
    refreshDisabledSites()
  }
  return result
})

/* ── IPC：局域网服务 ── */

ipcMain.handle('lan:state', () => lanService.state())

ipcMain.handle('lan:start', (_event, input?: { host?: unknown; port?: unknown }) => {
  const host = typeof input?.host === 'string' ? input.host : ''
  return lanService.start({ host, port: Number(input?.port) })
})

ipcMain.handle('lan:stop', () => lanService.stop())

ipcMain.handle('lan:open', async () => {
  const state = lanService.state()
  if (!state.running || state.urls.length === 0) return false
  await shell.openExternal(state.urls[0])
  return true
})

/* ── IPC：应用信息 ── */

ipcMain.handle('app:info', () => ({
  name: '映盒剧场',
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  packaged: app.isPackaged,
  /** 是否支持检查更新（开发模式可用 CINEBOX_DEV_UPDATE=1 打开联调） */
  canUpdate: updater.canUpdate()
}))

/* ── IPC：自动更新 ── */

ipcMain.handle('updater:check', () => {
  updater.checkForUpdates()
  return updater.getStatus()
})

ipcMain.handle('updater:download', () => {
  updater.downloadUpdate()
  return updater.getStatus()
})

ipcMain.handle('updater:install', () => {
  updater.quitAndInstall()
  return true
})

ipcMain.handle('updater:getStatus', () => updater.getStatus())

/* ── 应用生命周期 ── */

if (!gotTheLock) {
  // 已经有一个实例在运行，直接退出，由它负责把窗口拉到前台
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.0x2one.cinebox')

    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(icon)
    }

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    await appSettingsStore.init().catch(() => {})
    await siteStore.init().catch(() => {})
    await categoryStore.init().catch(() => {})
    await bindingStore.init().catch(() => {})
    await scheduleStore.init().catch((error) => console.error('采集计划初始化失败', error))
    await backupStore.init().catch(() => {})
    await homeStore.init().catch((error) => console.error('首页配置初始化失败', error))
    await downloadStore.init().catch((error) => console.error('下载记录初始化失败', error))
    // 上次退出时没跑完的缓存任务：转失败并清掉半成品包
    await downloadEngine.init().catch((error) => console.error('缓存任务初始化失败', error))
    // 自定义图片：cine-img://home/<文件名> → userData/Data/Home/images/<文件名>
    protocol.handle('cine-img', (request) => {
      try {
        const url = new URL(request.url)
        if (url.hostname !== 'home') return new Response('Not found', { status: 404 })
        const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        const path = homeStore.imageFile(file)
        if (!path) return new Response('Not found', { status: 404 })
        return net.fetch(pathToFileURL(path).toString())
      } catch {
        return new Response('Bad request', { status: 400 })
      }
    })
    // 本机下载视频：cine-file://downloads/<encodeURIComponent(绝对路径)>
    // 只放行下载记录里登记过的文件（按记录路径精确匹配），不做任意文件读取器；
    // 不要求文件仍在当前下载目录：用户改过保存位置后，旧目录里的视频照样要能播
    protocol.handle(DOWNLOAD_MEDIA_SCHEME, (request) => {
      try {
        const url = new URL(request.url)
        if (url.hostname !== 'downloads') return new Response('Not found', { status: 404 })
        const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        if (!isAbsolute(file) || !downloadStore.findByPath(file)) {
          return new Response('Not found', { status: 404 })
        }
        return serveDownloadFile(file, request)
      } catch {
        return new Response('Bad request', { status: 400 })
      }
    })
    try {
      await videoStore.init()
      videoCacheReady = true
      videoStore.resetInterrupted()
      // 禁用站点的视频默认不进列表 / 搜索 / 首页，启动时先把状态灌进缓存库
      refreshDisabledSites()
      collectLogs.trim()
      await reconcileVideoCache()
    } catch (error) {
      videoCacheReady = false
      console.error('视频缓存初始化失败', error)
    }

    // 启动时校正一次：老配置里可能有推荐到了非绑定分类的条目，按当前绑定拉回或清掉
    syncHomeRecommendations()

    const savedShortcut = appSettingsStore.get().showShortcut
    if (savedShortcut) tryRegisterAccel(savedShortcut)

    setupApplicationMenu()
    createWindow()
    syncTrayWithSettings()
    updater.init()
    if (videoCacheReady) scheduler.start()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      } else {
        showMainWindow()
      }
    })
  })

  app.on('before-quit', () => {
    isQuitting = true
    destroyTray()
    scheduler.stop()
    collector.shutdown()
    // 缓存任务直接中止；中断的记录由下次启动的 downloadEngine.init() 统一收尾
    downloadEngine.shutdown()
    downloadStore.flush()
    // 本机播放服务只在缓存播放时用，退出时关掉监听
    downloadHlsServer.dispose()
    // 先关掉局域网监听，别让网页端在数据库关闭后还发请求进来
    lanService.dispose()
    // 应用未就绪时调用 globalShortcut 会抛错，这里加一层保护
    if (app.isReady()) globalShortcut.unregisterAll()
    // 日志是异步批量落库的：关库前把队列里剩下的同步写完
    collectLogs.flush()
    // 关闭数据库连接，触发 WAL checkpoint 并清掉 -wal / -shm 附属文件
    videoStore.close()
    siteStore.close()
    categoryStore.close()
    bindingStore.close()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !appSettingsStore.get().closeToTray) {
      app.quit()
    }
  })
}
