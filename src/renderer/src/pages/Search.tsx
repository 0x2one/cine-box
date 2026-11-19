import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Spin } from 'antd'
import { ArrowUpOutlined, HistoryOutlined, SearchOutlined } from '@ant-design/icons'
import { visibleCategoryIds } from '../lib/category-tree'
import { formatCount } from '../utils/format'
import '../assets/search.css'

/** 每页条数：预览行比卡片高，20 条一页滚起来不会一次塞太长 */
const PAGE_SIZE = 20
/** 距底部这么多像素就预取下一页 */
const LOAD_AHEAD = 600
/** 滚过这么多像素浮出「回到顶部」 */
const BACK_TOP_AT = 600
/** 搜索历史：存在 localStorage，最近的排最前面，最多 10 条 */
const HISTORY_KEY = 'search-history'
const HISTORY_LIMIT = 10

/** 滚动回调要读的可变状态：放在 ref 里，避免闭包拿到过期的 page / loading */
interface SearchGuard {
  /** 当前关键词的请求代数：换词后旧响应直接丢弃 */
  generation: number
  /** 下一次要取的页码 */
  page: number
  loading: boolean
  failed: boolean
  exhausted: boolean
}

/** 关键词高亮：转义用户输入里的正则元字符 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把命中词包成 <mark>：按空白切词、大小写不敏感。
 * 主进程的 FTS 对中文按单字建索引、对拉丁词做前缀匹配，这里做的是同一段文本的视觉标注。
 */
function highlight(text: string, matcher: RegExp | null): React.ReactNode {
  if (!matcher) return text
  const parts = text.split(matcher)
  if (parts.length === 1) return text
  return parts.map((part, index) =>
    // split 带一个捕获组时，奇数下标就是命中的片段
    index % 2 === 1 ? (
      <mark className="search-hit" key={index}>
        {part}
      </mark>
    ) : (
      part
    )
  )
}

/** 读取搜索历史：格式坏掉就当没有，不影响页面 */
function readSearchHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const terms: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const term = item.trim()
      if (!term) continue
      const key = term.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      terms.push(term)
      if (terms.length >= HISTORY_LIMIT) break
    }
    return terms
  } catch {
    return []
  }
}

/**
 * 搜索条：左边是搜索图标，右边是「搜索」文字按钮。
 * 只负责收集输入，回车或点按钮才提交，不做实时搜索。
 */
function SearchBar({
  variant,
  value,
  autoFocus,
  onChange,
  onSubmit,
  onEscape
}: {
  variant: 'hero' | 'header'
  value: string
  autoFocus?: boolean
  onChange: (next: string) => void
  onSubmit: () => void
  onEscape: () => void
}): React.JSX.Element {
  const hero = variant === 'hero'
  return (
    <form
      className={`search-form is-${variant}`}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Input
        className="search-form-field"
        size={hero ? 'large' : 'middle'}
        allowClear
        autoFocus={autoFocus}
        prefix={<SearchOutlined />}
        placeholder="搜索片名"
        aria-label="搜索片名"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault()
            onEscape()
          }
        }}
      />
      <Button
        className="search-form-submit"
        type="primary"
        htmlType="submit"
        size={hero ? 'large' : 'middle'}
        disabled={!value.trim()}
      >
        搜索
      </Button>
    </form>
  )
}

/** 单条搜索结果：沿用控制台「视频」预览行的信息顺序，右侧是 3:4 封面 */
function SearchResultRow({
  item,
  matcher
}: {
  item: VideoListItem
  matcher: RegExp | null
}): React.JSX.Element {
  // 绑定后的本地分类更贴近展示端的叫法；没有绑定时退回采集里的原始类型
  const category =
    item.localCategoryPaths.length > 0
      ? item.localCategoryPaths.join('、')
      : item.vodClass || item.categoryName || '未分类'

  return (
    <article className="search-result">
      <div className="search-result-cover">
        <span className="search-cover-letter">{item.name.trim().slice(0, 1) || '影'}</span>
        {item.pic && (
          <img
            src={item.pic}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.visibility = 'hidden'
            }}
          />
        )}
      </div>

      <div className="search-result-main">
        <div className="search-result-title-row">
          <h3 className="search-result-title" title={item.name}>
            {highlight(item.name, matcher)}
          </h3>
          {item.note && (
            <span className="search-result-note" title={item.note}>
              {item.note}
            </span>
          )}
        </div>

        <div className="search-result-meta">
          <span className="search-meta-strong">{item.sourceCount} 个来源</span>
          <span className="search-meta-dot" />
          <span className="search-meta-class" title={category}>
            {category}
          </span>
          <span className="search-meta-dot" />
          <span className="search-meta-strong">更新 {item.latestTime}</span>
        </div>

        <p className="search-result-intro">{item.introExcerpt || '暂无简介'}</p>
        <p className="search-result-actor" title={`主演：${item.vodActor || '未知'}`}>
          主演：{item.vodActor || '未知'}
        </p>
      </div>
    </article>
  )
}

/**
 * 展示端搜索页：按片名检索已采集的视频（只搜展示中的）。
 * 初始态是居中的搜索落地页（搜索历史 / 分类入口 / 片库规模），
 * 提交后搜索条吸顶、结果按控制台「视频」的预览行排版，滚动到底自动取下一页。
 * 只展示、不跳转：和首页 / 列表页一样，这里没有播放或详情入口。
 */
function SearchView({
  onOpenBrowse
}: {
  /** 初始态的分类快捷入口：带分类 id 进入列表页，null 表示「全部」 */
  onOpenBrowse: (categoryId: string | null) => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  /** 已提交的关键词（去掉首尾空白）：空串表示停在初始态 */
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<VideoListItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  /** 搜索历史：最近 10 条，存在 localStorage */
  const [history, setHistory] = useState<string[]>(readSearchHistory)
  /** 初始态的分类快捷入口与片库规模：只读本地库，不阻塞搜索 */
  const [categories, setCategories] = useState<VideoCategory[]>([])
  const [stats, setStats] = useState<VideoStats | null>(null)
  /** 初始态底部那条淡出的封面带：纯装饰，不参与交互 */
  const [posterPics, setPosterPics] = useState<string[]>([])
  /** 吸顶头部滚过一点后加描边，内容从下面穿过去时有个边界 */
  const [elevated, setElevated] = useState(false)
  const [showBackTop, setShowBackTop] = useState(false)

  const guard = useRef<SearchGuard>({
    generation: 0,
    page: 1,
    loading: false,
    failed: false,
    exhausted: false
  })
  /** 滚动回调读当前关键词：避免闭包拿到上一次搜索的值 */
  const keywordRef = useRef('')

  const loadPage = useCallback(
    async (page: number, query: string, replace: boolean): Promise<void> => {
      const token = guard.current.generation
      guard.current.loading = true
      guard.current.failed = false
      setLoading(true)
      setFailed(false)
      try {
        const result = await window.api.videos.list({
          keyword: query,
          page,
          pageSize: PAGE_SIZE,
          visibility: 'shown'
        })
        // 换过关键词：这一页的结果已经没用了
        if (token !== guard.current.generation) return
        if (!result.ok) {
          guard.current.failed = true
          setFailed(true)
          return
        }
        setItems((previous) => {
          if (replace) return result.items
          // 采集 / 隐藏会让 offset 分页错位，按视频 id 去重，避免重复行和重复 key
          const seen = new Set(previous.map((item) => item.id))
          return [...previous, ...result.items.filter((item) => !seen.has(item.id))]
        })
        setTotal(result.total)
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

  /**
   * 提交关键词：作废旧请求、清空结果、回到第一页并滚回顶部。
   * 空串等于退回初始态（落地页），同时把输入框清空。
   */
  const startSearch = useCallback(
    (raw: string): void => {
      const next = raw.trim()
      keywordRef.current = next
      setKeyword(next)
      setItems([])
      setTotal(null)
      setFailed(false)
      setExhausted(false)
      setElevated(false)
      setShowBackTop(false)
      guard.current = {
        generation: guard.current.generation + 1,
        page: 1,
        loading: false,
        failed: false,
        exhausted: false
      }
      const page = rootRef.current?.closest('.page') as HTMLElement | null
      page?.scrollTo({ top: 0 })
      if (!next) {
        setDraft('')
        setLoading(false)
        return
      }
      setLoading(true)
      void loadPage(1, next, true)
    },
    [loadPage]
  )

  /** 记一条搜索历史：同一关键词只留一条（忽略大小写），最近的排最前，最多 10 条 */
  const rememberKeyword = useCallback((value: string): void => {
    const term = value.trim()
    if (!term) return
    setHistory((previous) => {
      const key = term.toLowerCase()
      return [term, ...previous.filter((item) => item.toLowerCase() !== key)].slice(
        0,
        HISTORY_LIMIT
      )
    })
  }, [])

  // 搜索历史落盘：读不回来 / 写不进去都不会影响搜索本身
  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
    } catch {
      // 隐私模式或配额不足时只在本次会话里保留
    }
  }, [history])

  /** 显式执行一次搜索：回车、点「搜索」或点历史词都走这里，顺便记历史 */
  const runSearch = (raw: string): void => {
    const next = raw.trim()
    if (!next) return
    rememberKeyword(next)
    startSearch(next)
  }

  const clearHistory = (): void => {
    setHistory([])
  }

  /** 距离底部不到 LOAD_AHEAD 且还有下一页时继续取 */
  const maybeLoadMore = useCallback((): void => {
    const state = guard.current
    const query = keywordRef.current
    if (!query || state.loading || state.failed || state.exhausted) return
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    if (page.scrollHeight - page.scrollTop - page.clientHeight > LOAD_AHEAD) return
    void loadPage(state.page, query, false)
  }, [loadPage])

  // 一页填不满窗口时接着取，否则要等用户再滚一下才会触发
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => maybeLoadMore())
    return () => window.cancelAnimationFrame(frame)
  }, [maybeLoadMore, items.length, loading, total, failed, exhausted])

  // 吸顶描边、回到顶部、滚动加载共用页面滚动事件（.page 才是滚动容器）
  useEffect(() => {
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    let frame = 0
    const sync = (): void => {
      setElevated(page.scrollTop > 4)
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

  // 初始态只需要分类名、片库规模和一条装饰封面带：读失败就少显示一块，不影响搜索
  useEffect(() => {
    let cancelled = false
    window.api.categories
      .list()
      .then((rows) => {
        if (!cancelled) setCategories(rows)
      })
      .catch(() => {
        // 分类读不到时初始态只剩搜索和历史
      })
    window.api.videos
      .stats()
      .then((value) => {
        if (!cancelled) setStats(value)
      })
      .catch(() => {
        // 统计失败时不显示「片库共 N 部视频」
      })
    // 底部装饰用的封面：取最近一批视频的图，等距抽几张，避免整排都是同一天的采集
    window.api.videos
      .list({ page: 1, pageSize: 30, visibility: 'shown' })
      .then((result) => {
        if (cancelled || !result.ok) return
        const seen = new Set<string>()
        const pics: string[] = []
        for (const item of result.items) {
          if (!item.pic || seen.has(item.pic)) continue
          seen.add(item.pic)
          pics.push(item.pic)
        }
        const step = Math.max(1, Math.ceil(pics.length / 9))
        setPosterPics(pics.filter((_, index) => index % step === 0).slice(0, 9))
      })
      .catch(() => {
        // 封面拉不到就不显示装饰带
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 初始态的分类快捷入口：和列表页一样只取可见的一级分类 */
  const tops = useMemo(() => {
    const visible = visibleCategoryIds(categories)
    return categories
      .filter((row) => row.parentId === null && visible.has(row.id))
      .sort((left, right) => left.sortOrder - right.sortOrder)
  }, [categories])

  const retry = (): void => {
    const state = guard.current
    const query = keywordRef.current
    if (!query || state.loading) return
    state.failed = false
    setFailed(false)
    void loadPage(state.page, query, items.length === 0)
  }

  /** 回到顶部：搜索页的滚动容器是 .page，不是 window */
  const backToTop = (): void => {
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    page.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
  }

  /** 命中词只用来高亮，不参与查询构造（查询由主进程的 makeFtsQuery 负责） */
  const matcher = useMemo(() => {
    const tokens = [...new Set(keyword.split(/\s+/).filter(Boolean))]
    if (tokens.length === 0) return null
    // 长词优先，避免「柯南」被「柯」先切开
    tokens.sort((left, right) => right.length - left.length)
    return new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi')
  }, [keyword])

  return (
    <div className="search-view" ref={rootRef}>
      <h1 className="visually-hidden">搜索</h1>

      {/* 只有进入结果页才有顶部搜索条；初始态是一个居中的搜索落地页 */}
      {keyword && (
        <header className={`search-head${elevated ? ' is-elevated' : ''}`}>
          <div className="search-head-inner">
            <SearchBar
              variant="header"
              value={draft}
              autoFocus
              onChange={(next) => {
                setDraft(next)
                // 清空输入等于退出搜索，回到初始态
                if (!next.trim()) startSearch('')
              }}
              onSubmit={() => runSearch(draft)}
              onEscape={() => {
                setDraft('')
                startSearch('')
              }}
            />
            <span className="search-count" aria-live="polite">
              {total !== null ? (
                <>
                  共 <b>{formatCount(total)}</b> 部相关视频
                </>
              ) : loading ? (
                '正在搜索…'
              ) : null}
            </span>
          </div>
        </header>
      )}

      <div className={`search-body${keyword ? '' : ' is-intro'}`}>
        {!keyword ? (
          <div className="search-intro">
            <div className="search-intro-main">
              <h2 className="search-intro-title">搜索片库</h2>
              <p className="search-intro-desc">
                输入片名，按回车或点「搜索」；也可以从下面的分类进入。
              </p>

              <SearchBar
                variant="hero"
                value={draft}
                autoFocus
                onChange={setDraft}
                onSubmit={() => runSearch(draft)}
                onEscape={() => setDraft('')}
              />

              <p className="search-intro-meta">
                {stats && stats.videoCount > 0 ? (
                  <>
                    片库共 <b>{formatCount(stats.videoCount)}</b> 部视频
                    <span className="search-meta-dot" />
                    支持中文 / 英文 / 数字
                    <span className="search-meta-dot" />
                    只搜展示中的视频
                  </>
                ) : stats ? (
                  '片库还是空的，去控制台采集后就能搜到视频'
                ) : (
                  '支持中文 / 英文 / 数字 · 只搜展示中的视频'
                )}
              </p>

              {history.length > 0 && (
                <div className="search-intro-block">
                  <div className="search-block-head">
                    <span className="search-cats-label">最近搜索</span>
                    <button type="button" className="search-history-clear" onClick={clearHistory}>
                      清空
                    </button>
                  </div>
                  <div className="search-history">
                    {history.map((term) => (
                      <button
                        key={term}
                        type="button"
                        className="search-history-item"
                        title={term}
                        onClick={() => {
                          setDraft(term)
                          runSearch(term)
                        }}
                      >
                        <HistoryOutlined />
                        <span>{term}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {tops.length > 0 && !(stats && stats.videoCount === 0) && (
                <div className="search-intro-block">
                  <span className="search-cats-label">按分类浏览</span>
                  <div className="search-cats">
                    <button
                      type="button"
                      className="search-cat is-all"
                      onClick={() => onOpenBrowse(null)}
                    >
                      全部
                    </button>
                    {tops.map((top) => (
                      <button
                        key={top.id}
                        type="button"
                        className="search-cat"
                        onClick={() => onOpenBrowse(top.id)}
                      >
                        {top.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 底部封面带只是氛围：不可点、不参与 Tab，读屏也忽略 */}
            {posterPics.length >= 3 && (
              <div className="search-intro-shelf" aria-hidden="true">
                {posterPics.map((pic) => (
                  <span className="search-shelf-item" key={pic}>
                    <img
                      src={pic}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        event.currentTarget.style.visibility = 'hidden'
                      }}
                    />
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : failed && items.length === 0 ? (
          <div className="search-empty">
            <p className="search-empty-title">搜索失败</p>
            <p className="search-empty-desc">视频缓存库可能正在初始化，稍后再试一次</p>
            <Button onClick={retry}>重新搜索</Button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="search-loading">
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <div className="search-empty">
            <p className="search-empty-title">没有找到「{keyword}」</p>
            <p className="search-empty-desc">换个关键词试试，或者按分类浏览片库</p>
            <Button onClick={() => onOpenBrowse(null)}>按分类浏览</Button>
          </div>
        ) : (
          <>
            <section className="search-results" aria-label={`「${keyword}」的搜索结果`}>
              {items.map((item) => (
                <SearchResultRow key={item.id} item={item} matcher={matcher} />
              ))}
            </section>

            <div className="search-footer">
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
                <span>已经到底了，共 {formatCount(total ?? items.length)} 部</span>
              ) : null}
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        className={`search-backtop${showBackTop ? '' : ' is-hidden'}`}
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

export default SearchView
