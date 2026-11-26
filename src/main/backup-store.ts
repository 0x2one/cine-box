import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, openDatabase } from './database'
import { isValidDailyTime } from './schedule-time'

/** 备份文件的格式标记与版本，恢复时用来识别与兼容 */
const BACKUP_FORMAT = 'cine-box-backup'
/** 版本 2：增加 collect_schedules；版本 1 备份按空计划恢复 */
const BACKUP_VERSION = 2
/** 备份目录（与数据库同级），文件是明文 JSON，方便分享与跨版本恢复 */
const BACKUP_DIR = 'Backups'
const FILE_PREFIX = 'cine-box-backup-'
const FILE_SUFFIX = '.json'
/** 单个备份文件上限，避免误选超大文件把主进程读爆 */
const MAX_FILE_SIZE = 8 * 1024 * 1024
/** 备份文件名只允许这些字符，恢复 / 删除时挡住路径穿越 */
const SAFE_ID = /^[A-Za-z0-9._-]+\.json$/

export interface BackupCounts {
  sites: number
  siteCategories: number
  categories: number
  bindings: number
  schedules: number
}

/** 一条备份记录：磁盘上的一个 JSON 文件 */
export interface BackupRecord {
  /** 备份文件名，同时作为记录 ID */
  id: string
  /** 生成备份的时间，ISO 8601 */
  createdAt: string
  /** 生成备份时的应用版本 */
  appVersion: string
  /** 文件大小（字节） */
  size: number
  counts: BackupCounts
  /** 恢复前自动生成的安全备份 */
  auto: boolean
}

interface SiteRow {
  id: string
  name: string
  display: string
  address: string
  format: 'xml' | 'json'
  remark: string
  /** 是否支持在线检索；旧备份没有该字段时按关闭处理 */
  onlineSearch: boolean
  /** 是否禁用；旧备份没有该字段时按启用处理 */
  disabled: boolean
  /** 是否 18+ 站点；旧备份没有该字段时按普通站点处理 */
  adult: boolean
  createdAt: string
  updatedAt: string
}

interface SiteCategoryRow {
  id: string
  siteId: string
  sourceId: string
  name: string
  createdAt: string
  updatedAt: string
}

interface VideoCategoryRow {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
  /** 展示端是否显示；旧备份没有该字段时按显示处理 */
  visible: boolean
  /** 是否 18+ 分类；旧备份没有该字段时按普通分类处理 */
  adult: boolean
  createdAt: string
  updatedAt: string
}

interface BindingRow {
  id: string
  siteId: string
  siteCategoryId: string
  videoCategoryId: string
  createdAt: string
  updatedAt: string
}

interface ScheduleRow {
  siteId: string
  mode: 'incremental' | 'full'
  fetchRange: 'all' | '24h' | '48h'
  timing: 'interval' | 'daily'
  intervalMinutes: number
  dailyTime: string
  enabled: boolean
  cacheDetail: boolean
  /** 保存计划时探测到的真实每页条数；0 = 未知（旧备份） */
  pageSize: number
  nextRunAt: string
  lastRunAt: string
  createdAt: string
  updatedAt: string
}

interface BackupData {
  sites: SiteRow[]
  siteCategories: SiteCategoryRow[]
  categories: VideoCategoryRow[]
  bindings: BindingRow[]
  schedules: ScheduleRow[]
}

interface BackupDocument {
  format: string
  version: number
  appVersion: string
  createdAt: string
  counts: BackupCounts
  data: BackupData
}

export type BackupError =
  'EMPTY' | 'INVALID' | 'UNSUPPORTED' | 'NOT_FOUND' | 'READ_FAILED' | 'WRITE_FAILED'

export interface BackupListResult {
  /** 备份目录绝对路径 */
  directory: string
  records: BackupRecord[]
}

export interface BackupCreateResult {
  ok: boolean
  error?: BackupError
  record?: BackupRecord
}

export interface BackupRemoveResult {
  ok: boolean
}

export interface BackupExportResult {
  ok: boolean
  canceled?: boolean
  error?: BackupError
  /** 用户选择的目标路径 */
  path?: string
}

export interface BackupPickResult {
  ok: boolean
  canceled?: boolean
  error?: BackupError
  /** 用户选中的文件绝对路径，确认恢复时原样传回 */
  path?: string
  record?: BackupRecord
}

export interface BackupRestoreResult {
  ok: boolean
  error?: BackupError
  /** 备份里的数据量，用于恢复成功的提示 */
  counts?: BackupCounts
  /** 恢复前自动备份的当前数据；当前库为空时没有 */
  safety?: BackupRecord
}

export interface RestoreSource {
  /** 库内备份记录 ID */
  id?: string
  /** 自定义备份文件的绝对路径 */
  path?: string
}

export interface BackupStore {
  init: () => Promise<void>
  directory: () => string
  list: () => BackupListResult
  /** 把当前库里的站点、在线分类、本地分类与绑定关系写成一份备份 */
  create: () => BackupCreateResult
  remove: (id: string) => BackupRemoveResult
  /** 另存到用户选择的位置，便于分享 */
  exportTo: (id: string, target: string) => BackupExportResult
  /** 解析自定义文件，只读取不写库，供恢复前确认 */
  inspect: (file: string) => BackupPickResult
  /** 用备份覆盖当前数据，恢复前自动备份现状 */
  restore: (source: RestoreSource) => BackupRestoreResult
  /** 备份文件的绝对路径，不存在时返回 null */
  filePath: (id: string) => string | null
}

const SELECT_SITES = `
SELECT id, name, display, address, format, remark, online_search, disabled, adult, created_at, updated_at
FROM sites
ORDER BY created_at ASC, rowid ASC
`

const SELECT_SITE_CATEGORIES = `
SELECT id, site_id, source_id, name, created_at, updated_at
FROM site_categories
ORDER BY rowid
`

const SELECT_VIDEO_CATEGORIES = `
SELECT id, parent_id, name, sort_order, visible, adult, created_at, updated_at
FROM video_categories
ORDER BY sort_order ASC, rowid ASC
`

const SELECT_BINDINGS = `
SELECT id, site_id, site_category_id, video_category_id, created_at, updated_at
FROM category_bindings
ORDER BY rowid
`

const SELECT_SCHEDULES = `
SELECT site_id, mode, fetch_range, timing, interval_minutes, daily_time, enabled, cache_detail,
       page_size, next_run_at, last_run_at, created_at, updated_at
FROM collect_schedules
ORDER BY created_at ASC, rowid ASC
`

const INSERT_SITE = `
INSERT INTO sites
  (id, name, display, address, format, remark, online_search, disabled, adult, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const INSERT_SITE_CATEGORY = `
INSERT INTO site_categories (id, site_id, source_id, name, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
`

const INSERT_VIDEO_CATEGORY = `
INSERT INTO video_categories (id, parent_id, name, sort_order, visible, adult, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`

const INSERT_BINDING = `
INSERT INTO category_bindings
  (id, site_id, site_category_id, video_category_id, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
`

const INSERT_SCHEDULE = `
INSERT INTO collect_schedules
  (site_id, mode, fetch_range, timing, interval_minutes, daily_time, enabled, cache_detail,
   page_size, next_run_at, last_run_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 必填字符串：空串 / 非字符串 / 超长都按无效处理，备份由本应用生成，正常不会超长 */
function requiredText(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > max) return null
  return text
}

/** 可选字符串：缺省与 null 都当空串 */
function optionalText(value: unknown, max = 1000): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 时间戳：解析不了就用兜底值，避免列表出现无效时间 */
function timestamp(value: unknown, fallback: string): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  return fallback
}

function countsOf(data: BackupData): BackupCounts {
  return {
    sites: data.sites.length,
    siteCategories: data.siteCategories.length,
    categories: data.categories.length,
    bindings: data.bindings.length,
    schedules: data.schedules.length
  }
}

function totalOf(counts: BackupCounts): number {
  return (
    counts.sites + counts.siteCategories + counts.categories + counts.bindings + counts.schedules
  )
}

type ParseResult = { ok: true; document: BackupDocument } | { ok: false; error: BackupError }

function invalid(): { ok: false; error: BackupError } {
  return { ok: false, error: 'INVALID' }
}

function parseSites(value: unknown): SiteRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: SiteRow[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return null
    const id = requiredText(item.id, 64)
    const name = requiredText(item.name, 200)
    const address = requiredText(item.address, 2048)
    const format = item.format === 'json' ? 'json' : item.format === 'xml' ? 'xml' : null
    if (!id || !name || !address || !format || ids.has(id)) return null
    ids.add(id)
    const createdAt = timestamp(item.createdAt, new Date().toISOString())
    rows.push({
      id,
      name,
      display: optionalText(item.display, 200),
      address,
      format,
      remark: optionalText(item.remark),
      // 旧备份没有这个字段：按「不支持在线检索」恢复
      onlineSearch: item.onlineSearch === true,
      // 旧备份没有这个字段：按「启用」恢复
      disabled: item.disabled === true,
      // 旧备份没有这个字段：按普通站点恢复
      adult: item.adult === true,
      createdAt,
      updatedAt: timestamp(item.updatedAt, createdAt)
    })
  }
  return rows
}

function parseSiteCategories(value: unknown, siteIds: Set<string>): SiteCategoryRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: SiteCategoryRow[] = []
  const ids = new Set<string>()
  const pairs = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return null
    const id = requiredText(item.id, 64)
    const siteId = requiredText(item.siteId, 64)
    const sourceId = requiredText(item.sourceId, 128)
    const name = requiredText(item.name, 200)
    if (!id || !siteId || !sourceId || !name || ids.has(id) || !siteIds.has(siteId)) return null
    // 同一个站点内来源 ID 唯一，与库里的唯一约束保持一致
    const pair = `${siteId}\u0000${sourceId}`
    if (pairs.has(pair)) return null
    ids.add(id)
    pairs.add(pair)
    const createdAt = timestamp(item.createdAt, new Date().toISOString())
    rows.push({
      id,
      siteId,
      sourceId,
      name,
      createdAt,
      updatedAt: timestamp(item.updatedAt, createdAt)
    })
  }
  return rows
}

function parseVideoCategories(value: unknown): VideoCategoryRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: VideoCategoryRow[] = []
  const parents = new Map<string, string | null>()
  for (const item of value) {
    if (!isRecord(item)) return null
    const id = requiredText(item.id, 64)
    const name = requiredText(item.name, 200)
    const parentId =
      item.parentId === null || item.parentId === undefined ? null : requiredText(item.parentId, 64)
    if (!id || !name || parents.has(id) || parentId === id) return null
    // 旧备份没有 visible（默认显示），有的话必须是布尔值，否则说明文件被改坏了
    if (item.visible !== undefined && typeof item.visible !== 'boolean') return null
    // 18+ 标记同理：老备份没有就按普通分类恢复
    if (item.adult !== undefined && typeof item.adult !== 'boolean') return null
    const createdAt = timestamp(item.createdAt, new Date().toISOString())
    parents.set(id, parentId)
    rows.push({
      id,
      parentId,
      name,
      sortOrder:
        typeof item.sortOrder === 'number' && Number.isFinite(item.sortOrder) ? item.sortOrder : 0,
      visible: item.visible !== false,
      adult: item.adult === true,
      createdAt,
      updatedAt: timestamp(item.updatedAt, createdAt)
    })
  }
  // 父分类必须存在，且任何一条父链都不能成环：一次遍历标记「走到过根」即可
  const resolved = new Set<string>()
  for (const id of parents.keys()) {
    if (resolved.has(id)) continue
    const path: string[] = []
    const visiting = new Set<string>()
    let cursor: string | null = id
    while (cursor) {
      if (resolved.has(cursor)) break
      if (visiting.has(cursor)) return null
      visiting.add(cursor)
      path.push(cursor)
      const parentId = parents.get(cursor)
      if (parentId === undefined) return null
      cursor = parentId
    }
    for (const node of path) resolved.add(node)
  }
  return rows
}

function parseBindings(
  value: unknown,
  siteIds: Set<string>,
  siteCategoryOwners: Map<string, string>,
  categoryIds: Set<string>
): BindingRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: BindingRow[] = []
  const ids = new Set<string>()
  const pairs = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return null
    const id = requiredText(item.id, 64)
    const siteId = requiredText(item.siteId, 64)
    const siteCategoryId = requiredText(item.siteCategoryId, 64)
    const videoCategoryId = requiredText(item.videoCategoryId, 64)
    if (!id || !siteId || !siteCategoryId || !videoCategoryId || ids.has(id)) return null
    if (!siteIds.has(siteId)) return null
    // 在线分类必须真的属于这个站点，否则恢复后两列对不上
    if (siteCategoryOwners.get(siteCategoryId) !== siteId) return null
    if (!categoryIds.has(videoCategoryId)) return null
    // 一条在线分类最多绑一个本地分类
    const pair = `${siteId}\u0000${siteCategoryId}`
    if (pairs.has(pair)) return null
    ids.add(id)
    pairs.add(pair)
    const createdAt = timestamp(item.createdAt, new Date().toISOString())
    rows.push({
      id,
      siteId,
      siteCategoryId,
      videoCategoryId,
      createdAt,
      updatedAt: timestamp(item.updatedAt, createdAt)
    })
  }
  return rows
}

/** 定时采集计划：站点必须存在；旧备份（版本 1）没有该数组时按空计划处理 */
function parseSchedules(value: unknown, siteIds: Set<string>): ScheduleRow[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const rows: ScheduleRow[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return null
    const siteId = requiredText(item.siteId, 64)
    if (!siteId || !siteIds.has(siteId) || seen.has(siteId)) return null
    const mode = item.mode === 'incremental' || item.mode === 'full' ? item.mode : null
    const fetchRange =
      item.fetchRange === 'all' || item.fetchRange === '24h' || item.fetchRange === '48h'
        ? item.fetchRange
        : null
    const interval = Number(item.intervalMinutes)
    if (!mode || !fetchRange || !Number.isFinite(interval) || interval < 5) return null
    if (mode === 'full' && fetchRange !== 'all') return null
    if (typeof item.enabled !== 'boolean') return null
    // 旧备份没有 cacheDetail / timing 字段，按关闭、按间隔处理
    const cacheDetail = item.cacheDetail === true
    const timing = item.timing === 'daily' ? 'daily' : 'interval'
    const dailyTime = timing === 'daily' ? (requiredText(item.dailyTime, 5) ?? '') : ''
    if (timing === 'daily' && !isValidDailyTime(dailyTime)) return null
    const createdAt = timestamp(item.createdAt, new Date().toISOString())
    // 旧备份没有 pageSize，按未知（0）处理，采集时用默认 100
    const pageSizeRaw = Number(item.pageSize)
    const pageSize =
      Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 100) : 0
    seen.add(siteId)
    rows.push({
      siteId,
      mode,
      fetchRange,
      timing,
      intervalMinutes: Math.min(Math.floor(interval), 10080),
      dailyTime,
      enabled: item.enabled,
      cacheDetail,
      pageSize,
      nextRunAt: optionalText(item.nextRunAt, 40),
      lastRunAt: optionalText(item.lastRunAt, 40),
      createdAt,
      updatedAt: timestamp(item.updatedAt, createdAt)
    })
  }
  return rows
}

/** 校验整份备份；任何一行对不上都拒绝，避免只恢复一半数据 */
function parseBackup(raw: unknown): ParseResult {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) return invalid()
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    return invalid()
  }
  if (raw.version > BACKUP_VERSION) return { ok: false, error: 'UNSUPPORTED' }
  if (!isRecord(raw.data)) return invalid()

  const sites = parseSites(raw.data.sites)
  if (!sites) return invalid()
  const siteIds = new Set(sites.map((row) => row.id))
  const siteCategories = parseSiteCategories(raw.data.siteCategories, siteIds)
  if (!siteCategories) return invalid()
  const categories = parseVideoCategories(raw.data.categories)
  if (!categories) return invalid()
  const bindings = parseBindings(
    raw.data.bindings,
    siteIds,
    new Map(siteCategories.map((row) => [row.id, row.siteId])),
    new Set(categories.map((row) => row.id))
  )
  if (!bindings) return invalid()
  const schedules = parseSchedules(raw.data.schedules, siteIds)
  if (!schedules) return invalid()

  const data: BackupData = { sites, siteCategories, categories, bindings, schedules }
  const createdAt = timestamp(raw.createdAt, new Date().toISOString())
  return {
    ok: true,
    document: {
      format: BACKUP_FORMAT,
      version: raw.version,
      appVersion: optionalText(raw.appVersion, 40),
      createdAt,
      counts: countsOf(data),
      data
    }
  }
}

/** 导出当前库里的全部数据，列名转成 camelCase，方便分享与人工查看 */
function readState(database: DatabaseSync): BackupData {
  const sites: SiteRow[] = database
    .prepare(SELECT_SITES)
    .all()
    .map((row) => {
      const raw = row as Record<string, unknown>
      const createdAt = timestamp(raw.created_at, new Date().toISOString())
      return {
        id: String(raw.id ?? ''),
        name: String(raw.name ?? ''),
        display: String(raw.display ?? ''),
        address: String(raw.address ?? ''),
        format: raw.format === 'json' ? ('json' as const) : ('xml' as const),
        remark: String(raw.remark ?? ''),
        onlineSearch: Number(raw.online_search ?? 0) !== 0,
        disabled: Number(raw.disabled ?? 0) !== 0,
        adult: Number(raw.adult ?? 0) !== 0,
        createdAt,
        updatedAt: timestamp(raw.updated_at, createdAt)
      }
    })

  const siteCategories: SiteCategoryRow[] = database
    .prepare(SELECT_SITE_CATEGORIES)
    .all()
    .map((row) => {
      const raw = row as Record<string, unknown>
      const createdAt = timestamp(raw.created_at, new Date().toISOString())
      return {
        id: String(raw.id ?? ''),
        siteId: String(raw.site_id ?? ''),
        sourceId: String(raw.source_id ?? ''),
        name: String(raw.name ?? ''),
        createdAt,
        updatedAt: timestamp(raw.updated_at, createdAt)
      }
    })

  const categories: VideoCategoryRow[] = database
    .prepare(SELECT_VIDEO_CATEGORIES)
    .all()
    .map((row) => {
      const raw = row as Record<string, unknown>
      const createdAt = timestamp(raw.created_at, new Date().toISOString())
      return {
        id: String(raw.id ?? ''),
        parentId: typeof raw.parent_id === 'string' && raw.parent_id ? raw.parent_id : null,
        name: String(raw.name ?? ''),
        sortOrder: Number(raw.sort_order ?? 0),
        visible: Number(raw.visible ?? 1) !== 0,
        adult: Number(raw.adult ?? 0) !== 0,
        createdAt,
        updatedAt: timestamp(raw.updated_at, createdAt)
      }
    })

  const bindings: BindingRow[] = database
    .prepare(SELECT_BINDINGS)
    .all()
    .map((row) => {
      const raw = row as Record<string, unknown>
      const createdAt = timestamp(raw.created_at, new Date().toISOString())
      return {
        id: String(raw.id ?? ''),
        siteId: String(raw.site_id ?? ''),
        siteCategoryId: String(raw.site_category_id ?? ''),
        videoCategoryId: String(raw.video_category_id ?? ''),
        createdAt,
        updatedAt: timestamp(raw.updated_at, createdAt)
      }
    })

  const schedules: ScheduleRow[] = database
    .prepare(SELECT_SCHEDULES)
    .all()
    .map((row) => {
      const raw = row as Record<string, unknown>
      const createdAt = timestamp(raw.created_at, new Date().toISOString())
      return {
        siteId: String(raw.site_id ?? ''),
        mode: raw.mode === 'full' ? ('full' as const) : ('incremental' as const),
        fetchRange:
          raw.fetch_range === '24h' || raw.fetch_range === '48h'
            ? raw.fetch_range
            : ('all' as const),
        timing: raw.timing === 'daily' ? ('daily' as const) : ('interval' as const),
        intervalMinutes: Number(raw.interval_minutes ?? 360),
        dailyTime: String(raw.daily_time ?? ''),
        enabled: Number(raw.enabled ?? 1) !== 0,
        cacheDetail: Number(raw.cache_detail ?? 0) !== 0,
        pageSize: Number(raw.page_size ?? 0) || 0,
        nextRunAt: String(raw.next_run_at ?? ''),
        lastRunAt: String(raw.last_run_at ?? ''),
        createdAt,
        updatedAt: timestamp(raw.updated_at, createdAt)
      }
    })

  return { sites, siteCategories, categories, bindings, schedules }
}

/** 自引用外键要求父分类先插入，按层级从浅到深写入 */
function orderByDepth(rows: VideoCategoryRow[]): VideoCategoryRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const depths = new Map<string, number>()
  const measure = (id: string): number => {
    const cached = depths.get(id)
    if (cached !== undefined) return cached
    const parentId = byId.get(id)?.parentId ?? null
    const value = parentId && byId.has(parentId) ? measure(parentId) + 1 : 0
    depths.set(id, value)
    return value
  }
  return rows
    .map((row) => ({ row, depth: measure(row.id) }))
    .sort((left, right) => left.depth - right.depth)
    .map((item) => item.row)
}

/** 整体覆盖：先清空五张表，再按外键顺序写回，失败时由事务回滚 */
function applyState(database: DatabaseSync, data: BackupData): void {
  inTransaction(database, (tx) => {
    tx.exec('DELETE FROM collect_schedules')
    tx.exec('DELETE FROM category_bindings')
    tx.exec('DELETE FROM site_categories')
    tx.exec('DELETE FROM video_categories')
    tx.exec('DELETE FROM sites')

    const insertSite = tx.prepare(INSERT_SITE)
    for (const row of data.sites) {
      insertSite.run(
        row.id,
        row.name,
        row.display,
        row.address,
        row.format,
        row.remark,
        row.onlineSearch ? 1 : 0,
        row.disabled ? 1 : 0,
        row.adult ? 1 : 0,
        row.createdAt,
        row.updatedAt
      )
    }

    const insertSchedule = tx.prepare(INSERT_SCHEDULE)
    for (const row of data.schedules) {
      insertSchedule.run(
        row.siteId,
        row.mode,
        row.fetchRange,
        row.timing,
        row.intervalMinutes,
        row.dailyTime,
        row.enabled ? 1 : 0,
        row.cacheDetail ? 1 : 0,
        row.pageSize,
        row.nextRunAt,
        row.lastRunAt,
        row.createdAt,
        row.updatedAt
      )
    }

    const insertSiteCategory = tx.prepare(INSERT_SITE_CATEGORY)
    for (const row of data.siteCategories) {
      insertSiteCategory.run(
        row.id,
        row.siteId,
        row.sourceId,
        row.name,
        row.createdAt,
        row.updatedAt
      )
    }

    const insertCategory = tx.prepare(INSERT_VIDEO_CATEGORY)
    for (const row of orderByDepth(data.categories)) {
      insertCategory.run(
        row.id,
        row.parentId,
        row.name,
        row.sortOrder,
        row.visible ? 1 : 0,
        row.adult ? 1 : 0,
        row.createdAt,
        row.updatedAt
      )
    }

    const insertBinding = tx.prepare(INSERT_BINDING)
    for (const row of data.bindings) {
      insertBinding.run(
        row.id,
        row.siteId,
        row.siteCategoryId,
        row.videoCategoryId,
        row.createdAt,
        row.updatedAt
      )
    }
  })
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function recordOf(id: string, document: BackupDocument, size: number): BackupRecord {
  return {
    id,
    createdAt: document.createdAt,
    appVersion: document.appVersion,
    size,
    counts: document.counts,
    auto: id.includes('-auto')
  }
}

type ReadResult =
  { ok: true; document: BackupDocument; size: number } | { ok: false; error: BackupError }

function readDocument(file: string): ReadResult {
  let stats: Stats
  try {
    stats = statSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, error: code === 'ENOENT' ? 'NOT_FOUND' : 'READ_FAILED' }
  }
  if (!stats.isFile() || stats.size > MAX_FILE_SIZE) return { ok: false, error: 'INVALID' }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, error: 'READ_FAILED' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'INVALID' }
  }
  const parsed = parseBackup(raw)
  if (!parsed.ok) return parsed
  return { ok: true, document: parsed.document, size: stats.size }
}

/**
 * 站点 / 分类 / 绑定关系的备份与恢复，文件存放在数据库同级的 Backups 目录。
 * 备份是明文 JSON（格式标记 + 版本 + 四张表的数据），可以复制给别人导入；
 * 恢复是整体覆盖，写库前会自动为当前数据生成一份安全备份。
 */
export function createBackupStore(file: string, appVersion: string): BackupStore {
  const directory = join(dirname(file), BACKUP_DIR)

  function ensureDirectory(): void {
    mkdirSync(directory, { recursive: true })
  }

  function filePath(id: string): string | null {
    const name = typeof id === 'string' ? id : ''
    if (!SAFE_ID.test(name)) return null
    const target = join(directory, name)
    return existsSync(target) ? target : null
  }

  /** 备份文件名带时间戳，同一秒重复备份时补序号 */
  function uniqueId(createdAt: string, auto: boolean): string {
    const base = `${FILE_PREFIX}${stamp(new Date(createdAt))}${auto ? '-auto' : ''}`
    let name = `${base}${FILE_SUFFIX}`
    let index = 2
    while (existsSync(join(directory, name))) {
      name = `${base}-${index}${FILE_SUFFIX}`
      index += 1
    }
    return name
  }

  function writeDocument(document: BackupDocument, auto: boolean): BackupRecord {
    ensureDirectory()
    const id = uniqueId(document.createdAt, auto)
    const target = join(directory, id)
    // 先写临时文件再改名，写入过程中崩溃不会留下半截备份
    const temp = `${target}.tmp`
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
    return recordOf(id, document, statSync(target).size)
  }

  /** 读取当前库并落盘，数据为空时返回 null（不产生空备份） */
  function snapshot(database: DatabaseSync, auto: boolean): BackupRecord | null {
    const data = readState(database)
    const counts = countsOf(data)
    if (totalOf(counts) === 0) return null
    return writeDocument(
      {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        appVersion,
        createdAt: new Date().toISOString(),
        counts,
        data
      },
      auto
    )
  }

  function list(): BackupListResult {
    let names: string[]
    try {
      ensureDirectory()
      names = readdirSync(directory)
    } catch {
      return { directory, records: [] }
    }
    const records: BackupRecord[] = []
    for (const name of names) {
      if (!SAFE_ID.test(name)) continue
      const parsed = readDocument(join(directory, name))
      if (!parsed.ok) continue
      records.push(recordOf(name, parsed.document, parsed.size))
    }
    records.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)
    )
    return { directory, records }
  }

  function create(): BackupCreateResult {
    let database: DatabaseSync
    try {
      database = openDatabase(file)
    } catch {
      return { ok: false, error: 'WRITE_FAILED' }
    }
    try {
      const record = snapshot(database, false)
      if (!record) return { ok: false, error: 'EMPTY' }
      return { ok: true, record }
    } catch {
      return { ok: false, error: 'WRITE_FAILED' }
    }
  }

  function remove(id: string): BackupRemoveResult {
    const target = filePath(id)
    if (!target) return { ok: false }
    try {
      rmSync(target, { force: true })
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  function exportTo(id: string, target: string): BackupExportResult {
    const source = filePath(id)
    if (!source) return { ok: false, error: 'NOT_FOUND' }
    const destination = typeof target === 'string' ? target.trim() : ''
    if (!destination) return { ok: false, error: 'WRITE_FAILED' }
    // 目标就是备份目录里的同一份文件时不必复制
    if (resolve(destination) === resolve(source)) return { ok: true, path: source }
    try {
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
      return { ok: true, path: destination }
    } catch {
      return { ok: false, error: 'WRITE_FAILED' }
    }
  }

  function inspect(target: string): BackupPickResult {
    const source = typeof target === 'string' ? target.trim() : ''
    if (!source) return { ok: false, error: 'INVALID' }
    const parsed = readDocument(source)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    return {
      ok: true,
      path: source,
      record: recordOf(basename(source), parsed.document, parsed.size)
    }
  }

  function restore(source: RestoreSource): BackupRestoreResult {
    const custom = typeof source?.path === 'string' ? source.path.trim() : ''
    const target = custom || filePath(String(source?.id ?? ''))
    if (!target) return { ok: false, error: 'NOT_FOUND' }

    const parsed = readDocument(target)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    let database: DatabaseSync
    try {
      database = openDatabase(file)
    } catch {
      return { ok: false, error: 'READ_FAILED' }
    }

    // 恢复是覆盖式写入，先把现状存一份，用户后悔时还能找回
    let safety: BackupRecord | null
    try {
      safety = snapshot(database, true)
    } catch {
      return { ok: false, error: 'WRITE_FAILED' }
    }

    try {
      applyState(database, parsed.document.data)
    } catch {
      return { ok: false, error: 'INVALID' }
    }
    return {
      ok: true,
      counts: parsed.document.counts,
      ...(safety ? { safety } : {})
    }
  }

  return {
    init: async () => {
      try {
        ensureDirectory()
      } catch {
        // 目录不可用时由具体操作报错，初始化不阻塞应用启动
      }
    },
    directory: () => directory,
    list,
    create,
    remove,
    exportTo,
    inspect,
    restore,
    filePath
  }
}
