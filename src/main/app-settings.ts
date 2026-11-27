import { app } from 'electron'
import { mkdirSync, promises as fsp, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_WINDOW_SIZE, isAppWindowSize, type AppWindowSize } from './window-size'
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  type NetworkSettings
} from './network/network-types'
import { DEFAULT_MCP_SETTINGS, normalizeMcpSettings, type McpSettings } from './mcp/mcp-settings'

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

/** 同时下载的视频数：默认 2，最多 5 路（再多容易被单站限速，磁盘也抢不过来） */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 2
export const MIN_DOWNLOAD_CONCURRENCY = 1
export const MAX_DOWNLOAD_CONCURRENCY = 5

/** 把任意输入收敛到 1–5；缺失 / 空串 / 非法值回落到默认值 */
export function clampDownloadConcurrency(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_DOWNLOAD_CONCURRENCY
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_DOWNLOAD_CONCURRENCY
  return Math.min(Math.max(Math.floor(parsed), MIN_DOWNLOAD_CONCURRENCY), MAX_DOWNLOAD_CONCURRENCY)
}

/** 单集内部同时下载的分片数：默认 3，最多 6 路（再高容易被站点限流 / 封 IP） */
export const DEFAULT_DOWNLOAD_SEGMENT_CONCURRENCY = 3
export const MIN_DOWNLOAD_SEGMENT_CONCURRENCY = 1
export const MAX_DOWNLOAD_SEGMENT_CONCURRENCY = 6

/** 把任意输入收敛到 1–6；缺失 / 空串 / 非法值回落到默认值 */
export function clampDownloadSegmentConcurrency(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_DOWNLOAD_SEGMENT_CONCURRENCY
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_DOWNLOAD_SEGMENT_CONCURRENCY
  return Math.min(
    Math.max(Math.floor(parsed), MIN_DOWNLOAD_SEGMENT_CONCURRENCY),
    MAX_DOWNLOAD_SEGMENT_CONCURRENCY
  )
}

/**
 * 默认下载目录：系统「下载」下的「映盒剧场」子目录，不和用户自己的文件混在一起。
 * app.getPath('downloads') 在个别 Linux 环境会抛错，退回家目录下的 Downloads。
 */
export function defaultDownloadPath(): string {
  try {
    return join(app.getPath('downloads'), '映盒剧场')
  } catch {
    return join(app.getPath('home'), 'Downloads', '映盒剧场')
  }
}

export interface AppSettings {
  /** 开机自启（以操作系统登录项为准） */
  openAtLogin: boolean
  /** 关闭窗口时最小化到托盘，而不是退出 */
  closeToTray: boolean
  /** 检测到新版本后自动下载 */
  autoDownload: boolean
  /**
   * 是否显示 18+ 内容：关闭时，标记为 18+ 的站点 / 分类 / 视频在推荐、找片看、
   * 搜索、播放页与局域网共享页里一律不可见；控制台仍然能看到并管理。
   */
  allowAdult: boolean
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
  /** 下载文件的保存目录（绝对路径） */
  downloadPath: string
  /** 同时下载的任务数（1–5） */
  downloadConcurrency: number
  /** 单集内部同时下载的分片数（1–6） */
  downloadSegmentConcurrency: number
  /** 网络代理：禁用 / 系统代理 / 自定义（HTTP、SOCKS5，可选身份验证） */
  network: NetworkSettings
  /** MCP HTTP 服务：开关、监听地址 / 端口、访问令牌 */
  mcp: McpSettings
}

interface StoreFile {
  version: 1
  openAtLogin?: boolean
  closeToTray?: boolean
  autoDownload?: boolean
  allowAdult?: boolean
  showShortcut?: string
  startView?: string
  windowSize?: string
  defaultPicSiteId?: string
  collectConcurrency?: number
  downloadPath?: string
  downloadConcurrency?: number
  downloadSegmentConcurrency?: number
  network?: Partial<NetworkSettings>
  mcp?: Partial<McpSettings>
}

const DEFAULTS: AppSettings = {
  openAtLogin: false,
  closeToTray: false,
  autoDownload: true,
  // 默认关闭：标记为 18+ 的内容在展示端不可见，需要时在「设置 › 内容」里打开
  allowAdult: false,
  showShortcut: DEFAULT_SHOW_SHORTCUT,
  startView: 'home',
  windowSize: DEFAULT_WINDOW_SIZE,
  defaultPicSiteId: '',
  collectConcurrency: DEFAULT_COLLECT_CONCURRENCY,
  // 读取配置时再落到系统下载目录（此时 app 已就绪），这里只占位
  downloadPath: '',
  downloadConcurrency: DEFAULT_DOWNLOAD_CONCURRENCY,
  downloadSegmentConcurrency: DEFAULT_DOWNLOAD_SEGMENT_CONCURRENCY,
  network: { ...DEFAULT_NETWORK_SETTINGS },
  mcp: { ...DEFAULT_MCP_SETTINGS }
}

export interface AppSettingsStore {
  init: () => Promise<void>
  get: () => AppSettings
  setOpenAtLogin: (value: boolean) => AppSettings
  setCloseToTray: (value: boolean) => AppSettings
  setAutoDownload: (value: boolean) => AppSettings
  /** 是否显示 18+ 内容；保存后展示端立刻按新值隐藏 / 恢复 */
  setAllowAdult: (value: boolean) => AppSettings
  setShowShortcut: (value: string | null) => AppSettings
  setStartView: (value: string | null) => AppSettings
  setWindowSize: (value: string | null) => AppSettings
  setDefaultPicSite: (value: string | null) => AppSettings
  /** 同时采集的站点数；立即影响后续填槽，不打断正在采集的任务 */
  setCollectConcurrency: (value: number | null) => AppSettings
  /** 下载保存目录；空串 / 非法值回落成默认目录 */
  setDownloadPath: (value: string | null) => AppSettings
  /** 同时下载的任务数（1–5）；下一次填槽生效，不打断在下载的任务 */
  setDownloadConcurrency: (value: number | null) => AppSettings
  /** 单集内部的分片并发（1–6）；对之后开始的缓存任务生效 */
  setDownloadSegmentConcurrency: (value: number | null) => AppSettings
  /** 网络代理配置；保存后由主进程立刻套用到 Chromium 网络栈 */
  setNetwork: (value: unknown) => AppSettings
  /** MCP 服务配置；由 MCP 控制器校验后再调用 */
  setMcp: (value: unknown) => AppSettings
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
  let settings: AppSettings = { ...DEFAULTS, network: { ...DEFAULT_NETWORK_SETTINGS } }

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
        allowAdult: typeof data?.allowAdult === 'boolean' ? data.allowAdult : DEFAULTS.allowAdult,
        showShortcut:
          typeof data?.showShortcut === 'string' ? data.showShortcut : DEFAULTS.showShortcut,
        startView: data?.startView === 'search' ? 'search' : 'home',
        windowSize: isAppWindowSize(data?.windowSize) ? data.windowSize : DEFAULTS.windowSize,
        defaultPicSiteId:
          typeof data?.defaultPicSiteId === 'string' ? data.defaultPicSiteId.trim() : '',
        collectConcurrency: clampCollectConcurrency(data?.collectConcurrency),
        downloadPath:
          typeof data?.downloadPath === 'string' && data.downloadPath.trim()
            ? data.downloadPath.trim()
            : defaultDownloadPath(),
        downloadConcurrency: clampDownloadConcurrency(data?.downloadConcurrency),
        downloadSegmentConcurrency: clampDownloadSegmentConcurrency(
          data?.downloadSegmentConcurrency
        ),
        network: normalizeNetworkSettings(data?.network),
        mcp: normalizeMcpSettings(data?.mcp)
      }
    } catch {
      settings = {
        ...DEFAULTS,
        downloadPath: defaultDownloadPath(),
        network: { ...DEFAULT_NETWORK_SETTINGS },
        mcp: { ...DEFAULT_MCP_SETTINGS }
      }
    }
  }

  function persist(): void {
    const payload: StoreFile = {
      version: 1,
      openAtLogin: settings.openAtLogin,
      closeToTray: settings.closeToTray,
      autoDownload: settings.autoDownload,
      allowAdult: settings.allowAdult,
      showShortcut: settings.showShortcut,
      startView: settings.startView,
      windowSize: settings.windowSize,
      defaultPicSiteId: settings.defaultPicSiteId,
      collectConcurrency: settings.collectConcurrency,
      downloadPath: settings.downloadPath,
      downloadConcurrency: settings.downloadConcurrency,
      downloadSegmentConcurrency: settings.downloadSegmentConcurrency,
      network: settings.network,
      mcp: settings.mcp
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
    setAllowAdult: (value: boolean) => {
      settings = { ...settings, allowAdult: Boolean(value) }
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
    },
    setDownloadPath: (value: string | null) => {
      const next = typeof value === 'string' ? value.trim() : ''
      settings = { ...settings, downloadPath: next || defaultDownloadPath() }
      persist()
      return snapshot()
    },
    setDownloadConcurrency: (value: number | null) => {
      settings = { ...settings, downloadConcurrency: clampDownloadConcurrency(value) }
      persist()
      return snapshot()
    },
    setDownloadSegmentConcurrency: (value: number | null) => {
      settings = { ...settings, downloadSegmentConcurrency: clampDownloadSegmentConcurrency(value) }
      persist()
      return snapshot()
    },
    setNetwork: (value: unknown) => {
      settings = { ...settings, network: normalizeNetworkSettings(value) }
      persist()
      return snapshot()
    },
    setMcp: (value: unknown) => {
      settings = { ...settings, mcp: normalizeMcpSettings(value) }
      persist()
      return snapshot()
    }
  }
}
