import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Checkbox,
  Form,
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
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { formatDateTime } from '../utils/format'
import {
  COLLECT_STATUS_COLOR,
  COLLECT_STATUS_TEXT,
  formatScheduleTiming,
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

const INTERVAL_OPTIONS = [
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' },
  { value: 180, label: '3 小时' },
  { value: 360, label: '6 小时' },
  { value: 720, label: '12 小时' },
  { value: 1440, label: '24 小时' }
]

/** 上次手动采集是否勾了「同时生成详情缓存」，没记录过就按勾选处理 */
const MANUAL_CACHE_DETAIL_KEY = 'collect-manual-cache-detail'

interface ManualValues {
  mode: CollectMode
  fetchRange: FetchRange
  allowEmpty: boolean
  cacheDetail: boolean
}

interface ScheduleValues {
  enabled: boolean
  timing: ScheduleTiming
  intervalMinutes: number
  dailyTime: Dayjs
  mode: CollectMode
  fetchRange: FetchRange
  cacheDetail: boolean
}

const COLLECT_ERRORS: Record<string, string> = {
  ALREADY_QUEUED: '同一模式与采集方式已在队列中，请稍后查看进度',
  INVALID_INPUT: '采集参数不合法',
  NOT_FOUND: '站点不存在，可能已被删除',
  CACHE_UNAVAILABLE: '缓存库不可用，请重启应用后重试',
  BUSY: '缓存正在清理，请稍后再试'
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
  const [progress, setProgress] = useState<Map<string, VideoCollectProgress>>(new Map())
  const [schedules, setSchedules] = useState<Map<string, VideoSchedule>>(new Map())
  const [loading, setLoading] = useState(true)
  const [manualTarget, setManualTarget] = useState<Site | null>(null)
  const [scheduleTarget, setScheduleTarget] = useState<Site | null>(null)
  const [saving, setSaving] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [manualForm] = Form.useForm<ManualValues>()
  const [scheduleForm] = Form.useForm<ScheduleValues>()
  const manualMode = Form.useWatch('mode', manualForm) ?? 'incremental'
  const scheduleMode = Form.useWatch('mode', scheduleForm) ?? 'incremental'
  const scheduleTiming = Form.useWatch('timing', scheduleForm) ?? 'interval'

  const load = useCallback(async (): Promise<void> => {
    try {
      const [siteRows, scheduleResult, progressRows] = await Promise.all([
        window.api.sites.list(),
        window.api.videos.schedules(),
        window.api.videos.progress()
      ])
      setSites(siteRows)
      setSchedules(
        new Map((scheduleResult.schedules ?? []).map((schedule) => [schedule.siteId, schedule]))
      )
      const map = new Map<string, VideoCollectProgress>()
      for (const item of progressRows) {
        const previous = map.get(item.siteId)
        if (!previous || previous.updatedAt < item.updatedAt) map.set(item.siteId, item)
      }
      setProgress(map)
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
      setProgress((previous) => {
        const current = previous.get(next.siteId)
        if (current && current.updatedAt > next.updatedAt) return previous
        const updated = new Map(previous)
        updated.set(next.siteId, next)
        return updated
      })
    })
  }, [load])

  useEffect(() => {
    if (!manualTarget) return
    manualForm.setFieldsValue({
      mode: 'incremental',
      fetchRange: '24h',
      allowEmpty: false,
      // 记住上一次手动采集时是否勾了「同时生成详情缓存」，没记录过就默认勾选
      cacheDetail: localStorage.getItem(MANUAL_CACHE_DETAIL_KEY) !== '0'
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
      const result = await window.api.videos.collect({
        siteId: manualTarget.id,
        mode: values.mode,
        fetchRange: values.mode === 'full' ? 'all' : values.fetchRange,
        allowEmpty: values.allowEmpty,
        cacheDetail: values.cacheDetail
      })
      if (!result.ok) {
        message.warning(COLLECT_ERRORS[result.error ?? ''] ?? '发起采集失败，请重试')
        return
      }
      setManualTarget(null)
      await load()
      message.success('已加入采集队列，可在「进度」查看')
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
      const result = await window.api.videos.saveSchedule({
        siteId: scheduleTarget.id,
        enabled: values.enabled,
        timing,
        intervalMinutes: values.intervalMinutes,
        dailyTime: timing === 'daily' && values.dailyTime ? values.dailyTime.format('HH:mm') : '',
        mode: values.mode,
        fetchRange: values.mode === 'full' ? 'all' : values.fetchRange,
        cacheDetail: values.cacheDetail
      })
      if (!result.ok) {
        message.error(
          result.error === 'NOT_FOUND' ? '站点不存在，可能已被删除' : '保存定时设置失败'
        )
        return
      }
      setScheduleTarget(null)
      await load()
      message.success(values.enabled ? '定时采集已启用' : '定时采集已关闭')
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
            const current = progress.get(site.id)
            const schedule = schedules.get(site.id)
            const status = current?.status ?? 'idle'
            const busy = status === 'running' || status === 'queued' || status === 'replacing'
            return (
              <article className="site-card collect-card" key={site.id}>
                <div className="site-card-head">
                  <div className="site-card-title">
                    <span className="site-card-name">{siteLabel(site)}</span>
                    <Tag color={site.format === 'xml' ? 'blue' : 'green'}>
                      {site.format.toUpperCase()}
                    </Tag>
                  </div>
                  <Tag color={COLLECT_STATUS_COLOR[status]}>{COLLECT_STATUS_TEXT[status]}</Tag>
                </div>

                <span className="site-card-address" title={site.address}>
                  {site.address}
                </span>
                <div className="collect-meta">
                  <span>
                    上次采集：
                    {current?.finishedAt
                      ? formatDateTime(current.finishedAt, true)
                      : current?.updatedAt
                        ? formatDateTime(current.updatedAt, true)
                        : '从未'}
                  </span>
                  <span>
                    下次计划：
                    {schedule?.enabled && schedule.nextRunAt
                      ? formatDateTime(schedule.nextRunAt, true)
                      : '未启用'}
                  </span>
                  {schedule && (
                    <span>
                      定时：{formatScheduleTiming(schedule)}
                      {schedule.cacheDetail ? ' · 含详情缓存' : ''}
                    </span>
                  )}
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
                  <Button
                    type="link"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    onClick={onOpenProgress}
                  >
                    进度
                  </Button>
                  {/* 取消按钮排在「进度」右边，采集中才出现，避免误点 */}
                  {busy && (
                    <Tooltip title="取消当前采集 / 排队">
                      <Button
                        size="small"
                        danger
                        icon={<StopOutlined />}
                        loading={cancelling}
                        aria-label="取消当前采集 / 排队"
                        onClick={() => current && void cancelCollect(site.id, current)}
                      />
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
        onCancel={() => setManualTarget(null)}
        width={460}
      >
        <Form form={manualForm} layout="vertical" requiredMark={false}>
          <Form.Item name="mode" label="模式" rules={[{ required: true }]}>
            <Select options={MODE_OPTIONS} />
          </Form.Item>
          <Form.Item name="fetchRange" label="采集方式" rules={[{ required: true }]}>
            <Select
              options={manualMode === 'full' ? RANGE_OPTIONS.slice(0, 1) : RANGE_OPTIONS}
              disabled={manualMode === 'full'}
            />
          </Form.Item>
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
          {manualMode === 'full' && (
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
        <Form form={scheduleForm} layout="vertical" requiredMark={false} className="schedule-form">
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
