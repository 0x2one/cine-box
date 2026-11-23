import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AppstoreOutlined,
  BorderOutlined,
  CloseOutlined,
  CompassOutlined,
  CompressOutlined,
  FireOutlined,
  MinusOutlined,
  SearchOutlined,
  SettingOutlined
} from '@ant-design/icons'
import logoUrl from '../assets/logo.svg'
import type { AppView } from '../types'

const IS_MAC = window.electron?.process?.platform === 'darwin'

interface TitleBarProps {
  view: AppView
  onNavigate: (view: AppView) => void
}

/**
 * 自绘窗口操作栏：左侧 Logo + 标题，右侧 控制台 / 设置 / 最小化 / 最大化 / 关闭。
 * 「关于」不再放在操作栏，由设置页的「关于」分区承载。
 * macOS 保留原生红绿灯，因此不再重复绘制窗口按钮。
 */
function TitleBar({ view, onNavigate }: TitleBarProps): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  /** 首帧量的位置不要过渡，避免导航胶囊从 0 宽度展开 */
  const [pillLive, setPillLive] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const homeRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLButtonElement>(null)
  const browseRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    void window.api.windowControls.isMaximized().then((value) => {
      if (alive) setMaximized(value)
    })
    const off = window.api.windowControls.onMaximizeChange(setMaximized)
    return () => {
      alive = false
      off()
    }
  }, [])

  /**
   * 导航胶囊：量当前 tab 的位置 / 宽度，直接写内联样式。
   * 用 DOM 写入而不是 state，切换时只有胶囊自己重新布局，不带着整条导航栏重渲染。
   */
  const placePill = useCallback((): void => {
    const nav = navRef.current
    const pill = pillRef.current
    if (!nav || !pill) return
    const target =
      view === 'home'
        ? homeRef.current
        : view === 'browse'
          ? browseRef.current
          : view === 'search'
            ? searchRef.current
            : null
    if (!target) {
      pill.style.opacity = '0'
      return
    }
    pill.style.opacity = '1'
    pill.style.width = `${target.offsetWidth}px`
    pill.style.transform = `translate3d(${target.offsetLeft}px, 0, 0)`
  }, [view])

  useLayoutEffect(() => {
    placePill()
  }, [placePill])

  useEffect(() => {
    // 字体 / 缩放变化会改变按钮宽度，重新量一次
    const nav = navRef.current
    if (!nav) return
    const observer = new ResizeObserver(() => placePill())
    observer.observe(nav)
    for (const element of [homeRef.current, searchRef.current, browseRef.current]) {
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [placePill])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPillLive(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const { minimize, maximize, close } = window.api.windowControls

  return (
    <header className={`titlebar${IS_MAC ? ' titlebar--mac' : ''}`}>
      <button
        type="button"
        className="titlebar-brand"
        onClick={() => onNavigate('home')}
        title="返回推荐页"
      >
        <img className="titlebar-logo" src={logoUrl} alt="" draggable={false} />
        <span className="titlebar-name">映盒剧场</span>
      </button>

      {/* 拖拽区：双击最大化由主进程的窗口消息处理（拖拽区不会派发 DOM 双击事件） */}
      <div className="titlebar-drag" />

      {/* 展示端导航：居中的两段式胶囊，找片看 = 视频列表页 */}
      <nav className="titlebar-nav" aria-label="展示端导航" ref={navRef}>
        {/* 激活态的滑动胶囊：切换 tab 时在三个入口之间流动 */}
        <span
          className={`titlebar-nav-pill${pillLive ? ' is-live' : ''}`}
          ref={pillRef}
          aria-hidden="true"
        />
        <button
          ref={homeRef}
          type="button"
          className={`titlebar-nav-btn${view === 'home' ? ' is-active' : ''}`}
          aria-current={view === 'home' ? 'page' : undefined}
          onClick={() => onNavigate('home')}
        >
          <FireOutlined className="titlebar-nav-icon" />
          推荐
        </button>
        {/* 长得像输入框的搜索按钮：点开搜索页，真正的搜索框在页面里 */}
        <button
          ref={searchRef}
          type="button"
          className={`titlebar-search${view === 'search' ? ' is-active' : ''}`}
          aria-current={view === 'search' ? 'page' : undefined}
          title="搜索视频"
          onClick={() => onNavigate('search')}
        >
          <span className="titlebar-search-text">搜索视频</span>
          <SearchOutlined />
        </button>
        <button
          ref={browseRef}
          type="button"
          className={`titlebar-nav-btn${view === 'browse' ? ' is-active' : ''}`}
          aria-current={view === 'browse' ? 'page' : undefined}
          onClick={() => onNavigate('browse')}
        >
          <CompassOutlined className="titlebar-nav-icon" />
          找片看
        </button>
      </nav>

      <div className="titlebar-actions">
        <button
          type="button"
          className={`titlebar-action${view === 'console' ? ' is-active' : ''}`}
          onClick={() => onNavigate('console')}
          title="控制台"
          aria-label="控制台"
        >
          <AppstoreOutlined />
        </button>

        <button
          type="button"
          className={`titlebar-action${view === 'settings' ? ' is-active' : ''}`}
          onClick={() => onNavigate('settings')}
          title="设置"
          aria-label="设置"
        >
          <SettingOutlined />
        </button>

        {!IS_MAC && (
          <>
            <span className="titlebar-divider" aria-hidden />
            <button
              type="button"
              className="window-btn"
              onClick={() => void minimize()}
              title="最小化"
              aria-label="最小化"
            >
              <MinusOutlined />
            </button>
            <button
              type="button"
              className="window-btn"
              onClick={() => void maximize()}
              title={maximized ? '向下还原' : '最大化'}
              aria-label={maximized ? '向下还原' : '最大化'}
            >
              {maximized ? <CompressOutlined /> : <BorderOutlined />}
            </button>
            <button
              type="button"
              className="window-btn window-btn--close"
              onClick={() => void close()}
              title="关闭"
              aria-label="关闭"
            >
              <CloseOutlined />
            </button>
          </>
        )}
      </div>
    </header>
  )
}

export default TitleBar
