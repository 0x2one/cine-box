import { createHash } from 'crypto'
import appJs from '../../lanweb/lan.js?raw'
import appCss from '../../lanweb/lan.css?raw'
import indexHtml from '../../lanweb/index.html?raw'
import hlsJs from 'hls.js/dist/hls.min.js?raw'

export interface LanAsset {
  body: string
  type: string
  cache: string
}

/**
 * CSS / JS 的地址带内容 hash：
 * - 修网页样式时，浏览器不会继续用旧的 `/assets/lan.css` 缓存；
 * - 资源内容不变时 hash 不变，可以长缓存。
 */
const assetVersion = createHash('sha1').update(appCss).update(appJs).digest('hex').slice(0, 8)

/** 网页端是纯静态的（不进 renderer 构建）：以字符串内联进主进程，打包后可直接从内存服务 */
export const LAN_HTML = indexHtml
  .replace('/assets/lan.css', `/assets/lan.css?v=${assetVersion}`)
  .replace('/assets/lan.js', `/assets/lan.js?v=${assetVersion}`)

export const LAN_ASSETS: Record<string, LanAsset> = {
  '/assets/lan.css': {
    body: appCss,
    type: 'text/css; charset=utf-8',
    cache: 'no-cache'
  },
  '/assets/lan.js': {
    body: appJs,
    type: 'text/javascript; charset=utf-8',
    cache: 'no-cache'
  },
  // 手机浏览器只在播放页按需加载（iOS 原生 HLS 时根本不会用到），单独给长缓存
  '/assets/hls.min.js': {
    body: hlsJs,
    type: 'text/javascript; charset=utf-8',
    cache: 'public, max-age=86400'
  }
}
