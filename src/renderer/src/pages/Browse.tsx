import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spin } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import VideoCard from '../components/VideoCard'
import { visibleCategoryIds } from '../lib/category-tree'
import '../assets/browse.css'

/** 每页条数：缓存库单页上限 100，按设计文档的默认 30 取 */
const PAGE_SIZE = 30
/** 距底部这么多像素就预取下一页 */
const LOAD_AHEAD = 600
/** 头部折叠 / 展开的滞回阈值：滚过 128px 折叠，回到 16px 内再展开。
 *  两个阈值之间的距离要大于折叠掉的高度，万一浏览器做了滚动锚定也不会来回切 */
const COLLAPSE_AT = 128
const EXPAND_AT = 16

interface Selection {
  /** 一级分类 */
  topId: string
  /** 选中的子分类；null 表示这个大类下的「全部」 */
  subId: string | null
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
 * 分类被删 / 被隐藏时退回第一个可见的一级分类，保证页面总能落到一个真实分类上。
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
  if (!initial || !visible.has(initial.id)) return { topId: tops[0].id, subId: null }
  if (initial.parentId === null) return { topId: initial.id, subId: null }

  // 只认二级：传进来的是更深层分类时同样退回第一个大类
  const parent = categories.find((row) => row.id === initial.parentId)
  if (!parent || parent.parentId !== null || !visible.has(parent.id)) {
    return { topId: tops[0].id, subId: null }
  }
  return { topId: parent.id, subId: initial.id }
}

/**
 * 展示端视频列表页：顶部两级视频类型吸顶，下面是按更新时间倒序的视频卡片，
 * 滚动到底部自动取下一页。数据只读分类树与视频库，不读首页配置。
 */
function BrowseView({
  initialCategoryId,
  onBack
}: {
  initialCategoryId: string | null
  onBack: () => void
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

  const guard = useRef<ScrollGuard>({
    generation: 0,
    page: 1,
    loading: false,
    failed: false,
    exhausted: false
  })
  const filterRef = useRef<string | null>(null)

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
      categories && selection
        ? categories
            .filter((row) => row.parentId === selection.topId && visibleIds.has(row.id))
            .sort(bySortOrder)
        : [],
    [categories, selection, visibleIds]
  )

  const activeTop = useMemo(
    () => categories?.find((row) => row.id === selection?.topId) ?? null,
    [categories, selection]
  )

  /** 选中分类和已加载分类不一致：正在换分类，先别渲染上一类的卡片 */
  const activeFilter = selection ? (selection.subId ?? selection.topId) : null
  const pending = activeFilter !== null && loadedFilter !== activeFilter && !failed

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
    async (page: number, categoryId: string, replace: boolean): Promise<void> => {
      const token = guard.current.generation
      guard.current.loading = true
      guard.current.failed = false
      setLoading(true)
      setFailed(false)
      try {
        const result = await window.api.videos.list({
          page,
          pageSize: PAGE_SIZE,
          categoryId,
          visibility: 'shown'
        })
        // 切了分类：这一页的结果已经没用了
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
        setLoadedFilter(categoryId)
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

  /** 换分类：作废旧请求、清空列表、回到第一页 */
  const selectCategory = useCallback(
    (categoryId: string): void => {
      filterRef.current = categoryId
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
      void loadPage(1, categoryId, true)
    },
    [loadPage]
  )

  useEffect(() => {
    if (!selection) return
    // 切换类型时先清掉上一类的残留再取第一页；setState 在 effect 里是刻意的，
    // 规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    selectCategory(selection.subId ?? selection.topId)
  }, [selection, selectCategory])

  /** 距离底部不到 LOAD_AHEAD 且还有下一页时继续取 */
  const maybeLoadMore = useCallback((): void => {
    const state = guard.current
    const filter = filterRef.current
    if (!filter || state.loading || state.failed || state.exhausted) return
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    if (page.scrollHeight - page.scrollTop - page.clientHeight > LOAD_AHEAD) return
    void loadPage(state.page, filter, false)
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
  }

  const selectTop = (topId: string): void => {
    if (selection?.topId === topId && selection.subId === null) return
    scrollToTop()
    setSelection({ topId, subId: null })
  }

  const selectSub = (subId: string | null): void => {
    if (!selection || selection.subId === subId) return
    scrollToTop()
    setSelection({ topId: selection.topId, subId })
  }

  const retry = (): void => {
    const state = guard.current
    const filter = filterRef.current
    if (state.loading || !filter) return
    state.failed = false
    setFailed(false)
    void loadPage(state.page, filter, items.length === 0)
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
            <button type="button" className="browse-back" onClick={onBack}>
              <ArrowLeftOutlined />
              <span>首页</span>
            </button>
            <h1 className="browse-title">{activeTop?.name ?? '视频库'}</h1>
            {total !== null && <span className="browse-count">共 {total} 部</span>}
          </div>

          {tops.length > 0 && (
            <nav className="browse-types" aria-label="视频类型">
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
            <p className="home-empty-title">这个分类下还没有视频</p>
            <p className="home-empty-desc">换一个类型看看，或者去控制台采集视频</p>
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
    </div>
  )
}

export default BrowseView
