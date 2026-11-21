/**
 * 播放页的数据整理：把详情里的线路摊平成「一条线路 = 一组 m3u8 剧集」。
 * 播放源只接受 HLS（.m3u8），其余格式在这里就被过滤掉，播放器不会拿到 mp4 / flv。
 */

export interface PlayerEpisode {
  /** 线路里的原始下标：播放载荷按它定位，过滤掉非 m3u8 后也不会错位 */
  index: number
  name: string
  url: string
}

export interface PlayerLine {
  /** `${sourceId}-${lineIndex}`，同一个视频里唯一 */
  key: string
  sourceId: number
  sourceName: string
  /** 线路名（采集站给的 flag），空串表示默认线路 */
  flag: string
  /** playLines 里的原始下标 */
  index: number
  episodes: PlayerEpisode[]
}

export function isM3u8(url: string): boolean {
  const value = url.trim()
  if (!value) return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.pathname.toLowerCase().endsWith('.m3u8')) return true
  } catch {
    // 不是标准 URL 时退回正则判断
  }
  return /\.m3u8(?:[?#]|$)/i.test(value)
}

/** 详情 → 可播放线路：没有 m3u8 剧集的线路直接丢掉 */
export function buildLines(sources: VideoDetailSource[]): PlayerLine[] {
  const lines: PlayerLine[] = []
  for (const source of sources) {
    const playLines = source.detail?.playLines ?? []
    playLines.forEach((line, lineIndex) => {
      const episodes: PlayerEpisode[] = []
      line.episodes.forEach((episode, index) => {
        const url = episode.url.trim()
        if (!isM3u8(url)) return
        episodes.push({
          index,
          name: episode.name.trim(),
          url
        })
      })
      if (episodes.length === 0) return
      lines.push({
        key: `${source.id}-${lineIndex}`,
        sourceId: source.id,
        sourceName: source.siteName,
        flag: line.flag.trim(),
        index: lineIndex,
        episodes
      })
    })
  }
  return lines
}

/** 线路名：同名线路（不同来源都叫「线路一」）带上站点名区分 */
export function lineLabels(lines: PlayerLine[]): Map<string, string> {
  const base = (line: PlayerLine): string => line.flag || '默认线路'
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(base(line), (counts.get(base(line)) ?? 0) + 1)
  return new Map(
    lines.map((line) => [
      line.key,
      (counts.get(base(line)) ?? 0) > 1 ? `${line.sourceName} · ${base(line)}` : base(line)
    ])
  )
}

/**
 * 集数格子里的序号：能认出「第 12 集 / 12」就只显示序号，
 * 认不出（「正片」「HD」这类）才把原名作为小字补在下面。
 */
export function episodeLabel(name: string, index: number): { number: string; caption: string } {
  const text = name.trim()
  const numbered = text.match(/第\s*(\d+)\s*[集话期回]/)
  const plain = text.match(/^(\d+)$/)
  const digits = numbered?.[1] ?? plain?.[1]
  if (digits) return { number: digits.padStart(2, '0'), caption: '' }
  return { number: String(index + 1).padStart(2, '0'), caption: text }
}

/** 标题栏里显示的集数：优先用原始集名，没有就按序号补一个 */
export function episodeTitle(name: string, index: number): string {
  const text = name.trim()
  return text || `第 ${index + 1} 集`
}
