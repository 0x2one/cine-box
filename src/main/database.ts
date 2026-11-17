import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 同一个库文件只保留一个连接。站点、视频分类等模块各自持有一份 store，
 * 但都通过这里取连接，避免多连接互相锁表。
 */
const connections = new Map<string, DatabaseSync>()

/** 打开（或复用）数据库连接，并统一设置 WAL 与同步级别 */
export function openDatabase(file: string): DatabaseSync {
  const existing = connections.get(file)
  if (existing) return existing

  // 首次运行时 Data 目录还不存在
  mkdirSync(dirname(file), { recursive: true })
  const database = new DatabaseSync(file, { timeout: 5000 })
  try {
    // WAL 兼顾读写并发与崩溃恢复；NORMAL 在 WAL 下不会丢已提交事务
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
    // node:sqlite 默认就开着外键，这里显式声明，保证级联清理（删站点 / 删分类）不依赖默认值
    database.exec('PRAGMA foreign_keys = ON')
  } catch (error) {
    try {
      database.close()
    } catch {
      // 打开阶段失败的连接无需再处理
    }
    throw error
  }
  connections.set(file, database)
  return database
}

/** 关闭连接，触发 WAL checkpoint 并清掉 -wal / -shm 附属文件 */
export function closeDatabase(file: string): void {
  const database = connections.get(file)
  if (!database) return
  connections.delete(file)
  try {
    database.close()
  } catch {
    // 已关闭或关闭失败都不影响退出流程
  }
}

/** 把一组写操作包进事务，失败时回滚 */
export function inTransaction(
  database: DatabaseSync,
  work: (connection: DatabaseSync) => void
): void {
  database.exec('BEGIN')
  try {
    work(database)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
