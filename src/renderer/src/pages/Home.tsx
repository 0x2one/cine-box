import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spin } from 'antd'
import { CloseOutlined, LeftOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons'
import HomePicture from '../components/HomePicture'
import '../assets/home.css'

/** 叠层槽位：向右叠，露出的宽度越来越少（30 / 14 / 11 / 9 / 8） */
const SLOTS = [
  { left: 0, dim: 0 },
  { left: 30, dim: 0.38 },
  { left: 44, dim: 0.52 },
  { left: 55, dim: 0.62 },
  { left: 64, dim: 0.7 },
  { left: 72, dim: 0.78 }
]
const AUTOPLAY_MS = 7000

/** 一个分类轨道：头部两个箭头控制横向滚动，两端到头就置灰 */
function HomeRail({
  section,
  items,
  count
}: {
  section: HomeSectionView
  items: HomeItemView[]
  count: number
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const update = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    const max = rail.scrollWidth - rail.clientWidth
    setEdges({
      left: rail.scrollLeft > 1,
      right: max > 1 && rail.scrollLeft < max - 1
    })
  }, [])

  useEffect(() => {
    update()
    const rail = railRef.current
    if (!rail) return
    const observer = new ResizeObserver(update)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [items.length, update])

  const step = (direction: number): void => {
    const rail = railRef.current
    if (!rail) return
    const first = rail.firstElementChild as HTMLElement | null
    const width = (first?.offsetWidth ?? 146) + 16
    rail.scrollBy({ left: direction * 3 * width })
  }

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2 className="home-section-title">{section.title}</h2>
        <span className="home-section-count">共 {count} 部</span>
        <div className="home-section-tools">
          <button
            type="button"
            className="home-rail-btn"
            aria-label="向前"
            disabled={!edges.left}
            onClick={() => step(-1)}
          >
            <LeftOutlined />
          </button>
          <button
            type="button"
            className="home-rail-btn"
            aria-label="向后"
            disabled={!edges.right}
            onClick={() => step(1)}
          >
            <RightOutlined />
          </button>
        </div>
      </div>
      <div className="home-rail" ref={railRef} onScroll={update}>
        {items.map((item) => (
          <article className="home-item" key={item.videoId} title={item.title}>
            <div className="home-item-poster">
              <HomePicture item={item} />
            </div>
            <p className="home-item-title" title={item.title}>
              {item.title}
            </p>
            <p className="home-item-note">
              {item.note || (item.latestTime ? `更新 ${item.latestTime}` : '')}
            </p>
            <p className="home-item-sub">
              {item.intro || (item.actors ? `主演 ${item.actors}` : '')}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

/**
 * 首页：海报叠层（宽图铺满、右侧露边、循环翻页）+ 按一级分类的推荐轨道。
 * 暂时不做播放 / 详情页，所以卡片和海报只展示，不挂跳转。
 */
function HomeView({ onOpenConsole }: { onOpenConsole: () => void }): React.JSX.Element {
  const [feed, setFeed] = useState<HomeFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [swapping, setSwapping] = useState(false)
  const [paused, setPaused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const swapTimer = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.api.home.get()
      if (!result.ok || !result.feed) {
        setFailed(true)
        return
      }
      setFailed(false)
      setFeed(result.feed)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // setState 发生在 await 之后；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  useEffect(
    () => () => {
      window.clearTimeout(swapTimer.current)
    },
    []
  )

  /** 只有展示中的海报才算数：隐藏的、视频已丢失的、视频库隐藏的都不进叠层 */
  const posters = useMemo(
    () =>
      (feed?.posters ?? []).filter((item) => !item.hidden && !item.missing && !item.videoHidden),
    [feed]
  )
  const sections = useMemo(() => feed?.sections ?? [], [feed])

  useEffect(() => {
    // 叠层里的海报来回换，先把图都预热一遍，翻页时不会闪底色
    for (const poster of posters) {
      if (!poster.pic) continue
      const image = new Image()
      image.src = poster.pic
    }
  }, [posters])

  const slotCount = Math.min(SLOTS.length, posters.length)
  const stack = slotCount > 0 ? SLOTS[slotCount - 1].left : 0
  const current = posters.length > 0 ? posters[index % posters.length] : null

  const go = useCallback(
    (target: number): void => {
      const total = posters.length
      if (total < 2) return
      const next = ((target % total) + total) % total
      if (next === index % total) return
      setSwapping(true)
      window.clearTimeout(swapTimer.current)
      // 跟原型一致：先让文字淡出，再换图，避免两张海报的文字叠在一起
      swapTimer.current = window.setTimeout(() => {
        setIndex(next)
        setSwapping(false)
      }, 140)
    },
    [index, posters.length]
  )

  useEffect(() => {
    if (posters.length < 2 || paused) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => {
      if (!document.hidden) go(index + 1)
    }, AUTOPLAY_MS)
    return () => window.clearInterval(timer)
  }, [go, index, paused, posters.length])

  // 快捷键：Ctrl K 聚焦搜索、Esc 清空、左右键翻海报
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        return
      }
      if (event.key === 'Escape' && typing && query) {
        setQuery('')
        return
      }
      if (typing) return
      if (event.key === 'ArrowLeft') go(index - 1)
      if (event.key === 'ArrowRight') go(index + 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [go, index, query])

  const keyword = query.trim().toLowerCase()
  const matchedSections = useMemo(() => {
    return sections
      .filter((section) => section.visible && section.categoryVisible)
      .map((section) => {
        const visible = section.items.filter(
          (item) => !item.hidden && !item.missing && !item.videoHidden
        )
        const items = keyword
          ? visible.filter((item) =>
              `${item.title} ${item.note} ${item.actors} ${item.intro} ${section.title}`
                .toLowerCase()
                .includes(keyword)
            )
          : visible
        return { section, items }
      })
      .filter((entry) => entry.items.length > 0)
  }, [keyword, sections])

  const matched = matchedSections.reduce((sum, entry) => sum + entry.items.length, 0)
  const hasContent = posters.length > 0 || matchedSections.length > 0

  const meta = current
    ? [
        current.vodClass.split(',')[0],
        current.note,
        // 来源时间带时分秒，首页上只留日期，避免压过片名
        current.latestTime ? `更新 ${current.latestTime.split(' ')[0]}` : ''
      ].filter(Boolean)
    : []

  return (
    <div className="home-view">
      <div className="home-search">
        <SearchOutlined className="home-search-icon" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="搜片名、演员、分类"
          aria-label="搜索片库"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="home-search-clear"
            aria-label="清除搜索"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <CloseOutlined style={{ fontSize: 10 }} />
          </button>
        ) : (
          <span className="home-search-hint">Ctrl K</span>
        )}
      </div>

      {loading ? (
        <div className="home-loading">
          <Spin />
        </div>
      ) : failed ? (
        <div className="home-empty-state">
          <p className="home-empty-title">首页数据读取失败</p>
          <p className="home-empty-desc">视频缓存库可能正在初始化，稍后再试一次</p>
          <Button onClick={() => void load()}>重新加载</Button>
        </div>
      ) : (
        <>
          {current && (
            <section
              className="home-hero"
              style={{ '--stack': `${stack}px` } as React.CSSProperties}
              aria-label="海报推荐"
              aria-roledescription="carousel"
              onPointerEnter={() => setPaused(true)}
              onPointerLeave={() => setPaused(false)}
            >
              <div className="home-deck">
                {Array.from({ length: slotCount }, (_, slot) => {
                  const poster = posters[(index + slot) % posters.length]
                  const front = slot === 0
                  return (
                    <div
                      // 槽位固定，换的是槽位里的人和位置
                      key={`slot-${slot}`}
                      className="home-card"
                      data-slot={slot}
                      style={
                        {
                          '--left': `${SLOTS[slot].left}px`,
                          '--dim': String(SLOTS[slot].dim),
                          zIndex: slotCount - slot
                        } as React.CSSProperties
                      }
                      role={front ? undefined : 'button'}
                      tabIndex={front ? undefined : 0}
                      title={front ? undefined : `翻到《${poster.title}》`}
                      aria-label={front ? undefined : `翻到：${poster.title}`}
                      onClick={front ? undefined : () => go(index + slot)}
                      onKeyDown={
                        front
                          ? undefined
                          : (event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                go(index + slot)
                              }
                            }
                      }
                    >
                      <HomePicture item={poster} eager />
                    </div>
                  )
                })}
              </div>

              <div className={`home-hero-info${swapping ? ' is-swapping' : ''}`}>
                {meta.length > 0 && <p className="home-hero-meta">{meta.join(' / ')}</p>}
                <h1 className="home-hero-title">{current.title}</h1>
                {current.actors && (
                  <p className="home-hero-actors">
                    <span>主演</span>
                    {current.actors}
                  </p>
                )}
                {current.intro && <p className="home-hero-intro">{current.intro}</p>}
                <div className="home-hero-actions">
                  <div className="home-pager">
                    <span className="home-pager-count">
                      <b>{String((index % posters.length) + 1).padStart(2, '0')}</b> /{' '}
                      {String(posters.length).padStart(2, '0')}
                    </span>
                    <button
                      type="button"
                      className="home-pager-btn"
                      aria-label="上一部"
                      onClick={() => go(index - 1)}
                    >
                      <LeftOutlined style={{ fontSize: 11 }} />
                    </button>
                    <button
                      type="button"
                      className="home-pager-btn"
                      aria-label="下一部"
                      onClick={() => go(index + 1)}
                    >
                      <RightOutlined style={{ fontSize: 11 }} />
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {keyword && matched > 0 && (
            <p className="home-result-line">
              搜索「{query.trim()}」找到 <em>{matched}</em> 部影片
            </p>
          )}

          {matchedSections.map(({ section, items }) => (
            <HomeRail
              key={section.categoryId}
              section={section}
              items={items}
              count={keyword ? items.length : section.total}
            />
          ))}

          {/* 有搜索词但一条都没中：海报还留着，下面单独给一个空状态 */}
          {keyword && matched === 0 && (
            <div className="home-empty-state">
              <p className="home-empty-title">片库里没有「{query.trim()}」</p>
              <p className="home-empty-desc">换个片名、演员或分类再试一次</p>
              <Button
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
              >
                清除搜索
              </Button>
            </div>
          )}

          {!keyword && !hasContent && (
            <div className="home-empty-state">
              <p className="home-empty-title">首页还没有内容</p>
              <p className="home-empty-desc">去控制台「首页」把视频加进海报，或者打开分类推荐</p>
              <Button onClick={onOpenConsole}>打开控制台</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default HomeView
