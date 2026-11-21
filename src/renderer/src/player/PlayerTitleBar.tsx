import { useEffect, useState } from 'react'
import {
  BorderOutlined,
  CloseOutlined,
  CompressOutlined,
  MinusOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import logoUrl from '../assets/logo.svg'

const IS_MAC = window.electron?.process?.platform === 'darwin'

interface PlayerTitleBarProps {
  title: string
  /** 当前集数（原始集名或「第 N 集」） */
  episode: string
  /** 当前线路的集数总量，0 表示还没读到 */
  total: number
  /** 右侧剧集 / 简介面板是否展开 */
  panelOpen: boolean
  /** 面板正停在剧集 tab */
  episodesActive: boolean
  onEpisodes: () => void
}

/**
 * 播放窗自绘标题栏：左上角是片名与当前集数，右侧是「选集」入口和窗口按钮。
 * 整条是拖拽区，所有按钮单独退出拖拽，否则点不到。
 */
function PlayerTitleBar({
  title,
  episode,
  total,
  panelOpen,
  episodesActive,
  onEpisodes
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
        <button
          type="button"
          className={`player-text-btn${episodesActive ? ' is-active' : ''}`}
          onClick={onEpisodes}
          title="打开剧集 / 简介面板"
          aria-label="打开剧集 / 简介面板"
          aria-pressed={episodesActive}
          aria-expanded={panelOpen}
          disabled={total === 0}
        >
          <UnorderedListOutlined />
          <span>选集</span>
        </button>

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
