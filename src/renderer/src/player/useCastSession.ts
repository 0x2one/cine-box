import { useCallback, useEffect, useRef, useState } from 'react'

const EMPTY_STATE: CastState = { active: false, status: 'idle', position: 0, duration: 0 }

export interface CastSessionOptions {
  /** 点了某台设备后生成投屏参数；返回 null 表示当前这一集还不能投 */
  buildInput: (device: CastDevice) => CastStartInput | null
  /** 当前集 / 文件的 key：变化时自动停投，避免电视接着播上一集 */
  currentKey: string
  /** 投屏开始：暂停本地播放 */
  onCastStart: () => void
  /** 投屏结束：按电视上报的位置回位并继续本地播放 */
  onCastEnd: (position: number) => void
  /** 轻提示（按钮不存在时是空函数） */
  notice: (text: string) => void
}

export interface CastSessionHandle {
  state: CastState
  open: boolean
  devices: CastDevice[]
  loading: boolean
  error: string
  /** 控制条「投屏」：全屏时先退全屏，再开关设备列表 */
  toggle: () => void
  close: () => void
  refresh: () => void
  start: (device: CastDevice) => Promise<void>
  stop: () => void
  pause: () => void
  resume: () => void
}

/**
 * 播放页的投屏状态与设备列表。
 *
 * 播放页和下载中心的本机播放共用这一套：订阅主进程会话状态、拉设备、
 * 起停 / 暂停 / 继续，以及「投屏开始暂停本地、结束回位续播」。
 * 用 ref 保存最新回调，避免每次轮询更新状态时重建订阅。
 */
export function useCastSession(options: CastSessionOptions): CastSessionHandle {
  const [state, setState] = useState<CastState>(EMPTY_STATE)
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<CastDevice[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const optionsRef = useRef(options)
  const positionRef = useRef(0)
  const activeRef = useRef(false)
  const castedKeyRef = useRef('')
  const lastErrorRef = useRef('')

  // 回调（buildInput / currentKey）每帧都可能变，用 effect 同步，避免渲染期写 ref
  useEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => {
    let alive = true
    void window.api.cast.state().then((value) => {
      if (alive) setState(value)
    })
    const off = window.api.cast.onChange((value) => setState(value))
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    positionRef.current = state.position
  }, [state.position])

  useEffect(() => {
    const wasActive = activeRef.current
    activeRef.current = state.active
    if (state.active && !wasActive) {
      optionsRef.current.onCastStart()
      return
    }
    if (!state.active && wasActive) {
      optionsRef.current.onCastEnd(positionRef.current)
    }
  }, [state.active])

  useEffect(() => {
    if (!state.active) return
    const key = optionsRef.current.currentKey
    if (castedKeyRef.current && castedKeyRef.current !== key) {
      castedKeyRef.current = ''
      void window.api.cast.stop().catch(() => {})
      optionsRef.current.notice('切换剧集，已停止投屏')
    }
  }, [state.active, options.currentKey])

  useEffect(() => {
    if (state.active || !state.error) return
    if (lastErrorRef.current === state.error) return
    lastErrorRef.current = state.error
    optionsRef.current.notice(state.error)
  }, [state.active, state.error])

  // 播放页 / 下载中心关闭时结束投屏；主进程的窗口关闭回调也会兜底
  useEffect(() => {
    return () => {
      void window.api.cast.stop().catch(() => {})
    }
  }, [])

  const loadDevices = useCallback(async (refresh: boolean): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.cast.devices({ refresh })
      setDevices(result.devices)
      if (!result.ok) setError(result.error ?? '搜索投屏设备失败')
    } catch {
      setError('搜索投屏设备失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const toggle = useCallback((): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
    setOpen((value) => {
      const next = !value
      if (next) void loadDevices(false)
      return next
    })
  }, [loadDevices])

  const close = useCallback((): void => {
    setOpen(false)
  }, [])

  const refresh = useCallback((): void => {
    void loadDevices(true)
  }, [loadDevices])

  const start = useCallback(async (device: CastDevice): Promise<void> => {
    const input = optionsRef.current.buildInput(device)
    if (!input) return
    setError('')
    setLoading(true)
    try {
      const result = await window.api.cast.start(input)
      setState(result.state)
      if (!result.ok) {
        setError(result.message ?? '投屏失败')
        return
      }
      castedKeyRef.current = optionsRef.current.currentKey
      setOpen(false)
    } catch {
      setError('投屏失败，检查网络后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  const stop = useCallback((): void => {
    void window.api.cast.stop().catch(() => {})
  }, [])

  const pause = useCallback((): void => {
    void window.api.cast.pause().catch(() => {})
  }, [])

  const resume = useCallback((): void => {
    void window.api.cast.resume().catch(() => {})
  }, [])

  return {
    state,
    open,
    devices,
    loading,
    error,
    toggle,
    close,
    refresh,
    start,
    stop,
    pause,
    resume
  }
}
