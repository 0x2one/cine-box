import { app } from 'electron'
import { mkdirSync, promises as fsp, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_WINDOW_SIZE, isAppWindowSize, type AppWindowSize } from './window-size'

/** 默认全局快捷键：在任何地方唤起 / 隐藏主窗口 */
export const DEFAULT_SHOW_SHORTCUT = 'Ctrl+Shift+Space'

/** 启动时打开的页面：推荐页（首页）或搜索页 */
export type AppStartView = 'home' | 'search'

/** 同时采集的站点数：默认 2，最多 4 路（再高收益被网络和磁盘吃掉） */
export const DEFAULT_COLLECT_CONCURRENCY = 2
export const MIN_COLLECT_CONCURRENCY = 1
export const MAX_COLLECT_CONCURRENCY = 4

/** 把任意输入收敛到 1–4；缺失 / 空串 / 非法值回落到默认值 */
export function clampCollectConcurrency(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_COLLECT_CONCURRENCY
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_COLLECT_CONCURRENCY
  return Math.min(Math.max(Math.floor(parsed), MIN_COLLECT_CONCURRENCY), MAX_COLLECT_CONCURRENCY)
}

export interface AppSettings {
  /** 开机自启（以操作系统登录项为准） */
  openAtLogin: boolean
  /** 关闭窗口时最小化到托盘，而不是退出 */
  closeToTray: boolean
  /** 检测到新版本后自动下载 */
  autoDownload: boolean
  /** 全局快捷键，空字符串表示未启用 */
  showShortcut: string
  /** 启动映盒剧场时直接打开的页面 */
  startView: AppStartView
  /** 启动时主窗口的大小：适中 / 大屏 / 超大 */
  windowSize: AppWindowSize
  /** 采集时优先使用哪个站点的 pic 填充 videos.pic，空串表示不指定 */
  defaultPicSiteId: string
  /** 同时采集的站点数（1–4）：跨站并行，同一站点始终串行 */
  collectConcurrency: number
}

interface StoreFile {
  version: 1
  openAtLogin?: boolean
  closeToTray?: boolean
  autoDownload?: boolean
  showShortcut?: string
  startView?: string
  windowSize?: string
  defaultPicSiteId?: string
  collectConcurrency?: number
}

const DEFAULTS: AppSettings = {
  openAtLogin: false,
  closeToTray: false,
  autoDownload: true,
  showShortcut: DEFAULT_SHOW_SHORTCUT,
  startView: 'home',
  windowSize: DEFAULT_WINDOW_SIZE,
  defaultPicSiteId: '',
  collectConcurrency: DEFAULT_COLLECT_CONCURRENCY
}

export interface AppSettingsStore {
  init: () => Promise<void>
  get: () => AppSettings
  setOpenAtLogin: (value: boolean) => AppSettings
  setCloseToTray: (value: boolean) => AppSettings
  setAutoDownload: (value: boolean) => AppSettings
  setShowShortcut: (value: string | null) => AppSettings
  setStartView: (value: string | null) => AppSettings
  setWindowSize: (value: string | null) => AppSettings
  setDefaultPicSite: (value: string | null) => AppSettings
  /** 同时采集的站点数；立即影响后续填槽，不打断正在采集的任务 */
  setCollectConcurrency: (value: number | null) => AppSettings
}

function loginItemOptions(): { path: string; args: string[] } | undefined {
  if (app.isPackaged) return undefined
  // 开发模式下注册 electron 本体 + 项目路径，保证开机后还能拉起项目
  return { path: process.execPath, args: [app.getAppPath()] }
}

function applyOpenAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions() })
  } catch {
    // 注册失败（权限 / 平台限制）时保持当前值，由调用方从系统读取真实状态
  }
}

function readOpenAtLogin(): boolean {
  try {
    return Boolean(app.getLoginItemSettings(loginItemOptions()).openAtLogin)
  } catch {
    return false
  }
}

export function createAppSettingsStore(): AppSettingsStore {
  const file = join(app.getPath('userData'), 'app-settings.json')
  let settings: AppSettings = { ...DEFAULTS }

  async function readFile(): Promise<void> {
    try {
      const raw = await fsp.readFile(file, 'utf-8')
      const data = JSON.parse(raw) as StoreFile
      settings = {
        openAtLogin:
          typeof data?.openAtLogin === 'boolean' ? data.openAtLogin : DEFAULTS.openAtLogin,
        closeToTray:
          typeof data?.closeToTray === 'boolean' ? data.closeToTray : DEFAULTS.closeToTray,
        autoDownload:
          typeof data?.autoDownload === 'boolean' ? data.autoDownload : DEFAULTS.autoDownload,
        showShortcut:
          typeof data?.showShortcut === 'string' ? data.showShortcut : DEFAULTS.showShortcut,
        startView: data?.startView === 'search' ? 'search' : 'home',
        windowSize: isAppWindowSize(data?.windowSize) ? data.windowSize : DEFAULTS.windowSize,
        defaultPicSiteId:
          typeof data?.defaultPicSiteId === 'string' ? data.defaultPicSiteId.trim() : '',
        collectConcurrency: clampCollectConcurrency(data?.collectConcurrency)
      }
    } catch {
      settings = { ...DEFAULTS }
    }
  }

  function persist(): void {
    const payload: StoreFile = {
      version: 1,
      openAtLogin: settings.openAtLogin,
      closeToTray: settings.closeToTray,
      autoDownload: settings.autoDownload,
      showShortcut: settings.showShortcut,
      startView: settings.startView,
      windowSize: settings.windowSize,
      defaultPicSiteId: settings.defaultPicSiteId,
      collectConcurrency: settings.collectConcurrency
    }
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
    } catch {
      // 落盘失败不阻塞界面，本次运行内仍生效
    }
  }

  /** 以操作系统状态为准（用户可能在任务管理器里关掉自启） */
  function snapshot(): AppSettings {
    settings = { ...settings, openAtLogin: readOpenAtLogin() }
    return { ...settings }
  }

  return {
    init: async () => {
      await readFile()
      persist()
    },
    get: snapshot,
    setOpenAtLogin: (value: boolean) => {
      const enabled = Boolean(value)
      applyOpenAtLogin(enabled)
      settings = { ...settings, openAtLogin: enabled }
      persist()
      return snapshot()
    },
    setCloseToTray: (value: boolean) => {
      settings = { ...settings, closeToTray: Boolean(value) }
      persist()
      return snapshot()
    },
    setAutoDownload: (value: boolean) => {
      settings = { ...settings, autoDownload: Boolean(value) }
      persist()
      return snapshot()
    },
    setShowShortcut: (value: string | null) => {
      settings = { ...settings, showShortcut: typeof value === 'string' ? value.trim() : '' }
      persist()
      return snapshot()
    },
    setStartView: (value: string | null) => {
      settings = { ...settings, startView: value === 'search' ? 'search' : 'home' }
      persist()
      return snapshot()
    },
    setWindowSize: (value: string | null) => {
      settings = {
        ...settings,
        windowSize: isAppWindowSize(value) ? value : DEFAULTS.windowSize
      }
      persist()
      return snapshot()
    },
    setDefaultPicSite: (value: string | null) => {
      settings = {
        ...settings,
        defaultPicSiteId: typeof value === 'string' ? value.trim() : ''
      }
      persist()
      return snapshot()
    },
    setCollectConcurrency: (value: number | null) => {
      settings = { ...settings, collectConcurrency: clampCollectConcurrency(value) }
      persist()
      return snapshot()
    }
  }
}
