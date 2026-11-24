import { app } from 'electron'
import { existsSync, mkdirSync, promises as fsp, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { randomUUID } from 'crypto'

/**
 * 下载中心的数据层。
 *
 * 记录文件固定在 userData/Data/Downloads/records.json，不跟着「下载目录」走：
 * 用户改了保存位置以后，之前下到旧目录里的记录仍然要能查、能播。
 * 媒体文件本身存在用户配置的 downloadPath 下（app-settings），这里只存绝对路径。
 */

/** 任务状态：等待 / 下载中 / 暂停 / 完成 / 失败 / 取消 */
export type DownloadStatus = 'waiting' | 'downloading' | 'paused' | 'done' | 'failed' | 'canceled'

const STATUSES: DownloadStatus[] = [
  'waiting',
  'downloading',
  'paused',
  'done',
  'failed',
  'canceled'
]

export interface DownloadRecord {
  /** 主进程生成的 id（UUID 去掉横线） */
  id: string
  /** 来源视频 id；纯直链下载时可以没有 */
  videoId?: number
  /** 片名 */
  title: string
  /** 集名 / 版本名（单集下载时为空串） */
  episodeName: string
  /** 文件名（path 的 basename，展示用） */
  fileName: string
  /** 保存的绝对路径 */
  path: string
  status: DownloadStatus
  /** 0–100 */
  progress: number
  /** 已下载字节数 */
  receivedBytes: number
  /** 总字节数，未知时为 0 */
  totalBytes: number
  /** 失败原因（只对 failed 有意义） */
  error: string
  /** ISO 8601 */
  createdAt: string
  updatedAt: string
  /** 完成时间，未完成时为空串 */
  completedAt: string
}

/** 给渲染层的记录：额外带上磁盘上的真实状态（文件可能被用户手动删掉 / 挪走） */
export interface DownloadRecordView extends DownloadRecord {
  /** 文件是否还在原路径 */
  exists: boolean
  /** 磁盘上的实际大小；文件不在时为 0 */
  size: number
}

export interface DownloadInput {
  videoId?: number
  title: string
  episodeName?: string
  /** 绝对路径；fileName 不传就取 basename */
  path: string
  status?: DownloadStatus
  progress?: number
  receivedBytes?: number
  totalBytes?: number
}

export interface DownloadPatch {
  status?: DownloadStatus
  progress?: number
  receivedBytes?: number
  totalBytes?: number
  error?: string
  completedAt?: string
}

export interface DownloadRemoveResult {
  records: DownloadRecordView[]
  /** 真的从磁盘删掉的文件数 */
  deletedFiles: number
  /** 想删但没删的文件数（不在下载目录 / 文件不存在 / 删除失败） */
  keptFiles: number
}

export interface DownloadStore {
  init: () => Promise<void>
  /** 按创建时间倒序，附带文件是否存在与真实大小 */
  list: () => DownloadRecordView[]
  find: (id: string) => DownloadRecord | null
  /** 按绝对路径查记录：自定义协议只放行这里登记过的文件 */
  findByPath: (file: string) => DownloadRecord | null
  /** 当前保存目录（读设置，改完立即生效） */
  directory: () => string
  /** 确保保存目录存在，返回它 */
  ensureDirectory: () => string
  /** 下载引擎（后续步骤）落一条新记录 */
  add: (input: DownloadInput) => DownloadRecordView
  /** 更新进度 / 状态；记录已不存在时返回 null */
  update: (id: string, patch: DownloadPatch) => DownloadRecordView | null
  /** 删除记录；deleteFiles 为真时同时删文件（只删下载目录内的） */
  remove: (ids: string[], options?: { deleteFiles?: boolean }) => DownloadRemoveResult
  /** 清掉已完成 / 失败 / 已取消的记录 */
  clearFinished: (options?: { deleteFiles?: boolean }) => DownloadRemoveResult
  /** 记录文件路径（排查用） */
  recordsFile: () => string
}

/** file 是否在 dir 内部（相等不算，避免把目录本身当文件删掉） */
export function isInsideDirectory(dir: string, file: string): boolean {
  const base = resolve(dir)
  const target = resolve(file)
  if (base === target) return false
  const prefix =
    base.endsWith('\\') || base.endsWith('/')
      ? base
      : `${base}${process.platform === 'win32' ? '\\' : '/'}`
  // Windows 下盘符 / 路径大小写不敏感，比较前统一小写
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  return normalize(target).startsWith(normalize(prefix))
}

function isStatus(value: unknown): value is DownloadStatus {
  return typeof value === 'string' && STATUSES.includes(value as DownloadStatus)
}

function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toProgress(value: unknown): number {
  return Math.min(Math.max(toNumber(value), 0), 100)
}

/** 读文件时把历史 / 手改过的记录收敛成合法形状，坏记录直接丢掉 */
function normalizeRecord(raw: unknown): DownloadRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const path = toText(data.path).trim()
  if (!path || !isAbsolute(path)) return null
  const id = toText(data.id).trim() || randomUUID().replace(/-/g, '')
  const createdAt = toText(data.createdAt) || new Date().toISOString()
  const status = isStatus(data.status) ? data.status : 'done'
  const videoId = Number(data.videoId)
  return {
    id,
    videoId: Number.isInteger(videoId) && videoId > 0 ? videoId : undefined,
    title: toText(data.title).trim() || basename(path),
    episodeName: toText(data.episodeName),
    fileName: toText(data.fileName).trim() || basename(path),
    path: resolve(path),
    status,
    progress: status === 'done' ? 100 : toProgress(data.progress),
    receivedBytes: Math.max(toNumber(data.receivedBytes), 0),
    totalBytes: Math.max(toNumber(data.totalBytes), 0),
    error: toText(data.error),
    createdAt,
    updatedAt: toText(data.updatedAt) || createdAt,
    completedAt: toText(data.completedAt)
  }
}

export function createDownloadStore(options: {
  directory: () => string
  /** 记录有变化时通知渲染层（进度之外的增删改都走这里） */
  onChange?: () => void
}): DownloadStore {
  const file = join(app.getPath('userData'), 'Data', 'Downloads', 'records.json')
  let records: DownloadRecord[] = []

  const directory = (): string => resolve(options.directory())

  function persist(): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, records }, null, 2), 'utf-8')
    } catch {
      // 落盘失败不阻塞界面：本次运行内记录仍然可用
    }
  }

  function notify(): void {
    options.onChange?.()
  }

  function view(record: DownloadRecord): DownloadRecordView {
    try {
      const info = statSync(record.path)
      return { ...record, exists: info.isFile(), size: info.isFile() ? info.size : 0 }
    } catch {
      return { ...record, exists: false, size: 0 }
    }
  }

  function sortRecords(): DownloadRecord[] {
    return [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /**
   * 删除记录对应的文件，返回是否算「删掉了」。
   * 只动当前下载目录内的文件；文件本来就不在时也算完成（用户的目的已经达到）。
   */
  function deleteFile(record: DownloadRecord): boolean {
    try {
      if (!isInsideDirectory(directory(), record.path)) return false
      if (!existsSync(record.path)) return true
      unlinkSync(record.path)
      return true
    } catch {
      return false
    }
  }

  function removeRecords(ids: Set<string>, deleteFiles: boolean): DownloadRemoveResult {
    const removed: DownloadRecord[] = []
    records = records.filter((record) => {
      if (!ids.has(record.id)) return true
      removed.push(record)
      return false
    })
    let deletedFiles = 0
    let keptFiles = 0
    if (deleteFiles) {
      for (const record of removed) {
        if (deleteFile(record)) deletedFiles += 1
        else keptFiles += 1
      }
    }
    if (removed.length > 0) {
      persist()
      notify()
    }
    return { records: sortRecords().map(view), deletedFiles, keptFiles }
  }

  return {
    init: async () => {
      records = []
      try {
        const raw = await fsp.readFile(file, 'utf-8')
        const data = JSON.parse(raw) as { records?: unknown }
        const list = Array.isArray(data?.records) ? data.records : []
        const seen = new Set<string>()
        for (const item of list) {
          const record = normalizeRecord(item)
          if (!record || seen.has(record.path)) continue
          seen.add(record.path)
          records.push(record)
        }
      } catch {
        // 没有记录文件（首次启动）或文件损坏：从空列表开始
      }
      persist()
    },
    list: () => sortRecords().map(view),
    find: (id) => records.find((record) => record.id === id) ?? null,
    findByPath: (target) => {
      const wanted = resolve(target)
      return records.find((record) => resolve(record.path) === wanted) ?? null
    },
    directory,
    ensureDirectory: () => {
      const dir = directory()
      mkdirSync(dir, { recursive: true })
      return dir
    },
    add: (input) => {
      const now = new Date().toISOString()
      const path = resolve(input.path)
      const record: DownloadRecord = {
        id: randomUUID().replace(/-/g, ''),
        videoId: Number.isInteger(input.videoId) ? input.videoId : undefined,
        title: input.title.trim() || basename(path),
        episodeName: input.episodeName?.trim() ?? '',
        fileName: basename(path),
        path,
        status: input.status ?? 'waiting',
        progress: toProgress(input.progress),
        receivedBytes: Math.max(input.receivedBytes ?? 0, 0),
        totalBytes: Math.max(input.totalBytes ?? 0, 0),
        error: '',
        createdAt: now,
        updatedAt: now,
        completedAt: input.status === 'done' ? now : ''
      }
      records.push(record)
      persist()
      notify()
      return view(record)
    },
    update: (id, patch) => {
      const record = records.find((item) => item.id === id)
      if (!record) return null
      if (isStatus(patch.status)) {
        record.status = patch.status
        if (patch.status === 'done') {
          record.progress = 100
          record.completedAt = patch.completedAt ?? new Date().toISOString()
        }
        if (patch.status === 'failed') record.error = patch.error ?? ''
      }
      if (patch.progress !== undefined) record.progress = toProgress(patch.progress)
      if (patch.receivedBytes !== undefined) record.receivedBytes = Math.max(patch.receivedBytes, 0)
      if (patch.totalBytes !== undefined) record.totalBytes = Math.max(patch.totalBytes, 0)
      if (patch.error !== undefined && record.status === 'failed') record.error = patch.error
      if (patch.completedAt !== undefined) record.completedAt = patch.completedAt
      record.updatedAt = new Date().toISOString()
      persist()
      notify()
      return view(record)
    },
    remove: (ids, opts) => removeRecords(new Set(ids), Boolean(opts?.deleteFiles)),
    clearFinished: (opts) => {
      const finished = records.filter(
        (record) =>
          record.status === 'done' || record.status === 'failed' || record.status === 'canceled'
      )
      return removeRecords(new Set(finished.map((record) => record.id)), Boolean(opts?.deleteFiles))
    },
    recordsFile: () => file
  }
}
