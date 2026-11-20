import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spin } from 'antd'
import { ArrowUpOutlined } from '@ant-design/icons'
import VideoCard from '../components/VideoCard'
import { visibleCategoryIds } from '../lib/category-tree'
import { formatCount } from '../utils/format'
import '../assets/browse.css'

/** 每页条数：缓存库单页上限 100，按设计文档的默认 30 取 */
const PAGE_SIZE = 30
/** 距底部这么多像素就预取下一页 */
const LOAD_AHEAD = 600
/** 滚过这么多像素浮出「回到顶部」 */
const BACK_TOP_AT = 600
/** 头部折叠 / 展开的滞回阈值：滚过 128px 折叠，回到 16px 内再展开。
 *  两个阈值之间的距离要大于折叠掉的高度，万一浏览器做了滚动锚定也不会来回切 */
const COLLAPSE_AT = 128
const EXPAND_AT = 16

interface Selection {
  /** 一级分类；null 表示跨大类的「全部」 */
  topId: string | null
  /** 选中的子分类；null 表示这个大类下的「全部」 */
  subId: string | null
}

/** 一次列表查询的筛选：全部 = 所有可见一级分类的并集，分类 = 某个分类的子树 */
interface BrowseFilter {
  /** 稳定的筛选标识：全部用 all，分类用分类 id */
  key: string
  /** 单个分类（一级或子分类） */
  categoryId?: string
  /** 多个一级分类：主进程把它们各自的子树一起解析成绑定过滤 */
  categoryIds?: string[]
}

/** 滚动回调要读的可变状态：放在 ref 里，避免闭包拿到过期的 page / loading */
interface ScrollGuard {
  /** 当前筛选的请求代数：切分类后旧响应直接丢弃 */
  generation: number
  /** 下一次要取的页码 */
  page: number
  loading: boolean
  failed: boolean
  exhausted: boolean
}

function bySortOrder(left: VideoCategory, right: VideoCategory): number {
  return left.sortOrder - right.sortOrder
}

/**
 * 初始选中：首页传进来的一级分类优先；
 * 标题栏「找片看」进来（initialId 为空）或分类被删 / 隐藏时落到「全部」。
 */
function resolveSelection(
  categories: VideoCategory[],
  visible: Set<string>,
  initialId: string | null
): Selection | null {
  const tops = categories
    .filter((row) => row.parentId === null && visible.has(row.id))
    .sort(bySortOrder)
  if (tops.length === 0) return null

  const initial = initialId ? categories.find((row) => row.id === initialId) : undefined
  if (!initial || !visible.has(initial.id)) return { topId: null, subId: null }
  if (initial.parentId === null) return { topId: initial.id, subId: null }

  // 只认二级：传进来的是更深层分类时同样退回「全部」
  const parent = categories.find((row) => row.id === initial.parentId)
  if (!parent || parent.parentId !== null || !visible.has(parent.id)) {
    return { topId: null, subId: null }
  }
  return { topId: parent.id, subId: initial.id }
}

/**
 * 展示端视频列表页：顶部两级视频类型吸顶，下面是按更新时间倒序的视频卡片，
 * 滚动到底部自动取下一页。数据只读分类树与视频库，不读首页配置。
 */
function BrowseView({
  initialCategoryId,
  onCategoryChange
}: {
  initialCategoryId: string | null
  /** 用户切换分类时上报当前选中的分类 id（null = 全部），离开再回来时用来恢复 */
  onCategoryChange?: (categoryId: string | null) => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [categories, setCategories] = useState<VideoCategory[] | null>(null)
  const [categoryFailed, setCategoryFailed] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [items, setItems] = useState<VideoListItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  /** 当前 items 属于哪个分类：和选中分类不一致时先显示加载态，避免闪一下上一类的卡片 */
  const [loadedFilter, setLoadedFilter] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [compact, setCompact] = useState(false)
  const [showBackTop, setShowBackTop] = useState(false)

  const guard = useRef<ScrollGuard>({
    generation: 0,
    page: 1,
    loading: false,
    failed: false,
    exhausted: false
  })
  const filterRef = useRef<BrowseFilter | null>(null)

  const visibleIds = useMemo(
    () => (categories ? visibleCategoryIds(categories) : new Set<string>()),
    [categories]
  )

  const tops = useMemo(
    () =>
      categories
        ? categories
            .filter((row) => row.parentId === null && visibleIds.has(row.id))
            .sort(bySortOrder)
        : [],
    [categories, visibleIds]
  )

  const subs = useMemo(
    () =>
      categories && selection?.topId
        ? categories
            .filter((row) => row.parentId === selection.topId && visibleIds.has(row.id))
            .sort(bySortOrder)
        : [],
    [categories, selection, visibleIds]
  )

  const activeTop = useMemo(
    () =>
      selection?.topId ? (categories?.find((row) => row.id === selection.topId) ?? null) : null,
    [categories, selection]
  )

  /** 选中的子分类：标题显示成「大类 / 子类」的面包屑 */
  const activeSub = useMemo(
    () => (selection?.subId ? (subs.find((row) => row.id === selection.subId) ?? null) : null),
    [selection, subs]
  )

  /** 当前筛选：「全部」= 所有可见一级分类的并集（隐藏分类里的视频不会从这里漏出来） */
  const filter = useMemo<BrowseFilter | null>(() => {
    if (!selection) return null
    if (selection.topId === null) return { key: 'all', categoryIds: tops.map((top) => top.id) }
    const categoryId = selection.subId ?? selection.topId
    return { key: categoryId, categoryId }
  }, [selection, tops])

  /** 选中筛选和已加载筛选不一致：正在换分类，先别渲染上一类的卡片 */
  const pending = filter !== null && loadedFilter !== filter.key && !failed

  // 分类只读一次：列表页用分类原名，不带首页的显示名覆盖
  useEffect(() => {
    let cancelled = false
    window.api.categories
      .list()
      .then((rows) => {
        if (cancelled) return
        setCategoryFailed(false)
        setCategories(rows)
        setSelection(
          (previous) =>
            previous ?? resolveSelection(rows, visibleCategoryIds(rows), initialCategoryId)
        )
      })
      .catch(() => {
        if (!cancelled) setCategoryFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [initialCategoryId, reloadToken])

  const loadPage = useCallback(
    async (page: number, target: BrowseFilter, replace: boolean): Promise<void> => {
      const token = guard.current.generation
      guard.current.loading = true
      guard.current.failed = false
      setLoading(true)
      setFailed(false)
      try {
        const query: VideoListQuery = { page, pageSize: PAGE_SIZE, visibility: 'shown' }
        if (target.categoryId) query.categoryId = target.categoryId
        if (target.categoryIds) query.categoryIds = target.categoryIds
        const result = await window.api.videos.list(query)
        // 切了筛选：这一页的结果已经没用了
        if (token !== guard.current.generation) return
        if (!result.ok) {
          guard.current.failed = true
          setFailed(true)
          return
        }
        setItems((previous) => {
          if (replace) return result.items
          // 采集 / 隐藏可能让分页错位，按视频 id 去重，避免重复卡片和重复 key
          const seen = new Set(previous.map((item) => item.id))
          return [...previous, ...result.items.filter((item) => !seen.has(item.id))]
        })
        setTotal(result.total)
        setLoadedFilter(target.key)
        guard.current.page = page + 1
        const last = result.items.length < PAGE_SIZE || page * PAGE_SIZE >= result.total
        guard.current.exhausted = last
        setExhausted(last)
      } catch {
        if (token === guard.current.generation) {
          guard.current.failed = true
          setFailed(true)
        }
      } finally {
        if (token === guard.current.generation) {
          guard.current.loading = false
          setLoading(false)
        }
      }
    },
    []
  )

  /** 换筛选：作废旧请求、清空列表、回到第一页 */
  const startFilter = useCallback(
    (target: BrowseFilter): void => {
      filterRef.current = target
      guard.current = {
        generation: guard.current.generation + 1,
        page: 1,
        loading: false,
        failed: false,
        exhausted: false
      }
      setItems([])
      setTotal(null)
      setLoading(true)
      setFailed(false)
      setExhausted(false)
      void loadPage(1, target, true)
    },
    [loadPage]
  )

  useEffect(() => {
    if (!filter) return
    // 切换筛选时先清掉上一类的残留再取第一页；setState 在 effect 里是刻意的，
    // 规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startFilter(filter)
  }, [filter, startFilter])

  /** 距离底部不到 LOAD_AHEAD 且还有下一页时继续取 */
  const maybeLoadMore = useCallback((): void => {
    const state = guard.current
    const target = filterRef.current
    if (!target || state.loading || state.failed || state.exhausted) return
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    if (page.scrollHeight - page.scrollTop - page.clientHeight > LOAD_AHEAD) return
    void loadPage(state.page, target, false)
  }, [loadPage])

  // 一页填不满窗口时接着取，否则要等用户再滚一下才会触发
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => maybeLoadMore())
    return () => window.cancelAnimationFrame(frame)
  }, [maybeLoadMore, items.length, loading, total, failed, exhausted])

  // 头部吸顶收缩 + 滚动加载共用页面滚动事件（.page 才是滚动容器）
  useEffect(() => {
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    let frame = 0
    const sync = (): void => {
      // 滞回：滚过 COLLAPSE_AT 才折叠，回到 EXPAND_AT 内才展开，避免在阈值上抖动
      setCompact((previous) => page.scrollTop > (previous ? EXPAND_AT : COLLAPSE_AT))
      setShowBackTop(page.scrollTop > BACK_TOP_AT)
      maybeLoadMore()
    }
    const onScroll = (): void => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }
    page.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      page.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [maybeLoadMore])

  const scrollToTop = (): void => {
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    page?.scrollTo({ top: 0 })
    setCompact(false)
    setShowBackTop(false)
  }

  /** 回到顶部：列表页的滚动容器是 .page，不是 window */
  const backToTop = (): void => {
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    page.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
  }

  const selectAll = (): void => {
    if (selection?.topId === null) return
    scrollToTop()
    setSelection({ topId: null, subId: null })
    onCategoryChange?.(null)
  }

  const selectTop = (topId: string): void => {
    if (selection?.topId === topId && selection.subId === null) return
    scrollToTop()
    setSelection({ topId, subId: null })
    onCategoryChange?.(topId)
  }

  const selectSub = (subId: string | null): void => {
    if (!selection || selection.topId === null || selection.subId === subId) return
    scrollToTop()
    setSelection({ topId: selection.topId, subId })
    // 选中子分类就记子分类，选回「全部」记大类，回来时都能还原
    onCategoryChange?.(subId ?? selection.topId)
  }

  const retry = (): void => {
    const state = guard.current
    const target = filterRef.current
    if (state.loading || !target) return
    state.failed = false
    setFailed(false)
    void loadPage(state.page, target, items.length === 0)
  }

  const reloadCategories = (): void => {
    setCategories(null)
    setCategoryFailed(false)
    setSelection(null)
    setReloadToken((token) => token + 1)
  }

  return (
    <div className={`browse-view${compact ? ' is-compact' : ''}`} ref={rootRef}>
      <header className={`browse-head${compact ? ' is-compact' : ''}`}>
        <div className="browse-head-inner">
          <div className="browse-head-top">
            <h1 className="browse-title">
              {selection?.topId === null ? (
                '全部视频'
              ) : activeTop ? (
                activeSub ? (
                  <>
                    <span className="browse-title-parent">{activeTop.name}</span>
                    <span className="browse-title-sep">/</span>
                    {activeSub.name}
                  </>
                ) : (
                  activeTop.name
                )
              ) : (
                '视频库'
              )}
            </h1>
            {total !== null && (
              <span className="browse-count">
                共 <b>{formatCount(total)}</b> 部
              </span>
            )}
          </div>

          {tops.length > 0 && (
            <nav className="browse-types" aria-label="视频类型">
              <button
                type="button"
                className={`browse-chip${selection?.topId === null ? ' is-active' : ''}`}
                aria-pressed={selection?.topId === null}
                onClick={selectAll}
              >
                全部
              </button>
              {tops.map((top) => (
                <button
                  key={top.id}
                  type="button"
                  className={`browse-chip${selection?.topId === top.id ? ' is-active' : ''}`}
                  aria-pressed={selection?.topId === top.id}
                  onClick={() => selectTop(top.id)}
                >
                  {top.name}
                </button>
              ))}
            </nav>
          )}

          {subs.length > 0 && (
            <nav className="browse-subs" aria-label="视频子类型">
              <button
                type="button"
                className={`browse-chip${selection?.subId === null ? ' is-active' : ''}`}
                aria-pressed={selection?.subId === null}
                onClick={() => selectSub(null)}
              >
                全部
              </button>
              {subs.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  className={`browse-chip${selection?.subId === sub.id ? ' is-active' : ''}`}
                  aria-pressed={selection?.subId === sub.id}
                  onClick={() => selectSub(sub.id)}
                >
                  {sub.name}
                </button>
              ))}
            </nav>
          )}
        </div>
      </header>

      <div className="browse-body">
        {categoryFailed ? (
          <div className="home-empty-state">
            <p className="home-empty-title">分类读取失败</p>
            <p className="home-empty-desc">分类数据可能正在初始化，稍后再试一次</p>
            <Button onClick={reloadCategories}>重新加载</Button>
          </div>
        ) : !categories ? (
          <div className="home-loading">
            <Spin />
          </div>
        ) : !selection ? (
          <div className="home-empty-state">
            <p className="home-empty-title">还没有可展示的视频分类</p>
            <p className="home-empty-desc">
              去控制台「分类」建好分类并绑定在线分类后，这里就会出现
            </p>
          </div>
        ) : pending ? (
          <div className="home-loading">
            <Spin />
          </div>
        ) : loading && items.length === 0 ? (
          <div className="home-loading">
            <Spin />
          </div>
        ) : failed && items.length === 0 ? (
          <div className="home-empty-state">
            <p className="home-empty-title">视频库读取失败</p>
            <p className="home-empty-desc">视频缓存库可能正在初始化，稍后再试一次</p>
            <Button onClick={retry}>重新加载</Button>
          </div>
        ) : items.length === 0 ? (
          <div className="home-empty-state">
            <p className="home-empty-title">
              {filter?.key === 'all' ? '片库里还没有视频' : '这个分类下还没有视频'}
            </p>
            <p className="home-empty-desc">
              {filter?.key === 'all'
                ? '去控制台采集视频后，这里就会出现'
                : '换一个类型看看，或者去控制台采集视频'}
            </p>
          </div>
        ) : (
          <>
            <div className="browse-grid">
              {items.map((item) => (
                <VideoCard
                  key={item.id}
                  title={item.name}
                  pic={item.pic}
                  note={item.note}
                  intro={item.introExcerpt}
                  actors={item.vodActor}
                  latestTime={item.latestTime}
                />
              ))}
            </div>
            <div className="browse-footer">
              {failed ? (
                <Button type="link" onClick={retry}>
                  加载失败，点击重试
                </Button>
              ) : loading ? (
                <>
                  <Spin size="small" />
                  <span>正在加载…</span>
                </>
              ) : exhausted ? (
                <span>已经全部加载</span>
              ) : null}
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        className={`browse-backtop${showBackTop ? '' : ' is-hidden'}`}
        aria-label="回到顶部"
        title="回到顶部"
        tabIndex={showBackTop ? 0 : -1}
        onClick={backToTop}
      >
        <ArrowUpOutlined />
      </button>
    </div>
  )
}

export default BrowseView
