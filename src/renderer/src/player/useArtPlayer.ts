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

/**
 * 控制条「缓存本集」的图标：一根下箭头落进托盘，和标题栏的下载图标同一造型。
 * 画布 22×22，墨迹横向 3.5–18.5、纵向 2.4–19.6，和 ArtPlayer 自带图标（齿轮 / 画中画 /
 * 全屏）一样大、一样上下居中，外层还会套 `.art-icon` 统一缩放。
 * 托盘那条必须自己写 fill="none"：ArtPlayer 注入的 `.art-video-player svg{fill:…}`
 * 会盖掉 `<svg fill="none">` 上的表现属性，path 一被填实，箭头就成了实心三角、
 * 托盘成了实心横条，比旁边的图标高出一截，看着不在同一条线上。
 */
const CACHE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
  '<path d="M10 2.4h2v7h4L11 14.4l-5-5h4z" fill="currentColor"/>' +
  '<path d="M4.5 16.1v.8a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7v-.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
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
  /**
   * 流类型：默认 m3u8（走 hls.js）；本机的 mp4 等直接文件传 'auto'，
   * 交给 <video> 原生解码，不走 HLS。
   */
  type?: 'm3u8' | 'auto'
  poster?: string
  /** 当前主题的强调色：进度条 / 控件 / 选中态跟主窗口一致 */
  accent: string
  onEnded?: () => void
  onError?: (message: string) => void
  /**
   * 控制条里的「选集」：开 / 关右侧剧集面板。
   * 参数是全屏状态：全屏时面板在播放器元素外面、根本看不见，所以那一下只能是「打开」，
   * 不能当成「再点一次收起」，否则退出全屏后会看不到侧栏。
   */
  onEpisodes?: (fromFullscreen: boolean) => void
  /** 有没有剧集面板：本机单文件播放没有，不挂「选集」按钮 */
  showEpisodes?: boolean
  /** 控制条「缓存本集」：不传就不挂这颗按钮（本机文件播放） */
  onCache?: () => void
}

export interface ArtPlayerHandle {
  /** 当前这集彻底放不出来时重建播放器 */
  retry: () => void
  /** 播放器右下角的轻提示（缓存入队 / 已缓存等） */
  notice: (text: string) => void
  /**
   * 同一集内部换源（在线流 → 本机缓存）：按当前进度原地切过去，不重建实例。
   * 播放中 / 倍速 / 画面比例由 ArtPlayer 的 switchQuality 自己接上；
   * 切不过去就回落到 fallbackUrl（一样保住进度），返回 false。
   */
  switchSource: (nextUrl: string, fallbackUrl?: string) => Promise<boolean>
  /** 当前播放位置：切源前用来判断「是不是已经快播完了」 */
  position: () => { currentTime: number; duration: number } | null
}

/**
 * ArtPlayer + hls.js 的薄封装：
 * 只在拿到第一集地址后创建一次播放器，之后换集走 switchUrl，
 * 播放进度条、倍速、全屏这些状态都留在同一个实例上。
 */
export function useArtPlayer({
  containerRef,
  url,
  type = 'm3u8',
  poster,
  accent,
  onEnded,
  onError,
  onEpisodes,
  showEpisodes = true,
  onCache
}: UseArtPlayerOptions): ArtPlayerHandle {
  const artRef = useRef<Artplayer | null>(null)
  const urlRef = useRef(url)
  const posterRef = useRef(poster)
  const accentRef = useRef(accent)
  const endedRef = useRef(onEnded)
  const errorRef = useRef(onError)
  const episodesRef = useRef(onEpisodes)
  const cacheRef = useRef(onCache)
  const typeRef = useRef(type)
  const showEpisodesRef = useRef(showEpisodes)
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
    episodesRef.current = onEpisodes
    cacheRef.current = onCache
    typeRef.current = type
    showEpisodesRef.current = showEpisodes
  })

  useEffect(() => {
    const container = containerRef.current
    const firstUrl = urlRef.current
    if (!container || !firstUrl) return

    const instance = new Artplayer({
      container,
      url: firstUrl,
      // ArtPlayer 5 的 option 校验要求 poster 必须是 string：没有封面时传空串，
      // 不能留 undefined（下载中心播本机文件就是这种情况）
      poster: posterRef.current ?? '',
      // 本机文件（mp4 等）按扩展名交给原生 <video>，不走 hls.js
      type: typeRef.current === 'auto' ? 'auto' : 'm3u8',
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
        episodes: EPISODES_ICON,
        cache: CACHE_ICON
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

    // 右键菜单：ArtPlayer 会无条件加一条指向官网的版本项，这里摘掉，
    // 只保留倍速 / 画面比例 / 统计信息 / 关闭
    instance.contextmenu.remove('version')

    // 统计信息面板固定渲染六行，前两行是播放器版本和视频地址（blob: 串），
    // 播放页不需要；面板是 flex 纵向排列，删掉节点不会留下空位
    const infoItems = instance.template.$infoPanel.querySelectorAll('.art-info-item')
    for (let index = 0; index < 2; index += 1) infoItems[index]?.remove()

    // 控制条右侧的「选集」：只放图标（走 ArtPlayer 的 .art-icon，和自带控件同一套
    // 尺寸 / 悬停提亮 / 按压缩小）；全屏时先退全屏再打开面板（全屏下面板看不见，只开不关）
    if (showEpisodesRef.current) {
      instance.controls.add((art) => ({
        name: 'cinebox-episodes',
        html: art.icons.episodes,
        position: 'right',
        index: 25,
        tooltip: '选集',
        click: () => {
          // 直接调 document.exitFullscreen()：ArtPlayer 的 fullscreen setter 要等
          // video:loadedmetadata 才装上，内部也只是转调这个方法，直接用标准 API 更稳
          const fromFullscreen = Boolean(document.fullscreenElement)
          if (fromFullscreen) {
            void document.exitFullscreen().catch(() => {})
          } else if (instance.fullscreen) {
            instance.fullscreen = false
          }
          episodesRef.current?.(fromFullscreen)
        }
      }))
    }

    // 控制条「缓存本集」：只放图标，和「选集」同一套 .art-icon 样式
    if (cacheRef.current) {
      instance.controls.add((art) => ({
        name: 'cinebox-cache',
        html: art.icons.cache,
        position: 'right',
        index: 24,
        tooltip: '缓存本集',
        click: () => cacheRef.current?.()
      }))
    }

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

  const notice = useCallback((text: string) => {
    const instance = artRef.current
    if (!instance) return
    instance.notice.show = text
  }, [])

  /**
   * 同一集内部换源：走 ArtPlayer 的 switchQuality —— 它把当前 currentTime 带过去，
   * 在 loadedmetadata 时 seek，canplay 时恢复倍速 / 画面比例并按原来的播放状态续播，
   * 所以在线播到一半切本机缓存不会回到 0、也不会因为「切源」把用户按下的暂停顶掉。
   *
   * 先把地址记进 appliedRef：调用方随即会把状态里的 url 换成同一个地址，
   * 那个 effect 看到「已经应用过」就不会再走一遍从头开始的 switchUrl。
   */
  const switchSource = useCallback(
    async (nextUrl: string, fallbackUrl?: string): Promise<boolean> => {
      if (!nextUrl) return false
      const instance = artRef.current
      // 播放器还没建起来（或者已经销毁）：改状态就够了，创建时会直接用新地址
      if (!instance) return true
      const before = Math.max(0, instance.currentTime)
      const wasPlaying = instance.playing
      /**
       * 带超时的切换：坏掉的地址不一定让 switchQuality reject（hls.js 的致命错误往往只走
       * 自己的 error 回调），不加这道兜底，「切本机」会一直挂在这里
       */
      const apply = (target: string): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          let settled = false
          const finish = (ok: boolean): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(ok)
          }
          const timer = setTimeout(() => finish(false), 6000)
          instance.switchQuality(target).then(
            () => finish(true),
            () => finish(false)
          )
        })

      appliedRef.current = nextUrl
      if (await apply(nextUrl)) {
        // 个别流在 loadedmetadata 时还拿不到时长，switchQuality 的 seek 会被夹回 0，这里补一次
        if (before > 1 && Math.abs(instance.currentTime - before) > 1.5) {
          instance.currentTime = before
        }
        return true
      }
      if (fallbackUrl && fallbackUrl !== nextUrl) {
        // 回退也走 switchQuality：尽量保住原来的进度；它在切换时会先暂停，播回去要自己补
        appliedRef.current = fallbackUrl
        await apply(fallbackUrl)
        if (wasPlaying) await instance.play().catch(() => {})
      } else {
        appliedRef.current = null
      }
      return false
    },
    []
  )

  const position = useCallback(() => {
    const instance = artRef.current
    if (!instance) return null
    return { currentTime: instance.currentTime, duration: instance.duration }
  }, [])

  return { retry, notice, switchSource, position }
}
