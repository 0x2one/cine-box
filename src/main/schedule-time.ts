import type { ScheduleTiming } from './video-types'

/** 每天固定时间点的格式：24 小时制 HH:mm */
export const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export function isValidDailyTime(value: string): boolean {
  return DAILY_TIME_PATTERN.test(value)
}

/**
 * 下一次触发时间：按间隔就直接往后推，按每天固定时间点就取最近的 HH:mm。
 * 当天这个点还没到就排今天，已过（或正好到点）就排明天；时间按本地时区算。
 */
export function nextRunAt(
  from: Date,
  timing: ScheduleTiming,
  intervalMinutes: number,
  dailyTime: string
): string {
  if (timing === 'daily' && isValidDailyTime(dailyTime)) {
    const [hour, minute] = dailyTime.split(':').map(Number)
    const next = new Date(from)
    next.setHours(hour, minute, 0, 0)
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }
  return new Date(from.getTime() + intervalMinutes * 60_000).toISOString()
}
