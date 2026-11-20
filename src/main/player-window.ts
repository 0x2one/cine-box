import { BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/** 渲染层点某一集时传给播放窗的信息：详情由播放页自己按 videoId 取 */
export interface PlayerOpenInput {
  videoId: number
  /** 优先起播的来源（VideoDetailSource.id），不传就用第一个能播的来源 */
  sourceId?: number
  /** 来源里的线路下标（playLines 原始下标） */
  lineIndex?: number
  /** 线路里的集数下标（episodes 原始下标） */
  episodeIndex?: number
  /** 详情加载前先显示的片名 / 集数，避免窗口白一下 */
  title?: string
  episodeName?: string
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
 * 独立播放窗口。
 *
 * 只保留一个窗口：再点别的集数时把新载荷推给已经打开的窗口，不堆一屏播放器。
 * 窗口是无边框 + 固定暗色底，标题栏由播放页自己画，所以不会跟应用主题走。
 */
export function createPlayerWindowManager(options: { preload: string; icon: string }): {
  open: (input: PlayerOpenInput) => PlayerOpenResult
} {
  let playerWindow: BrowserWindow | null = null
  let payload: PlayerPayload | null = null
  let token = 0

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
      // 首帧之前也是暗色，不会先闪一下白底
      backgroundColor: '#08090c',
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
      // 布局切换 + 三个窗口按钮的实际宽度，双击这些按钮不应改变窗口状态
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
    const videoId = Number(input?.videoId)
    if (!Number.isInteger(videoId) || videoId <= 0) return { ok: false, error: 'INVALID_INPUT' }

    const toIndex = (value: unknown): number | undefined => {
      const index = Number(value)
      return Number.isInteger(index) && index >= 0 ? index : undefined
    }

    payload = {
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

  ipcMain.handle('player:open', (_event, input: PlayerOpenInput) => open(input))
  // 播放页挂载时取当前载荷：窗口是复用的，可能已经被推到第 N 集
  ipcMain.handle('player:payload', () => payload)

  return { open }
}
