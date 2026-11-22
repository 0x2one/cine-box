import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Checkbox, Popconfirm, Progress, Segmented, Spin, Tooltip } from 'antd'
import {
  CheckCircleOutlined,
  CheckOutlined,
  InfoCircleOutlined,
  PictureOutlined,
  ReloadOutlined,
  SyncOutlined,
  VideoCameraOutlined
} from '@ant-design/icons'
import FallbackImage from '../components/FallbackImage'
import { formatCount, formatShortDateTime } from '../utils/format'
import type { ConsoleSection } from '../types'

/** 同步耗时的口语化显示：大部分库一两秒，超过一分钟才需要分秒 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '不到 1 秒'
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
}

/**
 * 控制台「封面」：把「采集时用哪个站点的封面」和「已有封面同步到哪个来源」放在同一页。
 *
 * 选来源只改草稿，页面先用它统计覆盖率、待同步数和样张；点应用才写入默认来源，
 * 勾选「同时同步已有封面」时顺手把 videos.pic 重写一遍。同步任务的状态存在主进程，
 * 页面切走再回来能回填进度，不会出现「按钮点不动」。
 */
function PreviewPanel({
  title,
  desc,
  onNavigate
}: {
  title: string
  desc: string
  onNavigate: (section: ConsoleSection) => void
}): React.JSX.Element {
  const { message } = App.useApp()
  /** 已保存的默认来源；空串 = 主来源优先 */
  const [savedSiteId, setSavedSiteId] = useState('')
  /** 当前正在预览 / 准备应用的来源，可能还没保存 */
  const [draftSiteId, setDraftSiteId] = useState('')
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [stats, setStats] = useState<PicCleanStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState(false)
  const [previewMode, setPreviewMode] = useState<'current' | 'next'>('next')
  const [syncOnApply, setSyncOnApply] = useState(true)
  const [starting, setStarting] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<PicCleanProgress | null>(null)
  const [lastResult, setLastResult] = useState<PicCleanOutcome | null>(null)
  const [runningSiteId, setRunningSiteId] = useState('')
  const [cleanError, setCleanError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const statsGeneration = useRef(0)

  const applyStatus = useCallback((status: PicCleanStatus): void => {
    setCleaning(status.running)
    setCancelling(status.cancelling)
    setProgress(status.progress)
    if (status.lastResult) setLastResult(status.lastResult)
    if (status.running) {
      setDraftSiteId(status.siteId)
      setRunningSiteId(status.siteId)
    } else {
      setRunningSiteId('')
    }
  }, [])

  const loadAll = useCallback(
    async (initial: boolean): Promise<void> => {
      if (initial) setLoading(true)
      else setRefreshing(true)
      setLoadError(false)
      try {
        const [settings, list, status] = await Promise.all([
          window.api.settings.get(),
          window.api.sites.list(),
          window.api.videos.picsCleanStatus().catch(() => null)
        ])
        const saved =
          settings.defaultPicSiteId && list.some((site) => site.id === settings.defaultPicSiteId)
            ? settings.defaultPicSiteId
            : ''
        setSites(list)
        setSavedSiteId(saved)
        if (status) applyStatus(status)
        // 同步进行中时停在这次任务实际使用的来源；否则保留用户正在预览的有效草稿
        setDraftSiteId((current) => {
          if (status?.running) return status.siteId
          if (current && list.some((site) => site.id === current)) return current
          return saved
        })
        setRefreshKey((value) => value + 1)
      } catch {
        setLoadError(true)
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [applyStatus]
  )

  useEffect(() => {
    // 首屏读取设置 / 站点 / 同步状态是外部数据同步，规则按调用点误报
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll(true)
  }, [loadAll])

  useEffect(() => {
    const off = window.api.videos.onPicsCleanProgress((next) => {
      setCleaning(true)
      setProgress(next)
    })
    return off
  }, [])

  const loadStats = useCallback(async (targetSiteId: string): Promise<void> => {
    const generation = ++statsGeneration.current
    setStatsLoading(true)
    setStatsError(false)
    try {
      const next = await window.api.videos.picsStats({ siteId: targetSiteId })
      if (generation !== statsGeneration.current) return
      if (!next.ok) {
        setStats(null)
        setStatsError(true)
        return
      }
      setStats(next)
    } catch {
      if (generation === statsGeneration.current) {
        setStats(null)
        setStatsError(true)
      }
    } finally {
      if (generation === statsGeneration.current) setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (loading || loadError) return
    // 统计是 IPC 读取的外部数据，setState 发生在 await 之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStats(draftSiteId)
  }, [loading, loadError, draftSiteId, refreshKey, loadStats])

  const siteLabel = useCallback(
    (siteId: string): string => {
      if (!siteId) return '主来源优先'
      const site = sites.find((item) => item.id === siteId)
      return site ? site.display || site.name : '已失效的站点'
    },
    [sites]
  )

  /** 选来源只改草稿：先把旧来源的统计清掉，避免用上一个站点的样张冒充 */
  const chooseDraft = (siteId: string): void => {
    if (cleaning || starting) return
    setPreviewMode('next')
    if (siteId === draftSiteId) {
      // 统计失败或还没回来时再点一次当前项，等于重试
      if (!stats || statsError) setRefreshKey((value) => value + 1)
      return
    }
    setDraftSiteId(siteId)
    setStats(null)
    setStatsLoading(true)
    setStatsError(false)
  }

  const savedLabel = siteLabel(savedSiteId)
  const draftLabel = siteLabel(draftSiteId)
  const sourceChanged = draftSiteId !== savedSiteId
  const stale = stats?.stale ?? 0
  const covered = draftSiteId
    ? (stats?.covered ?? 0)
    : Math.max(0, (stats?.total ?? 0) - (stats?.empty ?? 0))
  const coveredPercent = stats && stats.total > 0 ? Math.round((covered / stats.total) * 100) : 0
  const statReady = Boolean(stats) && !statsLoading && !statsError
  const willSync = statReady && syncOnApply && stale > 0
  const canApply = !cleaning && !starting && (sourceChanged || willSync)

  const applyLabel = sourceChanged
    ? willSync
      ? '切换并同步'
      : '切换默认来源'
    : willSync
      ? '同步封面'
      : statReady
        ? '已是最新'
        : statsError
          ? '无法同步'
          : '统计中…'

  const startClean = async (target: string, total: number): Promise<void> => {
    setCleanError('')
    setStarting(true)
    setCleaning(true)
    setCancelling(false)
    setProgress({
      processed: 0,
      total,
      changed: 0,
      skipped: 0,
      percent: 0
    })
    let keepRunning = false
    try {
      const result = await window.api.videos.cleanPics({ siteId: target })
      if (!result.ok) {
        if (result.error === 'ALREADY_RUNNING') {
          const status = await window.api.videos.picsCleanStatus().catch(() => null)
          if (status) {
            applyStatus(status)
            keepRunning = status.running
          }
          message.info('已有同步任务在运行，进度会显示在这里')
        } else {
          setCleanError(
            result.error === 'CACHE_UNAVAILABLE'
              ? '视频缓存不可用，无法同步'
              : '同步失败，请稍后重试'
          )
          message.error('同步封面失败')
        }
        return
      }
      if (result.cancelled) {
        message.info(`已停止同步，已改写 ${formatCount(result.changed)} 部`)
      } else {
        message.success(`已同步 ${formatCount(result.changed)} 部视频的封面`)
      }
      const status = await window.api.videos.picsCleanStatus().catch(() => null)
      if (status) applyStatus(status)
      setRefreshKey((value) => value + 1)
    } catch {
      setCleanError('同步失败，请稍后重试')
      message.error('同步封面失败')
    } finally {
      setStarting(false)
      if (!keepRunning) {
        setCleaning(false)
        setCancelling(false)
        setProgress(null)
      }
    }
  }

  const applySwitch = async (): Promise<void> => {
    if (!canApply) return
    const target = draftSiteId
    const total = stats?.total ?? 0
    const needSync = willSync
    setStarting(true)
    try {
      if (sourceChanged) {
        const settings = await window.api.settings.setDefaultPicSite(target)
        if (settings.defaultPicSiteId !== target) {
          setSavedSiteId(settings.defaultPicSiteId)
          setDraftSiteId(settings.defaultPicSiteId)
          message.warning('该站点已失效，已回落到主来源')
          return
        }
        setSavedSiteId(settings.defaultPicSiteId)
        setDraftSiteId(settings.defaultPicSiteId)
      }
      if (needSync) {
        setStarting(false)
        await startClean(target, total)
        return
      }
      message.success(
        target
          ? `默认封面来源已切换为「${siteLabel(target)}」，之后采集生效`
          : '已恢复主来源优先，之后采集生效'
      )
      setRefreshKey((value) => value + 1)
    } catch {
      message.error('切换封面来源失败')
    } finally {
      setStarting(false)
    }
  }

  const cancelClean = async (): Promise<void> => {
    if (cancelling) return
    setCancelling(true)
    try {
      await window.api.videos.cancelPicsClean()
    } catch {
      message.error('取消同步失败')
      setCancelling(false)
    }
  }

  const statsErrorLine = statsError ? (
    <div className="cover-error" role="alert">
      <span>读取封面统计失败。</span>
      <Button size="small" onClick={() => setRefreshKey((value) => value + 1)}>
        重试
      </Button>
    </div>
  ) : null

  const percent = progress?.percent ?? 0
  const hasTotal = (progress?.total ?? 0) > 0
  const runningLabel = siteLabel(runningSiteId || draftSiteId)
  const samples = stats?.samples ?? []

  const statTiles = useMemo(
    () => [
      {
        label: draftSiteId ? '本站覆盖' : '可取得封面',
        value: stats ? covered : null,
        hint: draftSiteId ? `${coveredPercent}%` : '按主来源'
      },
      {
        label: '待同步',
        value: stats ? stale : null,
        hint: stale > 0 ? '会改写' : '已一致'
      },
      {
        label: '无封面',
        value: stats ? stats.empty : null,
        hint: '首字占位'
      },
      {
        label: '人工封面',
        value: stats ? stats.manual : null,
        hint: '同步不改'
      }
    ],
    [covered, coveredPercent, draftSiteId, stale, stats]
  )

  const applyDescription = willSync
    ? `将把 ${formatCount(stale)} 部视频的封面按「${draftLabel}」的规则重写；${
        stats?.manual ? `${formatCount(stats.manual)} 部人工封面不变。` : '人工封面不变。'
      }`
    : `之后采集的视频会优先取「${draftLabel}」的封面；已有封面保持不变。`

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          {cleaning && <span className="sites-count">同步中…</span>}
        </p>
        <div className="settings-panel-actions">
          <Button
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={() => void loadAll(false)}
          >
            刷新
          </Button>
          <Button icon={<VideoCameraOutlined />} onClick={() => onNavigate('videos')}>
            去视频库
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在读取封面配置…</span>
        </div>
      ) : loadError ? (
        <div className="sites-placeholder">
          <span className="sites-empty-title">读取封面配置失败</span>
          <span className="sites-empty-hint">检查数据库是否可用，或重新读取一次</span>
          <Button size="small" onClick={() => void loadAll(true)}>
            重试
          </Button>
        </div>
      ) : sites.length === 0 ? (
        <section className="overview-onboard">
          <div className="overview-onboard-head">
            <h3 className="overview-onboard-title">还没有接入采集站点</h3>
            <p className="overview-onboard-desc">
              添加站点并采集视频后，才能在这里选择默认封面来源、预览效果并同步已有封面。
            </p>
          </div>
          <Button type="primary" onClick={() => onNavigate('sites')}>
            去添加站点
          </Button>
        </section>
      ) : (
        <>
          <div className="cover-stats" aria-label="封面统计">
            {statTiles.map((item) => (
              <div className="cover-stat" key={item.label}>
                <span className="cover-stat-label">{item.label}</span>
                <strong className="cover-stat-value">
                  {statsLoading || item.value === null ? '—' : formatCount(item.value)}
                </strong>
                <span className="cover-stat-hint">{statsLoading ? '统计中' : item.hint}</span>
              </div>
            ))}
          </div>

          {statsErrorLine}

          <section className="cover-block">
            <header className="cover-block-head">
              <div className="cover-block-heading">
                <h3 className="cover-block-title">采集时用哪个站点的封面</h3>
                <p className="cover-block-sub">
                  写入和更新 videos.pic
                  时优先取这个站点的封面；站点没有该视频或封面为空时回落主来源。
                </p>
              </div>
            </header>
            <div className="cover-block-body">
              <div className="cover-source-list" role="radiogroup" aria-label="默认封面来源">
                <button
                  type="button"
                  role="radio"
                  aria-checked={draftSiteId === ''}
                  className={`cover-source${draftSiteId === '' ? ' is-active' : ''}`}
                  disabled={cleaning || starting}
                  onClick={() => chooseDraft('')}
                >
                  <span className="cover-source-name">
                    主来源优先
                    {draftSiteId === '' && <CheckOutlined className="cover-source-check" />}
                  </span>
                  <span className="cover-source-meta">不指定站点，按每条视频的主来源取图</span>
                </button>

                {sites.map((site) => {
                  const siteCovered =
                    stats?.sites.find((item) => item.siteId === site.id)?.covered ?? 0
                  const percent =
                    stats && stats.total > 0 ? Math.round((siteCovered / stats.total) * 100) : 0
                  const unknown = statsLoading || !stats || statsError
                  const noCover = !unknown && siteCovered === 0
                  const active = draftSiteId === site.id
                  const disabled = cleaning || starting
                  return (
                    <Tooltip
                      key={site.id}
                      title={
                        noCover
                          ? '该站点还没有带封面的视频；选它时当前视频会回落到主来源'
                          : undefined
                      }
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`cover-source${active ? ' is-active' : ''}${
                          noCover ? ' is-empty' : ''
                        }`}
                        disabled={disabled}
                        onClick={() => {
                          if (disabled) return
                          chooseDraft(site.id)
                        }}
                      >
                        <span className="cover-source-name">
                          {site.display || site.name}
                          {active && <CheckOutlined className="cover-source-check" />}
                        </span>
                        <span className="cover-source-meta">
                          {unknown
                            ? '统计中…'
                            : noCover
                              ? '暂无封面数据'
                              : `覆盖 ${formatCount(siteCovered)} 部 · ${percent}%`}
                        </span>
                      </button>
                    </Tooltip>
                  )
                })}
              </div>
              <p className="cover-source-hint">
                {cleaning
                  ? `正在同步「${runningLabel}」的封面，来源暂时锁定。`
                  : statsError
                    ? '读取统计失败，暂时不能应用切换；先重试统计。'
                    : statsLoading || !stats
                      ? '正在统计这个来源的覆盖情况…'
                      : sourceChanged
                        ? `预览的是「${draftLabel}」，当前保存的仍是「${savedLabel}」；点下方按钮应用。`
                        : `当前默认来源：${savedLabel}。${
                            stale > 0
                              ? `已有 ${formatCount(stale)} 部视频的封面待同步。`
                              : '已有封面已全部符合规则。'
                          }`}
              </p>
            </div>
          </section>

          <section className="cover-block">
            <header className="cover-block-head">
              <div className="cover-block-heading">
                <h3 className="cover-block-title">效果预览</h3>
                <p className="cover-block-sub">
                  从视频库里抽样 8 部，切换「当前封面 / 新规则」看会变成什么样。
                </p>
              </div>
              <div className="cover-block-actions">
                <Segmented
                  size="small"
                  value={previewMode}
                  onChange={(value) => setPreviewMode(value as 'current' | 'next')}
                  options={[
                    { label: '当前封面', value: 'current' },
                    { label: '新规则', value: 'next' }
                  ]}
                />
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={statsLoading}
                  onClick={() => setRefreshKey((value) => value + 1)}
                >
                  换一批
                </Button>
              </div>
            </header>
            <div className="cover-block-body">
              {statsLoading && !stats ? (
                <div className="cover-loading">
                  <Spin size="small" />
                  <span>正在生成预览…</span>
                </div>
              ) : samples.length === 0 ? (
                <div className="cover-loading cover-loading--empty">
                  <PictureOutlined />
                  <span>
                    {statsError
                      ? '统计失败，暂时没有可预览的封面。'
                      : stats && stats.total === 0
                        ? '视频库还是空的，采集之后再来预览。'
                        : '没有可预览的视频。'}
                  </span>
                </div>
              ) : (
                <div className="cover-preview-grid">
                  {samples.map((sample) => {
                    const pic = previewMode === 'next' ? sample.nextPic : sample.currentPic
                    const badge = !sample.nextPic ? '无封面' : sample.changed ? '会变' : '不变'
                    return (
                      <figure className="cover-preview-card" key={sample.videoId}>
                        <div className="cover-preview-frame">
                          <span className="cover-preview-letter" aria-hidden="true">
                            {sample.name.trim().slice(0, 1) || '映'}
                          </span>
                          {pic && (
                            <FallbackImage
                              src={pic}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              referrerPolicy="no-referrer"
                            />
                          )}
                          <span
                            className={`cover-preview-badge${
                              badge === '会变'
                                ? ' is-changed'
                                : badge === '无封面'
                                  ? ' is-empty'
                                  : ''
                            }`}
                          >
                            {badge}
                          </span>
                        </div>
                        <figcaption className="cover-preview-name" title={sample.name}>
                          {sample.name}
                        </figcaption>
                      </figure>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="cover-block">
            <header className="cover-block-head">
              <div className="cover-block-heading">
                <h3 className="cover-block-title">同步已有封面</h3>
                <p className="cover-block-sub">
                  按「{draftLabel}」重写已有 videos.pic；只改封面，不动其它字段。
                </p>
              </div>
              {lastResult && !cleaning && (
                <span className="cover-block-meta">
                  上次 {formatShortDateTime(lastResult.finishedAt)}
                </span>
              )}
            </header>
            <div className="cover-block-body">
              {cleaning ? (
                <div className="cover-progress">
                  <div className="cover-progress-head">
                    <strong>正在同步「{runningLabel}」</strong>
                    <span>{hasTotal ? `${percent}%` : '准备中'}</span>
                  </div>
                  <Progress percent={hasTotal ? percent : 0} showInfo={false} status="active" />
                  <div className="cover-progress-stats" aria-live="polite">
                    <span>
                      已处理 <strong>{progress ? formatCount(progress.processed) : '—'}</strong>
                      {hasTotal ? ` / ${formatCount(progress?.total ?? 0)}` : ''}
                    </span>
                    <span>
                      已改写 <strong>{progress ? formatCount(progress.changed) : '—'}</strong>
                    </span>
                    {(progress?.skipped ?? 0) > 0 && (
                      <span>
                        跳过人工 <strong>{formatCount(progress?.skipped ?? 0)}</strong>
                      </span>
                    )}
                  </div>
                  <div className="cover-progress-actions">
                    <Button
                      danger
                      loading={cancelling}
                      disabled={cancelling}
                      onClick={() => void cancelClean()}
                    >
                      {cancelling ? '正在停止…' : '取消同步'}
                    </Button>
                    <span>可以离开此页，进度会保留。</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="cover-sync-summary">
                    <div className="cover-sync-stat">
                      <span>会改写</span>
                      <strong>{stats ? formatCount(stale) : '—'}</strong>
                      <span>部</span>
                    </div>
                    <div className="cover-sync-stat">
                      <span>无封面</span>
                      <strong>{stats ? formatCount(stats.empty) : '—'}</strong>
                      <span>部</span>
                    </div>
                    <div className="cover-sync-stat">
                      <span>人工封面</span>
                      <strong>{stats ? formatCount(stats.manual) : '—'}</strong>
                      <span>部 · 不改显示</span>
                    </div>
                  </div>

                  <div className="cover-sync-controls">
                    <Checkbox
                      checked={syncOnApply}
                      disabled={cleaning || starting || !statReady || stale === 0}
                      onChange={(event) => setSyncOnApply(event.target.checked)}
                    >
                      同时同步已有封面
                    </Checkbox>
                    <Popconfirm
                      title={
                        sourceChanged && willSync
                          ? '切换并同步封面？'
                          : willSync
                            ? '同步已有封面？'
                            : '切换封面来源？'
                      }
                      description={applyDescription}
                      okText={willSync ? '开始同步' : '切换'}
                      cancelText="取消"
                      onConfirm={() => void applySwitch()}
                      disabled={!canApply}
                    >
                      <Button
                        type="primary"
                        icon={<SyncOutlined />}
                        loading={starting}
                        disabled={!canApply}
                      >
                        {applyLabel}
                      </Button>
                    </Popconfirm>
                    <span className="cover-sync-hint">
                      取消勾选则只改默认来源，已有封面保持不动；同步通常几秒，可随时取消。
                    </span>
                  </div>

                  {cleanError && (
                    <div className="cover-error" role="alert">
                      <span>{cleanError}</span>
                      <Button size="small" onClick={() => setCleanError('')}>
                        知道了
                      </Button>
                    </div>
                  )}

                  {lastResult && (
                    <div className={`cover-last${lastResult.cancelled ? ' is-cancelled' : ''}`}>
                      {lastResult.cancelled ? <InfoCircleOutlined /> : <CheckCircleOutlined />}
                      <span>
                        {lastResult.cancelled ? '上次同步已取消' : '上次同步完成'}：
                        {formatShortDateTime(lastResult.finishedAt)} ·{' '}
                        {siteLabel(lastResult.siteId)} · 改写 {formatCount(lastResult.changed)} 部
                        {lastResult.skipped > 0
                          ? ` · 跳过人工 ${formatCount(lastResult.skipped)} 部`
                          : ''}
                        {` · 用时 ${formatDuration(lastResult.durationMs)}`}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          <div className="cover-note">
            <InfoCircleOutlined />
            <span>
              人工换过的封面始终优先，同步不会改它的显示；展示端加载失败时会按来源逐个重试，
              全部失败才显示片名首字。
            </span>
          </div>
        </>
      )}
    </>
  )
}

export default PreviewPanel
