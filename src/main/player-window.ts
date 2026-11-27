import { BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/** 渲染层点某一集时传给播放窗的信息：详情由播放页自己按 videoId 取 */
export interface PlayerOpenInput {
  /** 库里的视频 id；本机下载文件播放时留空，改传 fileUrl */
  videoId?: number
  /** 优先起播的来源（VideoDetailSource.id），不传就用第一个能播的来源 */
  sourceId?: number
  /** 来源里的线路下标（playLines 原始下标） */
  lineIndex?: number
  /** 线路里的集数下标（episodes 原始下标） */
  episodeIndex?: number
  /** 详情加载前先显示的片名 / 集数，避免窗口白一下 */
  title?: string
  episodeName?: string
  /**
   * 本机文件（下载中心）：cine-file:// 地址，由主进程解析记录后填入。
   * 渲染层的 player:open 不接受这两个字段，只有 downloads:play 会传。
   */
  fileUrl?: string
  /** 本机文件名，详情加载前先当标题用 */
  fileName?: string
  /**
   * fileUrl 是离线缓存包里的 m3u8（下载中心 / 播放页优先缓存）：
   * 播放页按 HLS 处理，而不是当普通视频文件原生播放。
   */
  hls?: boolean
}

export interface PlayerPayload extends PlayerOpenInput {
  /** 每次打开都递增：播放页靠它重新取详情、重新起播 */
  token: number
}

export interface PlayerOpenResult {
  ok: boolean
  /** INVALID_INPUT：videoId 不合法 */
  error?: string
}

/**
 * 播放窗的固定底色：播放页固定深色（不跟主窗口明暗模式），
 * 取默认配色的深色 bg。渲染层换配色时只改播放页里的 CSS 变量，
 * 窗口底色保持这个值，避免刚打开时闪一下别的颜色。
 */
const PLAYER_BG = '#0c0f13'

/**
 * 独立播放窗口。
 *
 * 只保留一个窗口：再点别的集数时把新载荷推给已经打开的窗口，不堆一屏播放器。
 * 窗口是无边框 + 固定暗色底，标题栏由播放页自己画；配色只跟主窗口的深色那一份走。
 */
export function createPlayerWindowManager(options: { preload: string; icon: string }): {
  open: (input: PlayerOpenInput) => PlayerOpenResult
} {
  let playerWindow: BrowserWindow | null = null
  let payload: PlayerPayload | null = null
  let token = 0
  /** 主窗口当前的强调色与配色：播放窗创建后取一次，之后主窗口每次切换都转发过去 */
  let appearance: PlayerAppearance | null = null

  function rendererUrl(): string | null {
    const url = process.env['ELECTRON_RENDERER_URL']
    return is.dev && url ? url.replace(/\/$/, '') : null
  }

  function loadPage(window: BrowserWindow): void {
    const url = rendererUrl()
    if (url) {
      void window.loadURL(`${url}/player.html`)
    } else {
      void window.loadFile(join(__dirname, '../renderer/player.html'))
    }
  }

  function create(): BrowserWindow {
    const winOptions: Electron.BrowserWindowConstructorOptions = {
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      // 任务栏 / 窗口图标：Windows、Linux 生效
      icon: options.icon,
      title: '映盒剧场 · 播放',
      // 首帧之前就是播放页的深色底，不会先闪一下主窗口的配色
      backgroundColor: PLAYER_BG,
      webPreferences: {
        preload: options.preload,
        sandbox: false,
        // 播放源都在第三方 CDN 上，m3u8 / 分片未必带 CORS 头。播放窗只加载本地页面，
        // 脚本仍受 CSP 的 script-src 'self' 限制（拿不到远程 HTML / JS），
        // 这里放开同源策略只是为了 hls.js 能拉到流。
        webSecurity: false,
        // 点开播放窗就是一次明确的播放动作，不用再让用户点一下播放按钮
        autoplayPolicy: 'no-user-gesture-required'
      }
    }
    if (process.platform === 'darwin') {
      // macOS 保留原生红绿灯，其余内容由播放页自绘
      winOptions.titleBarStyle = 'hiddenInset'
      winOptions.trafficLightPosition = { x: 15, y: 15 }
    } else {
      winOptions.frame = false
    }

    const window = new BrowserWindow(winOptions)

    window.on('ready-to-show', () => {
      window.show()
    })

    window.on('closed', () => {
      if (playerWindow === window) playerWindow = null
    })

    window.on('maximize', () => {
      window.webContents.send('window:maximize-change', true)
    })

    window.on('unmaximize', () => {
      window.webContents.send('window:maximize-change', false)
    })

    if (process.platform === 'win32') {
      // 无边框窗口补回「双击标题栏最大化」：只认标题栏那一条，并避开右侧操作区
      const WM_LBUTTONDBLCLK = 0x0203
      const TITLE_BAR_HEIGHT = 46
      // 右侧三个窗口按钮再留一点余量，双击它们不应改变窗口状态
      const ACTIONS_ZONE_WIDTH = 300
      window.hookWindowMessage(WM_LBUTTONDBLCLK, () => {
        if (window.isDestroyed()) return
        const cursor = screen.getCursorScreenPoint()
        const bounds = window.getBounds()
        const inTitleBar = cursor.y >= bounds.y && cursor.y <= bounds.y + TITLE_BAR_HEIGHT
        const inDragZone =
          cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width - ACTIONS_ZONE_WIDTH
        if (!inTitleBar || !inDragZone) return
        if (window.isMaximized()) {
          window.unmaximize()
        } else {
          window.maximize()
        }
      })
    }

    window.webContents.setWindowOpenHandler((details) => {
      void shell.openExternal(details.url)
      return { action: 'deny' }
    })

    loadPage(window)
    return window
  }

  function open(input: PlayerOpenInput): PlayerOpenResult {
    const fileUrl = typeof input?.fileUrl === 'string' ? input.fileUrl.trim() : ''
    const isLocal = fileUrl.length > 0
    const videoId = Number(input?.videoId)
    // 二选一：要么是库里的视频，要么是下载到本机的文件
    if (!isLocal && (!Number.isInteger(videoId) || videoId <= 0)) {
      return { ok: false, error: 'INVALID_INPUT' }
    }

    const toIndex = (value: unknown): number | undefined => {
      const index = Number(value)
      return Number.isInteger(index) && index >= 0 ? index : undefined
    }

    payload = isLocal
      ? {
          fileUrl,
          hls: input?.hls === true,
          fileName: typeof input?.fileName === 'string' ? input.fileName : undefined,
          title: typeof input?.title === 'string' ? input.title : undefined,
          episodeName: typeof input?.episodeName === 'string' ? input.episodeName : undefined,
          token: ++token
        }
      : {
          videoId,
          sourceId: toIndex(input?.sourceId),
          lineIndex: toIndex(input?.lineIndex),
          episodeIndex: toIndex(input?.episodeIndex),
          title: typeof input?.title === 'string' ? input.title : undefined,
          episodeName: typeof input?.episodeName === 'string' ? input.episodeName : undefined,
          token: ++token
        }

    if (!playerWindow || playerWindow.isDestroyed()) {
      // 窗口创建后由播放页主动取 payload，这里不用等 load 完再发
      playerWindow = create()
      return { ok: true }
    }

    if (playerWindow.isMinimized()) playerWindow.restore()
    playerWindow.show()
    playerWindow.focus()
    playerWindow.webContents.send('player:load', payload)
    return { ok: true }
  }

  ipcMain.handle('player:open', (_event, input: PlayerOpenInput) => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'INVALID_INPUT' }
    // 白名单式转交：渲染层不能借 player:open 播任意本地文件（本机文件只走 downloads:play）
    return open({
      videoId: input.videoId,
      sourceId: input.sourceId,
      lineIndex: input.lineIndex,
      episodeIndex: input.episodeIndex,
      title: input.title,
      episodeName: input.episodeName
    })
  })
  // 播放页挂载时取当前载荷：窗口是复用的，可能已经被推到第 N 集
  ipcMain.handle('player:payload', () => payload)

  // 外观中转：主窗口应用主题后推过来，播放窗挂载时再取一次
  ipcMain.handle('appearance:get', () => appearance)
  ipcMain.handle('appearance:set', (_event, value: PlayerAppearance) => {
    if (!value) return
    appearance = {
      accent: typeof value.accent === 'string' && value.accent ? value.accent : 'cine',
      // 配色 key 由渲染层定义，主进程只做透传；播放页查不到会回落到默认色板
      theme: typeof value.theme === 'string' && value.theme ? value.theme : 'mist'
    }
    if (playerWindow && !playerWindow.isDestroyed()) {
      // 播放页固定深色底，只把强调色与配色转给已打开的播放窗，不需要重新打开
      playerWindow.setBackgroundColor(PLAYER_BG)
      playerWindow.webContents.send('appearance:change', appearance)
    }
  })

  return { open }
}
