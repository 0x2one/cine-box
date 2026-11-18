import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Popconfirm, Progress, Spin, Tag, Tooltip } from 'antd'
import { CloudDownloadOutlined, FileTextOutlined, StopOutlined } from '@ant-design/icons'
import { formatDateTime } from '../utils/format'

const STATUS_TEXT: Record<CollectStatus, string> = {
  idle: '未采集',
  queued: '排队中',
  running: '采集中',
  paused: '已暂停',
  replacing: '全量替换中',
  done: '已完成',
  error: '出错'
}

const STATUS_COLOR: Record<CollectStatus, string> = {
  idle: 'default',
  queued: 'processing',
  running: 'processing',
  paused: 'warning',
  replacing: 'processing',
  done: 'success',
  error: 'error'
}

const STATUS_ORDER: Record<CollectStatus, number> = {
  running: 0,
  replacing: 1,
  queued: 2,
  error: 3,
  paused: 4,
  idle: 5,
  done: 6
}

function siteLabel(site: Site | undefined, siteId: string): string {
  return site ? site.display || site.name : `已删除站点 ${siteId.slice(0, 8)}`
}

function modeText(mode: CollectMode): string {
  return mode === 'full' ? '全量' : '增量'
}

function progressText(item: VideoCollectProgress): string {
  if (item.pageCount > 0) return `第 ${item.page} / ${item.pageCount} 页`
  return item.page > 0 ? `第 ${item.page} 页` : '等待开始'
}

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

  const load = useCallback(async (): Promise<void> => {
    try {
      const [siteRows, progressRows] = await Promise.all([
        window.api.sites.list(),
        window.api.videos.progress()
      ])
      setSites(siteRows)
      setRows(progressRows)
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
  const ordered = useMemo(() => {
    return [...rows].sort((left, right) => {
      const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
      if (byStatus !== 0) return byStatus
      return right.updatedAt.localeCompare(left.updatedAt)
    })
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

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">共 {rows.length} 条采集记录</span>
        </p>
        <div className="settings-panel-actions">
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
        <div className="progress-table">
          <div className="progress-row progress-row-head">
            <span>站点</span>
            <span>模式 / 方式</span>
            <span>状态</span>
            <span>进度</span>
            <span>抓取 / 新增 / 更新 / 失败 / 删除</span>
            <span>时间</span>
            <span />
          </div>
          {ordered.map((item) => {
            const percent =
              item.pageCount > 0
                ? Math.min(100, Math.round((item.page / item.pageCount) * 100))
                : item.status === 'done'
                  ? 100
                  : 0
            const active = item.status === 'running' || item.status === 'replacing'
            return (
              <div className={`progress-row${active ? ' is-active' : ''}`} key={item.id}>
                <div className="progress-site">
                  <span className="progress-site-name">
                    {siteLabel(siteMap.get(item.siteId), item.siteId)}
                  </span>
                  <span className="progress-site-id" title={item.siteId}>
                    {item.siteId.slice(0, 8)}
                  </span>
                </div>
                <div className="progress-mode">
                  <span>{modeText(item.mode)}</span>
                  <span className="progress-range">
                    {item.fetchRange === 'all' ? '全部' : item.fetchRange}
                  </span>
                </div>
                <div>
                  <Tag color={STATUS_COLOR[item.status]}>{STATUS_TEXT[item.status]}</Tag>
                </div>
                <div className="progress-bar">
                  <Progress
                    percent={percent}
                    size="small"
                    showInfo={false}
                    status={
                      item.status === 'error'
                        ? 'exception'
                        : active
                          ? 'active'
                          : item.status === 'done'
                            ? 'success'
                            : 'normal'
                    }
                  />
                  <span className="progress-caption">{progressText(item)}</span>
                </div>
                <div className="progress-counts">
                  <span>{item.fetched}</span>
                  <span className="is-inserted">{item.inserted}</span>
                  <span className="is-updated">{item.updated}</span>
                  <span className="is-failed">{item.failed}</span>
                  <span className="is-deleted">{item.deleted}</span>
                </div>
                <div className="progress-time">
                  <span>开始 {item.startedAt ? formatDateTime(item.startedAt, true) : '—'}</span>
                  <span>
                    {item.finishedAt
                      ? `结束 ${formatDateTime(item.finishedAt, true)}`
                      : `更新 ${formatDateTime(item.updatedAt, true)}`}
                  </span>
                  {item.error && (
                    <Tooltip title={item.error}>
                      <span className="progress-error" title={item.error}>
                        {item.error}
                      </span>
                    </Tooltip>
                  )}
                </div>
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
                  <Tooltip title="重新发起采集">
                    <Button
                      type="text"
                      size="small"
                      icon={<CloudDownloadOutlined />}
                      onClick={onOpenCollect}
                      aria-label="重新发起采集"
                    />
                  </Tooltip>
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
            )
          })}
        </div>
      )}
    </>
  )
}

export default ProgressPanel
