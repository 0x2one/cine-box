import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LeftOutlined, ReloadOutlined, RightOutlined, VideoCameraOutlined } from '@ant-design/icons'
import { applyPlayerAppearance, findAccent } from '../theme/appearance'
import PlayerPanel, { type PlayerPanelTab } from './PlayerPanel'
import PlayerTitleBar from './PlayerTitleBar'
import { buildLines, episodeTitle, lineLabels, type PlayerLine } from './player-data'
import { useArtPlayer } from './useArtPlayer'

const AUTO_NEXT_KEY = 'player-auto-next'
const PANEL_OPEN_KEY = 'player-panel-open'
const PANEL_TAB_KEY = 'player-panel-tab'
/** 三档布局时代的旧键，已经不用了，启动时顺手清掉 */
const LEGACY_LAYOUT_KEY = 'player-layout'

type Phase = 'loading' | 'ready' | 'error'

function readAutoNext(): boolean {
  return localStorage.getItem(AUTO_NEXT_KEY) !== '0'
}

function readPanelOpen(): boolean {
  return localStorage.getItem(PANEL_OPEN_KEY) !== '0'
}

function readPanelTab(): PlayerPanelTab {
  return localStorage.getItem(PANEL_TAB_KEY) === 'info' ? 'info' : 'episodes'
}

interface PlayerSessionProps {
  payload: PlayerPayload
  /** 当前主题的强调色，ArtPlayer 的进度条 / 控件跟着它走 */
  accent: string
  panelOpen: boolean
  panelTab: PlayerPanelTab
  /**
   * 播放器控制条里的「选集」：开 / 关面板（收起或在「简介」时打开并切到剧集）。
   * 参数是从全屏退出来的：全屏时面板看不见，那一下只开不关。
   */
  onEpisodes: (fromFullscreen: boolean) => void
  /** 右缘中部按钮与面板头部关闭：只做开合，保留当前 tab */
  onTogglePanel: () => void
  onPanelTab: (tab: PlayerPanelTab) => void
}

/**
 * 一部视频的播放会话：按 videoId 取详情、摊平线路、维护当前集数。
 * 外层按 payload.token 给它换 key，换片时整块重挂载，播放器不会残留上一部的状态。
 * 面板的开合状态放在外层，换片不会把用户收起的面板重新弹出来。
 */
function PlayerSession({
  payload,
  accent,
  panelOpen,
  panelTab,
  onEpisodes,
  onTogglePanel,
  onPanelTab
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
    onError: (message) => setPlayError(message),
    onEpisodes
  })

  const reload = useCallback(() => {
    setPhase('loading')
    setPlayError('')
    setReloadToken((value) => value + 1)
  }, [])

  const selectEpisode = useCallback((index: number) => {
    setPlayError('')
    setEpisodeIndex(index)
  }, [])

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

  return (
    <div className="player-app">
      <PlayerTitleBar title={title} episode={episodeName} total={line?.episodes.length ?? 0} />

      <div className={`player-body${line && panelOpen ? ' has-panel' : ''}`}>
        <section className="player-stage">
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

        {line && panelOpen && (
          <PlayerPanel
            tab={panelTab}
            onTab={onPanelTab}
            onClose={onTogglePanel}
            lines={lines}
            line={line}
            onLine={switchLine}
            episodeIndex={episodeIndex}
            onEpisode={selectEpisode}
            autoNext={autoNext}
            onAutoNext={toggleAutoNext}
            detail={detail}
            lineLabel={lineLabel}
          />
        )}

        {line && (
          <button
            type="button"
            className="player-panel-toggle"
            onClick={onTogglePanel}
            title={panelOpen ? '收起侧边面板' : '展开侧边面板'}
            aria-label={panelOpen ? '收起侧边面板' : '展开侧边面板'}
            aria-expanded={panelOpen}
          >
            {panelOpen ? <LeftOutlined /> : <RightOutlined />}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 独立播放窗口的页面：先取主进程给的播放载荷，再交给按 token 挂载的会话组件。
 * 播放页固定深色，只跟随主窗口的强调色；面板开合状态放在这一层，换片不会重置。
 */
function PlayerApp({ initialAccent }: { initialAccent: string }): React.JSX.Element {
  const [payload, setPayload] = useState<PlayerPayload | null>(null)
  const [missing, setMissing] = useState(false)
  const [accentKey, setAccentKey] = useState(initialAccent)
  const [panelOpen, setPanelOpen] = useState(readPanelOpen)
  const [panelTab, setPanelTab] = useState<PlayerPanelTab>(readPanelTab)

  // 旧的三档布局已经删掉，清掉遗留的本地配置
  useEffect(() => {
    localStorage.removeItem(LEGACY_LAYOUT_KEY)
  }, [])

  useEffect(() => {
    localStorage.setItem(PANEL_OPEN_KEY, panelOpen ? '1' : '0')
  }, [panelOpen])

  useEffect(() => {
    localStorage.setItem(PANEL_TAB_KEY, panelTab)
  }, [panelTab])

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

  // 主窗口切换强调色：播放页固定深色，只换强调色变量，再更新 ArtPlayer 的主题色
  useEffect(() => {
    return window.api.appearance.onChange((value) => {
      applyPlayerAppearance(findAccent(value.accent))
      setAccentKey(value.accent)
    })
  }, [])

  // 控制条里的「选集」是开关：收起或在「简介」tab 时打开并切到剧集，
  // 已经停在剧集时再点一下收起；但从全屏退出来那一次只能算「打开」——
  // 全屏下面板在播放器外面根本看不见，当成收起就会出现「退出全屏后没有侧栏」
  const toggleEpisodes = useCallback(
    (fromFullscreen = false) => {
      if (!fromFullscreen && panelOpen && panelTab === 'episodes') {
        setPanelOpen(false)
        return
      }
      setPanelTab('episodes')
      setPanelOpen(true)
    },
    [panelOpen, panelTab]
  )

  // 右缘中部按钮与面板头部关闭：只做开合，保留当前 tab
  const togglePanel = useCallback(() => {
    setPanelOpen((value) => !value)
  }, [])

  const changePanelTab = useCallback((tab: PlayerPanelTab) => setPanelTab(tab), [])

  const accent = findAccent(accentKey).dark

  if (!payload) {
    return (
      <div className="player-app">
        <PlayerTitleBar title={missing ? '无法播放' : '正在准备播放'} episode="" total={0} />
        <div className="player-body">
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
    )
  }

  return (
    <PlayerSession
      key={payload.token}
      payload={payload}
      accent={accent}
      panelOpen={panelOpen}
      panelTab={panelTab}
      onEpisodes={toggleEpisodes}
      onTogglePanel={togglePanel}
      onPanelTab={changePanelTab}
    />
  )
}

export default PlayerApp
