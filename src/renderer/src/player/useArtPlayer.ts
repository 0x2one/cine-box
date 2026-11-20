import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import Artplayer from 'artplayer'
import Hls from 'hls.js'

const VOLUME_KEY = 'player-volume'
const MUTED_KEY = 'player-muted'

/** 播放器强调色：跟播放页的琥珀色一致，不用应用主题色 */
const PLAYER_THEME = '#f0b45e'

function readVolume(): number {
  const stored = Number(localStorage.getItem(VOLUME_KEY))
  return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 0.8
}

function readMuted(): boolean {
  return localStorage.getItem(MUTED_KEY) === '1'
}

export interface UseArtPlayerOptions {
  /** ArtPlayer 挂载的容器：由页面给尺寸，播放器自己铺满 */
  containerRef: RefObject<HTMLDivElement | null>
  /** 当前集的 m3u8 地址；切换时复用同一个播放器实例 */
  url?: string
  poster?: string
  onEnded?: () => void
  onError?: (message: string) => void
}

export interface ArtPlayerHandle {
  /** 当前这集彻底放不出来时重建播放器 */
  retry: () => void
}

/**
 * ArtPlayer + hls.js 的薄封装：
 * 只在拿到第一集地址后创建一次播放器，之后换集走 switchUrl，
 * 播放进度条、倍速、全屏这些状态都留在同一个实例上。
 */
export function useArtPlayer({
  containerRef,
  url,
  poster,
  onEnded,
  onError
}: UseArtPlayerOptions): ArtPlayerHandle {
  const artRef = useRef<Artplayer | null>(null)
  const urlRef = useRef(url)
  const posterRef = useRef(poster)
  const endedRef = useRef(onEnded)
  const errorRef = useRef(onError)
  /**
   * 已经交给播放器的地址。不能拿 art.url 比：hls.js 会把 video.src 换成 blob:，
   * 创建完那一刻 art.url 永远不等于 m3u8，直接比会把同一集再切一次。
   */
  const appliedRef = useRef<string | null>(null)
  /** 重建计数：重试时 +1，让创建 effect 重跑 */
  const [generation, setGeneration] = useState(0)
  const hasUrl = Boolean(url)

  // 最新地址与回调同步进 ref：创建 effect 只跑一次，切集 / 换片时读到的必须是最新值
  useEffect(() => {
    urlRef.current = url
    posterRef.current = poster
    endedRef.current = onEnded
    errorRef.current = onError
  })

  useEffect(() => {
    const container = containerRef.current
    const firstUrl = urlRef.current
    if (!container || !firstUrl) return

    const instance = new Artplayer({
      container,
      url: firstUrl,
      poster: posterRef.current,
      type: 'm3u8',
      lang: 'zh-cn',
      theme: PLAYER_THEME,
      autoplay: true,
      muted: readMuted(),
      volume: readVolume(),
      autoSize: false,
      autoMini: false,
      // 播放窗本身就是一个独立窗口，网页全屏会跟自绘标题栏打架，只保留原生全屏
      fullscreen: true,
      fullscreenWeb: false,
      pip: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      screenshot: false,
      hotkey: true,
      miniProgressBar: true,
      backdrop: true,
      playsInline: true,
      airplay: false,
      autoPlayback: true,
      moreVideoAttr: { preload: 'auto' },
      cssVar: {
        '--art-theme': PLAYER_THEME,
        '--art-control-height': '42px',
        '--art-control-icon-size': '24px',
        '--art-progress-height': '4px',
        '--art-border-radius': '6px'
      },
      customType: {
        m3u8(video, sourceUrl, art) {
          const previous = art.hls as Hls | undefined
          if (previous) previous.destroy()

          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              backBufferLength: 60,
              maxBufferLength: 40,
              manifestLoadingMaxRetry: 2,
              levelLoadingMaxRetry: 3,
              fragLoadingMaxRetry: 4
            })
            let recovered = 0
            hls.loadSource(sourceUrl)
            hls.attachMedia(video)
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (!data.fatal) return
              // 网络 / 解码类的致命错误先就地恢复一次，真的救不回来再交给页面提示换线路
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered < 2) {
                recovered += 1
                hls.startLoad()
                return
              }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered < 2) {
                recovered += 1
                hls.recoverMediaError()
                return
              }
              hls.destroy()
              errorRef.current?.('这条线路播放失败，换一条试试')
            })
            art.hls = hls
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = sourceUrl
          } else {
            errorRef.current?.('当前环境不支持 m3u8 播放')
          }
        }
      }
    })

    artRef.current = instance
    appliedRef.current = firstUrl

    instance.on('video:ended', () => endedRef.current?.())
    instance.on('video:volumechange', () => {
      localStorage.setItem(VOLUME_KEY, String(instance.volume))
      localStorage.setItem(MUTED_KEY, instance.muted ? '1' : '0')
    })
    // 切集时旧实例会被 switchUrl 内部销毁，这里统一兜底
    instance.on('destroy', () => {
      const hls = instance.hls as Hls | undefined
      hls?.destroy()
      instance.hls = undefined
    })

    return () => {
      artRef.current = null
      appliedRef.current = null
      instance.destroy(true)
    }
  }, [containerRef, hasUrl, generation])

  // 换集：地址变了就切流，并且按「点了就播」处理（自动连播也走这里）
  useEffect(() => {
    const instance = artRef.current
    if (!instance || !url || appliedRef.current === url) return
    appliedRef.current = url
    let alive = true
    instance
      .switchUrl(url)
      .then(() => {
        if (alive) void instance.play().catch(() => {})
      })
      .catch(() => {
        if (alive) errorRef.current?.('这条线路播放失败，换一条试试')
      })
    return () => {
      alive = false
    }
  }, [url])

  const retry = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])

  return { retry }
}
