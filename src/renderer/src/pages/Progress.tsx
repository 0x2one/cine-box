import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Popconfirm, Spin, Tag, Tooltip } from 'antd'
import { CloudDownloadOutlined, FileTextOutlined, StopOutlined } from '@ant-design/icons'
import { formatDateTime } from '../utils/format'
import {
  COLLECT_STATUS_COLOR,
  COLLECT_STATUS_ORDER,
  COLLECT_STATUS_TEXT,
  siteLabel
} from '../utils/collect'

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
      const byStatus = COLLECT_STATUS_ORDER[left.status] - COLLECT_STATUS_ORDER[right.status]
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
                    </span>
                    <span className="progress-caption">
                      {progressText(item)}
                      {item.pageCount > 0 ? ` · ${percent}%` : ''}
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
