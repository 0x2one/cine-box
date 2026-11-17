import { Button, Spin, Tooltip } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import { splitCategoryPath } from '../lib/category-tree'

interface BindingWorkspaceProps {
  /** 当前在绑定的站点名 */
  siteName: string
  /** 拖拽中的落点提示，非空时替换掉头部的说明文字 */
  hint: string
  /** 该站点的在线分类 */
  categories: SiteCategory[]
  /** siteCategoryId → 绑定的本地分类 */
  bindings: Map<string, SiteCategoryBinding>
  loading: boolean
  error: string
  /** 正在拖拽的在线分类 */
  draggingId: string | null
  /** 点击选中（无法拖拽时的等价操作） */
  selectedId: string | null
  onDragStart: (item: SiteCategory) => void
  onDragEnd: () => void
  onSelect: (item: SiteCategory) => void
  onUnbind: (item: SiteCategory) => void
  onExit: () => void
  onRetry: () => void
}

/**
 * 分类页右侧的映射工作区：列出某个站点的在线分类，拖到左侧分类树上即可绑定。
 * 只负责展示与交互，数据与写入都在 CategoriesPanel 里。
 */
function BindingWorkspace({
  siteName,
  hint,
  categories,
  bindings,
  loading,
  error,
  draggingId,
  selectedId,
  onDragStart,
  onDragEnd,
  onSelect,
  onUnbind,
  onExit,
  onRetry
}: BindingWorkspaceProps): React.JSX.Element {
  const unbound = categories.filter((item) => !bindings.has(item.id))
  const bound = categories.filter((item) => bindings.has(item.id))

  const renderCard = (item: SiteCategory): React.JSX.Element => {
    const binding = bindings.get(item.id)
    const path = binding ? splitCategoryPath(binding.categoryPath) : null
    return (
      <li
        key={item.id}
        className={`workspace-card${binding ? ' is-bound' : ''}${
          draggingId === item.id ? ' is-dragging' : ''
        }${selectedId === item.id ? ' is-selected' : ''}`}
        draggable
        title={
          binding ? `${item.name} → ${binding.categoryPath}` : `${item.name}（ID ${item.sourceId}）`
        }
        onDragStart={(event) => {
          // 落点判断用外层 ref，这里只是为了能拖起来
          event.dataTransfer.setData('application/x-cinebox-online', item.id)
          event.dataTransfer.effectAllowed = 'copy'
          onDragStart(item)
        }}
        onDragEnd={onDragEnd}
        onClick={() => onSelect(item)}
      >
        <span className="workspace-card-name">{item.name}</span>
        {path && (
          <span className="workspace-card-path">
            {path.parent && <span className="workspace-card-path-parent">{path.parent} / </span>}
            <span>{path.leaf}</span>
          </span>
        )}
        {binding && (
          <button
            type="button"
            className="workspace-card-unbind"
            aria-label={`解除「${item.name}」的绑定`}
            title="解除绑定"
            onClick={(event) => {
              event.stopPropagation()
              onUnbind(item)
            }}
          >
            <CloseOutlined />
          </button>
        )}
      </li>
    )
  }

  return (
    <section className="settings-card binding-workspace" aria-label="在线分类绑定">
      <header className="workspace-head">
        <div className="workspace-head-text">
          <span className="workspace-title">正在从「{siteName}」绑定</span>
          <span className={`workspace-desc${hint ? ' is-hint' : ''}`}>
            {hint || '拖到左侧分类上即可绑定，也可以先选中再点左侧分类'}
          </span>
        </div>
        <Tooltip title="退出绑定">
          <Button
            type="text"
            size="small"
            className="workspace-exit"
            icon={<CloseOutlined />}
            onClick={onExit}
            aria-label="退出绑定"
          />
        </Tooltip>
      </header>

      {loading ? (
        <div className="categories-state">
          <Spin size="small" />
          <span>正在获取该站点的分类…</span>
        </div>
      ) : error ? (
        <div className="categories-state">
          <span className="categories-error">{error}</span>
          <Button size="small" onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : categories.length === 0 ? (
        <div className="categories-state">
          <span>该站点还没有分类</span>
          <span className="sites-empty-hint">回到「站点」里点标签按钮获取分类后再来绑定</span>
        </div>
      ) : (
        <div className="workspace-groups">
          <section className="workspace-group">
            <h4 className="workspace-group-title">
              未绑定
              <span className="workspace-group-count">{unbound.length}</span>
            </h4>
            {unbound.length === 0 ? (
              <p className="workspace-empty">都绑好了</p>
            ) : (
              <ul className="workspace-cards">{unbound.map(renderCard)}</ul>
            )}
          </section>

          <section className="workspace-group">
            <h4 className="workspace-group-title">
              已绑定
              <span className="workspace-group-count">{bound.length}</span>
            </h4>
            {bound.length === 0 ? (
              <p className="workspace-empty">还没有绑定的分类</p>
            ) : (
              <ul className="workspace-cards">{bound.map(renderCard)}</ul>
            )}
          </section>
        </div>
      )}
    </section>
  )
}

export default BindingWorkspace
