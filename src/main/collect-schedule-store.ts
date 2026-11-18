import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './database'
import { isValidDailyTime, nextRunAt } from './schedule-time'
import { clampPageSize } from './video-collect-probe'
import type {
  CollectMode,
  FetchRange,
  ScheduleTiming,
  VideoSchedule,
  VideoScheduleInput
} from './video-types'

export type ScheduleError = 'INVALID_INPUT' | 'NOT_FOUND'

export interface ScheduleResult {
  ok: boolean
  error?: ScheduleError
  schedule?: VideoSchedule
}

export interface CollectScheduleStore {
  init: () => Promise<void>
  list: () => VideoSchedule[]
  get: (siteId: string) => VideoSchedule | null
  save: (input: VideoScheduleInput) => ScheduleResult
  remove: (siteId: string) => boolean
  /** 到点未执行的计划 */
  due: (now: string) => VideoSchedule[]
  /** 触发后推进时间：无论入队成功与否都调用，避免每 30 秒重复尝试 */
  markRun: (siteId: string, lastRunAt: string, nextRunAt: string) => void
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS collect_schedules (
  site_id TEXT PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
  fetch_range TEXT NOT NULL DEFAULT '24h' CHECK (fetch_range IN ('all', '24h', '48h')),
  timing TEXT NOT NULL DEFAULT 'interval',
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes >= 5),
  daily_time TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  cache_detail INTEGER NOT NULL DEFAULT 0,
  page_size INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collect_schedules_due
  ON collect_schedules (enabled, next_run_at);
`

const SELECT_ALL = `
SELECT site_id, mode, fetch_range, timing, interval_minutes, daily_time, enabled, cache_detail,
       page_size, next_run_at, last_run_at, created_at, updated_at
FROM collect_schedules
ORDER BY created_at ASC, rowid ASC
`

function rowToSchedule(row: Record<string, unknown>): VideoSchedule {
  return {
    siteId: String(row.site_id ?? ''),
    mode: row.mode === 'full' ? 'full' : 'incremental',
    fetchRange: row.fetch_range === '24h' || row.fetch_range === '48h' ? row.fetch_range : 'all',
    timing: row.timing === 'daily' ? 'daily' : 'interval',
    intervalMinutes: Number(row.interval_minutes) || 360,
    dailyTime: String(row.daily_time ?? ''),
    enabled: Number(row.enabled) !== 0,
    cacheDetail: Number(row.cache_detail) !== 0,
    pageSize: Number(row.page_size) || 0,
    nextRunAt: String(row.next_run_at ?? ''),
    lastRunAt: String(row.last_run_at ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  }
}

/** 老库补列：这些字段都是后来加的，按 pragma_table_info 幂等迁移 */
const LATE_COLUMNS = [
  { name: 'cache_detail', ddl: 'cache_detail INTEGER NOT NULL DEFAULT 0' },
  { name: 'timing', ddl: "timing TEXT NOT NULL DEFAULT 'interval'" },
  { name: 'daily_time', ddl: "daily_time TEXT NOT NULL DEFAULT ''" },
  { name: 'page_size', ddl: 'page_size INTEGER NOT NULL DEFAULT 0' }
]

function migrate(connection: DatabaseSync): void {
  const columns = connection.prepare('PRAGMA table_info(collect_schedules)').all() as Record<
    string,
    unknown
  >[]
  const existing = new Set(columns.map((column) => String(column.name)))
  for (const column of LATE_COLUMNS) {
    if (existing.has(column.name)) continue
    connection.exec(`ALTER TABLE collect_schedules ADD COLUMN ${column.ddl}`)
  }
}

function intervalOf(value: unknown): number {
  const numeric = Math.floor(Number(value))
  if (!Number.isFinite(numeric)) return 0
  return numeric
}

/** 定时采集计划：用户配置，存业务库，不随视频缓存清理而丢失 */
export function createCollectScheduleStore(file: string): CollectScheduleStore {
  let db: DatabaseSync | null = null

  function database(): DatabaseSync {
    if (!db) throw new Error('采集计划数据库尚未初始化')
    return db
  }

  function list(): VideoSchedule[] {
    return (database().prepare(SELECT_ALL).all() as Record<string, unknown>[]).map(rowToSchedule)
  }

  function get(siteId: string): VideoSchedule | null {
    const row = database()
      .prepare(
        `SELECT site_id, mode, fetch_range, timing, interval_minutes, daily_time, enabled,
                cache_detail, page_size, next_run_at, last_run_at, created_at, updated_at
         FROM collect_schedules WHERE site_id = ?`
      )
      .get(siteId) as Record<string, unknown> | undefined
    return row ? rowToSchedule(row) : null
  }

  function save(input: VideoScheduleInput): ScheduleResult {
    const siteId = String(input?.siteId ?? '').trim()
    if (!siteId) return { ok: false, error: 'INVALID_INPUT' }
    if (input?.mode !== 'incremental' && input?.mode !== 'full') {
      return { ok: false, error: 'INVALID_INPUT' }
    }
    if (input?.fetchRange !== 'all' && input?.fetchRange !== '24h' && input?.fetchRange !== '48h') {
      return { ok: false, error: 'INVALID_INPUT' }
    }
    const mode: CollectMode = input.mode
    const fetchRange: FetchRange = input.fetchRange
    // 全量模式只对全量范围有意义，24h/48h 组合直接拒绝
    if (mode === 'full' && fetchRange !== 'all') return { ok: false, error: 'INVALID_INPUT' }
    const interval = intervalOf(input?.intervalMinutes)
    if (interval < 5) return { ok: false, error: 'INVALID_INPUT' }
    const intervalMinutes = Math.min(interval, 10080)
    const timing: ScheduleTiming = input?.timing === 'daily' ? 'daily' : 'interval'
    const dailyTime = timing === 'daily' ? String(input?.dailyTime ?? '').trim() : ''
    if (timing === 'daily' && !isValidDailyTime(dailyTime)) {
      return { ok: false, error: 'INVALID_INPUT' }
    }

    const connection = database()
    const site = connection.prepare('SELECT id FROM sites WHERE id = ?').get(siteId)
    if (!site) return { ok: false, error: 'NOT_FOUND' }

    const now = new Date().toISOString()
    const enabled = Boolean(input.enabled)
    const cacheDetail = Boolean(input.cacheDetail)
    // 主进程探测后带进来；0 表示未知（探测失败且没有历史值）
    const pageSize = clampPageSize(input.pageSize)
    const next = enabled ? nextRunAt(new Date(), timing, intervalMinutes, dailyTime) : ''
    const existing = get(siteId)
    connection
      .prepare(
        `INSERT INTO collect_schedules
           (site_id, mode, fetch_range, timing, interval_minutes, daily_time, enabled, cache_detail,
            page_size, next_run_at, last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id) DO UPDATE SET
           mode = excluded.mode,
           fetch_range = excluded.fetch_range,
           timing = excluded.timing,
           interval_minutes = excluded.interval_minutes,
           daily_time = excluded.daily_time,
           enabled = excluded.enabled,
           cache_detail = excluded.cache_detail,
           page_size = excluded.page_size,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`
      )
      .run(
        siteId,
        mode,
        fetchRange,
        timing,
        intervalMinutes,
        dailyTime,
        enabled ? 1 : 0,
        cacheDetail ? 1 : 0,
        pageSize,
        next,
        existing?.lastRunAt ?? '',
        existing?.createdAt ?? now,
        now
      )
    return { ok: true, schedule: get(siteId) ?? undefined }
  }

  function remove(siteId: string): boolean {
    return (
      Number(
        database().prepare('DELETE FROM collect_schedules WHERE site_id = ?').run(siteId).changes
      ) > 0
    )
  }

  function due(now: string): VideoSchedule[] {
    return (
      database()
        .prepare(
          `SELECT site_id, mode, fetch_range, timing, interval_minutes, daily_time, enabled,
                  cache_detail, page_size, next_run_at, last_run_at, created_at, updated_at
           FROM collect_schedules
           WHERE enabled = 1 AND next_run_at <> '' AND next_run_at <= ?
           ORDER BY next_run_at ASC`
        )
        .all(now) as Record<string, unknown>[]
    ).map(rowToSchedule)
  }

  function markRun(siteId: string, lastRunAt: string, nextRunAt: string): void {
    database()
      .prepare(
        'UPDATE collect_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE site_id = ?'
      )
      .run(lastRunAt, nextRunAt, new Date().toISOString(), siteId)
  }

  return {
    init: async () => {
      if (db) return
      const connection = openDatabase(file)
      connection.exec(CREATE_TABLE)
      migrate(connection)
      db = connection
    },
    list,
    get,
    save,
    remove,
    due,
    markRun
  }
}
