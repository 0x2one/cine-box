/**
 * 启动时的窗口大小，分三档：适中 / 大屏 / 超大。
 * 大屏档是默认值，比原来的 1180×760 更大，为 1080p 以上的显示器设计；
 * 适中给笔记本与小屏，超大给 2K / 4K 显示器。
 */
export type AppWindowSize = 'medium' | 'large' | 'xlarge'

/** 默认档：大屏 */
export const DEFAULT_WINDOW_SIZE: AppWindowSize = 'large'

/** 主窗口最小尺寸：BrowserWindow 的 minWidth / minHeight 和尺寸换算共用这一份 */
export const WINDOW_MIN_WIDTH = 920
export const WINDOW_MIN_HEIGHT = 620

/** 三档的目标尺寸，屏幕放不下时按主显示器工作区收缩。改这里时同步 Settings.tsx 的 WINDOW_SIZE_HINTS 文案 */
export const WINDOW_SIZE_PRESETS: Record<AppWindowSize, { width: number; height: number }> = {
  medium: { width: 1200, height: 780 },
  large: { width: 1400, height: 880 },
  xlarge: { width: 1600, height: 1000 }
}

/** 窗口与工作区之间留的边距：选了超大也不顶满屏幕，仍能看到桌面 / 任务栏边界 */
const SCREEN_MARGIN = 48

export function isAppWindowSize(value: unknown): value is AppWindowSize {
  return value === 'medium' || value === 'large' || value === 'xlarge'
}

/**
 * 把档位换算成实际窗口尺寸：目标尺寸超过主显示器工作区时收缩到「工作区 - 留白」，
 * 但不低于窗口最小尺寸（否则 BrowserWindow 会忽略这个 width / height）。
 */
export function resolveWindowSize(
  size: AppWindowSize,
  workArea: { width: number; height: number }
): { width: number; height: number } {
  const preset = WINDOW_SIZE_PRESETS[size]
  return {
    width: Math.max(WINDOW_MIN_WIDTH, Math.min(preset.width, workArea.width - SCREEN_MARGIN)),
    height: Math.max(WINDOW_MIN_HEIGHT, Math.min(preset.height, workArea.height - SCREEN_MARGIN))
  }
}
