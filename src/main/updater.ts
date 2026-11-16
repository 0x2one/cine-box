import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export type UpdaterState =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'

export interface UpdaterProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface UpdaterStatus {
  state: UpdaterState
  version?: string
  releaseNotes?: string
  progress?: UpdaterProgress
  error?: string
}

type SendFn = (channel: string, ...args: unknown[]) => void
type GetAutoDownload = () => boolean

interface UpdateInfoLike {
  version?: string
  releaseNotes?: string | string[]
}

/** 启动后延迟检查，避开窗口初始化 */
const STARTUP_CHECK_DELAY_MS = 5 * 1000
/** 长时间挂后台时，每 4 小时再检查一次 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseReleaseNotes(notes: string | string[] | undefined): string | undefined {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((note) => {
        if (typeof note === 'string') return note
        if (note && typeof note === 'object') {
          const value = (note as { note?: unknown }).note
          return typeof value === 'string' ? value : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return undefined
}

export interface Updater {
  init: () => void
  /** 当前环境是否允许检查更新（打包后，或开发模式显式开启联调） */
  canUpdate: () => boolean
  checkForUpdates: () => void
  downloadUpdate: () => void
  quitAndInstall: () => void
  getStatus: () => UpdaterStatus
}

/**
 * 更新流程：
 * 1. 启动 5 秒后静默检查一次，之后每 4 小时检查；
 * 2. 发现新版本 → 若「偏好设置 - 自动下载更新」开启则自动下载，否则等用户点击；
 * 3. 下载完成后提示重启安装；正常退出时也会自动安装（autoInstallOnAppQuit）。
 */
export function createUpdater(send: SendFn, getAutoDownload: GetAutoDownload): Updater {
  let status: UpdaterStatus = { state: 'idle' }
  let initCalled = false

  // 开发模式联调开关：CINEBOX_DEV_UPDATE=1 pnpm dev（读取 dev-app-update.yml 指向的真实仓库）
  const forceDevUpdate = is.dev && process.env['CINEBOX_DEV_UPDATE'] === '1'
  const isUpdateEnabled = (): boolean => app.isPackaged || forceDevUpdate

  function publish(next: UpdaterStatus): void {
    status = next
    send('updater:status', status)
  }

  // 是否下载由「偏好设置 - 自动下载更新」控制，安装前仍由用户决定
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    if (status.state === 'downloading') return
    publish({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    const anyInfo = info as UpdateInfoLike
    publish({
      state: 'available',
      version: anyInfo.version,
      releaseNotes: parseReleaseNotes(anyInfo.releaseNotes)
    })
    if (getAutoDownload()) downloadUpdate()
  })

  autoUpdater.on('update-not-available', () => {
    publish({ state: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    publish({ state: 'error', error: errorMessage(err) })
  })

  autoUpdater.on('download-progress', (progress) => {
    publish({
      state: 'downloading',
      version: status.version,
      progress: {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      }
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    const anyInfo = info as UpdateInfoLike
    publish({ state: 'downloaded', version: anyInfo.version })
  })

  function checkForUpdates(): void {
    if (!isUpdateEnabled()) return
    if (status.state === 'checking' || status.state === 'downloading') return
    void autoUpdater.checkForUpdates().catch((err) => {
      // 绝大多数失败已通过 'error' 事件发布状态，这里只兜底
      if (status.state !== 'error') publish({ state: 'error', error: errorMessage(err) })
    })
  }

  function downloadUpdate(): void {
    if (!isUpdateEnabled()) return
    if (status.state !== 'available') return
    void autoUpdater.downloadUpdate().catch((err) => {
      publish({ state: 'error', version: status.version, error: errorMessage(err) })
    })
  }

  function quitAndInstall(): void {
    if (!isUpdateEnabled()) return
    if (status.state !== 'downloaded') return
    // 立即退出并重启，避免收进托盘的逻辑拦住更新
    autoUpdater.quitAndInstall(false, true)
  }

  return {
    init: () => {
      if (initCalled) return
      initCalled = true
      if (is.dev) {
        // 开发模式指向 dev-app-update.yml，便于对着真实 Release 联调
        autoUpdater.updateConfigPath = join(app.getAppPath(), 'dev-app-update.yml')
      }
      if (forceDevUpdate) autoUpdater.forceDevUpdateConfig = true
      if (!isUpdateEnabled()) return

      const startupTimer = setTimeout(checkForUpdates, STARTUP_CHECK_DELAY_MS)
      startupTimer.unref?.()
      // 常驻后台时定时轮询；定时器随进程存活，无需清理
      setInterval(checkForUpdates, CHECK_INTERVAL_MS).unref?.()
    },
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    canUpdate: isUpdateEnabled,
    getStatus: () => status
  }
}
