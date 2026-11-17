/** 本地分类的树形结构与下拉选项：分类页和站点分类弹窗共用 */

export interface CategoryTreeNode {
  key: string
  title: string
  children?: CategoryTreeNode[]
}

export interface CategoryOption {
  value: string
  label: string
  disabled?: boolean
  children?: CategoryOption[]
}

/** 把扁平列表还原成树：父级缺失的行按一级分类兜底 */
export function buildCategoryTree(rows: VideoCategory[]): CategoryTreeNode[] {
  const nodes = new Map<string, CategoryTreeNode>()
  for (const row of rows) nodes.set(row.id, { key: row.id, title: row.name })

  const roots: CategoryTreeNode[] = []
  for (const row of rows) {
    const node = nodes.get(row.id)
    if (!node) continue
    const parent = row.parentId ? nodes.get(row.parentId) : undefined
    if (!parent) {
      roots.push(node)
      continue
    }
    parent.children = parent.children ?? []
    parent.children.push(node)
  }
  return roots
}

/** 下拉选项，disabled 里的节点不可选（编辑分类时用来排掉自己和后代） */
export function toCategoryOptions(
  nodes: CategoryTreeNode[],
  disabled?: Set<string>
): CategoryOption[] {
  return nodes.map((node) => ({
    value: node.key,
    label: node.title,
    disabled: disabled ? disabled.has(node.key) : false,
    children: node.children ? toCategoryOptions(node.children, disabled) : undefined
  }))
}

/** 自己 + 所有后代，用于禁用上级选项与拒绝把分类拖进自己的子树 */
export function categorySubtreeIds(rows: VideoCategory[], id: string): Set<string> {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id)
        grew = true
      }
    }
  }
  return ids
}

/** 某个分类的完整路径，如「电影 / 动作片」 */
export function categoryPathOf(rows: VideoCategory[], id: string): string {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const names: string[] = []
  const guard = new Set<string>()
  let cursor = byId.get(id)
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id)
    names.unshift(cursor.name)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return names.join(' / ')
}

/** 把路径拆成上级与自身，上级用弱化色、自身用强调色 */
export function splitCategoryPath(path: string): { parent: string; leaf: string } {
  const index = path.lastIndexOf(' / ')
  if (index < 0) return { parent: '', leaf: path }
  return { parent: path.slice(0, index), leaf: path.slice(index + 3) }
}
