import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Spin, Switch, Tooltip } from 'antd'
import { ArrowUpOutlined, CloseOutlined, HistoryOutlined, SearchOutlined } from '@ant-design/icons'
import FallbackImage from '../components/FallbackImage'
import HomePicture from '../components/HomePicture'
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
/** 搜索模式（本地 / 在线），记忆在 localStorage */
const MODE_KEY = 'search-mode'
/** 在线模式每站返回 20 条，主进程最多合并 200 条，这里只用于文案 */
const ONLINE_SITE_PAGE_SIZE = 20

type SearchMode = 'local' | 'online'

function readSearchMode(): SearchMode {
  return localStorage.getItem(MODE_KEY) === 'online' ? 'online' : 'local'
}

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

/** 搜索模式开关：本地 = 查已入库的片库，在线 = 向开启了在线检索的站点按片名检索 */
function SearchModeSwitch({
  mode,
  disabled,
  onChange
}: {
  mode: SearchMode
  /** 没有站点开启在线检索时禁用（在线模式本身也会被回落到本地） */
  disabled: boolean
  onChange: (next: SearchMode) => void
}): React.JSX.Element {
  return (
    <div className="search-mode">
      <span className="search-mode-label">搜索模式</span>
      {/* Tooltip 包一层 span：禁用的开关不派发鼠标事件，直接包它提示不会出现 */}
      <Tooltip title={disabled ? '还没有站点开启「支持在线检索」，去控制台 › 站点 编辑开启' : ''}>
        <span className="search-mode-switch">
          <Switch
            checked={mode === 'online'}
            checkedChildren="在线"
            unCheckedChildren="本地"
            disabled={disabled}
            onChange={(checked) => onChange(checked ? 'online' : 'local')}
            aria-label="搜索模式：在线或本地"
          />
        </span>
      </Tooltip>
    </div>
  )
}

/** 单条搜索结果：沿用控制台「视频」预览行的信息顺序，左侧是 3:4 封面 */
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

  /**
   * 点封面 / 片名直接播放：和首页、列表页的卡片同一条口径，只给视频 id，
   * 由播放页自己取详情、挑第一个能播的线路，这里不查详情、不进详情页。
   */
  const open = (): void => {
    void window.api.player.open({ videoId: item.id, title: item.name })
  }

  return (
    <article className="search-result is-openable">
      <div className="search-result-cover">
        <span className="search-cover-letter">{item.name.trim().slice(0, 1) || '影'}</span>
        <FallbackImage src={item.pic} candidates={item.picCandidates} alt="" loading="lazy" />
        {/* 透明按钮铺满封面：整张图都能点开播放，键盘也能聚焦 */}
        <button
          type="button"
          className="search-cover-open"
          title={`播放《${item.name}》`}
          aria-label={`播放 ${item.name}`}
          onClick={open}
        />
      </div>

      <div className="search-result-main">
        <div className="search-result-title-row">
          <button
            type="button"
            className="search-result-title search-result-title-btn"
            title={item.name}
            onClick={open}
          >
            {highlight(item.name, matcher)}
          </button>
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
 * 结果行的封面和片名都能点开独立播放窗口（同首页 / 列表页的卡片），没有详情页。
 */
function SearchView({
  initialKeyword = '',
  onKeywordChange,
  onOpenBrowse
}: {
  /** 从控制台 / 设置返回时恢复的搜索词，空串表示停在初始态 */
  initialKeyword?: string
  /** 已提交的关键词变化时上报，离开再回来时用它恢复这一页 */
  onKeywordChange?: (keyword: string) => void
  /** 初始态的分类快捷入口：带分类 id 进入列表页，null 表示「全部」 */
  onOpenBrowse: (categoryId: string | null) => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState(initialKeyword)
  /** 已提交的关键词（去掉首尾空白）：空串表示停在初始态 */
  const [keyword, setKeyword] = useState(initialKeyword)
  const [items, setItems] = useState<VideoListItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  /** 恢复上一次搜索时首帧就在加载态，避免先闪一下「没有找到」 */
  const [loading, setLoading] = useState(() => initialKeyword.trim() !== '')
  const [failed, setFailed] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  /** 搜索历史：最近 10 条，存在 localStorage */
  const [history, setHistory] = useState<string[]>(readSearchHistory)
  /** 初始态的分类快捷入口与片库规模：只读本地库，不阻塞搜索 */
  const [categories, setCategories] = useState<VideoCategory[]>([])
  const [stats, setStats] = useState<VideoStats | null>(null)
  /** 初始态底部的推荐位：控制台「推荐 › 搜索推荐」配置，TOP 或人工列表 */
  const [recommend, setRecommend] = useState<HomeSearchView | null>(null)
  /** 吸顶头部滚过一点后加描边，内容从下面穿过去时有个边界 */
  const [elevated, setElevated] = useState(false)
  const [showBackTop, setShowBackTop] = useState(false)
  /** 搜索模式：本地查片库，在线向支持在线检索的站点按片名检索 */
  const [modeState, setModeState] = useState<SearchMode>(readSearchMode)
  /** 站点列表只为「在线」开关服务：哪些站点开了在线检索 */
  const [sites, setSites] = useState<Site[]>([])
  const [sitesLoaded, setSitesLoaded] = useState(false)
  /** 在线模式最近一次检索的结果：站点分布、后台任务数、是否截断 */
  const [online, setOnline] = useState<VideoOnlineSearchResult | null>(null)

  const onlineSites = useMemo(() => sites.filter((site) => site.onlineSearch), [sites])
  const onlineReady = onlineSites.length > 0
  /**
   * 上次停在在线模式、但已经没有站点支持在线检索时回落到本地：
   * 用派生值而不是 effect 里 setState，免得一次多余的渲染。
   */
  const mode: SearchMode =
    modeState === 'online' && sitesLoaded && !onlineReady ? 'local' : modeState

  const guard = useRef<SearchGuard>({
    generation: 0,
    page: 1,
    loading: false,
    failed: false,
    exhausted: false
  })
  /** 滚动回调读当前关键词：避免闭包拿到上一次搜索的值 */
  const keywordRef = useRef(initialKeyword)

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
   * 在线检索：主进程只问开启在线检索的站点，每站取第 1 页 20 条，
   * 按 name_key 合并（跨站同名合成一条）并按相关性排序后返回；
   * 同时会把这些关键词追加到各站点的「检索」采集任务，后台继续采。
   */
  const runOnline = useCallback(async (query: string): Promise<void> => {
    const token = guard.current.generation
    guard.current.loading = true
    guard.current.failed = false
    setLoading(true)
    setFailed(false)
    setOnline(null)
    try {
      const result = await window.api.videos.searchOnline({ keyword: query })
      // 换过关键词：这次结果已经没用了
      if (token !== guard.current.generation) return
      if (!result.ok) {
        guard.current.failed = true
        setFailed(true)
        return
      }
      setItems(result.items)
      setTotal(result.total)
      setOnline(result)
      // 在线结果是一次性快照（每站 20 条），不做滚动分页
      guard.current.page = 1
      guard.current.exhausted = true
      setExhausted(true)
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
  }, [])

  /**
   * 提交关键词：作废旧请求、清空结果、回到第一页并滚回顶部。
   * 空串等于退回初始态（落地页），同时把输入框清空。
   * modeOverride 用于「切换搜索模式后用同一个词重查」：状态更新是异步的，
   * 这里必须显式传入新模式，否则会拿切换前的那份闭包。
   */
  const startSearch = useCallback(
    (raw: string, modeOverride?: SearchMode): void => {
      const next = raw.trim()
      const targetMode = modeOverride ?? mode
      keywordRef.current = next
      setKeyword(next)
      onKeywordChange?.(next)
      setItems([])
      setTotal(null)
      setFailed(false)
      setExhausted(false)
      setElevated(false)
      setShowBackTop(false)
      setOnline(null)
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
      if (targetMode === 'online') void runOnline(next)
      else void loadPage(1, next, true)
    },
    [loadPage, runOnline, mode, onKeywordChange]
  )

  /** 切模式：写 localStorage；已经有提交过的关键词就用同一个词在新模式下重查 */
  const changeMode = (next: SearchMode): void => {
    if (next === mode) return
    setModeState(next)
    try {
      window.localStorage.setItem(MODE_KEY, next)
    } catch {
      // 隐私模式 / 配额不足时只在本次会话里保留
    }
    if (keywordRef.current) startSearch(keywordRef.current, next)
  }

  // 从控制台 / 设置返回时恢复上次的搜索结果：只在挂载时跑一次，不重复记历史。
  // 恢复现场要在挂载后补一次请求（先进入加载态），规则按调用点误报，这里显式关闭
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialKeyword.trim()) startSearch(initialKeyword)
  }, [initialKeyword, startSearch])

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

  /** 只删这一条：大小写不敏感，和历史去重时用的是同一套判断 */
  const removeHistory = (term: string): void => {
    const key = term.toLowerCase()
    setHistory((previous) => previous.filter((item) => item.toLowerCase() !== key))
  }

  /** 距离底部不到 LOAD_AHEAD 且还有下一页时继续取（在线模式一次性返回，不分页） */
  const maybeLoadMore = useCallback((): void => {
    if (mode !== 'local') return
    const state = guard.current
    const query = keywordRef.current
    if (!query || state.loading || state.failed || state.exhausted) return
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    if (page.scrollHeight - page.scrollTop - page.clientHeight > LOAD_AHEAD) return
    void loadPage(state.page, query, false)
  }, [loadPage, mode])

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

  // 初始态需要分类名、片库规模、站点（在线开关）和底部推荐：任何一块读失败都只是少显示一块
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
    // 站点列表：决定「在线」能不能切（没有站点开启在线检索时开关禁用并回落到本地）
    window.api.sites
      .list()
      .then((rows) => {
        if (cancelled) return
        setSites(rows)
        setSitesLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setSitesLoaded(true)
      })
    window.api.videos
      .stats()
      .then((value) => {
        if (!cancelled) setStats(value)
      })
      .catch(() => {
        // 统计失败时不显示「片库共 N 部视频」
      })
    // 底部推荐位：控制台「搜索推荐」里的配置，和搜索词无关
    window.api.home
      .getSearch()
      .then((result) => {
        if (!cancelled && result.ok && result.search) setRecommend(result.search)
      })
      .catch(() => {
        // 推荐读不到就不显示这一块
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 在线结果里的站点名：只用于失败提示，站点已被删除时退化到 id 前缀 */
  const siteLabelOf = (siteId: string): string => {
    const site = sites.find((row) => row.id === siteId)
    return site ? site.display || site.name : siteId.slice(0, 8)
  }

  /** 初始态的分类快捷入口：和列表页一样只取可见的一级分类 */
  const tops = useMemo(() => {
    const visible = visibleCategoryIds(categories)
    return categories
      .filter((row) => row.parentId === null && visible.has(row.id))
      .sort((left, right) => left.sortOrder - right.sortOrder)
  }, [categories])

  /**
   * 底部推荐位只显示能展示的条目：配置里隐藏的、视频被隐藏的、已经不在缓存库里的都不算。
   * 和控制台看到的是同一份配置，只是那边保留这些状态方便恢复。
   */
  const recommendItems = useMemo(
    () =>
      (recommend?.items ?? []).filter((item) => !item.hidden && !item.missing && !item.videoHidden),
    [recommend]
  )

  const retry = (): void => {
    const state = guard.current
    const query = keywordRef.current
    if (!query || state.loading) return
    state.failed = false
    setFailed(false)
    // 在线模式重试整次检索（结果是快照），本地模式重试当前这一页
    if (mode === 'online') void runOnline(query)
    else void loadPage(state.page, query, items.length === 0)
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

  /** 在线检索时所有站点都失败了：空状态要按「失败」而不是「没有找到」展示 */
  const onlineAllFailed = Boolean(
    online && online.sites.length > 0 && online.sites.every((site) => !site.ok)
  )

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
            <div className="search-head-side">
              <span className="search-count" aria-live="polite">
                {online ? (
                  total !== null ? (
                    <>
                      共 <b>{formatCount(total)}</b> 部 · {online.siteCount} 个站点
                    </>
                  ) : null
                ) : total !== null ? (
                  <>
                    共 <b>{formatCount(total)}</b> 部相关视频
                  </>
                ) : loading ? (
                  '正在搜索…'
                ) : null}
              </span>
              <SearchModeSwitch mode={mode} disabled={!onlineReady} onChange={changeMode} />
            </div>
          </div>
        </header>
      )}

      <div className={`search-body${keyword ? '' : ' is-intro'}`}>
        {!keyword ? (
          <div className="search-intro">
            <div className="search-intro-mode">
              <SearchModeSwitch mode={mode} disabled={!onlineReady} onChange={changeMode} />
            </div>
            <div className="search-intro-main">
              <h2 className="search-intro-title">搜索片库</h2>
              <p className="search-intro-desc">
                {mode === 'online'
                  ? '输入片名，向支持在线检索的站点检索，命中会合并入库。'
                  : '输入片名，按回车或点「搜索」；也可以从下面的分类进入。'}
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
                {mode === 'online' ? (
                  onlineReady ? (
                    <>
                      在线检索 <b>{onlineSites.length}</b> 个站点
                      <span className="search-meta-dot" />
                      每站前 {ONLINE_SITE_PAGE_SIZE} 条
                      <span className="search-meta-dot" />
                      命中会合并入库
                    </>
                  ) : (
                    '还没有站点开启在线检索，先在控制台 › 站点 编辑里打开「支持在线检索」'
                  )
                ) : stats && stats.videoCount > 0 ? (
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
                      <div className="search-history-item" key={term}>
                        <button
                          type="button"
                          className="search-history-run"
                          title={term}
                          onClick={() => {
                            setDraft(term)
                            runSearch(term)
                          }}
                        >
                          <HistoryOutlined />
                          <span>{term}</span>
                        </button>
                        <button
                          type="button"
                          className="search-history-remove"
                          title={`删除「${term}」`}
                          aria-label={`删除搜索记录：${term}`}
                          onClick={() => removeHistory(term)}
                        >
                          <CloseOutlined />
                        </button>
                      </div>
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

            {/* 底部推荐位：片名紧跟封面上方，整张卡片波浪交错，悬停时丝滑上托 */}
            {recommendItems.length > 0 && (
              <section className="search-recommend" aria-label="推荐视频">
                {recommendItems.map((item) => (
                  <button
                    key={item.videoId}
                    type="button"
                    className="search-recommend-card"
                    aria-label={`搜索：${item.title}`}
                    onClick={() => {
                      const term = (item.videoName || item.title).trim()
                      if (!term) return
                      setDraft(term)
                      runSearch(term)
                    }}
                  >
                    <div className="search-recommend-inner">
                      <span className="search-recommend-title" title={item.title}>
                        {item.title}
                      </span>
                      <div className="search-recommend-poster">
                        {/* 与控制台预览共用一套裁剪坐标：自定义图片按取景框显示 */}
                        <HomePicture item={item} />
                      </div>
                    </div>
                  </button>
                ))}
              </section>
            )}
          </div>
        ) : failed && items.length === 0 ? (
          <div className="search-empty">
            <p className="search-empty-title">搜索失败</p>
            <p className="search-empty-desc">
              {mode === 'online'
                ? '在线站点都没有返回结果，检查网络或站点是否可用，也可以改用本地搜索'
                : '视频缓存库可能正在初始化，稍后再试一次'}
            </p>
            <Button onClick={retry}>重新搜索</Button>
            {mode === 'online' && (
              <Button type="link" onClick={() => changeMode('local')}>
                改用本地搜索
              </Button>
            )}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="search-loading">
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <div className="search-empty">
            <p className="search-empty-title">
              {onlineAllFailed
                ? '在线检索失败'
                : `${mode === 'online' ? '在线检索没有找到' : '没有找到'}「${keyword}」`}
            </p>
            <p className="search-empty-desc">
              {onlineAllFailed
                ? `站点都没返回结果（${online?.sites
                    .filter((site) => !site.ok)
                    .map((site) => site.error ?? '失败')
                    .join('、')}），检查网络或站点是否可用，也可以改用本地搜索`
                : mode === 'online'
                  ? onlineReady
                    ? `${onlineSites.length} 个站点都没有命中这个词，换个关键词，或者改用本地搜索`
                    : '还没有站点开启在线检索，先去控制台 › 站点 编辑里打开'
                  : '换个关键词试试，或者按分类浏览片库'}
            </p>
            {mode === 'online' && onlineReady ? (
              <Button type="link" onClick={() => changeMode('local')}>
                改用本地搜索
              </Button>
            ) : (
              <Button onClick={() => onOpenBrowse(null)}>按分类浏览</Button>
            )}
          </div>
        ) : (
          <>
            <section className="search-results" aria-label={`「${keyword}」的搜索结果`}>
              {items.map((item) => (
                <SearchResultRow key={item.id} item={item} matcher={matcher} />
              ))}
            </section>

            <div className="search-footer">
              {mode === 'online' && online ? (
                <>
                  <span>
                    {online.siteCount} 个站点参与 · {online.sites.filter((site) => site.ok).length}{' '}
                    个成功
                    {online.sites.some((site) => !site.ok) && (
                      <>
                        {' · '}
                        <Tooltip
                          title={online.sites
                            .filter((site) => !site.ok)
                            .map((site) => `${siteLabelOf(site.siteId)}（${site.error ?? '失败'}）`)
                            .join('、')}
                        >
                          <span className="search-online-failed">
                            {online.sites.filter((site) => !site.ok).length} 个失败
                          </span>
                        </Tooltip>
                      </>
                    )}
                    {online.queued > 0 ? ` · 已触发 ${online.queued} 个检索采集任务` : ''}
                  </span>
                  {online.truncated ? (
                    <span>结果较多，只显示前 {items.length} 条</span>
                  ) : online.sites.some((site) => site.ok && site.recordCount > site.count) ? (
                    <span>站点还有更多命中，后台正在继续采集，完成后可切到「本地」查看全部</span>
                  ) : null}
                </>
              ) : failed ? (
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
