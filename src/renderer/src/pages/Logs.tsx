import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Popconfirm, Select, Space, Spin, Switch, Tag, Tooltip } from 'antd'
import { ClearOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { formatDateTime } from '../utils/format'

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: 'blue',
  warn: 'orange',
  error: 'red'
}

const LEVEL_OPTIONS = [
  { value: '', label: '全部级别' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' }
]

const MAX_KEEP = 1000

/** 控制台「日志」：读取 collect_logs，支持站点/级别筛选、实时追加与清空 */
function LogsPanel({
  title,
  desc,
  initialSiteId = ''
}: {
  title: string
  desc: string
  initialSiteId?: string
}): React.JSX.Element {
  const { message } = App.useApp()
  const [sites, setSites] = useState<Site[]>([])
  const [logs, setLogs] = useState<VideoCollectLog[]>([])
  const [siteId, setSiteId] = useState(initialSiteId)
  const [level, setLevel] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [clearing, setClearing] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites])
  const siteOptions = useMemo(() => {
    const options = sites.map((site) => ({
      value: site.id,
      label: site.display || site.name
    }))
    // 从进度页带过来的站点可能已被删除，仍要能显示当前筛选
    if (siteId && !sites.some((site) => site.id === siteId)) {
      options.unshift({ value: siteId, label: `已删除站点 ${siteId.slice(0, 8)}` })
    }
    return options
  }, [sites, siteId])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.api.videos.logs({
        siteId: siteId || undefined,
        level: level ? (level as LogLevel) : undefined,
        limit: 100
      })
      setLogs([...result.logs].reverse())
    } catch {
      message.error('读取采集日志失败')
    } finally {
      setLoading(false)
    }
  }, [siteId, level, message])

  useEffect(() => {
    void window.api.sites
      .list()
      .then(setSites)
      .catch(() => {})
  }, [])

  useEffect(() => {
    // load 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  useEffect(() => {
    return window.api.videos.onLogAppend((log) => {
      if (siteId && log.siteId !== siteId) return
      if (level && log.level !== level) return
      setLogs((previous) => {
        if (previous.some((item) => item.id === log.id)) return previous
        const next = [...previous, log]
        return next.length > MAX_KEEP ? next.slice(next.length - MAX_KEEP) : next
      })
    })
  }, [siteId, level])

  useEffect(() => {
    if (!autoScroll || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [logs, autoScroll])

  const loadMore = async (): Promise<void> => {
    const first = logs[0]
    if (!first) return
    setLoadingMore(true)
    try {
      const result = await window.api.videos.logs({
        siteId: siteId || undefined,
        level: level ? (level as LogLevel) : undefined,
        beforeId: first.id,
        limit: 100
      })
      const older = [...result.logs].reverse()
      setLogs((previous) => {
        const known = new Set(previous.map((item) => item.id))
        const merged = [...older.filter((item) => !known.has(item.id)), ...previous]
        return merged.length > MAX_KEEP ? merged.slice(0, MAX_KEEP) : merged
      })
    } catch {
      message.error('加载更早日志失败')
    } finally {
      setLoadingMore(false)
    }
  }

  const clear = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.videos.clearLogs(siteId ? { siteId } : undefined)
      setLogs([])
      message.success(siteId ? '该站点的采集日志已清空' : '采集日志已清空')
    } catch {
      message.error('清空日志失败')
    } finally {
      setClearing(false)
    }
  }

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">当前显示 {logs.length} 条</span>
        </p>
        <div className="settings-panel-actions">
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Popconfirm
            title="清空采集日志"
            description={
              siteId ? '只清空当前站点筛选下的日志。' : '会清空全部采集日志，不影响采集任务。'
            }
            okText="清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void clear()}
          >
            <Button danger icon={<ClearOutlined />} loading={clearing}>
              清空
            </Button>
          </Popconfirm>
        </div>
      </div>

      <div className="log-toolbar">
        <Space wrap>
          <Select
            style={{ width: 220 }}
            placeholder="全部站点"
            allowClear
            value={siteId || undefined}
            onChange={(value) => setSiteId(value ?? '')}
            options={siteOptions}
          />
          <Select
            style={{ width: 140 }}
            value={level}
            onChange={setLevel}
            options={LEVEL_OPTIONS}
          />
          <span className="log-auto">
            <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
            自动滚动
          </span>
        </Space>
        <Button
          size="small"
          loading={loadingMore}
          onClick={() => void loadMore()}
          disabled={logs.length === 0}
        >
          <DownloadOutlined /> 加载更早
        </Button>
      </div>

      {loading ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在读取采集日志…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="sites-placeholder">
          <span className="sites-empty-title">暂无日志</span>
          <span className="sites-empty-hint">发起采集后，开始、进度、完成和错误会实时写在这里</span>
        </div>
      ) : (
        <div className="log-list" ref={listRef}>
          {logs.map((log) => {
            const site = siteMap.get(log.siteId)
            return (
              <article className={`log-row log-row-${log.level}`} key={log.id}>
                <div className="log-row-head">
                  <span className="log-time">{formatDateTime(log.createdAt, true)}</span>
                  <Tag color={LEVEL_COLOR[log.level]}>{log.level.toUpperCase()}</Tag>
                  <span className="log-site">
                    {log.siteId
                      ? site
                        ? site.display || site.name
                        : `已删除站点 ${log.siteId.slice(0, 8)}`
                      : '系统'}
                  </span>
                  {log.mode && (
                    <span className="log-mode">
                      {log.mode === 'full' ? '全量' : '增量'}
                      {log.fetchRange ? ` / ${log.fetchRange}` : ''}
                    </span>
                  )}
                </div>
                <div className="log-message">{log.message}</div>
                {log.detail && (
                  <details className="log-detail">
                    <summary>错误详情</summary>
                    <pre>{log.detail}</pre>
                  </details>
                )}
              </article>
            )
          })}
        </div>
      )}

      {!loading && logs.length > 0 && (
        <div className="log-foot">
          <Tooltip title="客户端最多保留 1000 条，更多历史请用「加载更早」">
            <span>日志最多保留 5000 条 / 30 天；清空视频缓存时日志也会一并清空。</span>
          </Tooltip>
        </div>
      )}
    </>
  )
}

export default LogsPanel
