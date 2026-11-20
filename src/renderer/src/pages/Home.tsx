import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spin } from 'antd'
import { ArrowUpOutlined, CaretRightOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import HomePicture from '../components/HomePicture'
import VideoCard from '../components/VideoCard'
import { formatCount } from '../utils/format'
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

/** 底部最新列表：一页 30 条，和「找片看」用同一套卡片 */
const LATEST_PAGE_SIZE = 30
/** 左上角跑马灯占的 TOP 条数：这几部不再进入下方列表 */
const LATEST_LEAD = 5
/** 跑马灯每部停留时长 */
const LATEST_LEAD_MS = 3600
/** 跑马灯左右拖动超过这个距离才翻页 */
const LATEST_SWIPE = 40
/** 距底部这么多像素就取下一页 */
const LATEST_LOAD_AHEAD = 600
/** 滚过这么多像素浮出「回到顶部」 */
const LATEST_BACK_TOP_AT = 600
/** 没有自定义裁剪时按 cover 铺满，和 VideoCard 保持一致 */
const FULL_CROP: HomeCrop = { x: 0, y: 0, w: 1, h: 1 }

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
            videoId={item.videoId}
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
 * 推荐页底部：按更新时间倒序的整库列表，卡片与「找片看」一致，滚到底自动取下一页。
 * 左上角第一格是最新 5 部的跑马灯：两行三列的大图，封面左右铺满、上下取中间，
 * 信息压在图上（底部深色过渡），支持左右拖动切换；这 5 部不再进入下方列表。
 */
function HomeLatest({ onOpenBrowse }: { onOpenBrowse: () => void }): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null)
  const [items, setItems] = useState<VideoListItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [leadIndex, setLeadIndex] = useState(0)
  const [leadPaused, setLeadPaused] = useState(false)
  const [showBackTop, setShowBackTop] = useState(false)
  /** 滚动回调要读的可变状态：放在 ref 里，避免闭包拿到过期的 page / loading */
  const guard = useRef({ page: 1, loading: true, failed: false, exhausted: false })
  const startedRef = useRef(false)

  const load = useCallback(async (page: number, replace: boolean): Promise<void> => {
    guard.current.loading = true
    setLoading(true)
    setFailed(false)
    try {
      const result = await window.api.videos.list({
        page,
        pageSize: LATEST_PAGE_SIZE,
        visibility: 'shown'
      })
      if (!result.ok) {
        guard.current.failed = true
        setFailed(true)
        return
      }
      setItems((previous) => {
        if (replace) return result.items
        // 采集 / 隐藏会让 offset 分页错位，按视频 id 去重，避免重复卡片
        const seen = new Set(previous.map((item) => item.id))
        return [...previous, ...result.items.filter((item) => !seen.has(item.id))]
      })
      setTotal(result.total)
      guard.current.page = page + 1
      const last = result.items.length < LATEST_PAGE_SIZE || page * LATEST_PAGE_SIZE >= result.total
      guard.current.exhausted = last
      setExhausted(last)
    } catch {
      guard.current.failed = true
      setFailed(true)
    } finally {
      guard.current.loading = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // StrictMode 下 effect 会执行两次，这里只让首次挂载真正请求
    if (startedRef.current) return
    startedRef.current = true
    void load(1, true)
  }, [load])

  /** 距离底部不到 LATEST_LOAD_AHEAD 且还有下一页时继续取 */
  const maybeLoadMore = useCallback((): void => {
    const state = guard.current
    if (state.loading || state.failed || state.exhausted) return
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    if (page.scrollHeight - page.scrollTop - page.clientHeight > LATEST_LOAD_AHEAD) return
    void load(state.page, false)
  }, [load])

  // 一页填不满窗口时接着取，否则要等用户再滚一下才会触发
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => maybeLoadMore())
    return () => window.cancelAnimationFrame(frame)
  }, [maybeLoadMore, items.length, loading, total, failed, exhausted])

  // 滚动加载 + 回到顶部共用页面滚动事件（.page 才是滚动容器）
  useEffect(() => {
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    let frame = 0
    const sync = (): void => {
      setShowBackTop(page.scrollTop > LATEST_BACK_TOP_AT)
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

  const lead = items.slice(0, LATEST_LEAD)
  const rest = items.slice(LATEST_LEAD)
  const leadCount = lead.length
  const activeLead = leadCount > 0 ? lead[leadIndex % leadCount] : null

  /** 跑马灯拖动切换：往左拖看下一部，往右拖回上一部 */
  const leadDrag = useRef<{ id: number; x: number; captured: boolean } | null>(null)
  const [leadDragging, setLeadDragging] = useState(false)

  const goLead = (target: number): void => {
    if (leadCount < 2) return
    setLeadIndex(((target % leadCount) + leadCount) % leadCount)
  }

  const onLeadPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (leadCount < 2) return
    leadDrag.current = { id: event.pointerId, x: event.clientX, captured: false }
  }

  const onLeadPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const state = leadDrag.current
    if (!state || state.id !== event.pointerId) return
    // 移动超过一点再捕获指针：圆点的 click 不会被抢走，单纯点一下也不会暂停轮播
    if (!state.captured && Math.abs(event.clientX - state.x) > 8) {
      state.captured = true
      setLeadDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const endLeadDrag = (event: React.PointerEvent<HTMLElement>, apply: boolean): void => {
    const state = leadDrag.current
    leadDrag.current = null
    setLeadDragging(false)
    if (!state || state.id !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!apply) return
    const dx = event.clientX - state.x
    if (Math.abs(dx) < LATEST_SWIPE) return
    goLead(leadIndex + (dx < 0 ? 1 : -1))
  }

  // 跑马灯自动轮播：悬停 / 聚焦 / 拖动时暂停；系统要求减少动效时不自动播
  useEffect(() => {
    if (leadCount < 2 || leadPaused || leadDragging) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => {
      if (!document.hidden) setLeadIndex((index) => (index + 1) % leadCount)
    }, LATEST_LEAD_MS)
    return () => window.clearInterval(timer)
  }, [leadCount, leadPaused, leadDragging])

  const retry = (): void => {
    const state = guard.current
    if (state.loading) return
    state.failed = false
    setFailed(false)
    void load(state.page, items.length === 0)
  }

  const backToTop = (): void => {
    const page = rootRef.current?.closest('.page') as HTMLElement | null
    if (!page) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    page.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
  }

  /** 压在大图上的小字：note + 类型 + 更新日期 */
  const leadMeta = activeLead
    ? [
        activeLead.note,
        activeLead.vodClass.split(',')[0]?.trim(),
        activeLead.latestTime ? `更新 ${activeLead.latestTime.split(' ')[0]}` : ''
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <section className="home-latest" ref={rootRef} aria-label="最新收录">
      <div className="home-section-head">
        <h2 className="home-section-title">最新收录</h2>
        {total !== null && <span className="home-section-count">共 {formatCount(total)} 部</span>}
        <div className="home-section-tools">
          <button
            type="button"
            className="home-section-more"
            title="在列表页浏览全部视频"
            onClick={onOpenBrowse}
          >
            全部视频
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        failed ? (
          <div className="home-latest-empty">
            <span>最新视频读取失败</span>
            <Button type="link" size="small" onClick={retry}>
              重试
            </Button>
          </div>
        ) : loading ? (
          <div className="home-loading">
            <Spin />
          </div>
        ) : (
          <div className="home-latest-empty">
            <span>片库里还没有可展示的视频</span>
          </div>
        )
      ) : (
        <>
          <div className="home-latest-grid">
            {activeLead && (
              <article
                className={`home-latest-lead${leadDragging ? ' is-dragging' : ''}`}
                aria-roledescription="carousel"
                aria-label={`最新 ${leadCount} 部`}
                onPointerEnter={() => setLeadPaused(true)}
                onPointerLeave={() => setLeadPaused(false)}
                onFocus={(event) => {
                  // 只有键盘聚焦才暂停：鼠标点圆点也会聚焦，不能让它一直停在那里
                  const target = event.target
                  if (target instanceof HTMLElement && target.matches(':focus-visible')) {
                    setLeadPaused(true)
                  }
                }}
                onBlur={() => setLeadPaused(false)}
                onPointerDown={onLeadPointerDown}
                onPointerMove={onLeadPointerMove}
                onPointerUp={(event) => endLeadDrag(event, true)}
                onPointerCancel={(event) => endLeadDrag(event, false)}
                onDragStart={(event) => event.preventDefault()}
              >
                <div className="home-latest-media">
                  {lead.map((item, index) => (
                    <div
                      key={item.id}
                      className={`home-latest-slide${
                        index === leadIndex % leadCount ? ' is-active' : ''
                      }`}
                      aria-hidden={index !== leadIndex % leadCount}
                    >
                      {item.pic && (
                        <img
                          className="home-latest-blur"
                          src={item.pic}
                          alt=""
                          aria-hidden="true"
                          draggable={false}
                          loading={index === 0 ? 'eager' : 'lazy'}
                          decoding="async"
                          referrerPolicy="no-referrer"
                          onError={(event) => {
                            event.currentTarget.style.visibility = 'hidden'
                          }}
                        />
                      )}
                      <HomePicture
                        item={{
                          pic: item.pic,
                          crop: FULL_CROP,
                          customPic: false,
                          title: item.name
                        }}
                        eager={index === 0}
                      />
                    </div>
                  ))}
                  <span className="home-latest-shade" aria-hidden="true" />
                  <span className="home-latest-flag">TOP {leadCount}</span>
                  {leadCount > 1 && (
                    <div className="home-latest-dots">
                      {lead.map((item, index) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`home-latest-dot${
                            index === leadIndex % leadCount ? ' is-active' : ''
                          }`}
                          aria-label={`第 ${index + 1} 部：${item.name}`}
                          aria-current={index === leadIndex % leadCount ? 'true' : undefined}
                          onClick={() => setLeadIndex(index)}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <div className="home-latest-copy" key={activeLead.id}>
                  <p className="home-latest-meta">{leadMeta}</p>
                  <h3 className="home-latest-title" title={activeLead.name}>
                    {activeLead.name}
                  </h3>
                  <p className="home-latest-sub">
                    {activeLead.introExcerpt ||
                      (activeLead.vodActor ? `主演 ${activeLead.vodActor}` : '')}
                  </p>
                </div>
              </article>
            )}

            {rest.map((item) => (
              <VideoCard
                key={item.id}
                videoId={item.id}
                title={item.name}
                pic={item.pic}
                note={item.note}
                intro={item.introExcerpt}
                actors={item.vodActor}
                latestTime={item.latestTime}
              />
            ))}
          </div>

          <div className="home-latest-footer">
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
              <span>{rest.length > 0 ? '已经全部加载' : ''}</span>
            ) : null}
          </div>
        </>
      )}

      <button
        type="button"
        className={`home-backtop${showBackTop ? '' : ' is-hidden'}`}
        aria-label="回到顶部"
        title="回到顶部"
        tabIndex={showBackTop ? 0 : -1}
        onClick={backToTop}
      >
        <ArrowUpOutlined />
      </button>
    </section>
  )
}

/**
 * 推荐页：海报叠层（宽图铺满、右侧露边、循环翻页）+ 按一级分类的推荐轨道，
 * 末尾是按更新时间倒序的整库列表（左上角第一格是最新 5 部的跑马灯）。
 * 暂时不做播放 / 详情页，卡片和海报只展示；分类标题和「全部」跳到视频列表页。
 */
function HomeView({
  onOpenConsole,
  onOpenBrowse
}: {
  onOpenConsole: () => void
  onOpenBrowse: (categoryId: string | null) => void
}): React.JSX.Element {
  const [feed, setFeed] = useState<HomeFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [index, setIndex] = useState(0)
  const [swapping, setSwapping] = useState(false)
  const [paused, setPaused] = useState(false)
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

  // 左右键翻海报：焦点在输入框 / 文本域里时不抢按键
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return
      if (event.key === 'ArrowLeft') go(index - 1)
      if (event.key === 'ArrowRight') go(index + 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [go, index])

  const railSections = useMemo(() => {
    return sections
      .filter((section) => section.visible && section.categoryVisible)
      .map((section) => ({
        section,
        items: section.items.filter((item) => !item.hidden && !item.missing && !item.videoHidden)
      }))
      .filter((entry) => entry.items.length > 0)
  }, [sections])

  const hasContent = posters.length > 0 || railSections.length > 0

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
                  <button
                    type="button"
                    className="home-hero-play"
                    onClick={() =>
                      void window.api.player.open({
                        videoId: current.videoId,
                        title: current.title
                      })
                    }
                  >
                    <CaretRightOutlined />
                    播放
                  </button>
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

          {railSections.map(({ section, items }) => (
            <HomeRail
              key={section.categoryId}
              section={section}
              items={items}
              count={section.total}
              onOpenBrowse={onOpenBrowse}
            />
          ))}

          {/* 最后一条轨道下面按更新时间倒序继续往下翻，第一格是最新 5 部的跑马灯 */}
          {hasContent && <HomeLatest onOpenBrowse={() => onOpenBrowse(null)} />}

          {!hasContent && (
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
