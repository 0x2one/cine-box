import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Popconfirm, Select, Space, Spin, Switch, Tag, Tooltip } from 'antd'
import {
  ClearOutlined,
  ReloadOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined
} from '@ant-design/icons'
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

const RANGE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' }
]

type RangeKey = 'all' | 'today' | '7d'

/** 时间范围 → 查询用的 ISO 下界（本地时区计算） */
function rangeSince(range: RangeKey): string | undefined {
  if (range === 'all') return undefined
  if (range === '7d') return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.toISOString()
}

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
  const [range, setRange] = useState<RangeKey>('all')
  /** latest：看最近一批；earliest：跳到最早一批 */
  const [view, setView] = useState<'latest' | 'earliest'>('latest')
  /** 停在最早一批时收到新日志，提示去「最新」 */
  const [hasNew, setHasNew] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(true)
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

  const load = useCallback(
    async (target: 'latest' | 'earliest' = 'latest'): Promise<void> => {
      setLoading(true)
      try {
        const result = await window.api.videos.logs({
          siteId: siteId || undefined,
          level: level ? (level as LogLevel) : undefined,
          since: rangeSince(range),
          order: target === 'earliest' ? 'oldest' : 'newest',
          limit: 100
        })
        // 列表统一按时间正序：最新一批倒序返回，需要翻转；最早一批本身就是正序
        setLogs(target === 'earliest' ? result.logs : [...result.logs].reverse())
        setView(target)
        setHasNew(false)
      } catch {
        message.error('读取采集日志失败')
      } finally {
        setLoading(false)
      }
    },
    [siteId, level, range, message]
  )

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
      // 停在最早一批时不往列表里追加，只提示有新日志
      if (view !== 'latest') {
        setHasNew(true)
        return
      }
      setLogs((previous) => {
        if (previous.some((item) => item.id === log.id)) return previous
        const next = [...previous, log]
        return next.length > MAX_KEEP ? next.slice(next.length - MAX_KEEP) : next
      })
    })
  }, [siteId, level, view])

  useEffect(() => {
    if (!autoScroll || view !== 'latest' || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [logs, autoScroll, view])

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
          <span className="sites-count">
            {view === 'earliest' ? '最早' : '最近'} {logs.length} 条
          </span>
          {hasNew && <span className="log-new-hint">有新日志</span>}
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
          <Select
            style={{ width: 120 }}
            value={range}
            onChange={(value) => setRange(value as RangeKey)}
            options={RANGE_OPTIONS}
          />
        </Space>
        <Space size={10} align="center">
          <Tooltip title="有新日志时自动滚到列表底部">
            <span className="log-auto">
              <Switch size="small" checked={autoScroll} onChange={setAutoScroll} />
              自动滚动
            </span>
          </Tooltip>
          <Tooltip title="跳到这批筛选结果里最早的 100 条，从旧往新看">
            <Button
              size="small"
              icon={<VerticalAlignTopOutlined />}
              disabled={loading || view === 'earliest'}
              onClick={() => void load('earliest')}
            >
              跳到最早
            </Button>
          </Tooltip>
          <Tooltip title="回到最近 100 条，并继续实时追加新日志">
            <Button
              size="small"
              icon={<VerticalAlignBottomOutlined />}
              disabled={loading || view === 'latest'}
              onClick={() => void load('latest')}
            >
              回到最新
            </Button>
          </Tooltip>
        </Space>
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
                {/* detail 是通用补充说明：错误才折叠成「错误详情」，其余直接内联显示 */}
                {log.detail &&
                  (log.level === 'error' ? (
                    <details className="log-detail">
                      <summary>错误详情</summary>
                      <pre>{log.detail}</pre>
                    </details>
                  ) : (
                    <div className="log-note">{log.detail}</div>
                  ))}
              </article>
            )
          })}
        </div>
      )}

      {!loading && logs.length > 0 && (
        <div className="log-foot">
          <Tooltip title="一次显示 100 条；用右侧「最新 / 最早」切换两端，或先按时间范围缩小范围">
            <span>日志最多保留 5000 条 / 30 天；清空视频缓存时日志也会一并清空。</span>
          </Tooltip>
        </div>
      )}
    </>
  )
}

export default LogsPanel
