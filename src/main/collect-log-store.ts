import type { DatabaseSync } from 'node:sqlite'
import type { LogLevel, VideoCollectLog } from './video-types'

export interface LogQuery {
  siteId?: string
  level?: LogLevel
  beforeId?: number
  limit?: number
}

export interface LogAppendInput {
  level: LogLevel
  siteId?: string
  mode?: string
  fetchRange?: string
  message: string
  detail?: string
}

export interface CollectLogStore {
  append: (input: LogAppendInput) => VideoCollectLog
  list: (query?: LogQuery) => VideoCollectLog[]
  clear: (siteId?: string) => number
  trim: () => void
}

const MAX_ROWS = 5000
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TRIM_EVERY = 100

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function rowToLog(row: Record<string, unknown>): VideoCollectLog {
  return {
    id: Number(row.id) || 0,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    level: row.level === 'warn' || row.level === 'error' ? row.level : 'info',
    siteId: typeof row.site_id === 'string' ? row.site_id : '',
    mode: typeof row.mode === 'string' ? row.mode : '',
    fetchRange: typeof row.fetch_range === 'string' ? row.fetch_range : '',
    message: typeof row.message === 'string' ? row.message : '',
    detail: typeof row.detail === 'string' ? row.detail : ''
  }
}

/**
 * 采集日志：写入缓存库的 collect_logs，按“最多 5000 行 / 30 天”裁剪；
 * 新日志通过 emit 实时推给渲染层，日志失败不影响采集主流程。
 */
export function createCollectLogStore(
  connection: () => DatabaseSync,
  emit?: (log: VideoCollectLog) => void
): CollectLogStore {
  let writes = 0

  function trim(): void {
    try {
      const db = connection()
      const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString()
      db.prepare('DELETE FROM collect_logs WHERE created_at < ?').run(cutoff)
      db.prepare(
        `DELETE FROM collect_logs
         WHERE id NOT IN (SELECT id FROM collect_logs ORDER BY id DESC LIMIT ?)`
      ).run(MAX_ROWS)
    } catch {
      // 日志裁剪失败不影响采集
    }
  }

  function append(input: LogAppendInput): VideoCollectLog {
    const log: VideoCollectLog = {
      id: 0,
      createdAt: new Date().toISOString(),
      level: input.level,
      siteId: input.siteId ?? '',
      mode: input.mode ?? '',
      fetchRange: input.fetchRange ?? '',
      message: truncate(String(input.message ?? ''), 500),
      detail: truncate(String(input.detail ?? ''), 2000)
    }
    try {
      const db = connection()
      const result = db
        .prepare(
          `INSERT INTO collect_logs
             (created_at, level, site_id, mode, fetch_range, message, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          log.createdAt,
          log.level,
          log.siteId,
          log.mode,
          log.fetchRange,
          log.message,
          log.detail
        )
      log.id = Number(result.lastInsertRowid)
      writes += 1
      if (writes % TRIM_EVERY === 0) trim()
    } catch {
      // 写日志失败时仍然把日志交给界面，别因为日志表异常中断采集
    }
    try {
      emit?.(log)
    } catch {
      // 渲染层未就绪 / 已关闭
    }
    return log
  }

  function list(query: LogQuery = {}): VideoCollectLog[] {
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500)
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.siteId) {
      where.push('site_id = ?')
      params.push(query.siteId)
    }
    if (query.level === 'info' || query.level === 'warn' || query.level === 'error') {
      where.push('level = ?')
      params.push(query.level)
    }
    if (query.beforeId && query.beforeId > 0) {
      where.push('id < ?')
      params.push(query.beforeId)
    }
    const sql = `SELECT * FROM collect_logs
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ?`
    try {
      return (
        connection()
          .prepare(sql)
          .all(...params, limit) as Record<string, unknown>[]
      ).map(rowToLog)
    } catch {
      return []
    }
  }

  function clear(siteId?: string): number {
    try {
      const db = connection()
      return siteId
        ? Number(db.prepare('DELETE FROM collect_logs WHERE site_id = ?').run(siteId).changes)
        : Number(db.prepare('DELETE FROM collect_logs').run().changes)
    } catch {
      return 0
    }
  }

  return { append, list, clear, trim }
}
