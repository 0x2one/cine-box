function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 把字节数格式化成易读的容量文本（B / KB / MB / GB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/** 大数字加千位分隔：89564 → 89,564（采集总量这类六位数才看得清） */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.round(value).toLocaleString('zh-CN')
}

/** 统一显示到分钟，备份等需要区分同分钟内的记录时再带上秒 */
export function formatDateTime(iso: string, withSeconds = false): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const minutes = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
  return withSeconds ? `${minutes}:${pad(date.getSeconds())}` : minutes
}

/** 窄位置用的时间戳：同年省略年份（11-18 18:59），跨年才补上年份 */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const rest = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`
  return date.getFullYear() === new Date().getFullYear() ? rest : `${date.getFullYear()}-${rest}`
}

/** 日志行用的紧凑时间：当天只给 23:41:05，跨天补日期（完整时间放 title） */
export function formatLogTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return time
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}-${day} ${time}`
}

/** 计划时间的相对说法：今天 20:00 / 明天 08:30 / 11月20日 09:00；已过期显示「即将执行」 */
export function formatUpcoming(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const now = new Date()
  if (date.getTime() <= now.getTime()) return '即将执行'
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000))
  if (days === 0) return `今天 ${time}`
  if (days === 1) return `明天 ${time}`
  if (days === 2) return `后天 ${time}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}
