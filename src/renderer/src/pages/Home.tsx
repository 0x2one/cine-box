import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spin } from 'antd'
import { CloseOutlined, LeftOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons'
import HomePicture from '../components/HomePicture'
import VideoCard from '../components/VideoCard'
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
/** 叠层拖动超过这个距离才算翻页，太短就当作没拖 */
const HERO_DRAG = 64

/**
 * 一个分类轨道：头部两个箭头控制横向滚动。
 * 内容比轨道宽时把列表复制一份，滚过接缝就换成内容完全一样的另一半，
 * 所以左右两个方向都能一直划下去（不会停在第一个 / 最后一个）。
 */
function HomeRail({
  section,
  items,
  count,
  onOpenBrowse
}: {
  section: HomeSectionView
  items: HomeItemView[]
  count: number
  onOpenBrowse: (categoryId: string) => void
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  /** 指针横向拖动：按住往左拖就是往后看，和箭头按钮等价 */
  const dragRef = useRef<{ id: number; x: number; scroll: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** 列表是否复制了一份（只有内容溢出时才需要循环） */
  const [looping, setLooping] = useState(false)
  const loopRef = useRef(false)
  /** 箭头翻页的平滑滚动期间不做接缝校正，等它滚完再归位 */
  const settlingRef = useRef(false)
  const settleTimer = useRef(0)

  /** 一份（复制前）列表的像素宽度：用第二份第一张卡的偏移算，比 scrollWidth / 2 准 */
  const copyWidthOf = useCallback(
    (rail: HTMLDivElement): number => {
      if (!loopRef.current) return rail.scrollWidth
      const first = rail.children[0] as HTMLElement | undefined
      const clone = rail.children[items.length] as HTMLElement | undefined
      if (!first || !clone) return rail.scrollWidth / 2
      return clone.offsetLeft - first.offsetLeft
    },
    [items.length]
  )

  /** 瞬移：轨道本身是 scroll-behavior: smooth，换接缝 / 回到起点时必须绕开它，否则会看见一段长滑动 */
  const jump = (rail: HTMLDivElement, left: number): void => {
    const previous = rail.style.scrollBehavior
    rail.style.scrollBehavior = 'auto'
    rail.scrollLeft = left
    rail.style.scrollBehavior = previous
  }

  /** 滚过接缝就跳到等价的另一半：相差整整一份，画面一模一样，用户看不见跳变 */
  const normalize = (): void => {
    const rail = railRef.current
    if (!rail || !loopRef.current) return
    const half = copyWidthOf(rail)
    if (half <= 1) return
    const current = rail.scrollLeft
    let next = current
    if (current > half + 0.5) next = current - half
    // 顶到最左边其实是另一份的开头，换过去之后往右还有得划
    else if (current <= 0.5) next = current + half
    if (Math.abs(next - current) <= 0.5) return
    jump(rail, next)
    // 拖动中途换位时，拖动基准也要跟着挪，否则下一次移动会跳回去
    if (dragRef.current) dragRef.current.scroll = next
  }

  const update = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    const max = rail.scrollWidth - rail.clientWidth
    setEdges({
      left: rail.scrollLeft > 1,
      right: max > 1 && rail.scrollLeft < max - 1
    })
  }, [])

  /** 按「一份」的宽度判断要不要循环：复制过之后 scrollWidth 是两份 */
  const measure = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    const perCopy = copyWidthOf(rail)
    const next = items.length > 1 && perCopy > rail.clientWidth + 2
    if (next === loopRef.current) return
    loopRef.current = next
    setLooping(next)
  }, [copyWidthOf, items.length])

  useEffect(() => {
    measure()
    update()
    const rail = railRef.current
    if (!rail) return
    const observer = new ResizeObserver(() => {
      measure()
      update()
    })
    observer.observe(rail)
    return () => observer.disconnect()
  }, [measure, update])

  // 复制之后从第二份的开头开始：左边和右边都留着可以划的内容
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    if (looping) jump(rail, copyWidthOf(rail))
  }, [copyWidthOf, looping, items.length])

  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  const step = (direction: number): void => {
    const rail = railRef.current
    if (!rail) return
    const first = rail.firstElementChild as HTMLElement | null
    // 卡片宽度 + 轨道 gap（home.css 里是 14px）
    const width = (first?.offsetWidth ?? 146) + 14
    const delta = direction * 3 * width
    if (!loopRef.current) {
      rail.scrollBy({ left: delta })
      return
    }
    const half = copyWidthOf(rail)
    // 先把起点换到「中间」的位置（整份宽度，画面一样），两边各留一步的空间
    if (rail.scrollLeft < half / 2) jump(rail, rail.scrollLeft + half)
    else if (rail.scrollLeft > half * 1.5) jump(rail, rail.scrollLeft - half)
    if (rail.scrollLeft + delta > rail.scrollWidth - rail.clientWidth) {
      jump(rail, rail.scrollLeft - half)
    }
    settlingRef.current = true
    rail.scrollBy({ left: delta, behavior: 'smooth' })
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      settlingRef.current = false
      normalize()
    }, 420)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rail = railRef.current
    if (!rail || event.button !== 0) return
    dragRef.current = { id: event.pointerId, x: event.clientX, scroll: rail.scrollLeft }
    setDragging(true)
    rail.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = dragRef.current
    const rail = railRef.current
    if (!state || !rail || state.id !== event.pointerId) return
    // 直接写 scrollLeft（不是 scrollBy），这样拖到一半停住不会继续滑
    rail.scrollLeft = state.scroll - (event.clientX - state.x)
    normalize()
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = dragRef.current
    if (!state || state.id !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    const rail = railRef.current
    if (rail?.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId)
  }

  const track = looping ? [...items, ...items] : items

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2 className="home-section-title">
          {/* 点大类名 = 看这个大类下的全部视频，和右侧「全部」等价 */}
          <button
            type="button"
            className="home-section-title-btn"
            title={`查看「${section.title}」的全部视频`}
            onClick={() => onOpenBrowse(section.categoryId)}
          >
            {section.title}
          </button>
        </h2>
        <span className="home-section-count">共 {count} 部</span>
        <div className="home-section-tools">
          <button
            type="button"
            className="home-section-more"
            title={`查看「${section.title}」的全部视频`}
            onClick={() => onOpenBrowse(section.categoryId)}
          >
            全部
          </button>
          <button
            type="button"
            className="home-rail-btn"
            aria-label="向前"
            disabled={!looping && !edges.left}
            onClick={() => step(-1)}
          >
            <LeftOutlined />
          </button>
          <button
            type="button"
            className="home-rail-btn"
            aria-label="向后"
            disabled={!looping && !edges.right}
            onClick={() => step(1)}
          >
            <RightOutlined />
          </button>
        </div>
      </div>
      <div
        className={`home-rail${dragging ? ' is-dragging' : ''}`}
        ref={railRef}
        onScroll={() => {
          if (!settlingRef.current) normalize()
          update()
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDragStart={(event) => event.preventDefault()}
      >
        {track.map((item, index) => (
          <VideoCard
            // 复制的第二份用下标区分 key，滚动时不会因为重复 id 报错
            key={`${item.videoId}-${index}`}
            title={item.title}
            pic={item.pic}
            crop={item.crop}
            customPic={item.customPic}
            note={item.note}
            intro={item.intro}
            actors={item.actors}
            latestTime={item.latestTime}
            ariaHidden={looping && index >= items.length}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * 推荐页：海报叠层（宽图铺满、右侧露边、循环翻页）+ 按一级分类的推荐轨道。
 * 暂时不做播放 / 详情页，卡片和海报只展示；分类标题和「全部」跳到视频列表页。
 */
function HomeView({
  onOpenConsole,
  onOpenBrowse
}: {
  onOpenConsole: () => void
  onOpenBrowse: (categoryId: string) => void
}): React.JSX.Element {
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

  /** 叠层拖动：往左拖翻到下一部，往右拖回上一部，和手机上滑动一致 */
  const deckRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ id: number; x: number; moved: boolean } | null>(null)
  /** 松手时浏览器还会补一个 click，用它挡住「拖完顺手翻两页」 */
  const dragMoved = useRef(false)
  /** 松手后把 --drag 归零的计时器 */
  const dragResetTimer = useRef(0)
  const [dragging, setDragging] = useState(false)

  useEffect(
    () => () => {
      window.clearTimeout(dragResetTimer.current)
    },
    []
  )

  const onHeroPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || posters.length < 2) return
    // 先不捕获指针：捕获会把 click 也挪到 section 上，翻页箭头和卡片就点不着了
    dragState.current = { id: event.pointerId, x: event.clientX, moved: false }
    dragMoved.current = false
    setDragging(true)
  }

  const onHeroPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const state = dragState.current
    if (!state || state.id !== event.pointerId) return
    const dx = event.clientX - state.x
    if (Math.abs(dx) > 6) {
      state.moved = true
      dragMoved.current = true
      // 确认是在拖动才捕获，之后拖出叠层也能跟手
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
    }
    // 只有最前面那张跟着指针走：位移 1:1，松手靠 CSS 过渡回到该在的位置
    const deck = deckRef.current
    const width = deck?.clientWidth || 900
    const shifted = Math.max(-width, Math.min(width, dx))
    deck?.style.setProperty('--drag', `${shifted}px`)
  }

  const endHeroDrag = (event: React.PointerEvent<HTMLElement>, commit: boolean): void => {
    const state = dragState.current
    if (!state || state.id !== event.pointerId) return
    const dx = event.clientX - state.x
    dragState.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // 松手：撤掉「跟手」这一帧的 transition:none，卡片自己滑回去 / 滑到最底层
    setDragging(false)
    window.clearTimeout(dragResetTimer.current)
    // 等过渡跑起来再清掉位移，否则会直接跳回原位
    dragResetTimer.current = window.setTimeout(() => {
      deckRef.current?.style.setProperty('--drag', '0px')
    }, 340)
    if (!commit || !state.moved || Math.abs(dx) < HERO_DRAG) return
    // 够远了：换一张。卡片按视频 id 做 key，所以「换页」只是各张挪到新槽位，
    // 被拖的那张顺势滑到最底层，下一层顶上来的过程是连续的
    const total = posters.length
    if (total < 2) return
    window.clearTimeout(swapTimer.current)
    setSwapping(false)
    setIndex((((index + (dx < 0 ? 1 : -1)) % total) + total) % total)
  }

  /** 拖完那一下的 click 不再翻页，纯点击照旧 */
  const clickGo = (target: number): void => {
    if (dragMoved.current) return
    go(target)
  }

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
        // 来源时间带时分秒，推荐页上只留日期，避免压过片名
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
          <p className="home-empty-title">推荐页数据读取失败</p>
          <p className="home-empty-desc">视频缓存库可能正在初始化，稍后再试一次</p>
          <Button onClick={() => void load()}>重新加载</Button>
        </div>
      ) : (
        <>
          {current && (
            <section
              className={`home-hero${dragging ? ' is-dragging' : ''}`}
              style={{ '--stack': `${stack}px` } as React.CSSProperties}
              aria-label="海报推荐"
              aria-roledescription="carousel"
              onPointerEnter={() => setPaused(true)}
              onPointerLeave={() => setPaused(false)}
              onPointerDown={onHeroPointerDown}
              onPointerMove={onHeroPointerMove}
              onPointerUp={(event) => endHeroDrag(event, true)}
              onPointerCancel={(event) => endHeroDrag(event, false)}
              onDragStart={(event) => event.preventDefault()}
            >
              <div className="home-deck" ref={deckRef}>
                {Array.from({ length: slotCount }, (_, slot) => {
                  const poster = posters[(index + slot) % posters.length]
                  const front = slot === 0
                  return (
                    <div
                      // 按视频 id 做 key：换页时是同一张卡片挪到新槽位，过渡才连得上
                      key={poster.videoId}
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
                      onClick={front ? undefined : () => clickGo(index + slot)}
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
                      onClick={() => clickGo(index - 1)}
                    >
                      <LeftOutlined style={{ fontSize: 11 }} />
                    </button>
                    <button
                      type="button"
                      className="home-pager-btn"
                      aria-label="下一部"
                      onClick={() => clickGo(index + 1)}
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
              onOpenBrowse={onOpenBrowse}
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
              <p className="home-empty-title">推荐页还没有内容</p>
              <p className="home-empty-desc">去控制台「推荐」把视频加进海报，或者打开分类推荐</p>
              <Button onClick={onOpenConsole}>打开控制台</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default HomeView
