import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** 主进程通过 additionalArguments 传入的启动页面，同步读取，首帧就能渲染正确的页面 */
function readStartView(): AppStartView {
  return process.argv.includes('--cinebox-start-view=search') ? 'search' : 'home'
}

// 暴露给渲染进程的自定义 API
const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    startView: (): AppStartView => readStartView()
  },
  player: {
    /** 打开独立播放窗：已打开时把新的一集推过去，不另开窗口 */
    open: (input: PlayerOpenInput): Promise<PlayerOpenResult> =>
      ipcRenderer.invoke('player:open', input),
    /** 播放页挂载时取当前载荷（窗口是复用的，可能已经切到别的集） */
    payload: (): Promise<PlayerPayload | null> => ipcRenderer.invoke('player:payload'),
    onLoad: (callback: (payload: PlayerPayload) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PlayerPayload): void =>
        callback(payload)
      ipcRenderer.on('player:load', handler)
      return () => {
        ipcRenderer.removeListener('player:load', handler)
      }
    }
  },
  appearance: {
    get: (): Promise<PlayerAppearance | null> => ipcRenderer.invoke('appearance:get'),
    set: (value: PlayerAppearance): Promise<void> => ipcRenderer.invoke('appearance:set', value),
    onChange: (callback: (value: PlayerAppearance) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PlayerAppearance): void =>
        callback(value)
      ipcRenderer.on('appearance:change', handler)
      return () => {
        ipcRenderer.removeListener('appearance:change', handler)
      }
    }
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
      ipcRenderer.invoke('settings:resetShowShortcut'),
    setStartView: (value: AppStartView): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setStartView', value),
    setWindowSize: (value: AppWindowSize): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setWindowSize', value)
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
  home: {
    /** 推荐页传 { view: 'display' }（默认），控制台「推荐」页不传，要完整数据 */
    get: (options?: { view?: HomeFeedView }): Promise<HomeFeedResult> =>
      ipcRenderer.invoke('home:get', options),
    addPoster: (videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:posters:add', videoId),
    updatePoster: (videoId: number, patch: HomeItemPatch): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:posters:update', videoId, patch),
    removePoster: (videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:posters:remove', videoId),
    reorderPosters: (videoIds: number[]): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:posters:reorder', videoIds),
    saveSection: (categoryId: string, patch: HomeSectionPatch): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:save', categoryId, patch),
    addSectionItem: (categoryId: string, videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:addItem', categoryId, videoId),
    updateSectionItem: (
      categoryId: string,
      videoId: number,
      patch: HomeItemPatch
    ): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:updateItem', categoryId, videoId, patch),
    removeSectionItem: (categoryId: string, videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:removeItem', categoryId, videoId),
    restoreSectionItem: (categoryId: string, videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:restoreItem', categoryId, videoId),
    reorderSectionItems: (categoryId: string, videoIds: number[]): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:reorder', categoryId, videoIds),
    clearSectionItems: (categoryId: string): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:clear', categoryId),
    getSearch: (): Promise<HomeSearchResult> => ipcRenderer.invoke('home:search:get'),
    saveSearch: (patch: HomeSearchPatch): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:search:save', patch),
    addSearchItem: (videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:search:addItem', videoId),
    updateSearchItem: (videoId: number, patch: HomeItemPatch): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:search:updateItem', videoId, patch),
    removeSearchItem: (videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:search:removeItem', videoId),
    restoreSearchItem: (videoId: number): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:search:restoreItem', videoId),
    reorderSearchItems: (videoIds: number[]): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:search:reorder', videoIds),
    clearSearchItems: (): Promise<HomeActionResult> => ipcRenderer.invoke('home:search:clear'),
    /** 弹系统文件选择框，把选中的图片复制进配置目录，返回 cine-img:// 地址 */
    pickImage: (): Promise<HomeImageResult> => ipcRenderer.invoke('home:image:pick')
  },
  videos: {
    list: (query: VideoListQuery): Promise<VideoListResult> =>
      ipcRenderer.invoke('videos:list', query),
    /** 只问数量、不取行（概览的「隐藏了多少」）：比取一页拿 total 快两个数量级 */
    count: (query: VideoListQuery): Promise<VideoCountResult> =>
      ipcRenderer.invoke('videos:count', query),
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
    /** { sites: false } 跳过按站点分组的统计（概览用不到，能省 100ms 上下） */
    capacity: (options?: { sites?: boolean }): Promise<VideoCapacity> =>
      ipcRenderer.invoke('videos:capacity', options),
    scanCapacity: (options?: { fixMissing?: boolean }): Promise<VideoCapacityScanResult> =>
      ipcRenderer.invoke('videos:capacity:scan', options),
    /** 清掉没有任何来源的视频（容量页的手动修复入口） */
    clearOrphans: (): Promise<VideoOrphanPurgeResult> => ipcRenderer.invoke('videos:orphans:clear'),
    clearDetails: (options?: { siteId?: string }): Promise<DetailClearResult> =>
      ipcRenderer.invoke('videos:details:clear', options),
    /** 删除一个站点的全部缓存数据（来源 / 视频 / 详情 / 进度 / 日志） */
    purgeSite: (input: { siteId: string }): Promise<VideoSitePurgeResult> =>
      ipcRenderer.invoke('videos:site:purge', input),
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
