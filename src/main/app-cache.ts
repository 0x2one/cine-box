import { app, session } from 'electron'
import { promises as fsp } from 'fs'
import type { Dirent } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * 缓存管理：扫描 / 清理 Chromium 运行时产生的磁盘缓存。
 *
 * 只处理 userData 下固定的缓存目录（网页缓存、代码缓存、着色器缓存等），
 * 不碰 app-settings.json、Data/cine-box.db、Local Storage 等真实数据。
 */

/** 进度阶段：enumerate 统计文件 → measure 计算体积；清理时为 clear */
export type CachePhase = 'enumerate' | 'measure' | 'clear'

export interface CacheProgress {
  phase: CachePhase
  /** 0-100：enumerate 阶段没有总量，固定为 0；measure / clear 阶段是真实进度 */
  percent: number
  /** 已统计到的缓存体积（字节） */
  bytes: number
  /** 已处理的文件数（enumerate 阶段为已发现的文件数） */
  files: number
  /** 当前所在缓存目录的中文名称 */
  current: string
}

export interface CacheSummary {
  /** 缓存总字节数 */
  size: number
  /** 缓存文件总数 */
  files: number
  /** ISO 8601，本次扫描完成时间 */
  scannedAt: string
}

export interface CacheClearResult extends CacheSummary {
  /** 本次清理掉的字节数 */
  freed: number
  /** 清理失败、仍被占用的缓存目录数 */
  locked: number
}

export interface CacheManager {
  scan: (onProgress?: (progress: CacheProgress) => void) => Promise<CacheSummary>
  clear: (onProgress?: (progress: CacheProgress) => void) => Promise<CacheClearResult>
}

const CACHE_DIRS: { key: string; label: string }[] = [
  { key: 'Cache', label: '网页缓存' },
  { key: 'Code Cache', label: '脚本编译缓存' },
  { key: 'GPUCache', label: 'GPU 缓存' },
  { key: 'GPUPersistentCache', label: 'GPU 持久缓存' },
  { key: 'DawnCache', label: 'Dawn 缓存' },
  { key: 'DawnGraphiteCache', label: 'Dawn Graphite 缓存' },
  { key: 'DawnWebGPUCache', label: 'WebGPU 缓存' },
  { key: 'GrShaderCache', label: '图形着色器缓存' },
  { key: 'ShaderCache', label: 'Skia 着色器缓存' },
  { key: 'Shared Dictionary', label: '共享字典缓存' }
]

/** 进度事件最小间隔，避免刷屏卡住渲染进程 */
const PROGRESS_INTERVAL = 80
/** 清理时复用最近一次扫描结果的有效期，超时则重新扫描作为清理基线 */
const BASELINE_TTL = 60 * 1000
/** 统计体积时并发 stat 的数量 */
const BATCH_SIZE = 32

interface CacheRoot {
  label: string
  path: string
}

function cacheRoots(): CacheRoot[] {
  const bases = [app.getPath('userData')]
  if (process.platform === 'darwin') {
    // macOS 上 Chromium 也可能把 HTTP 缓存放在 ~/Library/Caches/<应用名> 下
    bases.push(join(homedir(), 'Library', 'Caches', app.getName()))
  }

  const roots: CacheRoot[] = []
  const seen = new Set<string>()
  for (const base of bases) {
    for (const dir of CACHE_DIRS) {
      const path = join(base, dir.key)
      const fence = path.toLowerCase()
      if (seen.has(fence)) continue
      seen.add(fence)
      roots.push({ label: dir.label, path })
    }
  }
  return roots
}

async function probeRoots(): Promise<CacheRoot[]> {
  const existing: CacheRoot[] = []
  for (const root of cacheRoots()) {
    try {
      const stat = await fsp.stat(root.path)
      if (stat.isDirectory()) existing.push(root)
    } catch {
      // 目录不存在：该缓存尚未生成
    }
  }
  return existing
}

/** 按时间节流并保证阶段切换 / 完成事件不被丢弃 */
function createReporter(
  onProgress?: (progress: CacheProgress) => void
): (progress: CacheProgress) => void {
  let lastTime = 0
  let lastPhase: CachePhase | null = null
  return (progress) => {
    if (!onProgress) return
    const now = Date.now()
    const phaseChanged = progress.phase !== lastPhase
    if (!phaseChanged && progress.percent < 100 && now - lastTime < PROGRESS_INTERVAL) return
    lastTime = now
    lastPhase = progress.phase
    try {
      onProgress(progress)
    } catch {
      // 渲染进程已销毁，忽略
    }
  }
}

async function measure(
  roots: CacheRoot[],
  report: (progress: CacheProgress) => void
): Promise<CacheSummary> {
  // 先枚举文件清单：拿到文件总数后才能给出真实的百分比进度
  const files: { path: string; root: number }[] = []
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index]
    const stack = [root.path]
    while (stack.length > 0) {
      const dir = stack.pop() as string
      let entries: Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) files.push({ path: full, root: index })
      }
      report({
        phase: 'enumerate',
        percent: 0,
        bytes: 0,
        files: files.length,
        current: root.label
      })
    }
  }
  report({
    phase: 'enumerate',
    percent: 0,
    bytes: 0,
    files: files.length,
    current: ''
  })

  let bytes = 0
  let measured = 0
  for (let offset = 0; offset < files.length; offset += BATCH_SIZE) {
    const batch = files.slice(offset, offset + BATCH_SIZE)
    const sizes = await Promise.all(
      batch.map(async (file) => {
        try {
          const stat = await fsp.stat(file.path)
          return stat.isFile() ? stat.size : 0
        } catch {
          return 0
        }
      })
    )
    for (const size of sizes) bytes += size
    measured += batch.length
    report({
      phase: 'measure',
      percent: Math.round((measured / files.length) * 100),
      bytes,
      files: measured,
      current: roots[batch[0].root]?.label ?? ''
    })
  }
  if (files.length === 0) {
    report({ phase: 'measure', percent: 100, bytes: 0, files: 0, current: '' })
  }

  return {
    size: bytes,
    files: files.length,
    scannedAt: new Date().toISOString()
  }
}

export function createCacheManager(): CacheManager {
  /** 扫描 / 清理串行执行，避免两次扫描互相干扰 */
  let tail: Promise<unknown> = Promise.resolve()
  let lastSummary: CacheSummary | null = null
  let lastSummaryAt = 0

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async function doScan(onProgress?: (progress: CacheProgress) => void): Promise<CacheSummary> {
    const roots = await probeRoots()
    const summary = await measure(roots, createReporter(onProgress))
    lastSummary = summary
    lastSummaryAt = Date.now()
    return summary
  }

  async function doClear(
    onProgress?: (progress: CacheProgress) => void
  ): Promise<CacheClearResult> {
    const report = createReporter(onProgress)

    // 清理基线：优先用最近一次扫描结果计算释放量，过旧则重新扫一遍
    let before = lastSummary
    if (!before || Date.now() - lastSummaryAt > BASELINE_TTL) {
      before = await doScan()
    }

    const roots = await probeRoots()
    const step = (percent: number, current: string): void => {
      report({ phase: 'clear', percent, bytes: 0, files: 0, current })
    }

    step(2, '正在清理网页缓存')
    const ses = session.defaultSession
    try {
      // Chromium 的「缓存」数据类型：HTTP 缓存、代码缓存、着色器缓存与 CacheStorage
      await ses.clearData({ dataTypes: ['cache'] })
    } catch {
      try {
        await ses.clearCache()
      } catch {
        // 内存缓存清理失败不影响随后直接删除磁盘目录
      }
    }
    try {
      await ses.clearHostResolverCache()
    } catch {
      // DNS 缓存清理失败不影响整体
    }

    // 兜底删除磁盘残留；被进程占用的文件会保留并计入 locked
    let locked = 0
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index]
      step(15 + Math.round((index / roots.length) * 75), `正在清理${root.label}`)
      try {
        await fsp.rm(root.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      } catch {
        locked += 1
      }
    }

    step(92, '正在重新统计缓存')
    const after = await measure(roots, () => {})
    const freed = Math.max(0, (before?.size ?? 0) - after.size)
    report({
      phase: 'clear',
      percent: 100,
      bytes: after.size,
      files: after.files,
      current: '清理完成'
    })
    lastSummary = after
    lastSummaryAt = Date.now()
    return { ...after, freed, locked }
  }

  return {
    scan: (onProgress) => serialize(() => doScan(onProgress)),
    clear: (onProgress) => serialize(() => doClear(onProgress))
  }
}
