import { useEffect, useRef, useState } from 'react'
import {
  App,
  Button,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Spin,
  Tag,
  Tooltip
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  TagsOutlined
} from '@ant-design/icons'

interface SiteFormValues {
  name: string
  display?: string
  address: string
  format: SiteFormat
  remark?: string
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

const FORMAT_OPTIONS: { value: SiteFormat; label: string }[] = [
  { value: 'xml', label: 'XML' },
  { value: 'json', label: 'JSON' }
]

/** 卡片里统一显示到分钟，避免秒级噪音 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

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
function SitesPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
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
  /** 只认最后一次请求，避免快速切换站点时旧响应覆盖新结果 */
  const categoryRequest = useRef(0)

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
        remark: editing.remark
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

  const loadCategories = (site: Site): void => {
    const requestId = categoryRequest.current + 1
    categoryRequest.current = requestId
    setCategorySite(site)
    setCategories([])
    setCategoriesError('')
    setCategoriesLoading(true)
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
  }

  const closeCategories = (): void => {
    categoryRequest.current += 1
    setCategorySite(null)
    setCategories([])
    setCategoriesError('')
    setCategoriesLoading(false)
  }

  return (
    <>
      <div className="sites-header">
        <div className="sites-head">
          <h2 className="settings-panel-title">{title}</h2>
          <Tooltip title="新增站点">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openAdd}
              aria-label="新增站点"
            />
          </Tooltip>
        </div>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">共 {sites.length} 个站点</span>
        </p>
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
            <article className="site-card" key={site.id}>
              <div className="site-card-head">
                <div className="site-card-title">
                  <span className="site-card-name">{siteLabel(site)}</span>
                  <Tag
                    className="site-card-format"
                    color={site.format === 'xml' ? 'blue' : 'green'}
                  >
                    {site.format.toUpperCase()}
                  </Tag>
                </div>
                <div className="site-card-actions">
                  <Tooltip title="获取分类">
                    <Button
                      type="text"
                      size="small"
                      icon={<TagsOutlined />}
                      onClick={() => loadCategories(site)}
                      aria-label={`获取 ${siteLabel(site)} 的视频分类`}
                    />
                  </Tooltip>
                  <Tooltip title="编辑">
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => openEdit(site)}
                      aria-label={`编辑 ${siteLabel(site)}`}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="删除站点"
                    description={`确定删除「${siteLabel(site)}」吗？删除后不可恢复。`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove(site)}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label={`删除 ${siteLabel(site)}`}
                    />
                  </Popconfirm>
                </div>
              </div>

              {site.display && site.display !== site.name && (
                <span className="site-card-alias">{site.name}</span>
              )}
              <span className="site-card-address" title={site.address}>
                {site.address}
              </span>
              {site.remark && <span className="site-card-remark">{site.remark}</span>}
              <span className="site-card-meta" title={`创建于 ${formatTime(site.createdAt)}`}>
                更新于 {formatTime(site.updatedAt)}
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
        width={480}
      >
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ format: 'xml' }}
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
          <Form.Item
            name="format"
            label="格式"
            rules={[{ required: true, message: '请选择采集格式' }]}
          >
            <Select options={FORMAT_OPTIONS} />
          </Form.Item>
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
        title={categorySite ? `「${siteLabel(categorySite)}」的视频分类` : '视频分类'}
        open={Boolean(categorySite)}
        onCancel={closeCategories}
        footer={<Button onClick={closeCategories}>关闭</Button>}
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
            <div className="categories-summary">共 {categories.length} 个分类</div>
            <div className="categories-list">
              {categories.map((category) => (
                <span className="category-chip" key={category.id} title={`ID ${category.id}`}>
                  {category.name}
                </span>
              ))}
            </div>
          </>
        )}
      </Modal>
    </>
  )
}

export default SitesPanel
