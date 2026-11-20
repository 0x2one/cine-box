import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReloadOutlined, VideoCameraOutlined } from '@ant-design/icons'
import { applyAppearance, findAccent } from '../theme/appearance'
import EpisodePanel from './EpisodePanel'
import PlayerInfo from './PlayerInfo'
import PlayerTitleBar from './PlayerTitleBar'
import {
  buildLines,
  episodeTitle,
  lineLabels,
  type PlayerLayout,
  type PlayerLine
} from './player-data'
import { useArtPlayer } from './useArtPlayer'

const LAYOUT_KEY = 'player-layout'
const AUTO_NEXT_KEY = 'player-auto-next'

type Phase = 'loading' | 'ready' | 'error'

function readLayout(): PlayerLayout {
  const stored = localStorage.getItem(LAYOUT_KEY)
  return stored === 'cinema' || stored === 'below' ? stored : 'standard'
}

function readAutoNext(): boolean {
  return localStorage.getItem(AUTO_NEXT_KEY) !== '0'
}

interface PlayerSessionProps {
  payload: PlayerPayload
  layout: PlayerLayout
  onLayout: (layout: PlayerLayout) => void
  /** 当前主题的强调色，ArtPlayer 的进度条 / 控件跟着它走 */
  accent: string
}

/**
 * 一部视频的播放会话：按 videoId 取详情、摊平线路、维护当前集数。
 * 外层按 payload.token 给它换 key，换片时整块重挂载，播放器不会残留上一部的状态。
 */
function PlayerSession({
  payload,
  layout,
  onLayout,
  accent
}: PlayerSessionProps): React.JSX.Element {
  const [detail, setDetail] = useState<VideoDetail | null>(null)
  const [lines, setLines] = useState<PlayerLine[]>([])
  const [lineKey, setLineKey] = useState('')
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('loading')
  const [errorText, setErrorText] = useState('')
  const [errorHint, setErrorHint] = useState('')
  const [playError, setPlayError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const [autoNext, setAutoNext] = useState(readAutoNext)
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    window.api.videos
      .detail(payload.videoId)
      .then((result) => {
        if (!alive) return
        if (!result.ok || !result.video) {
          setPhase('error')
          setErrorText(result.error === 'CACHE_UNAVAILABLE' ? '视频缓存不可用' : '读取视频详情失败')
          setErrorHint('没有详情缓存时会先抓一次，可以重新加载')
          return
        }
        const built = buildLines(result.video.sources)
        setDetail(result.video)
        setLines(built)
        if (built.length === 0) {
          setPhase('error')
          setErrorText('这个视频没有 m3u8 播放源')
          setErrorHint('播放页只接受 HLS（.m3u8）格式，mp4 / flv 线路不会出现在这里')
          return
        }
        const preferred =
          built.find(
            (item) => item.sourceId === payload.sourceId && item.index === payload.lineIndex
          ) ??
          built.find((item) => item.sourceId === payload.sourceId) ??
          built[0]
        setLineKey(preferred.key)
        const target =
          preferred.episodes.find((item) => item.index === payload.episodeIndex) ??
          preferred.episodes[0]
        setEpisodeIndex(preferred.episodes.indexOf(target))
        setPhase('ready')
      })
      .catch(() => {
        if (!alive) return
        setPhase('error')
        setErrorText('读取视频详情失败')
        setErrorHint('检查网络后重新加载')
      })

    return () => {
      alive = false
    }
  }, [payload, reloadToken])

  const line = useMemo(
    () => lines.find((item) => item.key === lineKey) ?? lines[0] ?? null,
    [lines, lineKey]
  )
  const episode = line?.episodes[episodeIndex] ?? line?.episodes[0] ?? null
  const labels = useMemo(() => lineLabels(lines), [lines])
  const lineLabel = line ? (labels.get(line.key) ?? '') : ''

  const title = detail?.name?.trim() || payload.title?.trim() || '正在播放'
  const episodeName = episode
    ? episodeTitle(episode.name, episodeIndex)
    : (payload.episodeName?.trim() ?? '')

  // 任务栏 / 窗口标题跟着片名和集数走
  useEffect(() => {
    document.title = episodeName ? `${title} · ${episodeName} — 映盒剧场` : `${title} — 映盒剧场`
  }, [title, episodeName])

  // 自动连播：只在本线路内往下走，最后一集就停下
  const goNext = useCallback(() => {
    if (!autoNext || !line) return
    if (episodeIndex + 1 < line.episodes.length) setEpisodeIndex(episodeIndex + 1)
  }, [autoNext, line, episodeIndex])

  const { retry } = useArtPlayer({
    containerRef: stageRef,
    // 重试 / 重新加载时旧剧集还在，先别把播放器拆掉，等新数据到了再切
    url: episode?.url,
    poster: detail?.pic,
    accent,
    onEnded: goNext,
    onError: (message) => setPlayError(message)
  })

  const reload = useCallback(() => {
    setPhase('loading')
    setPlayError('')
    setReloadToken((value) => value + 1)
  }, [])

  const selectEpisode = useCallback(
    (index: number) => {
      setPlayError('')
      setEpisodeIndex(index)
      if (layout === 'cinema') setPanelOpen(false)
    },
    [layout]
  )

  const switchLine = useCallback(
    (next: PlayerLine) => {
      setPlayError('')
      const currentOriginal = episode?.index
      const target =
        next.episodes.find((item) => item.index === currentOriginal) ??
        next.episodes[Math.min(episodeIndex, next.episodes.length - 1)]
      setLineKey(next.key)
      setEpisodeIndex(next.episodes.indexOf(target))
    },
    [episode, episodeIndex]
  )

  const toggleAutoNext = useCallback((value: boolean) => {
    setAutoNext(value)
    localStorage.setItem(AUTO_NEXT_KEY, value ? '1' : '0')
  }, [])

  const retryPlayback = useCallback(() => {
    setPlayError('')
    retry()
  }, [retry])

  /** 播放失败时的「换线路」：按当前顺序切到下一条 */
  const nextLine = useMemo(() => {
    if (!line || lines.length < 2) return null
    const index = lines.findIndex((item) => item.key === line.key)
    return lines[(index + 1) % lines.length]
  }, [line, lines])

  const panel = line && (
    <EpisodePanel
      variant={layout === 'below' ? 'strip' : layout === 'cinema' ? 'drawer' : 'sidebar'}
      lines={lines}
      line={line}
      onLine={switchLine}
      episodeIndex={episodeIndex}
      onEpisode={selectEpisode}
      autoNext={autoNext}
      onAutoNext={toggleAutoNext}
      onClose={() => setPanelOpen(false)}
    />
  )

  return (
    <div className={`player-app is-${layout}`}>
      <PlayerTitleBar
        title={title}
        episode={episodeName}
        total={line?.episodes.length ?? 0}
        layout={layout}
        onLayout={onLayout}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((value) => !value)}
      />

      <div className="player-scroll">
        <div
          className={`player-body${layout === 'standard' && phase === 'error' ? ' is-solo' : ''}`}
        >
          <div className="player-main">
            <section className={`player-stage${phase === 'ready' ? ' is-ready' : ''}`}>
              {/* ArtPlayer 的挂载点：尺寸由外层 section 决定 */}
              <div className="player-stage-art" ref={stageRef} />

              {phase === 'loading' && (
                <div className="player-state">
                  <span className="player-spinner" aria-hidden="true" />
                  <p className="player-state-title">正在读取播放源…</p>
                </div>
              )}

              {phase === 'error' && (
                <div className="player-state is-error">
                  <VideoCameraOutlined className="player-state-icon" />
                  <p className="player-state-title">{errorText}</p>
                  {errorHint && <p className="player-state-hint">{errorHint}</p>}
                  <button type="button" className="player-btn" onClick={reload}>
                    <ReloadOutlined />
                    重新加载
                  </button>
                </div>
              )}

              {phase === 'ready' && playError && (
                <div className="player-state is-overlay">
                  <p className="player-state-title">{playError}</p>
                  <div className="player-state-actions">
                    <button type="button" className="player-btn" onClick={retryPlayback}>
                      重试
                    </button>
                    {nextLine && (
                      <button
                        type="button"
                        className="player-btn is-ghost"
                        onClick={() => switchLine(nextLine)}
                      >
                        换线路
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>

            <PlayerInfo
              key={detail?.id ?? 'loading'}
              detail={detail}
              line={line}
              lineLabel={lineLabel}
            />

            {layout === 'below' && panel}
          </div>

          {layout === 'standard' && panel && <aside className="player-side">{panel}</aside>}
        </div>
      </div>

      {layout === 'cinema' && panel && (
        <div className={`player-drawer${panelOpen ? ' is-open' : ''}`}>
          <div
            className="player-drawer-scrim"
            aria-hidden="true"
            onClick={() => setPanelOpen(false)}
          />
          <aside className="player-drawer-panel">{panel}</aside>
        </div>
      )}
    </div>
  )
}

/**
 * 独立播放窗口的页面：先取主进程给的播放载荷，再交给按 token 挂载的会话组件。
 * 主题与强调色跟随主窗口：主窗口每次切换都会推一份外观过来，这里直接换色，不用重开窗口。
 */
function PlayerApp({
  initialAppearance
}: {
  initialAppearance: PlayerAppearance
}): React.JSX.Element {
  const [payload, setPayload] = useState<PlayerPayload | null>(null)
  const [missing, setMissing] = useState(false)
  const [layout, setLayout] = useState<PlayerLayout>(readLayout)
  const [appearance, setAppearance] = useState<PlayerAppearance>(initialAppearance)

  useEffect(() => {
    let alive = true
    void window.api.player.payload().then((value) => {
      if (!alive) return
      if (value) {
        setPayload(value)
      } else {
        setMissing(true)
      }
    })
    const off = window.api.player.onLoad((value) => setPayload(value))
    return () => {
      alive = false
      off()
    }
  }, [])

  // 主窗口切换主题 / 强调色：写 CSS 变量，再更新 ArtPlayer 的主题色
  useEffect(() => {
    return window.api.appearance.onChange((value) => {
      applyAppearance(value.theme, findAccent(value.accent))
      setAppearance(value)
    })
  }, [])

  const changeLayout = useCallback((next: PlayerLayout) => {
    setLayout(next)
    localStorage.setItem(LAYOUT_KEY, next)
  }, [])

  const accent = findAccent(appearance.accent)[appearance.theme]

  if (!payload) {
    return (
      <div className={`player-app is-${layout}`}>
        <PlayerTitleBar
          title={missing ? '无法播放' : '正在准备播放'}
          episode=""
          total={0}
          layout={layout}
          onLayout={changeLayout}
          panelOpen={false}
          onTogglePanel={() => {}}
        />
        <div className="player-scroll">
          <div className="player-body">
            <div className="player-main">
              <section className="player-stage">
                <div className="player-state is-error">
                  <VideoCameraOutlined className="player-state-icon" />
                  <p className="player-state-title">
                    {missing ? '没有收到播放信息' : '正在读取播放信息…'}
                  </p>
                  {missing && <p className="player-state-hint">回到视频详情，重新点一集试试</p>}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <PlayerSession
      key={payload.token}
      payload={payload}
      layout={layout}
      onLayout={changeLayout}
      accent={accent}
    />
  )
}

export default PlayerApp
