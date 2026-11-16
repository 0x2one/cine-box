import { useEffect, useState } from 'react'
import {
  BorderOutlined,
  CloseOutlined,
  CompressOutlined,
  MinusOutlined,
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
 * 自绘窗口操作栏：左侧 Logo + 标题，右侧 设置 / 最小化 / 最大化 / 关闭。
 * 「关于」不再放在操作栏，由设置页的「关于」分区承载。
 * macOS 保留原生红绿灯，因此不再重复绘制窗口按钮。
 */
function TitleBar({ view, onNavigate }: TitleBarProps): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

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

  const { minimize, maximize, close } = window.api.windowControls

  return (
    <header className={`titlebar${IS_MAC ? ' titlebar--mac' : ''}`}>
      <button
        type="button"
        className="titlebar-brand"
        onClick={() => onNavigate('home')}
        title="返回首页"
      >
        <img className="titlebar-logo" src={logoUrl} alt="" draggable={false} />
        <span className="titlebar-name">映盒剧场</span>
      </button>

      {/* 拖拽区：双击最大化由主进程的窗口消息处理（拖拽区不会派发 DOM 双击事件） */}
      <div className="titlebar-drag" />

      <div className="titlebar-actions">
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
