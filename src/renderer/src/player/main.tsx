import { createRoot } from 'react-dom/client'
import PlayerApp from './PlayerApp'
import './player.css'

// 播放页不挂 StrictMode：ArtPlayer 会往容器里注入 DOM，
// 开发模式的双次挂载 / 卸载会让播放器闪一下再重建。
createRoot(document.getElementById('player-root')!).render(<PlayerApp />)
