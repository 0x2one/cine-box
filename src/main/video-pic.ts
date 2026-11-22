/**
 * 视频封面的选图规则，采集重算、批量清洗与渲染层换源共用。
 *
 * 默认 pic 来源（站点 id）非空时，优先用这个站点来源的 pic；找不到（站点没有该视频的来源，
 * 或来源 pic 为空）就回落到原来的规则：主来源优先、为空再依次看其它来源。
 */

/** 只取选图需要的两个字段，避免和 video-cache-store 的行类型互相引用 */
export interface PicSource {
  siteId: string
  pic: string
}

export function resolvePic(sources: PicSource[], preferredSiteId: string): string {
  if (preferredSiteId) {
    const preferred = sources.find((source) => source.siteId === preferredSiteId && source.pic)
    if (preferred) return preferred.pic
  }
  const primary = sources[0]
  const own = primary?.pic ?? ''
  if (own) return own
  return sources.find((source) => source.pic)?.pic ?? own
}

/**
 * 封面加载失败时的候选列表：按默认 pic 来源优先、其余保持来源顺序，去重去空。
 * 不在此处的调用方（比如人工换的封面）由 `pic` 字段单独表达。
 */
export function picCandidates(sources: PicSource[], preferredSiteId: string): string[] {
  const ordered = preferredSiteId
    ? [...sources].sort(
        (left, right) =>
          Number(right.siteId === preferredSiteId) - Number(left.siteId === preferredSiteId)
      )
    : sources
  const result: string[] = []
  const seen = new Set<string>()
  for (const source of ordered) {
    const pic = source.pic.trim()
    if (!pic || seen.has(pic)) continue
    seen.add(pic)
    result.push(pic)
  }
  return result
}
