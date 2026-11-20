import { useState } from 'react'
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  BarChartOutlined,
  CloudDownloadOutlined,
  CompassOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  GlobalOutlined,
  SaveOutlined,
  VideoCameraOutlined
} from '@ant-design/icons'
import BackupPanel from './Backup'
import CapacityPanel from './Capacity'
import CategoriesPanel from './Categories'
import CollectPanel from './Collect'
import HomeSettingsPanel from './HomeSettings'
import LogsPanel from './Logs'
import OverviewPanel from './Overview'
import ProgressPanel from './Progress'
import SitesPanel from './Sites'
import VideosPanel from './Videos'
import type { ConsoleSection } from '../types'

const NAV_ITEMS: { key: ConsoleSection; label: string; icon: typeof DashboardOutlined }[] = [
  { key: 'overview', label: '概览', icon: DashboardOutlined },
  { key: 'home', label: '推荐', icon: CompassOutlined },
  { key: 'sites', label: '站点', icon: GlobalOutlined },
  { key: 'categories', label: '分类', icon: ApartmentOutlined },
  { key: 'collect', label: '采集', icon: CloudDownloadOutlined },
  { key: 'progress', label: '进度', icon: BarChartOutlined },
  { key: 'videos', label: '视频', icon: VideoCameraOutlined },
  { key: 'capacity', label: '容量', icon: DatabaseOutlined },
  { key: 'backup', label: '备份', icon: SaveOutlined },
  { key: 'logs', label: '日志', icon: FileTextOutlined }
]

const SECTION_META: Record<ConsoleSection, { title: string; desc: string }> = {
  overview: { title: '概览', desc: '运行状态与统计' },
  home: { title: '推荐', desc: '海报叠层、分类推荐与搜索推荐' },
  sites: { title: '站点', desc: '管理采集站点' },
  categories: { title: '视频分类', desc: '层级管理本地分类' },
  collect: { title: '采集', desc: '手动采集与定时计划' },
  progress: { title: '进度', desc: '按站点查看采集进度与计数' },
  videos: { title: '视频', desc: '已采集视频与详情' },
  capacity: { title: '容量', desc: '查看并清理缓存索引与详情文件' },
  backup: { title: '备份', desc: '导出与恢复站点、分类、绑定和计划' },
  logs: { title: '日志', desc: '采集运行日志' }
}

/**
 * 控制台：返回收进左侧导航，分区标题与说明合并成吸顶行。
 * 概览页汇总各分区数据，其余分区各自读取并订阅自己的数据。
 */
function Console({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [section, setSection] = useState<ConsoleSection>('overview')
  /** 从站点分类弹窗点「绑定」带过来的上下文，非空时分类页进入左右两栏映射模式 */
  const [bindingSite, setBindingSite] = useState<{ id: string; name: string } | null>(null)
  /** 从进度页点「日志」带过来的站点筛选 */
  const [logSiteId, setLogSiteId] = useState('')
  const meta = SECTION_META[section]

  const goSection = (next: ConsoleSection): void => {
    setSection(next)
    // 离开分类页就退出映射模式，避免回来时还挂着一半的状态
    if (next !== 'categories') setBindingSite(null)
    // 导航进入日志时默认看全部；行内「日志」按钮走 onOpenLogs，不经过这里
    setLogSiteId('')
  }

  const renderSection = (): React.JSX.Element => {
    switch (section) {
      case 'overview':
        return <OverviewPanel title={meta.title} desc={meta.desc} onNavigate={goSection} />
      case 'home':
        return <HomeSettingsPanel title={meta.title} desc={meta.desc} />
      case 'sites':
        return (
          <SitesPanel
            title={meta.title}
            desc={meta.desc}
            onStartBinding={(site) => {
              setBindingSite(site)
              setSection('categories')
            }}
          />
        )
      case 'categories':
        return (
          <CategoriesPanel
            title={meta.title}
            desc={meta.desc}
            bindingSite={bindingSite}
            onExitBinding={() => setBindingSite(null)}
          />
        )
      case 'backup':
        return <BackupPanel title={meta.title} desc={meta.desc} />
      case 'collect':
        return (
          <CollectPanel
            title={meta.title}
            desc={meta.desc}
            onOpenProgress={() => goSection('progress')}
          />
        )
      case 'progress':
        return (
          <ProgressPanel
            title={meta.title}
            desc={meta.desc}
            onOpenCollect={() => goSection('collect')}
            onOpenLogs={(siteId) => {
              setLogSiteId(siteId)
              setSection('logs')
            }}
          />
        )
      case 'videos':
        return <VideosPanel title={meta.title} desc={meta.desc} />
      case 'capacity':
        return <CapacityPanel title={meta.title} desc={meta.desc} />
      case 'logs':
        return (
          <LogsPanel
            key={logSiteId || 'all'}
            title={meta.title}
            desc={meta.desc}
            initialSiteId={logSiteId}
          />
        )
    }
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

        <div className="settings-panel">{renderSection()}</div>
      </div>
    </div>
  )
}

export default Console
