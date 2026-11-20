import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // 主界面与独立播放页是两个入口：播放窗加载 out/renderer/player.html
        input: {
          index: resolve('src/renderer/index.html'),
          player: resolve('src/renderer/player.html')
        }
      }
    }
  }
})
