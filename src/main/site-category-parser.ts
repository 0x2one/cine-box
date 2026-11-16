/** 采集站分类解析：纯函数，便于单独验证（不依赖 electron） */

export interface SiteCategory {
  id: string
  name: string
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 苹果 CMS 风格 JSON：class[].type_id / class[].type_name（个别站点会带 BOM） */
export function parseJsonCategories(raw: string): SiteCategory[] {
  const data = JSON.parse(raw.replace(/^\uFEFF/, '')) as {
    class?: { type_id?: unknown; type_name?: unknown }[]
  }
  const list = Array.isArray(data?.class) ? data.class : []
  return list
    .map((item) => ({
      id: String(item?.type_id ?? ''),
      name: String(item?.type_name ?? '').trim()
    }))
    .filter((item) => item.name)
}

/** RSS 5.1 的 <class><ty id="1">电影</ty></class> */
export function parseXmlCategories(raw: string): SiteCategory[] {
  const categories: SiteCategory[] = []
  const pattern = /<ty\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/ty>/g
  let match = pattern.exec(raw)
  while (match) {
    const name = decodeEntities(match[2].trim())
    if (name) categories.push({ id: match[1], name })
    match = pattern.exec(raw)
  }
  return categories
}
