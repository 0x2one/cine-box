import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, promises as fsp, writeFileSync } from 'fs'
import { join } from 'path'

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

export interface SiteStore {
  init: () => Promise<void>
  list: () => Site[]
  add: (input: SiteInput) => AddSiteResult
  update: (id: string, input: SiteInput) => UpdateSiteResult
  remove: (id: string) => RemoveSiteResult
}

const MAX_NAME = 60
const MAX_REMARK = 200

interface StoreFile {
  version: 1
  sites?: Site[]
}

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

export function createSiteStore(): SiteStore {
  const file = join(app.getPath('userData'), 'sites.json')
  let sites: Site[] = []

  async function readFile(): Promise<void> {
    try {
      const raw = await fsp.readFile(file, 'utf-8')
      const data = JSON.parse(raw) as StoreFile
      sites = Array.isArray(data?.sites)
        ? data.sites.map(normalizeSite).filter((site): site is Site => site !== null)
        : []
    } catch {
      // 首次运行或文件损坏：从空列表开始
      sites = []
    }
  }

  function persist(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const payload: StoreFile = { version: 1, sites }
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
    } catch {
      // 落盘失败不阻塞界面，本次运行内仍生效
    }
  }

  /** 新加的站点排在最前 */
  function sorted(): Site[] {
    return [...sites].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  return {
    init: async () => {
      await readFile()
      persist()
    },
    list: sorted,
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
      sites.push(site)
      persist()
      return { ok: true, site }
    },
    update: (id, input) => {
      const index = sites.findIndex((site) => site.id === id)
      if (index === -1) return { ok: false, error: 'NOT_FOUND' }
      const checked = validateSiteInput(input)
      if (!checked.ok) return checked
      const site: Site = {
        ...sites[index],
        ...checked.value,
        updatedAt: new Date().toISOString()
      }
      sites = sites.map((item, position) => (position === index ? site : item))
      persist()
      return { ok: true, site }
    },
    remove: (id) => {
      const remaining = sites.filter((site) => site.id !== id)
      const removed = remaining.length !== sites.length
      if (removed) {
        sites = remaining
        persist()
      }
      return { ok: removed, sites: sorted() }
    }
  }
}
