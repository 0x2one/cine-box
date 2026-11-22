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
import { join } from 'path'
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
  type VideoCategoryInput
} from './category-store'
import { createCollectLogStore } from './collect-log-store'
import { createCollectScheduleStore } from './collect-schedule-store'
import { createCollectScheduler } from './collect-scheduler'
import { buildHomeFeed, buildSearchSection } from './home-feed'
import { boundTopCategories, syncRecommendations } from './home-recommend'
import { createHomeStore } from './home-store'
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
import { clampPageSize, probePageSize } from './video-collect-probe'
import {
  createSiteStore,
  isSameSiteHost,
  type CategoryUpdateMode,
  type SiteCategoryInput,
  type SiteInput
} from './site-store'
import { createUpdater } from './updater'
import { createVideoCacheStore } from './video-cache-store'
import { createVideoCollector } from './video-collector'
import { createVideoDetailCache } from './video-detail-cache'
import { resolveWindowSize, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from './window-size'
import type {
  CollectMode,
  FetchRange,
  VideoCollectStartInput,
  VideoListQuery,
  VideoScheduleInput,
  VideoUpdateInput
} from './video-types'

const gotTheLock = app.requestSingleInstanceLock()

// 首页自定义图片走自己的协议，避免把图片整段塞进配置 JSON 或放开 file://
protocol.registerSchemesAsPrivileged([
  { scheme: 'cine-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }
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
const videoStore = createVideoCacheStore(videoCacheFile)
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
  emitProgress: (progress) => {
    // 采集每落一页都会推一次进度：新片进来推荐页的轨道就该变，缓存作废
    invalidateHomeFeed()
    sendToRenderer('videos:collect:progress', progress)
  }
})
const scheduler = createCollectScheduler({
  schedules: scheduleStore,
  collector,
  logs: collectLogs
})
// 首页配置（海报叠层 + 分类推荐）与自定义图片：userData/Data/Home
const homeStore = createHomeStore(join(app.getPath('userData'), 'Data', 'Home'))
/** 缓存库初始化失败时不影响应用启动，视频相关 IPC 返回 CACHE_UNAVAILABLE */
let videoCacheReady = false
/** 「重新获取」的抓取结果，等用户选择增量 / 全量后再写库，保证确认内容与实际写入一致 */
const pendingCategoryRefresh = new Map<string, { categories: SiteCategoryInput[]; at: number }>()
const PENDING_CATEGORY_TTL = 5 * 60 * 1000
const updater = createUpdater(sendToRenderer, () => appSettingsStore.get().autoDownload)
const cacheManager = createCacheManager()
// 播放页跑在独立的无边框暗色窗口里，不复用主窗口（IPC 由它自己注册）
createPlayerWindowManager({
  preload: join(__dirname, '../preload/index.js'),
  icon
})

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
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
const siteCachePurges = new Map<string, Promise<void>>()

async function purgeSiteCache(siteId: string): Promise<void> {
  collector.cancel({ siteId })
  // 先作废推荐页那份缓存：清理期间重建也不会再看到这个站点的视频
  invalidateHomeFeed()
  if (!videoCacheReady) return
  try {
    videoStore.removeSite(siteId)
  } catch (error) {
    console.error('清理站点视频缓存失败', error)
    return
  }
  await detailCache.removeSite(siteId).catch(() => {})
  invalidateHomeFeed()
}

function scheduleSiteCachePurge(siteId: string): void {
  const next = (siteCachePurges.get(siteId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => purgeSiteCache(siteId))
    .finally(() => {
      if (siteCachePurges.get(siteId) === next) siteCachePurges.delete(siteId)
    })
  siteCachePurges.set(siteId, next)
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

function invalidateHomeFeed(): void {
  displayFeed = null
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
        videosByIds: (videoIds) => videoStore.listVideosByIds(videoIds),
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
    const ACTIONS_ZONE_WIDTH = 222
    // 与 TitleBar 中间「推荐 / 搜索 / 找片看」胶囊的实际宽度对齐（main.css 的 .titlebar-nav）：
    // 内边距 3+3、边框 1+1、推荐 58、找片看约 62、搜索框 200、三处间距 6×2
    const CENTER_NAV_WIDTH = 340
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

ipcMain.handle('videos:list', (_event, query: VideoListQuery) => {
  if (!videoCacheReady) return { ...cacheUnavailable(), items: [], total: 0, page: 1, pageSize: 10 }
  const { filters, empty } = resolveVideoFilters(query)
  if (empty) return { ok: true, items: [], total: 0, page: 1, pageSize: 10 }
  const result = videoStore.listVideos(query ?? {}, filters)
  if (!result.ok || result.items.length === 0) return result

  // 列表要显示「绑定后类型」：把本页视频各来源的在线分类映射成本地分类路径
  const bindingPaths = new Map(
    bindingStore
      .pathsForSourceCategories()
      .map((row) => [`${row.siteId}\u0000${row.sourceCategoryId}`, row.categoryPath])
  )
  const byVideo = new Map<number, string[]>()
  for (const source of videoStore.listSourceCategories(result.items.map((item) => item.id))) {
    const path = bindingPaths.get(`${source.siteId}\u0000${source.categoryId}`)
    if (!path) continue
    const paths = byVideo.get(source.videoId) ?? []
    if (!paths.includes(path)) paths.push(path)
    byVideo.set(source.videoId, paths)
  }

  // 首页状态：已加进海报 / 已推荐到哪些分类，视频列表直接显示出来，不用再点开看
  const homeConfig = homeStore.get()
  // 推荐只能进视频绑定的大类，弹窗按这个列表给可选目标
  const boundTops = boundTopCategoriesByVideo(result.items.map((item) => item.id))
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

  return {
    ...result,
    items: result.items.map((item) => ({
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

ipcMain.handle('videos:progress', (_event, siteId?: string) => {
  if (!videoCacheReady) return []
  return videoStore.listProgress(siteId ? String(siteId) : undefined)
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
  // 同一模式与方式已经在跑 / 排队时不用探测，enqueue 会直接回 ALREADY_QUEUED
  const range = input?.mode === 'full' ? 'all' : input?.fetchRange
  const live = videoStore
    .listProgress(siteId)
    .some(
      (row) =>
        row.mode === input?.mode &&
        row.fetchRange === range &&
        (row.status === 'queued' || row.status === 'running' || row.status === 'replacing')
    )
  let pageSize = clampPageSize(input?.pageSize)
  if (!pageSize && !live) {
    // 历史任务用过真实页大小就直接复用，只有完全没记录时才试抓一页
    pageSize = knownPageSize(siteId, input?.mode, range)
    if (!pageSize) {
      const site = siteStore.list().find((item) => item.id === siteId)
      if (site) pageSize = (await probePageSize(site)).pageSize
    }
  }
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
  collector.resume()
  scheduler.start()
  // 缓存库整体重建，推荐页的卡片全部作废
  invalidateHomeFeed()
  return { ok: true, freedBytes: before.dbBytes + before.detailBytes }
})

/* ── IPC：采集站点 ── */

ipcMain.handle('sites:list', () => siteStore.list())

ipcMain.handle('sites:add', (_event, input: SiteInput) => siteStore.add(input))

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
  // 只有真的换了站点（域名 / 格式变了）旧缓存才不可信。同一个 domain 下改路径、补斜杠
  // 通常只是笔误，为此把几万条来源和详情文件全清掉不值当；清理本身也放到后台，不堵保存。
  if (formatChanged || !isSameSiteHost(existing.address, result.site.address)) {
    // 先同步作废推荐页那份缓存：清理是异步的，别让接下来的 home:get 还拿到旧 feed
    invalidateHomeFeed()
    scheduleSiteCachePurge(siteId)
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
    invalidateHomeFeed()
    // 站点缓存与详情目录在后台清，几万条来源时不拖住删除操作
    scheduleSiteCachePurge(siteId)
  }
  return result
})

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
    // 分类 / 绑定被整体替换，推荐页那份缓存不再可信
    invalidateHomeFeed()
  }
  return result
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
    try {
      await videoStore.init()
      videoCacheReady = true
      videoStore.resetInterrupted()
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
