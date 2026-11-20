/** 首页配置与首页数据的主进程类型：IPC、配置库、feed 构建器共用同一套语义 */

/** 首页分类推荐规则：manual 用视频列表里「推荐」进来的视频，latest 按更新时间取前 N 部 */
export type HomeRule = 'manual' | 'latest'

/** 默认的「TOP N」条数 */
export const HOME_DEFAULT_TOP_N = 18
/** TOP N 的上下限：上限是缓存库单次查询能取到的条数 */
export const HOME_MIN_TOP_N = 1
export const HOME_MAX_TOP_N = 50
/** 搜索页底部推荐默认取 8 部；一格 8 张，再多就会换行 */
export const HOME_SEARCH_DEFAULT_TOP_N = 8
export const HOME_SEARCH_MIN_TOP_N = 1
export const HOME_SEARCH_MAX_TOP_N = 24
/** 海报叠层最多放几张，超出没有展示位也没有意义 */
export const HOME_MAX_POSTERS = 24

/**
 * 图片裁剪：原图中要显示的一块区域，按原图宽高归一化到 0–1。
 * 空图片（pic 为空）时忽略；自定义图片时由控制台的裁剪器生成。
 */
export interface HomeCrop {
  x: number
  y: number
  w: number
  h: number
}

/** 条目的展示覆盖字段：空串表示沿用视频库里的值 */
export interface HomeItemFields {
  /** 首页上显示的片名，空串用视频名 */
  title: string
  /** 更新进度 / 一句话备注 */
  note: string
  actors: string
  intro: string
  /** 自定义图片地址：http(s) 或 cine-img://home/<文件名>，空串表示用视频封面 */
  pic: string
  crop: HomeCrop
  /** 在首页隐藏（配置里仍保留，随时可以恢复） */
  hidden: boolean
}

/** 海报叠层里的一张：顺序就是数组顺序 */
export interface HomePosterItem extends HomeItemFields {
  videoId: number
}

/**
 * 分类推荐里的一条。
 * latest 规则下 removed 表示「从自动列表里排除」，manual 规则下移除直接删条目。
 */
export interface HomeSectionItem extends HomeItemFields {
  videoId: number
  /** 从自动列表里排除 */
  removed: boolean
  /**
   * 是否由人工指定：推荐进来的、手动排过序的排在自动列表前面；
   * 只改过隐藏 / 图片的自动条目仍然是自动条目，不会因此插到最前面。
   */
  pinned: boolean
}

/** 一级分类（首页上的一个大类）的配置 */
export interface HomeSectionConfig {
  categoryId: string
  /** 是否在首页显示 */
  visible: boolean
  /** 首页上的显示名，空串沿用分类名 */
  title: string
  rule: HomeRule
  /** latest 规则下取多少部 */
  topN: number
  /**
   * 「自定义」列表是否被编辑过（加片 / 改信息 / 移除 / 排序 / 清空）。
   * 只有「没编辑过」的列表才会在 TOP → 自定义时被当前 TOP 自动填充，编辑过的不再覆盖。
   */
  customized?: boolean
  items: HomeSectionItem[]
}

/**
 * 搜索页初始状态底部的推荐位：没有分类归属，独立一条轨道。
 * 规则与分类推荐一致：latest 按更新时间取前 N 部，manual 只显示人工加进来的。
 */
export interface HomeSearchConfig {
  rule: HomeRule
  topN: number
  /** 「自定义」列表是否被编辑过，语义同分类推荐 */
  customized?: boolean
  items: HomeSectionItem[]
}

export interface HomeConfig {
  posters: HomePosterItem[]
  /** 只保存配置过的一级分类，没配置的按默认值（显示 / TOP 12）处理 */
  sections: HomeSectionConfig[]
  search: HomeSearchConfig
}

/** 条目 + 视频库解析结果：首页与控制台共用 */
export interface HomeItemView {
  videoId: number
  /** 最终片名：自定义优先，其次视频名，视频不存在时给占位文案 */
  title: string
  note: string
  actors: string
  intro: string
  /** 最终图片：自定义优先，其次视频封面；都为空时由界面画首字占位 */
  pic: string
  crop: HomeCrop
  /** 是否使用自定义图片（决定要不要按 crop 裁剪） */
  customPic: boolean
  hidden: boolean
  /** 是否由配置指定（海报 / 自定义推荐 / 手动排序过的条目）；false 表示 latest 自动带出来的 */
  pinned: boolean
  /** 视频在「视频」页被隐藏，展示端不出现（配置里仍在） */
  videoHidden: boolean
  /** 视频已不在缓存库里（清空缓存或重新采集后 id 变化） */
  missing: boolean
  /** 视频库里的原始值，供控制台「恢复默认」与预览 */
  videoName: string
  videoPic: string
  videoNote: string
  videoActors: string
  videoIntro: string
  latestTime: string
  vodClass: string
}

export interface HomeSectionView {
  categoryId: string
  /** 分类原名 */
  name: string
  /** 首页显示名：自定义优先，其次分类名 */
  title: string
  visible: boolean
  /** 分类本身在展示端被隐藏（分类管理里的开关） */
  categoryVisible: boolean
  rule: HomeRule
  topN: number
  /** 「自定义」列表是否被编辑过：编辑过之后切回自定义不再用 TOP 覆盖 */
  customized: boolean
  /**
   * manual：推荐条数（就是这份列表，白给的）。
   * latest：恒为 0 = 未知——「该分类共 N 部」要为每条轨道跑一次几十到一百多毫秒的统计，
   * 拼 feed 时不算，控制台等页面出来以后单独走 `videos:count` 补上。
   */
  total: number
  items: HomeItemView[]
  /** latest 规则下被移除的视频（只有 console 口径会带，推荐页不渲染它） */
  removedItems: HomeItemView[]
}

/** 搜索页底部推荐：结构跟分类推荐一样，只是没有分类字段 */
export interface HomeSearchView {
  rule: HomeRule
  topN: number
  customized: boolean
  /** manual：推荐条数；latest：0 = 未知（同上，控制台用 `videos:count` 补） */
  total: number
  items: HomeItemView[]
  /** latest 规则下被移除的视频，可以恢复 */
  removedItems: HomeItemView[]
}

/**
 * feed 的两种口径。推荐页只要「能画出来」的东西，控制台要完整数据：
 * - display：不算每个分类的总数（那是每条轨道一次整表 COUNT，十几万条的视频库上
 *   一条就要 200ms 左右）、不构建隐藏 / 分类已隐藏的轨道、不带搜索页推荐位；
 * - console：控制台「推荐」页用，总数、隐藏轨道和搜索推荐 tab 都要。
 */
export type HomeFeedView = 'display' | 'console'

export interface HomeFeed {
  posters: HomeItemView[]
  sections: HomeSectionView[]
  /** 搜索页底部推荐位：只有 console 口径会构建它，推荐页不显示 */
  search?: HomeSearchView
}

export interface HomeSearchResult {
  ok: boolean
  error?: string
  search?: HomeSearchView
}

export interface HomeFeedResult {
  ok: boolean
  error?: string
  feed?: HomeFeed
}

/** 条目可改字段的补丁，未传的字段保持原样 */
export type HomeItemPatch = Partial<HomeItemFields>

export interface HomeActionResult {
  ok: boolean
  /** NOT_FOUND / DUPLICATE / INVALID_INPUT / CACHE_UNAVAILABLE */
  error?: string
}

export interface HomeSectionPatch {
  visible?: boolean
  title?: string
  rule?: HomeRule
  topN?: number
}

/** 搜索页推荐位只有规则和条数可改 */
export interface HomeSearchPatch {
  rule?: HomeRule
  topN?: number
}

export interface HomeImageResult {
  ok: boolean
  canceled?: boolean
  error?: string
  /** cine-img://home/<文件名> */
  url?: string
}
