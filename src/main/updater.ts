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

function parseReleaseNotes(notes: string | string[] | undefined): string | undefined {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        if (typeof n === 'string') return n
        if (n && typeof n === 'object') {
          const note = (n as { note?: unknown }).note
          return typeof note === 'string' ? note : ''
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
  checkForUpdates: () => void
  downloadUpdate: () => void
  quitAndInstall: () => void
  getStatus: () => UpdaterStatus
}

export function createUpdater(send: SendFn, getAutoDownload: GetAutoDownload): Updater {
  let status: UpdaterStatus = { state: 'idle' }
  let initCalled = false

  function publish(next: UpdaterStatus): void {
    status = next
    send('updater:status', status)
  }

  // 是否自动下载由「偏好设置 - 自动下载更新」控制
  autoUpdater.autoDownload = false
  autoUpdater.autoRunAppAfterInstall = true

  autoUpdater.on('checking-for-update', () => {
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
    publish({ state: 'error', error: err instanceof Error ? err.message : String(err) })
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
    if (!app.isPackaged) return
    if (status.state === 'downloading') return
    void autoUpdater.checkForUpdates().catch(() => {
      // 错误已经通过 'error' 事件发布
    })
  }

  function downloadUpdate(): void {
    if (!app.isPackaged) return
    void autoUpdater.downloadUpdate().catch(() => {
      // 错误已经通过 'error' 事件发布
    })
  }

  function quitAndInstall(): void {
    if (!app.isPackaged) return
    autoUpdater.quitAndInstall()
  }

  return {
    init: () => {
      if (initCalled) return
      initCalled = true
      if (is.dev) {
        // 开发模式下指向 dev-app-update.yml，便于联调（检查仍以 app.isPackaged 为闸门）
        autoUpdater.updateConfigPath = join(app.getAppPath(), 'dev-app-update.yml')
      }
      setTimeout(() => checkForUpdates(), 5000)
    },
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    getStatus: () => status
  }
}
