import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App,
  Button,
  Drawer,
  Form,
  Input,
  List,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  Tooltip
} from 'antd'
import {
  EyeInvisibleOutlined,
  EyeOutlined,
  EditOutlined,
  FileSearchOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import { formatDateTime } from '../utils/format'

const PAGE_SIZE = 10
/** 单条线路最多铺开的集数，避免几百集的剧把抽屉撑爆 */
const EPISODE_LIMIT = 12

type Visibility = 'all' | 'shown' | 'hidden'

interface EditFields {
  note: string
  intro: string
  vodActor: string
  vodClass: string
}

/** 打开编辑时的原值，保存时只提交改动过的字段 */
interface EditOrigin extends EditFields {
  pic: string
  hidden: boolean
}

function siteLabel(sites: Map<string, Site>, siteId: string): string {
  const site = sites.get(siteId)
  return site ? site.display || site.name : `已删除站点 ${siteId.slice(0, 8)}`
}

/** 详情索引状态：已缓存 / 已过期 / 未缓存 */
function detailTag(source: VideoDetailSource): React.JSX.Element {
  if (!source.detailCachedAt) return <Tag color="default">未缓存详情</Tag>
  if (source.detailStale) return <Tag color="warning">详情已过期</Tag>
  return <Tag color="success">详情已缓存</Tag>
}

/** 控制台「视频」：已采集视频列表（antd List + 分页 + 搜索），可编辑信息、换封面、隐藏 */
function VideosPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [form] = Form.useForm<EditFields>()
  const [sites, setSites] = useState<Site[]>([])
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('all')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<VideoListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<VideoDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editTarget, setEditTarget] = useState<VideoListItem | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [editSources, setEditSources] = useState<VideoDetailSource[]>([])
  const [editOriginal, setEditOriginal] = useState<EditOrigin>({
    note: '',
    intro: '',
    vodActor: '',
    vodClass: '',
    pic: '',
    hidden: false
  })
  const [draftPic, setDraftPic] = useState('')
  const [draftHidden, setDraftHidden] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 快速翻页时只认最后一次请求的结果 */
  const requestId = useRef(0)

  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites])

  useEffect(() => {
    window.api.sites
      .list()
      .then(setSites)
      .catch(() => {
        // 站点名缺失只影响展示，列表本身照常
      })
  }, [])

  const loadPage = useCallback(async (): Promise<void> => {
    const ticket = ++requestId.current
    setLoading(true)
    try {
      const result = await window.api.videos.list({
        keyword: query,
        page,
        pageSize: PAGE_SIZE,
        visibility
      })
      if (ticket !== requestId.current) return
      if (!result.ok) {
        setItems([])
        setTotal(0)
        message.error('读取视频列表失败，试试重新采集')
        return
      }
      // 删到末页时回退一页，避免停在空白页
      if (result.items.length === 0 && result.total > 0 && page > 1) {
        setPage(Math.max(1, Math.ceil(result.total / PAGE_SIZE)))
        return
      }
      setItems(result.items)
      setTotal(result.total)
    } catch {
      if (ticket === requestId.current) message.error('读取视频列表失败')
    } finally {
      if (ticket === requestId.current) setLoading(false)
    }
  }, [message, page, query, visibility])

  useEffect(() => {
    // setState 发生在 await 之后；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPage()
  }, [loadPage])

  const openDetail = async (item: VideoListItem): Promise<void> => {
    setDetailOpen(true)
    setDetail(null)
    setDetailLoading(true)
    try {
      // 默认 autoFetch：详情没缓存时顺手抓一次，回来就能看线路
      const result = await window.api.videos.detail(item.id)
      if (!result.ok || !result.video) {
        message.error('读取视频详情失败')
        setDetailOpen(false)
        return
      }
      setDetail(result.video)
    } catch {
      message.error('读取视频详情失败')
      setDetailOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const openEdit = async (item: VideoListItem): Promise<void> => {
    const baseline: EditOrigin = {
      note: item.note,
      intro: item.introExcerpt,
      vodActor: item.vodActor,
      vodClass: item.vodClass,
      pic: '',
      hidden: item.hidden
    }
    setEditTarget(item)
    setEditOpen(true)
    setEditLoading(true)
    setEditSources([])
    setEditOriginal(baseline)
    setDraftPic('')
    setDraftHidden(item.hidden)
    form.setFieldsValue({
      note: item.note,
      intro: item.introExcerpt,
      vodActor: item.vodActor,
      vodClass: item.vodClass
    })
    try {
      // 只读缓存里的来源，编辑时不因为换封面去抓详情
      const result = await window.api.videos.detail(item.id, { autoFetch: false })
      if (result.ok && result.video) {
        const video = result.video
        setEditSources(video.sources)
        // picSiteId 非空说明当前封面是手动选的，回填选中态；否则停留在「默认」
        const chosenPic = video.picSiteId ? video.pic : ''
        setEditOriginal({
          note: video.note,
          intro: video.introExcerpt,
          vodActor: video.vodActor,
          vodClass: video.vodClass,
          pic: chosenPic,
          hidden: video.hidden
        })
        setDraftPic(chosenPic)
        setDraftHidden(video.hidden)
        form.setFieldsValue({
          note: video.note,
          intro: video.introExcerpt,
          vodActor: video.vodActor,
          vodClass: video.vodClass
        })
      }
    } catch {
      // 拿不到来源就只能改文字，封面区提示为空
    } finally {
      setEditLoading(false)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (!editTarget) return
    const values = await form.validateFields()
    // 只提交真正改过的字段：没动的字段不产生覆盖，保存后不会被标成「已编辑」
    const patch: VideoUpdateInput = {}
    if (values.note !== editOriginal.note) patch.note = values.note
    if (values.intro !== editOriginal.intro) patch.intro = values.intro
    if (values.vodActor !== editOriginal.vodActor) patch.vodActor = values.vodActor
    if (values.vodClass !== editOriginal.vodClass) patch.vodClass = values.vodClass
    if (draftPic !== editOriginal.pic) patch.pic = draftPic
    if (draftHidden !== editOriginal.hidden) patch.hidden = draftHidden
    if (Object.keys(patch).length === 0) {
      message.info('没有改动')
      setEditOpen(false)
      return
    }
    setSaving(true)
    try {
      const result = await window.api.videos.update(editTarget.id, patch)
      if (!result.ok) {
        message.error(result.error === 'INVALID_PIC' ? '封面必须来自该视频的来源' : '保存失败')
        return
      }
      message.success('已保存')
      setEditOpen(false)
      setEditTarget(null)
      await loadPage()
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 清空所有文字与封面覆盖，回落到采集值；隐藏状态保持不变 */
  const resetEdits = async (): Promise<void> => {
    if (!editTarget) return
    setSaving(true)
    try {
      const result = await window.api.videos.update(editTarget.id, {
        note: '',
        intro: '',
        vodActor: '',
        vodClass: '',
        pic: ''
      })
      if (!result.ok) {
        message.error('恢复失败')
        return
      }
      message.success('已恢复采集值')
      setEditOpen(false)
      setEditTarget(null)
      await loadPage()
    } catch {
      message.error('恢复失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleHidden = async (item: VideoListItem): Promise<void> => {
    try {
      const result = await window.api.videos.update(item.id, { hidden: !item.hidden })
      if (!result.ok) {
        message.error('操作失败')
        return
      }
      message.success(item.hidden ? '已恢复显示' : '已隐藏')
      await loadPage()
    } catch {
      message.error('操作失败')
    }
  }

  /** 可选的封面：来自该视频的所有来源，同一张图只留一个；同名站点带上来源短号区分 */
  const coverOptions = useMemo(() => {
    const seen = new Set<string>()
    const options: { pic: string; siteId: string; siteName: string }[] = []
    for (const source of editSources) {
      if (!source.pic || seen.has(source.pic)) continue
      seen.add(source.pic)
      const siteName = siteLabel(siteMap, source.siteId)
      const sameSite = editSources.filter((item) => item.siteId === source.siteId).length > 1
      options.push({
        pic: source.pic,
        siteId: source.siteId,
        siteName: sameSite ? `${siteName} · ${source.sourceVideoId.slice(-4)}` : siteName
      })
    }
    return options
  }, [editSources, siteMap])

  /** 「默认」缩略图用主来源的图，方便对比换了没有 */
  const primaryPic = editSources[0]?.pic ?? ''

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">{desc}</p>
        <div className="settings-panel-actions">
          <Select
            className="video-visibility"
            value={visibility}
            onChange={(value) => {
              setVisibility(value)
              setPage(1)
            }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'shown', label: '显示中' },
              { value: 'hidden', label: '已隐藏' }
            ]}
          />
          <Input.Search
            className="video-search"
            allowClear
            placeholder="搜索片名"
            value={keyword}
            onChange={(event) => {
              const next = event.target.value
              setKeyword(next)
              if (!next) {
                setQuery('')
                setPage(1)
              }
            }}
            onSearch={(value) => {
              setQuery(value.trim())
              setPage(1)
            }}
          />
          <Tooltip title="重新读取视频列表">
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              aria-label="刷新"
              onClick={() => void loadPage()}
            />
          </Tooltip>
        </div>
      </div>

      <List
        className="video-list"
        itemLayout="vertical"
        size="large"
        loading={loading}
        dataSource={items}
        locale={{
          emptyText: (
            <div className="sites-placeholder">
              <span className="sites-empty-title">
                {query
                  ? '没有匹配的视频'
                  : visibility === 'hidden'
                    ? '没有隐藏的视频'
                    : '视频库还是空的'}
              </span>
              <span className="sites-empty-hint">
                {query
                  ? '换个片名关键词试试'
                  : visibility === 'hidden'
                    ? '在列表里点「隐藏」就会出现在这里'
                    : '去「采集」发起一次采集，抓到的视频会出现在这里'}
              </span>
            </div>
          )
        }}
        pagination={
          total > PAGE_SIZE
            ? {
                current: page,
                pageSize: PAGE_SIZE,
                total,
                showSizeChanger: false,
                showTotal: (count) => `共 ${count} 个视频`,
                onChange: (next) => setPage(next)
              }
            : false
        }
        renderItem={(item) => (
          <List.Item
            key={item.id}
            extra={
              <div className="video-cover">
                <span className="video-cover-letter">{item.name.trim().slice(0, 1)}</span>
                {item.pic && (
                  <img
                    src={item.pic}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                )}
              </div>
            }
            actions={[
              <Tooltip key="detail" title="查看详情">
                <Button
                  className="video-action"
                  type="text"
                  size="small"
                  icon={<FileSearchOutlined />}
                  aria-label="查看详情"
                  onClick={() => void openDetail(item)}
                />
              </Tooltip>,
              <Tooltip key="edit" title="编辑信息">
                <Button
                  className="video-action"
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  aria-label="编辑信息"
                  onClick={() => void openEdit(item)}
                />
              </Tooltip>,
              <Tooltip key="hidden" title={item.hidden ? '恢复显示' : '隐藏'}>
                <Button
                  className="video-action"
                  type="text"
                  size="small"
                  icon={item.hidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                  aria-label={item.hidden ? '恢复显示' : '隐藏'}
                  onClick={() => void toggleHidden(item)}
                />
              </Tooltip>
            ]}
          >
            <List.Item.Meta
              title={
                <div className="video-title">
                  <span className="video-title-text" title={item.name}>
                    {item.name}
                  </span>
                  {item.note && <span className="video-title-note">{item.note}</span>}
                  {item.hidden && <Tag color="default">已隐藏</Tag>}
                  {item.edited && <Tag color="processing">已编辑</Tag>}
                </div>
              }
              description={
                <div className="video-meta">
                  <span className="video-meta-strong">{item.sourceCount} 个来源</span>
                  <span className="video-meta-dot" />
                  {item.localCategoryPaths.length > 0 ? (
                    <span className="video-meta-class" title={item.localCategoryPaths.join('、')}>
                      {item.localCategoryPaths.join('、')}
                    </span>
                  ) : (
                    <span className="video-meta-class is-empty">未绑定分类</span>
                  )}
                  <span className="video-meta-dot" />
                  <span
                    className="video-meta-class video-meta-raw"
                    title={item.vodClass || item.categoryName || '未分类'}
                  >
                    {item.vodClass || item.categoryName || '未分类'}
                  </span>
                  <span className="video-meta-dot" />
                  <span className="video-meta-strong">更新 {item.latestTime}</span>
                </div>
              }
            />
            <p className="video-intro">{item.introExcerpt || '暂无简介'}</p>
            <p className="video-actor" title={`主演：${item.vodActor || '未知'}`}>
              主演：{item.vodActor || '未知'}
            </p>
          </List.Item>
        )}
      />

      <Modal
        title="编辑视频信息"
        open={editOpen}
        width={760}
        onCancel={() => setEditOpen(false)}
        destroyOnHidden
        classNames={{ body: 'video-edit-scroll' }}
        afterOpenChange={(open) => {
          // 弹窗主体是复用的，上次滚到哪就停在哪，重新打开时拉回顶部
          if (!open) return
          const scroller = document.querySelector('.video-edit-scroll')
          if (scroller instanceof HTMLElement) scroller.scrollTop = 0
        }}
        styles={{ body: { maxHeight: 'calc(100vh - 260px)', overflowY: 'auto', paddingRight: 6 } }}
        footer={[
          editTarget?.edited ? (
            <Button
              key="reset"
              type="text"
              danger
              disabled={saving}
              onClick={() => void resetEdits()}
            >
              恢复采集值
            </Button>
          ) : null,
          <Button key="cancel" disabled={saving} onClick={() => setEditOpen(false)}>
            取消
          </Button>,
          <Button key="save" type="primary" loading={saving} onClick={() => void saveEdit()}>
            保存
          </Button>
        ]}
      >
        <Spin spinning={editLoading}>
          <Form form={form} layout="vertical" className="video-edit-form" requiredMark={false}>
            <Form.Item
              label={
                <span className="video-edit-field-head">
                  <span>名称</span>
                  <span className="video-edit-hint">名称来自采集、参与合并去重，不可修改</span>
                </span>
              }
            >
              <Input value={editTarget?.name ?? ''} disabled />
            </Form.Item>
            <div className="video-edit-row">
              <Form.Item name="note" label="备注">
                <Input placeholder="例如：更新至第 12 期" maxLength={200} />
              </Form.Item>
              <Form.Item name="vodClass" label="类型">
                <Input placeholder="例如：真人秀,大陆综艺" maxLength={200} />
              </Form.Item>
            </div>
            <Form.Item name="vodActor" label="主演">
              <Input placeholder="多个用逗号分隔" maxLength={500} />
            </Form.Item>
            <Form.Item name="intro" label="简介">
              <Input.TextArea rows={3} maxLength={4000} showCount />
            </Form.Item>

            <div className="video-edit-field">
              <div className="video-edit-field-head">
                <span className="video-edit-label">封面</span>
                {coverOptions.length <= 1 && (
                  <span className="video-edit-hint">
                    这个视频只有主来源的预览图，接入更多站点后可以在这里换图
                  </span>
                )}
              </div>
              <div className="video-cover-picker">
                <button
                  type="button"
                  className={`video-cover-option${draftPic ? '' : ' is-active'}`}
                  onClick={() => setDraftPic('')}
                >
                  {primaryPic ? (
                    <img src={primaryPic} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="video-cover-empty">默认</span>
                  )}
                  <span className="video-cover-site">主来源</span>
                </button>
                {coverOptions.map((option) => (
                  <button
                    type="button"
                    key={option.pic}
                    className={`video-cover-option${draftPic === option.pic ? ' is-active' : ''}`}
                    onClick={() => setDraftPic(option.pic)}
                  >
                    <img src={option.pic} alt="" referrerPolicy="no-referrer" />
                    <span className="video-cover-site">{option.siteName}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="video-edit-switch">
              <Switch checked={draftHidden} onChange={setDraftHidden} />
              <div>
                <span className="video-edit-label">在展示端隐藏</span>
                <span className="video-edit-hint">
                  默认全部显示；隐藏后仍保留在这里，随时可以恢复
                </span>
              </div>
            </div>
          </Form>
        </Spin>
      </Modal>

      <Drawer
        title="视频详情"
        open={detailOpen}
        width={560}
        destroyOnHidden
        styles={{ body: { padding: '16px 18px' } }}
        onClose={() => setDetailOpen(false)}
      >
        {detailLoading || !detail ? (
          <div className="sites-placeholder">
            <Spin size="small" />
            <span className="sites-empty-hint">正在读取详情，没缓存时会顺手抓一次…</span>
          </div>
        ) : (
          <div className="video-detail">
            <div className="video-detail-head">
              <div className="video-detail-cover">
                <span className="video-detail-letter">{detail.name.trim().slice(0, 1)}</span>
                {detail.pic && (
                  <img
                    src={detail.pic}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                )}
              </div>
              <div className="video-detail-info">
                <h3 className="video-detail-name">{detail.name}</h3>
                <div className="video-detail-meta">
                  {detail.note && <span>{detail.note}</span>}
                  {detail.vodClass && <span>{detail.vodClass}</span>}
                  <span>{detail.sourceCount} 个来源</span>
                  <span>更新 {detail.latestTime}</span>
                  {detail.hidden && <Tag color="default">已隐藏</Tag>}
                </div>
                {detail.vodActor && (
                  <div className="video-detail-meta">
                    <span>主演：{detail.vodActor}</span>
                  </div>
                )}
              </div>
            </div>

            <section className="video-detail-section">
              <span className="video-detail-label">简介</span>
              <p className="video-detail-text">
                {detail.introExcerpt || '暂无简介'}
                {detail.introTruncated ? '…' : ''}
              </p>
            </section>

            <section className="video-detail-section">
              <span className="video-detail-label">来源与播放线路</span>
              {detail.sources.map((source) => (
                <div className="video-source" key={source.id}>
                  <div className="video-source-head">
                    <span className="video-source-name">{source.siteName}</span>
                    {detailTag(source)}
                    <span className="video-source-meta">
                      {source.categoryName || '未分类'}
                      {source.detailCachedAt
                        ? ` · 缓存于 ${formatDateTime(source.detailCachedAt)}`
                        : ''}
                    </span>
                  </div>
                  {source.detail ? (
                    source.detail.playLines.length === 0 ? (
                      <span className="video-source-hint">详情里没有播放地址</span>
                    ) : (
                      source.detail.playLines.map((line) => (
                        <div className="video-line" key={`${source.id}-${line.flag}`}>
                          <span className="video-line-flag" title={line.flag || '默认线路'}>
                            {line.flag || '默认线路'}
                          </span>
                          <div className="video-episodes">
                            {line.episodes.slice(0, EPISODE_LIMIT).map((episode, index) => (
                              <span
                                className="video-episode"
                                key={`${source.id}-${line.flag}-${index}`}
                                title={episode.url}
                              >
                                {episode.name}
                              </span>
                            ))}
                            {line.episodes.length > EPISODE_LIMIT && (
                              <span className="video-episode is-more">
                                还有 {line.episodes.length - EPISODE_LIMIT} 集
                              </span>
                            )}
                          </div>
                        </div>
                      ))
                    )
                  ) : (
                    <span className="video-source-hint">
                      {source.detailError
                        ? `详情抓取失败：${source.detailError}`
                        : '详情未缓存，重新打开会再抓一次'}
                    </span>
                  )}
                </div>
              ))}
            </section>
          </div>
        )}
      </Drawer>
    </>
  )
}

export default VideosPanel
