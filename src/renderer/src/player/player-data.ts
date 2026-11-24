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
  /**
   * 线路名（采集站给的 flag，如 jjm3u8）。播放页只播 m3u8，它跟「播放类型」没区别，
   * 界面上不再展示，只留在数据里方便排查。
   */
  flag: string
  /** playLines 里的原始下标 */
  index: number
  episodes: PlayerEpisode[]
}

/** 一个资源站下的所有 m3u8 线路：面板按站分组，同一站有多条时才用 ① ② 区分 */
export interface PlayerSourceGroup {
  sourceId: number
  sourceName: string
  lines: PlayerLine[]
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

/** 圆圈数字：① … ⑳，超过 20 条线路时退回 (21) 这种写法 */
const CIRCLED = [
  '①',
  '②',
  '③',
  '④',
  '⑤',
  '⑥',
  '⑦',
  '⑧',
  '⑨',
  '⑩',
  '⑪',
  '⑫',
  '⑬',
  '⑭',
  '⑮',
  '⑯',
  '⑰',
  '⑱',
  '⑲',
  '⑳'
]

export function circledNumber(value: number): string {
  return CIRCLED[value - 1] ?? `(${value})`
}

/**
 * 线路按资源站分组，顺序沿用详情里的来源顺序。
 * 正常情况下一个站只有一条 m3u8 线路，分组只是为了让标题稳定显示「资源站名」。
 */
export function groupBySource(lines: PlayerLine[]): PlayerSourceGroup[] {
  const groups: PlayerSourceGroup[] = []
  const index = new Map<number, PlayerSourceGroup>()
  for (const line of lines) {
    let group = index.get(line.sourceId)
    if (!group) {
      group = { sourceId: line.sourceId, sourceName: line.sourceName, lines: [] }
      index.set(line.sourceId, group)
      groups.push(group)
    }
    group.lines.push(line)
  }
  return groups
}

/** 集数排序：倒序 = 最新一集在前（默认），正序 = 第 1 集在前 */
export type EpisodeOrder = 'asc' | 'desc'

export const EPISODE_ORDER_KEY = 'player-episode-order'

/** 读集数排序偏好；没存过或者值不合法都按倒序 */
export function readEpisodeOrder(): EpisodeOrder {
  return localStorage.getItem(EPISODE_ORDER_KEY) === 'asc' ? 'asc' : 'desc'
}

/**
 * 打开视频但调用方没指定具体集数时，默认播排序后的第一格：
 * 倒序就是最新一集，正序就是第 1 集。
 */
export function firstEpisodeIndex(episodes: PlayerEpisode[], order: EpisodeOrder): number {
  if (episodes.length <= 1) return 0
  return order === 'desc' ? episodes.length - 1 : 0
}

/**
 * 同一个资源站里的第几条 m3u8 线路（1 起）；该站只有一条（绝大多数情况）时返回 0。
 * 面板只在多线路站给 chip 补 ① ②，单线路站不需要区分。
 */
export function lineOrdinal(line: PlayerLine, groups: PlayerSourceGroup[]): number {
  const group = groups.find((item) => item.sourceId === line.sourceId)
  if (!group || group.lines.length <= 1) return 0
  return group.lines.findIndex((item) => item.key === line.key) + 1
}

/**
 * 线路显示名：{资源站名}；同一个站有多条 m3u8 线路时补成「{资源站名} · ①」。
 * 播放类型（原 flag）不参与命名。
 */
export function lineName(line: PlayerLine, groups: PlayerSourceGroup[]): string {
  const ordinal = lineOrdinal(line, groups)
  return ordinal > 0 ? `${line.sourceName} · ${circledNumber(ordinal)}` : line.sourceName
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

/**
 * 剧集头部「正在播放」用的短标签：认得出集数就写「第 N 集」，
 * 认不出（正片 / 预告之类）才退回原始集名。
 */
export function currentEpisodeLabel(name: string, index: number): string {
  const text = name.trim()
  const numbered = text.match(/第\s*(\d+)\s*[集话期回]/) ?? text.match(/^(\d+)$/)
  if (numbered) return `第 ${Number(numbered[1])} 集`
  return text || `第 ${index + 1} 集`
}

/** 标题栏里显示的集数：优先用原始集名，没有就按序号补一个 */
export function episodeTitle(name: string, index: number): string {
  const text = name.trim()
  return text || `第 ${index + 1} 集`
}
