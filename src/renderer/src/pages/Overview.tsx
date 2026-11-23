import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Spin, Tag, Tooltip } from 'antd'
import {
  ClockCircleOutlined,
  CloudDownloadOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  GlobalOutlined,
  ReloadOutlined,
  RightOutlined,
  VideoCameraOutlined
} from '@ant-design/icons'
import { formatBytes, formatShortDateTime, formatUpcoming } from '../utils/format'
import {
  COLLECT_STATUS_COLOR,
  COLLECT_STATUS_TEXT,
  collectModeText,
  compareCollectProgress,
  formatScheduleTiming,
  siteLabel
} from '../utils/collect'
import type { ConsoleSection } from '../types'

/** 概览一次拉齐的数据：都来自现有接口，不额外增加主进程通道 */
interface OverviewData {
  sites: Site[]
  categories: VideoCategory[]
  bindingCount: number
  hiddenCount: number
  /** 视频数 / 来源数 / 最后采集时间也在这个包里，不用再单独要一次 stats */
  capacity: VideoCapacity
  schedules: VideoSchedule[]
  progress: VideoCollectProgress[]
  /** 最近 24 小时的采集日志（最多 100 条），用于挑出异常 */
  logs: VideoCollectLog[]
}

const ONBOARD_STEPS: { title: string; desc: string; target: ConsoleSection; action: string }[] = [
  { title: '添加站点', desc: '录入采集站名称与接口地址', target: 'sites', action: '去添加' },
  { title: '绑定分类', desc: '把采集站分类映射到本地分类', target: 'categories', action: '去绑定' },
  {
    title: '发起采集',
    desc: '立即执行一次，或设置每天 / 按间隔定时',
    target: 'collect',
    action: '去采集'
  }
]

/** 只取时分秒，用于页头「数据更新于」 */
function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 采集进度百分比：已完成一律 100%，其余按页数推算 */
function progressPercent(item: VideoCollectProgress): number {
  if (item.status === 'done') return 100
  // 检索进度按「已处理的关键词 / 全部关键词」算
  if (item.mode === 'search' && item.words && item.words.length > 0) {
    const processed = item.words.filter(
      (word) => word.status === 'done' || word.status === 'error'
    ).length
    return Math.min(100, Math.round((processed / item.words.length) * 100))
  }
  if (item.pageCount <= 0) return 0
  return Math.min(100, Math.round((item.page / item.pageCount) * 100))
}

/** 控制台「概览」：先给结论（视频量 / 站点 / 计划 / 占用），再给最近采集与异常 */
function OverviewPanel({
  title,
  desc,
  onNavigate
}: {
  title: string
  desc: string
  onNavigate: (section: ConsoleSection) => void
}): React.JSX.Element {
  const { message } = App.useApp()
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState('')

  const load = useCallback(
    async (options?: { silent?: boolean }): Promise<void> => {
      if (!options?.silent) setLoading(true)
      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const [sites, categories, counts, hidden, capacity, schedules, progress, logs] =
          await Promise.all([
            window.api.sites.list(),
            window.api.categories.list(),
            window.api.bindings.counts(),
            // 只关心「隐藏了多少」：只要数字，不取行（取一页拿 total 会扫整张表）
            window.api.videos.count({ visibility: 'hidden' }),
            // 概览只看总量，按站点分组的统计（十几万条来源）在这里用不到
            window.api.videos.capacity({ sites: false }),
            window.api.videos.schedules(),
            window.api.videos.progress(),
            window.api.videos.logs({ since, order: 'newest', limit: 100 })
          ])
        setData({
          sites,
          categories,
          bindingCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
          hiddenCount: hidden.ok ? hidden.total : 0,
          capacity,
          schedules: schedules.schedules ?? [],
          progress,
          logs: logs.logs ?? []
        })
        setRefreshedAt(new Date().toISOString())
      } catch {
        message.error('读取概览数据失败')
      } finally {
        setLoading(false)
      }
    },
    [message]
  )

  useEffect(() => {
    // load 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  useEffect(() => {
    return window.api.videos.onProgress((next) => {
      setData((previous) => {
        if (!previous) return previous
        const exists = previous.progress.some((item) => item.id === next.id)
        return {
          ...previous,
          progress: exists
            ? previous.progress.map((item) => (item.id === next.id ? next : item))
            : [next, ...previous.progress]
        }
      })
      // 一次采集结束后视频数、占用都变了，静默补一次统计
      if (next.status === 'done' || next.status === 'error') void load({ silent: true })
    })
  }, [load])

  const siteMap = useMemo(() => new Map((data?.sites ?? []).map((site) => [site.id, site])), [data])

  const recent = useMemo(() => {
    return [...(data?.progress ?? [])].sort(compareCollectProgress).slice(0, 4)
  }, [data])

  const activeCount = useMemo(
    () =>
      (data?.progress ?? []).filter(
        (item) =>
          item.status === 'running' || item.status === 'replacing' || item.status === 'queued'
      ).length,
    [data]
  )

  const upcoming = useMemo(
    () =>
      (data?.schedules ?? [])
        .filter((schedule) => schedule.enabled && schedule.nextRunAt)
        .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt)),
    [data]
  )

  const issues = useMemo(() => (data?.logs ?? []).filter((log) => log.level !== 'info'), [data])
  const errorCount = issues.filter((log) => log.level === 'error').length

  const sites = data?.sites ?? []
  const videoCount = data?.capacity.videoCount ?? 0
  const sourceCount = data?.capacity.sourceCount ?? 0
  const lastCollectedAt = data?.capacity.lastCollectedAt ?? ''
  const totalBytes = (data?.capacity.dbBytes ?? 0) + (data?.capacity.detailBytes ?? 0)
  const nextSchedule = upcoming[0]

  const refreshedHint = refreshedAt ? `数据更新于 ${clockTime(refreshedAt)}` : ''

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          {refreshedHint && <span className="sites-count">{refreshedHint}</span>}
        </p>
        <div className="settings-panel-actions">
          <Button icon={<CloudDownloadOutlined />} onClick={() => onNavigate('collect')}>
            发起采集
          </Button>
          <Tooltip title="重新读取站点、视频与缓存统计">
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
          </Tooltip>
        </div>
      </div>

      {loading && !data ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在汇总运行状态…</span>
        </div>
      ) : !data ? (
        <div className="sites-placeholder">
          <span className="sites-empty-title">暂时读不到概览数据</span>
          <span className="sites-empty-hint">点右上角「刷新」再试一次</span>
        </div>
      ) : sites.length === 0 ? (
        <section className="overview-onboard">
          <div className="overview-onboard-head">
            <h3 className="overview-onboard-title">还没有接入采集站点</h3>
            <p className="overview-onboard-desc">
              按顺序完成三步，视频总量、采集进度和定时计划就会汇总到这里。
            </p>
          </div>
          <ol className="overview-steps">
            {ONBOARD_STEPS.map((step, index) => (
              <li className="overview-step" key={step.target}>
                <span className="overview-step-index">{index + 1}</span>
                <div className="overview-step-body">
                  <span className="overview-step-title">{step.title}</span>
                  <span className="overview-step-desc">{step.desc}</span>
                </div>
                <Button size="small" onClick={() => onNavigate(step.target)}>
                  {step.action}
                </Button>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <>
          <div className="overview-grid">
            <button type="button" className="overview-card" onClick={() => onNavigate('videos')}>
              <span className="overview-card-head">
                <VideoCameraOutlined />
                视频库
                <RightOutlined className="overview-card-go" />
              </span>
              <strong className="overview-value">
                {videoCount.toLocaleString('zh-CN')}
                <small>部</small>
              </strong>
              <span className="overview-hint">
                {videoCount === 0
                  ? '还没有采集到视频'
                  : `${sourceCount.toLocaleString('zh-CN')} 个来源${
                      data.hiddenCount > 0 ? ` · 隐藏 ${data.hiddenCount}` : ''
                    }`}
              </span>
            </button>

            <button type="button" className="overview-card" onClick={() => onNavigate('sites')}>
              <span className="overview-card-head">
                <GlobalOutlined />
                站点与分类
                <RightOutlined className="overview-card-go" />
              </span>
              <strong className="overview-value">
                {sites.length}
                <small>个站点</small>
              </strong>
              <span className="overview-hint">
                {data.categories.length} 个本地分类 · {data.bindingCount} 条绑定
              </span>
            </button>

            <button type="button" className="overview-card" onClick={() => onNavigate('collect')}>
              <span className="overview-card-head">
                <ClockCircleOutlined />
                定时采集
                <RightOutlined className="overview-card-go" />
              </span>
              <strong className="overview-value">
                {upcoming.length}
                <small>个启用</small>
              </strong>
              <span className="overview-hint">
                {nextSchedule
                  ? `下次 ${formatUpcoming(nextSchedule.nextRunAt)}`
                  : data.schedules.length === 0
                    ? '还没有定时计划'
                    : `共 ${data.schedules.length} 个计划 · 均未启用`}
              </span>
            </button>

            <button type="button" className="overview-card" onClick={() => onNavigate('capacity')}>
              <span className="overview-card-head">
                <DatabaseOutlined />
                缓存占用
                <RightOutlined className="overview-card-go" />
              </span>
              <strong className="overview-value">{formatBytes(totalBytes)}</strong>
              <span className="overview-hint">
                {data.capacity.detailCount} 个详情 ·{' '}
                {lastCollectedAt
                  ? `上次采集 ${formatShortDateTime(lastCollectedAt)}`
                  : '还未采集过'}
              </span>
            </button>
          </div>

          <div className="overview-columns">
            <section className="overview-block">
              <header className="overview-block-head">
                <span className="overview-block-title">最近采集</span>
                <span className="overview-block-count">
                  {activeCount > 0 ? `${activeCount} 个进行中` : `共 ${data.progress.length} 条`}
                </span>
                <Button type="link" size="small" onClick={() => onNavigate('progress')}>
                  查看全部
                </Button>
              </header>
              {recent.length === 0 ? (
                <div className="overview-empty">
                  <span className="overview-empty-title">还没有采集记录</span>
                  <span className="overview-empty-hint">发起一次采集后，进度会实时显示在这里</span>
                </div>
              ) : (
                <div className="overview-rows">
                  {recent.map((item) => {
                    const percent = progressPercent(item)
                    return (
                      <article className="overview-row" key={item.id}>
                        <div className="overview-row-main">
                          <span
                            className="overview-row-name"
                            title={siteLabel(siteMap.get(item.siteId), item.siteId)}
                          >
                            {siteLabel(siteMap.get(item.siteId), item.siteId)}
                          </span>
                          <Tag color={COLLECT_STATUS_COLOR[item.status]}>
                            {COLLECT_STATUS_TEXT[item.status]}
                          </Tag>
                          <span className="overview-row-meta">
                            {collectModeText(item.mode)} ·{' '}
                            {item.mode === 'search'
                              ? item.words && item.words.length > 0
                                ? `${item.words.filter((word) => word.status === 'done').length} / ${item.words.length} 个关键词`
                                : '等待关键词'
                              : item.pageCount > 0
                                ? `第 ${item.page} / ${item.pageCount} 页 · ${percent}%`
                                : '等待开始'}
                          </span>
                          <span className="overview-row-meta overview-row-end">
                            {formatShortDateTime(item.updatedAt)}
                          </span>
                        </div>
                        <div className="overview-row-sub">
                          抓取 {item.fetched} · 新增 {item.inserted} · 更新 {item.updated} · 失败{' '}
                          {item.failed}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="overview-block">
              <header className="overview-block-head">
                <span className="overview-block-title">定时计划</span>
                <span className="overview-block-count">
                  {upcoming.length > 0 ? `${upcoming.length} 个待执行` : '暂无待执行'}
                </span>
                <Button type="link" size="small" onClick={() => onNavigate('collect')}>
                  管理
                </Button>
              </header>
              {upcoming.length === 0 ? (
                <div className="overview-empty">
                  <span className="overview-empty-title">
                    {data.schedules.length === 0 ? '还没有定时计划' : '所有定时计划都已停用'}
                  </span>
                  <span className="overview-empty-hint">
                    在「采集」里可以按每天固定时间或时间间隔自动采集
                  </span>
                </div>
              ) : (
                <div className="overview-rows">
                  {upcoming.slice(0, 4).map((schedule, index) => (
                    <article className="overview-row" key={schedule.siteId}>
                      <div className="overview-row-main">
                        <span
                          className="overview-row-name"
                          title={siteLabel(siteMap.get(schedule.siteId), schedule.siteId)}
                        >
                          {siteLabel(siteMap.get(schedule.siteId), schedule.siteId)}
                        </span>
                        <span className="overview-row-meta">
                          {formatScheduleTiming(schedule)} · {collectModeText(schedule.mode)}
                          {schedule.cacheDetail ? ' · 含详情' : ''}
                        </span>
                        <span
                          className={`overview-row-meta overview-row-end${
                            index === 0 ? ' is-next' : ''
                          }`}
                        >
                          {formatUpcoming(schedule.nextRunAt)}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          {issues.length > 0 && (
            <section className="overview-block overview-block-issues">
              <header className="overview-block-head">
                <ExclamationCircleOutlined className="overview-block-icon is-warn" />
                <span className="overview-block-title">最近 24 小时异常</span>
                <span className="overview-block-count">
                  错误 {errorCount} · 警告 {issues.length - errorCount}
                </span>
                <Button type="link" size="small" onClick={() => onNavigate('logs')}>
                  查看日志
                </Button>
              </header>
              <div className="overview-rows">
                {issues.slice(0, 3).map((log) => (
                  <article className="overview-row" key={log.id}>
                    <div className="overview-row-main">
                      <Tag color={log.level === 'error' ? 'red' : 'orange'}>
                        {log.level === 'error' ? '错误' : '警告'}
                      </Tag>
                      <span className="overview-row-name">
                        {siteLabel(siteMap.get(log.siteId), log.siteId)}
                      </span>
                      <span className="overview-row-message" title={log.message}>
                        {log.message}
                      </span>
                      <span className="overview-row-meta overview-row-end">
                        {formatShortDateTime(log.createdAt)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  )
}

export default OverviewPanel
