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
