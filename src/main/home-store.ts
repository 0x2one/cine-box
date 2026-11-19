import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import {
  HOME_DEFAULT_TOP_N,
  HOME_MAX_POSTERS,
  HOME_MAX_TOP_N,
  HOME_MIN_TOP_N,
  type HomeActionResult,
  type HomeConfig,
  type HomeCrop,
  type HomeItemFields,
  type HomeItemPatch,
  type HomePosterItem,
  type HomeRule,
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
  posters?: unknown
  sections?: unknown
}

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

/**
 * 首页配置：单独一个 JSON 文件（userData/Data/Home/home.json），
 * 与业务库、视频缓存库都分开，清空缓存不会连带删掉配置（只是条目变成「视频已丢失」）。
 * 图片放在同目录的 images/ 下，渲染层通过 cine-img://home/<文件名> 引用。
 */
export function createHomeStore(directory: string): HomeStore {
  const file = join(directory, 'home.json')
  const imagesDir = join(directory, 'images')
  let config: HomeConfig = { posters: [], sections: [] }

  function persist(): void {
    const payload: StoreFile = {
      version: 1,
      posters: config.posters,
      sections: config.sections
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
      const items: HomeSectionItem[] = []
      const seenItems = new Set<number>()
      for (const item of Array.isArray(record.items) ? record.items : []) {
        if (!item || typeof item !== 'object') continue
        const itemRecord = item as Record<string, unknown>
        const videoId = videoIdOf(itemRecord.videoId)
        if (videoId === null || seenItems.has(videoId)) continue
        seenItems.add(videoId)
        items.push({
          videoId,
          removed: itemRecord.removed === true,
          pinned: itemRecord.pinned === true,
          ...fieldsFromObject(itemRecord)
        })
      }
      sections.push({
        categoryId,
        visible: record.visible !== false,
        title: typeof record.title === 'string' ? truncate(record.title, 60) : '',
        rule: isRule(record.rule) ? record.rule : 'latest',
        topN: clampTopN(record.topN),
        items
      })
    }
    return { posters, sections }
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
        config = { posters: [], sections: [] }
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
      if (patch?.rule !== undefined) section.rule = patch.rule
      if (patch?.topN !== undefined) section.topN = clampTopN(patch.topN)
      persist()
      return { ok: true }
    },

    addSectionItem: (categoryId, videoId) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      const vid = videoIdOf(videoId)
      if (!id || vid === null) return { ok: false, error: 'INVALID_INPUT' }
      const section = ensureSection(id)
      const existing = section.items.find((item) => item.videoId === vid)
      if (existing) {
        // 之前被移除过的，再推荐一次就当恢复，并且按推荐放到前面
        existing.removed = false
        existing.pinned = true
      } else {
        section.items.push({ videoId: vid, removed: false, pinned: true, ...defaultFields() })
      }
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

    reorderSectionItems: (categoryId, videoIds) => {
      const id = typeof categoryId === 'string' ? categoryId.trim() : ''
      if (!id) return { ok: false, error: 'INVALID_INPUT' }
      const section = ensureSection(id)
      const items = new Map(section.items.map((item) => [item.videoId, item]))
      const ordered: HomeSectionItem[] = []
      for (const raw of Array.isArray(videoIds) ? videoIds : []) {
        const vid = videoIdOf(raw)
        if (vid === null) continue
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
