import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import Artplayer from 'artplayer'
import Hls from 'hls.js'

const VOLUME_KEY = 'player-volume'
const MUTED_KEY = 'player-muted'

/**
 * 控制条「选集」的图标：列表造型的 22×22 SVG。
 * 22×22 跟 ArtPlayer 自带图标一致，外层会套 `.art-icon`，尺寸 / 悬停 / 按压缩放都走它自己的样式。
 */
const EPISODES_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">' +
  '<circle cx="4" cy="6.5" r="1.6"/>' +
  '<rect x="8" y="5.3" width="13" height="2.4" rx="0.4"/>' +
  '<circle cx="4" cy="12" r="1.6"/>' +
  '<rect x="8" y="10.8" width="13" height="2.4" rx="0.4"/>' +
  '<circle cx="4" cy="17.5" r="1.6"/>' +
  '<rect x="8" y="16.3" width="13" height="2.4" rx="0.4"/>' +
  '</svg>'

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
  /** 当前主题的强调色：进度条 / 控件 / 选中态跟主窗口一致 */
  accent: string
  onEnded?: () => void
  onError?: (message: string) => void
  /** 控制条里的「选集」：开 / 关右侧剧集面板 */
  onToggleEpisodes?: () => void
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
  accent,
  onEnded,
  onError,
  onToggleEpisodes
}: UseArtPlayerOptions): ArtPlayerHandle {
  const artRef = useRef<Artplayer | null>(null)
  const urlRef = useRef(url)
  const posterRef = useRef(poster)
  const accentRef = useRef(accent)
  const endedRef = useRef(onEnded)
  const errorRef = useRef(onError)
  const episodesRef = useRef(onToggleEpisodes)
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
    accentRef.current = accent
    endedRef.current = onEnded
    errorRef.current = onError
    episodesRef.current = onToggleEpisodes
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
      theme: accentRef.current,
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
      // 控制条自动收起时不再在底部留一条细进度线
      miniProgressBar: false,
      backdrop: true,
      playsInline: true,
      airplay: false,
      autoPlayback: true,
      moreVideoAttr: { preload: 'auto' },
      // 自定义图标挂在 ArtPlayer 的 icons 上，取出来是带 .art-icon 的元素
      icons: {
        episodes: EPISODES_ICON
      },
      cssVar: {
        '--art-control-height': '42px',
        '--art-control-icon-size': '24px',
        '--art-progress-height': '4px',
        '--art-border-radius': '6px'
      },
      customType: {
        m3u8(video, sourceUrl, art) {
          const previous = art.hls as Hls | undefined
          if (previous) previous.destroy()

          // 全屏时错误状态层会被全屏视频挡住，先退全屏再交给页面提示
          const fail = (message: string): void => {
            if (art.fullscreen) art.fullscreen = false
            errorRef.current?.(message)
          }

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
              fail('这条线路播放失败，换一条试试')
            })
            art.hls = hls
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = sourceUrl
          } else {
            fail('当前环境不支持 m3u8 播放')
          }
        }
      }
    })

    artRef.current = instance
    appliedRef.current = firstUrl

    // 控制条右侧的「选集」：只放图标（走 ArtPlayer 的 .art-icon，和自带控件同一套
    // 尺寸 / 悬停提亮 / 按压缩小）；点击是开 / 关剧集面板，全屏时先退全屏再切换
    instance.controls.add((art) => ({
      name: 'cinebox-episodes',
      html: art.icons.episodes,
      position: 'right',
      index: 25,
      tooltip: '选集',
      click: () => {
        if (instance.fullscreen) instance.fullscreen = false
        episodesRef.current?.()
      }
    }))

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
        if (!alive) return
        if (instance.fullscreen) instance.fullscreen = false
        errorRef.current?.('这条线路播放失败，换一条试试')
      })
    return () => {
      alive = false
    }
  }, [url])

  // 主窗口切换强调色：播放器已经创建时直接换主题色，不重建实例
  useEffect(() => {
    const instance = artRef.current
    if (instance) instance.theme = accent
  }, [accent])

  const retry = useCallback(() => {
    setGeneration((value) => value + 1)
  }, [])

  return { retry }
}
