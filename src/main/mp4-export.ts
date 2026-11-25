import { spawn, type ChildProcess } from 'child_process'
import { existsSync, promises as fsp } from 'fs'
import { dirname, join, resolve } from 'path'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import type { DownloadRecord, DownloadStore } from './download-store'

/**
 * 把已完成的 HLS 缓存包导出成 MP4（只换容器，不重编码）。
 *
 * - 缓存包的分片 / 密钥 / init 都是本地相对路径，ffmpeg 直接读包里的 index.m3u8；
 * - 密钥文件名是 `key-*.bin`，ffmpeg 6 起默认拦截非媒体扩展名，必须带
 *   `-allowed_extensions ALL`（只对本地缓存包使用，不接受外部地址）；
 * - 输出先写 `.part`，成功后再 rename，失败 / 取消不会留下半截 MP4；
 * - 导出与下载是两条队列：一次只转一集，避免多集同时抢占磁盘和 CPU。
 */

/** MP4 导出入队结果 */
export interface Mp4ExportEnqueueResult {
  ok: boolean
  /** 本次新入队的集数 */
  queued: number
  /** 已导出 / 已在队列中的集数 */
  existing: number
  /** 缓存未完成 / 文件缺失而跳过的集数 */
  skipped: number
}

export interface Mp4ExportEngine {
  /** 启动清理：上次退出时没转完的记录收敛为已完成 / 失败，并清掉 .part */
  init: () => Promise<void>
  enqueue: (ids: string[], options?: { force?: boolean }) => Mp4ExportEnqueueResult
  cancel: (ids: string[]) => Promise<void>
  shutdown: () => void
}

class Mp4ExportError extends Error {
  code: string
  detail: string

  constructor(code: string, message: string, detail = '') {
    super(message)
    this.name = 'Mp4ExportError'
    this.code = code
    this.detail = detail
  }
}

interface ActiveExport {
  child: ChildProcess | null
  canceled: boolean
  promise: Promise<void>
}

/** Windows 文件名里不能出现的字符：统一去掉再压缩空白 */
function safeName(value: string): string {
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || '\\/:*?"<>|'.includes(char)) continue
    text += char
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 80)
}

/** 导出文件名：优先用记录里的缓存包名（已经是「片名 集名」），退回片名 + 集名 */
function exportBaseName(record: DownloadRecord): string {
  const fromRecord = safeName(record.fileName)
  if (fromRecord) return fromRecord
  return safeName(`${record.title} ${record.episodeName}`) || '视频'
}

/** 读播放列表的时长（秒）：master 取第一个变体，媒体列表累加 EXTINF */
async function playlistDuration(file: string, depth = 0): Promise<number> {
  if (depth > 3) return 0
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return 0
  }
  const lines = text.split(/\r?\n/)
  const hasVariant = lines.some((line) => line.trim().toUpperCase().startsWith('#EXT-X-STREAM-INF'))
  if (hasVariant) {
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim().toUpperCase().startsWith('#EXT-X-STREAM-INF')) continue
      let uriIndex = index + 1
      while (
        uriIndex < lines.length &&
        (!lines[uriIndex].trim() || lines[uriIndex].trim().startsWith('#'))
      ) {
        uriIndex += 1
      }
      const uri = lines[uriIndex]?.trim()
      if (!uri || /^[a-z]+:/i.test(uri)) continue
      return playlistDuration(resolve(dirname(file), uri), depth + 1)
    }
    return 0
  }
  let total = 0
  for (const line of lines) {
    const match = /^#EXTINF:\s*([\d.]+)/i.exec(line.trim())
    if (match) total += Number(match[1]) || 0
  }
  return total
}

/** 导出目录所在磁盘的可用空间是否够放这一集 MP4（留 64MB 余量） */
async function hasEnoughSpace(dir: string, estimatedBytes: number): Promise<boolean> {
  try {
    const stats = await fsp.statfs(dir, { bigint: true })
    const free = stats.bavail * stats.bsize
    const need = BigInt(Math.max(0, Math.round(estimatedBytes))) + 64n * 1024n * 1024n
    return free > need
  } catch {
    // statfs 在某些网络盘上不可用：不要因为查不到空间就阻止导出
    return true
  }
}

function ffmpegBinary(): string {
  if (!ffmpegStatic) {
    throw new Mp4ExportError('NO_FFMPEG', '没有找到内置的 ffmpeg，请重新安装应用')
  }
  const binary = app.isPackaged
    ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStatic
  if (!existsSync(binary)) {
    throw new Mp4ExportError('NO_FFMPEG', '内置 ffmpeg 不存在，请重新安装应用')
  }
  return binary
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/** 把 ffmpeg 的 stderr 收敛成一句中文提示 */
function describeError(error: unknown): string {
  if (error instanceof Mp4ExportError) {
    if (error.code === 'DISK' || error.code === 'NO_FFMPEG') return error.message
    const detail = error.detail
    if (/no space left|not enough space/i.test(detail)) return '磁盘空间不足'
    if (/permission denied|access is denied/i.test(detail)) return '没有写入权限，检查下载目录'
    if (/invalid data|corrupt|moov atom not found/i.test(detail)) {
      return '缓存文件损坏，请回到播放页重新缓存'
    }
    if (/blocked for security reasons/i.test(detail)) return '无法读取缓存密钥，请重新缓存'
    if (/no such file or directory/i.test(detail)) return '缓存文件不完整，请重新缓存'
    const line = lastLine(detail)
    return line ? `MP4 转换失败：${line.slice(0, 120)}` : error.message
  }
  const message = (error as Error)?.message
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC') return '磁盘空间不足'
  if (code === 'EACCES' || code === 'EPERM') return '没有写入权限，检查下载目录'
  return message ? message.slice(0, 160) : 'MP4 转换失败'
}

/** 选输出路径：重新导出时覆盖原 MP4，否则在同名文件后面补 (2)、(3) */
async function chooseTarget(record: DownloadRecord, exportDir: string): Promise<string> {
  if (record.mp4Path && existsSync(record.mp4Path)) return record.mp4Path
  const base = exportBaseName(record)
  let target = join(exportDir, `${base}.mp4`)
  let index = 2
  while (existsSync(target)) {
    target = join(exportDir, `${base} (${index}).mp4`)
    index += 1
  }
  return target
}

/** 跑一次 ffmpeg，解析 `-progress pipe:1` 的 out_time_us 报进度；成功时返回 stderr 供识别编码 */
function runFfmpeg(
  binary: string,
  args: string[],
  duration: number,
  task: ActiveExport,
  onProgress: (percent: number) => void
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    task.child = child
    let stderr = ''
    let buffer = ''
    let lastReport = 0

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue
        const micros = Number(line.slice(eq + 1).trim())
        if (!Number.isFinite(micros) || micros < 0 || duration <= 0) continue
        const now = Date.now()
        // 进度事件不用太密：界面 500ms 刷新一次就够，也少打扰 records.json
        if (now - lastReport < 500) continue
        lastReport = now
        onProgress(Math.min(99, Math.round((micros / 1_000_000 / duration) * 100)))
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // 只留最后一段，足够定位错误，也不会把整段日志攒在内存里
      stderr = (stderr + chunk).slice(-8_000)
    })

    child.once('error', (error) => {
      task.child = null
      rejectPromise(
        new Mp4ExportError(
          'NO_FFMPEG',
          '内置 ffmpeg 无法启动，请重新安装应用',
          (error as Error).message
        )
      )
    })
    child.once('close', (code) => {
      task.child = null
      if (task.canceled) {
        resolvePromise(stderr)
        return
      }
      if (code === 0) {
        resolvePromise(stderr)
        return
      }
      rejectPromise(new Mp4ExportError('FFMPEG', 'MP4 转换失败', stderr))
    })
    // 极端情况下取消发生在 spawn 之前：监听器挂好后再补一刀，避免任务继续跑
    if (task.canceled) child.kill()
  })
}

export function createMp4Export(options: { store: DownloadStore }): Mp4ExportEngine {
  const { store } = options
  const queue: string[] = []
  const active = new Map<string, ActiveExport>()
  let shuttingDown = false

  /** 取消 / 退出时把状态恢复到转换前：原来有 MP4 就继续显示已导出 */
  function restoreAfterCancel(
    record: DownloadRecord,
    previous: { path: string; size: number; note: string; updatedAt: string }
  ): void {
    const oldExists = Boolean(previous.path && existsSync(previous.path))
    store.update(
      record.id,
      {
        mp4Status: oldExists ? 'done' : 'idle',
        mp4Path: oldExists ? previous.path : '',
        mp4Size: oldExists ? previous.size : 0,
        mp4Progress: oldExists ? 100 : 0,
        mp4Error: '',
        mp4UpdatedAt: oldExists ? previous.updatedAt : ''
      },
      { persist: true }
    )
  }

  async function runTask(record: DownloadRecord, task: ActiveExport): Promise<void> {
    const previous = {
      path: record.mp4Path,
      size: record.mp4Size,
      note: record.mp4Note,
      updatedAt: record.mp4UpdatedAt
    }
    const exportDir = join(store.directory(), '导出')
    let part = ''
    try {
      await fsp.mkdir(exportDir, { recursive: true })
      const target = await chooseTarget(record, exportDir)
      part = `${target}.part`
      await fsp.rm(part, { force: true }).catch(() => {})
      const estimated = Math.max(record.totalBytes, record.receivedBytes)
      if (!(await hasEnoughSpace(exportDir, estimated))) {
        throw new Mp4ExportError('DISK', '磁盘空间不足，无法导出 MP4')
      }

      store.update(
        record.id,
        { mp4Status: 'converting', mp4Path: target, mp4Progress: 0, mp4Error: '' },
        { persist: true }
      )
      if (task.canceled) {
        restoreAfterCancel(record, previous)
        return
      }
      const duration = await playlistDuration(record.path)
      const metadataTitle = `${record.title}${record.episodeName ? ` ${record.episodeName}` : ''}`
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 200)
      const args = [
        '-hide_banner',
        // info 级别会把输入的 Video: h264 / hevc 打在 stderr 里，成功后据此提示 HEVC 兼容性
        '-loglevel',
        'info',
        '-nostats',
        '-progress',
        'pipe:1',
        // 缓存包的密钥是 key-*.bin，ffmpeg 默认会拦截非媒体扩展名
        '-allowed_extensions',
        'ALL',
        // 只允许本地文件：包里的 playlist 已经全部改写成本地相对路径
        '-protocol_whitelist',
        'file,crypto,data',
        '-i',
        record.path,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-metadata',
        `title=${metadataTitle}`,
        '-y',
        '-f',
        'mp4',
        part
      ]

      const ffmpegLog = await runFfmpeg(ffmpegBinary(), args, duration, task, (percent) => {
        store.update(record.id, { mp4Progress: percent }, { persist: false })
      })
      if (task.canceled) {
        restoreAfterCancel(record, previous)
        return
      }

      const info = await fsp.stat(part)
      // Windows 上目标存在时 rename 会失败：先删旧文件，再落成品
      await fsp.rm(target, { force: true }).catch(() => {})
      await fsp.rename(part, target)
      part = ''
      const hevc = /\bVideo:\s*(?:hevc|h265)\b/i.test(ffmpegLog)
      store.update(
        record.id,
        {
          mp4Status: 'done',
          mp4Path: target,
          mp4Size: info.size,
          mp4Progress: 100,
          mp4Error: '',
          mp4Note: hevc ? 'HEVC 编码，部分设备可能无法播放' : '',
          mp4UpdatedAt: new Date().toISOString()
        },
        { persist: true }
      )
    } catch (error) {
      if (task.canceled) {
        restoreAfterCancel(record, previous)
        return
      }
      const oldExists = Boolean(previous.path && existsSync(previous.path))
      store.update(
        record.id,
        {
          mp4Status: 'failed',
          mp4Path: oldExists ? previous.path : '',
          mp4Size: oldExists ? previous.size : 0,
          mp4Progress: 0,
          mp4Error: describeError(error),
          mp4Note: oldExists ? previous.note : '',
          mp4UpdatedAt: oldExists ? previous.updatedAt : ''
        },
        { persist: true }
      )
    } finally {
      if (part) await fsp.rm(part, { force: true }).catch(() => {})
    }
  }

  function startTask(record: DownloadRecord): void {
    const task: ActiveExport = {
      child: null,
      canceled: false,
      promise: Promise.resolve()
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
    if (shuttingDown || active.size > 0) return
    while (queue.length > 0) {
      const id = queue.shift() as string
      if (active.has(id)) continue
      const record = store.find(id)
      if (!record || record.mp4Status !== 'queued') continue
      startTask(record)
      return
    }
  }

  /** 取消等待 / 转换中的任务，恢复取消前的导出状态 */
  async function cancelOne(id: string): Promise<void> {
    const queuedIndex = queue.indexOf(id)
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1)
      const record = store.find(id)
      if (record) {
        const oldExists = Boolean(record.mp4Path && existsSync(record.mp4Path))
        store.update(
          id,
          {
            mp4Status: oldExists ? 'done' : 'idle',
            mp4Progress: oldExists ? 100 : 0,
            mp4Error: ''
          },
          { persist: true }
        )
      }
      return
    }
    const task = active.get(id)
    if (!task) return
    task.canceled = true
    task.child?.kill()
    await task.promise.catch(() => {})
  }

  return {
    init: async () => {
      for (const record of store.list()) {
        if (record.mp4Status !== 'queued' && record.mp4Status !== 'converting') continue
        if (record.mp4Path) {
          await fsp.rm(`${record.mp4Path}.part`, { force: true }).catch(() => {})
        }
        // 转换中途退出：新文件还没 rename 到目标路径，目标路径上若有文件就是上一次的成品，
        // 继续按「已导出」显示；没有成品才标失败
        let oldSize = record.mp4Size
        const oldExists = Boolean(record.mp4Path && existsSync(record.mp4Path))
        if (oldExists) {
          try {
            oldSize = (await fsp.stat(record.mp4Path)).size
          } catch {
            oldSize = record.mp4Size
          }
        }
        store.update(
          record.id,
          {
            mp4Status: oldExists ? 'done' : 'failed',
            mp4Size: oldExists ? oldSize : 0,
            mp4Progress: oldExists ? 100 : 0,
            mp4Error: oldExists ? '' : '应用退出，MP4 转换未完成',
            mp4Note: oldExists ? record.mp4Note : '',
            mp4UpdatedAt: oldExists ? record.mp4UpdatedAt : ''
          },
          { persist: true }
        )
      }
      store.flush()
    },

    enqueue: (ids, enqueueOptions) => {
      const result: Mp4ExportEnqueueResult = { ok: true, queued: 0, existing: 0, skipped: 0 }
      const seen = new Set<string>()
      for (const raw of ids) {
        const id = String(raw)
        if (seen.has(id)) continue
        seen.add(id)
        const record = store.find(id)
        if (
          !record ||
          record.kind !== 'hls' ||
          record.status !== 'done' ||
          !existsSync(record.path)
        ) {
          result.skipped += 1
          continue
        }
        if (active.has(id) || queue.includes(id)) {
          result.existing += 1
          continue
        }
        const hasMp4 = Boolean(record.mp4Path && existsSync(record.mp4Path))
        if (!enqueueOptions?.force && record.mp4Status === 'done' && hasMp4) {
          result.existing += 1
          continue
        }
        store.update(id, { mp4Status: 'queued', mp4Progress: 0, mp4Error: '' }, { persist: true })
        queue.push(id)
        result.queued += 1
      }
      pump()
      return result
    },

    cancel: async (ids) => {
      await Promise.all(ids.map((id) => cancelOne(String(id))))
    },

    shutdown: () => {
      shuttingDown = true
      queue.length = 0
      for (const task of active.values()) {
        task.canceled = true
        task.child?.kill()
      }
    }
  }
}
