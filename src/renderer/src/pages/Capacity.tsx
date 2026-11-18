import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Checkbox, Modal, Radio, Select, Space, Spin, Tooltip } from 'antd'
import {
  ClearOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  ReloadOutlined,
  ScanOutlined
} from '@ant-design/icons'
import { formatBytes, formatDateTime } from '../utils/format'

/** 控制台「容量」：SQLite 索引 + 详情文件缓存体积，支持手动清理 */
function CapacityPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [capacity, setCapacity] = useState<VideoCapacity | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [fixMissing, setFixMissing] = useState(false)
  const [drift, setDrift] = useState<VideoCapacityDrift | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [clearAllOpen, setClearAllOpen] = useState(false)
  const [scope, setScope] = useState<'all' | 'site'>('all')
  const [clearSiteId, setClearSiteId] = useState('')
  const [clearing, setClearing] = useState<'details' | 'all' | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setCapacity(await window.api.videos.capacity())
    } catch {
      message.error('读取缓存容量失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    // load 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const sites = capacity?.sites ?? []
  const totalBytes = (capacity?.dbBytes ?? 0) + (capacity?.detailBytes ?? 0)
  const selectedSite = useMemo(
    () => sites.find((site) => site.siteId === clearSiteId) ?? null,
    [sites, clearSiteId]
  )
  const estimatedBytes =
    scope === 'all' ? (capacity?.detailBytes ?? 0) : (selectedSite?.detailBytes ?? 0)

  const scan = async (): Promise<void> => {
    setScanning(true)
    try {
      const result = await window.api.videos.scanCapacity({ fixMissing })
      if (result.drift) setDrift(result.drift)
      setCapacity(result)
      message.success('扫描完成')
    } catch {
      message.error('扫描详情目录失败')
    } finally {
      setScanning(false)
    }
  }

  const clearDetails = async (): Promise<void> => {
    if (scope === 'site' && !clearSiteId) {
      message.warning('请选择要清理的站点')
      return
    }
    setClearing('details')
    try {
      const result = await window.api.videos.clearDetails(
        scope === 'site' ? { siteId: clearSiteId } : undefined
      )
      if (!result.ok) {
        message.warning(
          `部分文件被占用，索引已重置${result.freedBytes ? `，释放 ${formatBytes(result.freedBytes)}` : ''}`
        )
      } else {
        message.success(`详情缓存已清理，释放 ${formatBytes(result.freedBytes ?? 0)}`)
      }
      setDetailsOpen(false)
      setDrift(null)
      await load()
    } catch {
      message.error('清理详情缓存失败')
    } finally {
      setClearing(null)
    }
  }

  const clearAll = async (): Promise<void> => {
    setClearing('all')
    try {
      const result = await window.api.videos.clear()
      if (!result.ok) {
        message.error('清空缓存失败，可能有文件被占用')
        return
      }
      message.success(`全部缓存已清空，释放 ${formatBytes(result.freedBytes ?? 0)}`)
      setClearAllOpen(false)
      setDrift(null)
      await load()
    } catch {
      message.error('清空缓存失败')
    } finally {
      setClearing(null)
    }
  }

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">{desc}</p>
        <div className="settings-panel-actions">
          <Tooltip title="重新读取索引与文件大小">
            <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Tooltip>
          <Tooltip title="遍历 Data/videos，和 SQLite 索引对账">
            <Button icon={<ScanOutlined />} loading={scanning} onClick={() => void scan()}>
              扫描校对
            </Button>
          </Tooltip>
          <Button
            icon={<DeleteOutlined />}
            disabled={!capacity || capacity.detailCount === 0}
            onClick={() => {
              setScope('all')
              setClearSiteId('')
              setDetailsOpen(true)
            }}
          >
            清理详情
          </Button>
          <Button danger icon={<ClearOutlined />} onClick={() => setClearAllOpen(true)}>
            清空全部
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在统计缓存容量…</span>
        </div>
      ) : (
        <>
          <div className="capacity-grid">
            <section className="capacity-card">
              <div className="capacity-card-head">
                <DatabaseOutlined />
                <span>SQLite 缓存</span>
              </div>
              <strong className="capacity-value">{formatBytes(capacity?.dbBytes ?? 0)}</strong>
              <span className="capacity-hint">
                主库 {formatBytes(capacity?.dbFileBytes ?? 0)} · WAL{' '}
                {formatBytes(capacity?.walBytes ?? 0)}
              </span>
              <div className="capacity-stats">
                <span>{capacity?.videoCount ?? 0} 个视频</span>
                <span>{capacity?.sourceCount ?? 0} 个来源</span>
                <span>{capacity?.logCount ?? 0} 条日志</span>
              </div>
            </section>

            <section className="capacity-card">
              <div className="capacity-card-head">
                <FileTextOutlined />
                <span>详情文件缓存</span>
              </div>
              <strong className="capacity-value">{formatBytes(capacity?.detailBytes ?? 0)}</strong>
              <span className="capacity-hint">
                {capacity?.detailCount ?? 0} 个详情索引 · {capacity?.siteCount ?? 0} 个站点
              </span>
              <div className="capacity-stats">
                <span>
                  上次采集：
                  {capacity?.lastCollectedAt
                    ? formatDateTime(capacity.lastCollectedAt, true)
                    : '从未'}
                </span>
              </div>
            </section>

            <section className="capacity-card capacity-card-total">
              <div className="capacity-card-head">
                <ScanOutlined />
                <span>合计占用</span>
              </div>
              <strong className="capacity-value">{formatBytes(totalBytes)}</strong>
              <span className="capacity-hint">SQLite + 详情文件</span>
              <div className="capacity-stats">
                <span>清理不会影响站点、分类、绑定与定时计划</span>
              </div>
            </section>
          </div>

          <div className="capacity-toolbar">
            <Checkbox
              checked={fixMissing}
              onChange={(event) => setFixMissing(event.target.checked)}
            >
              扫描时清理“索引有、文件不存在”的行
            </Checkbox>
          </div>

          {drift && (
            <section className="capacity-drift">
              <div className="capacity-drift-head">
                <span>最近一次校对</span>
                <span className="capacity-drift-time">{formatDateTime(drift.scannedAt, true)}</span>
              </div>
              <div className="capacity-drift-grid">
                <span>索引 {drift.indexCount} 个</span>
                <span>文件 {drift.fileCount} 个</span>
                <span>索引体积 {formatBytes(drift.indexBytes)}</span>
                <span>文件体积 {formatBytes(drift.fileBytes)}</span>
                <span className={drift.missing > 0 ? 'is-warn' : ''}>
                  文件缺失 {drift.missing} 个
                </span>
                <span className={drift.orphan > 0 ? 'is-warn' : ''}>
                  孤儿文件 {drift.orphan} 个
                </span>
                <span className={drift.tempFiles > 0 ? 'is-warn' : ''}>
                  临时文件 {drift.tempFiles} 个
                </span>
                <span>已修复索引 {drift.fixed} 个</span>
              </div>
            </section>
          )}

          <div className="capacity-sites">
            <div className="capacity-sites-head">
              <span>按站点统计</span>
              <span className="sites-count">共 {sites.length} 个站点有缓存</span>
            </div>
            {sites.length === 0 ? (
              <div className="sites-placeholder">
                <span className="sites-empty-title">还没有详情缓存</span>
                <span className="sites-empty-hint">打开视频详情后会按需产生缓存文件</span>
              </div>
            ) : (
              <ul className="capacity-list">
                {sites.map((site) => (
                  <li className="capacity-row" key={site.siteId}>
                    <span className="capacity-row-name">
                      {site.siteName || `已删除站点 ${site.siteId.slice(0, 8)}`}
                    </span>
                    <span className="capacity-row-meta">
                      {site.videoCount} 个视频 · {site.sourceCount} 个来源
                    </span>
                    <span className="capacity-row-detail">
                      {site.detailCount} 个详情 · {formatBytes(site.detailBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <Modal
        title="清理详情缓存"
        open={detailsOpen}
        okText="清理"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={clearing === 'details'}
        onOk={() => void clearDetails()}
        onCancel={() => setDetailsOpen(false)}
        width={480}
      >
        <div className="capacity-clear">
          <Radio.Group
            value={scope}
            onChange={(event) => setScope(event.target.value as 'all' | 'site')}
          >
            <Space direction="vertical">
              <Radio value="all">清理全部站点的详情缓存</Radio>
              <Radio value="site">只清理指定站点</Radio>
            </Space>
          </Radio.Group>
          {scope === 'site' && (
            <Select
              style={{ width: '100%', marginTop: 12 }}
              placeholder="选择站点"
              value={clearSiteId || undefined}
              onChange={setClearSiteId}
              options={sites.map((site) => ({
                value: site.siteId,
                label: `${site.siteName || site.siteId.slice(0, 8)}（${site.detailCount} 个详情）`
              }))}
            />
          )}
          <p className="capacity-warning">
            将删除对应的详情文件并重置详情索引，预计释放 {formatBytes(estimatedBytes)}。
            列表、搜索、采集进度、日志与定时计划都会保留；再次打开详情会重新抓取并回填。
          </p>
        </div>
      </Modal>

      <Modal
        title="清空全部视频缓存"
        open={clearAllOpen}
        okText="清空并重建"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={clearing === 'all'}
        onOk={() => void clearAll()}
        onCancel={() => setClearAllOpen(false)}
        width={480}
      >
        <div className="capacity-clear">
          <p className="capacity-warning">
            会删除视频列表、搜索索引、采集进度、采集日志与全部详情文件，并重建空缓存库，预计释放{' '}
            {formatBytes(totalBytes)}。
          </p>
          <p className="capacity-warning">
            站点、在线分类、本地分类、绑定关系与定时采集计划保存在业务库中，不受影响；定时计划到点后会重新入队。
          </p>
        </div>
      </Modal>
    </>
  )
}

export default CapacityPanel
