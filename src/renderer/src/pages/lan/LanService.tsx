import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, InputNumber, QRCode, Select, Spin } from 'antd'
import {
  AppstoreOutlined,
  CopyOutlined,
  ExportOutlined,
  MobileOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  WifiOutlined
} from '@ant-design/icons'
import './lan-service.css'

const START_ERRORS: Record<string, string> = {
  INVALID_HOST: '监听地址不可用，请重新选择',
  INVALID_PORT: '端口需要是 1024–65535 之间的整数',
  PORT_IN_USE: '这个端口已被占用，换一个再试',
  ADDRESS_UNAVAILABLE: '这个 IP 当前不在线，请刷新地址列表后重新选择',
  PERMISSION: '没有权限监听这个端口，请换一个 1024 以上的端口',
  START_FAILED: '启动失败，请稍后再试'
}

/** 复制文本：优先 async clipboard，被拒时退回选区 + execCommand（和视频页同一套） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** 控制台「局域网」：启动 / 关闭网页服务，选择监听 IP 与端口，展示扫码地址 */
function LanServicePanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [state, setState] = useState<LanServiceState | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [host, setHost] = useState('0.0.0.0')
  const [port, setPort] = useState(8090)
  const [error, setError] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.lan.state()
      setState(next)
      setHost(next.host)
      setPort(next.port)
    } catch {
      message.error('读取局域网服务状态失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    // load 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  useEffect(() => {
    return window.api.lan.onChange((next) => {
      setState(next)
      setHost(next.host)
      setPort(next.port)
    })
  }, [])

  const running = state?.running ?? false
  const primaryUrl = state?.urls[0] ?? ''
  const hasLanAddress = useMemo(
    () => (state?.addresses ?? []).some((item) => !item.loopback),
    [state]
  )

  const hostOptions = useMemo(() => {
    const options = [
      { value: '0.0.0.0', label: '全部网卡（推荐）' },
      ...(state?.addresses ?? []).map((item) => ({
        value: item.address,
        label: `${item.address} · ${item.name}${item.loopback ? '（仅本机）' : ''}`
      }))
    ]
    // 上次保存的 IP 可能已经不在线（换了网络），仍然让它显示出来，方便用户改掉
    if (state && state.host !== '0.0.0.0' && !options.some((item) => item.value === state.host)) {
      options.push({ value: state.host, label: `${state.host}（当前不可用）` })
    }
    return options
  }, [state])

  const start = async (): Promise<void> => {
    setStarting(true)
    setError('')
    try {
      const result = await window.api.lan.start({ host, port })
      setState(result.state)
      if (!result.ok) {
        setError(START_ERRORS[result.error ?? ''] ?? '启动失败，请稍后再试')
        return
      }
      message.success('局域网服务已启动')
    } catch {
      setError('启动失败，请稍后再试')
    } finally {
      setStarting(false)
    }
  }

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      const next = await window.api.lan.stop()
      setState(next)
      setError('')
      message.success('局域网服务已关闭')
    } catch {
      message.error('关闭局域网服务失败')
    } finally {
      setStopping(false)
    }
  }

  const copyUrl = async (): Promise<void> => {
    if (!primaryUrl) return
    if (await copyText(primaryUrl)) message.success('访问地址已复制')
    else message.error('复制失败，请手动选择地址')
  }

  const openBrowser = async (): Promise<void> => {
    try {
      const opened = await window.api.lan.open()
      if (!opened) message.warning('先启动服务，再用浏览器打开')
    } catch {
      message.error('打开浏览器失败')
    }
  }

  const refresh = async (): Promise<void> => {
    setLoading(true)
    await load()
  }

  if (loading && !state) {
    return (
      <>
        <div className="settings-panel-head">
          <h2 className="settings-panel-title">{title}</h2>
          <span className="settings-panel-sep">·</span>
          <p className="settings-panel-desc">{desc}</p>
        </div>
        <div className="lan-page lan-loading">
          <Spin />
        </div>
      </>
    )
  }

  return (
    <div className="lan-page">
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">{desc}</p>
        <div className="settings-panel-actions">
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      {error && <Alert className="lan-alert" type="error" showIcon message={error} />}
      {!error && state?.error && (
        <Alert
          className="lan-alert"
          type="error"
          showIcon
          message={START_ERRORS[state.error] ?? '服务启动失败，请稍后再试'}
        />
      )}
      {!hasLanAddress && (
        <Alert
          className="lan-alert"
          type="warning"
          showIcon
          message="没有检测到局域网 IP"
          description="当前只找到本机回环地址，手机无法连接。请确认电脑已经连上 Wi-Fi 或有线网络，然后点右上角「刷新」。"
        />
      )}
      {state?.host === '127.0.0.1' && (
        <Alert
          className="lan-alert"
          type="warning"
          showIcon
          message="当前只监听本机回环地址"
          description="127.0.0.1 只能在这台电脑上访问，手机扫码会连到手机自己；请把监听 IP 改成「全部网卡」或电脑的局域网 IP。"
        />
      )}

      <div className="settings-card lan-hero">
        <div className="lan-hero-main">
          <div className="lan-status">
            <span className={`lan-dot${running ? ' is-on' : ''}`} aria-hidden="true" />
            <strong>{running ? '服务运行中' : '服务未启动'}</strong>
            <span className="lan-status-sub">
              {running ? '同一局域网里的手机、平板、电脑都能访问' : '启动后即可用浏览器打开片库'}
            </span>
          </div>

          <div className="lan-url-block">
            <span className="lan-url-label">访问地址</span>
            <code className="lan-url">{primaryUrl || '—'}</code>
          </div>
          {running && (state?.urls.length ?? 0) > 1 && (
            <p className="lan-alt-urls">其它可用地址：{state?.urls.slice(1).join('、')}</p>
          )}

          <div className="lan-actions">
            {running ? (
              <Button
                type="primary"
                danger
                loading={stopping}
                icon={<WifiOutlined />}
                onClick={() => void stop()}
              >
                关闭服务
              </Button>
            ) : (
              <Button
                type="primary"
                loading={starting}
                icon={<WifiOutlined />}
                onClick={() => void start()}
              >
                启动服务
              </Button>
            )}
            <Button
              icon={<ExportOutlined />}
              disabled={!running}
              onClick={() => void openBrowser()}
            >
              浏览器打开
            </Button>
            <Button icon={<CopyOutlined />} disabled={!primaryUrl} onClick={() => void copyUrl()}>
              复制地址
            </Button>
          </div>

          <p className="lan-hint">
            {running
              ? '想换 IP / 端口？先关闭服务，再修改下方设置。服务只监听局域网，不会暴露到公网；在公共 Wi-Fi 下请注意片库隐私。'
              : '手机与电脑连同一个 Wi-Fi，扫码就能打开；没有安装 App 也可以使用。'}
          </p>
        </div>

        <div className="lan-qr">
          {running && primaryUrl ? (
            <>
              <QRCode value={primaryUrl} size={168} type="svg" bordered={false} errorLevel="M" />
              <span className="lan-qr-tip">手机扫码打开</span>
            </>
          ) : (
            <div className="lan-qr-off">
              <WifiOutlined />
              <span>启动后显示二维码</span>
            </div>
          )}
        </div>
      </div>

      <div className="settings-card">
        <div className="lan-form-head">
          <div>
            <h3>监听设置</h3>
            <p>
              {running
                ? '服务运行中，监听设置暂时锁定；关闭服务后可以修改。'
                : '启动服务时会自动保存，下次打开控制台继续使用。'}
            </p>
          </div>
        </div>
        <div className="lan-form">
          <label className="lan-field">
            <span>监听 IP</span>
            <Select
              value={host}
              onChange={(value) => setHost(value)}
              options={hostOptions}
              disabled={running}
              popupMatchSelectWidth={false}
            />
            <small>「全部网卡」会监听所有 IPv4 地址，二维码使用第一个局域网地址。</small>
          </label>
          <label className="lan-field">
            <span>端口</span>
            <InputNumber
              value={port}
              min={1024}
              max={65535}
              precision={0}
              disabled={running}
              onChange={(value) => setPort(Number(value) || 8090)}
            />
            <small>范围 1024–65535；如果提示端口被占用，换一个即可。</small>
          </label>
        </div>
        <p className="lan-note">
          手机打不开时：先确认两台设备连的是同一个
          Wi-Fi，再在系统防火墙里允许「映盒剧场」访问专用网络。
        </p>
      </div>

      <div className="settings-card lan-features">
        <div className="lan-feature">
          <MobileOutlined />
          <div>
            <strong>手机扫码即看</strong>
            <span>无需安装客户端，自适应手机与电脑屏幕</span>
          </div>
        </div>
        <div className="lan-feature">
          <SearchOutlined />
          <div>
            <strong>首页本地 / 在线检索</strong>
            <span>本地秒搜片库，在线实时问采集站点</span>
          </div>
        </div>
        <div className="lan-feature">
          <AppstoreOutlined />
          <div>
            <strong>找片看分类浏览</strong>
            <span>按一级 / 二级分类翻整库，滚到底自动加载</span>
          </div>
        </div>
        <div className="lan-feature">
          <PlayCircleOutlined />
          <div>
            <strong>点开即播</strong>
            <span>列表点开就是播放页，只留 m3u8 线路与选集；电脑缓存好的剧集同片分组，直接播</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default LanServicePanel
