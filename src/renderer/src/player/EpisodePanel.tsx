import { useCallback, useEffect, useRef, useState } from 'react'
import { CloseOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import { episodeLabel, lineLabels, type PlayerLine } from './player-data'

interface EpisodePanelProps {
  /** sidebar：右侧常驻；drawer：影院布局的浮层；strip：播放器下方的横向剧集条 */
  variant: 'sidebar' | 'drawer' | 'strip'
  lines: PlayerLine[]
  line: PlayerLine
  onLine: (line: PlayerLine) => void
  episodeIndex: number
  onEpisode: (index: number) => void
  autoNext: boolean
  onAutoNext: (value: boolean) => void
  onClose?: () => void
}

/**
 * 剧集面板：线路切换 + 集数格子 + 自动连播开关。
 * 集数用等宽数字排成「胶片格」，正在播放的那一格填成琥珀色并带三根跳动的电平条。
 */
function EpisodePanel({
  variant,
  lines,
  line,
  onLine,
  episodeIndex,
  onEpisode,
  autoNext,
  onAutoNext,
  onClose
}: EpisodePanelProps): React.JSX.Element {
  const labels = lineLabels(lines)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })

  const syncEdges = useCallback(() => {
    const element = scrollerRef.current
    if (!element) return
    const max = element.scrollWidth - element.clientWidth
    setEdges({ start: element.scrollLeft <= 1, end: element.scrollLeft >= max - 1 })
  }, [])

  useEffect(() => {
    syncEdges()
  }, [line, syncEdges])

  // 切集 / 切线路后把当前格滚到可见位置：侧栏上下滚，剧集条左右滚
  useEffect(() => {
    const container = scrollerRef.current
    const active = container?.querySelector<HTMLElement>('.episode-cell.is-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [episodeIndex, line.key])

  const step = (direction: number): void => {
    const element = scrollerRef.current
    if (!element) return
    element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <section className={`episode-panel is-${variant}`}>
      <div className="episode-head">
        <div className="episode-heading">
          <span className="episode-eyebrow">剧集</span>
          <span className="episode-count">{line.episodes.length} 集</span>
        </div>
        {variant === 'strip' && (
          <div className="episode-strip-actions">
            <button
              type="button"
              className="episode-arrow"
              onClick={() => step(-1)}
              disabled={edges.start}
              title="向前翻"
              aria-label="向前翻"
            >
              <LeftOutlined />
            </button>
            <button
              type="button"
              className="episode-arrow"
              onClick={() => step(1)}
              disabled={edges.end}
              title="向后翻"
              aria-label="向后翻"
            >
              <RightOutlined />
            </button>
          </div>
        )}
        {variant === 'drawer' && onClose && (
          <button
            type="button"
            className="episode-arrow"
            onClick={onClose}
            title="收起剧集"
            aria-label="收起剧集"
          >
            <CloseOutlined />
          </button>
        )}
      </div>

      {lines.length > 1 ? (
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
      ) : (
        <p className="episode-single-line" title={line.sourceName}>
          {line.sourceName} · {labels.get(line.key)}
        </p>
      )}

      <div
        className={`episode-grid is-${variant}`}
        ref={scrollerRef}
        onScroll={variant === 'strip' ? syncEdges : undefined}
      >
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

      {variant !== 'strip' && (
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
      )}
    </section>
  )
}

export default EpisodePanel
