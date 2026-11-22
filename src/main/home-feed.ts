import type { VideoCategory } from './category-store'
import {
  HOME_DEFAULT_TOP_N,
  type HomeConfig,
  type HomeFeed,
  type HomeFeedView,
  type HomeItemFields,
  type HomeItemView,
  type HomeSearchConfig,
  type HomeSearchView,
  type HomeSectionItem,
  type HomeSectionView
} from './home-types'
import type { VideoListItem, VideoListQuery, VideoListResult } from './video-types'

export interface HomeFeedDeps {
  config: HomeConfig
  /** 全部分类的当前状态（含隐藏的，控制台要显示分类本身的开关） */
  categories: VideoCategory[]
  /** 某个本地分类绑定的在线分类 */
  bindingsFor: (categoryId: string) => { siteId: string; sourceId: string }[]
  /** 按 id 批量取视频：海报与推荐条目可能不在分类的前 100 条里 */
  videosByIds: (videoIds: number[]) => VideoListItem[]
  listVideos: (
    query: VideoListQuery,
    filters: { siteId: string; categoryId: string }[]
  ) => VideoListResult
  /** 缓存库不可用时只用配置里的覆盖字段渲染，视频一律标成已丢失 */
  cacheReady: boolean
}

function emptyItem(videoId: number): HomeSectionItem {
  return {
    videoId,
    removed: false,
    pinned: false,
    title: '',
    note: '',
    actors: '',
    intro: '',
    pic: '',
    crop: { x: 0, y: 0, w: 1, h: 1 },
    hidden: false
  }
}

function toView(
  item: HomeItemFields & { videoId: number },
  video: VideoListItem | undefined,
  pinned = true
): HomeItemView {
  return {
    videoId: item.videoId,
    title: item.title || video?.name || '视频已丢失',
    note: item.note || video?.note || '',
    actors: item.actors || video?.vodActor || '',
    intro: item.intro || video?.introExcerpt || '',
    pic: item.pic || video?.pic || '',
    picCandidates: video?.picCandidates ?? [],
    crop: item.crop,
    customPic: item.pic !== '',
    hidden: item.hidden,
    pinned,
    videoHidden: video?.hidden ?? false,
    missing: !video,
    videoName: video?.name ?? '',
    videoPic: video?.pic ?? '',
    videoNote: video?.note ?? '',
    videoActors: video?.vodActor ?? '',
    videoIntro: video?.introExcerpt ?? '',
    latestTime: video?.latestTime ?? '',
    vodClass: video?.vodClass ?? ''
  }
}

/** 一级分类及其整棵子树：首页的大类要把它下面的子分类视频都算进来 */
function subtreeIds(categories: VideoCategory[], rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const category of categories) {
    if (!category.parentId) continue
    const list = children.get(category.parentId) ?? []
    list.push(category.id)
    children.set(category.parentId, list)
  }
  const result: string[] = []
  const queue = [rootId]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return result
}

/** 搜索页底部推荐的构建依赖：没有分类，直接按整库取片 */
export interface HomeSearchFeedDeps {
  config: HomeSearchConfig
  videosByIds: (videoIds: number[]) => VideoListItem[]
  listVideos: (
    query: VideoListQuery,
    filters: { siteId: string; categoryId: string }[]
  ) => VideoListResult
  cacheReady: boolean
}

/**
 * 搜索页初始状态底部的推荐位：规则与分类推荐一致。
 * latest 先放人工指定的，再按更新时间补满 topN；manual 只显示人工列表。
 */
export function buildSearchSection(deps: HomeSearchFeedDeps): HomeSearchView {
  const { config } = deps
  const allVideoIds = new Set(config.items.map((item) => item.videoId))
  const videos = new Map<number, VideoListItem>()
  if (deps.cacheReady && allVideoIds.size > 0) {
    for (const video of deps.videosByIds([...allVideoIds])) videos.set(video.id, video)
  }

  if (config.rule === 'manual') {
    const views = config.items
      .filter((item) => !item.removed)
      .map((item) => toView(item, videos.get(item.videoId)))
    return {
      rule: config.rule,
      topN: config.topN,
      customized: config.customized === true,
      total: views.length,
      items: views,
      removedItems: []
    }
  }

  const pinned = config.items.filter((item) => !item.removed && item.pinned)
  const removed = config.items.filter((item) => item.removed)
  const overrides = new Map(config.items.map((item) => [item.videoId, item]))
  const pinnedIds = new Set(pinned.map((item) => item.videoId))
  const removedIds = new Set(removed.map((item) => item.videoId))

  let rows: VideoListItem[] = []
  if (deps.cacheReady) {
    // 不要总数：分类里的视频数要单独查（`videos:count`），见 HomeSectionView.total 的说明
    const result = deps.listVideos({ pageSize: 100, visibility: 'shown', withTotal: false }, [])
    if (result.ok) rows = result.items
  }
  const auto = rows
    .filter((video) => !pinnedIds.has(video.id) && !removedIds.has(video.id))
    // 自动条目也可能被改过隐藏 / 图片 / 文案，覆盖照常生效，但不会因此插到前面
    .map((video) => toView(overrides.get(video.id) ?? emptyItem(video.id), video, false))

  return {
    rule: config.rule,
    topN: config.topN,
    customized: config.customized === true,
    total: 0,
    items: [
      ...pinned.map((item) => toView(item, videos.get(item.videoId))),
      // 人工指定的全部保留，自动条目只补到 topN
      ...auto.slice(0, Math.max(0, config.topN - pinned.length))
    ],
    removedItems: removed.map((item) => toView(item, videos.get(item.videoId)))
  }
}

/**
 * 把首页配置、分类绑定与视频缓存库拼成首页要用的数据。
 * 控制台读同一份结果，所以「已移除 / 已隐藏 / 视频已丢失」在两边看到的完全一致。
 * view = 'display' 时只构建推荐页真正会渲染的那部分（见 HomeFeedView 的说明）。
 */
export function buildHomeFeed(deps: HomeFeedDeps, view: HomeFeedView = 'console'): HomeFeed {
  const { config, categories } = deps
  const display = view === 'display'

  const allVideoIds = new Set<number>()
  for (const poster of config.posters) allVideoIds.add(poster.videoId)
  for (const section of config.sections) {
    for (const item of section.items) allVideoIds.add(item.videoId)
  }
  const videos = new Map<number, VideoListItem>()
  if (deps.cacheReady && allVideoIds.size > 0) {
    for (const video of deps.videosByIds([...allVideoIds])) videos.set(video.id, video)
  }

  const posters = config.posters.map((poster) => toView(poster, videos.get(poster.videoId)))

  const topLevel = categories
    .filter((category) => category.parentId === null)
    .sort((left, right) => left.sortOrder - right.sortOrder)
  const sections: HomeSectionView[] = []
  for (const category of topLevel) {
    const stored = config.sections.find((section) => section.categoryId === category.id)
    const visible = stored?.visible ?? true
    const title = stored?.title ?? ''
    const rule = stored?.rule ?? 'latest'
    const topN = stored?.topN ?? HOME_DEFAULT_TOP_N
    const items = stored?.items ?? []
    // 推荐页只算真正会显示的轨道：控制台要列出隐藏的那几条，好在设置里重新打开
    if (display && (!visible || !category.visible)) continue

    if (rule === 'manual') {
      const views = items
        .filter((item) => !item.removed)
        .map((item) => toView(item, videos.get(item.videoId)))
      sections.push({
        categoryId: category.id,
        name: category.name,
        title: title || category.name,
        visible,
        categoryVisible: category.visible,
        rule,
        topN,
        customized: stored?.customized === true,
        // 自定义轨道的就是这份列表，条数是白给的；TOP 轨道见下面的说明
        total: views.length,
        items: views,
        removedItems: []
      })
      continue
    }

    // latest：人工指定（推荐 / 排过序）的排前面，剩下按更新时间补满 topN
    const pinned = items.filter((item) => !item.removed && item.pinned)
    const removed = items.filter((item) => item.removed)
    const overrides = new Map(items.map((item) => [item.videoId, item]))
    const pinnedIds = new Set(pinned.map((item) => item.videoId))
    const removedIds = new Set(removed.map((item) => item.videoId))

    const filters: { siteId: string; categoryId: string }[] = []
    const seenFilters = new Set<string>()
    for (const id of subtreeIds(categories, category.id)) {
      for (const binding of deps.bindingsFor(id)) {
        const key = `${binding.siteId}\u0000${binding.sourceId}`
        if (seenFilters.has(key)) continue
        seenFilters.add(key)
        filters.push({ siteId: binding.siteId, categoryId: binding.sourceId })
      }
    }

    let rows: VideoListItem[] = []
    if (deps.cacheReady && filters.length > 0) {
      // 不统计这条轨道的总数：一次 COUNT 在十几万条的视频库上要几十到一百多毫秒，
      // 需要这个数字的地方（控制台分组头部）在页面出来以后单独走 `videos:count`
      const result = deps.listVideos(
        { pageSize: 100, visibility: 'shown', withTotal: false },
        filters
      )
      if (result.ok) rows = result.items
    }
    const auto = rows
      .filter((video) => !pinnedIds.has(video.id) && !removedIds.has(video.id))
      // 自动条目也可能被改过隐藏 / 图片 / 文案，覆盖照常生效，但不会因此插到前面
      .map((video) => toView(overrides.get(video.id) ?? emptyItem(video.id), video, false))

    const views = [
      ...pinned.map((item) => toView(item, videos.get(item.videoId))),
      // 人工指定的全部保留（推荐数 > topN 时也不藏起来），自动条目只补到 topN
      ...auto.slice(0, Math.max(0, topN - pinned.length))
    ]

    sections.push({
      categoryId: category.id,
      name: category.name,
      title: title || category.name,
      visible,
      categoryVisible: category.visible,
      rule,
      topN,
      customized: stored?.customized === true,
      // TOP 轨道的条数要单独数（控制台用 videos:count 补），这里给 0 = 未知
      total: 0,
      items: views,
      // 「已移除」只有控制台那条可展开的胶囊在用，推荐页不渲染
      removedItems: display ? [] : removed.map((item) => toView(item, videos.get(item.videoId)))
    })
  }

  // 配置里有、分类已被删掉的段落不再展示；配置本身留在文件里，重建同名分类时不受影响
  const feed: HomeFeed = { posters, sections }
  // 搜索推荐位只有搜索页 / 控制台用，推荐页不显示它，也就不为它再查一次全库
  if (!display) {
    feed.search = buildSearchSection({
      config: config.search,
      videosByIds: deps.videosByIds,
      listVideos: deps.listVideos,
      cacheReady: deps.cacheReady
    })
  }
  return feed
}
