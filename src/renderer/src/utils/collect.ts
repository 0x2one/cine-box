/** 采集相关文案与格式化：进度、采集、概览三个分区共用，避免各写一份 */

/** 采集状态文案 */
export const COLLECT_STATUS_TEXT: Record<CollectStatus, string> = {
  idle: '未采集',
  queued: '排队中',
  running: '采集中',
  paused: '已暂停',
  replacing: '全量替换中',
  done: '已完成',
  error: '出错'
}

/** 发起采集失败时的错误文案：采集、进度两处共用 */
export const COLLECT_ERRORS: Record<string, string> = {
  ALREADY_QUEUED: '同一模式与采集方式已在队列中，请稍后查看进度',
  INVALID_INPUT: '采集参数不合法',
  NOT_FOUND: '站点不存在，可能已被删除',
  CACHE_UNAVAILABLE: '缓存库不可用，请重启应用后重试',
  BUSY: '缓存正在清理，请稍后再试'
}

/** 采集状态对应的 antd Tag 颜色 */
export const COLLECT_STATUS_COLOR: Record<CollectStatus, string> = {
  idle: 'default',
  queued: 'processing',
  running: 'processing',
  paused: 'warning',
  replacing: 'processing',
  done: 'success',
  error: 'error'
}

/** 列表排序权重：越靠前越需要关注 */
export const COLLECT_STATUS_ORDER: Record<CollectStatus, number> = {
  running: 0,
  replacing: 1,
  queued: 2,
  error: 3,
  paused: 4,
  idle: 5,
  done: 6
}

/** 间隔的短说明：30 分钟 / 6 小时 / 1.5 小时 */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`
}

/** 定时方式的短说明：每天 20:00 / 每 6 小时 */
export function formatScheduleTiming(
  schedule: Pick<VideoSchedule, 'timing' | 'intervalMinutes' | 'dailyTime'>
): string {
  return schedule.timing === 'daily'
    ? `每天 ${schedule.dailyTime}`
    : `每 ${formatInterval(schedule.intervalMinutes)}`
}

/** 站点显示名；拿不到站点（已删除）时退化到 ID 前缀 */
export function siteLabel(site: Site | undefined | null, siteId = ''): string {
  if (site) return site.display || site.name
  return `已删除站点 ${siteId.slice(0, 8)}`
}

/** 采集进度主键：站点 + 模式 + 采集方式，与主进程 collect_progress.id 保持一致 */
export function collectProgressKey(
  siteId: string,
  mode: CollectMode,
  fetchRange: FetchRange
): string {
  return `${siteId}:${mode}:${fetchRange}`
}

/** 暂停 / 出错的任务既有断点也有失败页：可以接着采，也可以清空进度重来 */
export function isResumableStatus(status: CollectStatus): boolean {
  return status === 'paused' || status === 'error'
}

/** 上次手动采集是否勾了「同时生成详情缓存」 */
export const MANUAL_CACHE_DETAIL_KEY = 'collect-manual-cache-detail'

/** 手动采集的详情缓存选择；没记录过就按勾选处理（与采集弹窗默认值一致） */
export function manualCacheDetail(): boolean {
  return localStorage.getItem(MANUAL_CACHE_DETAIL_KEY) !== '0'
}
