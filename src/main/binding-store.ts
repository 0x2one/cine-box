import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { closeDatabase, inTransaction, openDatabase } from './database'

/** 绑定定位：站点的某个在线分类，唯一键是这两个字段的组合 */
export interface BindingTarget {
  siteId: string
  siteCategoryId: string
}

/** 某个本地分类已绑定的在线分类，分类页只读列表用 */
export interface CategoryBinding {
  /** category_bindings.id */
  id: string
  siteId: string
  /** 站点显示名（display 为空时取 name） */
  siteName: string
  siteCategoryId: string
  /** 采集接口返回的分类 ID */
  sourceId: string
  /** 在线分类名，读取时 join 取最新值 */
  name: string
  createdAt: string
}

/** 站点分类弹窗用的绑定状态，只返回已绑定的在线分类 */
export interface SiteCategoryBinding {
  siteCategoryId: string
  /** 绑定的本地分类 */
  categoryId: string
  /** 本地分类完整路径，如「电影 / 动作片」 */
  categoryPath: string
}

export type BindingError = 'INVALID_INPUT' | 'NOT_FOUND'

export interface BindingResult {
  ok: boolean
  error?: BindingError
}

export interface BindingStore {
  init: () => Promise<void>
  /** 某个站点已绑定的在线分类，按站点分类的入库顺序返回 */
  forSite: (siteId: string) => SiteCategoryBinding[]
  /** 某个本地分类已绑定的在线分类，按站点名、在线分类名排序 */
  forCategory: (categoryId: string) => CategoryBinding[]
  /** 每个本地分类的绑定数量，未绑定的分类不出现 */
  counts: () => Record<string, number>
  /** 把一批在线分类绑到指定本地分类，已绑定的直接改绑 */
  bind: (items: BindingTarget[], categoryId: string) => BindingResult
  unbind: (items: BindingTarget[]) => BindingResult
  close: () => void
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS category_bindings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  site_category_id TEXT NOT NULL REFERENCES site_categories (id) ON DELETE CASCADE,
  video_category_id TEXT NOT NULL REFERENCES video_categories (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, site_category_id)
);
CREATE INDEX IF NOT EXISTS idx_category_bindings_video ON category_bindings (video_category_id);
`

const SELECT_SITE_BINDINGS = `
SELECT sc.id AS site_category_id, b.video_category_id AS video_category_id
FROM category_bindings AS b
JOIN site_categories AS sc ON sc.id = b.site_category_id
WHERE b.site_id = ?
ORDER BY sc.rowid
`

const SELECT_CATEGORY_BINDINGS = `
SELECT b.id AS id, b.site_id AS site_id, b.site_category_id AS site_category_id,
       b.created_at AS created_at, s.name AS site_name, s.display AS site_display,
       sc.source_id AS source_id, sc.name AS category_name
FROM category_bindings AS b
JOIN site_categories AS sc ON sc.id = b.site_category_id
JOIN sites AS s ON s.id = b.site_id
WHERE b.video_category_id = ?
ORDER BY s.name, sc.name
`

const SELECT_COUNTS = `
SELECT video_category_id AS id, COUNT(*) AS total
FROM category_bindings
GROUP BY video_category_id
`

const SELECT_CATEGORY_TREE = 'SELECT id, parent_id, name FROM video_categories'

const SELECT_CATEGORY = 'SELECT id FROM video_categories WHERE id = ?'

const SELECT_SITE_CATEGORY = 'SELECT site_id FROM site_categories WHERE id = ?'

const UPSERT_BINDING = `
INSERT INTO category_bindings (id, site_id, site_category_id, video_category_id, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (site_id, site_category_id) DO UPDATE SET
  video_category_id = excluded.video_category_id,
  updated_at = excluded.updated_at
WHERE category_bindings.video_category_id <> excluded.video_category_id
`

const DELETE_BINDING = 'DELETE FROM category_bindings WHERE site_id = ? AND site_category_id = ?'

interface CategoryNameRow {
  id: string
  parentId: string | null
  name: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 去重并剔掉不合法的定位，空数组表示调用方没给有效输入 */
function normalizeTargets(items: BindingTarget[]): BindingTarget[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const targets: BindingTarget[] = []
  for (const item of items) {
    const siteId = text(item?.siteId).trim()
    const siteCategoryId = text(item?.siteCategoryId).trim()
    if (!siteId || !siteCategoryId) continue
    const key = `${siteId}\u0000${siteCategoryId}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ siteId, siteCategoryId })
  }
  return targets
}

/** 从分类树拼出「电影 / 动作片」这样的完整路径 */
function buildPaths(rows: CategoryNameRow[]): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const paths = new Map<string, string>()
  for (const row of rows) {
    const names: string[] = []
    const guard = new Set<string>()
    let cursor: CategoryNameRow | undefined = row
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id)
      names.unshift(cursor.name)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    paths.set(row.id, names.join(' / '))
  }
  return paths
}

/**
 * 在线分类与本地分类的绑定关系，存 SQLite 的 category_bindings 表。
 * 一个在线分类最多绑一个本地分类（唯一键 site_id + site_category_id），
 * 一个本地分类可以收多个站点、多个在线分类。
 */
export function createBindingStore(file: string): BindingStore {
  let db: DatabaseSync | null = null

  function database(): DatabaseSync {
    if (!db) throw new Error('绑定数据库尚未初始化')
    return db
  }

  function forSite(siteId: string): SiteCategoryBinding[] {
    const id = text(siteId).trim()
    if (!id) return []
    const paths = buildPaths(
      database()
        .prepare(SELECT_CATEGORY_TREE)
        .all()
        .map((row) => {
          const raw = row as Record<string, unknown>
          return {
            id: text(raw.id),
            parentId: text(raw.parent_id) || null,
            name: text(raw.name)
          }
        })
    )
    return database()
      .prepare(SELECT_SITE_BINDINGS)
      .all(id)
      .map((row) => {
        const raw = row as Record<string, unknown>
        const categoryId = text(raw.video_category_id)
        return {
          siteCategoryId: text(raw.site_category_id),
          categoryId,
          categoryPath: paths.get(categoryId) ?? ''
        }
      })
      .filter((row) => row.siteCategoryId !== '' && row.categoryId !== '')
  }

  function forCategory(categoryId: string): CategoryBinding[] {
    const id = text(categoryId).trim()
    if (!id) return []
    return database()
      .prepare(SELECT_CATEGORY_BINDINGS)
      .all(id)
      .map((row) => {
        const raw = row as Record<string, unknown>
        const name = text(raw.site_name)
        const display = text(raw.site_display)
        return {
          id: text(raw.id),
          siteId: text(raw.site_id),
          siteName: display || name,
          siteCategoryId: text(raw.site_category_id),
          sourceId: text(raw.source_id),
          name: text(raw.category_name),
          createdAt: text(raw.created_at)
        }
      })
      .filter((row) => row.id !== '')
  }

  function counts(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const row of database().prepare(SELECT_COUNTS).all()) {
      const raw = row as Record<string, unknown>
      const id = text(raw.id)
      const total = Number(raw.total ?? 0)
      if (id && total > 0) result[id] = total
    }
    return result
  }

  function bind(items: BindingTarget[], categoryId: string): BindingResult {
    const targets = normalizeTargets(items)
    const target = text(categoryId).trim()
    if (targets.length === 0 || !target) return { ok: false, error: 'INVALID_INPUT' }

    const connection = database()
    if (!connection.prepare(SELECT_CATEGORY).get(target)) return { ok: false, error: 'NOT_FOUND' }

    // 站点以库里的为准：渲染层传的 siteId 只用来核对，避免两列对不上
    const lookup = connection.prepare(SELECT_SITE_CATEGORY)
    const resolved: BindingTarget[] = []
    for (const item of targets) {
      const row = lookup.get(item.siteCategoryId) as { site_id?: unknown } | undefined
      const owner = text(row?.site_id)
      if (!owner) return { ok: false, error: 'NOT_FOUND' }
      if (owner !== item.siteId) return { ok: false, error: 'INVALID_INPUT' }
      resolved.push({ siteId: owner, siteCategoryId: item.siteCategoryId })
    }

    const now = new Date().toISOString()
    inTransaction(connection, (tx) => {
      const upsert = tx.prepare(UPSERT_BINDING)
      for (const item of resolved) {
        upsert.run(
          randomUUID().replace(/-/g, ''),
          item.siteId,
          item.siteCategoryId,
          target,
          now,
          now
        )
      }
    })
    return { ok: true }
  }

  function unbind(items: BindingTarget[]): BindingResult {
    const targets = normalizeTargets(items)
    if (targets.length === 0) return { ok: false, error: 'INVALID_INPUT' }
    inTransaction(database(), (tx) => {
      const remove = tx.prepare(DELETE_BINDING)
      for (const item of targets) remove.run(item.siteId, item.siteCategoryId)
    })
    return { ok: true }
  }

  return {
    init: async () => {
      if (db) return
      const connection = openDatabase(file)
      try {
        connection.exec(CREATE_TABLE)
        db = connection
      } catch (error) {
        db = null
        throw error
      }
    },
    forSite,
    forCategory,
    counts,
    bind,
    unbind,
    close: () => {
      closeDatabase(file)
      db = null
    }
  }
}
