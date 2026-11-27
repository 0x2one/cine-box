import { createContext, useContext } from 'react'
import {
  THEMES,
  type AccentOption,
  type ResolvedTheme,
  type ThemeMode,
  type ThemeOption
} from './appearance'

export interface ThemeContextValue {
  /** 用户选择：跟随系统 / 浅色 / 深色 */
  mode: ThemeMode
  /** 实际生效的明暗主题 */
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  /** 当前主题配色：底色、卡片、边框、文字 */
  theme: ThemeOption
  setTheme: (key: string) => void
  /** 当前强调色 */
  accent: AccentOption
  setAccent: (key: string) => void
}

export const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  resolved: 'light',
  setMode: () => {},
  theme: THEMES[0],
  setTheme: () => {},
  accent: { key: 'cine', name: '映盒蓝', light: '#1296db', dark: '#3aa9e8' },
  setAccent: () => {}
})

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
