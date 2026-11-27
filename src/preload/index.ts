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
    /** 是否显示 18+ 内容：关闭时展示端与共享页都看不到标记过的内容 */
    setAllowAdult: (value: boolean): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setAllowAdult', value),
    setShowShortcut: (value: string | null): Promise<SetShortcutResult> =>
      ipcRenderer.invoke('settings:setShowShortcut', value),
    resetShowShortcut: (): Promise<SetShortcutResult> =>
      ipcRenderer.invoke('settings:resetShowShortcut'),
    setStartView: (value: AppStartView): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setStartView', value),
    setWindowSize: (value: AppWindowSize): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setWindowSize', value),
    setDefaultPicSite: (value: string): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setDefaultPicSite', value),
    setCollectConcurrency: (value: number): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:setCollectConcurrency', value),
    setNetwork: (value: NetworkSettings): Promise<SetNetworkResult> =>
      ipcRenderer.invoke('settings:setNetwork', value),
    testNetwork: (input: NetworkTestInput): Promise<NetworkTestResult> =>
      ipcRenderer.invoke('settings:testNetwork', input)
  },
  downloads: {
    list: (): Promise<DownloadRecordView[]> => ipcRenderer.invoke('downloads:list'),
    /** 下载目录占用（文件数 / 字节数）与所在磁盘的容量，设置页的「下载」分区用 */
    usage: (): Promise<{ ok: boolean; usage?: DownloadUsage }> =>
      ipcRenderer.invoke('downloads:usage'),
    /** 用独立播放窗播本机文件；文件被删 / 记录不存在时 ok 为假 */
    play: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('downloads:play', id),
    /** 不带 id：打开下载目录；带 id：在资源管理器里定位这个文件 */
    openFolder: (id?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('downloads:openFolder', id),
    remove: (input: { ids: string[]; deleteFiles?: boolean }): Promise<DownloadRemoveResult> =>
      ipcRenderer.invoke('downloads:remove', input),
    clearFinished: (input?: { deleteFiles?: boolean }): Promise<DownloadRemoveResult> =>
      ipcRenderer.invoke('downloads:clearFinished', input),
    pickPath: (): Promise<{ ok: boolean; canceled?: boolean; path?: string }> =>
      ipcRenderer.invoke('downloads:pickPath'),
    setPath: (value: string): Promise<DownloadPathResult> =>
      ipcRenderer.invoke('downloads:setPath', value),
    setConcurrency: (value: number): Promise<AppSettings> =>
      ipcRenderer.invoke('downloads:setConcurrency', value),
    /** 单集内部的分片并发（1–6），对之后开始的缓存任务生效 */
    setSegmentConcurrency: (value: number): Promise<AppSettings> =>
      ipcRenderer.invoke('downloads:setSegmentConcurrency', value),
    /** 播放页缓存当前集 / 多选批量：主进程按详情解析地址并入队 */
    cache: (input: DownloadCacheInput): Promise<DownloadCacheResult> =>
      ipcRenderer.invoke('downloads:cache', input),
    /** 某部视频已缓存 / 缓存中的集（播放页状态与优先缓存用） */
    cachedEpisodes: (videoId: number): Promise<DownloadCachedEpisodesResult> =>
      ipcRenderer.invoke('downloads:cachedEpisodes', videoId),
    /** 缓存的 hls 包取本机播放地址；文件缺失 / 服务失败时 ok 为假 */
    playbackUrl: (id: string): Promise<DownloadPlaybackResult> =>
      ipcRenderer.invoke('downloads:playbackUrl', id),
    /** 取消一条等待 / 下载中 / 暂停的任务，返回时任务已停下 */
    cancel: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('downloads:cancel', id),
    /** 暂停下载；已下载的分片保留，继续时从断点接着下 */
    pause: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('downloads:pause', id),
    /** 继续暂停的任务，从断点接着下 */
    resume: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('downloads:resume', id),
    /** 用记录里保存的地址重试失败 / 已取消的任务 */
    retry: (id: string): Promise<DownloadRetryResult> => ipcRenderer.invoke('downloads:retry', id),
    /** 把已完成的缓存包导出成 MP4（只换容器，不重编码）；force 覆盖已导出的文件 */
    exportMp4: (input: { ids: string[]; force?: boolean }): Promise<DownloadExportResult> =>
      ipcRenderer.invoke('downloads:exportMp4', input),
    /** 取消排队 / 转换中的 MP4 导出 */
    cancelExport: (ids: string[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('downloads:exportMp4:cancel', ids),
    /** 在文件管理器里定位导出的 MP4 */
    openMp4Folder: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('downloads:openMp4Folder', id),
    /** 删除导出的 MP4，缓存包保留 */
    removeMp4: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('downloads:removeMp4', id),
    /** 记录有增删改时通知（进度不推，避免高频刷新列表） */
    onChange: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('downloads:changed', handler)
      return () => {
        ipcRenderer.removeListener('downloads:changed', handler)
      }
    },
    /** 进度 / 状态更新：按记录 id 就地打补丁，不整页重拉 */
    onProgress: (callback: (record: DownloadRecordView) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, record: DownloadRecordView): void =>
        callback(record)
      ipcRenderer.on('downloads:progress', handler)
      return () => {
        ipcRenderer.removeListener('downloads:progress', handler)
      }
    }
  },
  sites: {
    list: (): Promise<Site[]> => ipcRenderer.invoke('sites:list'),
    add: (input: SiteInput): Promise<AddSiteResult> => ipcRenderer.invoke('sites:add', input),
    update: (id: string, input: SiteInput): Promise<UpdateSiteResult> =>
      ipcRenderer.invoke('sites:update', id, input),
    remove: (id: string): Promise<RemoveSiteResult> => ipcRenderer.invoke('sites:remove', id),
    /** 在线检索自检：真实发一次 wd 请求，只解析不写缓存库 */
    testSearch: (input: { siteId: string; keyword: string }): Promise<SiteSearchTestResult> =>
      ipcRenderer.invoke('sites:search:test', input),
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
    /** 控制台传 { includeAdult: true } 才能看到 18+ 分类（展示端默认看不到） */
    list: (options?: { includeAdult?: boolean }): Promise<VideoCategory[]> =>
      ipcRenderer.invoke('categories:list', options),
    create: (input: VideoCategoryInput): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:create', input),
    update: (id: string, input: VideoCategoryInput): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:update', id, input),
    setVisible: (id: string, visible: boolean): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:setVisible', id, visible),
    /** 切换 18+ 标记：父分类打开后整棵子树都按 18+ 处理 */
    setAdult: (id: string, adult: boolean): Promise<VideoCategoryResult> =>
      ipcRenderer.invoke('categories:setAdult', id, adult),
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
    /** 调整一级分类在推荐页上的先后顺序（控制台「分类推荐」拖动排序） */
    reorderSections: (categoryIds: string[]): Promise<HomeActionResult> =>
      ipcRenderer.invoke('home:sections:reorderCategories', categoryIds),
    getSearch: (options?: { view?: HomeFeedView }): Promise<HomeSearchResult> =>
      ipcRenderer.invoke('home:search:get', options),
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
    detail: (
      videoId: number,
      options?: { autoFetch?: boolean; includeAdult?: boolean }
    ): Promise<VideoDetailResult> => ipcRenderer.invoke('videos:detail', videoId, options),
    refreshDetail: (
      videoId: number,
      options?: { force?: boolean; includeAdult?: boolean }
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
    /** 按选定来源批量重写 videos.pic */
    cleanPics: (input?: { siteId?: string }): Promise<PicCleanResult> =>
      ipcRenderer.invoke('videos:pics:clean', input),
    cancelPicsClean: (): Promise<void> => ipcRenderer.invoke('videos:pics:clean:cancel'),
    onPicsCleanProgress: (callback: (progress: PicCleanProgress) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: PicCleanProgress): void =>
        callback(progress)
      ipcRenderer.on('videos:pics:clean:progress', handler)
      return () => ipcRenderer.removeListener('videos:pics:clean:progress', handler)
    },
    /** 同步任务状态：页面重新进入时回填进度与上次结果 */
    picsCleanStatus: (): Promise<PicCleanStatus> => ipcRenderer.invoke('videos:pics:clean:status'),
    /** 封面规则统计 + 效果抽样；siteId 可以传未保存的候选来源 */
    picsStats: (options?: { siteId?: string }): Promise<PicCleanStats> =>
      ipcRenderer.invoke('videos:pics:stats', options),
    /** 删除一个站点的全部缓存数据（来源 / 视频 / 详情 / 进度 / 日志） */
    purgeSite: (input: { siteId: string }): Promise<VideoSitePurgeResult> =>
      ipcRenderer.invoke('videos:site:purge', input),
    progress: (siteId?: string): Promise<VideoCollectProgress[]> =>
      ipcRenderer.invoke('videos:progress', siteId),
    /** 一键清空采集进度（含检索关键词）；有任务在跑 / 排队时返回 BUSY */
    clearProgress: (): Promise<{ ok: boolean; removed?: number; error?: string }> =>
      ipcRenderer.invoke('videos:progress:clear'),
    /** 展示端搜索页「在线」模式：只查开启在线检索的站点，每站 1 页 20 条，合并排序后返回 */
    searchOnline: (input: { keyword: string }): Promise<VideoOnlineSearchResult> =>
      ipcRenderer.invoke('videos:search:online', input),
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
  lan: {
    state: (): Promise<LanServiceState> => ipcRenderer.invoke('lan:state'),
    start: (input: { host: string; port: number }): Promise<LanStartResult> =>
      ipcRenderer.invoke('lan:start', input),
    stop: (): Promise<LanServiceState> => ipcRenderer.invoke('lan:stop'),
    open: (): Promise<boolean> => ipcRenderer.invoke('lan:open'),
    onChange: (callback: (state: LanServiceState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: LanServiceState): void =>
        callback(state)
      ipcRenderer.on('lan:changed', handler)
      return () => {
        ipcRenderer.removeListener('lan:changed', handler)
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
