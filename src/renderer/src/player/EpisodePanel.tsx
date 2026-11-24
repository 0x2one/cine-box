import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent
} from 'react'
import { MoreOutlined, SettingOutlined } from '@ant-design/icons'
import {
  analyzeNaming,
  circledNumber,
  describeEpisode,
  EPISODE_ORDER_KEY,
  episodeCountLabel,
  episodeTitle,
  groupBySource,
  lineName,
  lineOrdinal,
  readEpisodeOrder,
  type EpisodeNaming,
  type EpisodeOrder,
  type PlayerLine
} from './player-data'

/** 每 100 集一个锚点区间：1-100、101-200 … */
const RANGE_SIZE = 100

type PanelMenu = 'settings' | 'sources' | null

interface EpisodeRange {
  /** 区间起点（原始序号，1 起） */
  start: number
  /** 区间终点，最后一段按总集数截断 */
  end: number
}

interface EpisodePanelProps {
  lines: PlayerLine[]
  line: PlayerLine
  onLine: (line: PlayerLine) => void
  episodeIndex: number
  onEpisode: (index: number) => void
  autoNext: boolean
  onAutoNext: (value: boolean) => void
  /** 当前线路的集名风格（量词 / 是否按日期排），由播放会话按分类算好传进来 */
  naming: EpisodeNaming
  /** 视频分类（大陆综艺 / 剧情片…）：只用来给「全部播放源」里的其它线路挑量词 */
  category: string
}

/** 「全部播放源」里每条线路的条数：综艺数「期」、电影数「个版本」 */
function lineCount(line: PlayerLine, category: string): string {
  const naming = analyzeNaming(
    line.episodes.map((episode) => episode.name),
    category
  )
  if (naming.textOnly) return `${line.episodes.length} 个版本`
  return `${line.episodes.length} ${naming.unit}`
}

function buildRanges(total: number): EpisodeRange[] {
  const ranges: EpisodeRange[] = []
  for (let start = 1; start <= total; start += RANGE_SIZE) {
    ranges.push({ start, end: Math.min(start + RANGE_SIZE - 1, total) })
  }
  return ranges
}

/**
 * 面板里的剧集列表 + 底部操作条。
 *
 * 这里不显示播放类型（jjm3u8 之类），也不在顶部放大字号的资源站名：
 * 当前播放源由底部那颗高亮的站名 chip 表示，够用又不抢戏。
 * 底部一条是「设置」+「播放源 chip」+（放不下时）「全部播放源」：
 * 两个图标按钮都把面板紧贴着往上弹，设置里是自动连播和集数排序，更多里是全部播放源。
 * 集数默认倒序（新→旧），可切正序；超过 100 集时网格上方多一条 1-100 / 101-200 的锚点，
 * 点击直接滚到对应区间，滚动时锚点跟着高亮。
 */
function EpisodePanel({
  lines,
  line,
  onLine,
  episodeIndex,
  onEpisode,
  autoNext,
  onAutoNext,
  naming,
  category
}: EpisodePanelProps): React.JSX.Element {
  const groups = useMemo(() => groupBySource(lines), [lines])
  const [order, setOrder] = useState<EpisodeOrder>(readEpisodeOrder)
  const [orderLive, setOrderLive] = useState(false)
  const [menu, setMenu] = useState<PanelMenu>(null)
  // 首帧就落在当前集所在的区间，避免先亮 1-100 再跳过去
  const [activeRange, setActiveRange] = useState(
    () => Math.floor(episodeIndex / RANGE_SIZE) * RANGE_SIZE + 1
  )
  const [overflow, setOverflow] = useState(false)
  const [edge, setEdge] = useState({ start: true, end: true })
  const gridRef = useRef<HTMLDivElement>(null)
  const sourcesRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const orderPillRef = useRef<HTMLSpanElement>(null)
  const descRef = useRef<HTMLButtonElement>(null)
  const ascRef = useRef<HTMLButtonElement>(null)
  const spyFrame = useRef(0)

  /** 按排序方式摊开的集数：index 始终是 line.episodes 里的原始下标 */
  const episodes = useMemo(() => {
    const items = line.episodes.map((episode, index) => ({ episode, index }))
    return order === 'desc' ? items.reverse() : items
  }, [line.episodes, order])

  const ranges = useMemo(() => buildRanges(line.episodes.length), [line.episodes.length])

  /** 每个格子的主行 / 次行：一条线路只解析一次，换排序不用重算 */
  const labels = useMemo(
    () => line.episodes.map((episode) => describeEpisode(episode.name, naming)),
    [line.episodes, naming]
  )

  /** 区间锚点名：按日期排的线路写两端的日期（06.28–11.22），其余写序号（1-100） */
  const rangeText = useCallback(
    (range: EpisodeRange): { label: string; title: string } => {
      const first = labels[range.start - 1]?.date ?? ''
      const last = labels[range.end - 1]?.date ?? ''
      // 日期乱序（同一线路里混着 E 号和日期）时，日期区间反而误导，退回序号
      if (naming.dated && naming.sorted && first && last) {
        const from = first < last ? first : last
        const to = first < last ? last : first
        return {
          label: from === to ? from : `${from}–${to}`,
          title: from === to ? `跳到 ${from}` : `跳到 ${from} 至 ${to}`
        }
      }
      const label = range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`
      return { label, title: `跳到第 ${range.start}–${range.end} ${naming.unit}` }
    },
    [labels, naming]
  )

  useEffect(() => {
    localStorage.setItem(EPISODE_ORDER_KEY, order)
  }, [order])

  /**
   * 倒序 / 正序 的滑块：直接量当前按钮的宽度和位置写内联样式，不经过 state，
   * 和标题栏的导航胶囊是同一套做法。用 offsetLeft / offsetWidth 而不是
   * getBoundingClientRect：弹层打开时正在跑 episode-pop-in 的上浮动画，
   * rect 会带上位移，offsetLeft 是布局坐标、不受 transform 影响。
   */
  const placeOrderPill = useCallback((): void => {
    const pill = orderPillRef.current
    const target = order === 'desc' ? descRef.current : ascRef.current
    if (!pill || !target) return
    pill.style.opacity = '1'
    pill.style.width = `${target.offsetWidth}px`
    pill.style.transform = `translate3d(${target.offsetLeft}px, 0, 0)`
  }, [order])

  useLayoutEffect(() => {
    // 设置弹层是条件渲染的：打开 / 关闭那一刻 refs 才出现，所以要跟着 menu 再量一次
    placeOrderPill()
  }, [placeOrderPill, menu])

  // 首帧量好位置之后才允许过渡，否则滑块会从 0 宽度展开
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOrderLive(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  /**
   * 区间里「显示在最上面」的那一集：正序是区间起点，倒序是区间终点。
   * 滚动定位和滚动高亮都拿它当参照，否则倒序时锚点会跳错地方。
   */
  const rangeAnchor = useCallback(
    (range: EpisodeRange): number => (order === 'desc' ? range.end : range.start),
    [order]
  )

  /** 滚动时让锚点跟着走：最后一个「已经滚过顶部」的区间就是当前区间 */
  const syncRange = useCallback(() => {
    const grid = gridRef.current
    if (!grid || ranges.length <= 1) return
    const top = grid.getBoundingClientRect().top
    const ordered = order === 'desc' ? [...ranges].reverse() : ranges
    let current = ordered[0].start
    for (const range of ordered) {
      const cell = grid.querySelector<HTMLElement>(`[data-ordinal="${rangeAnchor(range)}"]`)
      if (!cell) continue
      if (cell.getBoundingClientRect().top - top <= 8) current = range.start
    }
    setActiveRange(current)
  }, [order, rangeAnchor, ranges])

  const goRange = useCallback(
    (range: EpisodeRange) => {
      const grid = gridRef.current
      const cell = grid?.querySelector<HTMLElement>(`[data-ordinal="${rangeAnchor(range)}"]`)
      if (!grid || !cell) return
      // 只滚剧集网格，不走 scrollIntoView：面板外层是 overflow: hidden，
      // 让它去滚动祖先容器会把整个面板内容顶走
      const top =
        grid.scrollTop + cell.getBoundingClientRect().top - grid.getBoundingClientRect().top
      grid.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    },
    [rangeAnchor]
  )

  // 切集 / 切线路 / 改排序 / 重新展开面板：把当前集滚进可见区，再同步一次锚点
  useEffect(() => {
    const active = gridRef.current?.querySelector<HTMLElement>('.episode-cell.is-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    syncRange()
  }, [episodeIndex, line.key, order, syncRange])

  const handleGridScroll = (): void => {
    if (spyFrame.current) return
    spyFrame.current = requestAnimationFrame(() => {
      spyFrame.current = 0
      syncRange()
    })
  }

  useEffect(
    () => () => {
      if (spyFrame.current) cancelAnimationFrame(spyFrame.current)
    },
    []
  )

  // 播放源多到一行放不下时，最右边那颗「更多」出现；两端压暗只在没滚到头时显示
  useEffect(() => {
    const strip = sourcesRef.current
    if (!strip) return
    const update = (): void => {
      const max = strip.scrollWidth - strip.clientWidth
      const nextOverflow = max > 1
      setOverflow(nextOverflow)
      // 「更多」随溢出消失时，已经展开的播放源菜单也跟着收起
      if (!nextOverflow) setMenu((current) => (current === 'sources' ? null : current))
      const start = strip.scrollLeft <= 1
      const end = max <= 1 || strip.scrollLeft >= max - 1
      // 滚动时只在端点真的变了才更新，避免整块剧集网格跟着重渲染
      setEdge((current) =>
        current.start === start && current.end === end ? current : { start, end }
      )
    }
    update()
    strip.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(strip)
    return () => {
      strip.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [lines.length])

  // 切站后把当前 chip 带回可见区。「更多」出现时来源条会变窄，所以 overflow 变化也要重算
  useEffect(() => {
    const strip = sourcesRef.current
    const chip = strip?.querySelector<HTMLElement>('.episode-source-chip.is-active')
    if (!strip || !chip) return
    const chipRect = chip.getBoundingClientRect()
    const stripRect = strip.getBoundingClientRect()
    if (chipRect.right > stripRect.right) {
      strip.scrollBy({ left: chipRect.right - stripRect.right, behavior: 'smooth' })
    } else if (chipRect.left < stripRect.left) {
      strip.scrollBy({ left: chipRect.left - stripRect.left, behavior: 'smooth' })
    }
  }, [line.key, lines.length, overflow])

  // 点面板外面 / 按 Esc 收起弹出层
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!barRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  // 播放源条横向滚动：普通鼠标只有竖向滚轮，这里把 deltaY 转给 scrollLeft
  const wheelSources = (event: WheelEvent<HTMLDivElement>): void => {
    const strip = sourcesRef.current
    if (!strip || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if (strip.scrollWidth <= strip.clientWidth) return
    strip.scrollLeft += event.deltaY
  }

  /**
   * 顶部那行右侧的「正在播放」：跟随当前集 / 换线路更新，
   * 剧集网格滚到别的区间时也能知道在播哪一集。
   */
  const currentIndex = episodeIndex < line.episodes.length ? episodeIndex : 0
  const current = line.episodes[currentIndex] ?? null
  const currentLabel = labels[currentIndex] ?? null

  return (
    <section className="episode-panel">
      <div className="episode-head">
        <span className="episode-total">{episodeCountLabel(naming, line.episodes.length)}</span>
        {current && currentLabel && (
          <span
            className="episode-now"
            title={`正在播放 ${episodeTitle(current.name, currentIndex)}`}
          >
            <span className="episode-now-label">正在播放</span>
            <span className="episode-now-episode">{currentLabel.spoken}</span>
          </span>
        )}
      </div>

      {ranges.length > 1 && (
        <div className="episode-anchors" role="group" aria-label="集数区间">
          {ranges.map((range) => {
            const active = range.start === activeRange
            const text = rangeText(range)
            return (
              <button
                key={range.start}
                type="button"
                className={`episode-anchor${active ? ' is-active' : ''}`}
                aria-current={active ? 'true' : undefined}
                title={text.title}
                onClick={() => goRange(range)}
              >
                {text.label}
              </button>
            )
          })}
        </div>
      )}

      <div className="episode-grid" ref={gridRef} onScroll={handleGridScroll}>
        {episodes.map(({ episode, index }) => {
          const label = labels[index]
          const active = index === episodeIndex
          return (
            <button
              key={`${episode.index}-${episode.url}`}
              type="button"
              className={`episode-cell${active ? ' is-active' : ''}${label?.text ? ' is-text' : ''}`}
              data-ordinal={index + 1}
              title={episode.name || `第 ${index + 1} ${naming.unit}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => onEpisode(index)}
            >
              <span className="episode-num">{label?.main}</span>
              {label?.caption && <span className="episode-caption">{label.caption}</span>}
              {active && (
                <span className="episode-bars" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="episode-actions">
        <div className="episode-actionbar" ref={barRef}>
          <button
            type="button"
            className={`episode-action${menu === 'settings' ? ' is-open' : ''}`}
            title="播放设置"
            aria-label="播放设置"
            aria-expanded={menu === 'settings'}
            onClick={() => setMenu(menu === 'settings' ? null : 'settings')}
          >
            <SettingOutlined />
          </button>

          <div
            className={`episode-sources${edge.start ? '' : ' is-fade-start'}${
              edge.end ? '' : ' is-fade-end'
            }`}
            ref={sourcesRef}
            role="group"
            aria-label="播放源"
            onWheel={wheelSources}
          >
            {lines.map((item) => {
              const ordinal = lineOrdinal(item, groups)
              const active = item.key === line.key
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`episode-source-chip${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  title={lineName(item, groups)}
                  onClick={() => {
                    setMenu(null)
                    onLine(item)
                  }}
                >
                  <span className="episode-source-name">{item.sourceName}</span>
                  {ordinal > 0 && (
                    <span className="episode-source-ordinal">{circledNumber(ordinal)}</span>
                  )}
                </button>
              )
            })}
          </div>

          {overflow && (
            <button
              type="button"
              className={`episode-action${menu === 'sources' ? ' is-open' : ''}`}
              title="全部播放源"
              aria-label="全部播放源"
              aria-expanded={menu === 'sources'}
              onClick={() => setMenu(menu === 'sources' ? null : 'sources')}
            >
              <MoreOutlined />
            </button>
          )}

          {menu === 'settings' && (
            <div className="episode-popover is-settings" role="dialog" aria-label="播放设置">
              <div className="episode-setting-row">
                <span className="episode-setting-label">自动连播</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoNext}
                  className={`episode-switch${autoNext ? ' is-on' : ''}`}
                  title={autoNext ? '关闭自动连播' : '开启自动连播'}
                  onClick={() => onAutoNext(!autoNext)}
                >
                  <span className="episode-switch-knob" />
                </button>
              </div>
              <div className="episode-setting-row">
                <span className="episode-setting-label">集数排序</span>
                <div className="episode-order" role="group" aria-label="集数排序">
                  <span
                    className={`episode-order-pill${orderLive ? ' is-live' : ''}`}
                    ref={orderPillRef}
                    aria-hidden="true"
                  />
                  <button
                    ref={descRef}
                    type="button"
                    className={`episode-order-btn${order === 'desc' ? ' is-active' : ''}`}
                    aria-pressed={order === 'desc'}
                    onClick={() => setOrder('desc')}
                  >
                    倒序
                  </button>
                  <button
                    ref={ascRef}
                    type="button"
                    className={`episode-order-btn${order === 'asc' ? ' is-active' : ''}`}
                    aria-pressed={order === 'asc'}
                    onClick={() => setOrder('asc')}
                  >
                    正序
                  </button>
                </div>
              </div>
            </div>
          )}

          {menu === 'sources' && (
            <div className="episode-popover is-sources" role="dialog" aria-label="全部播放源">
              <div className="episode-popover-head">播放源</div>
              <div className="episode-source-list">
                {lines.map((item) => {
                  const ordinal = lineOrdinal(item, groups)
                  const active = item.key === line.key
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`episode-source-item${active ? ' is-active' : ''}`}
                      aria-pressed={active}
                      onClick={() => {
                        setMenu(null)
                        onLine(item)
                      }}
                    >
                      <span className="episode-source-item-name">{item.sourceName}</span>
                      {ordinal > 0 && (
                        <span className="episode-source-item-ordinal">
                          {circledNumber(ordinal)}
                        </span>
                      )}
                      <span className="episode-source-item-count">{lineCount(item, category)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default EpisodePanel
