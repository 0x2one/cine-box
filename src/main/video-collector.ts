import { fetchCollectText } from './collect-http'
import { clampCollectConcurrency, DEFAULT_COLLECT_CONCURRENCY } from './app-settings'
import type { CollectLogStore } from './collect-log-store'
import type { Site } from './site-store'
import { parseCollectPage, type CollectedPage } from './video-collect-parser'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, clampPageSize } from './video-collect-probe'
import { makeNameKey } from './video-text'
import type { DetailSourceRow, SearchWordRow, VideoCacheStore } from './video-cache-store'
import type { VideoDetailCache } from './video-detail-cache'
import {
  ONLINE_SEARCH_PAGE_SIZE,
  SEARCH_MAX_ITEMS,
  type CollectMode,
  type CollectOrigin,
  type FetchRange,
  type VideoCollectProgress,
  type VideoCollectStartInput,
  type VideoCollectStartResult
} from './video-types'

export interface VideoCollector {
  enqueue: (
    input: VideoCollectStartInput,
    origin: CollectOrigin
  ) => Promise<VideoCollectStartResult>
  cancel: (input: { siteId: string; mode?: CollectMode; fetchRange?: FetchRange }) => {
    ok: boolean
  }
  /**
   * 取消该站点正在跑的任务并等它真正退出（删站点缓存前调用）：
   * 只置取消标记的话，在途的那一页还会落库，刚删干净的站点又被写回来一页。
   */
  stopAndWait: (siteId: string) => Promise<void>
  /** 取消运行中任务与排队任务，但保留采集器可用（清空缓存前调用） */
  cancelAll: () => Promise<void>
  /** 清空缓存期间暂停入队，避免重建数据库时又启动任务 */
  suspend: () => void
  resume: () => void
  /** 按当前并发度重新填满槽位（调整并发度后调用，立即启动排队任务） */
  wake: () => void
  /** 退出前调用：取消任务并禁止后续入队 */
  shutdown: () => void
}

interface QueueItem extends VideoCollectStartInput {
  origin: CollectOrigin
  /** 上次在 replacing 阶段中断，重新入队后直接继续清理 */
  resumeReplace: boolean
  /** 本次任务实际使用的每页条数（1–100） */
  pageSize: number
}

interface ActiveTask {
  item: QueueItem
  controller: AbortController
  cancelled: boolean
}

/** 一个槽位：任务本体 + 它真正退出时（含收尾）才 resolve 的 Promise */
interface ActiveEntry {
  task: ActiveTask
  done: Promise<void>
}

const DEFAULT_MAX_PAGES: Record<CollectMode, number> = {
  full: 500,
  incremental: 100,
  // 检索按「每个关键词最多 SEARCH_MAX_ITEMS 条」算页数上限，这里只是兜底
  search: Math.ceil(SEARCH_MAX_ITEMS / ONLINE_SEARCH_PAGE_SIZE)
}
/** 单轮页数硬上限：站点总页数异常（例如 pagecount 一直涨）时兜底，避免无限翻页 */
const MAX_PAGES_PER_RUN = 10000
const REPLACE_BATCH = 1000

function nowIso(): string {
  return new Date().toISOString()
}

function isMode(value: unknown): value is CollectMode {
  return value === 'full' || value === 'incremental' || value === 'search'
}

function isRange(value: unknown): value is FetchRange {
  return value === 'all' || value === '24h' || value === '48h'
}

/** 检索关键词归一化：去空白、截断、按合并键去重（与库里的 word_key 同一套规则） */
function normalizeWords(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const words: string[] = []
  for (const item of value) {
    const word = String(item ?? '')
      .trim()
      .slice(0, 60)
    if (!word) continue
    const key = makeNameKey(word) || word.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    words.push(word)
  }
  return words
}

function progressId(siteId: string, mode: CollectMode, range: FetchRange): string {
  return `${siteId}:${mode}:${range}`
}

/**
 * 站点没给 `pagecount` 时用 `recordcount / pagesize` 推总页数：
 * 有总量就能翻到最后一页停，不用再多请求一页空数据去确认结束。
 */
function derivePageCount(page: CollectedPage, fallbackPageSize: number): number {
  if (page.pageCount > 0) return page.pageCount
  const size = page.pageSize > 0 ? page.pageSize : fallbackPageSize
  if (size > 0 && page.recordCount > 0) return Math.ceil(page.recordCount / size)
  return 0
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 耗时文案：850ms / 1.2s / 2m5s */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

/**
 * 采集器：全局单队列，手动与定时共用；同一 (site, mode, range) 不重复入队。
 * 队列按并发度填槽（默认 2）：跨站点并行，同一站点始终串行；
 * 每页一个事务写列表，进度落库后推事件；full + all 完整结束后才做全量替换。
 */
export function createVideoCollector(options: {
  store: VideoCacheStore
  details: VideoDetailCache
  logs: CollectLogStore
  listSites: () => Site[]
  emitProgress: (progress: VideoCollectProgress) => void
  /** 站点缓存正在后台清理时先等它删完：否则刚写进来的进度行 / 来源会被一起删掉 */
  waitForSite?: (siteId: string) => Promise<void>
  /** 当前允许同时采集的站点数；每次填槽时读取，改完设置立刻生效 */
  getConcurrency?: () => number
}): VideoCollector {
  const { store, details, logs, listSites, emitProgress, waitForSite, getConcurrency } = options
  const queue: QueueItem[] = []
  const active = new Map<string, ActiveEntry>()
  /**
   * 每个站点的检索「代」：每次追加关键词就 +1。
   * 运行中的检索任务在 pending 读空时对比它，就绪发现新词后继续消费，不会漏词。
   */
  const searchTokens = new Map<string, number>()
  let disposed = false
  let suspended = false

  /** 同时运行的站点任务数上限；settings 里的值非法时回落到默认值 */
  function concurrency(): number {
    return clampCollectConcurrency(getConcurrency?.() ?? DEFAULT_COLLECT_CONCURRENCY)
  }

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
    if (active.has(id)) return true
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
    // 全量模式只对全量范围有意义；检索也不按时间范围取数
    if (input.mode === 'full' && input.fetchRange !== 'all') {
      return { ok: false, error: 'INVALID_INPUT' }
    }
    const words = input.mode === 'search' ? normalizeWords(input.words) : []
    if (input.mode === 'search' && (input.fetchRange !== 'all' || words.length === 0)) {
      return { ok: false, error: 'INVALID_INPUT' }
    }
    const site = listSites().find((item) => item.id === siteId)
    if (!site) return { ok: false, error: 'NOT_FOUND' }
    // 这个站点的旧缓存正在后台清理（改地址 / 删站点）：等它删完再建任务，
    // 否则 prepareTask 刚写进去的进度行会被紧接着的删除一起带走
    if (waitForSite) await waitForSite(siteId).catch(() => {})
    // 主进程会先把探测到的真实页大小带进来；没带就按默认 100
    const pageSize = clampPageSize(input.pageSize) || DEFAULT_PAGE_SIZE

    // 检索：同一个站点只保留一条进度，关键词追加进队列（已存在的重置为待检索）。
    // 已经在跑 / 排队的任务不会因为这次提交而重启，只是把新词接在后面。
    if (input.mode === 'search') {
      store.addSearchWords(siteId, words)
      const key = progressId(siteId, 'search', 'all')
      // token 变了运行中的任务才知道「又来了新词」，否则它读空 pending 就退出了
      searchTokens.set(siteId, (searchTokens.get(siteId) ?? 0) + 1)
      if (
        active.has(key) ||
        queue.some((item) => item.mode === 'search' && item.siteId === siteId)
      ) {
        emit(store.getProgress(key))
        log(
          'info',
          { siteId, mode: 'search', fetchRange: 'all' },
          '检索关键词已追加',
          `${words.length} 个：${words.join(' / ')}`
        )
        void pump()
        return { ok: true, progress: store.getProgress(key) ?? undefined, pageSize }
      }
      const progress = store.prepareTask({
        siteId,
        mode: 'search',
        fetchRange: 'all',
        restart: input.restart,
        pageSize
      })
      const item: QueueItem = {
        siteId,
        mode: 'search',
        fetchRange: 'all',
        restart: Boolean(input.restart),
        maxPages: input.maxPages,
        allowEmpty: false,
        origin,
        resumeReplace: false,
        cacheDetail: Boolean(input.cacheDetail),
        pageSize
      }
      queue.push(item)
      emit(progress)
      log(
        'info',
        item,
        origin === 'schedule' ? '定时检索已入队' : '检索任务已入队',
        `${words.length} 个关键词：${words.join(' / ')}`
      )
      void pump()
      return { ok: true, progress, pageSize }
    }

    if (isQueuedOrActive(siteId, input.mode, input.fetchRange)) {
      return { ok: false, error: 'ALREADY_QUEUED' }
    }
    const existing = store.getProgress(progressId(siteId, input.mode, input.fetchRange))
    const progress = store.prepareTask({
      siteId,
      mode: input.mode,
      fetchRange: input.fetchRange,
      restart: input.restart,
      pageSize
    })
    const item: QueueItem = {
      siteId,
      mode: input.mode,
      fetchRange: input.fetchRange,
      restart: Boolean(input.restart),
      maxPages: input.maxPages,
      allowEmpty: Boolean(input.allowEmpty),
      origin,
      resumeReplace: existing?.status === 'replacing',
      cacheDetail: Boolean(input.cacheDetail),
      pageSize
    }
    queue.push(item)
    emit(progress)
    // 站点 / 模式 / 范围日志行头里已经有了，这里不再重复
    log('info', item, origin === 'schedule' ? '定时采集已入队' : '已加入采集队列')
    void pump()
    return { ok: true, progress, pageSize }
  }

  function buildUrl(site: Site, range: FetchRange, page: number, pageSize: number): string {
    const url = new URL(site.address)
    url.searchParams.set('ac', 'detail')
    url.searchParams.set('pg', String(page))
    url.searchParams.set('pagesize', String(Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE)))
    if (range === '24h') url.searchParams.set('h', '24')
    else if (range === '48h') url.searchParams.set('h', '48')
    else url.searchParams.delete('h')
    if (site.format === 'xml') url.searchParams.set('at', 'xml')
    else url.searchParams.delete('at')
    return url.toString()
  }

  /** 检索模式的请求：`ac=detail&wd=<词>`，站点地址里残留的 ids / h 会干扰结果，一并去掉 */
  function buildSearchUrl(site: Site, word: string, page: number, pageSize: number): string {
    const url = new URL(site.address)
    url.searchParams.set('ac', 'detail')
    url.searchParams.set('wd', word)
    url.searchParams.set('pg', String(page))
    url.searchParams.set('pagesize', String(Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE)))
    url.searchParams.delete('ids')
    url.searchParams.delete('h')
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
    return readPage(site, buildUrl(site, item.fetchRange, page, item.pageSize), signal)
  }

  async function fetchSearchPage(
    site: Site,
    word: string,
    page: number,
    pageSize: number,
    signal: AbortSignal
  ): Promise<{ ok: true; value: CollectedPage } | { ok: false; error: string }> {
    return readPage(site, buildSearchUrl(site, word, page, pageSize), signal)
  }

  async function readPage(
    site: Site,
    url: string,
    signal: AbortSignal
  ): Promise<{ ok: true; value: CollectedPage } | { ok: false; error: string }> {
    const response = await fetchCollectText(url, signal)
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
    signal: AbortSignal,
    /** 列表阶段耗时文案；续采进入替换时没有翻页阶段，留空 */
    phaseText = ''
  ): Promise<VideoCollectProgress> {
    const runToken = progress.startedAt || nowIso()
    const runStartTs = Number.isNaN(Date.parse(progress.startedAt))
      ? 0
      : Date.parse(progress.startedAt)
    // 本轮开始时间：全量替换前用它排除「跑到一半时被在线检索写进来的来源」
    const runStartedAt = runStartTs > 0 ? new Date(runStartTs).toISOString() : nowIso()
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
      `本次标记 token=${runToken}，删除 ${runToken ? '本次未返回的旧来源' : '无'}` +
        (phaseText ? ` · ${phaseText}` : '')
    )

    while (true) {
      if (signal.aborted || disposed) {
        const paused = store.updateProgress(progress.id, { status: 'paused' })
        emit(paused)
        log('warn', item, '全量替换已暂停', '下次继续清理')
        return paused ?? progress
      }
      const stale = store.listStaleSources(
        item.siteId,
        runToken,
        runStartTs,
        runStartedAt,
        REPLACE_BATCH
      )
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

  /**
   * 检索任务：一条进度（`siteId:search:all`）+ 多个关键词，逐个词翻页写入。
   * 只追加、不做全量替换；每个词、每个站点最多入库 SEARCH_MAX_ITEMS 条。
   * 运行中追加关键词会让 token 变化，当前词结束后自动接上，不会漏词。
   */
  async function runSearchTask(task: ActiveTask): Promise<void> {
    const item = task.item
    const signal = task.controller.signal
    const site = listSites().find((entry) => entry.id === item.siteId)
    let progress = store.getProgress(progressId(item.siteId, item.mode, item.fetchRange))
    if (!progress) return
    if (!site) {
      await finishWithError(item, progress.id, 'NOT_FOUND')
      return
    }
    store.ensureSite({ id: site.id, address: site.address, format: site.format })

    progress =
      store.updateProgress(progress.id, { status: 'running', error: '', finishedAt: '' }) ??
      progress
    let words = store.listSearchWords(item.siteId)
    /** 已处理（成功或失败）的词数：进度的百分比按它算 */
    const processedCount = (rows: SearchWordRow[]): number =>
      rows.filter((row) => row.status === 'done' || row.status === 'error').length
    progress =
      store.updateProgress(progress.id, {
        page: processedCount(words),
        pageCount: words.length
      }) ?? progress
    emit(progress)
    log(
      'info',
      item,
      '开始检索采集',
      `${item.origin === 'schedule' ? '定时触发' : '手动触发'} · ${words.length} 个关键词` +
        ` · 每页 ${item.pageSize} 条 · 每个关键词最多 ${SEARCH_MAX_ITEMS} 条`
    )

    const startedAt = Date.now()
    let paused = false
    let failedWords = 0
    let detailCached = 0
    let detailFailed = 0
    let token = searchTokens.get(item.siteId) ?? 0

    while (true) {
      if (signal.aborted || task.cancelled || disposed || suspended) {
        paused = true
        break
      }
      let pending: SearchWordRow[]
      try {
        pending = store.listPendingSearchWords(item.siteId)
      } catch {
        // 缓存库正在重建 / 已关闭：按暂停退出，别让异常跑到 pump 的兜底
        paused = true
        break
      }
      if (pending.length === 0) {
        // 读完 pending 立刻看 token：这期间追加进来的关键词不能被漏掉
        const current = searchTokens.get(item.siteId) ?? 0
        if (current !== token) {
          token = current
          continue
        }
        break
      }
      token = searchTokens.get(item.siteId) ?? token
      const word = pending[0]
      try {
        store.markSearchWord(item.siteId, word.wordKey, 'running', 0)
      } catch {
        paused = true
        break
      }

      let fetched = 0
      let pages = 0
      let wordError = ''
      let pageNo = 1
      while (fetched < SEARCH_MAX_ITEMS) {
        if (signal.aborted || task.cancelled || disposed || suspended) {
          paused = true
          break
        }
        let result: Awaited<ReturnType<typeof fetchSearchPage>>
        try {
          result = await fetchSearchPage(site, word.word, pageNo, item.pageSize, signal)
        } catch {
          result = { ok: false, error: 'NETWORK' }
        }
        if (!result.ok) {
          if (result.error === 'ABORT' || signal.aborted || task.cancelled) {
            paused = true
            break
          }
          wordError = result.error
          break
        }
        const page = result.value
        if (page.items.length === 0) break
        // 一个词最多 200 条：最后一页只写还需要的条数
        const items = page.items.slice(0, SEARCH_MAX_ITEMS - fetched)
        let write
        try {
          write = store.writePage(item.siteId, items, '', false)
        } catch {
          wordError = 'DB'
          break
        }
        fetched += write.fetched
        pages += 1
        const pageCount = derivePageCount(page, progress.pageSize || item.pageSize)
        progress =
          store.updateProgress(progress.id, {
            pageSize: page.pageSize || progress.pageSize,
            fetchedDelta: write.fetched,
            insertedDelta: write.inserted,
            updatedDelta: write.updatedDelta,
            failedDelta: write.failed
          }) ?? progress
        emit(progress)
        if (item.cacheDetail && write.sourceIds.length > 0) {
          // 整页 ac=detail 已带回简介与播路线，直接落盘，不额外请求
          try {
            const itemsById = new Map(page.items.map((entry) => [entry.sourceVideoId, entry]))
            const sources = write.sourceIds
              .map((id) => store.getDetailSource(id))
              .filter((row): row is DetailSourceRow => row !== null)
            const warmed = await details.warmFromPage(sources, itemsById)
            detailCached += warmed.cached
            detailFailed += warmed.failed
          } catch {
            // 详情预热失败不影响检索入库
          }
        }
        if (items.length < page.items.length) break
        if (pageCount > 0 && pageNo >= pageCount) break
        if (pageNo >= MAX_PAGES_PER_RUN) break
        pageNo += 1
        await delay(0)
      }

      if (paused) {
        // 中止时当前词退回待检索，下次接着跑
        try {
          store.markSearchWord(item.siteId, word.wordKey, 'pending', 0)
        } catch {
          // 缓存库已关闭：忽略
        }
        break
      }
      if (wordError) failedWords += 1
      try {
        store.markSearchWord(
          item.siteId,
          word.wordKey,
          wordError ? 'error' : 'done',
          fetched,
          wordError
        )
        words = store.listSearchWords(item.siteId)
      } catch {
        words = []
      }
      progress =
        store.updateProgress(progress.id, {
          page: processedCount(words),
          pageCount: words.length
        }) ?? progress
      emit(progress)
      log(
        wordError ? 'warn' : 'info',
        item,
        `关键词「${word.word}」${wordError ? '检索失败' : '检索完成'}`,
        `${pages} 页 · 抓取 ${fetched} 条` +
          (fetched >= SEARCH_MAX_ITEMS ? ` · 已达上限 ${SEARCH_MAX_ITEMS} 条` : '') +
          (wordError ? ` · ${wordError}` : '')
      )
      await delay(0)
    }

    const phaseText = `耗时 ${formatMs(Date.now() - startedAt)}`
    if (paused) {
      const pausedProgress =
        store.updateProgress(progress.id, { status: 'paused', error: '' }) ?? progress
      emit(pausedProgress)
      log(
        'warn',
        item,
        '检索已暂停',
        `已完成 ${pausedProgress.page}/${pausedProgress.pageCount} 个关键词，下次继续 · ${phaseText}`
      )
      return
    }
    const done =
      store.updateProgress(progress.id, {
        status: 'done',
        error: failedWords > 0 ? 'SEARCH_PARTIAL' : '',
        finishedAt: nowIso()
      }) ?? progress
    emit(done)
    log(
      'info',
      item,
      '检索完成',
      `${done.page}/${done.pageCount} 个关键词 · 抓取 ${done.fetched} 条 · 新增 ${done.inserted}` +
        ` · 更新 ${done.updated}` +
        (failedWords > 0 ? ` · 失败 ${failedWords}` : '') +
        (item.cacheDetail
          ? ` · 详情缓存 ${detailCached} 个${detailFailed > 0 ? `（失败 ${detailFailed}）` : ''}`
          : '') +
        ` · ${phaseText}`
    )
  }

  async function runTask(task: ActiveTask): Promise<void> {
    const item = task.item
    const signal = task.controller.signal
    const site = listSites().find((entry) => entry.id === item.siteId)
    let progress = store.getProgress(progressId(item.siteId, item.mode, item.fetchRange))
    if (!progress) return
    if (!site) {
      await finishWithError(item, progress.id, 'NOT_FOUND')
      return
    }
    // 检索是另一条链路：按关键词翻页、只追加，不做全量替换
    if (item.mode === 'search') {
      await runSearchTask(task)
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

    // 继续采集时清掉上一次的结束时间，否则界面会一直显示旧的「结束」
    progress =
      store.updateProgress(progress.id, { status: 'running', error: '', finishedAt: '' }) ??
      progress
    emit(progress)
    log(
      'info',
      item,
      '开始采集',
      `${item.origin === 'schedule' ? '定时触发' : '手动触发'} · 每页 ${item.pageSize} 条`
    )

    // 页数上限只是防站点分页异常导致无限翻页，必须按「本轮」算：
    // 站点给了可靠总页数就翻到最后一页（全量任务本来就该翻完），否则按默认值兜底。
    // 之前按绝对页数比较，全量站点翻到默认 500 页暂停后，续采第 501 页立刻又撞上限，
    // 界面提示「已继续采集」但一页都没抓，任务永远停在 500 页。
    // 目标还必须每页重算：清空缓存后的第一次全量，pageCount 要等第 1 页响应才带回来，
    // 按任务开始时的 0 冻结成默认 500 页，8.5 万条的站点翻到第 500 页（5 万条）就会暂停，
    // 用户只能从进度里手动续采；改成按当前 pageCount 重算后，翻页途中拿到的总页数立刻生效。
    const pageBudget = Math.min(
      Math.max(Number(item.maxPages) || DEFAULT_MAX_PAGES[item.mode], 1),
      MAX_PAGES_PER_RUN
    )
    /** 拿不到站点总页数时，本轮最多再翻这么多页（从本任务开始的那一页算起） */
    const budgetBase = progress.page
    const resolveRunTarget = (current: VideoCollectProgress): number =>
      current.pageCount > 0
        ? Math.min(current.pageCount, MAX_PAGES_PER_RUN)
        : Math.min(budgetBase + pageBudget, MAX_PAGES_PER_RUN)
    let announcedFullRange = false
    let completed = false
    let paused = false
    let hitPageLimit = false
    let detailCached = 0
    let detailFailed = 0
    // 详情来源：本页响应直接落盘 / 仍需联网补抓（个别站点整页模式不给详情字段）
    let detailDirect = 0
    let detailFetched = 0
    // 耗时拆分（累计）：列表请求 / 写库 / 详情缓存
    let fetchTotalMs = 0
    let writeTotalMs = 0
    let detailTotalMs = 0
    /**
     * 详情落盘排在后台：它只碰文件和详情索引，和下一页的网络请求完全独立，
     * 一页 100 条在 Windows 上要 150ms 上下，串在关键路径上纯属白等。
     * 这里串成一条链，保证同一时刻只有一页在写（并发写文件实测只快 1.4×，
     * 不值得为此打乱顺序），跑完列表阶段再统一收尾。
     */
    let detailChain: Promise<void> = Promise.resolve()

    const listStart = Date.now()
    while (true) {
      // suspended 是「清空缓存」的第二道栅栏：suspend 之后即使清理队列超时，
      // 也绝不能翻下一页往即将重建的库里写
      if (signal.aborted || task.cancelled || disposed || suspended) {
        paused = true
        break
      }
      if (progress.pageCount > 0 && progress.page >= progress.pageCount) {
        completed = true
        break
      }
      const nextPage = progress.page + 1
      const runTarget = resolveRunTarget(progress)
      if (nextPage > runTarget) {
        hitPageLimit = true
        paused = true
        break
      }

      const fetchStart = Date.now()
      const result = await fetchPage(site, item, nextPage, signal)
      const fetchPageMs = Date.now() - fetchStart
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
        const pageCount = derivePageCount(page, progress.pageSize)
        if (
          item.mode === 'full' &&
          item.fetchRange === 'all' &&
          pageCount > 0 &&
          progress.page < pageCount
        ) {
          await finishWithError(item, progress.id, 'INCOMPLETE_PAGE')
          return
        }
        progress =
          store.updateProgress(progress.id, {
            pageCount: pageCount || progress.pageCount,
            recordCount: page.recordCount || progress.recordCount,
            pageSize: page.pageSize || progress.pageSize
          }) ?? progress
        emit(progress)
        completed = true
        break
      }

      let write
      const writeStart = Date.now()
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
      const writePageMs = Date.now() - writeStart
      const pageCount = derivePageCount(page, progress.pageSize)

      progress =
        store.updateProgress(progress.id, {
          page: nextPage,
          pageCount: pageCount || progress.pageCount,
          // 有的站点只在第一页给 recordcount，后续页为 0 时保留已知总量
          recordCount: page.recordCount || progress.recordCount,
          // 同理，个别站点后续页不再回 pagesize，别把已知的每页条数清成 0
          pageSize: page.pageSize || progress.pageSize,
          fetchedDelta: write.fetched,
          insertedDelta: write.inserted,
          updatedDelta: write.updated,
          failedDelta: write.failed
        }) ?? progress
      emit(progress)
      // 站点总页数超过默认单轮上限时说明一句，否则「这次怎么翻了这么久」没有解释
      if (!announcedFullRange && progress.pageCount > budgetBase + pageBudget) {
        announcedFullRange = true
        log(
          'info',
          item,
          `站点共 ${progress.pageCount} 页`,
          `超过本轮默认 ${pageBudget} 页上限，本次一次采完`
        )
      }
      if (nextPage % 10 === 0) {
        log(
          'info',
          item,
          `已处理 ${progress.page}/${progress.pageCount || '?'} 页`,
          `抓取 ${progress.fetched} · 新增 ${progress.inserted} · 更新 ${progress.updated} · 失败 ${progress.failed}`
        )
      }
      let detailQueued = 0
      if (item.cacheDetail && write.sourceIds.length > 0) {
        const sourceIds = write.sourceIds
        const itemsById = new Map(page.items.map((entry) => [entry.sourceVideoId, entry]))
        detailQueued = sourceIds.length
        detailChain = detailChain
          .then(async () => {
            const detailStart = Date.now()
            const sources = sourceIds
              .map((id) => store.getDetailSource(id))
              .filter((row): row is DetailSourceRow => row !== null)
            if (sources.length > 0) {
              try {
                // 整页模式已经带回详情，先直接落盘；剩下的才联网补抓
                const direct = await details.warmFromPage(sources, itemsById)
                detailCached += direct.cached
                detailFailed += direct.failed
                detailDirect += direct.cached
                if (direct.fallback.length > 0) {
                  const warmed = await details.warm(direct.fallback)
                  detailCached += warmed.cached
                  detailFailed += warmed.failed
                  detailFetched += warmed.cached
                }
              } catch {
                // 详情预热失败不影响列表采集，下一页继续
              }
            }
            detailTotalMs += Date.now() - detailStart
          })
          .catch(() => {})
      }
      fetchTotalMs += fetchPageMs
      writeTotalMs += writePageMs
      log(
        'info',
        item,
        `第 ${nextPage} 页耗时 ${formatMs(fetchPageMs + writePageMs)}`,
        `列表 ${formatMs(fetchPageMs)} · 写库 ${formatMs(writePageMs)}` +
          (detailQueued > 0 ? ` · 详情 ${detailQueued} 个转后台落盘` : '')
      )
      if (pageCount > 0 && nextPage >= pageCount) {
        completed = true
        break
      }
      // 让出事件循环，保证取消 / 进度事件及时处理
      await delay(0)
    }

    // 等后台详情落盘收尾（一般只剩最后一页），否则「完成」时计数还没写全
    await detailChain
    const listWallMs = Date.now() - listStart

    // 列表阶段耗时拆分：写进「暂停 / 完成 / 开始全量替换」日志，慢在哪一眼能看出来
    const phaseText =
      `耗时 ${formatMs(listWallMs)}` +
      `（列表 ${formatMs(fetchTotalMs)} · 写库 ${formatMs(writeTotalMs)} · 详情后台 ${formatMs(detailTotalMs)}）`

    if (paused) {
      const pausedProgress =
        store.updateProgress(progress.id, { status: 'paused', error: '' }) ?? progress
      emit(pausedProgress)
      const limitText = !hitPageLimit
        ? ''
        : pausedProgress.pageCount > 0
          ? `站点共 ${pausedProgress.pageCount} 页，已达单轮 ${MAX_PAGES_PER_RUN} 页上限，`
          : `站点未返回总页数，本轮 ${pageBudget} 页已翻完，`
      log(
        'warn',
        item,
        '采集已暂停',
        `停在第 ${pausedProgress.page} 页，${limitText}下次继续 · ${phaseText}`
      )
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
      await replaceAll(item, progress, signal, `列表阶段 ${phaseText}`)
      return
    }

    // 增量只看最近 24 / 48 小时：站点这段时间没有更新时也是正常结束（0 页），
    // 但日志里写「采集完成 0 页」看不出原因，单独说明一句，顺便提示怎么导入整库。
    if (completed && item.mode === 'incremental' && progress.page === 0 && progress.fetched === 0) {
      const noUpdate = store.updateProgress(progress.id, {
        status: 'done',
        error: '',
        finishedAt: nowIso()
      })
      emit(noUpdate)
      log(
        'info',
        item,
        '最近没有新视频',
        `${item.fetchRange === '24h' ? '最近 24 小时' : '最近 48 小时'}内站点没有返回更新；` +
          `需要导入整库请改用全量采集 · ${phaseText}`
      )
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
      `${final.page} 页 · 抓取 ${final.fetched} · 新增 ${final.inserted} · 更新 ${final.updated} · 失败 ${final.failed}` +
        (item.cacheDetail
          ? ` · 详情缓存 ${detailCached} 个${detailFailed > 0 ? `（失败 ${detailFailed}）` : ''}（直接 ${detailDirect} / 补抓 ${detailFetched}）`
          : '') +
        ` · ${phaseText}`
    )
  }

  /** 同站点互斥：一个站点已有任务在跑时，它的下一个任务（哪怕模式 / 范围不同）继续排队 */
  function siteBusy(siteId: string): boolean {
    for (const entry of active.values()) {
      if (entry.task.item.siteId === siteId) return true
    }
    return false
  }

  /** 把排队任务填进空槽位：跨站点并行、同站点串行，队首被占用的站点会被跳过 */
  function pump(): void {
    if (disposed || suspended) return
    // 一次只读一遍设置：中途改并发度由 settings handler 的 wake() 再触发
    const limit = concurrency()
    while (active.size < limit) {
      const index = queue.findIndex((item) => !siteBusy(item.siteId))
      if (index === -1) return
      const [next] = queue.splice(index, 1)
      const key = progressId(next.siteId, next.mode, next.fetchRange)
      const task: ActiveTask = {
        item: next,
        controller: new AbortController(),
        cancelled: false
      }
      const done = runTask(task)
        .catch(async () => {
          // runTask 自己会收尾；走到这里说明抛出了未预期的异常，补一条 error 免得停在 running
          try {
            const progress = store.getProgress(key)
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
        })
        .finally(() => {
          active.delete(key)
          // 所有槽位都空了再做 checkpoint：并行时每个任务结束都 checkpoint 会互相打架
          if (active.size === 0) {
            try {
              store.connection().exec('PRAGMA wal_checkpoint(PASSIVE)')
              store.connection().exec('PRAGMA shrink_memory')
            } catch {
              // 缓存库已关闭 / 正在清空
            }
          }
          if (!disposed) pump()
        })
      active.set(key, { task, done })
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

    for (const entry of active.values()) {
      if (!matches(entry.task.item)) continue
      entry.task.cancelled = true
      entry.task.controller.abort()
    }

    // 取消活跃任务时也要把同一站点的排队项一起摘掉：否则队列在它退出后
    // 又会为已删除 / 已改地址的站点起一个任务（删站点后重新写入一页）
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index]
      if (!matches(item)) continue
      queue.splice(index, 1)
      const id = progressId(item.siteId, item.mode, item.fetchRange)
      // 检索取消后仍然可以「继续采集」（关键词还挂在进度上），所以停在 paused 而不是 idle
      const progress = store.updateProgress(id, {
        status: item.mode === 'search' ? 'paused' : 'idle'
      })
      emit(progress)
      log('warn', item, '已取消排队中的采集')
    }
    return { ok: true }
  }

  async function stopAndWait(siteId: string): Promise<void> {
    cancel({ siteId })
    const running = [...active.values()]
      .filter((entry) => entry.task.item.siteId === siteId)
      .map((entry) => entry.done)
    if (running.length === 0) return
    // 任务会在当前这一页结束时退出；卡在请求上时最多等 15s，别把清理挂死
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(running).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15000)
      })
    ])
    if (timer) clearTimeout(timer)
  }

  async function cancelAll(): Promise<void> {
    for (const entry of active.values()) {
      entry.task.cancelled = true
      entry.task.controller.abort()
      const item = entry.task.item
      const progress = store.getProgress(progressId(item.siteId, item.mode, item.fetchRange))
      if (progress && (progress.status === 'running' || progress.status === 'replacing')) {
        store.updateProgress(progress.id, { status: 'paused' })
      }
    }
    for (const item of queue) {
      const id = progressId(item.siteId, item.mode, item.fetchRange)
      const progress = store.getProgress(id)
      if (progress && progress.status === 'queued') {
        // 检索取消后保留关键词，按暂停处理，进度里可以直接继续
        store.updateProgress(id, { status: item.mode === 'search' ? 'paused' : 'idle' })
      }
    }
    queue.length = 0
    const running = [...active.values()].map((entry) => entry.done)
    if (running.length > 0) {
      // 取消会让在途请求立刻 ABORT，正常情况下任务在页边界退出；15s 只是防呆上限
      await Promise.race([Promise.all(running).catch(() => {}), delay(15000)])
    }
  }

  function shutdown(): void {
    disposed = true
    for (const entry of active.values()) {
      entry.task.cancelled = true
      entry.task.controller.abort()
      const item = entry.task.item
      const progress = store.getProgress(progressId(item.siteId, item.mode, item.fetchRange))
      if (progress && (progress.status === 'running' || progress.status === 'replacing')) {
        store.updateProgress(progress.id, { status: 'paused' })
      }
    }
    for (const item of queue) {
      const id = progressId(item.siteId, item.mode, item.fetchRange)
      const progress = store.getProgress(id)
      if (progress && progress.status === 'queued') {
        // 检索取消后保留关键词，按暂停处理，进度里可以直接继续
        store.updateProgress(id, { status: item.mode === 'search' ? 'paused' : 'idle' })
      }
    }
    queue.length = 0
  }

  return {
    enqueue,
    cancel,
    stopAndWait,
    cancelAll,
    suspend: () => {
      suspended = true
    },
    resume: () => {
      suspended = false
      pump()
    },
    wake: () => {
      pump()
    },
    shutdown
  }
}
