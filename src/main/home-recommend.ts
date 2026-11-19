import type { SourceCategoryPath } from './binding-store'
import type { VideoCategory } from './category-store'
import type { HomeActionResult, HomeConfig } from './home-types'

/** 视频某一路来源命中的在线分类，配上它绑定的本地分类 */
export interface VideoSourceCategory {
  videoId: number
  siteId: string
  /** 采集库里的在线分类 id，等于 site_categories.source_id */
  categoryId: string
}

export interface RecommendSyncInput {
  config: HomeConfig
  categories: VideoCategory[]
  /** 全部「站点 + 在线分类 → 本地分类」绑定 */
  bindings: SourceCategoryPath[]
  /** 取这些视频的来源分类，以及缓存里还查得到的那些（查不到的保留原样，等用户自己处理） */
  loadVideoData: (videoIds: number[]) => {
    sources: VideoSourceCategory[]
    knownVideoIds: number[]
  }
  move: (fromCategoryId: string, toCategoryId: string | null, videoId: number) => HomeActionResult
}

/** 子分类沿父链走到一级分类：推荐是按大类组织的，绑在「电影 / 动作片」就算「电影」 */
function topCategoryOf(byId: Map<string, VideoCategory>, categoryId: string): string {
  const guard = new Set<string>()
  let cursor = byId.get(categoryId)
  while (cursor?.parentId) {
    if (guard.has(cursor.id)) break
    guard.add(cursor.id)
    const parent = byId.get(cursor.parentId)
    if (!parent) break
    cursor = parent
  }
  return cursor?.id ?? categoryId
}

/**
 * 视频 → 它所属的本地一级分类（按绑定关系推导，顺序跟分类树一致）。
 * 「推荐到首页」只能进这些分类；绑定变了推荐要跟着搬家，彻底解绑就删掉。
 */
export function boundTopCategories(
  categories: VideoCategory[],
  bindings: SourceCategoryPath[],
  sources: VideoSourceCategory[]
): Map<number, string[]> {
  const result = new Map<number, string[]>()
  if (sources.length === 0) return result
  const byId = new Map(categories.map((category) => [category.id, category]))
  const order = new Map(categories.map((category, index) => [category.id, index]))
  const bindingTop = new Map<string, string>()
  for (const row of bindings) {
    bindingTop.set(
      `${row.siteId}\u0000${row.sourceCategoryId}`,
      topCategoryOf(byId, row.categoryId)
    )
  }
  for (const source of sources) {
    const top = bindingTop.get(`${source.siteId}\u0000${source.categoryId}`)
    if (!top) continue
    const list = result.get(source.videoId) ?? []
    if (!list.includes(top)) list.push(top)
    result.set(source.videoId, list)
  }
  for (const list of result.values()) {
    list.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
  }
  return result
}

/**
 * 绑定 / 分类结构变了之后，把推荐条目挪到视频现在所属的大类：
 * 还绑着别的分类就搬过去（保留原来的覆盖字段），彻底解绑的直接从推荐里删掉。
 * 只处理人工指定的条目（`pinned`），latest 里自动出现的条目不动。
 */
export function syncRecommendations(input: RecommendSyncInput): void {
  const pinned: { categoryId: string; videoId: number }[] = []
  for (const section of input.config.sections) {
    for (const item of section.items) {
      if (item.pinned && !item.removed) {
        pinned.push({ categoryId: section.categoryId, videoId: item.videoId })
      }
    }
  }
  if (pinned.length === 0) return
  const videoIds = [...new Set(pinned.map((row) => row.videoId))]
  const { sources, knownVideoIds } = input.loadVideoData(videoIds)
  const known = new Set(knownVideoIds)
  const bound = boundTopCategories(input.categories, input.bindings, sources)
  for (const row of pinned) {
    if (!known.has(row.videoId)) continue
    const targets = bound.get(row.videoId) ?? []
    if (targets.includes(row.categoryId)) continue
    input.move(row.categoryId, targets[0] ?? null, row.videoId)
  }
}
