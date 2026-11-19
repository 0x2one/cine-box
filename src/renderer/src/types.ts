/**
 * 主内容区的页面：home 为展示端首页，browse 为按视频类型浏览的列表页，
 * console / settings 由标题栏进入。
 */
export type AppView = 'home' | 'browse' | 'console' | 'settings' | 'about'

/** 控制台左侧导航的分区 */
export type ConsoleSection =
  | 'overview'
  | 'home'
  | 'sites'
  | 'categories'
  | 'collect'
  | 'progress'
  | 'videos'
  | 'capacity'
  | 'backup'
  | 'logs'
