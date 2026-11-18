import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 暴露给渲染进程的自定义 API
const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    setOpenAtLogin: (value: boolean): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setOpenAtLogin', value),
    setCloseToTray: (value: boolean): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setCloseToTray', value),
    setAutoDownload: (value: boolean): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setAutoDownload', value),
    setShowShortcut: (value: string | null): Promise<SetShortcutResult> =>
      ipcRenderer.invoke('settings:setShowShortcut', value),
    resetShowShortcut: (): Promise<SetShortcutResult> =>
      ipcRenderer.invoke('settings:resetShowShortcut')
  },
  sites: {
    list: (): Promise<Site[]> => ipcRenderer.invoke('sites:list'),
    add: (input: SiteInput): Promise<AddSiteResult> => ipcRenderer.invoke('sites:add', input),
    update: (id: string, input: SiteInput): Promise<UpdateSiteResult> =>
      ipcRenderer.invoke('sites:update', id, input),
    remove: (id: string): Promise<RemoveSiteResult> => ipcRenderer.invoke('sites:remove', id),
    categories: (id: string): Promise<SiteCategoriesResult> =>
      ipcRenderer.invoke('sites:categories', id),
    refreshCategories: (id: string): Promise<SiteCategoriesRefreshResult> =>
      ipcRenderer.invoke('sites:categories:refresh', id),
    applyCategories: (
      id: string,
      mode: 'incremental' | 'full'
    ): Promise<SiteCategoriesApplyResult> => ipcRenderer.invoke('sites:categories:apply', id, mode)
  },
  categories: {
    list: (): Promise<VideoCategory[]> => ipcRenderer.invoke('categories:list'),
    create: (input: VideoCategoryInput): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:create', input),
    update: (id: string, input: VideoCategoryInput): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:update', id, input),
    setVisible: (id: string, visible: boolean): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:setVisible', id, visible),
    move: (
      id: string,
      targetId: string | null,
      placement: CategoryPlacement
    ): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:move', id, targetId, placement),
    remove: (id: string): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:remove', id)
  },
  bindings: {
    forSite: (siteId: string): Promise<SiteCategoryBinding[]> =>
      ipcRenderer.invoke('bindings:forSite', siteId),
    forCategory: (categoryId: string): Promise<CategoryBinding[]> =>
      ipcRenderer.invoke('bindings:forCategory', categoryId),
    counts: (): Promise<Record<string, number>> => ipcRenderer.invoke('bindings:counts'),
    bind: (items: BindingTarget[], categoryId: string): Promise<BindingResult> =>
      ipcRenderer.invoke('bindings:bind', items, categoryId),
    unbind: (items: BindingTarget[]): Promise<BindingResult> =>
      ipcRenderer.invoke('bindings:unbind', items)
  },
  backup: {
    list: (): Promise<BackupListResult> => ipcRenderer.invoke('backup:list'),
    create: (): Promise<BackupCreateResult> => ipcRenderer.invoke('backup:create'),
    remove: (id: string): Promise<BackupRemoveResult> => ipcRenderer.invoke('backup:remove', id),
    export: (id: string): Promise<BackupExportResult> => ipcRenderer.invoke('backup:export', id),
    openFolder: (): Promise<boolean> => ipcRenderer.invoke('backup:openFolder'),
    pick: (): Promise<BackupPickResult> => ipcRenderer.invoke('backup:pick'),
    restore: (source: RestoreSource): Promise<BackupRestoreResult> =>
      ipcRenderer.invoke('backup:restore', source)
  },
  videos: {
    list: (query: VideoListQuery): Promise<VideoListResult> =>
      ipcRenderer.invoke('videos:list', query),
    update: (videoId: number, patch: VideoUpdateInput): Promise<VideoUpdateResult> =>
      ipcRenderer.invoke('videos:update', videoId, patch),
    detail: (videoId: number, options?: { autoFetch?: boolean }): Promise<VideoDetailResult> =>
      ipcRenderer.invoke('videos:detail', videoId, options),
    refreshDetail: (
      videoId: number,
      options?: { force?: boolean }
    ): Promise<VideoDetailRefreshResult> =>
      ipcRenderer.invoke('videos:detail:refresh', videoId, options),
    stats: (): Promise<VideoStats> => ipcRenderer.invoke('videos:stats'),
    capacity: (): Promise<VideoCapacity> => ipcRenderer.invoke('videos:capacity'),
    scanCapacity: (options?: { fixMissing?: boolean }): Promise<VideoCapacityScanResult> =>
      ipcRenderer.invoke('videos:capacity:scan', options),
    clearDetails: (options?: { siteId?: string }): Promise<DetailClearResult> =>
      ipcRenderer.invoke('videos:details:clear', options),
    progress: (siteId?: string): Promise<VideoCollectProgress[]> =>
      ipcRenderer.invoke('videos:progress', siteId),
    collect: (input: VideoCollectStartInput): Promise<VideoCollectStartResult> =>
      ipcRenderer.invoke('videos:collect:start', input),
    cancelCollect: (input: {
      siteId: string
      mode?: CollectMode
      fetchRange?: FetchRange
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('videos:collect:cancel', input),
    schedules: (): Promise<VideoScheduleListResult> => ipcRenderer.invoke('videos:schedules:list'),
    saveSchedule: (input: VideoScheduleInput): Promise<VideoScheduleSaveResult> =>
      ipcRenderer.invoke('videos:schedules:save', input),
    removeSchedule: (siteId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('videos:schedules:remove', siteId),
    logs: (query?: VideoLogQuery): Promise<VideoLogListResult> =>
      ipcRenderer.invoke('videos:logs:list', query),
    clearLogs: (options?: { siteId?: string }): Promise<{ ok: boolean; removed?: number }> =>
      ipcRenderer.invoke('videos:logs:clear', options),
    clear: (): Promise<VideoCacheClearResult> => ipcRenderer.invoke('videos:clear'),
    onProgress: (callback: (progress: VideoCollectProgress) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: VideoCollectProgress): void =>
        callback(progress)
      ipcRenderer.on('videos:collect:progress', handler)
      return () => {
        ipcRenderer.removeListener('videos:collect:progress', handler)
      }
    },
    onLogAppend: (callback: (log: VideoCollectLog) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, log: VideoCollectLog): void =>
        callback(log)
      ipcRenderer.on('videos:logs:onAppend', handler)
      return () => {
        ipcRenderer.removeListener('videos:logs:onAppend', handler)
      }
    }
  },
  cache: {
    scan: (): Promise<CacheSummary> => ipcRenderer.invoke('cache:scan'),
    clear: (): Promise<CacheClearResult> => ipcRenderer.invoke('cache:clear'),
    onProgress: (callback: (progress: CacheProgress) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: CacheProgress): void =>
        callback(progress)
      ipcRenderer.on('cache:progress', handler)
      return () => {
        ipcRenderer.removeListener('cache:progress', handler)
      }
    }
  },
  updater: {
    check: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:download'),
    install: (): Promise<boolean> => ipcRenderer.invoke('updater:install'),
    getStatus: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:getStatus'),
    onStatus: (callback: (status: UpdaterStatus) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: UpdaterStatus): void =>
        callback(status)
      ipcRenderer.on('updater:status', handler)
      return () => {
        ipcRenderer.removeListener('updater:status', handler)
      }
    }
  },
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (callback: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void =>
        callback(maximized)
      ipcRenderer.on('window:maximize-change', handler)
      return () => {
        ipcRenderer.removeListener('window:maximize-change', handler)
      }
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
