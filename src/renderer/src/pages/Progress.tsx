import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Popconfirm, Select, Spin, Tag, Tooltip } from 'antd'
import {
  CloudDownloadOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons'
import { formatCount, formatDateTime } from '../utils/format'
import {
  COLLECT_ERRORS,
  COLLECT_STATUS_COLOR,
  COLLECT_STATUS_TEXT,
  compareCollectProgress,
  isResumableStatus,
  manualCacheDetail,
  siteLabel
} from '../utils/collect'

function modeText(mode: CollectMode): string {
  return mode === 'full' ? '全量' : '增量'
}

function progressText(item: VideoCollectProgress): string {
  if (item.pageCount > 0) return `第 ${item.page} / ${item.pageCount} 页`
  if (item.page > 0) return `第 ${item.page} 页`
  // 增量没有新数据也是正常结束（0 页），别再显示成「等待开始」
  if (item.status === 'done') {
    return item.mode === 'incremental' && item.fetched === 0 ? '最近没有新数据' : '0 页'
  }
  return '等待开始'
}

/** 「进度」页可调的并发档位：1–4 路，和主进程的 clamp 范围保持一致 */
const CONCURRENCY_OPTIONS = [1, 2, 3, 4].map((value) => ({ value, label: `${value} 路` }))

/** 控制台「进度」：按站点展示当前 / 最后一次采集，订阅事件实时更新 */
function ProgressPanel({
  title,
  desc,
  onOpenCollect,
  onOpenLogs
}: {
  title: string
  desc: string
  onOpenCollect: () => void
  onOpenLogs: (siteId: string) => void
}): React.JSX.Element {
  const { message } = App.useApp()
  const [sites, setSites] = useState<Site[]>([])
  const [rows, setRows] = useState<VideoCollectProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)
  // 暂停 / 出错的记录可以直接续采或重采；用 `${id}:${动作}` 标记按钮加载态
  const [acting, setActing] = useState<string | null>(null)
  /** 同时采集的站点数：默认 2，改动立即生效；主进程返回值是唯一权威 */
  const [concurrency, setConcurrency] = useState(2)
  const [savingConcurrency, setSavingConcurrency] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [siteRows, progressRows, settings] = await Promise.all([
        window.api.sites.list(),
        window.api.videos.progress(),
        window.api.settings.get()
      ])
      setSites(siteRows)
      setRows(progressRows)
      setConcurrency(settings.collectConcurrency)
    } catch {
      message.error('读取采集进度失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    // load 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    return window.api.videos.onProgress((next) => {
      setRows((previous) => {
        const index = previous.findIndex((item) => item.id === next.id)
        if (index === -1) return [next, ...previous]
        const current = previous[index]
        if (current.updatedAt > next.updatedAt) return previous
        const updated = [...previous]
        updated[index] = next
        return updated
      })
    })
  }, [load])

  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites])
  /** 运行 / 排队数直接从进度行推导，跟着 onProgress 实时变；并发度本身以主进程返回值为准 */
  const runningCount = rows.filter(
    (item) => item.status === 'running' || item.status === 'replacing'
  ).length
  const queuedCount = rows.filter((item) => item.status === 'queued').length
  const ordered = useMemo(() => {
    // 运行中的卡片按开始时间固定顺序，不会被每页进度事件顶来顶去
    return [...rows].sort(compareCollectProgress)
  }, [rows])

  const cancel = async (item: VideoCollectProgress): Promise<void> => {
    setCancelling(item.id)
    try {
      const result = await window.api.videos.cancelCollect({
        siteId: item.siteId,
        mode: item.mode,
        fetchRange: item.fetchRange
      })
      if (!result.ok) {
        message.error('取消失败，请重试')
        return
      }
      message.success('已取消')
    } catch {
      message.error('取消失败，请重试')
    } finally {
      setCancelling(null)
    }
  }

  /**
   * 调整同时采集的站点数：调大后主进程立刻把排队任务填进新槽位，
   * 调小只影响后续填槽、不打断正在采集的任务。
   */
  const changeConcurrency = async (value: number): Promise<void> => {
    setSavingConcurrency(true)
    try {
      const settings = await window.api.settings.setCollectConcurrency(value)
      setConcurrency(settings.collectConcurrency)
      message.success(`并发已调整为 ${settings.collectConcurrency} 路`)
    } catch {
      message.error('调整采集并发失败，请重试')
    } finally {
      setSavingConcurrency(false)
    }
  }

  /** fromStart = true 时清空进度重来，false 时从断点（失败页）接着采 */
  const runCollect = async (item: VideoCollectProgress, fromStart: boolean): Promise<void> => {
    setActing(`${item.id}:${fromStart ? 'restart' : 'resume'}`)
    try {
      const result = await window.api.videos.collect({
        siteId: item.siteId,
        mode: item.mode,
        fetchRange: item.fetchRange,
        restart: fromStart,
        // 续采不带弹窗，详情缓存沿用上次手动采集的选择
        cacheDetail: manualCacheDetail(),
        // 之前跑过就沿用已经确认过的真实页大小，省掉一次探测请求
        pageSize: item.pageSize > 0 ? item.pageSize : undefined
      })
      if (!result.ok) {
        message.warning(COLLECT_ERRORS[result.error ?? ''] ?? '发起采集失败，请重试')
        return
      }
      await load()
      message.success(
        fromStart ? '已重新入队，从第 1 页开始' : `已继续采集，从第 ${item.page + 1} 页开始`
      )
    } catch {
      message.error('发起采集失败，请重试')
    } finally {
      setActing(null)
    }
  }

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">共 {rows.length} 条采集记录</span>
          {runningCount > 0 && <span className="sites-count">运行 {runningCount}</span>}
          {queuedCount > 0 && <span className="sites-count">排队 {queuedCount}</span>}
        </p>
        <div className="settings-panel-actions">
          <Tooltip title="同时采集的站点数（1–4）。调大后排队任务立即开始；调小不会打断正在采集的任务。">
            <div className="progress-concurrency">
              <span className="progress-concurrency-label">并发</span>
              <Select
                size="small"
                style={{ width: 86 }}
                value={concurrency}
                disabled={savingConcurrency}
                options={CONCURRENCY_OPTIONS}
                onChange={(value) => void changeConcurrency(value)}
                aria-label="同时采集的站点数"
              />
            </div>
          </Tooltip>
          <Button icon={<CloudDownloadOutlined />} onClick={onOpenCollect}>
            发起采集
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在读取采集进度…</span>
        </div>
      ) : ordered.length === 0 ? (
        <div className="sites-placeholder">
          <span className="sites-empty-title">还没有采集记录</span>
          <span className="sites-empty-hint">去「采集」发起一次，进度会实时显示在这里</span>
        </div>
      ) : (
        <div className="progress-list">
          {ordered.map((item) => {
            // 已完成一律视为 100%，其余按页数推算
            const percent =
              item.status === 'done'
                ? 100
                : item.pageCount > 0
                  ? Math.min(100, Math.round((item.page / item.pageCount) * 100))
                  : 0
            const active = item.status === 'running' || item.status === 'replacing'
            const label = siteLabel(siteMap.get(item.siteId), item.siteId)
            // 下边框进度条只在这三种状态下出现：进行中（流光）、暂停（琥珀）、已完成（满格绿）
            const stateClass = active
              ? ' is-active'
              : item.status === 'paused'
                ? ' is-paused'
                : item.status === 'done'
                  ? ' is-done'
                  : ''
            return (
              <article
                className={`progress-card${stateClass}`}
                key={item.id}
                style={{ '--progress': `${percent}%` } as React.CSSProperties}
              >
                <div className="progress-card-head">
                  <div className="progress-card-title">
                    <span className="progress-site-name" title={label}>
                      {label}
                    </span>
                    <span className="progress-site-id" title={item.siteId}>
                      {item.siteId.slice(0, 8)}
                    </span>
                    <span className="progress-mode">
                      {modeText(item.mode)} · {item.fetchRange === 'all' ? '全部' : item.fetchRange}
                      {item.pageSize > 0 ? ` · 每页 ${item.pageSize} 条` : ''}
                    </span>
                    <span className="progress-caption">
                      {progressText(item)}
                      {item.pageCount > 0 ? ` · ${percent}%` : ''}
                      {/* 站点在 <list recordcount> / total 里给的真实记录总量 */}
                      {item.recordCount > 0 ? ` · 共 ${formatCount(item.recordCount)} 条` : ''}
                    </span>
                  </div>
                  <Tag color={COLLECT_STATUS_COLOR[item.status]}>
                    {COLLECT_STATUS_TEXT[item.status]}
                  </Tag>
                  <div className="progress-actions">
                    <Tooltip title="查看该站点日志">
                      <Button
                        type="text"
                        size="small"
                        icon={<FileTextOutlined />}
                        onClick={() => onOpenLogs(item.siteId)}
                        aria-label="查看该站点日志"
                      />
                    </Tooltip>
                    {isResumableStatus(item.status) ? (
                      <>
                        <Tooltip
                          title={
                            item.page > 0 ? `从第 ${item.page + 1} 页接着采集` : '继续这条采集'
                          }
                        >
                          <Button
                            type="link"
                            size="small"
                            icon={<PlayCircleOutlined />}
                            loading={acting === `${item.id}:resume`}
                            onClick={() => void runCollect(item, false)}
                          >
                            继续采集
                          </Button>
                        </Tooltip>
                        <Popconfirm
                          title="重新采集"
                          description="清空这条进度和计数，从第 1 页重新开始。"
                          okText="重新采集"
                          cancelText="取消"
                          onConfirm={() => void runCollect(item, true)}
                        >
                          <Button
                            type="link"
                            size="small"
                            icon={<ReloadOutlined />}
                            loading={acting === `${item.id}:restart`}
                          >
                            重新采集
                          </Button>
                        </Popconfirm>
                      </>
                    ) : (
                      <Tooltip title="重新发起采集">
                        <Button
                          type="text"
                          size="small"
                          icon={<CloudDownloadOutlined />}
                          onClick={onOpenCollect}
                          aria-label="重新发起采集"
                        />
                      </Tooltip>
                    )}
                    {(item.status === 'running' ||
                      item.status === 'queued' ||
                      item.status === 'replacing') && (
                      <Popconfirm
                        title="取消采集"
                        description={
                          item.status === 'queued'
                            ? '排队中的任务会直接移出队列。'
                            : '当前页结束后暂停，已提交的页会保留。'
                        }
                        okText="取消采集"
                        cancelText="继续"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void cancel(item)}
                      >
                        <Button
                          type="text"
                          danger
                          size="small"
                          loading={cancelling === item.id}
                          icon={<StopOutlined />}
                          aria-label="取消采集"
                        />
                      </Popconfirm>
                    )}
                  </div>
                </div>

                <div className="progress-card-foot">
                  <div className="progress-counts">
                    <span className="progress-count">
                      <span className="progress-count-label">抓取</span>
                      <span className="progress-count-value">{item.fetched}</span>
                    </span>
                    <span className="progress-count">
                      <span className="progress-count-label">新增</span>
                      <span className="progress-count-value is-inserted">{item.inserted}</span>
                    </span>
                    <span className="progress-count">
                      <span className="progress-count-label">更新</span>
                      <span className="progress-count-value is-updated">{item.updated}</span>
                    </span>
                    <span className="progress-count">
                      <span className="progress-count-label">失败</span>
                      <span className="progress-count-value is-failed">{item.failed}</span>
                    </span>
                    <span className="progress-count">
                      <span className="progress-count-label">删除</span>
                      <span className="progress-count-value is-deleted">{item.deleted}</span>
                    </span>
                  </div>
                  <div className="progress-time">
                    <span>开始 {item.startedAt ? formatDateTime(item.startedAt, true) : '—'}</span>
                    <span>
                      {item.finishedAt
                        ? `结束 ${formatDateTime(item.finishedAt, true)}`
                        : `更新 ${formatDateTime(item.updatedAt, true)}`}
                    </span>
                  </div>
                </div>

                {item.error && (
                  <Tooltip title={item.error}>
                    <span className="progress-error">{item.error}</span>
                  </Tooltip>
                )}
              </article>
            )
          })}
        </div>
      )}
    </>
  )
}

export default ProgressPanel
