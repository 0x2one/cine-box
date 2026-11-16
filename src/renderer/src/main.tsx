import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import App from './App'
import ThemeProvider from './theme/ThemeProvider'
import { applyStoredAppearance } from './theme/appearance'

// 本项目仅支持中文：全局固定中文语言包，不做语言切换
dayjs.locale('zh-cn')

// 首帧前写入主题，避免深色模式下先闪一下浅色
applyStoredAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
)
