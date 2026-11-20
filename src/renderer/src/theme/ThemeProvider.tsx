import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  FONT_FAMILY,
  SURFACES,
  applyAppearance,
  findAccent,
  readStoredAccent,
  readStoredMode,
  resolveMode,
  type ResolvedTheme,
  type ThemeMode
} from './appearance'
import { ThemeContext } from './theme-context'

function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveMode(readStoredMode()))
  const [accent, setAccentState] = useState(readStoredAccent)

  const setMode = useCallback((next: ThemeMode): void => {
    setModeState(next)
    localStorage.setItem('theme', next)
    setResolved(resolveMode(next))
  }, [])

  const setAccent = useCallback((key: string): void => {
    const next = findAccent(key)
    setAccentState(next)
    localStorage.setItem('accent', next.key)
  }, [])

  // 跟随系统：系统配色变化时实时切换
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (): void => {
      if (mode === 'system') setResolved(query.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [mode])

  // useLayoutEffect：在浏览器绘制前写入 CSS 变量，避免切换时闪白
  useLayoutEffect(() => {
    applyAppearance(resolved, accent)
    // 独立播放窗有自己的一份 document：把当前外观推给主进程中转，
    // 已经打开的播放窗收到后立刻跟着换，不用重新打开
    void window.api.appearance.set({
      theme: resolved,
      accent: accent.key,
      bg: SURFACES[resolved].bg
    })
  }, [resolved, accent])

  const palette = SURFACES[resolved]
  const accentColor = resolved === 'dark' ? accent.dark : accent.light

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode, accent, setAccent }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: accentColor,
            colorInfo: accentColor,
            colorLink: accentColor,
            colorBgBase: palette.bg,
            colorBgLayout: palette.bg,
            colorBgContainer: palette.surface,
            colorBgElevated: palette.elevated,
            colorBorder: palette.border,
            colorBorderSecondary: palette.border,
            colorSplit: palette.border,
            colorText: palette.text,
            colorTextSecondary: palette.textMuted,
            colorTextTertiary: palette.textFaint,
            colorFillSecondary: palette.surfaceMuted,
            colorFillTertiary: palette.surfaceMuted,
            colorFillQuaternary: palette.surfaceMuted,
            borderRadius: 8,
            fontFamily: FONT_FAMILY
          }
        }}
      >
        {/* antd 的 <App> 会额外包一层 div，需撑满高度，否则页面的 100% 高度链会断开 */}
        <AntApp style={{ height: '100%' }}>{children}</AntApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}

export default ThemeProvider
