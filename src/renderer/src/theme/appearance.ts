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
  { key: 'graphite', name: '石板', light: '#475569', dark: '#94a3b8' }
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

export interface ThemeOption {
  key: string
  name: string
  /** 一句话说明这套配色的性格，设置页放在 title 提示里 */
  hint: string
  light: SurfacePalette
  dark: SurfacePalette
}

/**
 * 主题配色：只决定窗口底色、卡片、边框、文字与标题栏这一层，
 * 和强调色（按钮 / 选中态 / 链接）完全独立，任意两套都能搭配。
 *
 * 每套都有浅色与深色两份，深色不是把浅色压暗，而是单独调过底色与描边，
 * 保证在 OLED 屏上不糊成一片黑。所有色板都带一点同色系的灰调，
 * 不会跟任何强调色打架。
 */
export const THEMES: ThemeOption[] = [
  {
    key: 'cloud',
    name: '云白',
    hint: '最朴素的默认：白底黑字、浅灰分区与描边',
    light: {
      bg: '#f4f4f5',
      surface: '#ffffff',
      surfaceMuted: '#ececee',
      elevated: '#ffffff',
      border: '#e4e4e7',
      borderStrong: '#d0d0d5',
      text: '#18181b',
      textMuted: '#5b5b63',
      textFaint: '#8b8b93',
      titlebar: '#ffffff'
    },
    dark: {
      bg: '#0a0a0b',
      surface: '#131316',
      surfaceMuted: '#1b1b1f',
      elevated: '#18181c',
      border: '#26262b',
      borderStrong: '#38383f',
      text: '#ededf0',
      textMuted: '#a0a0a8',
      textFaint: '#6f6f78',
      titlebar: '#0e0e10'
    }
  },
  {
    key: 'stone',
    name: '石墨',
    hint: '浅色是明确的灰，深色接近纯黑',
    light: {
      bg: '#ededee',
      surface: '#fafafa',
      surfaceMuted: '#e3e4e6',
      elevated: '#fafafa',
      border: '#dcdcdf',
      borderStrong: '#c6c6ca',
      text: '#19191b',
      textMuted: '#5a5a61',
      textFaint: '#8a8a92',
      titlebar: '#fafafa'
    },
    dark: {
      bg: '#050505',
      surface: '#101010',
      surfaceMuted: '#171717',
      elevated: '#141414',
      border: '#232323',
      borderStrong: '#333333',
      text: '#ededed',
      textMuted: '#9f9f9f',
      textFaint: '#6e6e6e',
      titlebar: '#0a0a0a'
    }
  },
  {
    key: 'mist',
    name: '雾蓝',
    hint: '冷调中性灰，偏一点蓝（旧版默认）',
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
  },
  {
    key: 'ocean',
    name: '深海',
    hint: '靛蓝夜色，偏冷静克制',
    light: {
      bg: '#eef2f9',
      surface: '#fbfdff',
      surfaceMuted: '#e4ebf5',
      elevated: '#fbfdff',
      border: '#d8e2f0',
      borderStrong: '#bccce0',
      text: '#121b2a',
      textMuted: '#4f6078',
      textFaint: '#8193aa',
      titlebar: '#fbfdff'
    },
    dark: {
      bg: '#070c15',
      surface: '#0e1621',
      surfaceMuted: '#141e2c',
      elevated: '#111a28',
      border: '#1e2b3d',
      borderStrong: '#2e4057',
      text: '#e7eefb',
      textMuted: '#9aacc5',
      textFaint: '#6a7f99',
      titlebar: '#0a101a'
    }
  },
  {
    key: 'forest',
    name: '松林',
    hint: '带青绿的林间配色，安静不抢戏',
    light: {
      bg: '#f2f6ef',
      surface: '#fbfdf8',
      surfaceMuted: '#e7efe0',
      elevated: '#fbfdf8',
      border: '#dbe6d2',
      borderStrong: '#c3d4b6',
      text: '#161f18',
      textMuted: '#526455',
      textFaint: '#83977f',
      titlebar: '#fbfdf8'
    },
    dark: {
      bg: '#090f0b',
      surface: '#111913',
      surfaceMuted: '#17221a',
      elevated: '#141d16',
      border: '#213026',
      borderStrong: '#33473a',
      text: '#e6f0e7',
      textMuted: '#9cb3a1',
      textFaint: '#6d8474',
      titlebar: '#0c130e'
    }
  },
  {
    key: 'plum',
    name: '梅紫',
    hint: '淡紫与深梅，柔和但不甜腻',
    light: {
      bg: '#f6f1f8',
      surface: '#fdfbff',
      surfaceMuted: '#eee5f2',
      elevated: '#fdfbff',
      border: '#e7daec',
      borderStrong: '#d2c0da',
      text: '#1f1526',
      textMuted: '#665371',
      textFaint: '#9887a4',
      titlebar: '#fdfbff'
    },
    dark: {
      bg: '#0e0911',
      surface: '#16101b',
      surfaceMuted: '#1e1726',
      elevated: '#1b1422',
      border: '#2a2033',
      borderStrong: '#3d2e4a',
      text: '#efe7f5',
      textMuted: '#b5a2c2',
      textFaint: '#816f8e',
      titlebar: '#110c15'
    }
  },
  {
    key: 'persimmon',
    name: '蜜杏',
    hint: '更暖的米杏色，比暖砂亮一点、橘一点',
    light: {
      bg: '#f8f3ec',
      surface: '#fffdf9',
      surfaceMuted: '#f0e7da',
      elevated: '#fffdf9',
      border: '#e7dccd',
      borderStrong: '#d2c1aa',
      text: '#231a12',
      textMuted: '#6d5f4e',
      textFaint: '#9f8e79',
      titlebar: '#fffdf9'
    },
    dark: {
      bg: '#110d09',
      surface: '#1a1611',
      surfaceMuted: '#221c16',
      elevated: '#1f1a14',
      border: '#302821',
      borderStrong: '#473a2d',
      text: '#f3ece1',
      textMuted: '#b6a793',
      textFaint: '#837460',
      titlebar: '#16120d'
    }
  },
  {
    key: 'sand',
    name: '暖砂',
    hint: '米白与暖褐，像旧书页和台灯',
    light: {
      bg: '#f7f3ea',
      surface: '#fffcf5',
      surfaceMuted: '#efe7d9',
      elevated: '#fffcf5',
      border: '#e5dac8',
      borderStrong: '#cfbfa4',
      text: '#221b11',
      textMuted: '#6b5d4a',
      textFaint: '#9c8b75',
      titlebar: '#fffcf5'
    },
    dark: {
      bg: '#100d09',
      surface: '#191510',
      surfaceMuted: '#211b14',
      elevated: '#1e1913',
      border: '#2e2720',
      borderStrong: '#453a2c',
      text: '#f2ebe0',
      textMuted: '#b3a491',
      textFaint: '#80715f',
      titlebar: '#15110d'
    }
  }
]

export const DEFAULT_THEME = 'cloud'

export const FONT_FAMILY =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif'

export function findAccent(key: string): AccentOption {
  return ACCENTS.find((item) => item.key === key) ?? ACCENTS[0]
}

/** 查不到时返回 null：主题 key 拼错和「没存过」要分开处理 */
export function findTheme(key: string): ThemeOption | null {
  return THEMES.find((item) => item.key === key) ?? null
}

export function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem('theme')
  return stored === 'light' || stored === 'dark' ? stored : DEFAULT_MODE
}

export function readStoredAccent(): AccentOption {
  return findAccent(localStorage.getItem('accent') ?? DEFAULT_ACCENT)
}

/**
 * 主题配色单独一个键，不要和「跟随系统 / 浅色 / 深色」的 theme 混用。
 * 没有这个键时用默认配色，并立刻写回一条显式记录：这样升级后外观不会自己变，
 * 以后想跟随新的默认配色也可以直接清掉这个键。
 */
export function readStoredTheme(): ThemeOption {
  const stored = localStorage.getItem('theme-color')
  const theme = stored ? findTheme(stored) : null
  const resolved = theme ?? findTheme(DEFAULT_THEME) ?? THEMES[0]
  if (!theme) {
    try {
      localStorage.setItem('theme-color', resolved.key)
    } catch {
      // 本地存储不可写时不影响本次渲染
    }
  }
  return resolved
}

export function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 把主题写进 <html>：data-theme 供 Tailwind 的 dark: 变体使用，
 * data-theme-color 留给需要按主题配色单独微调的样式，
 * CSS 变量与 antd token 保持同一份色板。
 */
export function applyAppearance(
  resolved: ResolvedTheme,
  accent: AccentOption,
  theme: ThemeOption
): void {
  const root = document.documentElement
  const palette = theme[resolved]

  root.setAttribute('data-theme', resolved)
  root.setAttribute('data-accent', accent.key)
  root.setAttribute('data-theme-color', theme.key)
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
  applyAppearance(resolveMode(readStoredMode()), readStoredAccent(), readStoredTheme())
}

/**
 * 播放页的外观：固定套用所选主题的深色色板（视频播放器的习惯，也让黑画面四周没有浅色画框），
 * 强调色跟随主窗口。主窗口切明暗模式时播放页不变，切配色 / 强调色时实时跟随。
 */
export function applyPlayerAppearance(
  accent: AccentOption,
  theme: ThemeOption | null = null
): void {
  applyAppearance('dark', accent, theme ?? findTheme(DEFAULT_THEME) ?? THEMES[0])
}
