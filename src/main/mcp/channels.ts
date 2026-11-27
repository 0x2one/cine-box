/**
 * MCP 工具复用主进程既有 IPC 处理逻辑：这里集中登记通道名，
 * 启动时用它校验 handler 是否都已注册，避免工具名里写错字符串。
 */
export const MCP_CHANNELS = {
  sitesList: 'sites:list',
  sitesAdd: 'sites:add',
  sitesUpdate: 'sites:update',
  sitesSearchTest: 'sites:search:test',
  sitesCategories: 'sites:categories',

  categoriesList: 'categories:list',
  categoriesCreate: 'categories:create',
  categoriesUpdate: 'categories:update',
  categoriesMove: 'categories:move',
  categoriesSetAdult: 'categories:setAdult',
  categoriesSetVisible: 'categories:setVisible',

  bindingsForCategory: 'bindings:forCategory',
  bindingsCounts: 'bindings:counts',
  bindingsForSite: 'bindings:forSite',
  bindingsBind: 'bindings:bind',
  bindingsUnbind: 'bindings:unbind',

  collectStart: 'videos:collect:start',
  collectCancel: 'videos:collect:cancel',
  progress: 'videos:progress',
  progressClear: 'videos:progress:clear',
  schedulesList: 'videos:schedules:list',
  schedulesSave: 'videos:schedules:save',
  schedulesRemove: 'videos:schedules:remove',
  setCollectConcurrency: 'settings:setCollectConcurrency',

  videosList: 'videos:list',
  videosDetail: 'videos:detail',
  videosUpdate: 'videos:update',
  downloadsCache: 'downloads:cache',

  homeGet: 'home:get',
  postersAdd: 'home:posters:add',
  postersUpdate: 'home:posters:update',
  postersRemove: 'home:posters:remove',
  postersReorder: 'home:posters:reorder',
  sectionsSave: 'home:sections:save',
  sectionsAddItem: 'home:sections:addItem',
  sectionsUpdateItem: 'home:sections:updateItem',
  sectionsRemoveItem: 'home:sections:removeItem',
  sectionsRestoreItem: 'home:sections:restoreItem',
  sectionsReorder: 'home:sections:reorder',
  sectionsReorderCategories: 'home:sections:reorderCategories',
  searchSave: 'home:search:save',
  searchReorder: 'home:search:reorder',
  searchUpdateItem: 'home:search:updateItem',
  searchRemoveItem: 'home:search:removeItem',
  searchRestoreItem: 'home:search:restoreItem',

  lanState: 'lan:state',
  lanStart: 'lan:start',
  lanStop: 'lan:stop',
  videosCapacity: 'videos:capacity',

  backupCreate: 'backup:create',
  backupRestore: 'backup:restore',
  backupList: 'backup:list',
  logsList: 'videos:logs:list',
  logsClear: 'videos:logs:clear',

  settingsGet: 'settings:get',
  settingsSetNetwork: 'settings:setNetwork',
  settingsTestNetwork: 'settings:testNetwork',
  settingsSetAllowAdult: 'settings:setAllowAdult',

  downloadsUsage: 'downloads:usage',
  downloadsSetPath: 'downloads:setPath',
  downloadsSetConcurrency: 'downloads:setConcurrency',
  downloadsSetSegmentConcurrency: 'downloads:setSegmentConcurrency',
  downloadsList: 'downloads:list',
  downloadsExportMp4: 'downloads:exportMp4'
} as const

/** 去重后的必需通道；启动时与 internalIpcHandlers 对账 */
export const MCP_REQUIRED_CHANNELS = [...new Set(Object.values(MCP_CHANNELS))]
