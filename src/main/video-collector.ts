import { fetchCollectText } from './collect-http'
import type { CollectLogStore } from './collect-log-store'
import type { Site } from './site-store'
import { parseCollectPage, type CollectedPage } from './video-collect-parser'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, clampPageSize } from './video-collect-probe'
import type { VideoCacheStore, DetailSourceRow } from './video-cache-store'
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

const DEFAULT_MAX_PAGES: Record<CollectMode, number> = { full: 500, incremental: 100 }
/** 单轮页数硬上限：站点总页数异常（例如 pagecount 一直涨）时兜底，避免无限翻页 */
const MAX_PAGES_PER_RUN = 10000
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
}): VideoCollector {
  const { store, details, logs, listSites, emitProgress, waitForSite } = options
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
    // 这个站点的旧缓存正在后台清理（改地址 / 删站点）：等它删完再建任务，
    // 否则 prepareTask 刚写进去的进度行会被紧接着的删除一起带走
    if (waitForSite) await waitForSite(siteId).catch(() => {})
    if (isQueuedOrActive(siteId, input.mode, input.fetchRange)) {
      return { ok: false, error: 'ALREADY_QUEUED' }
    }
    const existing = store.getProgress(progressId(siteId, input.mode, input.fetchRange))
    // 主进程会先把探测到的真实页大小带进来；没带就按默认 100
    const pageSize = clampPageSize(input.pageSize) || DEFAULT_PAGE_SIZE
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

  async function fetchPage(
    site: Site,
    item: QueueItem,
    page: number,
    signal: AbortSignal
  ): Promise<{ ok: true; value: CollectedPage } | { ok: false; error: string }> {
    const response = await fetchCollectText(
      buildUrl(site, item.fetchRange, page, item.pageSize),
      signal
    )
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
      if (signal.aborted || task.cancelled || disposed) {
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

  async function stopAndWait(siteId: string): Promise<void> {
    cancel({ siteId })
    const running = active && active.item.siteId === siteId ? activeDone : null
    if (!running) return
    // 任务会在当前这一页结束时退出；卡在请求上时最多等 15s，别把清理挂死
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      running.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15000)
      })
    ])
    if (timer) clearTimeout(timer)
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
    stopAndWait,
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
