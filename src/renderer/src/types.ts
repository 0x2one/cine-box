/** 主内容区的页面：home 为占位内容区，console / settings 由标题栏进入 */
export type AppView = 'home' | 'console' | 'settings' | 'about'

/** 控制台左侧导航的分区 */
export type ConsoleSection =
  | 'overview'
  | 'sites'
  | 'categories'
  | 'collect'
  | 'progress'
  | 'videos'
  | 'capacity'
  | 'backup'
  | 'logs'
