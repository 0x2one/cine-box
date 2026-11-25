import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LeftOutlined, ReloadOutlined, RightOutlined, VideoCameraOutlined } from '@ant-design/icons'
import { applyPlayerAppearance, findAccent } from '../theme/appearance'
import { formatBytes } from '../utils/format'
import PlayerPanel, { type PlayerPanelTab } from './PlayerPanel'
import PlayerTitleBar from './PlayerTitleBar'
import {
  analyzeNaming,
  buildLines,
  episodeCountLabel,
  episodeTitle,
  firstEpisodeIndex,
  groupBySource,
  lineName,
  readEpisodeOrder,
  type PlayerLine
} from './player-data'
import { useArtPlayer } from './useArtPlayer'

const AUTO_NEXT_KEY = 'player-auto-next'
const PANEL_OPEN_KEY = 'player-panel-open'
const PANEL_TAB_KEY = 'player-panel-tab'
/** 三档布局时代的旧键，已经不用了，启动时顺手清掉 */
const LEGACY_LAYOUT_KEY = 'player-layout'

type Phase = 'loading' | 'ready' | 'error'

/** 播放页上一条缓存记录（由 downloads:cachedEpisodes 拿到的精简形状） */
interface CachedEpisodeEntry {
  recordId: string
  status: DownloadStatus
  progress: number
  /** 当前下载速度（字节 / 秒） */
  speed: number
}

type CacheTone = 'done' | 'active' | 'paused' | 'failed'

/**
 * 当前这一集的播放源：选集 / 切线路时先落一次；之后只有「本集缓存刚下完」
 * 会把它从在线改成本机（见下面的提升逻辑），别的集下完不动。
 */
interface PlaybackDecision {
  /** `${sourceId}:${lineIndex}:${episodeIndex}` */
  key: string
  mode: 'cache' | 'remote'
  recordId?: string
}

function cacheKey(sourceId: number, lineIndex: number, episodeIndex: number): string {
  return `${sourceId}:${lineIndex}:${episodeIndex}`
}

function cacheTone(status: DownloadStatus): CacheTone {
  if (status === 'done') return 'done'
  if (status === 'paused') return 'paused'
  if (status === 'failed' || status === 'canceled') return 'failed'
  return 'active'
}

function isCacheActive(status: DownloadStatus): boolean {
  return status === 'waiting' || status === 'downloading' || status === 'paused'
}

function cacheErrorText(error?: string): string {
  if (error === 'CACHE_UNAVAILABLE') return '视频缓存库不可用'
  if (error === 'NOT_FOUND') return '视频信息已失效，请重新打开'
  if (error === 'NO_EPISODE') return '找不到这一集，换条线路试试'
  if (error === 'NOT_M3U8') return '这条线路不是 m3u8，暂不支持缓存'
  if (error === 'NOT_WRITABLE') return '写入下载目录失败，检查设置里的保存位置'
  return '加入缓存队列失败'
}

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
  /** 库里的视频 id（本机文件不走这里） */
  videoId: number
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
 *
 * 离线缓存：
 * - 详情加载的同时取该视频的缓存集；两者都就绪后才决定每一集播本机还是在线。
 * - 选集 / 切线路时按「优先缓存」落一次决策；本集还在缓存时，等它下完再按当前进度
 *   原地切到本机播放（别的集下完不动），切不过去就继续在线播。
 * - 当前集的缓存状态走右上角 chip；剧集面板按状态标记并支持多选批量入队。
 */
function PlayerSession({
  payload,
  videoId,
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
  const [cacheEntries, setCacheEntries] = useState<Map<string, CachedEpisodeEntry>>(new Map())
  const [cacheReady, setCacheReady] = useState(false)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [decision, setDecision] = useState<PlaybackDecision>({ key: '', mode: 'remote' })
  const [localUrl, setLocalUrl] = useState<{
    key: string
    recordId: string
    url: string
  } | null>(null)
  const [cacheBroken, setCacheBroken] = useState<Set<string>>(new Set())
  const stageRef = useRef<HTMLDivElement>(null)
  const decisionRef = useRef<PlaybackDecision>({ key: '', mode: 'remote' })
  /** 已经试过「本集下完就切本地」的记录 id：一条只试一次，失败也不反复折腾 */
  const promoteTriedRef = useRef<Set<string>>(new Set())
  const noticeRef = useRef<(text: string) => void>(() => {})
  const cacheCurrentRef = useRef<() => void>(() => {})

  useEffect(() => {
    let alive = true
    window.api.videos
      .detail(videoId)
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
        // 没指定具体集数时按集数排序播第一格：倒序 = 最新一集，正序 = 第 1 集。
        // 集名日期乱序的线路交给解析结果挑真正最晚的那集，别信列表顺序
        const preferredCategory =
          result.video.sources.find((item) => item.id === preferred.sourceId)?.categoryName ?? ''
        const preferredNaming = analyzeNaming(
          preferred.episodes.map((item) => item.name),
          preferredCategory
        )
        const fallbackIndex = firstEpisodeIndex(
          preferred.episodes,
          readEpisodeOrder(),
          preferredNaming
        )
        const specified =
          typeof payload.episodeIndex === 'number'
            ? preferred.episodes.find((item) => item.index === payload.episodeIndex)
            : undefined
        setEpisodeIndex(specified ? preferred.episodes.indexOf(specified) : fallbackIndex)
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
  }, [videoId, payload, reloadToken])

  // 缓存集：进入播放页拉一次，之后结构变化重拉、进度事件就地打补丁
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.downloads.cachedEpisodes(videoId)
        if (!alive || !result.ok) return
        const map = new Map<string, CachedEpisodeEntry>()
        for (const item of result.items) {
          map.set(cacheKey(item.sourceId, item.lineIndex, item.episodeIndex), {
            recordId: item.recordId,
            status: item.status,
            progress: item.progress,
            speed: item.speed
          })
        }
        setCacheEntries(map)
      } catch {
        // 缓存库不可用时按「没有缓存」处理，不影响在线播放
      } finally {
        if (alive) setCacheReady(true)
      }
    }
    void load()
    const offChanged = window.api.downloads.onChange(() => {
      if (alive) void load()
    })
    const offProgress = window.api.downloads.onProgress((record) => {
      if (!alive || record.videoId !== videoId) return
      const { sourceId, lineIndex, episodeIndex: episode } = record
      if (
        typeof sourceId !== 'number' ||
        typeof lineIndex !== 'number' ||
        typeof episode !== 'number'
      ) {
        return
      }
      setCacheEntries((prev) => {
        const next = new Map(prev)
        next.set(cacheKey(sourceId, lineIndex, episode), {
          recordId: record.id,
          status: record.status,
          progress: record.progress,
          speed: record.speed
        })
        return next
      })
      // 重新缓存成功：把这个 id 的「缓存文件缺失」标记摘掉
      if (record.status === 'done') {
        setCacheBroken((prev) => {
          if (!prev.has(record.id)) return prev
          const next = new Set(prev)
          next.delete(record.id)
          return next
        })
      }
    })
    return () => {
      alive = false
      offChanged()
      offProgress()
    }
  }, [videoId])

  const line = useMemo(
    () => lines.find((item) => item.key === lineKey) ?? lines[0] ?? null,
    [lines, lineKey]
  )
  const episode = line?.episodes[episodeIndex] ?? line?.episodes[0] ?? null
  const groups = useMemo(() => groupBySource(lines), [lines])
  const lineLabel = line ? lineName(line, groups) : ''

  // 集名风格跟着「当前线路所属来源」的分类走：综艺按「期」、电影是「国语 / 正片」这类版本名
  const category = useMemo(
    () => detail?.sources.find((item) => item.id === line?.sourceId)?.categoryName ?? '',
    [detail, line?.sourceId]
  )
  const naming = useMemo(
    () => analyzeNaming(line?.episodes.map((episode) => episode.name) ?? [], category),
    [line?.episodes, category]
  )
  const countLabel = episodeCountLabel(naming, line?.episodes.length ?? 0)

  const title = detail?.name?.trim() || payload.title?.trim() || '正在播放'
  const episodeName = episode
    ? episodeTitle(episode.name, episodeIndex)
    : (payload.episodeName?.trim() ?? '')

  const episodeKey = line && episode ? cacheKey(line.sourceId, line.index, episode.index) : ''
  const currentCache = episodeKey ? cacheEntries.get(episodeKey) : undefined

  /**
   * 优先缓存：换集 / 换线路那一刻落一次决策。
   * 这里只定「起点」——该集已经缓存好就直接播本机，否则先在线；
   * 正在缓存的那集下完之后要不要切源，交给下面的提升 effect，不会在别的集下完时乱切。
   */
  useLayoutEffect(() => {
    if (!episodeKey || !cacheReady) return
    if (decisionRef.current.key === episodeKey) return
    const entry = cacheEntries.get(episodeKey)
    const next: PlaybackDecision =
      entry?.status === 'done'
        ? { key: episodeKey, mode: 'cache', recordId: entry.recordId }
        : { key: episodeKey, mode: 'remote' }
    decisionRef.current = next
    setDecision(next)
  }, [episodeKey, cacheReady, cacheEntries])

  // 决策为缓存时取本机地址；取不到就标缺失并回退在线地址
  useEffect(() => {
    if (decision.mode === 'remote') return
    const recordId = decision.recordId
    const key = decision.key
    if (!recordId) return
    // 刚从在线切过来的那次已经在切之前取好了，不重复请求
    if (localUrl?.key === key && localUrl.recordId === recordId) return
    let alive = true
    const fallback = (): void => {
      setCacheBroken((prev) => {
        const next = new Set(prev)
        next.add(recordId)
        return next
      })
      const remote: PlaybackDecision = { key, mode: 'remote' }
      decisionRef.current = remote
      setDecision(remote)
    }
    window.api.downloads
      .playbackUrl(recordId)
      .then((result) => {
        if (!alive) return
        if (result.ok && result.url) {
          setLocalUrl({ key, recordId, url: result.url })
          return
        }
        fallback()
      })
      .catch(() => {
        if (alive) fallback()
      })
    return () => {
      alive = false
    }
  }, [decision, localUrl])

  /** 已经取到、且确实属于当前决策那一集（记录 id 也对得上）的缓存地址 */
  const resolvedLocalUrl =
    localUrl && localUrl.key === episodeKey && localUrl.recordId === decision.recordId
      ? localUrl.url
      : undefined
  const usingCache = decision.mode === 'cache' && Boolean(resolvedLocalUrl)
  let playUrl: string | undefined
  if (!episode || decision.key !== episodeKey) {
    playUrl = undefined
  } else if (decision.mode === 'remote') {
    playUrl = episode.url
  } else {
    playUrl = resolvedLocalUrl
  }
  const preparing = phase === 'ready' && !playUrl && !playError

  const cacheChip = useMemo(() => {
    if (!currentCache) return null
    if (cacheBroken.has(currentCache.recordId)) {
      return { tone: 'failed' as CacheTone, text: '缓存文件缺失' }
    }
    if (currentCache.status === 'done') {
      return { tone: 'done' as CacheTone, text: usingCache ? '已缓存 · 本地播放' : '已缓存' }
    }
    if (currentCache.status === 'paused') {
      return {
        tone: 'paused' as CacheTone,
        text: `已暂停 ${Math.round(currentCache.progress)}%`
      }
    }
    if (currentCache.status === 'failed' || currentCache.status === 'canceled') {
      return { tone: 'failed' as CacheTone, text: '缓存失败' }
    }
    const speed = currentCache.speed > 0 ? ` · ↓ ${formatBytes(currentCache.speed)}/s` : ''
    return {
      tone: 'active' as CacheTone,
      text: `正在缓存 ${Math.round(currentCache.progress)}%${speed}`
    }
  }, [currentCache, cacheBroken, usingCache])

  const lineCacheStates = useMemo(() => {
    const map = new Map<number, CacheTone>()
    if (!line) return map
    for (const item of line.episodes) {
      const entry = cacheEntries.get(cacheKey(line.sourceId, line.index, item.index))
      if (entry) map.set(item.index, cacheTone(entry.status))
    }
    return map
  }, [line, cacheEntries])

  // 任务详情 / 窗口标题跟着片名和集数走
  useEffect(() => {
    document.title = episodeName ? `${title} · ${episodeName} — 映盒剧场` : `${title} — 映盒剧场`
  }, [title, episodeName])

  // 自动连播：只在本线路内往下走，最后一集就停下
  const goNext = useCallback(() => {
    if (!autoNext || !line) return
    if (episodeIndex + 1 < line.episodes.length) setEpisodeIndex(episodeIndex + 1)
  }, [autoNext, line, episodeIndex])

  /** 缓存若干集（当前集 / 多选批量都走这里） */
  const cacheEpisodes = useCallback(
    (indexes: number[]): void => {
      if (!line || indexes.length === 0) return
      setCacheBusy(true)
      window.api.downloads
        .cache({
          videoId,
          sourceId: line.sourceId,
          lineIndex: line.index,
          episodeIndexes: indexes
        })
        .then((result) => {
          if (!result.ok) {
            noticeRef.current(cacheErrorText(result.error))
            return
          }
          const parts: string[] = []
          if (result.queued) parts.push(`已加入 ${result.queued} 集`)
          if (result.restarted) parts.push(`重新缓存 ${result.restarted} 集`)
          if (result.existing) parts.push(`跳过 ${result.existing} 集已缓存`)
          noticeRef.current(parts.length > 0 ? parts.join('，') : '这些集已经在缓存中')
        })
        .catch(() => noticeRef.current('加入缓存队列失败'))
        .finally(() => setCacheBusy(false))
    },
    [line, videoId]
  )

  const cacheCurrent = useCallback((): void => {
    if (!episode) return
    const entry = episodeKey ? cacheEntries.get(episodeKey) : undefined
    if (entry?.status === 'done' && !cacheBroken.has(entry.recordId)) {
      noticeRef.current('本集已缓存，可在下载中心播放')
      return
    }
    if (entry?.status === 'paused') {
      void window.api.downloads
        .resume(entry.recordId)
        .then((result) => noticeRef.current(result.ok ? '已继续缓存' : '继续缓存失败'))
        .catch(() => noticeRef.current('继续缓存失败'))
      return
    }
    if (entry && isCacheActive(entry.status)) {
      noticeRef.current(`本集正在缓存中（${Math.round(entry.progress)}%）`)
      return
    }
    // 失败 / 已取消 / 缓存文件缺失：重新入队（后端会重开同一条记录）
    cacheEpisodes([episode.index])
  }, [episode, episodeKey, cacheEntries, cacheBroken, cacheEpisodes])

  useEffect(() => {
    cacheCurrentRef.current = cacheCurrent
  }, [cacheCurrent])

  const { retry, notice, switchSource, position } = useArtPlayer({
    containerRef: stageRef,
    // 重试 / 重新加载时旧剧集还在，先别把播放器拆掉，等新数据到了再切
    url: playUrl,
    poster: detail?.pic,
    accent,
    onEnded: goNext,
    onError: (message) => setPlayError(message),
    onEpisodes,
    onCache: () => cacheCurrentRef.current()
  })

  useEffect(() => {
    noticeRef.current = notice
  }, [notice])

  /**
   * 本集缓存刚下完：按当前进度把正在播的在线流原地切到本机缓存。
   * - 只认当前这一集，别的集下完不动；一条记录只试一次，失败也不反复折腾。
   * - 进度 / 播放状态 / 倍速由 switchQuality 接上，切不过去就退回在线流继续播。
   * - 已经快播完（剩不到 3 秒）就不切了，省得在结尾闪一下。
   */
  useEffect(() => {
    if (!episode || !episodeKey || !currentCache) return
    if (currentCache.status !== 'done' || cacheBroken.has(currentCache.recordId)) return
    // 已经在本机播，或者决策还停在上一集（换集的第一帧）
    if (decision.mode === 'cache' || decision.key !== episodeKey) return
    const recordId = currentCache.recordId
    if (promoteTriedRef.current.has(recordId)) return
    const now = position()
    if (now && now.duration > 0 && now.duration - now.currentTime <= 3) return
    promoteTriedRef.current.add(recordId)
    const remoteUrl = episode.url
    // 这里不挂 cleanup：缓存进度推送会让这个 effect 反复重跑，用「用户是否已经换集」
    // （decisionRef 里的 key）判断这次切换还算不算数，比 alive 标志更稳
    window.api.downloads
      .playbackUrl(recordId)
      .then(async (result) => {
        if (!result.ok || !result.url) return
        // 取地址这段时间里用户可能已经换集 / 切线路，这次切换就作废
        if (decisionRef.current.key !== episodeKey) return
        const local = result.url
        // 先切播放器（内部同步记下已应用的地址），再让状态跟上：
        // playUrl 变成同一个地址时，useArtPlayer 不会再来一遍从头开始的切换
        const switched = switchSource(local, remoteUrl)
        const next: PlaybackDecision = { key: episodeKey, mode: 'cache', recordId }
        decisionRef.current = next
        setLocalUrl({ key: episodeKey, recordId, url: local })
        setDecision(next)
        if (await switched) {
          // 在线流刚才可能报过「播放失败」，切回本机就把它撤掉
          setPlayError('')
          noticeRef.current('本集已缓存完，已按当前进度切到本地播放')
          return
        }
        if (decisionRef.current.key !== episodeKey) return
        const back: PlaybackDecision = { key: episodeKey, mode: 'remote' }
        decisionRef.current = back
        setDecision(back)
        noticeRef.current('本机缓存播放失败，继续在线播放')
      })
      .catch(() => {})
  }, [episode, episodeKey, currentCache, cacheBroken, decision, position, switchSource])

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
      <PlayerTitleBar title={title} episode={episodeName} countLabel={countLabel} />

      <div className={`player-body${line && panelOpen ? ' has-panel' : ''}`}>
        <section className="player-stage">
          {/* ArtPlayer 的挂载点：尺寸由外层 section 决定 */}
          <div className="player-stage-art" ref={stageRef} />

          {cacheChip && (
            <div className={`player-cache-chip is-${cacheChip.tone}`} role="status">
              <span className="player-cache-dot" aria-hidden="true" />
              {cacheChip.text}
            </div>
          )}

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

          {preparing && (
            <div className="player-state">
              <span className="player-spinner" aria-hidden="true" />
              <p className="player-state-title">
                {decision.mode === 'cache' ? '正在读取本集缓存…' : '正在准备播放…'}
              </p>
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
            lines={lines}
            line={line}
            onLine={switchLine}
            episodeIndex={episodeIndex}
            onEpisode={selectEpisode}
            autoNext={autoNext}
            onAutoNext={toggleAutoNext}
            detail={detail}
            lineLabel={lineLabel}
            naming={naming}
            category={category}
            countLabel={countLabel}
            cacheStates={lineCacheStates}
            cacheBusy={cacheBusy}
            onCacheEpisodes={cacheEpisodes}
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
 * 本机文件播放（下载中心点「播放」）：不查详情、没有线路和剧集面板，
 * 直接把 cine-file:// 地址交给 ArtPlayer 原生播；离线缓存包是 m3u8，走 hls.js。
 * 播放失败时只给重试。
 */
function LocalSession({
  payload,
  accent
}: {
  payload: PlayerPayload
  accent: string
}): React.JSX.Element {
  const [playError, setPlayError] = useState('')
  const stageRef = useRef<HTMLDivElement>(null)
  const title = payload.title?.trim() || payload.fileName?.trim() || '本机视频'
  const episode = payload.episodeName?.trim() ?? ''
  const hls = payload.hls === true

  useEffect(() => {
    document.title = episode ? `${title} · ${episode} — 映盒剧场` : `${title} — 映盒剧场`
  }, [title, episode])

  const { retry } = useArtPlayer({
    containerRef: stageRef,
    url: payload.fileUrl,
    type: hls ? 'm3u8' : 'auto',
    accent,
    showEpisodes: false,
    onError: (message) => setPlayError(message)
  })

  const retryPlayback = (): void => {
    setPlayError('')
    retry()
  }

  return (
    <div className="player-app">
      <PlayerTitleBar title={title} episode={episode} countLabel={hls ? '离线缓存' : '本机文件'} />

      <div className="player-body">
        <section className="player-stage">
          <div className="player-stage-art" ref={stageRef} />

          {playError && (
            <div className="player-state is-overlay">
              <p className="player-state-title">{playError}</p>
              <div className="player-state-actions">
                <button type="button" className="player-btn" onClick={retryPlayback}>
                  重试
                </button>
              </div>
            </div>
          )}
        </section>
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

  // 右缘中部那颗按钮：只做开合，保留当前 tab
  const togglePanel = useCallback(() => {
    setPanelOpen((value) => !value)
  }, [])

  const changePanelTab = useCallback((tab: PlayerPanelTab) => setPanelTab(tab), [])

  const accent = findAccent(accentKey).dark

  if (!payload) {
    return (
      <div className="player-app">
        <PlayerTitleBar title={missing ? '无法播放' : '正在准备播放'} episode="" countLabel="" />
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

  // 本机下载文件：播放页直接播，不按 videoId 取详情
  if (payload.fileUrl) {
    return <LocalSession key={payload.token} payload={payload} accent={accent} />
  }

  const videoId = payload.videoId
  if (typeof videoId !== 'number') {
    return (
      <div className="player-app">
        <PlayerTitleBar title="无法播放" episode="" countLabel="" />
        <div className="player-body">
          <section className="player-stage">
            <div className="player-state is-error">
              <VideoCameraOutlined className="player-state-icon" />
              <p className="player-state-title">没有收到播放信息</p>
              <p className="player-state-hint">回到列表重新点一集试试</p>
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
      videoId={videoId}
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
