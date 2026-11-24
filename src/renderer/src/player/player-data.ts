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
 * 采集站偶尔把同一条线路的集名混着写（前面按日期、后面按 E 号，顺序不再可靠），
 * 这时改用集名里的日期挑最晚 / 最早的一集，否则「倒序」会停在中间某集上。
 */
export function firstEpisodeIndex(
  episodes: PlayerEpisode[],
  order: EpisodeOrder,
  naming?: EpisodeNaming
): number {
  const last = episodes.length - 1
  if (last <= 0) return 0

  if (naming?.dated && !naming.sorted) {
    const dated = episodes
      .map((episode, index) => ({ index, at: describeEpisode(episode.name, naming).at }))
      .filter((item): item is { index: number; at: number } => typeof item.at === 'number')
    if (dated.length >= Math.ceil(episodes.length * 0.4)) {
      const sorted = dated.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at))
      return order === 'desc' ? sorted[sorted.length - 1].index : sorted[0].index
    }
  }

  return order === 'desc' ? last : 0
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

/** 集数量词：剧集是「集」，综艺是「期」，动漫偶尔用「话」「回」 */
export type EpisodeUnit = '集' | '话' | '回' | '期' | '部' | '章'

/**
 * 一条线路的集名风格。采集站给的集名五花八门（按缓存里的真实数据）：
 * - 剧集 / 动漫：`第12集` `第01集` `12` `第05-06集`（合集）`第12.5集` `第1话`
 * - 综艺：`第3期`、`20261010`（按播出日期）、`20251223上` / `下`（上下期）、
 *   `20261019第2期加更`、`第3期纯享` / `花絮特辑` / `超前彩蛋` / `先导片`（衍生内容）、
 *   `E306.251221`（日韩综艺：E 号 + 播出日期）
 * - 电影：`正片` `国语` `英语` `TC中字` `HD中字上`（只有一集，名字是语言 / 画质）
 * - 赛事：`美国VS巴拉圭`
 * 格子只有 52px 宽，所以集名要先解析成「主行 + 次行」，不能把原名直接塞进去。
 */
export interface EpisodeNaming {
  /** 量词：取集名里出现最多的那个字，综艺优先用「期」 */
  unit: EpisodeUnit
  /** 集名以播出日期为主（综艺按天更新），格子里直接显示 10.15 */
  dated: boolean
  /** 日期跨年：格子补一行年份小字，否则同月同日会混 */
  multiYear: boolean
  /** 集名里的日期是单调的（升 / 降都算），区间锚点才敢用日期起名 */
  sorted: boolean
  /** 只有一集（电影 / 单期晚会），头部写「单集」 */
  single: boolean
  /** 整条线路都没有序号（电影的国语 / 粤语 / 正片），头部写「N 个版本」而不是「N 集」 */
  textOnly: boolean
}

/** 一个剧集格子的内容 */
export interface EpisodeLabel {
  /** 主行：`01` `12.5` `05-06` `10.15` `306`，电影是「国语」这类文字 */
  main: string
  /** 次行小字：`上` `下` `加更` `花絮` `2023` `OVA` */
  caption: string
  /** 主行是文字：字号收一档，允许折两行 */
  text: boolean
  /** 头部「正在播放」用：`第 12 期` / `2026-10-15` / `国语` */
  spoken: string
  /** 集名里的播出日期（MM.DD），按日期排的线路用它给区间锚点起名 */
  date?: string
  /** 播出日期的排序键（YYYYMMDD），「倒序播最新一集」靠它挑，跨年也错不了 */
  at?: number
}

interface EpisodeDate {
  /** MM.DD：格子主行 */
  md: string
  /** YYYY-MM-DD：「正在播放」和提示用 */
  full: string
  year: number
}

/** 集名解析出来的零件 */
interface ParsedEpisode {
  /** 主序号（数字集号 / 区间起点 / E 号）；纯文字集名没有 */
  number?: string
  /** 区间终点（第 05-06 集） */
  end?: string
  unit?: EpisodeUnit
  /** `EP` / `OVA` / `OAD` / `SP` / `E` 前缀 */
  prefix?: string
  date?: EpisodeDate
  /** 序号前面的文字：`白眉大侠66` → 「白眉大侠」 */
  text?: string
  /** 修饰词：上 / 下 / 中 / 加更 / 纯享 / 花絮 … */
  variant?: string
  /** 除序号外的说明文字 */
  extra?: string
  /** 整理后的原名 */
  raw: string
}

const UNIT_CHARS = '集话回期部章'

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
}

/** 综艺分类（含赛事）：量词和「按日期排」的判断都靠它 */
const VARIETY_CATEGORY = /综艺|赛事|足球|篮球|体育|晚会|盛典/

function pad2(value: string | number): string {
  const text = String(value)
  return text.length >= 2 ? text : `0${text}`
}

function trimZero(text: string): string {
  return text.replace(/^0+(?=\d)/, '')
}

function makeDate(year: number, month: number, day: number): EpisodeDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return {
    md: `${pad2(month)}.${pad2(day)}`,
    full: `${year}-${pad2(month)}-${pad2(day)}`,
    year
  }
}

/** 排序键：YYYYMMDD 的数字，比字符串快也比 MM.DD 准（跨年不会把 12.31 当成最新） */
function stamp(date?: EpisodeDate): number | undefined {
  return date
    ? date.year * 10000 + Number(date.md.slice(0, 2)) * 100 + Number(date.md.slice(3))
    : undefined
}

/** 中文数字集名（第一部 / 第二十集） */
function chineseNumber(text: string): number | null {
  let total = 0
  let current = 0
  for (const char of text) {
    if (char === '百') {
      total += (current || 1) * 100
      current = 0
    } else if (char === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (CN_DIGITS[char] !== undefined) {
      current = CN_DIGITS[char]
    } else {
      return null
    }
  }
  const value = total + current
  return value > 0 ? value : null
}

/** 集名里的播出日期：`2026-10-15` / `2026年10月15日` / `20261015`（容忍多一位的录入笔误） */
function findDate(text: string): { date: EpisodeDate; start: number; end: number } | null {
  const separated = /((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/.exec(text)
  const compact = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})\d?(?!\d)/.exec(text)
  const candidates: { date: EpisodeDate; start: number; end: number }[] = []
  if (separated) {
    const date = makeDate(Number(separated[1]), Number(separated[2]), Number(separated[3]))
    if (date) {
      candidates.push({ date, start: separated.index, end: separated.index + separated[0].length })
    }
  }
  if (compact) {
    const date = makeDate(Number(compact[1]), Number(compact[2]), Number(compact[3]))
    if (date) {
      candidates.push({ date, start: compact.index, end: compact.index + compact[0].length })
    }
  }
  return candidates.sort((a, b) => a.start - b.start)[0] ?? null
}

/** 去掉已识别的那一段，剩下的文字再找修饰词 */
function cutAt(text: string, start: number, end: number): string {
  return `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, ' ').trim()
}

/** 已知的衍生内容修饰词，长词在前，命中就收成两个字 */
const VARIANTS: [RegExp, string][] = [
  [/花絮特辑|花絮/, '花絮'],
  [/超前彩蛋|彩蛋/, '彩蛋'],
  [/还有加更|加更版|加更/, '加更'],
  [/加时营业|加时/, '加时'],
  [/回顾特辑|回顾/, '回顾'],
  [/特别企划|企划/, '企划'],
  [/搜证事件簿|搜证/, '搜证'],
  [/重置版|重置/, '重置'],
  [/收官宴|收官/, '收官'],
  [/先导片|先导/, '先导'],
  [/复盘局|复盘/, '复盘'],
  [/纯享版|纯享/, '纯享'],
  [/会员版|会员/, '会员'],
  [/未删减|未删/, '未删'],
  [/俱乐部/, '俱乐部'],
  [/大神/, '大神'],
  [/付费/, '付费'],
  [/衍生/, '衍生'],
  [/正片/, '正片'],
  [/预告/, '预告'],
  [/特辑/, '特辑']
]

const TRIM = /^[\s·、,，:：\-—|/（）()【\]]+|[\s·、,，:：\-—|/（）()【\]]+$/g

/** 上下期里的那个字：首尾优先，其次是两侧带分隔符的 */
function findDirection(text: string): { index: number; label: string } | null {
  const head = /^[上中下]/.exec(text)
  if (head) return { index: 0, label: head[0] }
  const tail = /[上中下]$/.exec(text)
  if (tail) return { index: text.length - 1, label: tail[0] }
  return null
}

/**
 * 修饰词：`上` `下` `中`（上下期）能和已知词同时出现，按在原文里的先后拼起来——
 * `20261010第1期上·慢速…纯享` → `上纯享`，`20261001先导片下` → `先导下`。
 * 尾巴上的数字（第10期上1 / 上2）是站点自己区分用的，跟着方向字一起留下。
 */
function readVariant(leftover: string): string {
  const raw = leftover.replace(TRIM, '')
  if (!raw) return ''
  const numbered = /([上中下])\s*(\d{1,2})$/.exec(raw)
  if (numbered) return `${numbered[1]}${numbered[2]}`
  const text = raw.replace(/\d+/g, ' ').replace(/\s+/g, ' ').replace(TRIM, '')
  if (!text) return ''
  const parts: { index: number; label: string }[] = []
  const direction = findDirection(text)
  if (direction) parts.push(direction)
  for (const [pattern, label] of VARIANTS) {
    const match = pattern.exec(text)
    if (match) {
      parts.push({ index: match.index, label })
      break
    }
  }
  const joined = parts
    .sort((a, b) => a.index - b.index)
    .map((part) => part.label)
    .join('')
  return joined.length > 4 ? joined.slice(0, 4) : joined
}

/** 修饰词之外的说明文字（一口气看吕严 / 案上）：去掉数字和分隔符，太长就截断 */
function readExtra(leftover: string): string {
  const text = leftover
    .replace(/\d+/g, ' ')
    // 日期后面常挂一个「期」「集」，它只是量词，不该占小字的位置
    .replace(/[集话期回部章]/g, ' ')
    .replace(/^[\s·、,，:：\-—|/（）()【\]]+|[\s·、,，:：\-—|/（）()【\]]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 8 ? text.slice(0, 8) : text
}

function formatNumber(digits: string): string {
  const [whole, decimal] = digits.split('.')
  return decimal ? `${pad2(trimZero(whole))}.${decimal}` : pad2(trimZero(whole))
}

/** 念出来的序号不用补位：01 → 1，05-06 → 5-6 */
function naturalNumber(text: string): string {
  return text
    .split('-')
    .map((part) => part.replace(/^0+(?=\d)/, ''))
    .join('-')
}

/**
 * 把一个集名拆成零件。顺序很有讲究：先认 `第 N 集` / `第 05-06 集`（综艺里
 * `20261010第1期上` 这种日期 + 期号并存的名字要能拿到期号），再认日期、E 号、
 * 纯数字、带文字的尾巴，最后才是整串当文字。
 */
function parseEpisode(input: string): ParsedEpisode {
  const raw = input
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .trim()
  if (!raw) return { raw: '' }

  const found = findDate(raw)

  const prefixed = /^(EP|OVA|OAD|SP|E)\s*0*(\d{1,4})(?:[.\-_](\d{2})(\d{2})(\d{2}))?/i.exec(raw)
  if (prefixed) {
    const inner = prefixed[3]
      ? makeDate(2000 + Number(prefixed[3]), Number(prefixed[4]), Number(prefixed[5]))
      : null
    const rest = cutAt(raw, prefixed.index, prefixed.index + prefixed[0].length)
    return {
      raw,
      number: formatNumber(prefixed[2]),
      prefix: prefixed[1].toUpperCase(),
      date: inner ?? found?.date,
      variant: readVariant(rest),
      extra: readExtra(rest)
    }
  }

  const range = /第\s*(\d{1,3})\s*[-~～至]\s*(\d{1,3})\s*([集话回期部章])/.exec(raw)
  if (range) {
    const rest = cutAt(raw, range.index, range.index + range[0].length)
    return {
      raw,
      number: formatNumber(range[1]),
      end: formatNumber(range[2]),
      unit: range[3] as EpisodeUnit,
      date: found?.date,
      variant: readVariant(rest),
      extra: readExtra(rest)
    }
  }

  const numbered = /第\s*(\d{1,8}(?:\.\d{1,2})?)\s*([集话回期部章])/.exec(raw)
  if (numbered) {
    const digits = numbered[1]
    const asDate =
      digits.length === 8
        ? makeDate(
            Number(digits.slice(0, 4)),
            Number(digits.slice(4, 6)),
            Number(digits.slice(6, 8))
          )
        : null
    const rest = cutAt(raw, numbered.index, numbered.index + numbered[0].length)
    return {
      raw,
      number: formatNumber(digits),
      unit: numbered[2] as EpisodeUnit,
      date: asDate ?? found?.date,
      variant: readVariant(rest),
      extra: readExtra(rest)
    }
  }

  const chinese = /第\s*([一二三四五六七八九十百零两]+)\s*([集话回期部章])/.exec(raw)
  if (chinese) {
    const value = chineseNumber(chinese[1])
    if (value) {
      const rest = cutAt(raw, chinese.index, chinese.index + chinese[0].length)
      return {
        raw,
        number: formatNumber(String(value)),
        unit: chinese[2] as EpisodeUnit,
        date: found?.date,
        variant: readVariant(rest),
        extra: readExtra(rest)
      }
    }
  }

  if (found) {
    const rest = cutAt(raw, found.start, found.end)
    return { raw, date: found.date, variant: readVariant(rest), extra: readExtra(rest) }
  }

  const plain = /^(\d{1,5}(?:\.\d{1,2})?)$/.exec(raw)
  if (plain) return { raw, number: formatNumber(plain[1]) }

  // 文字 + 结尾数字：白眉大侠66 / 感动篇2 / 春晚特别节目2
  const trailing = /^(.{1,12}?)\s*0*(\d{1,4})$/.exec(raw)
  if (trailing && !/^\d/.test(trailing[1])) {
    return { raw, number: formatNumber(trailing[2]), text: trailing[1].trim() }
  }

  return { raw }
}

/** 一条线路的集名风格：量词、是否按日期排、是否跨年、是否只有一集 */
export function analyzeNaming(names: string[], category = ''): EpisodeNaming {
  const variety = VARIETY_CATEGORY.test(category)
  const units = new Map<EpisodeUnit, number>()
  const years = new Set<number>()
  let dated = 0
  let numbered = 0
  let previous = ''
  let ascending = true
  let descending = true

  for (const name of names) {
    const parsed = parseEpisode(name)
    if (parsed.number !== undefined || parsed.date) numbered += 1
    if (parsed.date) {
      const current = parsed.date.full
      if (previous) {
        if (current < previous) ascending = false
        if (current > previous) descending = false
      }
      previous = current
      // E306.251221 这类名字靠 E 号识别，日期只是附注，不算「按日期排」
      if (!parsed.prefix) {
        dated += 1
        years.add(parsed.date.year)
      }
    }
    if (parsed.unit && UNIT_CHARS.includes(parsed.unit)) {
      units.set(parsed.unit, (units.get(parsed.unit) ?? 0) + 1)
    }
  }

  // 量词优先听集名的：综艺里也有「第 01 集」的剧集 / 评书，写「共 34 集」比硬掰成「期」准确
  const top = [...units.entries()].sort((a, b) => b[1] - a[1])[0]
  const unit: EpisodeUnit = top?.[0] ?? (variety ? '期' : '集')

  return {
    unit,
    dated: names.length > 1 && dated >= Math.max(2, Math.ceil(names.length * 0.4)),
    multiYear: years.size > 1,
    sorted: ascending || descending,
    single: names.length === 1,
    textOnly: names.length > 0 && numbered === 0
  }
}

/** 头部 / 标题栏的集数：单集写「单集」，纯文字线路写「N 个版本」，其余「共 N 期」 */
export function episodeCountLabel(naming: EpisodeNaming, total: number): string {
  if (total <= 0) return ''
  if (total === 1) return `单${naming.unit}`
  if (naming.textOnly) return `共 ${total} 个版本`
  return `共 ${total} ${naming.unit}`
}

/** 纯文字集名（电影语言 / 赛事对阵）：去掉书括号，`|` 两边拆成两行 */
function describeText(parsed: ParsedEpisode): EpisodeLabel {
  const raw = parsed.raw.replace(/^[（(【[]+|[)）】\]]+$/g, '').trim() || parsed.raw
  const [head, ...tail] = raw.split(/[|｜]/)
  const split = /^(.*[^上中下])([上中下])$/.exec(head.trim())
  const main = (split ? split[1] : head).trim()
  const caption = [split?.[2], tail.join(' / ').trim()].filter(Boolean).join(' · ')
  const spoken = caption ? `${main} · ${caption}` : main
  return { main, caption, text: true, spoken, date: parsed.date?.md, at: stamp(parsed.date) }
}

/**
 * 一个格子怎么显示：主行放序号 / 日期 / 文字，次行放修饰词。
 * 按日期排的综艺（dated）优先用日期当主行——`20261010第1期上` 显示成 `10.10 / 上`，
 * 这样同一档节目里「只有日期」和「日期 + 期号」的集名看起来是一致的。
 */
export function describeEpisode(name: string, naming: EpisodeNaming): EpisodeLabel {
  const parsed = parseEpisode(name)
  if (parsed.number === undefined) {
    if (parsed.date) {
      return {
        main: parsed.date.md,
        caption:
          parsed.variant ||
          parsed.text ||
          parsed.extra ||
          (naming.multiYear ? String(parsed.date.year) : ''),
        text: false,
        spoken: parsed.variant ? `${parsed.date.full} · ${parsed.variant}` : parsed.date.full,
        date: parsed.date.md,
        at: stamp(parsed.date)
      }
    }
    return describeText(parsed)
  }

  const unit = parsed.unit ?? naming.unit
  const numberText = parsed.end ? `${parsed.number}-${parsed.end}` : parsed.number
  // 8 位数字的「期号」其实就是日期（第20250205期），当日期用，否则格子会被撑破。
  // E306.251221 这类反过来：E 号才是集名，日期退到小字里
  const longNumber = numberText.replace(/-/g, '').length > 5
  const byDate = parsed.date && !parsed.prefix && (naming.dated || longNumber)

  if (byDate) {
    return {
      main: parsed.date!.md,
      caption:
        parsed.variant ||
        parsed.text ||
        parsed.extra ||
        (naming.multiYear ? String(parsed.date!.year) : ''),
      text: false,
      spoken: parsed.variant ? `${parsed.date!.full} · ${parsed.variant}` : parsed.date!.full,
      date: parsed.date!.md,
      at: stamp(parsed.date!)
    }
  }

  const prefixCaption = parsed.prefix && parsed.prefix.length > 1 ? parsed.prefix : ''
  const caption =
    parsed.variant || prefixCaption || parsed.date?.md || parsed.text || parsed.extra || ''
  const numberSpeech = naturalNumber(numberText)
  const spoken = parsed.prefix
    ? parsed.prefix === 'E'
      ? `第 ${numberSpeech} ${unit}`
      : `${parsed.prefix} ${numberSpeech}`
    : parsed.text
      ? `${parsed.text} ${numberSpeech}`
      : `第 ${numberSpeech} ${unit}`

  return {
    main: numberText,
    caption,
    text: false,
    spoken: parsed.variant ? `${spoken} · ${parsed.variant}` : spoken,
    date: parsed.date?.md,
    at: stamp(parsed.date)
  }
}

/** 标题栏里显示的集数：优先用原始集名，没有就按序号补一个 */
export function episodeTitle(name: string, index: number): string {
  const text = name.trim()
  return text || `第 ${index + 1} 集`
}
