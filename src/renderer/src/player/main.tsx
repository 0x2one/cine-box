import { createRoot } from 'react-dom/client'
import PlayerApp from './PlayerApp'
import { applyAppearance, findAccent, readStoredAppearance } from '../theme/appearance'
import './player.css'

/**
 * 播放页不挂 StrictMode：ArtPlayer 会往容器里注入 DOM，
 * 开发模式的双次挂载 / 卸载会让播放器闪一下再重建。
 *
 * 首帧之前先取主窗口当前的外观（主进程中转），没有就退回本地存的偏好，
 * 再写 data-theme / CSS 变量，避免打开播放窗时先闪一下另一种配色。
 */
async function boot(): Promise<void> {
  let appearance: PlayerAppearance | null = null
  try {
    appearance = await window.api.appearance.get()
  } catch {
    // 主进程还没上报过外观：下面退回本地存的偏好
  }
  const initial = appearance ?? readStoredAppearance()
  applyAppearance(initial.theme, findAccent(initial.accent))
  createRoot(document.getElementById('player-root')!).render(
    <PlayerApp initialAppearance={initial} />
  )
}

void boot()
