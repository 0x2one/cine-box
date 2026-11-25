import { existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { net } from 'electron'
import { downloadHlsPackage, HlsDownloadError, type HlsFetch } from './hls-download'
import type { DownloadInput, DownloadRecord, DownloadStore } from './download-store'

/**
 * 离线缓存队列。
 *
 * 下载中心和播放页只写记录，真正拉流在这里：
 * - 并发槽位每次填槽都读一次设置（1–5），调小不打断在跑的任务；
 * - 同一集重复提交会去重，失败 / 缺失的记录会重开；
 * - 分片级进度不重写 records.json，只通过 store.update 的 onProgress 推给界面；
 * - 应用退出时中断的任务不在这里收尾，下次启动 init() 统一转失败并清半成品。
 */

/** 一次入队请求里的一集 */
export interface DownloadTaskInput {
  videoId?: number
  title: string
  episodeName: string
  sourceId?: number
  sourceName?: string
  lineIndex?: number
  episodeIndex?: number
  /** 入队时解析出的 m3u8 地址 */
  url: string
}

export interface DownloadEnqueueResult {
  queued: number
  existing: number
  restarted: number
}

export interface DownloadEngine {
  /** 启动清理：上次退出时没跑完的下载转失败并删半成品；暂停的保留断点 */
  init: () => Promise<void>
  enqueueMany: (inputs: DownloadTaskInput[]) => Promise<DownloadEnqueueResult>
  /** 用记录里保存的地址重试；没有地址 / 状态不允许时返回错误码 */
  restart: (id: string) => { ok: boolean; error?: string }
  /** 暂停：等任务真正停下来再返回；已下载的分片留作断点 */
  pause: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** 继续暂停的任务，从已下载的分片接着下 */
  resume: (id: string) => { ok: boolean; error?: string }
  /** 等待任务真正停下来再返回，删除记录前调用 */
  cancel: (id: string) => Promise<void>
  cancelMany: (ids: string[]) => Promise<void>
  wake: () => void
  shutdown: () => void
}

interface ActiveTask {
  controller: AbortController
  promise: Promise<void>
  canceled: boolean
  paused: boolean
}

const isActiveStatus = (status: DownloadRecord['status']): boolean =>
  status === 'waiting' || status === 'downloading' || status === 'paused'

/** Windows 文件名里不能出现的字符：统一去掉再压缩空白 */
function safeName(value: string): string {
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    // 控制字符和 Windows 的非法字符都不进文件名
    if (code < 32 || '\\/:*?"<>|'.includes(char)) continue
    text += char
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 60)
}

function readableName(input: DownloadTaskInput): string {
  const title = safeName(input.title) || '视频'
  const episode = safeName(input.episodeName) || '缓存'
  return `${title} ${episode}`
}

function errorText(error: unknown): string {
  if (error instanceof HlsDownloadError) {
    if (error.code === 'ABORT') return '已取消'
    if (error.code === 'NETWORK') return '网络错误，稍后重试'
    if (error.code === 'LIVE') return '直播流不支持缓存'
    if (error.code === 'ENCRYPTED') return '这个视频的加密方式暂不支持缓存'
    if (error.code === 'NO_SEGMENTS') return '播放列表里没有可缓存的分片'
    if (error.code === 'PLAYLIST') return '播放列表解析失败，换一条线路试试'
    if (error.code === 'TOO_LARGE') return '播放列表或分片超过大小限制'
    if (error.code === 'DISK') return '写入磁盘失败，检查下载目录是否可写'
    const http = /^HTTP_(\d{3})$/.exec(error.code)
    if (http) {
      const status = Number(http[1])
      if (status === 401 || status === 403) {
        return '缓存地址已失效或无权限，请回到播放页重新缓存'
      }
      if (status === 404 || status === 410) return '播放地址不存在或已失效'
      return `播放服务器返回 ${status}`
    }
    return error.code
  }
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC') return '磁盘空间不足'
  if (code === 'EACCES' || code === 'EPERM') return '没有写入权限，检查下载目录'
  const message = (error as Error)?.message
  return message ? message.slice(0, 200) : '缓存失败'
}

async function removePartial(dir: string): Promise<void> {
  if (!dir || dir === '/') return
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}

export function createDownloadEngine(options: {
  store: DownloadStore
  /** 每次填槽读一次设置 */
  getConcurrency: () => number
  /** 单集内部的分片并发；每个缓存任务开始时读一次 */
  getSegmentConcurrency: () => number
}): DownloadEngine {
  const { store, getConcurrency, getSegmentConcurrency } = options
  const queue: string[] = []
  const active = new Map<string, ActiveTask>()
  let shuttingDown = false

  const fetchImpl: HlsFetch = (url, init) => net.fetch(url, init)

  async function runTask(record: DownloadRecord, task: ActiveTask): Promise<void> {
    const dir = record.packageDir
    const reportInterval = 400
    let lastReport = Date.now()
    let lastTime = Date.now()
    // 断点续传时记录里的 receivedBytes 是上次暂停的进度，用它当测速基线，
    // 避免把已经在磁盘上的分片算成这一轮刚下载的字节。
    let lastBytes = Math.max(record.receivedBytes, 0)
    let speed = 0
    try {
      await fsp.mkdir(dir, { recursive: true })
      store.update(record.id, { status: 'downloading', speed: 0 }, { persist: true })
      const result = await downloadHlsPackage({
        url: record.url,
        dir,
        signal: task.controller.signal,
        fetchImpl,
        concurrency: getSegmentConcurrency(),
        onProgress: (progress) => {
          const now = Date.now()
          if (now - lastReport < reportInterval) return
          const elapsed = Math.max(1, now - lastTime)
          const delta = Math.max(0, progress.receivedBytes - lastBytes)
          const instant = (delta * 1000) / elapsed
          // 0.6 旧值 + 0.4 新值：分片大小不均匀时数字也不会乱跳
          speed = speed > 0 ? speed * 0.6 + instant * 0.4 : instant
          lastReport = now
          lastTime = now
          lastBytes = progress.receivedBytes
          const percent =
            progress.total > 0
              ? Math.min(99, Math.round((progress.downloaded / progress.total) * 100))
              : 0
          store.update(
            record.id,
            { progress: percent, receivedBytes: progress.receivedBytes, speed },
            { persist: false }
          )
        }
      })
      store.update(
        record.id,
        {
          status: 'done',
          progress: 100,
          receivedBytes: result.bytes,
          totalBytes: result.bytes,
          speed: 0
        },
        { persist: true }
      )
    } catch (error) {
      if (task.paused) {
        // 暂停保留已下载的分片和进度，下次 resume 从断点继续
        store.update(record.id, { status: 'paused', speed: 0 }, { persist: true })
        return
      }
      if (task.controller.signal.aborted) {
        // 应用退出时交给下次启动的 init() 收尾；用户取消则立刻落库并清理
        if (!shuttingDown) {
          store.update(record.id, { status: 'canceled', speed: 0 }, { persist: true })
          await removePartial(dir)
        }
        return
      }
      store.update(
        record.id,
        { status: 'failed', error: errorText(error), speed: 0 },
        { persist: true }
      )
      // 已下载的分片保留：下载中心的「重试」会从断点继续，不再从头下
    }
  }

  function startTask(record: DownloadRecord): void {
    const controller = new AbortController()
    const task: ActiveTask = {
      controller,
      promise: Promise.resolve(),
      canceled: false,
      paused: false
    }
    task.promise = runTask(record, task)
      .catch(() => {})
      .finally(() => {
        active.delete(record.id)
        pump()
      })
    active.set(record.id, task)
  }

  function pump(): void {
    if (shuttingDown) return
    const limit = Math.max(1, getConcurrency())
    while (active.size < limit && queue.length > 0) {
      const id = queue.shift() as string
      // 重试连点 / 重复入队可能让同一个 id 排两次；已经在跑的直接跳过
      if (active.has(id)) continue
      const record = store.find(id)
      // 排队期间被取消 / 删除的直接跳过
      if (!record || record.status !== 'waiting') continue
      startTask(record)
    }
  }

  /** 等待中的任务被暂停 / 取消后从队列里摘掉，避免之后重复入队 */
  function dropFromQueue(id: string): void {
    const index = queue.indexOf(id)
    if (index >= 0) queue.splice(index, 1)
  }

  /** 重开一条失败 / 缺失的记录：清旧包，重置字段，重新排队 */
  async function resetRecord(record: DownloadRecord, input: DownloadTaskInput): Promise<void> {
    if (record.packageDir) await removePartial(record.packageDir)
    store.update(
      record.id,
      {
        status: 'waiting',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        error: '',
        completedAt: '',
        url: input.url,
        title: input.title,
        episodeName: input.episodeName
      },
      { persist: true }
    )
  }

  async function cancelOne(id: string): Promise<void> {
    const record = store.find(String(id))
    if (!record) return
    if (record.status === 'waiting' || record.status === 'paused') {
      // 排队中 / 已暂停：没有在跑的任务，直接落库；断点分片一并清掉
      dropFromQueue(record.id)
      store.update(record.id, { status: 'canceled', speed: 0 }, { persist: true })
      if (record.kind === 'hls') await removePartial(record.packageDir)
      return
    }
    const task = active.get(record.id)
    if (!task) return
    task.canceled = true
    task.controller.abort()
    await task.promise.catch(() => {})
  }

  async function pauseOne(id: string): Promise<{ ok: boolean; error?: string }> {
    const record = store.find(String(id))
    if (!record) return { ok: false, error: 'NOT_FOUND' }
    if (record.status === 'paused') return { ok: true }
    if (record.status === 'waiting') {
      dropFromQueue(record.id)
      store.update(record.id, { status: 'paused', speed: 0 }, { persist: true })
      return { ok: true }
    }
    if (record.status !== 'downloading') return { ok: false, error: 'NOT_PAUSABLE' }
    const task = active.get(record.id)
    if (!task) {
      // 任务刚好结束 / 被其它流程接管：按当前状态落成暂停
      store.update(record.id, { status: 'paused', speed: 0 }, { persist: true })
      return { ok: true }
    }
    task.paused = true
    task.controller.abort()
    await task.promise.catch(() => {})
    return { ok: true }
  }

  function resumeOne(id: string): { ok: boolean; error?: string } {
    const record = store.find(String(id))
    if (!record) return { ok: false, error: 'NOT_FOUND' }
    if (record.status !== 'paused') return { ok: false, error: 'NOT_PAUSED' }
    // 暂停目录被手动删掉时没有断点可续，进度归零重新下
    const hasCheckpoint = Boolean(record.packageDir && existsSync(record.packageDir))
    store.update(
      record.id,
      {
        status: 'waiting',
        speed: 0,
        error: '',
        completedAt: '',
        progress: hasCheckpoint ? record.progress : 0,
        receivedBytes: hasCheckpoint ? record.receivedBytes : 0,
        totalBytes: 0
      },
      { persist: true }
    )
    dropFromQueue(record.id)
    queue.push(record.id)
    pump()
    return { ok: true }
  }

  return {
    init: async () => {
      for (const record of store.list()) {
        // 暂停记录保留断点文件，重启后仍可在下载中心继续
        if (record.status === 'paused') continue
        if (!isActiveStatus(record.status)) continue
        // 被应用退出打断的下载：转失败但保留已下载分片，重试时从断点继续
        store.update(
          record.id,
          { status: 'failed', error: '应用退出，缓存未完成', speed: 0 },
          { persist: true }
        )
      }
      store.flush()
    },

    enqueueMany: async (inputs) => {
      const base = store.ensureDirectory()
      const result: DownloadEnqueueResult = { queued: 0, existing: 0, restarted: 0 }
      const pending: string[] = []
      const additions: DownloadInput[] = []

      for (const input of inputs) {
        const hasIdentity =
          typeof input.videoId === 'number' &&
          typeof input.sourceId === 'number' &&
          typeof input.lineIndex === 'number' &&
          typeof input.episodeIndex === 'number'
        const existing = hasIdentity
          ? store.findEpisode({
              videoId: input.videoId as number,
              sourceId: input.sourceId as number,
              lineIndex: input.lineIndex as number,
              episodeIndex: input.episodeIndex as number
            })
          : null

        if (existing) {
          const playable = existing.status === 'done' ? existsSync(existing.path) : false
          if (isActiveStatus(existing.status) || playable) {
            result.existing += 1
            continue
          }
          await resetRecord(existing, input)
          pending.push(existing.id)
          result.restarted += 1
          continue
        }

        const name = readableName(input)
        const packageDir = join(base, `${name}-${randomUUID().slice(0, 8)}`)
        additions.push({
          videoId: input.videoId,
          kind: 'hls',
          title: input.title,
          episodeName: input.episodeName,
          fileName: name,
          path: join(packageDir, 'index.m3u8'),
          packageDir,
          sourceId: input.sourceId,
          sourceName: input.sourceName ?? '',
          lineIndex: input.lineIndex,
          episodeIndex: input.episodeIndex,
          url: input.url,
          status: 'waiting'
        })
      }

      if (additions.length > 0) {
        const added = store.addMany(additions)
        for (const record of added) pending.push(record.id)
        result.queued = added.length
      }

      queue.push(...pending)
      pump()
      return result
    },

    restart: (id) => {
      const record = store.find(String(id))
      if (!record) return { ok: false, error: 'NOT_FOUND' }
      if (isActiveStatus(record.status)) return { ok: false, error: 'NOT_RETRYABLE' }
      if (!record.url) return { ok: false, error: 'NO_URL' }
      // 失败 / 中断留下的分片就是断点：重试不要再把目录删掉
      const hasCheckpoint = Boolean(record.packageDir && existsSync(record.packageDir))
      store.update(
        record.id,
        {
          status: 'waiting',
          speed: 0,
          error: '',
          completedAt: '',
          progress: hasCheckpoint ? record.progress : 0,
          receivedBytes: hasCheckpoint ? record.receivedBytes : 0,
          totalBytes: 0
        },
        { persist: true }
      )
      dropFromQueue(record.id)
      queue.push(record.id)
      pump()
      return { ok: true }
    },

    pause: pauseOne,
    resume: resumeOne,

    cancel: cancelOne,

    cancelMany: async (ids) => {
      await Promise.all(ids.map((id) => cancelOne(id)))
    },

    wake: () => pump(),

    shutdown: () => {
      shuttingDown = true
      queue.length = 0
      for (const task of active.values()) {
        task.canceled = true
        task.controller.abort()
      }
    }
  }
}
