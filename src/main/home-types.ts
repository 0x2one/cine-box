/** 首页配置与首页数据的主进程类型：IPC、配置库、feed 构建器共用同一套语义 */

/** 首页分类推荐规则：manual 用视频列表里「推荐」进来的视频，latest 按更新时间取前 N 部 */
export type HomeRule = 'manual' | 'latest'

/** 默认的「TOP N」条数 */
export const HOME_DEFAULT_TOP_N = 12
/** TOP N 的上下限：上限是缓存库单次查询能取到的条数 */
export const HOME_MIN_TOP_N = 1
export const HOME_MAX_TOP_N = 50
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

export interface HomeConfig {
  posters: HomePosterItem[]
  /** 只保存配置过的一级分类，没配置的按默认值（显示 / TOP 12）处理 */
  sections: HomeSectionConfig[]
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
  /** latest：该分类（含子分类）里展示中的视频总数；manual：推荐条数 */
  total: number
  items: HomeItemView[]
  /** latest 规则下被移除的视频 */
  removedItems: HomeItemView[]
}

export interface HomeFeed {
  posters: HomeItemView[]
  sections: HomeSectionView[]
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

export interface HomeImageResult {
  ok: boolean
  canceled?: boolean
  error?: string
  /** cine-img://home/<文件名> */
  url?: string
}
