import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  TimePicker,
  Tooltip
} from 'antd'
import {
  ClockCircleOutlined,
  CloudDownloadOutlined,
  GlobalOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { formatDateTime } from '../utils/format'
import {
  COLLECT_ERRORS,
  COLLECT_STATUS_COLOR,
  COLLECT_STATUS_TEXT,
  MANUAL_CACHE_DETAIL_KEY,
  collectProgressKey,
  formatScheduleTiming,
  isResumableStatus,
  manualCacheDetail,
  siteLabel
} from '../utils/collect'

const MODE_OPTIONS = [
  { value: 'incremental', label: '增量（只补最近更新）' },
  { value: 'full', label: '全量（翻完并替换旧数据）' }
]

const RANGE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: '24h', label: '最近 24 小时' },
  { value: '48h', label: '最近 48 小时' }
]

/** 检索方式：只有开启了「支持在线检索」的站点才有，按片名（wd）检索入库 */
const SEARCH_OPTION = { value: 'search', label: '检索（按片名在线检索）' }

/** 站点没开「在线检索」时也把这一项列出来，但不可选：否则会以为这个功能没做 */
const SEARCH_OPTION_LOCKED = {
  value: 'search',
  label: '检索（需先在「站点」里开启在线检索）',
  disabled: true
}

const INTERVAL_OPTIONS = [
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' },
  { value: 180, label: '3 小时' },
  { value: 360, label: '6 小时' },
  { value: 720, label: '12 小时' },
  { value: 1440, label: '24 小时' }
]

interface ManualValues {
  mode: ScheduleMode
  /** 采集方式；'search' 表示按片名检索 */
  fetchRange: FetchRange | 'search'
  keyword?: string
  allowEmpty: boolean
  cacheDetail: boolean
}

interface ScheduleValues {
  enabled: boolean
  timing: ScheduleTiming
  intervalMinutes: number
  dailyTime: Dayjs
  mode: ScheduleMode
  fetchRange: FetchRange
  cacheDetail: boolean
}

/** 控制台「采集」：按站点发起手动采集、设置定时计划 */
function CollectPanel({
  title,
  desc,
  onOpenProgress
}: {
  title: string
  desc: string
  onOpenProgress: () => void
}): React.JSX.Element {
  const { message } = App.useApp()
  const [sites, setSites] = useState<Site[]>([])
  const [progressRows, setProgressRows] = useState<VideoCollectProgress[]>([])
  const [schedules, setSchedules] = useState<Map<string, VideoSchedule>>(new Map())
  const [loading, setLoading] = useState(true)
  const [manualTarget, setManualTarget] = useState<Site | null>(null)
  const [scheduleTarget, setScheduleTarget] = useState<Site | null>(null)
  const [saving, setSaving] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  // 弹窗里选中「重新采集」的进度 id；默认（null / 不匹配）是继续采集
  const [restartChoice, setRestartChoice] = useState<string | null>(null)
  const [manualForm] = Form.useForm<ManualValues>()
  const [scheduleForm] = Form.useForm<ScheduleValues>()
  const manualMode = Form.useWatch('mode', manualForm) ?? 'incremental'
  const manualFetchRange = Form.useWatch('fetchRange', manualForm) ?? '24h'
  const scheduleMode = Form.useWatch('mode', scheduleForm) ?? 'incremental'
  const scheduleTiming = Form.useWatch('timing', scheduleForm) ?? 'interval'
  /** 采集方式选了「检索」：按片名检索入库，模式不再参与 */
  const manualSearch = manualFetchRange === 'search'
  /** 检索项：站点开了「在线检索」才可选，否则列一条禁用的说明项 */
  const searchOption = manualTarget?.onlineSearch ? SEARCH_OPTION : SEARCH_OPTION_LOCKED

  const load = useCallback(async (): Promise<void> => {
    try {
      const [siteRows, scheduleResult, rows] = await Promise.all([
        window.api.sites.list(),
        window.api.videos.schedules(),
        window.api.videos.progress()
      ])
      setSites(siteRows)
      setSchedules(
        new Map((scheduleResult.schedules ?? []).map((schedule) => [schedule.siteId, schedule]))
      )
      setProgressRows(rows)
    } catch {
      message.error('读取采集状态失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    // load 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    return window.api.videos.onProgress((next) => {
      setProgressRows((previous) => {
        const index = previous.findIndex((row) => row.id === next.id)
        if (index === -1) return [next, ...previous]
        if (previous[index].updatedAt > next.updatedAt) return previous
        const updated = [...previous]
        updated[index] = next
        return updated
      })
    })
  }, [load])

  /** 每个站点最新的一条进度：卡片状态与取消按钮用 */
  const latestBySite = useMemo(() => {
    const map = new Map<string, VideoCollectProgress>()
    for (const row of progressRows) {
      const previous = map.get(row.siteId)
      if (!previous || previous.updatedAt < row.updatedAt) map.set(row.siteId, row)
    }
    return map
  }, [progressRows])

  /** 弹窗里选中模式 + 采集方式对应的那条进度，用来判断是否已有暂停 / 出错的任务 */
  const manualResumeRow = useMemo(() => {
    if (!manualTarget) return null
    // 检索只有一条进度（`site:search:all`），关键词累积在它上面
    const key = manualSearch
      ? collectProgressKey(manualTarget.id, 'search', 'all')
      : collectProgressKey(
          manualTarget.id,
          manualMode,
          manualMode === 'full' ? 'all' : (manualFetchRange as FetchRange)
        )
    const row = progressRows.find((item) => item.id === key)
    return row && isResumableStatus(row.status) ? row : null
  }, [manualTarget, manualMode, manualFetchRange, manualSearch, progressRows])

  const resumeFromStart = Boolean(manualResumeRow && restartChoice === manualResumeRow.id)

  useEffect(() => {
    if (!manualTarget) return
    manualForm.setFieldsValue({
      mode: 'incremental',
      fetchRange: '24h',
      allowEmpty: false,
      // 记住上一次手动采集时是否勾了「同时生成详情缓存」，没记录过就默认勾选
      cacheDetail: manualCacheDetail()
    })
  }, [manualTarget, manualForm])

  useEffect(() => {
    if (!scheduleTarget) return
    const existing = schedules.get(scheduleTarget.id)
    const dailyTime = existing?.dailyTime || '08:00'
    const [hour, minute] = dailyTime.split(':').map(Number)
    scheduleForm.setFieldsValue({
      enabled: existing?.enabled ?? false,
      timing: existing?.timing ?? 'interval',
      intervalMinutes: existing?.intervalMinutes ?? 360,
      dailyTime: dayjs().hour(hour).minute(minute).second(0),
      mode: existing?.mode ?? 'incremental',
      fetchRange: existing?.fetchRange ?? '24h',
      cacheDetail: existing?.cacheDetail ?? true
    })
  }, [scheduleTarget, schedules, scheduleForm])

  const startCollect = async (): Promise<void> => {
    if (!manualTarget) return
    let values: ManualValues
    try {
      values = await manualForm.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      const isSearch = values.fetchRange === 'search'
      const keyword = (values.keyword ?? '').trim()
      const result = await window.api.videos.collect({
        siteId: manualTarget.id,
        mode: isSearch ? 'search' : values.mode,
        fetchRange: isSearch || values.mode === 'full' ? 'all' : (values.fetchRange as FetchRange),
        // 只有已经存在暂停 / 出错的任务时才有意义：不传则按库里的状态自动续采或重来
        restart: manualResumeRow ? resumeFromStart : undefined,
        allowEmpty: isSearch ? false : values.allowEmpty,
        cacheDetail: values.cacheDetail,
        words: isSearch ? [keyword] : undefined
      })
      if (!result.ok) {
        message.warning(COLLECT_ERRORS[result.error ?? ''] ?? '发起采集失败，请重试')
        return
      }
      setManualTarget(null)
      setRestartChoice(null)
      await load()
      // 站点忽略 pagesize=100 时按探测到的真实页大小采集，提示里说清楚
      const sizeNote =
        result.pageSize && result.pageSize < 100 ? `（每页 ${result.pageSize} 条）` : ''
      if (isSearch) {
        message.success(`已加入检索队列「${keyword}」${sizeNote}，可在「进度」查看`)
      } else if (manualResumeRow && !resumeFromStart) {
        message.success(`已继续采集，从第 ${manualResumeRow.page + 1} 页开始${sizeNote}`)
      } else if (manualResumeRow) {
        message.success(`已重新加入队列，从第 1 页开始${sizeNote}`)
      } else {
        message.success(`已加入采集队列${sizeNote}，可在「进度」查看`)
      }
    } catch {
      message.error('发起采集失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const saveSchedule = async (): Promise<void> => {
    if (!scheduleTarget) return
    let values: ScheduleValues
    try {
      values = await scheduleForm.validateFields()
    } catch {
      return
    }
    setSaving(true)
    try {
      const timing: ScheduleTiming = values.timing === 'daily' ? 'daily' : 'interval'
      // 「每天固定时间」会把间隔输入框卸载，validateFields 只回传当时挂载的字段，
      // 所以间隔要从表单 store 里补读，切回「按时间间隔」时还是用户填过的值
      const intervalMinutes = Number(
        values.intervalMinutes ?? scheduleForm.getFieldValue('intervalMinutes')
      )
      const result = await window.api.videos.saveSchedule({
        siteId: scheduleTarget.id,
        enabled: values.enabled,
        timing,
        intervalMinutes: intervalMinutes > 0 ? intervalMinutes : 0,
        dailyTime: timing === 'daily' && values.dailyTime ? values.dailyTime.format('HH:mm') : '',
        mode: values.mode,
        fetchRange: values.mode === 'full' ? 'all' : values.fetchRange,
        cacheDetail: values.cacheDetail
      })
      if (!result.ok) {
        message.error(
          result.error === 'NOT_FOUND'
            ? '站点不存在，可能已被删除'
            : result.error === 'INVALID_INPUT'
              ? '定时设置校验未通过，请检查间隔与执行时间'
              : '保存定时设置失败，缓存库可能正在重建'
        )
        return
      }
      setScheduleTarget(null)
      await load()
      const pageSize = result.schedule?.pageSize ?? 0
      // 探测到的真实页大小会跟着计划存下来，每次定时触发都按它翻页
      message.success(
        values.enabled
          ? `定时采集已启用${pageSize > 0 && pageSize < 100 ? `（每页 ${pageSize} 条）` : ''}`
          : '定时采集已关闭'
      )
    } catch {
      message.error('保存定时设置失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const removeSchedule = async (): Promise<void> => {
    if (!scheduleTarget) return
    setSaving(true)
    try {
      const result = await window.api.videos.removeSchedule(scheduleTarget.id)
      if (!result.ok) {
        message.error('删除定时计划失败，请重试')
        return
      }
      setScheduleTarget(null)
      await load()
      message.success('定时计划已删除')
    } catch {
      message.error('删除定时计划失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const cancelCollect = async (siteId: string, item: VideoCollectProgress): Promise<void> => {
    setCancelling(true)
    try {
      const result = await window.api.videos.cancelCollect({
        siteId,
        mode: item.mode,
        fetchRange: item.fetchRange
      })
      if (!result.ok) {
        message.error('取消失败，请重试')
        return
      }
      await load()
      message.success('已取消')
    } catch {
      message.error('取消失败，请重试')
    } finally {
      setCancelling(false)
    }
  }

  const sortedSites = useMemo(
    () =>
      [...sites].sort((left, right) => siteLabel(left).localeCompare(siteLabel(right), 'zh-CN')),
    [sites]
  )

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
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          <Button icon={<ClockCircleOutlined />} onClick={onOpenProgress}>
            查看进度
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在读取采集状态…</span>
        </div>
      ) : sortedSites.length === 0 ? (
        <div className="sites-placeholder">
          <span className="sites-empty-title">还没有采集站点</span>
          <span className="sites-empty-hint">先到「站点」录入采集站，再回来发起采集</span>
        </div>
      ) : (
        <div className="sites-grid">
          {sortedSites.map((site) => {
            const current = latestBySite.get(site.id)
            const schedule = schedules.get(site.id)
            const status = current?.status ?? 'idle'
            const busy = status === 'running' || status === 'queued' || status === 'replacing'
            return (
              <article className="site-card collect-card" key={site.id}>
                <div className="site-card-head">
                  <div className="site-card-title">
                    <span className="site-card-name">{siteLabel(site)}</span>
                    {site.onlineSearch && (
                      <Tooltip title="支持在线检索：采集时可选用「检索」方式">
                        <span className="site-card-online" aria-label="支持在线检索">
                          <GlobalOutlined />
                        </span>
                      </Tooltip>
                    )}
                  </div>
                  <Tag color={COLLECT_STATUS_COLOR[status]}>{COLLECT_STATUS_TEXT[status]}</Tag>
                </div>

                <span className="site-card-address" title={site.address}>
                  {site.address}
                </span>
                <div className="collect-meta">
                  <span>
                    采集：
                    {current?.finishedAt
                      ? formatDateTime(current.finishedAt, true)
                      : current?.updatedAt
                        ? formatDateTime(current.updatedAt, true)
                        : '从未'}
                  </span>
                  <span>
                    计划：
                    {!schedule
                      ? '—'
                      : schedule.enabled && schedule.nextRunAt
                        ? formatDateTime(schedule.nextRunAt, true)
                        : '未启用'}
                  </span>
                  {/* 定时一行常驻，跟「计划」一样：没配计划时就是一条横线 */}
                  <span>
                    定时：
                    {schedule ? formatScheduleTiming(schedule) : '—'}
                    {schedule && schedule.pageSize > 0 ? ` · 每页 ${schedule.pageSize} 条` : ''}
                    {schedule?.cacheDetail ? ' · 含详情缓存' : ''}
                  </span>
                </div>

                <div className="collect-actions">
                  <Button
                    type="primary"
                    size="small"
                    icon={<CloudDownloadOutlined />}
                    onClick={() => setManualTarget(site)}
                  >
                    采集
                  </Button>
                  <Button
                    size="small"
                    icon={<ClockCircleOutlined />}
                    onClick={() => setScheduleTarget(site)}
                  >
                    定时
                  </Button>
                  {/* 取消只在采集中 / 排队时出现，避免误点 */}
                  {busy && (
                    <Tooltip title="取消当前采集 / 排队">
                      <Button
                        size="small"
                        danger
                        icon={<StopOutlined />}
                        loading={cancelling}
                        onClick={() => current && void cancelCollect(site.id, current)}
                      >
                        取消
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <Modal
        title={manualTarget ? `采集「${siteLabel(manualTarget)}」` : '立即采集'}
        open={Boolean(manualTarget)}
        okText="开始采集"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void startCollect()}
        onCancel={() => {
          setManualTarget(null)
          setRestartChoice(null)
        }}
        width={460}
      >
        <Form form={manualForm} layout="vertical" requiredMark={false} className="collect-form">
          <Form.Item name="mode" label="模式" rules={[{ required: true }]}>
            <Select options={MODE_OPTIONS} disabled={manualSearch} />
          </Form.Item>
          <Form.Item name="fetchRange" label="采集方式" rules={[{ required: true }]}>
            <Select
              options={
                manualMode === 'full'
                  ? [RANGE_OPTIONS[0], searchOption]
                  : [...RANGE_OPTIONS, searchOption]
              }
              disabled={manualMode === 'full' && !manualTarget?.onlineSearch}
            />
          </Form.Item>
          {manualSearch && (
            <Form.Item
              name="keyword"
              label="视频名字"
              rules={[{ required: true, whitespace: true, message: '请填写要检索的视频名字' }]}
              extra="用采集接口的 wd 参数按片名检索：命中的视频直接入库，同一个站点只保留一条检索进度，多个关键词会累积在这条记录上（重复关键词会重置并重采）。"
            >
              <Input maxLength={60} placeholder="如：名侦探柯南" allowClear />
            </Form.Item>
          )}
          {manualResumeRow && (
            <Form.Item
              label={`上次采集${manualResumeRow.status === 'error' ? '出错' : '已暂停'}`}
              extra={
                manualSearch
                  ? '继续会接着检索还没采完的关键词；重新会把所有关键词重置为待检索，从第一个词重新采。'
                  : '继续会接着上次中断 / 失败的页码抓，保留已入库的数据；重新会清空这条进度与计数，从第 1 页开始。'
              }
            >
              <Radio.Group
                value={resumeFromStart ? 'restart' : 'resume'}
                onChange={(event) =>
                  setRestartChoice(event.target.value === 'restart' ? manualResumeRow.id : null)
                }
              >
                <Radio value="resume">
                  {manualSearch ? '继续检索' : '继续采集'}
                  {!manualSearch && manualResumeRow.page > 0
                    ? `（第 ${manualResumeRow.page + 1} 页起）`
                    : ''}
                </Radio>
                <Radio value="restart">{manualSearch ? '重新检索' : '重新采集（第 1 页起）'}</Radio>
              </Radio.Group>
            </Form.Item>
          )}
          <Form.Item
            name="cacheDetail"
            valuePropName="checked"
            extra="勾选后本次采集会顺带抓取详情（简介、演员、播放线路）并缓存到本地，多花一些时间和磁盘；不勾选则打开视频时再按需生成。"
          >
            <Checkbox
              onChange={(event) =>
                localStorage.setItem(MANUAL_CACHE_DETAIL_KEY, event.target.checked ? '1' : '0')
              }
            >
              同时生成详情缓存
            </Checkbox>
          </Form.Item>
          {manualMode === 'full' && !manualSearch && (
            <Form.Item
              name="allowEmpty"
              valuePropName="checked"
              extra="只有站点确实没有任何视频、且你确认要清空该站缓存时才勾选；默认不会因为临时返回空而删除旧数据。"
            >
              <Checkbox>允许空站点执行全量替换</Checkbox>
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title={scheduleTarget ? `定时采集「${siteLabel(scheduleTarget)}」` : '定时采集'}
        open={Boolean(scheduleTarget)}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => void saveSchedule()}
        onCancel={() => setScheduleTarget(null)}
        width={640}
        footer={
          <Space>
            {scheduleTarget && schedules.has(scheduleTarget.id) && (
              <Button danger loading={saving} onClick={() => void removeSchedule()}>
                删除计划
              </Button>
            )}
            <Button onClick={() => setScheduleTarget(null)}>取消</Button>
            <Button type="primary" loading={saving} onClick={() => void saveSchedule()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form
          form={scheduleForm}
          layout="vertical"
          requiredMark={false}
          className="collect-form schedule-form"
        >
          <Form.Item name="enabled" valuePropName="checked">
            <Checkbox>启用定时采集，按下面的计划自动入队</Checkbox>
          </Form.Item>
          <Form.Item name="timing" label="定时方式" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio.Button value="interval">按时间间隔</Radio.Button>
              <Radio.Button value="daily">每天固定时间</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {scheduleTiming === 'daily' ? (
            <Form.Item
              name="dailyTime"
              label="每天执行时间"
              rules={[{ required: true, message: '请选择时间点' }]}
              extra="到点自动入队；那会儿应用没开着，会在下次启动时补跑一次。"
            >
              <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
            </Form.Item>
          ) : (
            <Form.Item
              name="intervalMinutes"
              label="间隔"
              rules={[
                { required: true, message: '请填写间隔分钟数' },
                { type: 'number', min: 5, max: 10080, message: '间隔需在 5 分钟到 7 天之间' }
              ]}
            >
              <InputNumber
                min={5}
                max={10080}
                step={30}
                style={{ width: '100%' }}
                addonAfter="分钟"
              />
            </Form.Item>
          )}
          {scheduleTiming !== 'daily' && (
            <div className="collect-interval-presets">
              {INTERVAL_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  size="small"
                  onClick={() => scheduleForm.setFieldValue('intervalMinutes', option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )}
          <div className="schedule-form-row">
            <Form.Item name="mode" label="模式" rules={[{ required: true }]}>
              <Select options={MODE_OPTIONS} />
            </Form.Item>
            <Form.Item name="fetchRange" label="采集方式" rules={[{ required: true }]}>
              <Select
                options={scheduleMode === 'full' ? RANGE_OPTIONS.slice(0, 1) : RANGE_OPTIONS}
                disabled={scheduleMode === 'full'}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="cacheDetail"
            valuePropName="checked"
            extra="勾选后每次定时采集都会顺带生成详情缓存，会明显增加单次耗时与磁盘占用。"
          >
            <Checkbox>采集时同时生成详情缓存</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export default CollectPanel
