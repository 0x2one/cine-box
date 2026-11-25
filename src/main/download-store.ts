import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  promises as fsp,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { randomUUID } from 'crypto'

/**
 * 下载中心的数据层。
 *
 * 记录文件固定在 userData/Data/Downloads/records.json，不跟着「下载目录」走：
 * 用户改了保存位置以后，之前下到旧目录里的记录仍然要能查、能播。
 * 媒体文件本身存在用户配置的 downloadPath 下（app-settings），这里只存绝对路径。
 *
 * 两种记录：
 * - file：单个媒体文件（path 就是文件）；
 * - hls：离线缓存包（packageDir 是一个目录，path 是目录里的 index.m3u8）。
 */

/** 任务状态：等待 / 下载中 / 暂停 / 完成 / 失败 / 取消 */
export type DownloadStatus = 'waiting' | 'downloading' | 'paused' | 'done' | 'failed' | 'canceled'

/** 记录类型：单个文件 / 本地 HLS 缓存包 */
export type DownloadKind = 'file' | 'hls'

/** 缓存包导出 MP4 的状态；不影响下载状态本身 */
export type DownloadMp4Status = 'idle' | 'queued' | 'converting' | 'done' | 'failed'

const MP4_STATUSES: DownloadMp4Status[] = ['idle', 'queued', 'converting', 'done', 'failed']

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
  /** 记录类型；老记录按 file 处理 */
  kind: DownloadKind
  /** 片名 */
  title: string
  /** 集名 / 版本名（单集下载时为空串） */
  episodeName: string
  /** 文件名 / 缓存包名（展示用） */
  fileName: string
  /** 保存的绝对路径；hls 记录是包里的 index.m3u8 */
  path: string
  /** hls 缓存包目录；file 记录为空串 */
  packageDir: string
  /** 来源视频 id（VideoDetailSource.id）：播放页按它定位当前集 */
  sourceId?: number
  /** 来源站显示名，下载中心区分同名的集 */
  sourceName: string
  /** 来源里的线路下标（playLines 原始下标） */
  lineIndex?: number
  /** 线路里的集数下标（episodes 原始下标） */
  episodeIndex?: number
  /** 入队时解析出的 m3u8 地址：下载中心「重试」用 */
  url: string
  status: DownloadStatus
  /** 0–100 */
  progress: number
  /** 已下载字节数 */
  receivedBytes: number
  /** 当前下载速度（字节 / 秒，仅下载中有意义；不持久化，读盘时归零） */
  speed: number
  /** 总字节数，未知时为 0 */
  totalBytes: number
  /** 失败原因（只对 failed 有意义） */
  error: string
  /** ISO 8601 */
  createdAt: string
  updatedAt: string
  /** 完成时间，未完成时为空串 */
  completedAt: string
  /** 导出 MP4 的绝对路径；没导出过为空串 */
  mp4Path: string
  /** 导出 MP4 的字节数；没有时为 0 */
  mp4Size: number
  /** MP4 导出状态 */
  mp4Status: DownloadMp4Status
  /** MP4 导出进度 0–100 */
  mp4Progress: number
  /** 导出失败原因（只对 failed 有意义） */
  mp4Error: string
  /** 导出提示（如 HEVC 兼容性提醒），不影响成功状态 */
  mp4Note: string
  /** 导出完成时间，未完成时为空串 */
  mp4UpdatedAt: string
}

/** 给渲染层的记录：额外带上磁盘上的真实状态（文件可能被用户手动删掉 / 挪走） */
export interface DownloadRecordView extends DownloadRecord {
  /** 文件（hls 是 playlist）是否还在原路径 */
  exists: boolean
  /** 磁盘上的实际大小；文件不在时为 0 */
  size: number
  /** 导出的 MP4 是否还在原路径 */
  mp4Exists: boolean
}

export interface DownloadInput {
  videoId?: number
  kind?: DownloadKind
  title: string
  episodeName?: string
  /** 绝对路径；fileName 不传就取 basename */
  path: string
  /** hls 缓存包目录 */
  packageDir?: string
  fileName?: string
  sourceId?: number
  sourceName?: string
  lineIndex?: number
  episodeIndex?: number
  /** m3u8 地址，重试时复用 */
  url?: string
  status?: DownloadStatus
  progress?: number
  receivedBytes?: number
  totalBytes?: number
}

export interface DownloadPatch {
  status?: DownloadStatus
  progress?: number
  receivedBytes?: number
  /** 当前速度（字节 / 秒），分片进度更新时带上 */
  speed?: number
  totalBytes?: number
  error?: string
  completedAt?: string
  /** 重新入队时可能换一条新鲜地址 */
  url?: string
  title?: string
  episodeName?: string
  /** MP4 导出相关：由 mp4-export 队列写入 */
  mp4Path?: string
  mp4Size?: number
  mp4Status?: DownloadMp4Status
  mp4Progress?: number
  mp4Error?: string
  mp4Note?: string
  mp4UpdatedAt?: string
}

/** 播放页按「视频 + 来源 + 线路 + 集」定位一条缓存记录 */
export interface DownloadEpisodeKey {
  videoId: number
  sourceId: number
  lineIndex: number
  episodeIndex: number
}

export interface DownloadRemoveResult {
  records: DownloadRecordView[]
  /** 真的从磁盘删掉的文件 / 缓存包数 */
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
  /** 按「视频 + 来源 + 线路 + 集」查记录（批量缓存去重用） */
  findEpisode: (key: DownloadEpisodeKey) => DownloadRecord | null
  /** 某部视频的全部原始记录（播放页缓存状态用，不 stat 文件） */
  listByVideo: (videoId: number) => DownloadRecord[]
  /** 当前保存目录（读设置，改完立即生效） */
  directory: () => string
  /** 确保保存目录存在，返回它 */
  ensureDirectory: () => string
  /** 下载引擎落一条新记录 */
  add: (input: DownloadInput) => DownloadRecordView
  /** 一次落多条记录：只写一次文件、只通知一次（批量缓存用） */
  addMany: (inputs: DownloadInput[]) => DownloadRecordView[]
  /**
   * 更新进度 / 状态；记录已不存在时返回 null。
   * persist=false 只改内存并发进度事件（分片级进度不重写 records.json）。
   * 结构变化（增删）才走 onChange，update 一律只走 onProgress。
   */
  update: (
    id: string,
    patch: DownloadPatch,
    options?: { persist?: boolean }
  ) => DownloadRecordView | null
  /** 删除记录；deleteFiles 为真时同时删文件 / 缓存包（只删下载目录内的） */
  remove: (ids: string[], options?: { deleteFiles?: boolean }) => DownloadRemoveResult
  /** 清掉已完成 / 失败 / 已取消的记录 */
  clearFinished: (options?: { deleteFiles?: boolean }) => DownloadRemoveResult
  /** 把内存里的记录同步写盘（退出前用） */
  flush: () => void
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

function isMp4Status(value: unknown): value is DownloadMp4Status {
  return typeof value === 'string' && MP4_STATUSES.includes(value as DownloadMp4Status)
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

/** 非负整数下标；非法值返回 undefined */
function toIndex(value: unknown, min = 0): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min ? parsed : undefined
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
  const kind: DownloadKind = data.kind === 'hls' ? 'hls' : 'file'
  const packageDir =
    kind === 'hls'
      ? toText(data.packageDir).trim() && isAbsolute(toText(data.packageDir).trim())
        ? resolve(toText(data.packageDir).trim())
        : dirname(resolve(path))
      : ''
  const videoId = Number(data.videoId)
  const mp4Status = isMp4Status(data.mp4Status) ? data.mp4Status : 'idle'
  const mp4Path = toText(data.mp4Path).trim()
  return {
    id,
    videoId: Number.isInteger(videoId) && videoId > 0 ? videoId : undefined,
    kind,
    title: toText(data.title).trim() || basename(path),
    episodeName: toText(data.episodeName),
    fileName: toText(data.fileName).trim() || basename(packageDir || path),
    path: resolve(path),
    packageDir,
    sourceId: toIndex(data.sourceId, 1),
    sourceName: toText(data.sourceName),
    lineIndex: toIndex(data.lineIndex),
    episodeIndex: toIndex(data.episodeIndex),
    url: toText(data.url).slice(0, 4096),
    status,
    progress: status === 'done' ? 100 : toProgress(data.progress),
    receivedBytes: Math.max(toNumber(data.receivedBytes), 0),
    // 速度是运行期数据，不从磁盘恢复
    speed: 0,
    totalBytes: Math.max(toNumber(data.totalBytes), 0),
    error: toText(data.error),
    createdAt,
    updatedAt: toText(data.updatedAt) || createdAt,
    completedAt: toText(data.completedAt),
    mp4Path: mp4Path && isAbsolute(mp4Path) ? resolve(mp4Path) : '',
    mp4Size: Math.max(toNumber(data.mp4Size), 0),
    mp4Status,
    mp4Progress: mp4Status === 'done' ? 100 : toProgress(data.mp4Progress),
    mp4Error: toText(data.mp4Error),
    mp4Note: toText(data.mp4Note),
    mp4UpdatedAt: toText(data.mp4UpdatedAt)
  }
}

function recordFromInput(input: DownloadInput, now: string): DownloadRecord {
  const path = resolve(input.path)
  const kind: DownloadKind = input.kind === 'hls' ? 'hls' : 'file'
  const packageDir = kind === 'hls' ? resolve(input.packageDir ?? dirname(path)) : ''
  return {
    id: randomUUID().replace(/-/g, ''),
    videoId: Number.isInteger(input.videoId) ? input.videoId : undefined,
    kind,
    title: input.title.trim() || basename(packageDir || path),
    episodeName: input.episodeName?.trim() ?? '',
    fileName: input.fileName?.trim() || basename(packageDir || path) || basename(path),
    path,
    packageDir,
    sourceId: toIndex(input.sourceId, 1),
    sourceName: input.sourceName?.trim() ?? '',
    lineIndex: toIndex(input.lineIndex),
    episodeIndex: toIndex(input.episodeIndex),
    url: (input.url ?? '').slice(0, 4096),
    status: input.status ?? 'waiting',
    progress: toProgress(input.progress),
    receivedBytes: Math.max(input.receivedBytes ?? 0, 0),
    speed: 0,
    totalBytes: Math.max(input.totalBytes ?? 0, 0),
    error: '',
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === 'done' ? now : '',
    mp4Path: '',
    mp4Size: 0,
    mp4Status: 'idle',
    mp4Progress: 0,
    mp4Error: '',
    mp4Note: '',
    mp4UpdatedAt: ''
  }
}

export function createDownloadStore(options: {
  directory: () => string
  /** 记录有结构变化（增 / 删 / 清空）时通知渲染层 */
  onChange?: () => void
  /** 进度 / 状态更新：只发轻量事件，不触发整页重拉 */
  onProgress?: (record: DownloadRecordView) => void
}): DownloadStore {
  const file = join(app.getPath('userData'), 'Data', 'Downloads', 'records.json')
  /**
   * 删除缓存包时先进回收目录，再后台慢慢删：
   * 一个包可能有几百个分片，整组删除几百集时同步 rm 会把主进程卡住几分钟。
   * 同一卷 rename 是瞬时的；跨卷 / 被占用时退回后台删。
   */
  const trashDir = join(app.getPath('userData'), 'Data', 'Downloads', 'trash')
  let records: DownloadRecord[] = []
  /**
   * 后台删除队列：整组删几千集时如果每集都并发 rm，会把 fs 线程池和事件循环堵死。
   * 串行删；应用退出时剩下的交给下次启动清 trash。
   */
  const deleteQueue: string[] = []
  let deleting = false
  function drainDeletes(): void {
    if (deleting) return
    deleting = true
    void (async () => {
      while (deleteQueue.length > 0) {
        const target = deleteQueue.shift() as string
        await fsp.rm(target, { recursive: true, force: true }).catch(() => {})
      }
      deleting = false
    })()
  }
  function scheduleDelete(target: string): void {
    deleteQueue.push(target)
    drainDeletes()
  }

  const directory = (): string => resolve(options.directory())

  function persist(): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, records }, null, 2), 'utf-8')
    } catch {
      // 落盘失败不阻塞界面：本次运行内记录仍然可用
    }
  }

  function view(record: DownloadRecord): DownloadRecordView {
    // MP4 是导出产物，可能被用户挪走：单独给一个 mp4Exists，不影响缓存包本身的 exists
    const mp4Exists = Boolean(record.mp4Path && existsSync(record.mp4Path))
    if (record.kind === 'hls') {
      // playlist 存在才算可播；进度期间 totalBytes 还是 0，用已下载字节兜底
      return {
        ...record,
        exists: existsSync(record.path),
        size: record.totalBytes > 0 ? record.totalBytes : record.receivedBytes,
        mp4Exists
      }
    }
    try {
      const info = statSync(record.path)
      return {
        ...record,
        exists: info.isFile(),
        size: info.isFile() ? info.size : 0,
        mp4Exists
      }
    } catch {
      return { ...record, exists: false, size: 0, mp4Exists }
    }
  }

  function sortRecords(): DownloadRecord[] {
    return [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** 把目录挪进回收目录；失败就排进后台删除。调用方只关心「已经安排删除」 */
  function discardPackage(target: string): void {
    const staged = join(trashDir, randomUUID())
    try {
      mkdirSync(trashDir, { recursive: true })
      renameSync(target, staged)
    } catch {
      scheduleDelete(target)
      return
    }
    scheduleDelete(staged)
  }

  /**
   * 删除记录对应的文件，返回是否算「删掉了」。
   * 只动当前下载目录内的文件；文件本来就不在时也算完成（用户的目的已经达到）。
   */
  function deleteFile(record: DownloadRecord): boolean {
    let deleted = true
    try {
      if (record.kind === 'hls') {
        const dir = record.packageDir || dirname(record.path)
        if (!isInsideDirectory(directory(), dir)) deleted = false
        else if (existsSync(dir)) discardPackage(dir)
      } else if (!isInsideDirectory(directory(), record.path)) {
        deleted = false
      } else if (existsSync(record.path)) {
        unlinkSync(record.path)
      }
    } catch {
      deleted = false
    }
    // 导出的 MP4 跟着记录一起删；不在当前下载目录时只保留，不冒险删
    if (record.mp4Path) {
      if (!isInsideDirectory(directory(), record.mp4Path)) {
        if (existsSync(record.mp4Path)) deleted = false
      } else {
        try {
          if (existsSync(record.mp4Path)) unlinkSync(record.mp4Path)
        } catch {
          deleted = false
        }
      }
    }
    return deleted
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
      options.onChange?.()
    }
    return { records: sortRecords().map(view), deletedFiles, keptFiles }
  }

  return {
    init: async () => {
      // 上次退出时没删完的回收目录在后台清掉，不阻塞启动
      void fsp.rm(trashDir, { recursive: true, force: true }).catch(() => {})
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
    findEpisode: (key) =>
      records.find(
        (record) =>
          record.videoId === key.videoId &&
          record.sourceId === key.sourceId &&
          record.lineIndex === key.lineIndex &&
          record.episodeIndex === key.episodeIndex
      ) ?? null,
    listByVideo: (videoId) => records.filter((record) => record.videoId === videoId),
    directory,
    ensureDirectory: () => {
      const dir = directory()
      mkdirSync(dir, { recursive: true })
      return dir
    },
    add: (input) => {
      const record = recordFromInput(input, new Date().toISOString())
      records.push(record)
      persist()
      options.onChange?.()
      return view(record)
    },
    addMany: (inputs) => {
      if (inputs.length === 0) return []
      const now = new Date().toISOString()
      const added = inputs.map((input) => recordFromInput(input, now))
      records.push(...added)
      persist()
      options.onChange?.()
      return added.map(view)
    },
    update: (id, patch, updateOptions) => {
      const record = records.find((item) => item.id === id)
      if (!record) return null
      if (isStatus(patch.status)) {
        record.status = patch.status
        // 只有下载中才有速度，暂停 / 完成 / 失败 / 取消一律清零
        if (patch.status !== 'downloading') record.speed = 0
        if (patch.status === 'done') {
          record.progress = 100
          record.completedAt = patch.completedAt ?? new Date().toISOString()
          record.error = ''
        } else {
          // 重新入队 / 取消 / 失败都先清掉上一次的错误，再按需写入本次原因
          record.error = patch.status === 'failed' ? (patch.error ?? '') : ''
          if (patch.status === 'waiting') record.completedAt = ''
        }
      }
      if (patch.progress !== undefined) record.progress = toProgress(patch.progress)
      if (patch.receivedBytes !== undefined) record.receivedBytes = Math.max(patch.receivedBytes, 0)
      if (patch.speed !== undefined) record.speed = Math.max(0, Math.round(patch.speed))
      if (patch.totalBytes !== undefined) record.totalBytes = Math.max(patch.totalBytes, 0)
      if (patch.error !== undefined && record.status === 'failed') record.error = patch.error
      if (patch.completedAt !== undefined) record.completedAt = patch.completedAt
      if (patch.url !== undefined) record.url = patch.url.slice(0, 4096)
      if (patch.title !== undefined) record.title = patch.title.trim() || record.title
      if (patch.episodeName !== undefined) record.episodeName = patch.episodeName
      if (patch.mp4Path !== undefined) {
        const nextPath = patch.mp4Path.trim()
        record.mp4Path = nextPath && isAbsolute(nextPath) ? resolve(nextPath) : ''
      }
      if (patch.mp4Size !== undefined) record.mp4Size = Math.max(0, Math.round(patch.mp4Size))
      if (patch.mp4Progress !== undefined) record.mp4Progress = toProgress(patch.mp4Progress)
      if (patch.mp4Error !== undefined) record.mp4Error = patch.mp4Error.slice(0, 500)
      if (patch.mp4Note !== undefined) record.mp4Note = patch.mp4Note.slice(0, 200)
      if (patch.mp4UpdatedAt !== undefined) record.mp4UpdatedAt = patch.mp4UpdatedAt
      if (patch.mp4Status !== undefined && isMp4Status(patch.mp4Status)) {
        record.mp4Status = patch.mp4Status
        // 完成时统一把进度补满，避免最后一次进度事件落后在 99%
        if (patch.mp4Status === 'done') record.mp4Progress = 100
      }
      record.updatedAt = new Date().toISOString()
      if (updateOptions?.persist !== false) persist()
      const next = view(record)
      options.onProgress?.(next)
      return next
    },
    remove: (ids, opts) => removeRecords(new Set(ids), Boolean(opts?.deleteFiles)),
    clearFinished: (opts) => {
      const finished = records.filter(
        (record) =>
          record.status === 'done' || record.status === 'failed' || record.status === 'canceled'
      )
      return removeRecords(new Set(finished.map((record) => record.id)), Boolean(opts?.deleteFiles))
    },
    flush: () => persist(),
    recordsFile: () => file
  }
}
