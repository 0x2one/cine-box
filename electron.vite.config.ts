import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // 网页端需要把 hls.js 作为静态资源内联进主进程（?raw）；不排除的话
      // electron-vite 会把它当运行时依赖 external 掉，打包后 require 不到。
      externalizeDeps: { exclude: ['hls.js'] }
    }
  },
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
