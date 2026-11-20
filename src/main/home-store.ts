import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import {
  HOME_DEFAULT_TOP_N,
  HOME_MAX_POSTERS,
  HOME_MAX_TOP_N,
  HOME_MIN_TOP_N,
  HOME_SEARCH_DEFAULT_TOP_N,
  HOME_SEARCH_MAX_TOP_N,
  HOME_SEARCH_MIN_TOP_N,
  type HomeActionResult,
  type HomeConfig,
  type HomeCrop,
  type HomeItemFields,
  type HomeItemPatch,
  type HomePosterItem,
  type HomeRule,
  type HomeSearchConfig,
  type HomeSearchPatch,
  type HomeSectionConfig,
  type HomeSectionItem,
  type HomeSectionPatch
} from './home-types'

/** 自定义图片允许的扩展名与大小上限：海报用，超过上限一般也不是海报 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const EMPTY_CROP: HomeCrop = { x: 0, y: 0, w: 1, h: 1 }

interface StoreFile {
  version: 1
  /** 写入时生效的「TOP 默认条数」，用来识别旧默认值并迁移 */
  topDefault?: number
  posters?: unknown
  sections?: unknown
  /** 搜索页底部推荐，老文件没有这一段，读成默认的 TOP 8 */
  search?: unknown
}

/** 早先的默认条数：老配置里没记 topDefault，按这个值判断要不要迁移 */
const LEGACY_TOP_N = 12

export interface HomeStore {
  init: () => Promise<void>
  /** 当前配置的快照（调用方可以随意改，不影响内存里的那份） */
  get: () => HomeConfig
  addPoster: (videoId: number) => HomeActionResult
  updatePoster: (videoId: number, patch: HomeItemPatch) => HomeActionResult
  removePoster: (videoId: number) => HomeActionResult
  reorderPosters: (videoIds: number[]) => HomeActionResult
  saveSection: (categoryId: string, patch: HomeSectionPatch) => HomeActionResult
  addSectionItem: (categoryId: string, videoId: number) => HomeActionResult
  updateSectionItem: (categoryId: string, videoId: number, patch: HomeItemPatch) => HomeActionResult
  removeSectionItem: (categoryId: string, videoId: number) => HomeActionResult
  restoreSectionItem: (categoryId: string, videoId: number) => HomeActionResult
  reorderSectionItems: (categoryId: string, videoIds: number[]) => HomeActionResult
  /** 清空「自定义」轨道的全部推荐；TOP 规则下没有这个动作 */
  clearSectionItems: (categoryId: string) => HomeActionResult
  /**
   * 绑定关系变了以后把一条推荐挪到别的大类（to 为 null 表示直接删掉）。
   * 跟 removeSectionItem 不同：这里不会在 TOP 轨道里留下「已移除」记录。
   */
  moveSectionItem: (
    fromCategoryId: string,
    toCategoryId: string | null,
    videoId: number
  ) => HomeActionResult
  /** 搜索页底部推荐：规则与条数 */
  saveSearch: (patch: HomeSearchPatch) => HomeActionResult
  addSearchItem: (videoId: number) => HomeActionResult
  updateSearchItem: (videoId: number, patch: HomeItemPatch) => HomeActionResult
  removeSearchItem: (videoId: number) => HomeActionResult
  restoreSearchItem: (videoId: number) => HomeActionResult
  reorderSearchItems: (videoIds: number[]) => HomeActionResult
  /** 清空「自定义」的搜索推荐；TOP 规则下没有这个动作 */
  clearSearchItems: () => HomeActionResult
  /**
   * 把用户选中的本地图片复制进配置目录，返回 cine-img:// 地址。
   * 只接受主进程自己弹窗拿到的路径，渲染层不接触文件系统。
   */
  importImage: (sourcePath: string) => { ok: boolean; error?: string; url?: string }
  /** 自定义协议用：把 cine-img://home/<文件名> 还原成本地绝对路径 */
  imageFile: (fileName: string) => string | null
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

function truncate(value: string, max: number): string {
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

function sanitizeCrop(raw: unknown): HomeCrop {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_CROP }
  const source = raw as Partial<Record<keyof HomeCrop, unknown>>
  const w = clamp(Number(source.w), 0.01, 1)
  const h = clamp(Number(source.h), 0.01, 1)
  return {
    x: clamp(Number(source.x), 0, 1 - w),
    y: clamp(Number(source.y), 0, 1 - h),
    w,
    h
  }
}

function sanitizePic(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const url = value.trim()
  if (url === '') return ''
  if (!/^(https?:|cine-img:)/i.test(url)) return fallback
  return truncate(url, 2000)
}

function defaultFields(): HomeItemFields {
  return {
    title: '',
    note: '',
    actors: '',
    intro: '',
    pic: '',
    crop: { ...EMPTY_CROP },
    hidden: false
  }
}

/** 只覆盖传了的字段：undefined 表示保持原样，空串表示清掉覆盖 */
function applyPatch(base: HomeItemFields, patch: HomeItemPatch): HomeItemFields {
  const next: HomeItemFields = { ...base, crop: { ...base.crop } }
  if (typeof patch.title === 'string') next.title = truncate(patch.title, 120)
  if (typeof patch.note === 'string') next.note = truncate(patch.note, 200)
  if (typeof patch.actors === 'string') next.actors = truncate(patch.actors, 500)
  if (typeof patch.intro === 'string') next.intro = truncate(patch.intro, 4000)
  if (typeof patch.pic === 'string') next.pic = sanitizePic(patch.pic, base.pic)
  if (patch.crop) next.crop = sanitizeCrop(patch.crop)
  if (typeof patch.hidden === 'boolean') next.hidden = patch.hidden
  return next
}

function isRule(value: unknown): value is HomeRule {
  return value === 'manual' || value === 'latest'
}

function videoIdOf(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function fieldsFromObject(raw: Record<string, unknown>): HomeItemFields {
  return {
    title: typeof raw.title === 'string' ? truncate(raw.title, 120) : '',
    note: typeof raw.note === 'string' ? truncate(raw.note, 200) : '',
    actors: typeof raw.actors === 'string' ? truncate(raw.actors, 500) : '',
    intro: typeof raw.intro === 'string' ? truncate(raw.intro, 4000) : '',
    pic: sanitizePic(raw.pic, ''),
    crop: sanitizeCrop(raw.crop),
    hidden: raw.hidden === true
  }
}

function clampTopN(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return HOME_DEFAULT_TOP_N
  return Math.round(clamp(n, HOME_MIN_TOP_N, HOME_MAX_TOP_N))
}

function clampSearchTopN(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return HOME_SEARCH_DEFAULT_TOP_N
  return Math.round(clamp(n, HOME_SEARCH_MIN_TOP_N, HOME_SEARCH_MAX_TOP_N))
}

function defaultSearch(): HomeSearchConfig {
  return {
    rule: 'latest',
    topN: HOME_SEARCH_DEFAULT_TOP_N,
    customized: false,
    items: []
  }
}

/** 解析条目数组：分类推荐与搜索推荐共用，顺序就是展示顺序 */
function parseItems(raw: unknown): HomeSectionItem[] {
  const items: HomeSectionItem[] = []
  const seen = new Set<number>()
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const videoId = videoIdOf(record.videoId)
    if (videoId === null || seen.has(videoId)) continue
    seen.add(videoId)
    items.push({
      videoId,
      removed: record.removed === true,
      pinned: record.pinned === true,
      ...fieldsFromObject(record)
    })
  }
  return items
}

function parseSearch(raw: unknown): HomeSearchConfig {
  const record =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>)
  const items = parseItems(record.items)
  const rule: HomeRule = isRule(record.rule) ? record.rule : 'latest'
  return {
    rule,
    topN: clampSearchTopN(record.topN),
    // 语义同分类推荐：自定义列表有内容才算编辑过，空列表切回来仍可用 TOP 自动填充
    customized: items.length > 0 && (record.customized === true || rule === 'manual'),
    items
  }
}

/**
 * 首页配置：单独一个 JSON 文件（userData/Data/Home/home.json），
 * 与业务库、视频缓存库都分开，清空缓存不会连带删掉配置（只是条目变成「视频已丢失」）。
 * 图片放在同目录的 images/ 下，渲染层通过 cine-img://home/<文件名> 引用。
 */
export function createHomeStore(directory: string): HomeStore {
  const file = join(directory, 'home.json')
  const imagesDir = join(directory, 'images')
  let config: HomeConfig = { posters: [], sections: [], search: defaultSearch() }

  function persist(): void {
    const payload: StoreFile = {
      version: 1,
      topDefault: HOME_DEFAULT_TOP_N,
      posters: config.posters,
      sections: config.sections,
      search: config.search
    }
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (error) {
      console.error('首页配置写入失败', error)
    }
  }

  function parseConfig(raw: string): HomeConfig {
    const data = JSON.parse(raw) as StoreFile
    // 文件里记着写入时的默认条数（老文件没有这个字段，那会儿是 12）：
    // 和当前默认值不一样，就把还停在那档的 section 一起抬到新默认值
    const fileDefault = typeof data?.topDefault === 'number' ? data.topDefault : LEGACY_TOP_N
    const migrateTopN = fileDefault !== HOME_DEFAULT_TOP_N
    const posters: HomePosterItem[] = []
    const seenPosters = new Set<number>()
    for (const entry of Array.isArray(data?.posters) ? data.posters : []) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const videoId = videoIdOf(record.videoId)
      if (videoId === null || seenPosters.has(videoId)) continue
      seenPosters.add(videoId)
      posters.push({ videoId, ...fieldsFromObject(record) })
      if (posters.length >= HOME_MAX_POSTERS) break
    }

    const sections: HomeSectionConfig[] = []
    const seenSections = new Set<string>()
    for (const entry of Array.isArray(data?.sections) ? data.sections : []) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const categoryId = typeof record.categoryId === 'string' ? record.categoryId.trim() : ''
      if (!categoryId || seenSections.has(categoryId)) continue
      seenSections.add(categoryId)
      const items = parseItems(record.items)
      const rule: HomeRule = isRule(record.rule) ? record.rule : 'latest'
      sections.push({
        categoryId,
        visible: record.visible !== false,
        title: typeof record.title === 'string' ? truncate(record.title, 60) : '',
        rule,
        // 旧文件里还停在老默认值的，跟着新默认值走；用户自己填的其它值不动
        topN:
          migrateTopN && clampTopN(record.topN) === fileDefault
            ? HOME_DEFAULT_TOP_N
            : clampTopN(record.topN),
        // 自定义列表有内容才算「编辑过」，空列表切回来要能继续用 TOP 自动填充。
        // 老配置没有这个字段时，按「自定义规则下有条目」推断。
        customized: items.length > 0 && (record.customized === true || rule === 'manual'),
        items
      })
    }
    return { posters, sections, search: parseSearch(data?.search) }
  }

  function findSection(categoryId: string): HomeSectionConfig | null {
    return config.sections.find((section) => section.categoryId === categoryId) ?? null
  }

  function ensureSection(categoryId: string): HomeSectionConfig {
    const existing = findSection(categoryId)
    if (existing) return existing
    const created: HomeSectionConfig = {
      categoryId,
      visible: true,
      title: '',
      rule: 'latest',
      topN: HOME_DEFAULT_TOP_N,
      customized: false,
      items: []
    }
    config.sections.push(created)
    return created
  }

  function updateFields<T extends { videoId: number } & HomeItemFields>(
    list: T[],
    videoId: number,
    patch: HomeItemPatch
  ): boolean {
    const item = list.find((entry) => entry.videoId === videoId)
    if (!item) return false
    Object.assign(item, applyPatch(item, patch))
    return true
  }

  /** 自定义列表有了内容才算「编辑过」：空列表切回来还应该能用 TOP 自动填充 */
  function markCustomized(section: {
    rule: HomeRule
    customized?: boolean
    items: HomeSectionItem[]
  }): void {
    if (section.rule === 'manual') section.customized = section.items.length > 0
  }

  /** 往一条轨道里加片：已经存在的条目当成恢复，并按人工推荐放到前面 */
  function addItemTo(section: { items: HomeSectionItem[] }, videoId: number): void {
    const existing = section.items.find((item) => item.videoId === videoId)
    if (existing) {
      existing.removed = false
      existing.pinned = true
    } else {
      section.items.push({ videoId, removed: false, pinned: true, ...defaultFields() })
    }
  }

  /** 按给定顺序排序：不在顺序里的条目留在末尾，恢复后还能看到；没有可排的条目返回 false */
  function orderItems(section: { items: HomeSectionItem[] }, videoIds: number[]): boolean {
    const given = videoIds
      .map((raw) => videoIdOf(raw))
      .filter((value): value is number => value !== null)
    if (given.length === 0) return false
    const items = new Map(section.items.map((item) => [item.videoId, item]))
    const ordered: HomeSectionItem[] = []
    for (const vid of given) {
      // latest 规则里自动带上来的条目没有配置行，排序时就顺手补一行
      const item = items.get(vid) ?? {
        videoId: vid,
        removed: false,
        pinned: false,
        ...defaultFields()
      }
      item.pinned = true
      ordered.push(item)
      items.delete(vid)
    }
    for (const rest of section.items) {
      if (items.has(rest.videoId)) ordered.push(rest)
    }
    section.items = ordered
    return true
  }

  return {
    init: async () => {
      try {
        mkdirSync(imagesDir, { recursive: true })
      } catch {
        // 目录建不出来时后面写文件也会报错，这里不阻塞启动
      }
      try {
        config = parseConfig(readFileSync(file, 'utf-8'))
      } catch {
        config = { posters: [], sections: [], search: defaultSearch() }
      }
    },

    get: () => structuredClone(config),

    addPoster: (videoId) => {
      const id = videoIdOf(videoId)
      if (id === null) return { ok: false, error: 'INVALID_INPUT' }
      if (config.posters.some((item) => item.videoId === id))
        return { ok: false, error: 'DUPLICATE' }
      if (config.posters.length >= HOME_MAX_POSTERS) return { ok: false, error: 'FULL' }
      config.posters.push({ videoId: id, ...defaultFields() })
      persist()
      return { ok: true }
    },

    updatePoster: (videoId, patch) => {
      const id = videoIdOf(videoId)
      if (id === null) return { ok: false, error: 'INVALID_INPUT' }
      if (!updateFields(config.posters, id, patch)) return { ok: false, error: 'NOT_FOUND' }
      persist()
      return { ok: true }
    },

    removePoster: (videoId) => {
      const id = videoIdOf(videoId)
      if (id === null) return { ok: false, error: 'INVALID_INPUT' }
      const before = config.posters.length
      config.posters = config.posters.filter((item) => item.videoId !== id)
      if (config.posters.length === before) return { ok: false, error: 'NOT_FOUND' }
      persist()
      return { ok: true }
    },

    reorderPosters: (videoIds) => {
      const items = new Map(config.posters.map((item) => [item.videoId, item]))
      const ordered: HomePosterItem[] = []
      for (const raw of Array.isArray(videoIds) ? videoIds : []) {
        const id = videoIdOf(raw)
        const item = id === null ? undefined : items.get(id)
        if (!item) continue
        ordered.push(item)
        items.delete(id as number)
      }
      // 没在顺序里出现的（例如刚被别的窗口加进来的）留在末尾，不丢
      for (const rest of config.posters) {
        if (items.has(rest.videoId)) ordered.push(rest)
      }
      config.posters = ordered
      persist()
      return { ok: true }
    },

    saveSection: (categoryId, patch) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      if (!id) return { ok: false, error: 'INVALID_INPUT' }
      if (patch?.rule !== undefined && !isRule(patch.rule)) {
        return { ok: false, error: 'INVALID_INPUT' }
      }
      const section = ensureSection(id)
      if (typeof patch?.visible === 'boolean') section.visible = patch.visible
      if (typeof patch?.title === 'string') section.title = truncate(patch.title, 60)
      if (patch?.rule !== undefined && patch.rule !== section.rule) {
        section.rule = patch.rule
        if (patch.rule === 'latest') {
          // 切回 TOP：自定义列表不能再往 TOP 前面插，列表本身留着，切回自定义时原样恢复
          for (const item of section.items) item.pinned = false
        } else {
          // 切到自定义：渲染层刚把当前 TOP 落成列表（reorderSectionItems 写的），
          // 有内容就记成「编辑过」，之后切换不再用 TOP 覆盖
          section.customized = section.items.length > 0
        }
      }
      if (patch?.topN !== undefined) section.topN = clampTopN(patch.topN)
      persist()
      return { ok: true }
    },

    addSectionItem: (categoryId, videoId) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      const vid = videoIdOf(videoId)
      if (!id || vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const section = ensureSection(id)
      // 之前被移除过的，再推荐一次就当恢复，并且按推荐放到前面
      addItemTo(section, vid)
      markCustomized(section)
      persist()
      return { ok: true }
    },

    updateSectionItem: (categoryId, videoId, patch) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      const vid = videoIdOf(videoId)
      if (!id || vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const section = ensureSection(id)
      let item = section.items.find((entry) => entry.videoId === vid)
      if (!item) {
        // latest 规则里自动出现的视频没有配置行，改它就顺手补一行
        item = { videoId: vid, removed: false, pinned: false, ...defaultFields() }
        section.items.push(item)
      }
      Object.assign(item, applyPatch(item, patch))
      markCustomized(section)
      persist()
      return { ok: true }
    },

    removeSectionItem: (categoryId, videoId) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      const vid = videoIdOf(videoId)
      if (!id || vid === null) return { ok: false, error: 'INVALID_INPUT' }
      // 没配置过的一级分类走默认 latest 规则，移除时也给它的自动条目补一条排除记录
      const section = findSection(id) ?? ensureSection(id)
      if (section.rule === 'manual') {
        const before = section.items.length
        section.items = section.items.filter((item) => item.videoId !== vid)
        if (section.items.length === before) return { ok: false, error: 'NOT_FOUND' }
        section.customized = section.items.length > 0
      } else {
        let item = section.items.find((entry) => entry.videoId === vid)
        if (!item) {
          item = { videoId: vid, removed: true, pinned: false, ...defaultFields() }
          section.items.push(item)
        }
        item.removed = true
      }
      persist()
      return { ok: true }
    },

    restoreSectionItem: (categoryId, videoId) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      const vid = videoIdOf(videoId)
      if (!id || vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const section = ensureSection(id)
      const item = section.items.find((entry) => entry.videoId === vid)
      if (!item) return { ok: false, error: 'NOT_FOUND' }
      item.removed = false
      persist()
      return { ok: true }
    },

    clearSectionItems: (categoryId) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      if (!id) return { ok: false, error: 'INVALID_INPUT' }
      // 「自定义」是一份人工列表，清空就是把这条轨道清空；TOP 规则的列表是算出来的，没有这个动作
      const section = findSection(id)
      if (!section) return { ok: true }
      if (section.rule !== 'manual') return { ok: false, error: 'INVALID_INPUT' }
      section.items = []
      // 清空后列表又变回空的：再切到自定义时仍然允许用 TOP 自动填充
      section.customized = false
      persist()
      return { ok: true }
    },

    moveSectionItem: (fromCategoryId, toCategoryId, videoId) => {
      const fromId = typeof fromCategoryId === 'string' ? fromCategoryId.trim() : ''
      const toId = typeof toCategoryId === 'string' ? toCategoryId.trim() : ''
      const vid = videoIdOf(videoId)
      if (!fromId || vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const from = findSection(fromId)
      const item = from?.items.find((entry) => entry.videoId === vid)
      if (!from || !item) return { ok: false, error: 'NOT_FOUND' }
      from.items = from.items.filter((entry) => entry.videoId !== vid)
      if (toId) {
        const target = ensureSection(toId)
        const existing = target.items.find((entry) => entry.videoId === vid)
        if (existing) {
          // 目标分类里已经有这条（比如同时绑了两个大类），保留目标那份的覆盖字段
          existing.removed = false
          existing.pinned = true
        } else {
          target.items.push({ ...item, removed: false, pinned: true })
        }
        markCustomized(target)
      }
      persist()
      return { ok: true }
    },

    reorderSectionItems: (categoryId, videoIds) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      if (!id) return { ok: false, error: 'INVALID_INPUT' }
      const given = (Array.isArray(videoIds) ? videoIds : [])
        .map((raw) => videoIdOf(raw))
        .filter((value): value is number => value !== null)
      // 没有任何可落成自定义的条目（比如 TOP 轨道本来就是空的）就什么都不做：
      // 早先这里会把列表标成「编辑过」，导致之后切回自定义再也不会用 TOP 填充
      if (given.length === 0) return { ok: true }
      const section = ensureSection(id)
      const items = new Map(section.items.map((item) => [item.videoId, item]))
      const ordered: HomeSectionItem[] = []
      for (const vid of given) {
        // latest 规则里自动带上来的条目没有配置行，排序时就顺手补一行；
        // 人工排过序的条目固定到前面，自动条目仍然靠后
        const item = items.get(vid) ?? {
          videoId: vid,
          removed: false,
          pinned: false,
          ...defaultFields()
        }
        item.pinned = true
        ordered.push(item)
        items.delete(vid)
      }
      // 被移除的、以及不在顺序里的条目留在末尾，恢复后还能看到
      for (const rest of section.items) {
        if (items.has(rest.videoId)) ordered.push(rest)
      }
      section.items = ordered
      // 自定义规则下的排序才算编辑过；TOP 里的置顶排序不算（切过来时仍按 TOP 整份播种）
      if (section.rule === 'manual') section.customized = ordered.length > 0
      persist()
      return { ok: true }
    },

    saveSearch: (patch) => {
      if (patch?.rule !== undefined && !isRule(patch.rule)) {
        return { ok: false, error: 'INVALID_INPUT' }
      }
      const search = config.search
      if (patch?.rule !== undefined && patch.rule !== search.rule) {
        search.rule = patch.rule
        if (patch.rule === 'latest') {
          // 切回 TOP：人工排序不再往前面插，列表本身留着，切回自定义时原样恢复
          for (const item of search.items) item.pinned = false
        } else {
          // 切到自定义：渲染层刚把当前 TOP 落成列表，有内容就记成「编辑过」
          search.customized = search.items.length > 0
        }
      }
      if (patch?.topN !== undefined) search.topN = clampSearchTopN(patch.topN)
      persist()
      return { ok: true }
    },

    addSearchItem: (videoId) => {
      const vid = videoIdOf(videoId)
      if (vid === null) return { ok: false, error: 'INVALID_INPUT' }
      addItemTo(config.search, vid)
      markCustomized(config.search)
      persist()
      return { ok: true }
    },

    updateSearchItem: (videoId, patch) => {
      const vid = videoIdOf(videoId)
      if (vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const search = config.search
      let item = search.items.find((entry) => entry.videoId === vid)
      if (!item) {
        // latest 规则里自动出现的视频没有配置行，改它就顺手补一行
        item = { videoId: vid, removed: false, pinned: false, ...defaultFields() }
        search.items.push(item)
      }
      Object.assign(item, applyPatch(item, patch))
      markCustomized(search)
      persist()
      return { ok: true }
    },

    removeSearchItem: (videoId) => {
      const vid = videoIdOf(videoId)
      if (vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const search = config.search
      if (search.rule === 'manual') {
        const before = search.items.length
        search.items = search.items.filter((item) => item.videoId !== vid)
        if (search.items.length === before) return { ok: false, error: 'NOT_FOUND' }
        search.customized = search.items.length > 0
      } else {
        let item = search.items.find((entry) => entry.videoId === vid)
        if (!item) {
          item = { videoId: vid, removed: true, pinned: false, ...defaultFields() }
          search.items.push(item)
        }
        item.removed = true
      }
      persist()
      return { ok: true }
    },

    restoreSearchItem: (videoId) => {
      const vid = videoIdOf(videoId)
      if (vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const item = config.search.items.find((entry) => entry.videoId === vid)
      if (!item) return { ok: false, error: 'NOT_FOUND' }
      item.removed = false
      persist()
      return { ok: true }
    },

    reorderSearchItems: (videoIds) => {
      const search = config.search
      const applied = orderItems(search, Array.isArray(videoIds) ? videoIds : [])
      if (!applied) return { ok: true }
      // 自定义规则下的排序才算编辑过；TOP 里的置顶排序不算（切过来时仍按 TOP 整份播种）
      if (search.rule === 'manual') search.customized = search.items.length > 0
      persist()
      return { ok: true }
    },

    clearSearchItems: () => {
      // 「自定义」是一份人工列表；TOP 规则的列表是算出来的，没有这个动作
      if (config.search.rule !== 'manual') return { ok: false, error: 'INVALID_INPUT' }
      config.search.items = []
      config.search.customized = false
      persist()
      return { ok: true }
    },

    importImage: (sourcePath) => {
      const ext = extname(sourcePath).toLowerCase()
      if (!IMAGE_EXTENSIONS.has(ext)) return { ok: false, error: 'UNSUPPORTED' }
      try {
        const stat = statSync(sourcePath)
        if (!stat.isFile()) return { ok: false, error: 'NOT_FOUND' }
        if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: 'TOO_LARGE' }
        mkdirSync(imagesDir, { recursive: true })
        const name = `${randomUUID()}${ext}`
        copyFileSync(sourcePath, join(imagesDir, name))
        return { ok: true, url: `cine-img://home/${name}` }
      } catch (error) {
        console.error('首页图片导入失败', error)
        return { ok: false, error: 'COPY_FAILED' }
      }
    },

    imageFile: (fileName) => {
      const name = basename(fileName)
      if (name !== fileName) return null
      if (!/^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|avif)$/.test(name)) return null
      const path = join(imagesDir, name)
      return existsSync(path) ? path : null
    }
  }
}
