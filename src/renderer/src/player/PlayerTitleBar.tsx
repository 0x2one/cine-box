import { useEffect, useState } from 'react'
import {
  BorderOutlined,
  CloseOutlined,
  CompressOutlined,
  MinusOutlined,
  SyncOutlined
} from '@ant-design/icons'
import logoUrl from '../assets/logo.svg'

const IS_MAC = window.electron?.process?.platform === 'darwin'

interface PlayerTitleBarProps {
  title: string
  /** 当前集数（原始集名或「第 N 集」） */
  episode: string
  /** 集数文案：「共 392 集」「共 58 期」「单集」，空串表示还没读到 */
  countLabel: string
  /**
   * 强制刷新：重新从所有来源站点抓详情、刷新缓存后重渲染。
   * 本机文件播放没有详情，不传就不显示这颗按钮。
   */
  onRefresh?: () => void
  /** 刷新进行中：按钮转圈并禁用，避免重复触发 */
  refreshing?: boolean
}

/**
 * 播放窗自绘标题栏：左上角是片名与当前集数，右侧是详情刷新和窗口按钮。
 * 整条是拖拽区，所有按钮单独退出拖拽，否则点不到。
 *
 * 「强制刷新」做成 30×30 的纯图标按钮（和主窗口标题栏的 下载 / 控制台 / 设置 同一套规格），
 * 并在它和窗口按钮之间插一条分隔线：刷新是维护动作、窗口按钮是系统动作，两者不该连成一片——
 * 以前那颗带文字的胶囊紧贴最小化，误点一下就是窗口被最小化。
 */
function PlayerTitleBar({
  title,
  episode,
  countLabel,
  onRefresh,
  refreshing = false
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
        {countLabel && <span className="player-total">{countLabel}</span>}
      </div>

      <div className="player-titlebar-drag" />

      <div className="player-titlebar-actions">
        {onRefresh && (
          <>
            <button
              type="button"
              className="player-refresh-btn"
              onClick={onRefresh}
              disabled={refreshing}
              title={
                refreshing
                  ? '正在从所有来源重新获取详情…'
                  : '强制刷新详情：重新从所有来源获取详情并刷新缓存'
              }
              aria-label="强制刷新详情"
            >
              <SyncOutlined spin={refreshing} />
            </button>
            {/* 只在右侧真有窗口按钮时才需要这条分隔线（macOS 用系统红绿灯，没有窗口按钮） */}
            {!IS_MAC && <span className="player-titlebar-divider" aria-hidden="true" />}
          </>
        )}

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
