export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface AccentOption {
  key: string
  name: string
  light: string
  dark: string
}

/**
 * 默认主题色取自 Logo（build/icon.svg）的蓝色，其余为可选的强调色。
 */
export const ACCENTS: AccentOption[] = [
  { key: 'cine', name: '映盒蓝', light: '#1296db', dark: '#3aa9e8' },
  { key: 'azure', name: '天青', light: '#2563eb', dark: '#60a5fa' },
  { key: 'violet', name: '星紫', light: '#7c3aed', dark: '#a78bfa' },
  { key: 'magenta', name: '霓粉', light: '#c026d3', dark: '#e879f9' },
  { key: 'rose', name: '玫瑰', light: '#e11d48', dark: '#fb7185' },
  { key: 'amber', name: '琥珀', light: '#d97706', dark: '#fbbf24' },
  { key: 'emerald', name: '翡翠', light: '#059669', dark: '#34d399' },
  { key: 'teal', name: '青碧', light: '#0d9488', dark: '#2dd4bf' },
  { key: 'graphite', name: '石墨', light: '#475569', dark: '#94a3b8' }
]

export const DEFAULT_ACCENT = 'cine'
export const DEFAULT_MODE: ThemeMode = 'system'

export interface SurfacePalette {
  /** 应用底色 */
  bg: string
  /** 卡片 / 面板 */
  surface: string
  /** 悬停 / 内嵌区域 */
  surfaceMuted: string
  /** 浮层（下拉、弹窗） */
  elevated: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textFaint: string
  /** 标题栏底色 */
  titlebar: string
}

/** 冷灰中性色：不做砖红色的暖黄，跟随明暗主题 */
export const SURFACES: Record<ResolvedTheme, SurfacePalette> = {
  light: {
    bg: '#f5f7fa',
    surface: '#ffffff',
    surfaceMuted: '#eef1f6',
    elevated: '#ffffff',
    border: '#e3e8ef',
    borderStrong: '#cfd7e2',
    text: '#151a21',
    textMuted: '#5d6775',
    textFaint: '#8d97a5',
    titlebar: '#ffffff'
  },
  dark: {
    bg: '#0c0f13',
    surface: '#141920',
    surfaceMuted: '#1b2129',
    elevated: '#181e26',
    border: '#242c36',
    borderStrong: '#33404e',
    text: '#e9edf2',
    textMuted: '#96a2b2',
    textFaint: '#697586',
    titlebar: '#0f1318'
  }
}

export const FONT_FAMILY =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif'

export function findAccent(key: string): AccentOption {
  return ACCENTS.find((item) => item.key === key) ?? ACCENTS[0]
}

export function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem('theme')
  return stored === 'light' || stored === 'dark' ? stored : DEFAULT_MODE
}

export function readStoredAccent(): AccentOption {
  return findAccent(localStorage.getItem('accent') ?? DEFAULT_ACCENT)
}

export function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 把主题写进 <html>：data-theme 供 Tailwind 的 dark: 变体使用，
 * CSS 变量与 antd token 保持同一份色板。
 */
export function applyAppearance(resolved: ResolvedTheme, accent: AccentOption): void {
  const root = document.documentElement
  const palette = SURFACES[resolved]

  root.setAttribute('data-theme', resolved)
  root.setAttribute('data-accent', accent.key)
  root.style.colorScheme = resolved

  const vars: Record<string, string> = {
    '--bg': palette.bg,
    '--surface': palette.surface,
    '--surface-muted': palette.surfaceMuted,
    '--elevated': palette.elevated,
    '--border': palette.border,
    '--border-strong': palette.borderStrong,
    '--text': palette.text,
    '--text-muted': palette.textMuted,
    '--text-faint': palette.textFaint,
    '--titlebar': palette.titlebar,
    '--accent': resolved === 'dark' ? accent.dark : accent.light
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}

/** 首帧渲染前调用，避免深色主题先闪一下浅色 */
export function applyStoredAppearance(): void {
  applyAppearance(resolveMode(readStoredMode()), readStoredAccent())
}
