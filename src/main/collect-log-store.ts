import type { DatabaseSync } from 'node:sqlite'
import { inTransaction } from './database'
import type { LogLevel, VideoCollectLog } from './video-types'

export interface LogQuery {
  siteId?: string
  level?: LogLevel
  /** 只取该 ISO 时间之后的日志 */
  since?: string
  /** newest：取最新的一批（倒序返回）；oldest：取最早的一批（正序返回） */
  order?: 'newest' | 'oldest'
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
  /**
   * 只入内存队列，不落库、不发事件，调用方（采集主循环）不会被写日志拖慢；
   * 落库与推送在下一个事件循环批次里批量完成，id 到那时才回填
   */
  append: (input: LogAppendInput) => void
  list: (query?: LogQuery) => VideoCollectLog[]
  /** 清空日志，同时丢掉队列里还没落库的部分，避免清空后又被写回来 */
  clear: (siteId?: string) => number
  trim: () => void
  /** 同步写完队列里的日志（退出 / 清空缓存前调用） */
  flush: () => void
}

const MAX_ROWS = 5000
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TRIM_EVERY = 100

const INSERT_LOG = `
INSERT INTO collect_logs (created_at, level, site_id, mode, fetch_range, message, detail)
VALUES (?, ?, ?, ?, ?, ?, ?)
`

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
 * 采集日志：异步批量写入缓存库的 collect_logs，按“最多 5000 行 / 30 天”裁剪。
 * append 只做一次数组 push 并安排下一个事件循环批次落库，采集每页都会写日志，
 * 但写库、裁剪、推事件都不在采集的关键路径上；日志失败不影响采集主流程。
 */
export function createCollectLogStore(
  connection: () => DatabaseSync,
  emit?: (log: VideoCollectLog) => void
): CollectLogStore {
  const pending: VideoCollectLog[] = []
  let scheduled = false
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

  function flush(): void {
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    try {
      // 一批日志一个事务：把 N 次同步写盘压成一次
      inTransaction(connection(), (tx) => {
        const insert = tx.prepare(INSERT_LOG)
        for (const log of batch) {
          const result = insert.run(
            log.createdAt,
            log.level,
            log.siteId,
            log.mode,
            log.fetchRange,
            log.message,
            log.detail
          )
          log.id = Number(result.lastInsertRowid)
        }
      })
      writes += batch.length
      if (writes >= TRIM_EVERY) {
        writes = 0
        trim()
      }
    } catch {
      // 缓存库已关闭 / 正在重建：这批日志只推给界面，不落库
    }
    for (const log of batch) {
      try {
        emit?.(log)
      } catch {
        // 渲染层未就绪 / 已关闭
      }
    }
  }

  function scheduleFlush(): void {
    if (scheduled) return
    scheduled = true
    // setImmediate：等当前同步批次（页面写入事务等）跑完再落库，采集循环不等待
    setImmediate(() => {
      scheduled = false
      flush()
    })
  }

  function append(input: LogAppendInput): void {
    pending.push({
      id: 0,
      createdAt: new Date().toISOString(),
      level: input.level,
      siteId: input.siteId ?? '',
      mode: input.mode ?? '',
      fetchRange: input.fetchRange ?? '',
      message: truncate(String(input.message ?? ''), 500),
      detail: truncate(String(input.detail ?? ''), 2000)
    })
    scheduleFlush()
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
    if (query.since) {
      where.push('created_at >= ?')
      params.push(query.since)
    }
    const dir = query.order === 'oldest' ? 'ASC' : 'DESC'
    const sql = `SELECT * FROM collect_logs
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id ${dir} LIMIT ?`
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
    // 还没落库的日志一起丢掉，否则清空之后又会被 flush 写回来
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (!siteId || pending[index].siteId === siteId) pending.splice(index, 1)
    }
    try {
      const db = connection()
      return siteId
        ? Number(db.prepare('DELETE FROM collect_logs WHERE site_id = ?').run(siteId).changes)
        : Number(db.prepare('DELETE FROM collect_logs').run().changes)
    } catch {
      return 0
    }
  }

  return { append, list, clear, trim, flush }
}
