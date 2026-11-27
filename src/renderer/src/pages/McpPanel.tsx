import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Input, InputNumber, Select, Spin, Switch } from 'antd'
import { CopyOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import '../assets/mcp.css'

const MCP_ERRORS: Record<string, string> = {
  INVALID_INPUT: '配置格式不正确',
  INVALID_HOST: '监听地址不可用，请选择本机地址或 0.0.0.0',
  INVALID_PORT: '端口需要是 1024–65535 之间的整数',
  TOKEN_REQUIRED: '监听局域网地址前，请先设置访问令牌',
  PORT_IN_USE: '这个端口已被占用，换一个再试',
  ADDRESS_UNAVAILABLE: '这个 IP 当前不在线，请刷新地址列表后重新选择',
  PERMISSION: '没有权限监听这个端口，请换一个 1024 以上的端口',
  START_FAILED: 'MCP 服务启动失败，请稍后再试'
}

const DEFAULT_MCP_PORT = 3927

/** 复制文本：优先 async clipboard，被拒时退回选区 + execCommand */
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

/** 与主进程 mcpUrls 同一套口径：0.0.0.0 时列出每个本机 IPv4 */
function previewUrls(host: string, port: number, addresses: LanAddress[]): string[] {
  if (host !== '0.0.0.0') return [`http://${host}:${port}/mcp`]
  const lan = addresses.filter((item) => !item.loopback)
  const chosen = lan.length > 0 ? lan : addresses.filter((item) => item.loopback)
  const list = chosen.map((item) => `http://${item.address}:${port}/mcp`)
  return list.length > 0 ? list : [`http://127.0.0.1:${port}/mcp`]
}

function Row({
  title,
  description,
  children,
  stacked = false
}: {
  title: string
  description?: string
  children: React.ReactNode
  stacked?: boolean
}): React.JSX.Element {
  return (
    <div className={`settings-row${stacked ? ' settings-row--stack' : ''}`}>
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {description && <span className="settings-row-desc">{description}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** 设置 › MCP：控制服务开关、监听地址 / 端口 / 令牌，并给出客户端配置 */
function McpPanel(): React.JSX.Element {
  const { message } = App.useApp()
  const [snapshot, setSnapshot] = useState<McpSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState(DEFAULT_MCP_PORT)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')

  const applySnapshot = useCallback((next: McpSnapshot): void => {
    setSnapshot(next)
    setHost(next.settings.host)
    setPort(next.settings.port)
    setToken(next.settings.token)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.mcp.get()
      applySnapshot(next)
      setError('')
    } catch {
      setError('读取 MCP 服务状态失败')
    } finally {
      setLoading(false)
    }
  }, [applySnapshot])

  useEffect(() => {
    // load 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  useEffect(() => {
    return window.api.mcp.onChange((next) => {
      setSnapshot(next)
    })
  }, [])

  const settings = snapshot?.settings
  const state = snapshot?.state
  const addresses = useMemo<LanAddress[]>(
    () => snapshot?.state.addresses ?? [],
    [snapshot?.state.addresses]
  )
  const running = state?.running ?? false
  const statusText = running
    ? '服务运行中'
    : settings?.enabled
      ? '已开启，但服务未运行'
      : '服务未启动'
  const statusHint = running
    ? '外部 AI 客户端可以连接下面的地址'
    : settings?.enabled
      ? '检查监听地址 / 端口，或查看下方错误'
      : '打开开关后即可被 AI 客户端连接'

  const dirty = Boolean(
    snapshot &&
    (host !== snapshot.settings.host ||
      port !== snapshot.settings.port ||
      token !== snapshot.settings.token)
  )

  const urls = useMemo(() => previewUrls(host, port, addresses), [host, port, addresses])
  const primaryUrl = urls[0] ?? ''
  const savedUrls = useMemo(
    () => (snapshot ? previewUrls(snapshot.settings.host, snapshot.settings.port, addresses) : []),
    [snapshot, addresses]
  )
  const savedEndpoint = savedUrls[0] ?? ''
  const savedToken = snapshot?.settings.token ?? ''

  const hostOptions = useMemo(() => {
    const options = [
      { value: '127.0.0.1', label: '127.0.0.1 · 仅本机（推荐）' },
      { value: '0.0.0.0', label: '0.0.0.0 · 全部网卡' },
      ...addresses
        .filter((item) => item.address !== '127.0.0.1')
        .map((item) => ({
          value: item.address,
          label: `${item.address} · ${item.name}${item.loopback ? '（仅本机）' : ''}`
        }))
    ]
    if (host && !options.some((item) => item.value === host)) {
      options.push({ value: host, label: `${host}（当前不可用）` })
    }
    return options
  }, [addresses, host])

  const errorText = error || (state?.error ? MCP_ERRORS[state.error] : '')

  const toggle = async (enabled: boolean): Promise<void> => {
    setSwitching(true)
    setError('')
    try {
      const result = await window.api.mcp.set({ enabled })
      setSnapshot({ settings: result.settings, state: result.state })
      if (!result.ok) {
        setError(MCP_ERRORS[result.error ?? ''] ?? result.message ?? '保存失败')
        return
      }
      message.success(enabled ? 'MCP 服务已开启' : 'MCP 服务已关闭')
    } catch {
      setError('保存失败，请重试')
    } finally {
      setSwitching(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const result = await window.api.mcp.set({ host, port, token })
      setSnapshot({ settings: result.settings, state: result.state })
      if (!result.ok) {
        setError(MCP_ERRORS[result.error ?? ''] ?? result.message ?? '保存失败')
        return
      }
      setHost(result.settings.host)
      setPort(result.settings.port)
      setToken(result.settings.token)
      message.success(result.state.running ? '监听设置已保存并生效' : '监听设置已保存')
    } catch {
      setError('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const generateToken = (): void => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    setToken(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''))
  }

  const copyEndpoint = async (): Promise<void> => {
    if (!primaryUrl) return
    if (await copyText(primaryUrl)) message.success('访问地址已复制')
    else message.error('复制失败，请手动选择地址')
  }

  const copyToken = async (): Promise<void> => {
    if (!token) return
    if (await copyText(token)) message.success('访问令牌已复制')
    else message.error('复制失败，请手动选择令牌')
  }

  const clientConfig = useMemo(() => {
    const entry: Record<string, unknown> = { url: savedEndpoint || primaryUrl }
    if (savedToken) entry.headers = { Authorization: `Bearer ${savedToken}` }
    return JSON.stringify({ mcpServers: { 'cine-box': entry } }, null, 2)
  }, [savedEndpoint, savedToken, primaryUrl])

  const copyConfig = async (): Promise<void> => {
    if (await copyText(clientConfig)) message.success('客户端配置已复制')
    else message.error('复制失败，请手动选择配置')
  }

  const copyTokenUrl = async (): Promise<void> => {
    const url = savedToken
      ? `${savedEndpoint || primaryUrl}?token=${encodeURIComponent(savedToken)}`
      : savedEndpoint || primaryUrl
    if (await copyText(url)) message.success('带令牌地址已复制')
    else message.error('复制失败，请手动选择地址')
  }

  if (loading && !snapshot) {
    return (
      <section className="settings-card">
        <div className="mcp-loading">
          <Spin />
        </div>
      </section>
    )
  }

  return (
    <>
      <section className="settings-card mcp-hero">
        <Row
          title="MCP 服务"
          description="让 Claude、Cursor 等 AI 客户端连接本机，直接管理站点、采集、推荐与下载。"
        >
          <Switch
            checked={settings?.enabled ?? false}
            loading={switching}
            disabled={loading || saving}
            onChange={(value) => void toggle(value)}
          />
        </Row>

        <div className="mcp-status-row">
          <span className={`mcp-dot${running ? ' is-on' : ''}`} aria-hidden="true" />
          <strong>{statusText}</strong>
          <span className="mcp-status-sub">{statusHint}</span>
        </div>

        <div className="mcp-endpoint-row">
          <span className="mcp-endpoint-label">访问地址</span>
          <code className="mcp-endpoint">{primaryUrl || '—'}</code>
          <Button
            size="small"
            icon={<CopyOutlined />}
            disabled={!primaryUrl}
            onClick={() => void copyEndpoint()}
          >
            复制
          </Button>
        </div>
        {urls.length > 1 && (
          <p className="mcp-alt-urls">其它可用地址：{urls.slice(1).join('、')}</p>
        )}

        {errorText && <Alert className="mcp-alert" type="error" showIcon message={errorText} />}
        <p className="settings-note">
          MCP
          客户端可以修改和删除本机数据。默认只监听本机回环地址；监听局域网前请设置访问令牌，并只在可信网络开启。
        </p>
      </section>

      <section className="settings-card">
        <Row stacked title="监听与访问" description="保存后立即应用；改地址或端口会重启 MCP 服务。">
          <div className="mcp-form">
            <label className="mcp-field">
              <span>监听地址</span>
              <Select
                value={host}
                onChange={(value) => setHost(value)}
                options={hostOptions}
                disabled={saving || switching}
                popupMatchSelectWidth={false}
              />
              <small>「全部网卡」会监听所有 IPv4 地址；局域网监听必须设置访问令牌。</small>
            </label>
            <label className="mcp-field">
              <span>端口</span>
              <InputNumber
                value={port}
                min={1024}
                max={65535}
                precision={0}
                disabled={saving || switching}
                onChange={(value) => setPort(Number(value) || DEFAULT_MCP_PORT)}
              />
              <small>范围 1024–65535；被占用时换一个。</small>
            </label>
            <label className="mcp-field mcp-field--wide">
              <span>访问令牌</span>
              <div className="mcp-token-line">
                <Input.Password
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="回环监听可留空；局域网监听必填"
                  disabled={saving || switching}
                />
                <Button onClick={generateToken} disabled={saving || switching}>
                  生成令牌
                </Button>
                <Button
                  icon={<CopyOutlined />}
                  disabled={!token || saving || switching}
                  onClick={() => void copyToken()}
                >
                  复制
                </Button>
              </div>
              <small>
                令牌会随 `Authorization: Bearer ...` 或 `?token=` 传入；留空表示回环监听不鉴权。
              </small>
            </label>
            <div className="mcp-form-actions">
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                disabled={!dirty || switching}
                onClick={() => void save()}
              >
                保存并应用
              </Button>
              <Button
                icon={<ReloadOutlined />}
                disabled={saving || switching}
                onClick={() => void load()}
              >
                刷新
              </Button>
              {dirty && <span className="mcp-dirty">有未保存的修改</span>}
            </div>
          </div>
        </Row>
      </section>

      <section className="settings-card">
        <Row
          stacked
          title="客户端接入"
          description="把下面的 JSON 粘贴到客户端的 MCP 配置里；先保存设置，配置里才是最新地址与令牌。"
        >
          <div className="mcp-code-wrap">
            <pre className="mcp-code">{clientConfig}</pre>
            <div className="mcp-form-actions">
              <Button icon={<CopyOutlined />} onClick={() => void copyConfig()}>
                复制配置
              </Button>
              <Button onClick={() => void copyTokenUrl()}>复制带令牌地址</Button>
            </div>
          </div>
        </Row>
        <p className="settings-note">
          协议为 MCP 2026-07-28，并兼容 2025 版客户端；不支持已废弃的 HTTP+SSE 传输。只支持 stdio
          的客户端可以通过 `mcp-remote` 转发到上面的 URL。
        </p>
      </section>
    </>
  )
}

export default McpPanel
