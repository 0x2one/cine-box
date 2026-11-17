import { useEffect, useMemo, useRef, useState } from 'react'
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tooltip,
  Tree,
  TreeSelect
} from 'antd'
import type { TreeProps } from 'antd'
import {
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  LinkOutlined,
  PlusOutlined
} from '@ant-design/icons'
import BindingWorkspace from './BindingWorkspace'
import {
  buildCategoryTree,
  categoryPathOf,
  categorySubtreeIds,
  toCategoryOptions,
  visibleCategoryIds,
  type CategoryTreeNode
} from '../lib/category-tree'

interface CategoryFormValues {
  name: string
  parentId?: string
}

type DropInfo = Parameters<NonNullable<TreeProps['onDrop']>>[0]
type AllowDropInfo = Parameters<NonNullable<TreeProps['allowDrop']>>[0]

const CATEGORY_ERRORS: Record<string, string> = {
  INVALID_NAME: '请填写分类名称',
  INVALID_PARENT: '上级分类不存在，可能已被删除',
  INVALID_PLACEMENT: '拖拽位置不合法，请重试',
  DUPLICATE_NAME: '同一层级下已有同名分类',
  CYCLE: '不能把分类移动到它自己的子分类下',
  NOT_FOUND: '分类不存在，可能已被删除'
}

const BINDING_ERRORS: Record<string, string> = {
  INVALID_INPUT: '绑定信息已失效，请刷新后重试',
  NOT_FOUND: '在线分类已被删除，请重新获取站点分类'
}

interface BindingGroup {
  siteId: string
  siteName: string
  items: CategoryBinding[]
}

/** 映射模式下某个站点的在线分类与绑定，按 siteId 记录，避免切换站点时短暂显示上一个站点的数据 */
interface OnlineSource {
  siteId: string
  rows: SiteCategory[]
  bindings: Map<string, SiteCategoryBinding>
  error: string
}

const NO_ONLINE_ROWS: SiteCategory[] = []
const NO_ONLINE_BINDINGS = new Map<string, SiteCategoryBinding>()

/** 按站点分组展示绑定明细 */
function groupBindings(items: CategoryBinding[]): BindingGroup[] {
  const groups = new Map<string, BindingGroup>()
  for (const item of items) {
    const group = groups.get(item.siteId) ?? {
      siteId: item.siteId,
      siteName: item.siteName,
      items: []
    }
    group.items.push(item)
    groups.set(item.siteId, group)
  }
  return [...groups.values()]
}

function toTarget(item: CategoryBinding): BindingTarget {
  return { siteId: item.siteId, siteCategoryId: item.siteCategoryId }
}

/**
 * 控制台「视频分类」分区：本地分类按层级管理，支持新增、编辑、删除，
 * 拖拽可调整上下级与同级顺序。默认没有任何分类。
 * 从站点分类弹窗点「绑定」进来时，右侧出现该站点的在线分类，拖到树上即可绑定。
 */
function CategoriesPanel({
  title,
  desc,
  bindingSite,
  onExitBinding
}: {
  title: string
  desc: string
  /** 非空表示正在把该站点的在线分类拖到本地分类上 */
  bindingSite: { id: string; name: string } | null
  onExitBinding: () => void
}): React.JSX.Element {
  const { message } = App.useApp()
  const [categories, setCategories] = useState<VideoCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [formOpen, setFormOpen] = useState(false)
  /** 非空表示正在编辑该分类，为空则是新增 */
  const [editing, setEditing] = useState<VideoCategory | null>(null)
  /** 新增时预选的上级分类（行内「+」按钮带过来的） */
  const [draftParent, setDraftParent] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 正在切换显示状态的分类，用于按钮 loading */
  const [togglingId, setTogglingId] = useState<string | null>(null)
  /** 快速连续切换时只采纳最后一次结果，避免旧响应覆盖新状态 */
  const toggleToken = useRef(0)
  const [form] = Form.useForm<CategoryFormValues>()
  /** 正在拖拽的节点及其子树，用于阻止把分类拖进自己的后代 */
  const dragging = useRef<{ id: string; subtree: Set<string> } | null>(null)
  /** 接收原生拖拽事件的容器（含分类树与右侧工作区） */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 当前展开策略对应的模式（true = 绑定模式），null 表示还没按模式展开过 */
  const expandedMode = useRef<boolean | null>(null)
  /** 每个本地分类已绑定的在线分类数量，未绑定的不出现 */
  const [counts, setCounts] = useState<Record<string, number>>({})
  /** 非空表示绑定明细弹窗打开，并记录当前查看的分类 */
  const [bindingCategory, setBindingCategory] = useState<VideoCategory | null>(null)
  const [bindingItems, setBindingItems] = useState<CategoryBinding[]>([])
  const [bindingLoading, setBindingLoading] = useState(false)
  const [unbinding, setUnbinding] = useState(false)
  /** 映射模式：该站点在线分类 + 已有绑定，按 siteId 记录，切换站点时自然回到加载态 */
  const [onlineSource, setOnlineSource] = useState<OnlineSource | null>(null)
  /** 重试 / 重新拉取在线分类时自增，触发上面那个 effect */
  const [onlineReloadToken, setOnlineReloadToken] = useState(0)
  /** 正在拖拽 / 点击选中的在线分类，以及当前悬停的落点 */
  const [draggingItem, setDraggingItem] = useState<SiteCategory | null>(null)
  const [selectedItem, setSelectedItem] = useState<SiteCategory | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [binding, setBinding] = useState(false)
  /** 是否处于「把在线分类拖到本地分类上」的绑定模式 */
  const bindingMode = Boolean(bindingSite)

  const refreshCounts = (): void => {
    void window.api.bindings
      .counts()
      .then(setCounts)
      .catch(() => {})
  }

  useEffect(() => {
    let alive = true
    void window.api.bindings
      .counts()
      .then((next) => {
        if (alive) setCounts(next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 进入映射模式时拉该站点的在线分类与已有绑定；不在 effect 里同步 setState，避免级联渲染
  useEffect(() => {
    if (!bindingSite) return
    const siteId = bindingSite.id
    let alive = true
    void Promise.all([
      window.api.sites.categories(siteId),
      window.api.bindings.forSite(siteId).catch(() => [] as SiteCategoryBinding[])
    ])
      .then(([result, bindings]) => {
        if (!alive) return
        const error = result.ok
          ? ''
          : (CATEGORY_ERRORS[result.error ?? ''] ?? '获取站点分类失败，请重试')
        setOnlineSource({
          siteId,
          rows: result.ok ? (result.categories ?? []) : [],
          bindings: new Map(bindings.map((row) => [row.siteCategoryId, row])),
          error
        })
      })
      .catch(() => {
        if (!alive) return
        setOnlineSource({
          siteId,
          rows: [],
          bindings: new Map(),
          error: '获取站点分类失败，请重试'
        })
      })
    return () => {
      alive = false
    }
  }, [bindingSite, onlineReloadToken])

  useEffect(() => {
    let alive = true
    void window.api.categories
      .list()
      .then((rows) => {
        if (alive) setCategories(rows)
      })
      .catch(() => {
        if (alive) message.error('分类加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [message])

  // 平时默认收起，进入绑定模式时默认展开全部有子分类的节点；之后尊重用户自己的折叠状态
  useEffect(() => {
    if (categories.length === 0) return
    if (expandedMode.current === bindingMode) return
    expandedMode.current = bindingMode
    setExpandedKeys(
      bindingMode
        ? categories
            .filter((row) => categories.some((child) => child.parentId === row.id))
            .map((row) => row.id)
        : []
    )
  }, [bindingMode, categories])

  // 弹窗打开后再回填：Form 要等 Modal 首次渲染才挂载
  useEffect(() => {
    if (!formOpen) return
    if (editing) {
      form.setFieldsValue({ name: editing.name, parentId: editing.parentId ?? undefined })
      return
    }
    form.setFieldsValue({ name: '', parentId: draftParent ?? undefined })
  }, [formOpen, editing, draftParent, form])

  const tree = useMemo(() => buildCategoryTree(categories), [categories])
  const childCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of categories) {
      if (!row.parentId) continue
      counts.set(row.parentId, (counts.get(row.parentId) ?? 0) + 1)
    }
    return counts
  }, [categories])
  const parentOptions = useMemo(
    () =>
      toCategoryOptions(
        tree,
        editing ? categorySubtreeIds(categories, editing.id) : new Set<string>()
      ),
    [tree, categories, editing]
  )
  /** 展示端可见的分类：父分类隐藏时整棵子树一起隐藏 */
  const visibleIds = useMemo(() => visibleCategoryIds(categories), [categories])
  const hiddenCount = categories.length - visibleIds.size
  const bindingGroups = useMemo(() => groupBindings(bindingItems), [bindingItems])

  // 映射模式下只在数据属于当前站点时才展示，否则视为加载中
  const onlineReady = Boolean(bindingSite) && onlineSource?.siteId === bindingSite?.id
  const online = onlineReady && onlineSource ? onlineSource.rows : NO_ONLINE_ROWS
  const onlineBindings = onlineReady && onlineSource ? onlineSource.bindings : NO_ONLINE_BINDINGS
  const onlineError = onlineReady && onlineSource ? onlineSource.error : ''
  const onlineLoading = Boolean(bindingSite) && !onlineReady

  /** 统一处理主进程返回：失败时按错误码提示 */
  const applyResult = (result: VideoCategoryResult): boolean => {
    if (!result.ok) {
      message.error(CATEGORY_ERRORS[result.error ?? ''] ?? '操作失败，请重试')
      return false
    }
    if (result.categories) setCategories(result.categories)
    return true
  }

  const expand = (id: string | null): void => {
    if (!id) return
    setExpandedKeys((keys) => (keys.includes(id) ? keys : [...keys, id]))
  }

  const openCreate = (parentId: string | null = null): void => {
    setEditing(null)
    setDraftParent(parentId)
    setFormOpen(true)
  }

  const openEdit = (category: VideoCategory): void => {
    setEditing(category)
    setDraftParent(category.parentId)
    setFormOpen(true)
  }

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
    setDraftParent(null)
  }

  const submit = async (): Promise<void> => {
    let values: CategoryFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const payload = { name: values.name, parentId: values.parentId ?? null }
    const current = editing
    setSaving(true)
    try {
      const result = current
        ? await window.api.categories.update(current.id, payload)
        : await window.api.categories.create(payload)
      if (!applyResult(result)) return
      // 新建的子分类要把上级展开，否则保存后看不到它
      if (!current) expand(payload.parentId)
      closeForm()
      message.success(current ? '分类已更新' : '分类已创建')
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const move = (id: string, targetId: string, placement: CategoryPlacement): void => {
    void window.api.categories
      .move(id, targetId, placement)
      .then((result) => {
        applyResult(result)
      })
      .catch(() => message.error('移动失败，请重试'))
  }

  const remove = (category: VideoCategory): void => {
    void window.api.categories
      .remove(category.id)
      .then((result) => {
        if (!applyResult(result)) return
        // 分类删掉后挂在上面的绑定由外键级联清理，数量跟着刷新
        refreshCounts()
        message.success('分类已删除')
      })
      .catch(() => message.error('删除失败，请重试'))
  }

  /** 请求返回前按钮保持 loading；调用本身抛错（如预加载脚本尚未更新）也要复位，避免一直等待中 */
  const toggleVisible = async (category: VideoCategory, visible: boolean): Promise<void> => {
    const token = ++toggleToken.current
    setTogglingId(category.id)
    try {
      const result = await window.api.categories.setVisible(category.id, visible)
      if (token === toggleToken.current) applyResult(result)
    } catch (error) {
      message.error(
        error instanceof TypeError ? '切换失败，请重启应用后重试' : '切换显示状态失败，请重试'
      )
    } finally {
      if (token === toggleToken.current) setTogglingId(null)
    }
  }

  const openBindings = (category: VideoCategory): void => {
    setBindingCategory(category)
    setBindingItems([])
    setBindingLoading(true)
    void window.api.bindings
      .forCategory(category.id)
      .then((rows) => setBindingItems(rows))
      .catch(() => message.error('绑定信息加载失败'))
      .finally(() => setBindingLoading(false))
  }

  const closeBindings = (): void => {
    setBindingCategory(null)
    setBindingItems([])
    setBindingLoading(false)
    setUnbinding(false)
  }

  const unbind = (items: { siteId: string; siteCategoryId: string }[]): void => {
    if (items.length === 0) return
    setUnbinding(true)
    void window.api.bindings
      .unbind(items)
      .then((result) => {
        if (!result.ok) {
          message.error(BINDING_ERRORS[result.error ?? ''] ?? '解绑失败，请重试')
          return
        }
        message.success(items.length > 1 ? `已解绑 ${items.length} 个在线分类` : '已解绑')
        if (bindingCategory) {
          void window.api.bindings
            .forCategory(bindingCategory.id)
            .then((rows) => setBindingItems(rows))
            .catch(() => {})
        }
        // 映射模式下右侧也要跟着变
        if (bindingSite) reloadOnlineBindings()
        refreshCounts()
      })
      .catch(() => message.error('解绑失败，请重试'))
      .finally(() => setUnbinding(false))
  }

  const reloadOnlineBindings = (): void => {
    if (!bindingSite) return
    const siteId = bindingSite.id
    void window.api.bindings
      .forSite(siteId)
      .then((rows) => {
        setOnlineSource((current) => {
          if (!current || current.siteId !== siteId) return current
          return { ...current, bindings: new Map(rows.map((row) => [row.siteCategoryId, row])) }
        })
      })
      .catch(() => {})
  }

  const reloadOnline = (): void => {
    if (!bindingSite) return
    setOnlineSource(null)
    setOnlineReloadToken((token) => token + 1)
  }

  /** 把一条在线分类绑到指定的本地分类：拖拽落点或「先选中再点分类」都走这里 */
  const bindTo = (categoryId: string): void => {
    if (!bindingSite) return
    const item = draggingItem ?? selectedItem
    if (!item) return
    const previous = onlineBindings.get(item.id)
    setBinding(true)
    void window.api.bindings
      .bind([{ siteId: bindingSite.id, siteCategoryId: item.id }], categoryId)
      .then((result) => {
        if (!result.ok) {
          message.error(BINDING_ERRORS[result.error ?? ''] ?? '绑定失败，请重试')
          reloadOnlineBindings()
          return
        }
        setDraggingItem(null)
        setSelectedItem(null)
        setDropTargetId(null)
        const path = categoryPathOf(categories, categoryId)
        message.success(
          previous && previous.categoryId !== categoryId
            ? `已从「${previous.categoryPath}」改绑到「${path}」`
            : `已绑定到「${path}」`
        )
        reloadOnlineBindings()
        refreshCounts()
      })
      .catch(() => message.error('绑定失败，请重试'))
      .finally(() => setBinding(false))
  }

  const unbindOnline = (item: SiteCategory): void => {
    if (!bindingSite) return
    void window.api.bindings
      .unbind([{ siteId: bindingSite.id, siteCategoryId: item.id }])
      .then((result) => {
        if (!result.ok) {
          message.error(BINDING_ERRORS[result.error ?? ''] ?? '解绑失败，请重试')
          return
        }
        message.success('已解绑')
        reloadOnlineBindings()
        refreshCounts()
      })
      .catch(() => message.error('解绑失败，请重试'))
  }

  /** 从拖拽落点往上找带 data-category-id 的行 */
  const resolveCategoryId = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null
    const row = target.closest('[data-category-id]')
    return row instanceof HTMLElement ? (row.dataset.categoryId ?? null) : null
  }

  /**
   * rc-tree 的节点在 onDragOver / onDrop 里会 stopPropagation + preventDefault，
   * React 的 onDragOver 收不到外部拖进来的事件，所以改用捕获阶段的原生监听；
   * 回调放 ref 里，保证能拿到最新一次渲染的 state。
   */
  const dragBridge = useRef<(event: DragEvent, phase: 'over' | 'leave' | 'drop') => void>(() => {})

  useEffect(() => {
    dragBridge.current = (event, phase) => {
      if (!draggingItem) return
      if (phase === 'leave') {
        const next = event.relatedTarget as Node | null
        if (next && (event.currentTarget as Node | null)?.contains(next)) return
        setDropTargetId(null)
        return
      }
      const id = resolveCategoryId(event.target)
      if (!id) {
        if (phase === 'over') setDropTargetId(null)
        return
      }
      event.preventDefault()
      if (phase === 'over') {
        if (dropTargetId !== id) setDropTargetId(id)
        return
      }
      event.stopPropagation()
      setDropTargetId(null)
      bindTo(id)
    }
  })

  useEffect(() => {
    const node = bodyRef.current
    if (!node) return
    const over = (event: DragEvent): void => dragBridge.current(event, 'over')
    const leave = (event: DragEvent): void => dragBridge.current(event, 'leave')
    const drop = (event: DragEvent): void => dragBridge.current(event, 'drop')
    node.addEventListener('dragover', over, true)
    node.addEventListener('dragleave', leave, true)
    node.addEventListener('drop', drop, true)
    return () => {
      node.removeEventListener('dragover', over, true)
      node.removeEventListener('dragleave', leave, true)
      node.removeEventListener('drop', drop, true)
    }
  }, [])

  const handleDrop = (info: DropInfo): void => {
    // 外部拖进来的在线分类由上面的原生监听处理，这里只管树内部排序
    if (!info.dragNode) return
    const dragId = String(info.dragNode.key)
    const targetId = String(info.node.key)
    if (dragId === targetId) return
    // dropPosition 是整棵树里的绝对位置，减去目标节点自身的位置才是 -1 / 0 / 1
    const offset = info.dropPosition - Number(info.node.pos.split('-').pop())
    const placement: CategoryPlacement = info.dropToGap
      ? offset > 0
        ? 'after'
        : 'before'
      : 'inside'
    if (placement === 'inside') expand(targetId)
    move(dragId, targetId, placement)
  }

  const allowDrop = (info: AllowDropInfo): boolean => {
    const current = dragging.current
    if (!current) return false
    const dropId = String(info.dropNode.key ?? '')
    // 落在自己或自己的子树上都会形成环，直接拒绝
    return dropId !== current.id && !current.subtree.has(dropId)
  }

  const renderTitle = (node: CategoryTreeNode): React.ReactNode => {
    const count = childCount.get(node.key) ?? 0
    const bound = counts[node.key] ?? 0
    const category = categories.find((row) => row.id === node.key)
    const isDropTarget = dropTargetId === node.key
    const ownVisible = category?.visible !== false
    // 有效隐藏：自身关闭，或任一上级关闭
    const hidden = !visibleIds.has(node.key)
    const visibilityTitle = !ownVisible
      ? '已隐藏，点击显示'
      : hidden
        ? '上级分类已隐藏，当前分类也不会显示；点击可单独隐藏'
        : '在展示端显示，点击隐藏'
    return (
      <span
        className={`category-row${hidden ? ' is-hidden' : ''}${
          isDropTarget ? ' is-drop-target' : ''
        }`}
        data-category-id={node.key}
        onClick={() => {
          // 映射模式下选中了在线分类时，点分类即绑定
          if (!binding && selectedItem) bindTo(node.key)
        }}
      >
        <span className="category-name">{node.title}</span>
        {bound > 0 && (
          <button
            type="button"
            className="category-bound"
            title="查看已绑定的在线分类"
            onClick={(event) => {
              event.stopPropagation()
              if (category) openBindings(category)
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <LinkOutlined />
            <span>{bound}</span>
          </button>
        )}
        {count > 0 && <span className="category-count">{count} 个子分类</span>}
        <span
          className="category-actions"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Tooltip title={visibilityTitle}>
            <Button
              type="text"
              size="small"
              className={`category-visible${ownVisible ? '' : ' is-off'}`}
              icon={ownVisible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
              loading={togglingId === node.key}
              onClick={() => {
                if (category) void toggleVisible(category, !ownVisible)
              }}
              aria-label={ownVisible ? `隐藏「${node.title}」` : `显示「${node.title}」`}
            />
          </Tooltip>
          <Tooltip title={bound > 0 ? `已绑定 ${bound} 个在线分类` : '绑定在线分类'}>
            <Button
              type="text"
              size="small"
              icon={<LinkOutlined />}
              onClick={() => {
                if (category) openBindings(category)
              }}
              aria-label={`查看「${node.title}」的绑定`}
            />
          </Tooltip>
          <Tooltip title="新增子分类">
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => openCreate(node.key)}
              aria-label={`在「${node.title}」下新增子分类`}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                if (category) openEdit(category)
              }}
              aria-label={`编辑「${node.title}」`}
            />
          </Tooltip>
          <Popconfirm
            title="删除分类"
            description={
              bound > 0
                ? `「${node.title}」已绑定 ${bound} 个在线分类，删除后会一并解除绑定，且不可恢复。`
                : count > 0
                  ? `「${node.title}」下还有 ${count} 个直接子分类，删除后整棵子树都会移除，且不可恢复。`
                  : `确定删除「${node.title}」吗？删除后不可恢复。`
            }
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => {
              if (category) remove(category)
            }}
          >
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label={`删除「${node.title}」`}
            />
          </Popconfirm>
        </span>
      </span>
    )
  }

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">
            共 {categories.length} 个分类
            {hiddenCount > 0 ? ` · ${hiddenCount} 个已隐藏` : ''}
          </span>
        </p>
        <div className="settings-panel-actions">
          <Tooltip title="新增分类">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => openCreate()}
              aria-label="新增分类"
            />
          </Tooltip>
        </div>
      </div>

      <div className={`category-body${bindingSite ? ' is-binding' : ''}`} ref={bodyRef}>
        <div className="category-body-main">
          {loading ? (
            <div className="sites-placeholder">
              <Spin size="small" />
              <span className="sites-empty-hint">正在加载分类…</span>
            </div>
          ) : categories.length === 0 ? (
            <div className="sites-placeholder">
              <span className="sites-empty-title">暂无视频分类</span>
              <span className="sites-empty-hint">
                点击右上角的 + 创建第一个分类，分类可以多级嵌套
              </span>
            </div>
          ) : (
            <>
              {!bindingSite && (
                <p className="category-tip">
                  拖拽分类可调整层级与顺序，行内 +
                  可在该分类下新增子分类；行尾眼睛按钮控制是否在展示端显示，关闭父分类会连同子分类一起隐藏。
                </p>
              )}
              <div className="settings-card category-card">
                <Tree
                  className="category-tree"
                  blockNode
                  selectable={false}
                  draggable
                  treeData={tree}
                  titleRender={(node) => renderTitle(node as CategoryTreeNode)}
                  expandedKeys={expandedKeys}
                  onExpand={(keys) => setExpandedKeys(keys.map(String))}
                  allowDrop={allowDrop}
                  onDragStart={(info) => {
                    const id = String(info.node.key)
                    dragging.current = { id, subtree: categorySubtreeIds(categories, id) }
                  }}
                  onDragEnd={() => {
                    dragging.current = null
                  }}
                  onDrop={handleDrop}
                />
              </div>
            </>
          )}
        </div>

        {bindingSite && (
          <BindingWorkspace
            siteName={bindingSite.name}
            hint={
              draggingItem
                ? dropTargetId
                  ? `松开即绑定到「${categoryPathOf(categories, dropTargetId)}」`
                  : '把在线分类拖到左侧任意分类上'
                : ''
            }
            categories={online}
            bindings={onlineBindings}
            loading={onlineLoading}
            error={onlineError}
            draggingId={draggingItem?.id ?? null}
            selectedId={selectedItem?.id ?? null}
            onDragStart={setDraggingItem}
            onDragEnd={() => {
              setDraggingItem(null)
              setDropTargetId(null)
            }}
            onSelect={(item) =>
              setSelectedItem((current) => (current?.id === item.id ? null : item))
            }
            onUnbind={unbindOnline}
            onExit={() => {
              setSelectedItem(null)
              setDraggingItem(null)
              onExitBinding()
            }}
            onRetry={reloadOnline}
          />
        )}
      </div>

      <Modal
        title={editing ? '编辑分类' : draftParent ? '新增子分类' : '新增分类'}
        open={formOpen}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={closeForm}
        width={420}
      >
        <Form form={form} layout="vertical" requiredMark={false} className="site-form">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, whitespace: true, message: '请填写分类名称' }]}
          >
            <Input maxLength={40} placeholder="如：电影、动作片" allowClear />
          </Form.Item>
          <Form.Item name="parentId" label="上级分类">
            <TreeSelect
              allowClear
              showSearch
              treeDefaultExpandAll
              treeNodeFilterProp="label"
              placeholder="留空则创建一级分类"
              treeData={parentOptions}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          bindingCategory ? `「${categoryPathOf(categories, bindingCategory.id)}」的绑定` : '绑定'
        }
        open={Boolean(bindingCategory)}
        onCancel={closeBindings}
        width={520}
        footer={
          <Space>
            {bindingItems.length > 0 && (
              <Popconfirm
                title="解绑全部"
                description={`确定解除「${bindingCategory?.name ?? ''}」上全部 ${bindingItems.length} 个绑定吗？`}
                okText="解绑"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => unbind(bindingItems.map(toTarget))}
              >
                <Button danger loading={unbinding}>
                  解绑全部
                </Button>
              </Popconfirm>
            )}
            <Button onClick={closeBindings}>关闭</Button>
          </Space>
        }
      >
        {bindingLoading ? (
          <div className="categories-state">
            <Spin size="small" />
            <span>正在加载绑定…</span>
          </div>
        ) : bindingItems.length === 0 ? (
          <div className="categories-state">
            <span>还没有绑定任何在线分类</span>
            <span className="sites-empty-hint">
              在「站点 › 分类」里点击或勾选在线分类，即可绑定到这个分类
            </span>
          </div>
        ) : (
          <div className="binding-groups">
            {bindingGroups.map((group) => (
              <section className="binding-group" key={group.siteId}>
                <h4 className="binding-group-title">
                  {group.siteName}
                  <span className="binding-group-count">{group.items.length}</span>
                </h4>
                <ul className="binding-list">
                  {group.items.map((item) => (
                    <li className="binding-row is-bound" key={item.id}>
                      <span className="binding-name">{item.name}</span>
                      <button
                        type="button"
                        className="binding-unbind"
                        title="解绑"
                        aria-label={`解绑「${item.name}」`}
                        disabled={unbinding}
                        onClick={() => unbind([toTarget(item)])}
                      >
                        <CloseOutlined />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}

export default CategoriesPanel
