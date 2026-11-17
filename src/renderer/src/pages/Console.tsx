import { useState } from 'react'
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  DashboardOutlined,
  FileTextOutlined,
  GlobalOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import CategoriesPanel from './Categories'
import SitesPanel from './Sites'

type ConsoleSection = 'overview' | 'sites' | 'categories' | 'tasks' | 'logs'

const NAV_ITEMS: { key: ConsoleSection; label: string; icon: typeof DashboardOutlined }[] = [
  { key: 'overview', label: '概览', icon: DashboardOutlined },
  { key: 'sites', label: '站点', icon: GlobalOutlined },
  { key: 'categories', label: '分类', icon: ApartmentOutlined },
  { key: 'tasks', label: '任务', icon: UnorderedListOutlined },
  { key: 'logs', label: '日志', icon: FileTextOutlined }
]

const SECTION_META: Record<ConsoleSection, { title: string; desc: string; empty?: string }> = {
  overview: { title: '概览', desc: '运行状态与统计', empty: '暂无数据' },
  sites: { title: '站点', desc: '管理采集站点' },
  categories: { title: '视频分类', desc: '层级管理本地分类' },
  tasks: { title: '任务', desc: '任务列表与执行进度', empty: '暂无任务' },
  logs: { title: '日志', desc: '运行日志', empty: '暂无日志' }
}

/**
 * 控制台：返回收进左侧导航，分区标题与说明合并成吸顶行。
 * 站点与视频分类分区已接入真实数据，其余分区先用空状态占位。
 */
function Console({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [section, setSection] = useState<ConsoleSection>('overview')
  /** 从站点分类弹窗点「绑定」带过来的上下文，非空时分类页进入左右两栏映射模式 */
  const [bindingSite, setBindingSite] = useState<{ id: string; name: string } | null>(null)
  const meta = SECTION_META[section]

  const goSection = (next: ConsoleSection): void => {
    setSection(next)
    // 离开分类页就退出映射模式，避免回来时还挂着一半的状态
    if (next !== 'categories') setBindingSite(null)
  }

  return (
    <div className="page-inner page-inner--rail">
      {/* 视觉上不再显示页面大标题，保留给屏幕阅读器 */}
      <h1 className="visually-hidden">控制台</h1>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="控制台菜单">
          <button type="button" className="settings-back" onClick={onBack}>
            <ArrowLeftOutlined />
            <span>返回</span>
          </button>
          <div className="settings-nav-divider" />

          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = item.key === section
            return (
              <button
                key={item.key}
                type="button"
                className={`settings-nav-item${active ? ' is-active' : ''}`}
                onClick={() => goSection(item.key)}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="settings-panel">
          {/* 站点与分类分区自己渲染吸顶行（标题 / 说明 / 计数 / 新增按钮），其余分区用通用标题行 */}
          {section === 'sites' ? (
            <SitesPanel
              title={meta.title}
              desc={meta.desc}
              onStartBinding={(site) => {
                setBindingSite(site)
                setSection('categories')
              }}
            />
          ) : section === 'categories' ? (
            <CategoriesPanel
              title={meta.title}
              desc={meta.desc}
              bindingSite={bindingSite}
              onExitBinding={() => setBindingSite(null)}
            />
          ) : (
            <>
              <div className="settings-panel-head">
                <h2 className="settings-panel-title">{meta.title}</h2>
                <span className="settings-panel-sep">·</span>
                <p className="settings-panel-desc">{meta.desc}</p>
              </div>
              <section className="settings-card">
                <div className="console-empty">
                  <span className="console-empty-title">{meta.empty}</span>
                  <span className="console-empty-hint">控制台功能正在搭建，敬请期待</span>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default Console
