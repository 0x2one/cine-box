import { fetchCollectText } from './collect-http'
import type { CollectLogStore } from './collect-log-store'
import type { Site } from './site-store'
import { parseCollectPage, type CollectedPage } from './video-collect-parser'
import type { VideoCacheStore } from './video-cache-store'
import type { VideoDetailCache } from './video-detail-cache'
import type {
  CollectMode,
  CollectOrigin,
  FetchRange,
  VideoCollectProgress,
  VideoCollectStartInput,
  VideoCollectStartResult
} from './video-types'

export interface VideoCollector {
  enqueue: (
    input: VideoCollectStartInput,
    origin: CollectOrigin
  ) => Promise<VideoCollectStartResult>
  cancel: (input: { siteId: string; mode?: CollectMode; fetchRange?: FetchRange }) => {
    ok: boolean
  }
  /** 取消运行中任务与排队任务，但保留采集器可用（清空缓存前调用） */
  cancelAll: () => Promise<void>
  /** 清空缓存期间暂停入队，避免重建数据库时又启动任务 */
  suspend: () => void
  resume: () => void
  /** 退出前调用：取消任务并禁止后续入队 */
  shutdown: () => void
}

interface QueueItem extends VideoCollectStartInput {
  origin: CollectOrigin
  /** 上次在 replacing 阶段中断，重新入队后直接继续清理 */
  resumeReplace: boolean
}

interface ActiveTask {
  item: QueueItem
  controller: AbortController
  cancelled: boolean
}

const DEFAULT_MAX_PAGES: Record<CollectMode, number> = { full: 500, incremental: 100 }
const REPLACE_BATCH = 1000

function nowIso(): string {
  return new Date().toISOString()
}

function isMode(value: unknown): value is CollectMode {
  return value === 'full' || value === 'incremental'
}

function isRange(value: unknown): value is FetchRange {
  return value === 'all' || value === '24h' || value === '48h'
}

function progressId(siteId: string, mode: CollectMode, range: FetchRange): string {
  return `${siteId}:${mode}:${range}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 采集器：全局单队列，手动与定时共用；同一 (site, mode, range) 不重复入队。
 * 每页一个事务写列表，进度落库后推事件；full + all 完整结束后才做全量替换。
 */
export function createVideoCollector(options: {
  store: VideoCacheStore
  details: VideoDetailCache
  logs: CollectLogStore
  listSites: () => Site[]
  emitProgress: (progress: VideoCollectProgress) => void
}): VideoCollector {
  const { store, details, logs, listSites, emitProgress } = options
  const queue: QueueItem[] = []
  let active: ActiveTask | null = null
  let activeDone: Promise<void> | null = null
  let pumping = false
  let disposed = false
  let suspended = false

  function emit(progress: VideoCollectProgress | null): void {
    if (progress) emitProgress(progress)
  }

  function log(
    level: 'info' | 'warn' | 'error',
    item: { siteId: string; mode: CollectMode; fetchRange: FetchRange },
    message: string,
    detail = ''
  ): void {
    logs.append({
      level,
      siteId: item.siteId,
      mode: item.mode,
      fetchRange: item.fetchRange,
      message,
      detail
    })
  }

  function isQueuedOrActive(siteId: string, mode: CollectMode, fetchRange: FetchRange): boolean {
    const id = progressId(siteId, mode, fetchRange)
    if (active && progressId(active.item.siteId, active.item.mode, active.item.fetchRange) === id) {
      return true
    }
    return queue.some((item) => progressId(item.siteId, item.mode, item.fetchRange) === id)
  }

  async function enqueue(
    input: VideoCollectStartInput,
    origin: CollectOrigin
  ): Promise<VideoCollectStartResult> {
    if (disposed) return { ok: false, error: 'CACHE_UNAVAILABLE' }
    if (suspended) return { ok: false, error: 'BUSY' }
    const siteId = String(input?.siteId ?? '').trim()
    if (!siteId || !isMode(input?.mode) || !isRange(input?.fetchRange)) {
      return { ok: false, error: 'INVALID_INPUT' }
    }
    // 全量模式只对全量范围有意义
    if (input.mode === 'full' && input.fetchRange !== 'all') {
      return { ok: false, error: 'INVALID_INPUT' }
    }
    const site = listSites().find((item) => item.id === siteId)
    if (!site) return { ok: false, error: 'NOT_FOUND' }
    if (isQueuedOrActive(siteId, input.mode, input.fetchRange)) {
      return { ok: false, error: 'ALREADY_QUEUED' }
    }
    const existing = store.getProgress(progressId(siteId, input.mode, input.fetchRange))
    const progress = store.prepareTask({
      siteId,
      mode: input.mode,
      fetchRange: input.fetchRange,
      restart: input.restart
    })
    const item: QueueItem = {
      siteId,
      mode: input.mode,
      fetchRange: input.fetchRange,
      restart: Boolean(input.restart),
      maxPages: input.maxPages,
      allowEmpty: Boolean(input.allowEmpty),
      origin,
      resumeReplace: existing?.status === 'replacing'
    }
    queue.push(item)
    emit(progress)
    // 站点 / 模式 / 范围日志行头里已经有了，这里不再重复
    log('info', item, origin === 'schedule' ? '定时采集已入队' : '已加入采集队列')
    void pump()
    return { ok: true, progress }
  }

  function buildUrl(site: Site, range: FetchRange, page: number): string {
    const url = new URL(site.address)
    url.searchParams.set('ac', 'detail')
    url.searchParams.set('pg', String(page))
    url.searchParams.set('pagesize', '100')
    if (range === '24h') url.searchParams.set('h', '24')
    else if (range === '48h') url.searchParams.set('h', '48')
    else url.searchParams.delete('h')
    if (site.format === 'xml') url.searchParams.set('at', 'xml')
    else url.searchParams.delete('at')
    return url.toString()
  }

  async function fetchPage(
    site: Site,
    item: QueueItem,
    page: number,
    signal: AbortSignal
  ): Promise<{ ok: true; value: CollectedPage } | { ok: false; error: string }> {
    const response = await fetchCollectText(buildUrl(site, item.fetchRange, page), signal)
    if (!response.ok) {
      if (response.error === 'ABORT') return { ok: false, error: 'ABORT' }
      return {
        ok: false,
        error: response.error === 'HTTP' ? `HTTP_${response.status ?? 0}` : 'NETWORK'
      }
    }
    try {
      return { ok: true, value: parseCollectPage(response.text, site.format) }
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? 'PARSE')
      return { ok: false, error: code }
    }
  }

  async function finishWithError(
    item: QueueItem,
    progressIdValue: string,
    error: string
  ): Promise<void> {
    const updated = store.updateProgress(progressIdValue, {
      status: 'error',
      error,
      finishedAt: nowIso()
    })
    emit(updated)
    log('error', item, '采集失败', error)
  }

  async function replaceAll(
    item: QueueItem,
    progress: VideoCollectProgress,
    signal: AbortSignal
  ): Promise<VideoCollectProgress> {
    const runToken = progress.startedAt || nowIso()
    const runStartTs = Number.isNaN(Date.parse(progress.startedAt))
      ? 0
      : Date.parse(progress.startedAt)
    let deleted = progress.deleted
    let updated = store.updateProgress(progress.id, {
      status: 'replacing',
      error: ''
    })
    emit(updated)
    log(
      'info',
      item,
      '开始全量替换',
      `本次标记 token=${runToken}，删除 ${runToken ? '本次未返回的旧来源' : '无'}`
    )

    while (true) {
      if (signal.aborted || disposed) {
        const paused = store.updateProgress(progress.id, { status: 'paused' })
        emit(paused)
        log('warn', item, '全量替换已暂停', '下次继续清理')
        return paused ?? progress
      }
      const stale = store.listStaleSources(item.siteId, runToken, runStartTs, REPLACE_BATCH)
      if (stale.length === 0) break
      const rows = stale
        .map((entry) => store.getDetailSource(entry.id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      const removed = store.deleteSources(stale.map((entry) => entry.id))
      deleted += removed
      for (const row of rows) await details.removeSourceFile(row)
      updated = store.updateProgress(progress.id, {
        deletedDelta: removed,
        status: 'replacing'
      })
      emit(updated)
      await delay(0)
    }

    const done = store.updateProgress(progress.id, {
      status: 'done',
      error: '',
      finishedAt: nowIso()
    })
    emit(done)
    log('info', item, '全量替换完成', `删除 ${deleted} 条本次未返回的来源`)
    return done ?? progress
  }

  async function runTask(item: QueueItem): Promise<void> {
    const task: ActiveTask = { item, controller: new AbortController(), cancelled: false }
    active = task
    const signal = task.controller.signal
    const site = listSites().find((entry) => entry.id === item.siteId)
    let progress = store.getProgress(progressId(item.siteId, item.mode, item.fetchRange))
    if (!progress) return
    if (!site) {
      await finishWithError(item, progress.id, 'NOT_FOUND')
      return
    }
    // 对账用的极小表：每个采集过的站点一行，启动时只读它
    store.ensureSite({ id: site.id, address: site.address, format: site.format })

    // 上次在 replacing 阶段中断：页面已经翻完，直接继续清理
    const resumeReplace =
      item.resumeReplace &&
      item.mode === 'full' &&
      item.fetchRange === 'all' &&
      progress.pageCount > 0 &&
      progress.page >= progress.pageCount

    if (resumeReplace) {
      log('info', item, '继续全量替换', `已处理 ${progress.page}/${progress.pageCount} 页`)
      await replaceAll(item, progress, signal)
      return
    }

    progress = store.updateProgress(progress.id, { status: 'running', error: '' }) ?? progress
    emit(progress)
    log('info', item, '开始采集', item.origin === 'schedule' ? '定时触发' : '手动触发')

    const maxPages =
      Math.min(Math.max(Number(item.maxPages) || DEFAULT_MAX_PAGES[item.mode], 1), 10000) || 1
    let completed = false
    let paused = false

    while (true) {
      if (signal.aborted || task.cancelled || disposed) {
        paused = true
        break
      }
      if (progress.pageCount > 0 && progress.page >= progress.pageCount) {
        completed = true
        break
      }
      const nextPage = progress.page + 1
      if (nextPage > maxPages) {
        paused = true
        break
      }

      const result = await fetchPage(site, item, nextPage, signal)
      if (!result.ok) {
        if (result.error === 'ABORT' || signal.aborted || task.cancelled) {
          paused = true
          break
        }
        await finishWithError(item, progress.id, result.error)
        return
      }
      const page = result.value

      if (page.items.length === 0) {
        if (
          item.mode === 'full' &&
          item.fetchRange === 'all' &&
          page.pageCount > 0 &&
          progress.page < page.pageCount
        ) {
          await finishWithError(item, progress.id, 'INCOMPLETE_PAGE')
          return
        }
        progress =
          store.updateProgress(progress.id, {
            pageCount: page.pageCount || progress.pageCount,
            recordCount: page.recordCount || progress.recordCount,
            pageSize: page.pageSize || progress.pageSize
          }) ?? progress
        emit(progress)
        completed = true
        break
      }

      let write
      try {
        write = store.writePage(
          item.siteId,
          page.items,
          progress.startedAt,
          item.mode === 'full' && item.fetchRange === 'all'
        )
      } catch {
        await finishWithError(item, progress.id, 'DB')
        return
      }

      progress =
        store.updateProgress(progress.id, {
          page: nextPage,
          pageCount: page.pageCount,
          recordCount: page.recordCount,
          pageSize: page.pageSize,
          fetchedDelta: write.fetched,
          insertedDelta: write.inserted,
          updatedDelta: write.updated,
          failedDelta: write.failed
        }) ?? progress
      emit(progress)
      if (nextPage % 10 === 0) {
        log(
          'info',
          item,
          `已处理 ${progress.page}/${progress.pageCount || '?'} 页`,
          `抓取 ${progress.fetched} · 新增 ${progress.inserted} · 更新 ${progress.updated} · 失败 ${progress.failed}`
        )
      }
      if (page.pageCount > 0 && nextPage >= page.pageCount) {
        completed = true
        break
      }
      // 让出事件循环，保证取消 / 进度事件及时处理
      await delay(0)
    }

    if (paused) {
      const pausedProgress =
        store.updateProgress(progress.id, { status: 'paused', error: '' }) ?? progress
      emit(pausedProgress)
      log('warn', item, '采集已暂停', `停在第 ${pausedProgress.page} 页，下次继续`)
      return
    }

    if (completed && item.mode === 'full' && item.fetchRange === 'all') {
      const allowEmpty = Boolean(item.allowEmpty)
      const reliablePages = progress.pageCount > 0
      const empty = progress.fetched === 0
      if (empty && !allowEmpty) {
        const done = store.updateProgress(progress.id, {
          status: 'done',
          error: 'REPLACE_SKIPPED_EMPTY',
          finishedAt: nowIso()
        })
        emit(done)
        log('warn', item, '采集完成，但未执行全量替换', '站点返回 0 条，已跳过替换')
        return
      }
      // 解析出了记录但全部缺少 ID / 名称：本轮没有标记任何来源，替换会误删旧数据
      if (progress.fetched > 0 && progress.failed >= progress.fetched) {
        const done = store.updateProgress(progress.id, {
          status: 'done',
          error: 'REPLACE_SKIPPED_FAILED',
          finishedAt: nowIso()
        })
        emit(done)
        log('warn', item, '采集完成，但未执行全量替换', '本页记录全部缺少必要字段')
        return
      }
      if (!reliablePages && !(empty && allowEmpty)) {
        const done = store.updateProgress(progress.id, {
          status: 'done',
          error: 'REPLACE_SKIPPED_PAGE_COUNT',
          finishedAt: nowIso()
        })
        emit(done)
        log('warn', item, '采集完成，但未执行全量替换', '站点未返回可靠的分页字段')
        return
      }
      if (!(progress.page >= progress.pageCount)) {
        const done = store.updateProgress(progress.id, {
          status: 'done',
          error: 'REPLACE_SKIPPED_INCOMPLETE',
          finishedAt: nowIso()
        })
        emit(done)
        log('warn', item, '采集完成，但未执行全量替换', '未处理到最后一页')
        return
      }
      await replaceAll(item, progress, signal)
      return
    }

    const done = store.updateProgress(progress.id, {
      status: 'done',
      error: '',
      finishedAt: nowIso()
    })
    emit(done)
    const final = done ?? progress
    log(
      'info',
      item,
      '采集完成',
      `${final.page} 页 · 抓取 ${final.fetched} · 新增 ${final.inserted} · 更新 ${final.updated} · 失败 ${final.failed}`
    )
  }

  async function pump(): Promise<void> {
    if (pumping || disposed) return
    const next = queue.shift()
    if (!next) return
    pumping = true
    try {
      activeDone = runTask(next)
      await activeDone
    } catch {
      try {
        const progress = store.getProgress(progressId(next.siteId, next.mode, next.fetchRange))
        if (progress) {
          const updated = store.updateProgress(progress.id, {
            status: 'error',
            error: 'UNKNOWN',
            finishedAt: nowIso()
          })
          emit(updated)
          log('error', next, '采集异常终止', 'UNKNOWN')
        }
      } catch {
        // 缓存库已关闭（清空 / 退出），忽略收尾
      }
    } finally {
      active = null
      activeDone = null
      pumping = false
      try {
        store.connection().exec('PRAGMA wal_checkpoint(PASSIVE)')
        store.connection().exec('PRAGMA shrink_memory')
      } catch {
        // 缓存库已关闭 / 正在清空
      }
      if (!disposed) void pump()
    }
  }

  function cancel(input: { siteId: string; mode?: CollectMode; fetchRange?: FetchRange }): {
    ok: boolean
  } {
    const siteId = String(input?.siteId ?? '')
    if (!siteId) return { ok: false }
    const matches = (item: QueueItem): boolean =>
      item.siteId === siteId &&
      (!input.mode || item.mode === input.mode) &&
      (!input.fetchRange || item.fetchRange === input.fetchRange)

    if (active && matches(active.item)) {
      active.cancelled = true
      active.controller.abort()
      return { ok: true }
    }

    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index]
      if (!matches(item)) continue
      queue.splice(index, 1)
      const id = progressId(item.siteId, item.mode, item.fetchRange)
      const progress = store.updateProgress(id, { status: 'idle' })
      emit(progress)
      log('warn', item, '已取消排队中的采集')
    }
    return { ok: true }
  }

  async function cancelAll(): Promise<void> {
    if (active) {
      active.cancelled = true
      active.controller.abort()
      const item = active.item
      const progress = store.getProgress(progressId(item.siteId, item.mode, item.fetchRange))
      if (progress && (progress.status === 'running' || progress.status === 'replacing')) {
        store.updateProgress(progress.id, { status: 'paused' })
      }
    }
    for (const item of queue) {
      const id = progressId(item.siteId, item.mode, item.fetchRange)
      const progress = store.getProgress(id)
      if (progress && progress.status === 'queued') store.updateProgress(id, { status: 'idle' })
    }
    queue.length = 0
    const running = activeDone
    if (running) {
      await Promise.race([running.catch(() => {}), delay(5000)])
    }
  }

  function shutdown(): void {
    disposed = true
    if (active) {
      active.cancelled = true
      active.controller.abort()
      const item = active.item
      const progress = store.getProgress(progressId(item.siteId, item.mode, item.fetchRange))
      if (progress && (progress.status === 'running' || progress.status === 'replacing')) {
        store.updateProgress(progress.id, { status: 'paused' })
      }
    }
    for (const item of queue) {
      const id = progressId(item.siteId, item.mode, item.fetchRange)
      const progress = store.getProgress(id)
      if (progress && progress.status === 'queued') store.updateProgress(id, { status: 'idle' })
    }
    queue.length = 0
  }

  return {
    enqueue,
    cancel,
    cancelAll,
    suspend: () => {
      suspended = true
    },
    resume: () => {
      suspended = false
    },
    shutdown
  }
}
