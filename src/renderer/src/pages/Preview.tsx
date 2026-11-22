import { useEffect, useMemo, useState } from 'react'
import { App, Button, Popconfirm, Progress, Select, Tag } from 'antd'
import {
  CheckCircleOutlined,
  DatabaseOutlined,
  EyeOutlined,
  PictureOutlined,
  ReloadOutlined,
  RightOutlined
} from '@ant-design/icons'

/** 封面从哪来、写到哪、展示时怎么兜底——一条真实的链路，不是装饰性的步骤条 */
const FLOW_STEPS: {
  icon: typeof PictureOutlined
  title: string
  desc: string
}[] = [
  { icon: PictureOutlined, title: '选来源', desc: '采集时优先取指定站点的封面' },
  { icon: DatabaseOutlined, title: '写入视频库', desc: '写入视频封面，可按规则批量重写' },
  { icon: EyeOutlined, title: '展示兜底', desc: '封面加载失败时逐个换源重试' }
]

/**
 * 控制台「预览」：配置采集时优先用哪个站点的封面，
 * 并可一键把已有视频的封面按同一规则重写。清洗期间就地显示进度、可取消。
 */
function PreviewPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [siteId, setSiteId] = useState('')
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [progress, setProgress] = useState<PicCleanProgress | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([window.api.settings.get(), window.api.sites.list()]).then(
      ([settings, list]) => {
        if (!alive) return
        setSiteId(settings.defaultPicSiteId)
        setSites(list)
        setLoading(false)
      }
    )
    const off = window.api.videos.onPicsCleanProgress((next) => {
      if (alive) setProgress(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const currentName = useMemo(() => {
    if (!siteId) return '主来源优先'
    const site = sites.find((item) => item.id === siteId)
    return site ? site.display || site.name : '主来源优先'
  }, [siteId, sites])

  const changeSite = (value: string): void => {
    const next = value || ''
    setSiteId(next)
    setSaving(true)
    void window.api.settings
      .setDefaultPicSite(next)
      .then((settings) => {
        setSiteId(settings.defaultPicSiteId)
        message.success(
          settings.defaultPicSiteId ? '默认封面来源已更新，后续采集生效' : '已恢复默认选图规则'
        )
      })
      .finally(() => setSaving(false))
  }

  const startClean = (): void => {
    setProgress({ processed: 0, total: 0, changed: 0, percent: 0 })
    setCleaning(true)
    void window.api.videos
      .cleanPics()
      .then((result) => {
        if (!result.ok) {
          if (result.error !== 'ALREADY_RUNNING') message.error('清洗失败')
          return
        }
        if (result.cancelled) message.info('已取消清洗')
        else message.success(`清洗完成，改写 ${result.changed} 部视频的预览图`)
      })
      .catch(() => message.error('清洗失败'))
      .finally(() => {
        setCleaning(false)
        setProgress(null)
      })
  }

  return (
    <>
      <div className="settings-panel-head">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">{desc}</p>
      </div>

      <div className="preview-flow" aria-label="封面处理流程">
        {FLOW_STEPS.map((step, index) => {
          const Icon = step.icon
          return (
            <div className="preview-flow-step" key={step.title}>
              <div className="preview-flow-step-head">
                <span className="preview-flow-step-icon">
                  <Icon />
                </span>
                <span className="preview-flow-step-title">{step.title}</span>
                {index < FLOW_STEPS.length - 1 && <RightOutlined className="preview-flow-arrow" />}
              </div>
              <p className="preview-flow-step-desc">{step.desc}</p>
            </div>
          )
        })}
      </div>

      <div className="preview-grid">
        <section className="preview-card">
          <div className="preview-card-head">
            <span className="preview-card-icon">
              <PictureOutlined />
            </span>
            <div className="preview-card-heading">
              <h3 className="preview-card-title">默认封面来源</h3>
              <p className="preview-card-sub">决定新采集视频的封面优先取哪个站点</p>
            </div>
            <Tag className="preview-card-tag" bordered={false}>
              采集规则
            </Tag>
          </div>

          <div className="preview-card-body">
            <div className="preview-source-current">
              <span className="preview-source-current-label">当前生效</span>
              <strong className="preview-source-current-value">{currentName}</strong>
              <span className="preview-source-current-hint">
                {siteId ? '采集时优先取这个站点的封面' : '按视频的主来源取封面'}
              </span>
            </div>

            <label className="preview-field-label" htmlFor="preview-pic-source">
              更换来源
            </label>
            <Select
              id="preview-pic-source"
              style={{ width: '100%' }}
              loading={loading || saving}
              value={siteId}
              onChange={changeSite}
              options={[
                { value: '', label: '不指定（主来源优先）' },
                ...sites.map((site) => ({ value: site.id, label: site.display || site.name }))
              ]}
            />
            <p className="preview-field-hint">
              站点没有该视频、或封面为空时自动回落。改动立即生效，只影响之后采集的视频。
            </p>
          </div>
        </section>

        <section className="preview-card">
          <div className="preview-card-head">
            <span className="preview-card-icon">
              <ReloadOutlined />
            </span>
            <div className="preview-card-heading">
              <h3 className="preview-card-title">批量清洗</h3>
              <p className="preview-card-sub">把已有视频的封面按上面的规则重新取一遍</p>
            </div>
            <Tag className="preview-card-tag" bordered={false}>
              一次性操作
            </Tag>
          </div>

          <div className="preview-card-body">
            <p className="preview-clean-desc">
              遍历视频库，按当前默认来源重写封面。进度会显示在这里，过程中可随时取消；
              已经改写的结果不会回退。
            </p>

            {progress ? (
              <div className="preview-progress">
                <Progress percent={progress.percent} status={cleaning ? 'active' : 'normal'} />
                <div className="preview-progress-stats">
                  <div className="preview-progress-stat">
                    <span>已处理</span>
                    <strong>
                      {progress.processed} / {progress.total}
                    </strong>
                  </div>
                  <div className="preview-progress-stat">
                    <span>已改写</span>
                    <strong>{progress.changed}</strong>
                  </div>
                </div>
                <Button danger onClick={() => void window.api.videos.cancelPicsClean()}>
                  取消清洗
                </Button>
              </div>
            ) : (
              <div className="preview-clean-action">
                <Popconfirm
                  title="清洗现有视频的预览图"
                  description="按当前默认封面来源重写已有封面，过程中可取消"
                  okText="开始清洗"
                  cancelText="取消"
                  onConfirm={startClean}
                >
                  <Button type="primary" icon={<ReloadOutlined />}>
                    开始清洗
                  </Button>
                </Popconfirm>
                <span className="preview-clean-hint">大批量视频可能需要几分钟</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="preview-note">
        <CheckCircleOutlined />
        <span>
          人工换过的封面始终优先，清洗不会覆盖；展示页封面加载失败时会自动尝试其他来源。
        </span>
      </div>
    </>
  )
}

export default PreviewPanel
