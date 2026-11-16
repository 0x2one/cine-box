import { useEffect, useState } from 'react'
import { App, Button, Progress } from 'antd'
import {
  ArrowLeftOutlined,
  CloudDownloadOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import logoUrl from '../assets/logo.svg'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function describeUpdaterError(raw?: string): string {
  if (!raw) return '未知错误'
  if (/no published versions on github/i.test(raw)) return 'GitHub 上还没有发布版本'
  if (/404|cannot find latest|not found/i.test(raw)) return '未找到更新信息，可能还没有发布版本'
  if (/etimedout|enotfound|econnrefused|socket hang up|network|net::/i.test(raw)) {
    return '网络连接失败，请稍后重试'
  }
  return raw
}

function UpdateSection({ canUpdate }: { canUpdate: boolean | null }): React.JSX.Element {
  const { message } = App.useApp()
  const [status, setStatus] = useState<UpdaterStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.updater.getStatus().then((value) => {
      if (alive) setStatus(value)
    })
    const off = window.api.updater.onStatus((value) => setStatus(value))
    return () => {
      alive = false
      off()
    }
  }, [])

  const state = status?.state ?? 'idle'
  const version = status?.version ? `v${status.version}` : ''
  const disabled = canUpdate === false

  const check = (): void => {
    if (disabled) return
    setChecking(true)
    void window.api.updater
      .check()
      .then((value) => {
        setStatus(value)
        if (value.state === 'error') {
          message.error(`检查更新失败：${describeUpdaterError(value.error)}`)
        }
      })
      .finally(() => setChecking(false))
  }

  let hint: React.ReactNode
  let action: React.ReactNode

  if (disabled) {
    hint = '开发模式下不检查更新，打包安装后生效'
    action = (
      <Button icon={<SyncOutlined />} disabled>
        检查更新
      </Button>
    )
  } else {
    switch (state) {
      case 'checking':
        hint = '正在检查更新…'
        action = (
          <Button type="primary" loading icon={<SyncOutlined />}>
            检查更新
          </Button>
        )
        break
      case 'available':
        hint = `发现新版本 ${version}，可以立即下载`
        action = (
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => void window.api.updater.download().then(setStatus)}
          >
            下载更新
          </Button>
        )
        break
      case 'downloading':
        hint = `正在下载 ${version}`
        action = (
          <Button disabled loading icon={<CloudDownloadOutlined />}>
            下载中
          </Button>
        )
        break
      case 'downloaded':
        hint = `新版本 ${version} 已下载，重启后完成安装（退出应用时也会自动安装）`
        action = (
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => void window.api.updater.install()}
          >
            重启并安装
          </Button>
        )
        break
      case 'not-available':
        hint = '当前已是最新版本'
        action = (
          <Button icon={<ReloadOutlined />} loading={checking} onClick={check}>
            重新检查
          </Button>
        )
        break
      case 'error':
        hint = `检查更新失败：${describeUpdaterError(status?.error)}`
        action = (
          <Button icon={<ReloadOutlined />} loading={checking} onClick={check}>
            重试
          </Button>
        )
        break
      default:
        hint = '自动检查更新，也可以手动检查'
        action = (
          <Button type="primary" icon={<SyncOutlined />} loading={checking} onClick={check}>
            检查更新
          </Button>
        )
    }
  }

  return (
    <>
      <div className="settings-row settings-row--update">
        <div className="settings-row-text">
          <span className="settings-row-title">软件更新</span>
          <span className="settings-row-desc">{hint}</span>
        </div>
        <div className="settings-row-control">{action}</div>
      </div>
      {state === 'available' && status?.releaseNotes && (
        <pre className="update-notes">{status.releaseNotes}</pre>
      )}
      {state === 'downloading' && (
        <div className="update-progress">
          <Progress
            percent={Math.round(status?.progress?.percent ?? 0)}
            size="small"
            status="active"
            showInfo={false}
          />
          <span className="settings-row-desc">
            {Math.round(status?.progress?.percent ?? 0)}% ·{' '}
            {formatBytes(status?.progress?.bytesPerSecond ?? 0)}/s
          </span>
        </div>
      )}
    </>
  )
}

/** 应用介绍：关于面板与关于页共用同一段文案 */
const APP_INTRO =
  '映盒剧场是一款轻量的桌面影音应用，界面固定为简体中文。无边框窗口配自绘操作栏，常驻系统托盘并支持全局快捷键唤起，可切换浅色 / 深色主题与主题色，内置应用内更新。影音内容界面仍在建设中。'

/** 关于面板：设置页的「关于」分区与独立关于页共用 */
export function AboutPanel(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.app.info().then((value) => {
      if (alive) setInfo(value)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="about-card">
      <div className="about-head">
        <img className="about-logo" src={logoUrl} alt="" />
        <div>
          <div className="about-name">映盒剧场</div>
          <div className="about-version">版本 v{info?.version ?? '—'}</div>
        </div>
      </div>
      <p className="about-intro">{APP_INTRO}</p>
      <div className="about-tags">
        <span>托盘常驻</span>
        <span>全局快捷键</span>
        <span>深浅主题</span>
        <span>应用内更新</span>
      </div>
      <div className="about-divider" />
      <UpdateSection canUpdate={info?.canUpdate ?? null} />
    </section>
  )
}

function AboutPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <div className="page-inner">
      <button type="button" className="page-back" onClick={onBack}>
        <ArrowLeftOutlined />
        <span>返回</span>
      </button>
      <h1 className="page-title">关于</h1>
      <p className="page-subtitle">应用介绍与软件更新</p>
      <div className="about-page-body">
        <AboutPanel />
      </div>
    </div>
  )
}

export default AboutPage
