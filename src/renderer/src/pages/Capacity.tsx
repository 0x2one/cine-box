import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Checkbox, Modal, Radio, Spin, Tooltip } from 'antd'
import {
  ClearOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  ReloadOutlined,
  ScanOutlined
} from '@ant-design/icons'
import { formatBytes, formatCount, formatDateTime } from '../utils/format'

/** 控制台「容量」：缓存索引 + 详情文件缓存体积，支持手动清理 */
function CapacityPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [capacity, setCapacity] = useState<VideoCapacity | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [fixMissing, setFixMissing] = useState(false)
  const [drift, setDrift] = useState<VideoCapacityDrift | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [clearAllOpen, setClearAllOpen] = useState(false)
  const [orphanOpen, setOrphanOpen] = useState(false)
  /** 清理详情的范围：'all' = 全部站点，否则是站点 id；弹窗里的单选也用它 */
  const [clearTarget, setClearTarget] = useState('all')
  /** 要删掉全部缓存数据的站点 id，空串 = 弹窗关着 */
  const [purgeTarget, setPurgeTarget] = useState('')
  const [clearing, setClearing] = useState<'details' | 'all' | 'orphans' | 'site' | null>(null)

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
  /** 有详情缓存的站点：清理详情的弹窗只列这些，全部站点那一行始终在 */
  const detailSites = useMemo(() => sites.filter((site) => site.detailCount > 0), [sites])
  const totalBytes = (capacity?.dbBytes ?? 0) + (capacity?.detailBytes ?? 0)
  const targetSite = useMemo(
    () => sites.find((site) => site.siteId === clearTarget) ?? null,
    [sites, clearTarget]
  )
  /** 清理范围的文案（全部站点 / 站点名），用在弹窗说明和成功提示里 */
  const targetName = clearTarget === 'all' ? '全部站点' : (targetSite?.siteName ?? '该站点')
  const targetBytes =
    clearTarget === 'all' ? (capacity?.detailBytes ?? 0) : (targetSite?.detailBytes ?? 0)
  const purgeSite = useMemo(
    () => sites.find((site) => site.siteId === purgeTarget) ?? null,
    [sites, purgeTarget]
  )

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

  /** 打开「清理详情」弹窗：工具栏按钮默认清全部，站点行的「清理详情」直接选中这个站点 */
  const openDetailClear = (target: string): void => {
    setClearTarget(target)
    setDetailsOpen(true)
  }

  const clearDetails = async (): Promise<void> => {
    setClearing('details')
    try {
      const result = await window.api.videos.clearDetails(
        clearTarget === 'all' ? undefined : { siteId: clearTarget }
      )
      if (!result.ok) {
        message.warning(
          `部分文件被占用，索引已重置${result.freedBytes ? `，释放 ${formatBytes(result.freedBytes)}` : ''}`
        )
      } else {
        message.success(
          `${targetName}的详情缓存已清理，释放 ${formatBytes(result.freedBytes ?? 0)}`
        )
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

  /**
   * 删除一个站点的全部缓存数据：来源、只属于它的视频、详情文件、采集进度与采集日志。
   * 站点本身与分类 / 绑定 / 计划在业务库里，不在这里删。
   */
  const purgeSiteData = async (): Promise<void> => {
    if (!purgeTarget) return
    setClearing('site')
    try {
      const result = await window.api.videos.purgeSite({ siteId: purgeTarget })
      if (!result.ok) {
        message.error('删除站点数据失败')
        return
      }
      message.success(
        `已删除「${purgeSite?.siteName ?? '该站点'}」的数据：${formatCount(result.sources)} 个来源、` +
          `${formatCount(result.videos)} 部视频，释放 ${formatBytes(result.detailBytes)}` +
          (result.shared > 0 ? `（${formatCount(result.shared)} 部与其它站点共有，已保留）` : '')
      )
      setPurgeTarget('')
      setDrift(null)
      await load()
    } catch {
      message.error('删除站点数据失败')
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

  /** 清理没有任何来源的视频：旧版本 / 异常中断才会留下的行，删完刷新容量 */
  const clearOrphans = async (): Promise<void> => {
    setClearing('orphans')
    try {
      const result = await window.api.videos.clearOrphans()
      if (!result.ok) {
        message.error('清理无来源视频失败')
        return
      }
      message.success(
        result.videos > 0 ? `已清理 ${result.videos} 个无来源视频` : '没有需要清理的无来源视频'
      )
      setOrphanOpen(false)
      await load()
    } catch {
      message.error('清理无来源视频失败')
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
          <Tooltip title="遍历 Data/videos，和缓存索引对账">
            <Button icon={<ScanOutlined />} loading={scanning} onClick={() => void scan()}>
              扫描校对
            </Button>
          </Tooltip>
          <Button
            icon={<DeleteOutlined />}
            disabled={!capacity || capacity.detailCount === 0}
            onClick={() => openDetailClear('all')}
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
                <span>缓存索引</span>
              </div>
              <strong className="capacity-value">{formatBytes(capacity?.dbBytes ?? 0)}</strong>
              <span className="capacity-hint">
                数据文件 {formatBytes(capacity?.dbFileBytes ?? 0)} · 写入缓冲{' '}
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
              <span className="capacity-hint">缓存索引 + 详情文件</span>
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
            <Tooltip title="缓存库里已经没有来源的视频（正常流程不会产生，只有旧版本或异常中断才会留下）">
              {/* 禁用状态的 antd 按钮不触发鼠标事件，包一层 span 才能看到提示 */}
              <span>
                <Button
                  size="small"
                  icon={<DeleteOutlined />}
                  disabled={!capacity || (capacity.orphanCount ?? 0) === 0}
                  onClick={() => setOrphanOpen(true)}
                >
                  清理无来源视频（{capacity?.orphanCount ?? 0}）
                </Button>
              </span>
            </Tooltip>
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
                <span className="sites-empty-title">还没有站点缓存</span>
                <span className="sites-empty-hint">采集视频后会按来源分站点统计</span>
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
                    <span className="capacity-row-actions">
                      <Button
                        size="small"
                        type="text"
                        disabled={site.detailCount === 0}
                        onClick={() => openDetailClear(site.siteId)}
                      >
                        清理详情
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => setPurgeTarget(site.siteId)}
                      >
                        删除数据
                      </Button>
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
        width={520}
      >
        <div className="capacity-clear">
          <Radio.Group
            className="capacity-scope-list"
            value={clearTarget}
            onChange={(event) => setClearTarget(event.target.value as string)}
          >
            <Radio className="capacity-scope-row" value="all">
              <span className="capacity-scope-name">全部站点</span>
              <span className="capacity-scope-meta">
                {capacity?.detailCount ?? 0} 个详情 · {formatBytes(capacity?.detailBytes ?? 0)}
              </span>
            </Radio>
            {detailSites.map((site) => (
              <Radio className="capacity-scope-row" value={site.siteId} key={site.siteId}>
                <span className="capacity-scope-name">
                  {site.siteName || `已删除站点 ${site.siteId.slice(0, 8)}`}
                </span>
                <span className="capacity-scope-meta">
                  {site.detailCount} 个详情 · {formatBytes(site.detailBytes)}
                </span>
              </Radio>
            ))}
          </Radio.Group>
          <p className="capacity-warning">
            将删除「{targetName}」的详情文件并重置详情索引，预计释放 {formatBytes(targetBytes)}。
            列表、搜索、采集进度、日志与定时计划都会保留；再次打开详情会重新抓取并回填。
          </p>
        </div>
      </Modal>

      <Modal
        title="删除站点数据"
        open={Boolean(purgeTarget)}
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={clearing === 'site'}
        onOk={() => void purgeSiteData()}
        onCancel={() => setPurgeTarget('')}
        width={480}
      >
        <div className="capacity-clear">
          <p className="capacity-warning">
            将删除「{purgeSite?.siteName ?? '该站点'}」的 {formatCount(purgeSite?.sourceCount ?? 0)}{' '}
            个来源、{formatCount(purgeSite?.detailCount ?? 0)} 个详情文件（
            {formatBytes(purgeSite?.detailBytes ?? 0)}）、这个站点的采集进度与采集日志，涉及{' '}
            {formatCount(purgeSite?.videoCount ?? 0)} 部视频。
          </p>
          <p className="capacity-warning">
            只在这个站点有来源的视频会一起删掉，人工备注 / 简介 /
            封面等编辑跟着消失；与其它站点共有的视频保留，并重新挑主来源。正在跑的采集会先停下。
          </p>
          <p className="capacity-warning">
            站点本身、在线 /
            本地分类、绑定关系与定时采集计划都不受影响——要连站点一起删，请去「站点」。推荐页里指向这些视频的条目会显示「视频已丢失」，需要手动移除。
          </p>
        </div>
      </Modal>

      <Modal
        title="清理无来源视频"
        open={orphanOpen}
        okText="清理"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={clearing === 'orphans'}
        onOk={() => void clearOrphans()}
        onCancel={() => setOrphanOpen(false)}
        width={480}
      >
        <div className="capacity-clear">
          <p className="capacity-warning">
            {`将删除 ${capacity?.orphanCount ?? 0} 个已经没有来源的视频，以及它们的人工编辑（备注、简介、封面等），搜索索引会同步更新。`}
          </p>
          <p className="capacity-warning">
            站点、在线分类、本地分类、绑定关系与定时采集计划不受影响。正常的删除站点与全量替换都会顺手清掉这类行，
            这里只是修复旧版本或异常中断留下的数据。
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
            推荐页的配置（海报、分类轨道、搜索推荐）也会一并清空，自定义图片同时删除——它们指向的视频都已经不在了。
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
