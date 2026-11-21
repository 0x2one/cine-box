import { createRoot } from 'react-dom/client'
import PlayerApp from './PlayerApp'
import { applyPlayerAppearance, findAccent, readStoredAccent } from '../theme/appearance'
import './player.css'

/**
 * 播放页不挂 StrictMode：ArtPlayer 会往容器里注入 DOM，
 * 开发模式的双次挂载 / 卸载会让播放器闪一下再重建。
 *
 * 首帧之前先套上深色色板（播放页固定深色，不跟主窗口明暗主题），
 * 强调色取主窗口当前那一份；主进程还没上报过就退回本地存的偏好，
 * 避免打开播放窗时先闪一下别的配色。
 */
async function boot(): Promise<void> {
  let accentKey = readStoredAccent().key
  try {
    const appearance = await window.api.appearance.get()
    if (appearance) accentKey = appearance.accent
  } catch {
    // 主进程还没上报过外观：下面沿用本地存的强调色
  }
  applyPlayerAppearance(findAccent(accentKey))
  createRoot(document.getElementById('player-root')!).render(
    <PlayerApp initialAccent={accentKey} />
  )
}

void boot()
