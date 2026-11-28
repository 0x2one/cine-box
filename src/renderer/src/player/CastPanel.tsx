import { useEffect } from 'react'
import {
  CloseOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  WarningOutlined,
  WifiOutlined
} from '@ant-design/icons'

export interface CastPanelProps {
  devices: CastDevice[]
  loading: boolean
  error: string
  onRefresh: () => void
  onClose: () => void
  onStart: (device: CastDevice) => void
}

/**
 * 设备选择浮层：从播放器右下角弹起，和 `.episode-popover` 同一套视觉语言。
 * 点面板外面或按 Esc 关闭；播放器控制条被一层透明遮罩挡住，避免点「投屏」时
 * 先触发关闭、再触发一次打开。
 */
export function CastPanel({
  devices,
  loading,
  error,
  onRefresh,
  onClose,
  onStart
}: CastPanelProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <>
      <div className="cast-backdrop" aria-hidden="true" onPointerDown={onClose} />
      <div className="cast-panel" role="dialog" aria-label="投屏设备">
        <div className="cast-panel-head">
          <span className="cast-panel-title">投屏到</span>
          <div className="cast-panel-actions">
            <button
              type="button"
              className="cast-icon-btn"
              title="刷新设备"
              aria-label="刷新设备"
              onClick={onRefresh}
              disabled={loading}
            >
              <ReloadOutlined spin={loading} />
            </button>
            <button
              type="button"
              className="cast-icon-btn"
              title="关闭"
              aria-label="关闭"
              onClick={onClose}
            >
              <CloseOutlined />
            </button>
          </div>
        </div>

        {error && (
          <div className="cast-error" role="alert">
            <WarningOutlined />
            <span>{error}</span>
          </div>
        )}

        {loading && devices.length === 0 ? (
          <div className="cast-empty">正在搜索局域网里的电视…</div>
        ) : devices.length === 0 ? (
          <div className="cast-empty">
            没发现可投屏的设备。
            <br />
            确认电视和电脑连同一个 Wi-Fi、电视已打开投屏 / 多屏互动；
            <br />
            首次投屏如果弹出防火墙提示，请允许「专用网络」。
          </div>
        ) : (
          <div className="cast-list">
            {devices.map((device) => (
              <button
                key={device.id}
                type="button"
                className="cast-device"
                onClick={() => onStart(device)}
                disabled={loading}
              >
                <span className="cast-device-name">{device.name}</span>
                <span className="cast-device-meta">
                  {[device.model, device.manufacturer].filter(Boolean).join(' · ') || '局域网设备'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="cast-hint">在线集由电脑代理后投给电视，投屏期间电脑需要保持运行。</div>
      </div>
    </>
  )
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

function statusText(state: CastState): string {
  if (state.status === 'starting') return '正在连接电视…'
  if (state.status === 'playing') return '电视正在播放'
  if (state.status === 'paused') return '已暂停'
  return state.error ?? '投屏异常'
}

export interface CastStageProps {
  state: CastState
  onPause: () => void
  onResume: () => void
  onStop: () => void
}

/**
 * 投屏中的状态卡：盖住本地视频（本地已暂停），只保留暂停 / 继续 / 停止，
 * 避免用户在电脑上点播放导致两边同时出声。
 */
export function CastStage({ state, onPause, onResume, onStop }: CastStageProps): React.JSX.Element {
  return (
    <div className={`cast-stage is-${state.status}`} role="status">
      <div className="cast-stage-card">
        <span className="cast-stage-icon" aria-hidden="true">
          <WifiOutlined />
        </span>
        <p className="cast-stage-title">正在投屏到 {state.deviceName ?? '电视'}</p>
        <p className="cast-stage-sub">
          {[state.title, state.episodeName].filter(Boolean).join(' · ') || '映盒剧场'}
        </p>
        <p className="cast-stage-state">{statusText(state)}</p>
        {state.duration > 0 && (
          <p className="cast-stage-time">
            {formatTime(state.position)} / {formatTime(state.duration)}
          </p>
        )}
        {state.error && (
          <p className="cast-stage-error">
            <WarningOutlined />
            <span>{state.error}</span>
          </p>
        )}
        <div className="cast-stage-actions">
          {state.status === 'paused' ? (
            <button type="button" className="player-btn" onClick={onResume}>
              <PlayCircleOutlined />
              继续
            </button>
          ) : (
            <button
              type="button"
              className="player-btn"
              onClick={onPause}
              disabled={state.status === 'starting'}
            >
              <PauseCircleOutlined />
              暂停
            </button>
          )}
          <button type="button" className="player-btn is-ghost" onClick={onStop}>
            <StopOutlined />
            停止投屏
          </button>
        </div>
      </div>
    </div>
  )
}
