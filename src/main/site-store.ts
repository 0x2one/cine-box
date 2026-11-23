import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { closeDatabase, inTransaction, openDatabase } from './database'

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
  /**
   * 是否支持在线检索：开启后展示端搜索页可以切到「在线」，用采集接口的
   * `wd` 参数按片名检索，并在控制台「采集」里多出一种「检索」采集方式。
   */
  onlineSearch: boolean
  /**
   * 是否禁用：禁用后仍然可以编辑，但不再采集、不再参与搜索（本地 / 在线）、
   * 推荐页与列表页也不再显示只属于它的视频；它的缓存数据保留，重新启用即恢复。
   */
  disabled: boolean
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
  onlineSearch?: boolean
  disabled?: boolean
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

/** 新增 / 消失的分类 */
export interface SiteCategoryChange {
  /** 采集接口返回的分类 ID */
  sourceId: string
  name: string
}

/** 来源 ID 不变、名称变化的分类 */
export interface SiteCategoryRename {
  sourceId: string
  /** 库内原名称 */
  from: string
  /** 本次抓取的新名称 */
  to: string
}

/** 重新抓取后与库内数据的差异，未写入前仅供确认弹窗展示 */
export interface SiteCategoryDiff {
  /** 库中没有、本次新增 */
  added: SiteCategoryChange[]
  /** 库中有、本次未返回（增量更新时保留） */
  removed: SiteCategoryChange[]
  /** 来源 ID 相同但名称变化 */
  renamed: SiteCategoryRename[]
}

/** 全量更新：以本次抓取为准（删除未返回的分类）；增量更新：只新增和改名 */
export type CategoryUpdateMode = 'incremental' | 'full'

export interface SiteStore {
  init: () => Promise<void>
  list: () => Site[]
  add: (input: SiteInput) => AddSiteResult
  update: (id: string, input: SiteInput) => UpdateSiteResult
  remove: (id: string) => RemoveSiteResult
  /** 读取站点已保存的视频分类，按入库顺序返回 */
  listCategories: (siteId: string) => SiteCategoryRecord[]
  /** 计算本次抓取结果与库内分类的差异，不写库 */
  previewCategories: (siteId: string, categories: SiteCategoryInput[]) => SiteCategoryDiff
  /** 按指定方式写入：已有行保留 id / createdAt，仅名称变化时刷新 updatedAt */
  applyCategories: (
    siteId: string,
    categories: SiteCategoryInput[],
    mode: CategoryUpdateMode
  ) => SiteCategoryRecord[]
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
  online_search INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
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
INSERT INTO sites (id, name, display, address, format, remark, online_search, disabled, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const UPDATE_SITE = `
UPDATE sites
SET name = ?, display = ?, address = ?, format = ?, remark = ?, online_search = ?, disabled = ?, updated_at = ?
WHERE id = ?
`

const SELECT_ALL = `
SELECT id, name, display, address, format, remark, online_search, disabled, created_at, updated_at
FROM sites
ORDER BY created_at DESC, rowid DESC
`

const SELECT_ONE = `
SELECT id, name, display, address, format, remark, online_search, disabled, created_at, updated_at
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

/**
 * 两个采集地址是不是同一个站点：只比 host（含端口）。
 * 同一个域名下改路径、补结尾斜杠、切 http/https 通常只是笔误，缓存仍然可信；
 * 解析不出来的地址一律当作换了站点，宁可多清一次。
 */
export function isSameSiteHost(left: string, right: string): boolean {
  try {
    return new URL(left).host === new URL(right).host
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
    onlineSearch: raw.onlineSearch === true,
    disabled: raw.disabled === true,
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
    onlineSearch: Number(raw.online_search ?? 0) !== 0,
    disabled: Number(raw.disabled ?? 0) !== 0,
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

/** 去重、去空并截断名称，保持采集接口返回的顺序 */
function normalizeCategories(categories: SiteCategoryInput[]): Map<string, string> {
  const normalized = new Map<string, string>()
  for (const item of categories) {
    const sourceId = String(item?.id ?? '').trim()
    const name = String(item?.name ?? '')
      .trim()
      .slice(0, MAX_NAME)
    // 没有来源 ID 或名称为空的行无法和采集接口对应，直接跳过
    if (!sourceId || !name) continue
    normalized.set(sourceId, name)
  }
  return normalized
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
        .slice(0, MAX_REMARK),
      onlineSearch: Boolean(input?.onlineSearch),
      disabled: Boolean(input?.disabled)
    }
  }
}

// 后加列：老库补上（新库建表时已经有了），保持迁移幂等
const LATE_COLUMNS = [
  { name: 'online_search', ddl: 'online_search INTEGER NOT NULL DEFAULT 0' },
  { name: 'disabled', ddl: 'disabled INTEGER NOT NULL DEFAULT 0' }
]

function migrate(connection: DatabaseSync): void {
  const columns = connection.prepare('PRAGMA table_info(sites)').all() as Record<string, unknown>[]
  const existing = new Set(columns.map((column) => String(column.name)))
  for (const column of LATE_COLUMNS) {
    if (existing.has(column.name)) continue
    connection.exec(`ALTER TABLE sites ADD COLUMN ${column.ddl}`)
  }
}

/** 站点数据存 SQLite，file 为数据库文件绝对路径（与其它模块共用同一个连接） */
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

  function listCategories(siteId: string): SiteCategoryRecord[] {
    return database()
      .prepare(SELECT_CATEGORIES)
      .all(siteId)
      .map(rowToCategory)
      .filter((category): category is SiteCategoryRecord => category !== null)
  }

  /** 本次抓取结果里读不出来源 ID / 名称的行无法与库对应，直接跳过 */
  function previewCategories(siteId: string, categories: SiteCategoryInput[]): SiteCategoryDiff {
    const incoming = normalizeCategories(categories)
    const stored = new Map(listCategories(siteId).map((row) => [row.sourceId, row]))
    const diff: SiteCategoryDiff = { added: [], removed: [], renamed: [] }

    for (const [sourceId, name] of incoming) {
      const row = stored.get(sourceId)
      if (!row) {
        diff.added.push({ sourceId, name })
      } else if (row.name !== name) {
        diff.renamed.push({ sourceId, from: row.name, to: name })
      }
    }
    for (const row of stored.values()) {
      if (!incoming.has(row.sourceId)) diff.removed.push({ sourceId: row.sourceId, name: row.name })
    }
    return diff
  }

  /** 增量只写新增 / 改名；全量还会删除本次未返回的分类 */
  function applyCategories(
    siteId: string,
    categories: SiteCategoryInput[],
    mode: CategoryUpdateMode
  ): SiteCategoryRecord[] {
    const incoming = normalizeCategories(categories)
    const sourceIds = [...incoming.keys()]
    const now = new Date().toISOString()

    inTransaction(database(), (connection) => {
      const upsert = connection.prepare(UPSERT_CATEGORY)
      for (const [sourceId, name] of incoming) {
        upsert.run(randomUUID().replace(/-/g, ''), siteId, sourceId, name, now, now)
      }
      if (mode === 'incremental') return
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
      const connection = openDatabase(file)
      try {
        connection.exec(CREATE_TABLE)
        migrate(connection)
        db = connection
      } catch (error) {
        db = null
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
          site.onlineSearch ? 1 : 0,
          site.disabled ? 1 : 0,
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
          site.onlineSearch ? 1 : 0,
          site.disabled ? 1 : 0,
          site.updatedAt,
          site.id
        )
      return { ok: true, site }
    },
    remove: (id) => {
      let removed = false
      inTransaction(database(), (connection) => {
        // 显式清理子表，避免依赖连接上的 foreign_keys 开关
        connection.prepare('DELETE FROM site_categories WHERE site_id = ?').run(id)
        const result = connection.prepare('DELETE FROM sites WHERE id = ?').run(id)
        removed = Number(result.changes) > 0
      })
      return { ok: removed, sites: listSites() }
    },
    listCategories,
    previewCategories,
    applyCategories,
    close: () => {
      closeDatabase(file)
      db = null
    }
  }
}
