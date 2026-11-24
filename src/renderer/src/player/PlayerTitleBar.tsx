import { useEffect, useState } from 'react'
import { BorderOutlined, CloseOutlined, CompressOutlined, MinusOutlined } from '@ant-design/icons'
import logoUrl from '../assets/logo.svg'

const IS_MAC = window.electron?.process?.platform === 'darwin'

interface PlayerTitleBarProps {
  title: string
  /** 当前集数（原始集名或「第 N 集」） */
  episode: string
  /** 集数文案：「共 392 集」「共 58 期」「单集」，空串表示还没读到 */
  countLabel: string
}

/**
 * 播放窗自绘标题栏：左上角是片名与当前集数，右侧只有窗口按钮。
 * 整条是拖拽区，所有按钮单独退出拖拽，否则点不到。
 */
function PlayerTitleBar({ title, episode, countLabel }: PlayerTitleBarProps): React.JSX.Element {
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
        {countLabel && <span className="player-total">{countLabel}</span>}
      </div>

      <div className="player-titlebar-drag" />

      <div className="player-titlebar-actions">
        {!IS_MAC && (
          <>
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
