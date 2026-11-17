import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { DatabaseSync } from 'node:sqlite'

/** 采集接口输出格式 */
export type SiteFormat = 'xml' | 'json'

export interface Site {
  /** 唯一 ID：UUID 去掉横线（32 位十六进制） */
  id: string
  /** 站点名称 */
  name: string
  /** 显示名称，留空表示沿用名称 */
  display: string
  /** 采集站地址 */
  address: string
  format: SiteFormat
  /** 备注 */
  remark: string
  /** 创建 / 更新时间，ISO 8601 */
  createdAt: string
  updatedAt: string
}

/** 新增站点时由渲染层提交的字段，id 与时间戳由主进程生成 */
export interface SiteInput {
  name: string
  display?: string
  address: string
  format?: SiteFormat
  remark?: string
}

export type SiteError = 'INVALID_NAME' | 'INVALID_ADDRESS' | 'INVALID_FORMAT' | 'NOT_FOUND'

export type SaveSiteResult = { ok: true; site: Site } | { ok: false; error: SiteError }

export type AddSiteResult = SaveSiteResult

export type UpdateSiteResult = SaveSiteResult

export interface RemoveSiteResult {
  ok: boolean
  sites: Site[]
}

/** 采集接口解析出的分类：来源 ID + 名称 */
export interface SiteCategoryInput {
  /** 采集接口返回的分类 ID（苹果 CMS `type_id` / RSS `<ty id>`） */
  id: string
  name: string
}

/** 已入库的视频分类，归属于某个采集站点 */
export interface SiteCategoryRecord {
  /** 主进程生成的 32 位十六进制 ID */
  id: string
  /** 所属站点 ID */
  siteId: string
  /** 采集接口返回的分类 ID，站点内唯一 */
  sourceId: string
  name: string
  /** 创建 / 更新时间，ISO 8601 */
  createdAt: string
  updatedAt: string
}

export interface SiteStore {
  init: () => Promise<void>
  list: () => Site[]
  add: (input: SiteInput) => AddSiteResult
  update: (id: string, input: SiteInput) => UpdateSiteResult
  remove: (id: string) => RemoveSiteResult
  /** 读取站点已保存的视频分类，按入库顺序返回 */
  listCategories: (siteId: string) => SiteCategoryRecord[]
  /** 用本次抓取结果同步分类：已有行保留 id / createdAt，仅名称变化时刷新 updatedAt */
  syncCategories: (siteId: string, categories: SiteCategoryInput[]) => SiteCategoryRecord[]
  /** 关闭数据库连接（应用退出时调用，触发 WAL checkpoint） */
  close: () => void
}

const MAX_NAME = 60
const MAX_REMARK = 200

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'xml',
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sites_created_at ON sites (created_at DESC);
CREATE TABLE IF NOT EXISTS site_categories (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_site_categories_site ON site_categories (site_id);
`

const INSERT_SITE = `
INSERT INTO sites (id, name, display, address, format, remark, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`

const UPDATE_SITE = `
UPDATE sites
SET name = ?, display = ?, address = ?, format = ?, remark = ?, updated_at = ?
WHERE id = ?
`

const SELECT_ALL = `
SELECT id, name, display, address, format, remark, created_at, updated_at
FROM sites
ORDER BY created_at DESC, rowid DESC
`

const SELECT_ONE = `
SELECT id, name, display, address, format, remark, created_at, updated_at
FROM sites
WHERE id = ?
`

const SELECT_CATEGORIES = `
SELECT id, site_id, source_id, name, created_at, updated_at
FROM site_categories
WHERE site_id = ?
ORDER BY rowid
`

/** 同一站点内按来源 ID 去重；名称没变时保留原 updatedAt */
const UPSERT_CATEGORY = `
INSERT INTO site_categories (id, site_id, source_id, name, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (site_id, source_id) DO UPDATE SET
  name = excluded.name,
  updated_at = excluded.updated_at
WHERE site_categories.name <> excluded.name
`

function normalizeFormat(value: unknown): SiteFormat | null {
  if (value === undefined || value === null || value === '') return 'xml'
  const raw = String(value).toLowerCase()
  return raw === 'xml' || raw === 'json' ? raw : null
}

function isHttpAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 兜底修补历史 / 手工改坏的数据，缺字段用默认值补齐 */
function normalizeSite(value: unknown): Site | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Site>
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (typeof raw.name !== 'string' || typeof raw.address !== 'string') return null
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString()
  return {
    id: raw.id,
    name: raw.name,
    display: typeof raw.display === 'string' ? raw.display : '',
    address: raw.address,
    format: raw.format === 'json' ? 'json' : 'xml',
    remark: typeof raw.remark === 'string' ? raw.remark : '',
    createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt
  }
}

/** 数据库行使用 snake_case 列名，先转成 Site 的形状再走同一套兜底逻辑 */
function rowToSite(row: unknown): Site | null {
  if (!row || typeof row !== 'object') return null
  const raw = row as Record<string, unknown>
  return normalizeSite({
    id: raw.id,
    name: raw.name,
    display: raw.display,
    address: raw.address,
    format: raw.format,
    remark: raw.remark,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  })
}

function rowToCategory(row: unknown): SiteCategoryRecord | null {
  if (!row || typeof row !== 'object') return null
  const raw = row as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.site_id !== 'string') return null
  if (typeof raw.source_id !== 'string' || typeof raw.name !== 'string') return null
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString()
  return {
    id: raw.id,
    siteId: raw.site_id,
    sourceId: raw.source_id,
    name: raw.name,
    createdAt,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : createdAt
  }
}

/** 校验并归一化渲染层提交的字段 */
function validateSiteInput(
  input: SiteInput
):
  | { ok: true; value: Omit<Site, 'id' | 'createdAt' | 'updatedAt'> }
  | { ok: false; error: SiteError } {
  const name = String(input?.name ?? '').trim()
  if (!name) return { ok: false, error: 'INVALID_NAME' }
  const address = String(input?.address ?? '').trim()
  if (!isHttpAddress(address)) return { ok: false, error: 'INVALID_ADDRESS' }
  const format = normalizeFormat(input?.format)
  if (!format) return { ok: false, error: 'INVALID_FORMAT' }
  return {
    ok: true,
    value: {
      name: name.slice(0, MAX_NAME),
      display: String(input?.display ?? '')
        .trim()
        .slice(0, MAX_NAME),
      address,
      format,
      remark: String(input?.remark ?? '')
        .trim()
        .slice(0, MAX_REMARK)
    }
  }
}

/** 站点数据存 SQLite，file 为数据库文件绝对路径 */
export function createSiteStore(file: string): SiteStore {
  let db: DatabaseSync | null = null

  function database(): DatabaseSync {
    if (!db) throw new Error('站点数据库尚未初始化')
    return db
  }

  function listSites(): Site[] {
    return database()
      .prepare(SELECT_ALL)
      .all()
      .map(rowToSite)
      .filter((site): site is Site => site !== null)
  }

  function withTransaction(work: (connection: DatabaseSync) => void): void {
    const connection = database()
    connection.exec('BEGIN')
    try {
      work(connection)
      connection.exec('COMMIT')
    } catch (error) {
      connection.exec('ROLLBACK')
      throw error
    }
  }

  function listCategories(siteId: string): SiteCategoryRecord[] {
    return database()
      .prepare(SELECT_CATEGORIES)
      .all(siteId)
      .map(rowToCategory)
      .filter((category): category is SiteCategoryRecord => category !== null)
  }

  /** 以最近一次抓取的结果为准：新增、改名、删除未返回的分类，未变化的行保持原 id 与 createdAt */
  function syncCategories(
    siteId: string,
    categories: SiteCategoryInput[]
  ): SiteCategoryRecord[] {
    const incoming = new Map<string, string>()
    for (const item of categories) {
      const sourceId = String(item?.id ?? '').trim()
      const name = String(item?.name ?? '')
        .trim()
        .slice(0, MAX_NAME)
      // 没有来源 ID 或名称为空的行无法和采集接口对应，直接跳过
      if (!sourceId || !name) continue
      incoming.set(sourceId, name)
    }
    const sourceIds = [...incoming.keys()]
    const now = new Date().toISOString()

    withTransaction((connection) => {
      const upsert = connection.prepare(UPSERT_CATEGORY)
      for (const [sourceId, name] of incoming) {
        upsert.run(randomUUID().replace(/-/g, ''), siteId, sourceId, name, now, now)
      }
      if (sourceIds.length === 0) {
        connection.prepare('DELETE FROM site_categories WHERE site_id = ?').run(siteId)
        return
      }
      const placeholders = sourceIds.map(() => '?').join(', ')
      connection
        .prepare(
          `DELETE FROM site_categories WHERE site_id = ? AND source_id NOT IN (${placeholders})`
        )
        .run(siteId, ...sourceIds)
    })

    return listCategories(siteId)
  }

  return {
    init: async () => {
      if (db) return
      mkdirSync(dirname(file), { recursive: true })
      const database = new DatabaseSync(file, { timeout: 5000 })
      try {
        // WAL 兼顾读写并发与崩溃恢复；NORMAL 在 WAL 下不会丢已提交事务
        database.exec('PRAGMA journal_mode = WAL')
        database.exec('PRAGMA synchronous = NORMAL')
        database.exec(CREATE_TABLE)
        db = database
      } catch (error) {
        db = null
        try {
          database.close()
        } catch {
          // 打开阶段失败的连接无需再处理
        }
        throw error
      }
    },
    list: listSites,
    add: (input) => {
      const checked = validateSiteInput(input)
      if (!checked.ok) return checked
      const now = new Date().toISOString()
      const site: Site = {
        id: randomUUID().replace(/-/g, ''),
        ...checked.value,
        createdAt: now,
        updatedAt: now
      }
      database()
        .prepare(INSERT_SITE)
        .run(
          site.id,
          site.name,
          site.display,
          site.address,
          site.format,
          site.remark,
          site.createdAt,
          site.updatedAt
        )
      return { ok: true, site }
    },
    update: (id, input) => {
      const existing = rowToSite(database().prepare(SELECT_ONE).get(id))
      if (!existing) return { ok: false, error: 'NOT_FOUND' }
      const checked = validateSiteInput(input)
      if (!checked.ok) return checked
      const site: Site = {
        ...existing,
        ...checked.value,
        updatedAt: new Date().toISOString()
      }
      database()
        .prepare(UPDATE_SITE)
        .run(
          site.name,
          site.display,
          site.address,
          site.format,
          site.remark,
          site.updatedAt,
          site.id
        )
      return { ok: true, site }
    },
    remove: (id) => {
      let removed = false
      withTransaction((connection) => {
        // 显式清理子表，避免依赖连接上的 foreign_keys 开关
        connection.prepare('DELETE FROM site_categories WHERE site_id = ?').run(id)
        const result = connection.prepare('DELETE FROM sites WHERE id = ?').run(id)
        removed = Number(result.changes) > 0
      })
      return { ok: removed, sites: listSites() }
    },
    listCategories,
    syncCategories,
    close: () => {
      if (!db) return
      try {
        db.close()
      } catch {
        // 已关闭或关闭失败都不影响退出流程
      }
      db = null
    }
  }
}
