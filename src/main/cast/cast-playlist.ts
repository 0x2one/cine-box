/**
 * 把 HLS master playlist 压成一条媒体播放列表。
 *
 * 真机实测：DLNA 渲染器对 master playlist 的支持很差，会把它当媒体列表、
 * 把每个变体的地址当成分片去拉（日志里能看到 5 个 `#EXT-X-STREAM-INF` 的
 * 子列表全被请求了一遍），最后停在暂停态。缓存包是媒体列表，所以一直正常。
 *
 * 投屏前先用主进程的 fetch 取一次；如果确实是 master，就挑一条变体（优先
 * ≤1080p 里分辨率最高 / 码率最大的），把变体地址交给电视。取不到或本来
 * 就是媒体列表时原样返回，不打断投屏。
 */

import { PROXY_USER_AGENT } from '../lan/lan-proxy'
import type { CastFetch } from './cast-types'

const MAX_PLAYLIST_BYTES = 1024 * 1024
const TIMEOUT_MS = 8000
const MAX_HEIGHT = 1080

interface Variant {
  url: string
  bandwidth: number
  height: number
}

function pickVariant(lines: string[], base: string): string | null {
  const variants: Variant[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF')) continue
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1] ?? 0)
    const height = Number(/RESOLUTION=\d+x(\d+)/i.exec(line)?.[1] ?? 0)
    let cursor = index + 1
    while (cursor < lines.length) {
      const next = lines[cursor].trim()
      if (next && !next.startsWith('#')) break
      cursor += 1
    }
    const uri = lines[cursor]?.trim()
    if (!uri || uri.startsWith('#')) continue
    try {
      variants.push({ url: new URL(uri, base).href, bandwidth, height })
    } catch {
      // 相对地址解析失败就跳过这条
    }
  }
  if (variants.length === 0) return null

  const prefer = variants.filter((item) => item.height > 0 && item.height <= MAX_HEIGHT)
  const pool = prefer.length > 0 ? prefer : variants
  pool.sort((left, right) => {
    if (right.height !== left.height) return right.height - left.height
    return right.bandwidth - left.bandwidth
  })
  return pool[0].url
}

export async function resolveMediaPlaylist(fetchFn: CastFetch, url: string): Promise<string> {
  try {
    let referer = ''
    try {
      referer = `${new URL(url).origin}/`
    } catch {
      // 地址不合法时交给代理层报错
    }
    const response = await fetchFn(url, {
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        'User-Agent': PROXY_USER_AGENT,
        ...(referer ? { Referer: referer } : {})
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) return url
    const text = await response.text()
    if (text.length > MAX_PLAYLIST_BYTES) return url
    if (!/#EXT-X-STREAM-INF/i.test(text)) return url
    const variant = pickVariant(text.split(/\r?\n/), response.url || url)
    return variant ?? url
  } catch {
    return url
  }
}
