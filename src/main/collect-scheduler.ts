import type { CollectLogStore } from './collect-log-store'
import type { CollectScheduleStore } from './collect-schedule-store'
import { nextRunAt } from './schedule-time'
import type { VideoCollector } from './video-collector'
import type { VideoSchedule } from './video-types'

export interface CollectScheduler {
  start: () => void
  stop: () => void
  /** 立即检查一次到期计划（启动补跑与测试用） */
  tick: () => Promise<void>
}

const TICK_MS = 30_000

/**
 * 定时调度器：每 30 秒查一次到期计划，只负责入队，不直接访问站点。
 * 启动时过期计划只补跑一次；入队失败也推进 next_run_at，避免每 30 秒重试。
 */
export function createCollectScheduler(options: {
  schedules: CollectScheduleStore
  collector: VideoCollector
  logs: CollectLogStore
  /** 站点被禁用时跳过这次定时任务（时间照常推进，不重复触发） */
  isSiteDisabled?: (siteId: string) => boolean
}): CollectScheduler {
  const { schedules, collector, logs } = options
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false
  let running = false

  async function runSchedule(schedule: VideoSchedule): Promise<void> {
    const now = new Date()
    // 先推进时间：即使入队失败也不重复触发
    const next = nextRunAt(now, schedule.timing, schedule.intervalMinutes, schedule.dailyTime)
    schedules.markRun(schedule.siteId, now.toISOString(), next)
    // 站点禁用期间不采集：时间已经推进，重新启用后按自己的节奏继续
    if (options.isSiteDisabled?.(schedule.siteId)) {
      logs.append({
        level: 'warn',
        siteId: schedule.siteId,
        mode: schedule.mode,
        fetchRange: schedule.fetchRange,
        message: '站点已禁用，跳过本次定时采集',
        detail: 'SITE_DISABLED'
      })
      return
    }
    const result = await collector.enqueue(
      {
        siteId: schedule.siteId,
        mode: schedule.mode,
        fetchRange: schedule.fetchRange,
        cacheDetail: schedule.cacheDetail,
        // 保存计划时探测到的真实页大小；0 表示当时没探到，采集器按默认 100
        pageSize: schedule.pageSize || undefined
      },
      'schedule'
    )
    if (!result.ok) {
      logs.append({
        level: 'warn',
        siteId: schedule.siteId,
        mode: schedule.mode,
        fetchRange: schedule.fetchRange,
        message: '定时采集未能入队',
        detail: result.error ?? ''
      })
    }
  }

  async function tick(): Promise<void> {
    if (!running || ticking) return
    ticking = true
    try {
      const due = schedules.due(new Date().toISOString())
      for (const schedule of due) {
        try {
          await runSchedule(schedule)
        } catch {
          logs.append({
            level: 'error',
            siteId: schedule.siteId,
            mode: schedule.mode,
            fetchRange: schedule.fetchRange,
            message: '定时采集触发失败',
            detail: 'SCHEDULE'
          })
        }
      }
    } catch {
      // 计划表读取失败时下一轮再试
    } finally {
      ticking = false
    }
  }

  return {
    start: () => {
      if (timer) return
      running = true
      void tick()
      timer = setInterval(() => void tick(), TICK_MS)
    },
    stop: () => {
      running = false
      if (timer) clearInterval(timer)
      timer = null
    },
    tick
  }
}
