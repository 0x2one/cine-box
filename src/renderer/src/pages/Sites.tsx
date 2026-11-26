import { useEffect, useMemo, useRef, useState } from 'react'
import {
  App,
  Button,
  Col,
  Dropdown,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip
} from 'antd'
import {
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  GlobalOutlined,
  LinkOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  TagsOutlined
} from '@ant-design/icons'
import SiteFormatIcon from '../components/SiteFormatIcon'
import { splitCategoryPath } from '../lib/category-tree'
import { formatCount, formatDateTime } from '../utils/format'

interface SiteFormValues {
  name: string
  display?: string
  address: string
  format: SiteFormat
  remark?: string
  onlineSearch: boolean
  /** 禁用：还能编辑，但不再采集、不参与搜索、不显示只属于它的视频 */
  disabled: boolean
  /** 18+：设置里关闭 18+ 内容时，这个站点的视频在展示端与共享页都不可见 */
  adult: boolean
}

/** 竖排三点：antd 只有横排的 MoreOutlined，这里直接画一颗，别用旋转凑 */
function MoreVerticalIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 1024 1024" width="1em" height="1em" fill="currentColor" aria-hidden="true">
      <circle cx="512" cy="192" r="96" />
      <circle cx="512" cy="512" r="96" />
      <circle cx="512" cy="832" r="96" />
    </svg>
  )
}

const SITE_ERRORS: Record<string, string> = {
  INVALID_NAME: '请填写站点名称',
  INVALID_ADDRESS: '站点地址需要以 http:// 或 https:// 开头',
  INVALID_FORMAT: '采集格式不合法',
  NOT_FOUND: '站点不存在，可能已被删除'
}

const CATEGORY_ERRORS: Record<string, string> = {
  NOT_FOUND: '站点不存在，可能已被删除',
  NETWORK: '连接站点失败，请检查地址或网络后重试',
  HTTP: '站点返回了错误状态，请确认采集接口是否可用',
  PARSE: '站点返回的内容无法解析，请确认采集格式是否选对'
}

const BINDING_ERRORS: Record<string, string> = {
  INVALID_INPUT: '绑定信息已失效，请刷新后重试',
  NOT_FOUND: '分类已被删除，请重新获取后重试'
}

const FORMAT_OPTIONS: { value: SiteFormat; label: string }[] = [
  { value: 'xml', label: 'XML' },
  { value: 'json', label: 'JSON' }
]

/** 在线检索自检的结论：支持 / 疑似忽略关键词 / 没命中 / 请求失败 */
const SEARCH_TEST_VERDICT: Record<
  SiteSearchTestResult['verdict'],
  { text: string; color: string }
> = {
  supported: { text: '支持检索', color: 'success' },
  ignored: { text: '疑似不支持', color: 'warning' },
  empty: { text: '没有命中', color: 'default' },
  failed: { text: '请求失败', color: 'error' }
}

/** 卡片标题：优先显示显示名 */
function siteLabel(site: Site): string {
  return site.display || site.name
}

function isHttpAddress(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 控制台「站点」分区：采集站点以卡片形式展示，支持新增、编辑与删除 */
function SitesPanel({
  title,
  desc,
  onStartBinding
}: {
  title: string
  desc: string
  /** 跳转到分类页，把该站点的在线分类拖到本地分类上完成绑定 */
  onStartBinding: (site: { id: string; name: string }) => void
}): React.JSX.Element {
  const { message, modal } = App.useApp()
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  /** 非空表示当前是编辑该站点，为空则是新增 */
  const [editing, setEditing] = useState<Site | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<SiteFormValues>()
  /** 非空表示分类弹窗打开，并记录当前查看的站点 */
  const [categorySite, setCategorySite] = useState<Site | null>(null)
  const [categories, setCategories] = useState<SiteCategory[]>([])
  const [categoriesLoading, setCategoriesLoading] = useState(false)
  const [categoriesError, setCategoriesError] = useState('')
  /** 「重新获取」是否进行中 */
  const [refreshing, setRefreshing] = useState(false)
  /** 当前站点的绑定关系：siteCategoryId → 绑定的本地分类 */
  const [bindings, setBindings] = useState<Map<string, SiteCategoryBinding>>(new Map())
  const [unbinding, setUnbinding] = useState(false)
  /** 非空表示「分类有变更」确认弹窗打开，并记录待写入的站点与差异 */
  const [pendingSite, setPendingSite] = useState<Site | null>(null)
  const [pendingDiff, setPendingDiff] = useState<SiteCategoryDiff | null>(null)
  const [applying, setApplying] = useState<'incremental' | 'full' | null>(null)
  /** 只认最后一次请求，避免快速切换站点时旧响应覆盖新结果 */
  const categoryRequest = useRef(0)
  /** 在线检索自检弹窗：输入片名发一次真实请求，判断站点支不支持按片名检索 */
  const [testSite, setTestSite] = useState<Site | null>(null)
  const [testKeyword, setTestKeyword] = useState('')
  const [testing, setTesting] = useState(false)
  /** 自检弹窗里直接打开「在线检索」的请求中状态 */
  const [enablingSearch, setEnablingSearch] = useState(false)
  const [testResult, setTestResult] = useState<SiteSearchTestResult | null>(null)
  /** 只认最后一次自检请求：关弹窗 / 换站点后旧结果直接丢弃 */
  const testRequest = useRef(0)

  useEffect(() => {
    let alive = true
    void window.api.sites
      .list()
      .then((rows) => {
        if (alive) setSites(rows)
      })
      .catch(() => {
        if (alive) message.error('站点列表加载失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [message])

  // 弹窗打开后再回填：Form 要等 Modal 首次渲染才挂载
  useEffect(() => {
    if (!formOpen) return
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        display: editing.display,
        address: editing.address,
        format: editing.format,
        remark: editing.remark,
        onlineSearch: editing.onlineSearch,
        disabled: editing.disabled,
        adult: editing.adult
      })
    } else {
      form.resetFields()
    }
  }, [formOpen, editing, form])

  const openAdd = (): void => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (site: Site): void => {
    setEditing(site)
    setFormOpen(true)
  }

  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  const submit = async (): Promise<void> => {
    let values: SiteFormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    const current = editing
    setSaving(true)
    try {
      const result = current
        ? await window.api.sites.update(current.id, values)
        : await window.api.sites.add(values)
      if (!result.ok) {
        message.error(SITE_ERRORS[result.error ?? ''] ?? '保存失败，请重试')
        return
      }
      setSites(await window.api.sites.list())
      closeForm()
      message.success(current ? '站点已更新' : '站点已添加')
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  /** 卡片上的禁用 / 启用：只改这一个字段，其余字段原样带回去（update 是整行覆盖） */
  const toggleDisabled = (site: Site): void => {
    void window.api.sites
      .update(site.id, {
        name: site.name,
        display: site.display,
        address: site.address,
        format: site.format,
        remark: site.remark,
        onlineSearch: site.onlineSearch,
        disabled: !site.disabled,
        adult: site.adult
      })
      .then(async (result) => {
        if (!result.ok) {
          message.error(SITE_ERRORS[result.error ?? ''] ?? '操作失败，请重试')
          return
        }
        setSites(await window.api.sites.list())
        message.success(site.disabled ? '已启用站点' : '已禁用站点')
      })
      .catch(() => message.error('操作失败，请重试'))
  }

  /** 卡片菜单上的 18+ 标记：只改这一个字段，其余字段原样带回去（update 是整行覆盖） */
  const toggleAdult = (site: Site): void => {
    void window.api.sites
      .update(site.id, {
        name: site.name,
        display: site.display,
        address: site.address,
        format: site.format,
        remark: site.remark,
        onlineSearch: site.onlineSearch,
        disabled: site.disabled,
        adult: !site.adult
      })
      .then(async (result) => {
        if (!result.ok) {
          message.error(SITE_ERRORS[result.error ?? ''] ?? '操作失败，请重试')
          return
        }
        setSites(await window.api.sites.list())
        message.success(site.adult ? '已取消 18+ 标记' : '已标记为 18+ 站点')
      })
      .catch(() => message.error('操作失败，请重试'))
  }

  const remove = (site: Site): void => {
    void window.api.sites
      .remove(site.id)
      .then((result) => {
        setSites(result.sites)
        if (result.ok) message.success('站点已删除')
        else message.warning('站点不存在，可能已被删除')
      })
      .catch(() => message.error('删除失败，请重试'))
  }

  /** 删除确认：操作收进「更多」菜单后没法再套 Popconfirm，改用应用级弹窗确认 */
  const confirmRemove = (site: Site): void => {
    modal.confirm({
      title: '删除站点',
      content: `确定删除「${siteLabel(site)}」吗？删除后不可恢复。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => remove(site)
    })
  }

  /** 卡片「更多」菜单：编辑 / 测试 / 分类 / 绑定 / 禁用 / 删除都收在这颗竖排三点里 */
  const runMoreAction = (key: string, site: Site): void => {
    if (key === 'edit') openEdit(site)
    else if (key === 'test') openSearchTest(site)
    else if (key === 'categories') loadCategories(site)
    else if (key === 'bind') startBindingFromCard(site)
    else if (key === 'adult') toggleAdult(site)
    else if (key === 'toggle') toggleDisabled(site)
    else if (key === 'remove') confirmRemove(site)
  }

  const loadBindings = (siteId: string): void => {
    void window.api.bindings
      .forSite(siteId)
      .then((rows) => setBindings(new Map(rows.map((row) => [row.siteCategoryId, row]))))
      .catch(() => {})
  }

  const loadCategories = (site: Site): void => {
    const requestId = categoryRequest.current + 1
    categoryRequest.current = requestId
    setCategorySite(site)
    setCategories([])
    setCategoriesError('')
    setCategoriesLoading(true)
    setBindings(new Map())
    void window.api.sites
      .categories(site.id)
      .then((result) => {
        if (categoryRequest.current !== requestId) return
        if (!result.ok) {
          setCategoriesError(CATEGORY_ERRORS[result.error ?? ''] ?? '获取分类失败，请重试')
          return
        }
        setCategories(result.categories ?? [])
      })
      .catch(() => {
        if (categoryRequest.current === requestId) setCategoriesError('获取分类失败，请重试')
      })
      .finally(() => {
        if (categoryRequest.current === requestId) setCategoriesLoading(false)
      })
    loadBindings(site.id)
  }

  /** 关闭「分类有变更」确认弹窗 */
  const closeDiff = (): void => {
    setPendingSite(null)
    setPendingDiff(null)
    setApplying(null)
  }

  const closeCategories = (): void => {
    categoryRequest.current += 1
    setCategorySite(null)
    setCategories([])
    setCategoriesError('')
    setCategoriesLoading(false)
    setRefreshing(false)
    setBindings(new Map())
    setUnbinding(false)
    closeDiff()
  }

  /** 重新抓取：只对比不写库；没有变化直接提示，有变化弹确认窗让用户选更新方式 */
  const refreshCategories = (site: Site): void => {
    const requestId = categoryRequest.current
    setRefreshing(true)
    void window.api.sites
      .refreshCategories(site.id)
      .then((result) => {
        if (categoryRequest.current !== requestId) return
        if (!result.ok) {
          message.error(CATEGORY_ERRORS[result.error ?? ''] ?? '重新获取失败，请重试')
          return
        }
        if (!result.hasChanges || !result.diff) {
          message.success('分类无变化')
          return
        }
        setPendingSite(site)
        setPendingDiff(result.diff)
      })
      .catch(() => {
        if (categoryRequest.current === requestId) message.error('重新获取失败，请重试')
      })
      .finally(() => {
        if (categoryRequest.current === requestId) setRefreshing(false)
      })
  }

  /** 按用户选择的方式，把待确认的抓取结果写入数据库 */
  const applyCategoryUpdate = (mode: 'incremental' | 'full'): void => {
    if (!pendingSite) return
    setApplying(mode)
    void window.api.sites
      .applyCategories(pendingSite.id, mode)
      .then((result) => {
        if (!result.ok) {
          if (result.error === 'EXPIRED') {
            closeDiff()
            message.error('抓取结果已过期，请重新获取')
            return
          }
          if (result.error === 'NOT_FOUND') {
            closeDiff()
            message.error('站点不存在，可能已被删除')
            return
          }
          message.error('更新分类失败，请重试')
          return
        }
        setCategories(result.categories ?? [])
        // 全量更新可能删掉已绑定的在线分类，绑定关系会跟着级联清理，这里重新拉一次
        loadBindings(pendingSite.id)
        closeDiff()
        message.success(mode === 'full' ? '已按全量更新分类' : '已按增量更新分类')
      })
      .catch(() => message.error('更新分类失败，请重试'))
      .finally(() => setApplying(null))
  }

  /** 已绑定在线分类对应的采集端 ID，用来说明全量更新会解绑哪些 */
  const boundSourceIds = useMemo(() => {
    const sourceById = new Map(categories.map((item) => [item.id, item.sourceId]))
    const result = new Set<string>()
    for (const id of bindings.keys()) {
      const sourceId = sourceById.get(id)
      if (sourceId) result.add(sourceId)
    }
    return result
  }, [categories, bindings])

  /** 全量更新会连带解绑的数量 */
  const removedBoundCount = pendingDiff
    ? pendingDiff.removed.filter((item) => boundSourceIds.has(item.sourceId)).length
    : 0

  /** 弹窗里只做单条解绑；绑定在分类页的映射模式里完成 */
  const unbindOne = (siteCategoryId: string): void => {
    if (!categorySite) return
    setUnbinding(true)
    void window.api.bindings
      .unbind([{ siteId: categorySite.id, siteCategoryId }])
      .then((result) => {
        if (!result.ok) {
          message.error(BINDING_ERRORS[result.error ?? ''] ?? '解绑失败，请重试')
          return
        }
        loadBindings(categorySite.id)
        message.success('已解绑')
      })
      .catch(() => message.error('解绑失败，请重试'))
      .finally(() => setUnbinding(false))
  }

  const startBinding = (): void => {
    if (!categorySite) return
    const target = { id: categorySite.id, name: siteLabel(categorySite) }
    closeCategories()
    onStartBinding(target)
  }

  /** 卡片上的「绑定」快捷入口：还没存过分类时先打开分类弹窗取一次，免得进去是空的 */
  const startBindingFromCard = (site: Site): void => {
    void window.api.sites
      .categories(site.id)
      .then((result) => {
        if (result.ok && (result.categories?.length ?? 0) > 0) {
          onStartBinding({ id: site.id, name: siteLabel(site) })
          return
        }
        loadCategories(site)
      })
      .catch(() => message.error('读取站点分类失败，请重试'))
  }

  const openSearchTest = (site: Site): void => {
    // 关掉 / 换站点时作废上一次还在路上的请求，别把结果贴到另一个站点上
    testRequest.current += 1
    setTestSite(site)
    setTestKeyword('')
    setTestResult(null)
  }

  const closeSearchTest = (): void => {
    testRequest.current += 1
    setTestSite(null)
    setTestResult(null)
    setTesting(false)
  }

  /** 发一次真实请求；结果只展示，不写缓存库，所以随时可以放心试 */
  const runSearchTest = async (): Promise<void> => {
    if (!testSite) return
    const keyword = testKeyword.trim()
    if (!keyword) {
      message.warning('请先填写要测试的片名')
      return
    }
    const token = (testRequest.current += 1)
    setTesting(true)
    try {
      const result = await window.api.sites.testSearch({ siteId: testSite.id, keyword })
      if (testRequest.current !== token) return
      setTestResult(result)
    } catch {
      if (testRequest.current === token) message.error('测试失败，请重试')
    } finally {
      if (testRequest.current === token) setTesting(false)
    }
  }

  /** 自检确认真能按片名搜，就在这个弹窗里直接打开「在线检索」，省得再去编辑弹窗 */
  const enableOnlineSearch = async (): Promise<void> => {
    if (!testSite || testSite.onlineSearch) return
    const targetId = testSite.id
    setEnablingSearch(true)
    try {
      const result = await window.api.sites.update(targetId, {
        name: testSite.name,
        display: testSite.display,
        address: testSite.address,
        format: testSite.format,
        remark: testSite.remark,
        disabled: testSite.disabled,
        adult: testSite.adult,
        onlineSearch: true
      })
      if (!result.ok) {
        message.error(SITE_ERRORS[result.error ?? ''] ?? '开启失败，请重试')
        return
      }
      // 先就地改卡片再关弹窗：列表刷新是本地库读取，晚一拍不影响，也不会让弹窗多挂一会儿
      setSites((previous) =>
        previous.map((site) => (site.id === targetId ? { ...site, onlineSearch: true } : site))
      )
      message.success('已开启在线检索')
      closeSearchTest()
      void window.api.sites
        .list()
        .then(setSites)
        .catch(() => {})
    } catch {
      message.error('开启失败，请重试')
    } finally {
      setEnablingSearch(false)
    }
  }

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">共 {sites.length} 个站点</span>
        </p>
        <div className="settings-panel-actions">
          <Tooltip title="新增站点">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openAdd}
              aria-label="新增站点"
            />
          </Tooltip>
        </div>
      </div>

      {loading ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在加载站点…</span>
        </div>
      ) : sites.length === 0 ? (
        <div className="sites-placeholder">
          <span className="sites-empty-title">暂无站点</span>
          <span className="sites-empty-hint">点击右上角的 + 录入第一个采集站</span>
        </div>
      ) : (
        <div className="sites-grid">
          {sites.map((site) => (
            <article className={`site-card${site.disabled ? ' is-disabled' : ''}`} key={site.id}>
              <div className="site-card-head">
                <div className="site-card-title">
                  <span className="site-card-name">{siteLabel(site)}</span>
                  <Tooltip title={`采集格式：${site.format.toUpperCase()}`}>
                    <span className={`site-card-format is-${site.format}`}>
                      <SiteFormatIcon format={site.format} />
                    </span>
                  </Tooltip>
                  {site.disabled && <Tag className="site-card-disabled">已禁用</Tag>}
                  {site.adult && (
                    <Tooltip title="18+ 站点：设置里关闭「显示 18+ 内容」时，这个站点的视频在展示端和共享页都不可见">
                      <Tag className="site-card-adult">18+</Tag>
                    </Tooltip>
                  )}
                  {site.onlineSearch && (
                    <Tooltip title="支持在线检索：搜索页可切到「在线」，采集里多出「检索」方式">
                      <span className="site-card-online" aria-label="支持在线检索">
                        <GlobalOutlined />
                      </span>
                    </Tooltip>
                  )}
                </div>
                <div className="site-card-actions">
                  {/* 所有操作都收进竖排三点，标题行只留一颗按钮 */}
                  <Dropdown
                    trigger={['click']}
                    placement="bottomRight"
                    menu={{
                      items: [
                        { key: 'edit', icon: <EditOutlined />, label: '编辑站点' },
                        { type: 'divider' },
                        { key: 'test', icon: <SearchOutlined />, label: '测试在线检索' },
                        { key: 'categories', icon: <TagsOutlined />, label: '获取分类' },
                        { key: 'bind', icon: <LinkOutlined />, label: '绑定在线分类' },
                        {
                          key: 'adult',
                          icon: <SafetyCertificateOutlined />,
                          label: site.adult ? '取消 18+ 标记' : '标记为 18+ 站点'
                        },
                        { type: 'divider' },
                        {
                          key: 'toggle',
                          icon: site.disabled ? <PlayCircleOutlined /> : <PauseCircleOutlined />,
                          label: site.disabled ? '启用站点' : '禁用站点'
                        },
                        { type: 'divider' },
                        { key: 'remove', icon: <DeleteOutlined />, label: '删除站点', danger: true }
                      ],
                      onClick: ({ key, domEvent }) => {
                        // 卡片本身没有点击行为，这里只是别让菜单点击冒泡到头部
                        domEvent.stopPropagation()
                        runMoreAction(key, site)
                      }
                    }}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<MoreVerticalIcon />}
                      aria-label={`更多操作：${siteLabel(site)}`}
                    />
                  </Dropdown>
                </div>
              </div>

              {site.display && site.display !== site.name && (
                <span className="site-card-alias">{site.name}</span>
              )}
              <span className="site-card-address" title={site.address}>
                {site.address}
              </span>
              {site.remark && <span className="site-card-remark">{site.remark}</span>}
              <span className="site-card-meta" title={`创建于 ${formatDateTime(site.createdAt)}`}>
                更新于 {formatDateTime(site.updatedAt)}
              </span>
            </article>
          ))}
        </div>
      )}

      <Modal
        title={editing ? '编辑站点' : '新增站点'}
        open={formOpen}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void submit()}
        onCancel={closeForm}
        width={720}
      >
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ format: 'xml', onlineSearch: false, disabled: false, adult: false }}
          className="site-form"
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="name"
                label="名称"
                rules={[{ required: true, whitespace: true, message: '请填写站点名称' }]}
              >
                <Input maxLength={60} placeholder="站点名称，如：某资源站" allowClear />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="display" label="显示">
                <Input maxLength={60} placeholder="留空则使用名称" allowClear />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="address"
            label="地址"
            rules={[
              { required: true, whitespace: true, message: '请填写采集站地址' },
              {
                validator: (_rule, value?: string) =>
                  !value || isHttpAddress(value.trim())
                    ? Promise.resolve()
                    : Promise.reject(new Error('地址需要以 http:// 或 https:// 开头'))
              }
            ]}
          >
            <Input placeholder="https://example.com/api.php/provide/vod" allowClear />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="onlineSearch"
                label="在线检索"
                valuePropName="checked"
                extra="开启后搜索页可切到「在线」，采集里多出「检索」方式；站点不支持按片名检索时请勿开启。"
              >
                <Switch checkedChildren="支持" unCheckedChildren="不支持" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="format"
                label="格式"
                rules={[{ required: true, message: '请选择采集格式' }]}
              >
                <Select options={FORMAT_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="disabled"
                label="禁用站点"
                valuePropName="checked"
                extra="禁用后不再采集，也不参与本地 / 在线搜索，展示端不再显示只属于它的视频；缓存保留，重新启用即恢复。"
              >
                <Switch checkedChildren="已禁用" unCheckedChildren="正常" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="adult"
                label="18+ 站点"
                valuePropName="checked"
                extra="设置里关闭「显示 18+ 内容」后，它的视频在推荐、找片看、搜索、播放页和共享页都不可见；控制台仍可见。"
              >
                <Switch checkedChildren="18+" unCheckedChildren="普通" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea
              rows={3}
              maxLength={200}
              showCount
              placeholder="其它需要记录的信息，可留空"
              style={{ resize: 'none' }}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={testSite ? `测试在线检索「${siteLabel(testSite)}」` : '测试在线检索'}
        open={Boolean(testSite)}
        onCancel={closeSearchTest}
        footer={null}
        width={560}
      >
        <p className="site-search-test-hint">
          输入片名后点右侧搜索（或回车），会真的向站点搜一次，结果不会入库；片名里找不到你搜的词，就说明它不支持按片名搜索。
        </p>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={testKeyword}
            onChange={(event) => setTestKeyword(event.target.value)}
            onPressEnter={() => void runSearchTest()}
            placeholder="输入片名，如：名侦探柯南"
            maxLength={60}
            allowClear
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={testing}
            onClick={() => void runSearchTest()}
            aria-label="测试"
            title="测试"
          />
        </Space.Compact>
        {/* 结果区固定占位：没搜 / 没命中时也保留高度，弹窗不会随条数忽大忽小 */}
        <div className="site-search-test-slot">
          {testResult && (
            <div className={`site-search-test is-${testResult.verdict}`}>
              <div className="site-search-test-head">
                <Tag color={SEARCH_TEST_VERDICT[testResult.verdict].color}>
                  {SEARCH_TEST_VERDICT[testResult.verdict].text}
                </Tag>
                <span className="site-search-test-meta">
                  {testResult.elapsedMs} ms
                  {testResult.status > 0 ? ` · HTTP ${testResult.status}` : ''}
                  {` · 本页 ${testResult.count} 条`}
                  {testResult.recordCount > 0
                    ? ` · 共 ${formatCount(testResult.recordCount)} 条`
                    : ''}
                  {testResult.pageSize > 0 ? ` · 每页 ${testResult.pageSize} 条` : ''}
                </span>
              </div>
              <p className="site-search-test-message">{testResult.message}</p>
              {testResult.items.length > 0 && (
                <ul className="site-search-test-list">
                  {testResult.items.map((item, index) => (
                    <li key={`${item.sourceVideoId}-${index}`}>
                      <span className="site-search-test-name" title={item.name}>
                        {item.name}
                      </span>
                      {item.note && <span className="site-search-test-note">{item.note}</span>}
                      {item.sourceTime && (
                        <span className="site-search-test-time">{item.sourceTime}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {/* 站点还没开启在线检索时，测完可以直接在这里打开，不用再进编辑弹窗 */}
        {testSite && !testSite.onlineSearch && (
          <div className="site-search-test-action">
            <span
              className={`site-search-test-tip${
                testResult?.verdict === 'supported' ? '' : ' is-muted'
              }`}
            >
              {testResult?.verdict === 'supported'
                ? '能按片名搜索，直接开启就好。'
                : '开启后「采集」多出「检索」方式，搜索页也能切到「在线」。'}
            </span>
            <Button
              type="primary"
              size="small"
              loading={enablingSearch}
              onClick={() => void enableOnlineSearch()}
            >
              开启在线检索
            </Button>
          </div>
        )}
      </Modal>

      <Modal
        title={categorySite ? `「${siteLabel(categorySite)}」的视频分类` : '视频分类'}
        open={Boolean(categorySite)}
        onCancel={closeCategories}
        footer={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={refreshing}
              disabled={!categorySite}
              onClick={() => categorySite && refreshCategories(categorySite)}
            >
              重新获取
            </Button>
            <Button
              type="primary"
              disabled={!categorySite || categories.length === 0}
              onClick={startBinding}
            >
              绑定
            </Button>
            <Button onClick={closeCategories}>关闭</Button>
          </Space>
        }
        width={720}
      >
        {categoriesLoading ? (
          <div className="categories-state">
            <Spin size="small" />
            <span>正在获取分类…</span>
          </div>
        ) : categoriesError ? (
          <div className="categories-state">
            <span className="categories-error">{categoriesError}</span>
            {categorySite && (
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => loadCategories(categorySite)}
              >
                重试
              </Button>
            )}
          </div>
        ) : categories.length === 0 ? (
          <div className="categories-state">
            <span>该站点没有返回分类</span>
          </div>
        ) : (
          <>
            <div className="binding-summary">
              共 {categories.length} 个分类 · 已绑定 {bindings.size} 个
            </div>
            <ul className="binding-list">
              {categories.map((category) => {
                const bound = bindings.get(category.id)
                const path = bound ? splitCategoryPath(bound.categoryPath) : null
                return (
                  <li className={`binding-row${bound ? ' is-bound' : ''}`} key={category.id}>
                    <span className="binding-name" title={`ID ${category.sourceId}`}>
                      {category.name}
                    </span>
                    {bound && path ? (
                      <span className="binding-state is-bound" title={bound.categoryPath}>
                        {path.parent && (
                          <span className="binding-path-parent">{path.parent} / </span>
                        )}
                        <span className="binding-path-leaf">{path.leaf}</span>
                      </span>
                    ) : (
                      <span className="binding-state">未绑定</span>
                    )}
                    {bound && <LinkOutlined className="binding-mark" aria-hidden />}
                    {bound && (
                      <Tooltip title="解除绑定">
                        <button
                          type="button"
                          className="binding-unbind"
                          disabled={unbinding}
                          onClick={() => unbindOne(category.id)}
                          aria-label={`解除「${category.name}」的绑定`}
                        >
                          <CloseOutlined />
                        </button>
                      </Tooltip>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Modal>

      <Modal
        title={pendingSite ? `「${siteLabel(pendingSite)}」分类有变更` : '分类有变更'}
        open={Boolean(pendingDiff)}
        onCancel={closeDiff}
        width={640}
        footer={
          <Space>
            <Button onClick={closeDiff} disabled={Boolean(applying)}>
              取消
            </Button>
            <Button
              onClick={() => applyCategoryUpdate('incremental')}
              loading={applying === 'incremental'}
              disabled={!pendingDiff || (!pendingDiff.added.length && !pendingDiff.renamed.length)}
            >
              增量更新
            </Button>
            <Button
              type="primary"
              onClick={() => applyCategoryUpdate('full')}
              loading={applying === 'full'}
            >
              全量更新
            </Button>
          </Space>
        }
      >
        {pendingDiff && (
          <div className="category-diff">
            <p className="category-diff-hint">
              增量更新只新增和改名，保留库中多出来的分类；全量更新以本次抓取结果为准，会删除多出来的分类，已绑定的分类会一并解除绑定。
            </p>
            {pendingDiff.added.length > 0 && (
              <section className="category-diff-section">
                <h4>新增 {pendingDiff.added.length} 个</h4>
                <div className="categories-list">
                  {pendingDiff.added.map((item) => (
                    <span
                      className="category-chip"
                      key={item.sourceId}
                      title={`ID ${item.sourceId}`}
                    >
                      {item.name}
                    </span>
                  ))}
                </div>
              </section>
            )}
            {pendingDiff.renamed.length > 0 && (
              <section className="category-diff-section">
                <h4>改名 {pendingDiff.renamed.length} 个</h4>
                <div className="category-diff-renamed">
                  {pendingDiff.renamed.map((item) => (
                    <div className="category-diff-rename-row" key={item.sourceId}>
                      <span className="category-diff-from">{item.from}</span>
                      <span className="category-diff-arrow">→</span>
                      <span className="category-diff-to">{item.to}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {pendingDiff.removed.length > 0 && (
              <section className="category-diff-section">
                <h4>
                  本次未返回 {pendingDiff.removed.length} 个（全量更新会删除
                  {removedBoundCount > 0 ? `，其中 ${removedBoundCount} 个已绑定` : ''}）
                </h4>
                <div className="categories-list">
                  {pendingDiff.removed.map((item) => (
                    <span
                      className="category-chip category-chip-removed"
                      key={item.sourceId}
                      title={`ID ${item.sourceId}`}
                    >
                      {item.name}
                      {boundSourceIds.has(item.sourceId) && (
                        <span className="category-chip-flag">已绑定</span>
                      )}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}

export default SitesPanel
