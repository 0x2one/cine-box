import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { closeDatabase, inTransaction, openDatabase } from './database'

/** 本地视频分类：树形结构，parentId 为空表示一级分类 */
export interface VideoCategory {
  /** 主进程生成的 32 位十六进制 ID */
  id: string
  /** 上级分类 ID，一级分类为 null */
  parentId: string | null
  name: string
  /** 同级排序，从 0 开始连续编号 */
  sortOrder: number
  /** 是否在展示端显示：关闭后该分类及其整棵子树都不再展示，管理页仍会列出 */
  visible: boolean
  /**
   * 是否 18+ 分类：设置里关闭 18+ 内容时，这个分类（含整棵子树）的视频在展示端与
   * 局域网共享页里都不可见；控制台仍然能看到并管理。
   */
  adult: boolean
  /** 创建 / 更新时间，ISO 8601 */
  createdAt: string
  updatedAt: string
}

/** 新增 / 编辑时由渲染层提交的字段 */
export interface VideoCategoryInput {
  name: string
  /** 上级分类：新增时不传即一级分类；编辑时不传表示保持原样，传 null 表示移到一级分类 */
  parentId?: string | null
  /** 18+ 分类：新增时不传按关闭；编辑时不传表示保持原样 */
  adult?: boolean
}

/** 拖拽落点：目标之前 / 成为目标的子分类 / 目标之后 */
export type CategoryPlacement = 'before' | 'inside' | 'after'

export type CategoryError =
  'INVALID_NAME' | 'INVALID_PARENT' | 'INVALID_PLACEMENT' | 'DUPLICATE_NAME' | 'CYCLE' | 'NOT_FOUND'

export interface CategoryResult {
  ok: boolean
  error?: CategoryError
  /** 变更后的完整分类列表，已按同级顺序排好 */
  categories?: VideoCategory[]
}

export interface CategoryStore {
  init: () => Promise<void>
  list: () => VideoCategory[]
  /** 一个分类连同它下面各级子分类的 id，按分类筛选视频时用 */
  subtreeIds: (id: string) => string[]
  create: (input: VideoCategoryInput) => CategoryResult
  update: (id: string, input: VideoCategoryInput) => CategoryResult
  /** 切换展示端的显示状态；关闭父分类会让整棵子树在展示端一起隐藏 */
  setVisible: (id: string, visible: boolean) => CategoryResult
  /** 切换 18+ 标记；打开父分类会让整棵子树都被当成 18+ */
  setAdult: (id: string, adult: boolean) => CategoryResult
  /** 拖拽移动：改变上级并插入到指定位置 */
  move: (id: string, targetId: string | null, placement: CategoryPlacement) => CategoryResult
  /** 删除分类及其所有子分类 */
  remove: (id: string) => CategoryResult
  /** 关闭数据库连接（应用退出时调用） */
  close: () => void
}

const MAX_NAME = 40

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS video_categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES video_categories (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  adult INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_categories_parent ON video_categories (parent_id, sort_order);
`

/** 旧库没有 visible 列，启动时补上；已有分类默认显示 */
const ADD_VISIBLE_COLUMN =
  'ALTER TABLE video_categories ADD COLUMN visible INTEGER NOT NULL DEFAULT 1'

/** 旧库没有 adult 列，启动时补上；已有分类默认不是 18+ */
const ADD_ADULT_COLUMN = 'ALTER TABLE video_categories ADD COLUMN adult INTEGER NOT NULL DEFAULT 0'

const SELECT_ALL = `
SELECT id, parent_id, name, sort_order, visible, adult, created_at, updated_at
FROM video_categories
ORDER BY sort_order ASC, created_at ASC, rowid ASC
`

const INSERT_CATEGORY = `
INSERT INTO video_categories (id, parent_id, name, sort_order, adult, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
`

const UPDATE_CATEGORY = `
UPDATE video_categories
SET name = ?, parent_id = ?, sort_order = ?, adult = ?, updated_at = ?
WHERE id = ?
`

const UPDATE_VISIBLE = 'UPDATE video_categories SET visible = ?, updated_at = ? WHERE id = ?'

const UPDATE_ADULT = 'UPDATE video_categories SET adult = ?, updated_at = ? WHERE id = ?'

/** 只改排序，不动 updatedAt（同级整体压紧不算内容变更） */
const UPDATE_ORDER = 'UPDATE video_categories SET sort_order = ? WHERE id = ?'

/** 自引用表用递归 CTE 一次删掉整棵子树 */
const DELETE_SUBTREE = `
WITH RECURSIVE subtree (id) AS (
  SELECT id FROM video_categories WHERE id = ?
  UNION ALL
  SELECT child.id FROM video_categories AS child JOIN subtree ON child.parent_id = subtree.id
)
DELETE FROM video_categories WHERE id IN (SELECT id FROM subtree)
`

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .slice(0, MAX_NAME)
}

function normalizeParentId(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw || null
}

function rowToCategory(row: unknown): VideoCategory | null {
  if (!row || typeof row !== 'object') return null
  const raw = row as Record<string, unknown>
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString()
  return {
    id: raw.id,
    parentId: typeof raw.parent_id === 'string' && raw.parent_id ? raw.parent_id : null,
    name: raw.name,
    sortOrder: typeof raw.sort_order === 'number' ? raw.sort_order : 0,
    // node:sqlite 返回整数 0 / 1，缺列时按显示处理
    visible: Number(raw.visible ?? 1) !== 0,
    adult: Number(raw.adult ?? 0) !== 0,
    createdAt,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : createdAt
  }
}

/** 目标是不是自己或自己的后代：向上走父链，数据被改坏成环时也按后代处理 */
function isSelfOrDescendant(rows: VideoCategory[], id: string, candidateId: string): boolean {
  const parents = new Map(rows.map((row) => [row.id, row.parentId]))
  const visited = new Set<string>()
  let cursor: string | null = candidateId
  while (cursor) {
    if (cursor === id) return true
    if (visited.has(cursor)) return true
    visited.add(cursor)
    cursor = parents.get(cursor) ?? null
  }
  return false
}

/**
 * 视频分类存 SQLite，file 为数据库文件绝对路径（与站点共用同一个连接）。
 * 所有写操作都以「同级名称唯一」为前提，并返回变更后的完整列表。
 */
export function createCategoryStore(file: string): CategoryStore {
  let db: DatabaseSync | null = null

  function database(): DatabaseSync {
    if (!db) throw new Error('分类数据库尚未初始化')
    return db
  }

  function queryAll(): VideoCategory[] {
    return database()
      .prepare(SELECT_ALL)
      .all()
      .map(rowToCategory)
      .filter((row): row is VideoCategory => row !== null)
  }

  /** 同级分类（可按 id 排除自己），保持库里的排序 */
  function siblings(
    rows: VideoCategory[],
    parentId: string | null,
    exceptId?: string
  ): VideoCategory[] {
    return rows.filter((row) => row.parentId === parentId && row.id !== exceptId)
  }

  /** 按传入顺序把同级分类的 sort_order 压紧成 0..n-1 */
  function reindex(connection: DatabaseSync, ids: string[]): void {
    if (ids.length === 0) return
    const statement = connection.prepare(UPDATE_ORDER)
    ids.forEach((id, position) => statement.run(position, id))
  }

  /** 一个分类连同各级子分类的 id（广度优先，带环保护），父分类过滤时要连子分类一起查 */
  function subtreeIds(id: string): string[] {
    const root = typeof id === 'string' ? id.trim() : ''
    if (!root) return []
    const children = new Map<string, string[]>()
    for (const row of queryAll()) {
      if (!row.parentId) continue
      const list = children.get(row.parentId) ?? []
      list.push(row.id)
      children.set(row.parentId, list)
    }
    const result: string[] = []
    const seen = new Set<string>()
    const queue = [root]
    while (queue.length > 0) {
      const current = queue.shift() as string
      if (seen.has(current)) continue
      seen.add(current)
      result.push(current)
      queue.push(...(children.get(current) ?? []))
    }
    return result
  }

  function create(input: VideoCategoryInput): CategoryResult {
    const name = normalizeName(input?.name)
    if (!name) return { ok: false, error: 'INVALID_NAME' }
    const parentId = normalizeParentId(input?.parentId)
    const rows = queryAll()
    if (parentId && !rows.some((row) => row.id === parentId)) {
      return { ok: false, error: 'INVALID_PARENT' }
    }
    const brothers = siblings(rows, parentId)
    if (brothers.some((row) => row.name === name)) return { ok: false, error: 'DUPLICATE_NAME' }

    const now = new Date().toISOString()
    // 追加到同级末尾
    const sortOrder = brothers.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0)
    database()
      .prepare(INSERT_CATEGORY)
      .run(
        randomUUID().replace(/-/g, ''),
        parentId,
        name,
        sortOrder,
        input?.adult === true ? 1 : 0,
        now,
        now
      )
    return { ok: true, categories: queryAll() }
  }

  function update(id: string, input: VideoCategoryInput): CategoryResult {
    const rows = queryAll()
    const existing = rows.find((row) => row.id === id)
    if (!existing) return { ok: false, error: 'NOT_FOUND' }
    const name = normalizeName(input?.name)
    if (!name) return { ok: false, error: 'INVALID_NAME' }
    // 不传 parentId 表示保持原来的上级，传 null 才是移到一级分类
    const parentId =
      input?.parentId === undefined ? existing.parentId : normalizeParentId(input.parentId)
    if (parentId && !rows.some((row) => row.id === parentId)) {
      return { ok: false, error: 'INVALID_PARENT' }
    }
    if (parentId && isSelfOrDescendant(rows, id, parentId)) return { ok: false, error: 'CYCLE' }

    const changedParent = existing.parentId !== parentId
    const target = siblings(rows, parentId, id)
    if (target.some((row) => row.name === name)) return { ok: false, error: 'DUPLICATE_NAME' }

    const now = new Date().toISOString()
    // 换上级时追加到新同级末尾，原同级随之压紧；18+ 标记不传就保持原样
    const sortOrder = changedParent ? target.length : existing.sortOrder
    const adult = input?.adult === undefined ? existing.adult : Boolean(input.adult)
    inTransaction(database(), (connection) => {
      connection.prepare(UPDATE_CATEGORY).run(name, parentId, sortOrder, adult ? 1 : 0, now, id)
      if (changedParent)
        reindex(
          connection,
          siblings(rows, existing.parentId, id).map((row) => row.id)
        )
    })
    return { ok: true, categories: queryAll() }
  }

  function setVisible(id: string, visible: boolean): CategoryResult {
    const rows = queryAll()
    const existing = rows.find((row) => row.id === id)
    if (!existing) return { ok: false, error: 'NOT_FOUND' }
    // 值没变就不刷 updatedAt
    if (existing.visible === visible) return { ok: true, categories: rows }
    database()
      .prepare(UPDATE_VISIBLE)
      .run(visible ? 1 : 0, new Date().toISOString(), id)
    return { ok: true, categories: queryAll() }
  }

  function setAdult(id: string, adult: boolean): CategoryResult {
    const rows = queryAll()
    const existing = rows.find((row) => row.id === id)
    if (!existing) return { ok: false, error: 'NOT_FOUND' }
    // 值没变就不刷 updatedAt
    if (existing.adult === adult) return { ok: true, categories: rows }
    database()
      .prepare(UPDATE_ADULT)
      .run(adult ? 1 : 0, new Date().toISOString(), id)
    return { ok: true, categories: queryAll() }
  }

  function move(id: string, targetId: string | null, placement: CategoryPlacement): CategoryResult {
    if (placement !== 'before' && placement !== 'inside' && placement !== 'after') {
      return { ok: false, error: 'INVALID_PLACEMENT' }
    }
    const rows = queryAll()
    const existing = rows.find((row) => row.id === id)
    if (!existing) return { ok: false, error: 'NOT_FOUND' }

    let parentId: string | null = null
    let index: number
    if (!targetId) {
      // 拖到空白处：移到一级分类末尾
      index = siblings(rows, null, id).length
    } else {
      const target = rows.find((row) => row.id === targetId)
      if (!target) return { ok: false, error: 'NOT_FOUND' }
      // 拖到自己身上没有任何变化
      if (target.id === id) return { ok: true, categories: rows }
      if (placement === 'inside') {
        parentId = target.id
        index = siblings(rows, parentId, id).length
      } else {
        parentId = target.parentId
        const group = siblings(rows, parentId, id)
        const at = group.findIndex((row) => row.id === target.id)
        if (at < 0) return { ok: false, error: 'NOT_FOUND' }
        index = placement === 'before' ? at : at + 1
      }
    }
    if (parentId && isSelfOrDescendant(rows, id, parentId)) return { ok: false, error: 'CYCLE' }

    const group = siblings(rows, parentId, id)
    if (group.some((row) => row.name === existing.name))
      return { ok: false, error: 'DUPLICATE_NAME' }

    // 落到合法区间，插入后自己正好在这个位置
    const position = Math.min(Math.max(index, 0), group.length)
    const ordered = [...group]
    ordered.splice(position, 0, existing)
    const changedParent = existing.parentId !== parentId
    const now = new Date().toISOString()

    inTransaction(database(), (connection) => {
      const order = connection.prepare(UPDATE_ORDER)
      ordered.forEach((row, at) => order.run(at, row.id))
      connection
        .prepare(UPDATE_CATEGORY)
        .run(existing.name, parentId, position, existing.adult ? 1 : 0, now, id)
      if (changedParent) {
        reindex(
          connection,
          siblings(rows, existing.parentId, id).map((row) => row.id)
        )
      }
    })
    return { ok: true, categories: queryAll() }
  }

  function remove(id: string): CategoryResult {
    const rows = queryAll()
    const existing = rows.find((row) => row.id === id)
    if (!existing) return { ok: false, error: 'NOT_FOUND' }

    inTransaction(database(), (connection) => {
      connection.prepare(DELETE_SUBTREE).run(id)
      // 删掉后把剩下的同级顺序压紧
      reindex(
        connection,
        siblings(rows, existing.parentId, id).map((row) => row.id)
      )
    })
    return { ok: true, categories: queryAll() }
  }

  return {
    init: async () => {
      if (db) return
      const connection = openDatabase(file)
      try {
        connection.exec(CREATE_TABLE)
        // 旧库的建表语句不会补列，这里单独迁移一次
        const columns = connection
          .prepare("SELECT name FROM pragma_table_info('video_categories')")
          .all()
          .map((row) => String((row as Record<string, unknown>).name ?? ''))
        if (!columns.includes('visible')) connection.exec(ADD_VISIBLE_COLUMN)
        if (!columns.includes('adult')) connection.exec(ADD_ADULT_COLUMN)
        db = connection
      } catch (error) {
        db = null
        throw error
      }
    },
    list: queryAll,
    subtreeIds,
    create,
    update,
    setVisible,
    setAdult,
    move,
    remove,
    close: () => {
      closeDatabase(file)
      db = null
    }
  }
}
