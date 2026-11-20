import { useEffect, useState } from 'react'
import {
  BorderOutlined,
  CloseOutlined,
  CompressOutlined,
  ExpandOutlined,
  LayoutOutlined,
  MinusOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import logoUrl from '../assets/logo.svg'
import type { PlayerLayout } from './player-data'

const IS_MAC = window.electron?.process?.platform === 'darwin'

const LAYOUTS: { value: PlayerLayout; label: string; icon: React.ReactNode }[] = [
  { value: 'standard', label: '标准布局：播放器 + 右侧剧集', icon: <LayoutOutlined /> },
  { value: 'cinema', label: '影院布局：全宽播放，剧集浮层', icon: <ExpandOutlined /> },
  { value: 'below', label: '剧集条：剧集放在播放器下方', icon: <UnorderedListOutlined /> }
]

interface PlayerTitleBarProps {
  title: string
  /** 当前集数（原始集名或「第 N 集」） */
  episode: string
  /** 当前线路的集数总量，0 表示还没读到 */
  total: number
  layout: PlayerLayout
  onLayout: (layout: PlayerLayout) => void
  panelOpen: boolean
  onTogglePanel: () => void
}

/**
 * 播放窗自绘标题栏：左上角是片名与当前集数，右侧是布局切换和窗口按钮。
 * 整条是拖拽区，所有按钮单独退出拖拽，否则点不到。
 */
function PlayerTitleBar({
  title,
  episode,
  total,
  layout,
  onLayout,
  panelOpen,
  onTogglePanel
}: PlayerTitleBarProps): React.JSX.Element {
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
    <header className={`player-titlebar${IS_MAC ? ' is-mac' : ''}`}>
      <img className="player-brand-logo" src={logoUrl} alt="" draggable={false} />
      <div className="player-heading">
        <h1 className="player-title" title={title}>
          {title}
        </h1>
        {episode && <span className="player-episode">{episode}</span>}
        {total > 0 && <span className="player-total">共 {total} 集</span>}
      </div>

      <div className="player-titlebar-drag" />

      <div className="player-titlebar-actions">
        {layout === 'cinema' && (
          <button
            type="button"
            className={`player-text-btn${panelOpen ? ' is-active' : ''}`}
            onClick={onTogglePanel}
            title={panelOpen ? '收起剧集' : '展开剧集'}
            aria-expanded={panelOpen}
          >
            <UnorderedListOutlined />
            <span>选集</span>
          </button>
        )}

        <div className="player-layout-switch" role="group" aria-label="播放布局">
          {LAYOUTS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`player-layout-btn${layout === item.value ? ' is-active' : ''}`}
              title={item.label}
              aria-label={item.label}
              aria-pressed={layout === item.value}
              onClick={() => onLayout(item.value)}
            >
              {item.icon}
            </button>
          ))}
        </div>

        {!IS_MAC && (
          <>
            <span className="player-titlebar-divider" aria-hidden />
            <button
              type="button"
              className="player-win-btn"
              onClick={() => void minimize()}
              title="最小化"
              aria-label="最小化"
            >
              <MinusOutlined />
            </button>
            <button
              type="button"
              className="player-win-btn"
              onClick={() => void maximize()}
              title={maximized ? '向下还原' : '最大化'}
              aria-label={maximized ? '向下还原' : '最大化'}
            >
              {maximized ? <CompressOutlined /> : <BorderOutlined />}
            </button>
            <button
              type="button"
              className="player-win-btn is-close"
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

export default PlayerTitleBar
