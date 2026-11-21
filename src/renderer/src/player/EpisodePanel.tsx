import { useEffect, useRef } from 'react'
import { episodeLabel, lineLabels, type PlayerLine } from './player-data'

interface EpisodePanelProps {
  lines: PlayerLine[]
  line: PlayerLine
  onLine: (line: PlayerLine) => void
  episodeIndex: number
  onEpisode: (index: number) => void
  autoNext: boolean
  onAutoNext: (value: boolean) => void
}

/**
 * 面板里的剧集列表：线路切换 + 集数格子 + 自动连播开关。
 * 集数用等宽数字排成「胶片格」，正在播放的那一格填强调色并带三根跳动的电平条；
 * 网格自己滚动，头部和底部固定。
 */
function EpisodePanel({
  lines,
  line,
  onLine,
  episodeIndex,
  onEpisode,
  autoNext,
  onAutoNext
}: EpisodePanelProps): React.JSX.Element {
  const labels = lineLabels(lines)
  const scrollerRef = useRef<HTMLDivElement>(null)

  // 切集 / 切线路 / 重新展开面板后把当前格滚到可见位置
  useEffect(() => {
    const container = scrollerRef.current
    const active = container?.querySelector<HTMLElement>('.episode-cell.is-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [episodeIndex, line.key])

  return (
    <section className="episode-panel">
      <div className="episode-head">
        <span className="episode-current" title={line.sourceName}>
          {line.sourceName}
        </span>
        <span className="episode-count">{line.episodes.length} 集</span>
      </div>

      {lines.length > 1 && (
        <div className="episode-lines" role="group" aria-label="播放线路">
          {lines.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`episode-line${item.key === line.key ? ' is-active' : ''}`}
              aria-pressed={item.key === line.key}
              title={`${item.sourceName} · ${item.flag || '默认线路'}`}
              onClick={() => onLine(item)}
            >
              {labels.get(item.key)}
            </button>
          ))}
        </div>
      )}

      <div className="episode-grid" ref={scrollerRef}>
        {line.episodes.map((episode, index) => {
          const label = episodeLabel(episode.name, index)
          const active = index === episodeIndex
          return (
            <button
              key={`${episode.index}-${episode.url}`}
              type="button"
              className={`episode-cell${active ? ' is-active' : ''}`}
              title={episode.name || `第 ${index + 1} 集`}
              aria-current={active ? 'true' : undefined}
              onClick={() => onEpisode(index)}
            >
              <span className="episode-num">{label.number}</span>
              {label.caption && <span className="episode-caption">{label.caption}</span>}
              {active && (
                <span className="episode-bars" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="episode-foot">
        <span className="episode-foot-label">自动连播</span>
        <button
          type="button"
          role="switch"
          aria-checked={autoNext}
          className={`episode-switch${autoNext ? ' is-on' : ''}`}
          title={autoNext ? '关闭自动连播' : '开启自动连播'}
          onClick={() => onAutoNext(!autoNext)}
        >
          <span className="episode-switch-knob" />
        </button>
      </div>
    </section>
  )
}

export default EpisodePanel
