/** 播放地址判定：和桌面播放页 `player-data.ts` 的 isM3u8 保持同一口径 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isHlsUrl(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.pathname.toLowerCase().endsWith('.m3u8')) return true
  } catch {
    // 不是标准 URL 时退回正则判断
  }
  return /\.m3u8(?:[?#]|$)/i.test(text)
}
