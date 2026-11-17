import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  nativeImage,
  Menu,
  Tray,
  globalShortcut,
  screen
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createAppSettingsStore, DEFAULT_SHOW_SHORTCUT } from './app-settings'
import { createCacheManager } from './app-cache'
import { createBindingStore, type BindingTarget } from './binding-store'
import {
  createCategoryStore,
  type CategoryPlacement,
  type VideoCategoryInput
} from './category-store'
import { fetchSiteCategories } from './site-categories'
import {
  createSiteStore,
  type CategoryUpdateMode,
  type SiteCategoryInput,
  type SiteInput
} from './site-store'
import { createUpdater } from './updater'

const gotTheLock = app.requestSingleInstanceLock()

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
/** 「重新获取」的抓取结果，等用户选择增量 / 全量后再写库，保证确认内容与实际写入一致 */
const pendingCategoryRefresh = new Map<string, { categories: SiteCategoryInput[]; at: number }>()
const PENDING_CATEGORY_TTL = 5 * 60 * 1000
const updater = createUpdater(sendToRenderer, () => appSettingsStore.get().autoDownload)
const cacheManager = createCacheManager()

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
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
  const winOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    // 任务栏 / 窗口图标：Windows、Linux 生效，macOS 走 Dock 图标（见下）
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
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
    // 只在标题栏拖拽区生效，避免双击右侧按钮时误触。
    const WM_LBUTTONDBLCLK = 0x0203
    const TITLE_BAR_HEIGHT = 44
    const BRAND_ZONE_WIDTH = 150
    const ACTIONS_ZONE_WIDTH = 222
    mainWindow.hookWindowMessage(WM_LBUTTONDBLCLK, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const cursor = screen.getCursorScreenPoint()
      const bounds = mainWindow.getBounds()
      const inTitleBar = cursor.y >= bounds.y && cursor.y <= bounds.y + TITLE_BAR_HEIGHT
      const inDragZone =
        cursor.x >= bounds.x + BRAND_ZONE_WIDTH &&
        cursor.x <= bounds.x + bounds.width - ACTIONS_ZONE_WIDTH
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

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
})

ipcMain.handle('window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

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

/* ── IPC：采集站点 ── */

ipcMain.handle('sites:list', () => siteStore.list())

ipcMain.handle('sites:add', (_event, input: SiteInput) => siteStore.add(input))

ipcMain.handle('sites:update', (_event, id: string, input: SiteInput) => {
  // 地址 / 格式可能变化，之前抓取的待确认结果随之作废
  pendingCategoryRefresh.delete(String(id))
  return siteStore.update(String(id), input)
})

ipcMain.handle('sites:remove', (_event, id: string) => {
  pendingCategoryRefresh.delete(String(id))
  return siteStore.remove(String(id))
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
  return { ok: true, categories: siteStore.applyCategories(site.id, pending.categories, mode) }
})

/* ── IPC：视频分类 ── */

ipcMain.handle('categories:list', () => categoryStore.list())

ipcMain.handle('categories:create', (_event, input: VideoCategoryInput) =>
  categoryStore.create(input)
)

ipcMain.handle('categories:update', (_event, id: string, input: VideoCategoryInput) =>
  categoryStore.update(String(id), input)
)

ipcMain.handle(
  'categories:move',
  (_event, id: string, targetId: string | null, placement: CategoryPlacement) =>
    categoryStore.move(
      String(id),
      targetId === null || targetId === undefined ? null : String(targetId),
      placement
    )
)

ipcMain.handle('categories:remove', (_event, id: string) => categoryStore.remove(String(id)))

/* ── IPC：在线分类与本地分类的绑定 ── */

ipcMain.handle('bindings:forSite', (_event, siteId: string) => bindingStore.forSite(String(siteId)))

ipcMain.handle('bindings:forCategory', (_event, categoryId: string) =>
  bindingStore.forCategory(String(categoryId))
)

ipcMain.handle('bindings:counts', () => bindingStore.counts())

ipcMain.handle('bindings:bind', (_event, items: BindingTarget[], categoryId: string) =>
  bindingStore.bind(items, String(categoryId))
)

ipcMain.handle('bindings:unbind', (_event, items: BindingTarget[]) => bindingStore.unbind(items))

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

    const savedShortcut = appSettingsStore.get().showShortcut
    if (savedShortcut) tryRegisterAccel(savedShortcut)

    setupApplicationMenu()
    createWindow()
    syncTrayWithSettings()
    updater.init()

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
    // 应用未就绪时调用 globalShortcut 会抛错，这里加一层保护
    if (app.isReady()) globalShortcut.unregisterAll()
    // 关闭数据库连接，触发 WAL checkpoint 并清掉 -wal / -shm 附属文件
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
