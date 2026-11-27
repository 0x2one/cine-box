import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App,
  Button,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  ClearOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  HolderOutlined,
  LinkOutlined,
  PictureOutlined,
  ReloadOutlined,
  RightOutlined,
  UndoOutlined,
  UploadOutlined
} from '@ant-design/icons'
import HomePicture from '../components/HomePicture'

/** 海报叠层的宽高比：1180 窗口下约 984 × 420 */
const HERO_RATIO = 2.34
/** 分类轨道的封面比例，和推荐页卡片一致 */
const CARD_RATIO = 2 / 3
/** 搜索页底部推荐位：展示端是 3:4 的竖版，裁剪器也按这个比例取景 */
const SEARCH_CARD_RATIO = 3 / 4

/** 两个 tab 的说明：放在标题行右侧，超长省略，悬停看全文 */
const POSTER_HINT =
  '顺序就是推荐页叠层的顺序，拖动行或点上 / 下箭头都能调整；「添加到海报」在控制台「视频」页每行的操作里。隐藏的不会出现在推荐页，配置仍保留。'
const SECTION_HINT =
  '每个一级分类对应推荐页上的一条轨道。自定义用「视频」页的「推荐」按钮加片；TOP 按视频更新时间自动取前 N 部。两种规则都能排序、移除、隐藏、改图；拖动分类名前的把手可以调整分类在推荐页上的先后顺序。'
const SEARCH_HINT =
  '搜索页初始状态底部的一排带片名海报，默认按更新时间取前 8 部。自定义同样用「视频」页的「推荐」按钮加片；两种规则都能排序、移除、隐藏、改图。'

const HOME_ERRORS: Record<string, string> = {
  NOT_FOUND: '条目已不存在，刷新后再试',
  DUPLICATE: '这个视频已经在海报里了',
  FULL: '海报数量已达上限',
  INVALID_INPUT: '配置内容不合法',
  CACHE_UNAVAILABLE: '视频缓存库不可用'
}

/** 分类推荐默认收起，展开过的分组记在这里，下次进来还开着 */
const EXPANDED_KEY = 'home-sections-expanded'

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    // 记录坏掉就当没展开过，默认收起
    return []
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * 图片裁剪器：一个按目标比例固定的取景框，拖动平移，双指捏合 / Ctrl + 滚轮缩放。
 * 内部用「显示尺寸 + 左上角偏移」表示，对外只输出归一化裁剪框，和渲染端的算法一致。
 */
function ImageCropper({
  src,
  ratio,
  initialCrop,
  onChange
}: {
  src: string
  ratio: number
  initialCrop: HomeCrop
  onChange: (crop: HomeCrop) => void
}): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [frame, setFrame] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<{ zoom: number; left: number; top: number } | null>(null)

  const baseScale = useMemo(() => {
    if (!natural || frame.w <= 0 || frame.h <= 0) return 0
    return Math.max(frame.w / natural.w, frame.h / natural.h)
  }, [frame, natural])

  const clampView = useCallback(
    (
      next: { zoom: number; left: number; top: number },
      size = frame
    ): { zoom: number; left: number; top: number } => {
      if (!natural || size.w <= 0 || size.h <= 0) return next
      const zoom = clamp(next.zoom, 1, 4)
      const base = Math.max(size.w / natural.w, size.h / natural.h)
      const width = natural.w * base * zoom
      const height = natural.h * base * zoom
      return {
        zoom,
        left: clamp(next.left, size.w - width, 0),
        top: clamp(next.top, size.h - height, 0)
      }
    },
    [frame, natural]
  )

  const emit = useCallback(
    (next: { zoom: number; left: number; top: number }): void => {
      if (!natural || frame.w <= 0 || frame.h <= 0) return
      const base = Math.max(frame.w / natural.w, frame.h / natural.h)
      const width = natural.w * base * next.zoom
      const height = natural.h * base * next.zoom
      onChange({
        x: clamp(-next.left / width, 0, 1),
        y: clamp(-next.top / height, 0, 1),
        w: clamp(frame.w / width, 0.001, 1),
        h: clamp(frame.h / height, 0.001, 1)
      })
    },
    [frame, natural, onChange]
  )

  // 量取景框的像素尺寸（窗口缩放 / 切换比例后要重算）
  useEffect(() => {
    const element = frameRef.current
    if (!element) return
    const measure = (): void => {
      const next = { w: element.clientWidth, h: element.clientHeight }
      setFrame((prev) => (prev.w === next.w && prev.h === next.h ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 图片尺寸就绪后，把已有裁剪框反推成缩放 / 偏移；比例对不上就按居中 cover 重新开
  useEffect(() => {
    if (!natural || frame.w <= 0 || frame.h <= 0) return
    const base = Math.max(frame.w / natural.w, frame.h / natural.h)
    const crop = initialCrop
    const aspectOk = Math.abs(crop.w / crop.h - frame.w / frame.h) < 0.03
    const initial = aspectOk
      ? {
          zoom: frame.w / crop.w / natural.w / base,
          left: -crop.x * (frame.w / crop.w),
          top: -crop.y * (frame.h / crop.h)
        }
      : { zoom: 1, left: 0, top: 0 }
    // 居中：cover 时多出来的部分两边各裁一半
    const width = natural.w * base * initial.zoom
    const height = natural.h * base * initial.zoom
    const centered = {
      zoom: initial.zoom,
      left: aspectOk ? initial.left : (frame.w - width) / 2,
      top: aspectOk ? initial.top : (frame.h - height) / 2
    }
    const next = clampView(centered)
    // 图片 / 取景框尺寸就绪后按已有裁剪复位一次，属于对外部测量结果的同步
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView(next)
    emit(next)
    // 只在图片 / 取景框尺寸变化时初始化，拖动过程中不重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural, frame])

  /**
   * 缩放走原生 wheel：React 的 onWheel 是 passive 的，preventDefault 不生效会让页面跟着滚。
   * 触控板双指捏合在 Chromium 里就是 Ctrl + wheel，所以一段监听同时覆盖两种手势。
   * 监听只挂一次，最新状态通过 ref 读取。
   */
  const liveRef = useRef<{
    view: { zoom: number; left: number; top: number } | null
    natural: { w: number; h: number } | null
    clamp: (next: { zoom: number; left: number; top: number }) => {
      zoom: number
      left: number
      top: number
    }
    apply: (next: { zoom: number; left: number; top: number }) => void
  }>({
    view: null,
    natural: null,
    clamp: clampView,
    apply: () => {
      // 初始化前不会收到 wheel
    }
  })

  useEffect(() => {
    liveRef.current = {
      view,
      natural,
      clamp: clampView,
      apply: (next) => {
        setView(next)
        emit(next)
      }
    }
  }, [clampView, emit, natural, view])

  useEffect(() => {
    const element = frameRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      const live = liveRef.current
      if (!live.view || !live.natural) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const pointX = event.clientX - rect.left
      const pointY = event.clientY - rect.top
      // 行模式（部分鼠标）先换算成像素，步长才和触控板接近
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY
      const zoom = clamp(live.view.zoom * Math.exp(-delta * 0.0022), 1, 4)
      if (Math.abs(zoom - live.view.zoom) < 0.001) return
      // 以指针位置为中心缩放：指针下的那块画面保持不动
      const scale = zoom / live.view.zoom
      live.apply(
        live.clamp({
          zoom,
          left: pointX - (pointX - live.view.left) * scale,
          top: pointY - (pointY - live.view.top) * scale
        })
      )
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  const reset = (): void => {
    if (!natural) return
    const width = natural.w * baseScale
    const height = natural.h * baseScale
    const next = clampView({
      zoom: 1,
      left: (frame.w - width) / 2,
      top: (frame.h - height) / 2
    })
    setView(next)
    emit(next)
  }

  return (
    <div className="home-editor-cropper">
      <div
        ref={frameRef}
        className="home-editor-crop-frame"
        style={{ aspectRatio: String(ratio) }}
        onPointerDown={(event) => {
          if (!view) return
          // 合成事件 / 不支持捕获的环境里不抛错，拖动本身照样能走
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // ignore
          }
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            left: view.left,
            top: view.top
          }
        }}
        onPointerMove={(event) => {
          if (!dragRef.current || !view) return
          const next = clampView({
            zoom: view.zoom,
            left: dragRef.current.left + (event.clientX - dragRef.current.x),
            top: dragRef.current.top + (event.clientY - dragRef.current.y)
          })
          setView(next)
          emit(next)
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
        onPointerCancel={() => {
          dragRef.current = null
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          style={
            view && natural
              ? {
                  width: natural.w * baseScale * view.zoom,
                  height: natural.h * baseScale * view.zoom,
                  left: view.left,
                  top: view.top
                }
              : { visibility: 'hidden' }
          }
          onLoad={(event) => {
            const image = event.currentTarget
            setNatural({ w: image.naturalWidth || 1, h: image.naturalHeight || 1 })
          }}
        />
        <span className="home-editor-crop-hint">拖动平移 · 双指或 Ctrl + 滚轮缩放</span>
        <button
          type="button"
          className="home-editor-crop-reset"
          title="重置取景"
          aria-label="重置取景"
          disabled={!natural || !view}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={reset}
        >
          <UndoOutlined />
        </button>
      </div>
    </div>
  )
}

/** 条目编辑弹窗：文字覆盖 + 自定义图片（本地上传 / 图片地址 / 换来源封面）+ 裁剪 */
function HomeItemEditor({
  item,
  ratio,
  kind,
  saving,
  onCancel,
  onSave
}: {
  item: HomeItemView
  ratio: number
  kind: 'poster' | 'section' | 'search'
  saving: boolean
  onCancel: () => void
  onSave: (patch: HomeItemPatch) => void
}): React.JSX.Element {
  const { message } = App.useApp()
  const [title, setTitle] = useState(item.title === '视频已丢失' ? '' : item.title)
  const [note, setNote] = useState(item.note)
  const [actors, setActors] = useState(item.actors)
  const [intro, setIntro] = useState(item.intro)
  const [draftPic, setDraftPic] = useState(item.customPic ? item.pic : '')
  const [crop, setCrop] = useState<HomeCrop>(
    item.customPic ? item.crop : { x: 0, y: 0, w: 1, h: 1 }
  )
  const [hidden, setHidden] = useState(item.hidden)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [covers, setCovers] = useState<{ pic: string; siteName: string }[]>([])
  const [coversLoading, setCoversLoading] = useState(!item.missing)

  useEffect(() => {
    if (item.missing) return
    let alive = true
    window.api.videos
      .detail(item.videoId, { autoFetch: false, includeAdult: true })
      .then((result) => {
        if (!alive || !result.ok || !result.video) return
        const seen = new Set<string>()
        const list: { pic: string; siteName: string }[] = []
        for (const source of result.video.sources) {
          if (!source.pic || seen.has(source.pic)) continue
          seen.add(source.pic)
          list.push({ pic: source.pic, siteName: source.siteName })
        }
        setCovers(list.slice(0, 8))
      })
      .catch(() => {
        // 拿不到来源封面不影响手填
      })
      .finally(() => {
        if (alive) setCoversLoading(false)
      })
    return () => {
      alive = false
    }
  }, [item.missing, item.videoId])

  const selectPic = (next: string): void => {
    setDraftPic(next)
    // 换图后先按居中 cover 重新取景，具体裁剪由裁剪器算完回填
    setCrop({ x: 0, y: 0, w: 1, h: 1 })
  }

  const pickLocal = async (): Promise<void> => {
    try {
      const result = await window.api.home.pickImage()
      if (!result.ok) {
        if (!result.canceled) {
          message.error(result.error === 'TOO_LARGE' ? '图片不能超过 16MB' : '图片导入失败')
        }
        return
      }
      if (result.url) selectPic(result.url)
    } catch {
      message.error('图片导入失败')
    }
  }

  const applyUrl = (): void => {
    const value = url.trim()
    if (!/^https?:\/\//i.test(value)) {
      message.warning('请填写 http(s) 开头的图片地址')
      return
    }
    selectPic(value)
    setUrlOpen(false)
  }

  const previewItem = {
    pic: draftPic || item.videoPic,
    crop,
    customPic: !!draftPic,
    title: title || item.videoName || '映'
  }

  return (
    <Modal
      open
      width={920}
      title={kind === 'poster' ? '编辑海报' : '编辑推荐条目'}
      onCancel={onCancel}
      footer={null}
      destroyOnHidden
    >
      <div className="home-editor">
        <div className="home-editor-fields">
          <p className="home-editor-hint">
            留空表示沿用视频库里的值；这里改的只影响展示端，不会动采集到的数据。
          </p>
          <label className="home-editor-field">
            <span className="home-editor-label">
              片名
              <span className="home-editor-placeholder-hint">{item.videoName || '视频已丢失'}</span>
            </span>
            <Input
              value={title}
              maxLength={120}
              placeholder={item.videoName || '默认用视频名'}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="home-editor-field">
            <span className="home-editor-label">进度 / 备注</span>
            <Input
              value={note}
              maxLength={200}
              placeholder={item.videoNote || '例如：全 12 集'}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <label className="home-editor-field">
            <span className="home-editor-label">主演</span>
            <Input
              value={actors}
              maxLength={500}
              placeholder={item.videoActors || '多个用逗号分隔'}
              onChange={(event) => setActors(event.target.value)}
            />
          </label>
          <label className="home-editor-field">
            <span className="home-editor-label">简介</span>
            <Input.TextArea
              value={intro}
              rows={4}
              maxLength={4000}
              placeholder={item.videoIntro || '留空则用视频库的简介'}
              onChange={(event) => setIntro(event.target.value)}
            />
          </label>
          <div className="home-editor-switch">
            <Switch checked={hidden} onChange={setHidden} />
            <div>
              <span className="home-editor-label">
                {kind === 'search' ? '在搜索页隐藏' : '在推荐页隐藏'}
              </span>
              <span className="home-editor-hint">隐藏后配置仍保留，随时可以恢复</span>
            </div>
          </div>
        </div>

        <div className="home-editor-image">
          <div className="home-editor-image-head">
            <span className="home-editor-label">图片</span>
            <span className="home-editor-hint">
              {draftPic
                ? '拖动平移，双指或 Ctrl + 滚轮缩放，保存后按取景框显示'
                : '当前使用视频封面'}
            </span>
          </div>

          <div
            className="home-editor-image-stage"
            style={{ '--editor-ratio': String(ratio) } as React.CSSProperties}
          >
            {draftPic ? (
              <ImageCropper
                key={`${draftPic}:${ratio}`}
                src={draftPic}
                ratio={ratio}
                initialCrop={crop}
                onChange={setCrop}
              />
            ) : (
              <div className="home-editor-default-frame" style={{ aspectRatio: String(ratio) }}>
                <HomePicture item={previewItem} eager />
              </div>
            )}

            {/* 浮在图片右下角：换封面 / 上传 / 地址，不额外占一行 */}
            <div className="home-editor-image-actions">
              <Tooltip title="使用视频封面">
                <button
                  type="button"
                  className="home-editor-image-action"
                  aria-label="使用视频封面"
                  disabled={!draftPic}
                  onClick={() => selectPic('')}
                >
                  <PictureOutlined />
                </button>
              </Tooltip>
              <Tooltip title="本地上传">
                <button
                  type="button"
                  className="home-editor-image-action"
                  aria-label="本地上传"
                  onClick={() => void pickLocal()}
                >
                  <UploadOutlined />
                </button>
              </Tooltip>
              <Tooltip title="图片地址">
                <button
                  type="button"
                  className="home-editor-image-action"
                  aria-label="图片地址"
                  onClick={() => setUrlOpen((value) => !value)}
                >
                  <LinkOutlined />
                </button>
              </Tooltip>
            </div>
          </div>

          {urlOpen && (
            <Space.Compact block>
              <Input
                autoFocus
                value={url}
                placeholder="https://…/poster.jpg"
                onChange={(event) => setUrl(event.target.value)}
                onPressEnter={applyUrl}
              />
              <Button
                icon={<CheckOutlined />}
                aria-label="应用地址"
                title="应用地址"
                onClick={applyUrl}
              />
            </Space.Compact>
          )}

          {covers.length > 0 && (
            <div className="home-editor-covers">
              <span className="home-editor-covers-label">换来源封面</span>
              <span className="home-editor-covers-hint">
                选一张来源封面作为海报，选好后在上方取景框里拖动、缩放调整显示区域
              </span>
              <div className="home-editor-covers-list">
                {covers.map((cover) => (
                  <button
                    key={cover.pic}
                    type="button"
                    className={`home-editor-cover${draftPic === cover.pic ? ' is-active' : ''}`}
                    title={cover.siteName}
                    onClick={() => selectPic(cover.pic)}
                  >
                    <img src={cover.pic} alt="" referrerPolicy="no-referrer" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {coversLoading && <Spin size="small" />}
        </div>
      </div>

      <div className="home-editor-footer">
        <Button onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button
          type="primary"
          loading={saving}
          onClick={() =>
            onSave({
              title: title.trim(),
              note: note.trim(),
              actors: actors.trim(),
              intro: intro.trim(),
              pic: draftPic,
              crop: draftPic ? crop : item.crop,
              hidden
            })
          }
        >
          保存
        </Button>
      </div>
    </Modal>
  )
}

type DragEdge = 'before' | 'after'

/** 拖动排序：整行可拖，落点按行的上 / 下半区决定插到前面还是后面 */
interface RowDrag {
  dragging: boolean
  edge: DragEdge | null
  onStart: () => void
  onOver: (edge: DragEdge) => void
  onDrop: (edge: DragEdge) => void
  onEnd: () => void
}

/** 一行条目：缩略图 + 标题 / 状态 + 拖动或按钮排序、隐藏、编辑、移除 */
function HomeItemRow({
  item,
  ratio,
  index,
  total,
  removeTitle,
  onMove,
  onEdit,
  onToggleHidden,
  onRemove,
  drag
}: {
  item: HomeItemView
  ratio: number
  index: number
  total: number
  removeTitle: string
  onMove: (delta: number) => void
  onEdit: () => void
  onToggleHidden: () => void
  onRemove: () => void
  drag?: RowDrag
}): React.JSX.Element {
  /** 落点：指针在行的上半区就插到它前面，下半区插到后面 */
  const edgeFromPointer = (event: React.DragEvent<HTMLDivElement>): DragEdge => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }
  const classes = ['home-config-row']
  if (item.hidden) classes.push('is-hidden')
  if (drag?.dragging) classes.push('is-dragging')
  if (drag?.edge) classes.push(`is-drop-${drag.edge}`)
  return (
    <div
      className={classes.join(' ')}
      draggable={Boolean(drag)}
      onDragStart={(event) => {
        if (!drag) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(item.videoId))
        drag.onStart()
      }}
      onDragOver={(event) => {
        if (!drag) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        drag.onOver(edgeFromPointer(event))
      }}
      onDrop={(event) => {
        if (!drag) return
        event.preventDefault()
        drag.onDrop(edgeFromPointer(event))
      }}
      onDragEnd={() => drag?.onEnd()}
    >
      {drag && (
        <span className="home-config-grip" aria-hidden="true">
          <HolderOutlined />
        </span>
      )}
      <div
        className={`home-thumb${ratio > 1 ? ' home-thumb--wide' : ''}`}
        style={{ aspectRatio: String(ratio) }}
        role="button"
        tabIndex={0}
        title="点一下编辑这条海报"
        aria-label={`编辑：${item.title}`}
        onClick={onEdit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onEdit()
        }}
      >
        <HomePicture item={item} />
      </div>
      <div className="home-config-body">
        <div className="home-config-title">
          <span className="home-config-name" title={item.title}>
            {item.title}
          </span>
          {!item.pinned && <Tag color="default">自动</Tag>}
          {item.customPic && <Tag color="blue">自定义图片</Tag>}
          {item.hidden && <Tag color="default">已隐藏</Tag>}
          {item.missing && <Tag color="error">视频已丢失</Tag>}
          {item.videoHidden && <Tag color="warning">视频已隐藏</Tag>}
        </div>
        <div className="home-config-meta">
          {item.videoName && item.videoName !== item.title ? `${item.videoName} · ` : ''}
          {item.latestTime ? `更新 ${item.latestTime}` : '暂无更新时间'}
          {item.note ? ` · ${item.note}` : ''}
        </div>
      </div>
      <div className="home-config-actions">
        <Tooltip title="上移">
          <Button
            type="text"
            size="small"
            icon={<ArrowUpOutlined />}
            aria-label="上移"
            disabled={index <= 0}
            onClick={() => onMove(-1)}
          />
        </Tooltip>
        <Tooltip title="下移">
          <Button
            type="text"
            size="small"
            icon={<ArrowDownOutlined />}
            aria-label="下移"
            disabled={index >= total - 1}
            onClick={() => onMove(1)}
          />
        </Tooltip>
        <Tooltip title={item.hidden ? '恢复显示' : '在推荐页隐藏'}>
          <Button
            type="text"
            size="small"
            icon={item.hidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
            aria-label={item.hidden ? '恢复显示' : '在推荐页隐藏'}
            onClick={onToggleHidden}
          />
        </Tooltip>
        <Tooltip title="编辑视频信息 / 自定义图片">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            aria-label="编辑"
            onClick={onEdit}
          />
        </Tooltip>
        <Popconfirm title={removeTitle} okText="移除" cancelText="取消" onConfirm={onRemove}>
          <Tooltip title="移除">
            <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="移除" />
          </Tooltip>
        </Popconfirm>
      </div>
    </div>
  )
}

/**
 * 一张推荐卡片：封面按轨道比例取景（和推荐页看到的一致），点封面或片名编辑。
 * 整卡可拖，落点按指针在卡片的左 / 右半边决定插到前面还是后面；操作条悬停或聚焦时浮出。
 */
function HomeItemCard({
  item,
  ratio,
  index,
  total,
  removeTitle,
  hideLabel = '推荐页',
  onMove,
  onEdit,
  onToggleHidden,
  onRemove,
  drag
}: {
  item: HomeItemView
  ratio: number
  index: number
  total: number
  removeTitle: string
  /** 隐藏开关的文案落在哪个展示页 */
  hideLabel?: string
  onMove: (delta: number) => void
  onEdit: () => void
  onToggleHidden: () => void
  onRemove: () => void
  drag?: RowDrag
}): React.JSX.Element {
  /** 落点：指针在左半边就插到它前面，右半边插到后面 */
  const edgeFromPointer = (event: React.DragEvent<HTMLDivElement>): DragEdge => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
  }
  const classes = ['home-shelf-card']
  if (item.hidden) classes.push('is-hidden')
  if (drag?.dragging) classes.push('is-dragging')
  if (drag?.edge) classes.push(`is-drop-${drag.edge}`)
  /** 卡片放不下的一行信息放进 title，悬停能看到完整的时间和备注 */
  const meta = [
    item.videoName && item.videoName !== item.title ? item.videoName : '',
    item.latestTime ? `更新 ${item.latestTime}` : '暂无更新时间',
    item.note
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className={classes.join(' ')}
      draggable={Boolean(drag)}
      onDragStart={(event) => {
        if (!drag) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(item.videoId))
        drag.onStart()
      }}
      onDragOver={(event) => {
        if (!drag) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        drag.onOver(edgeFromPointer(event))
      }}
      onDrop={(event) => {
        if (!drag) return
        event.preventDefault()
        drag.onDrop(edgeFromPointer(event))
      }}
      onDragEnd={() => drag?.onEnd()}
    >
      <div className="home-shelf-frame" style={{ aspectRatio: String(ratio) }}>
        <button
          type="button"
          className="home-shelf-open"
          title={meta}
          aria-label={`编辑 ${item.title}`}
          onClick={onEdit}
        >
          <HomePicture item={item} />
        </button>
        <span className="home-shelf-index" aria-hidden="true">
          {index + 1}
        </span>
        {(item.missing || item.videoHidden || item.hidden) && (
          <span className="home-shelf-flags">
            {item.missing && <span className="home-shelf-flag is-error">已丢失</span>}
            {item.videoHidden && <span className="home-shelf-flag is-warn">视频隐藏</span>}
            {item.hidden && <span className="home-shelf-flag">已隐藏</span>}
          </span>
        )}
        <div className="home-shelf-actions">
          <button
            type="button"
            className="home-shelf-action"
            title="前移"
            aria-label="前移"
            disabled={index <= 0}
            onClick={() => onMove(-1)}
          >
            <ArrowLeftOutlined />
          </button>
          <button
            type="button"
            className="home-shelf-action"
            title="后移"
            aria-label="后移"
            disabled={index >= total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowRightOutlined />
          </button>
          <button
            type="button"
            className="home-shelf-action"
            title={item.hidden ? '恢复显示' : `在${hideLabel}隐藏`}
            aria-label={item.hidden ? '恢复显示' : `在${hideLabel}隐藏`}
            onClick={onToggleHidden}
          >
            {item.hidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
          </button>
          <Popconfirm title={removeTitle} okText="移除" cancelText="取消" onConfirm={onRemove}>
            <button
              type="button"
              className="home-shelf-action is-danger"
              title="移除"
              aria-label="移除"
            >
              <DeleteOutlined />
            </button>
          </Popconfirm>
        </div>
      </div>
      <button
        type="button"
        className="home-shelf-name"
        title={`${item.title} · ${meta}`}
        onClick={onEdit}
      >
        {item.title}
      </button>
    </div>
  )
}

/**
 * 控制台「推荐页」：海报叠层的排序 / 隐藏 / 移除，一级分类在推荐页的显示与推荐规则。
 * 条目本身（视频信息覆盖、自定义图片与裁剪）走同一个编辑弹窗。
 */
function HomeSettingsPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [feed, setFeed] = useState<HomeFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<'poster' | 'section' | 'search'>('poster')
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<{
    kind: 'poster' | 'section' | 'search'
    categoryId: string
    ratio: number
    item: HomeItemView
  } | null>(null)
  /** 拖动排序的源行与落点：海报和分类推荐共用，同一时间只会有一个拖动 */
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: number; edge: DragEdge } | null>(null)
  /** 分类推荐的分组拖动：拖的是一整个一级分类，落点单独记（视频 id 是数字，这里用分类 id） */
  const [sectionDragId, setSectionDragId] = useState<string | null>(null)
  const [sectionDrop, setSectionDrop] = useState<{ id: string; edge: DragEdge } | null>(null)
  /** 展开的分组（默认全收起，展开状态记到 localStorage）；「已移除」列表只在本页 */
  const [expanded, setExpanded] = useState<string[]>(readExpanded)
  const [removedOpen, setRemovedOpen] = useState<string[]>([])
  /**
   * TOP 轨道的「共 N 部」：每条轨道要跑一次几十到一百多毫秒的统计，所以不跟 feed 一起等，
   * 页面出来以后再单独补。key 是分类 id，`search` 是搜索页推荐位那一行（整库展示中的数量）。
   */
  const [counts, setCounts] = useState<Record<string, number>>({})
  /** 已经数过的分类：本页内不再重复统计（条数不会因为改配置而变） */
  const counted = useRef(new Set<string>())

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
    } catch {
      // 存不下就只在本次会话里生效
    }
  }, [expanded])

  /**
   * 页面渲染完再补「共 N 部」。一个分类只数一次，所以点开关 / 改 TOP N 触发的静默刷新
   * 不会又把这几条统计跑一遍；查询失败时把标记撤掉，下次刷新会重试。
   */
  const loadCounts = useCallback((next: HomeFeed): void => {
    const pending = next.sections.filter(
      (section) => section.rule === 'latest' && !counted.current.has(section.categoryId)
    )
    const wantSearch = next.search?.rule === 'latest' && !counted.current.has('search')
    if (pending.length === 0 && !wantSearch) return

    const fill = async (key: string, query: VideoListQuery): Promise<void> => {
      counted.current.add(key)
      try {
        const result = await window.api.videos.count(query)
        if (!result.ok) {
          counted.current.delete(key)
          return
        }
        setCounts((previous) => ({ ...previous, [key]: result.total }))
      } catch {
        counted.current.delete(key)
      }
    }

    for (const section of pending) {
      void fill(section.categoryId, {
        categoryId: section.categoryId,
        visibility: 'shown',
        includeAdult: true
      })
    }
    // 搜索页推荐位那一行：整库里「展示中」的数量（控制台口径，18+ 的也算）
    if (wantSearch) void fill('search', { visibility: 'shown', includeAdult: true })
  }, [])

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    try {
      // 控制台要完整数据：隐藏轨道、搜索推荐位（总数改为页面出来后单独补，见 loadCounts）
      const result = await window.api.home.get({ view: 'console' })
      if (!result.ok || !result.feed) {
        setFailed(true)
        return
      }
      setFailed(false)
      setFeed(result.feed)
    } catch {
      setFailed(true)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // 数字等页面出来以后再补：feed 换过一次就检查还缺哪些（不挡住首屏）
  useEffect(() => {
    if (feed) loadCounts(feed)
  }, [feed, loadCounts])

  useEffect(() => {
    // 首次读取发生在 effect 里；setState 在 await 之后，规则按调用点误报
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const act = useCallback(
    async (promise: Promise<HomeActionResult>, success?: string): Promise<boolean> => {
      try {
        const result = await promise
        if (!result.ok) {
          message.error(HOME_ERRORS[result.error ?? ''] ?? '操作失败')
          return false
        }
        if (success) message.success(success)
        await load(true)
        return true
      } catch {
        message.error('操作失败')
        return false
      }
    },
    [load, message]
  )

  const posters = feed?.posters ?? []
  const sections = feed?.sections ?? []
  const search = feed?.search ?? null
  const posterIds = posters.map((item) => item.videoId)
  const visibleSections = sections.filter(
    (section) => section.visible && section.categoryVisible
  ).length
  /** 标题行右侧的说明跟着当前 tab 走 */
  const hint = tab === 'poster' ? POSTER_HINT : tab === 'section' ? SECTION_HINT : SEARCH_HINT

  const clearDrag = (): void => {
    setDragId(null)
    setDropTarget(null)
  }

  /** 折叠 / 展开这类只影响本页显示的开关 */
  const toggleKey = (setter: React.Dispatch<React.SetStateAction<string[]>>, key: string): void => {
    setter((prev) => (prev.includes(key) ? prev.filter((entry) => entry !== key) : [...prev, key]))
  }

  /** 把拖动行插到目标行的前 / 后，再按新顺序提交 */
  const dropInto = (
    ids: number[],
    targetId: number,
    edge: DragEdge,
    commit: (next: number[]) => void
  ): void => {
    const sourceId = dragId
    clearDrag()
    if (sourceId === null || sourceId === targetId) return
    const from = ids.indexOf(sourceId)
    const target = ids.indexOf(targetId)
    if (from < 0 || target < 0) return
    let to = target + (edge === 'after' ? 1 : 0)
    if (from < to) to -= 1
    if (to === from) return
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, sourceId)
    commit(next)
  }

  const rowDrag = (ids: number[], itemId: number, commit: (next: number[]) => void): RowDrag => ({
    dragging: dragId === itemId,
    edge: dropTarget?.id === itemId ? dropTarget.edge : null,
    onStart: () => {
      setDragId(itemId)
      setDropTarget(null)
    },
    onOver: (edge) => {
      // 只在本列表内部排序：从别的列表拖过来时不显示落点
      if (dragId === null || !ids.includes(dragId)) return
      setDropTarget((prev) =>
        prev?.id === itemId && prev.edge === edge ? prev : { id: itemId, edge }
      )
    },
    onDrop: (edge) => dropInto(ids, itemId, edge, commit),
    onEnd: clearDrag
  })

  /** 分类推荐里各分组的当前顺序：拖动分类名前的把手调整，结果写进推荐配置 */
  const sectionIds = sections.map((section) => section.categoryId)

  const clearSectionDrag = (): void => {
    setSectionDragId(null)
    setSectionDrop(null)
  }

  /**
   * 分组落点：指针在目标分组标题的上半区就插到它前面；
   * 落到标题下方的内容区时按拖动方向判断 —— 往上拖插到整组前面，
   * 往下拖插到整组后面，否则「拖上去却落到原处」会让人以为没生效。
   */
  const sectionDropEdge = (event: React.DragEvent<HTMLElement>, targetId: string): DragEdge => {
    const head = event.currentTarget.querySelector('.home-config-section-head')
    const rect = (head ?? event.currentTarget).getBoundingClientRect()
    if (event.clientY < rect.top + rect.height / 2) return 'before'
    const from = sectionIds.indexOf(sectionDragId ?? '')
    const to = sectionIds.indexOf(targetId)
    return from >= 0 && to >= 0 && from > to ? 'before' : 'after'
  }

  const dropIntoSections = (targetId: string, edge: DragEdge): void => {
    const sourceId = sectionDragId
    clearSectionDrag()
    if (!sourceId || sourceId === targetId) return
    const from = sectionIds.indexOf(sourceId)
    const to = sectionIds.indexOf(targetId)
    if (from < 0 || to < 0) return
    let insert = to + (edge === 'after' ? 1 : 0)
    if (from < insert) insert -= 1
    if (insert === from) return
    const next = [...sectionIds]
    next.splice(from, 1)
    next.splice(insert, 0, sourceId)
    void act(window.api.home.reorderSections(next))
  }

  const movePoster = (videoId: number, delta: number): void => {
    const ids = posters.map((item) => item.videoId)
    const from = ids.indexOf(videoId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    void act(window.api.home.reorderPosters(ids))
  }

  const moveSectionItem = (section: HomeSectionView, videoId: number, delta: number): void => {
    const ids = section.items.map((item) => item.videoId)
    const from = ids.indexOf(videoId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    void act(window.api.home.reorderSectionItems(section.categoryId, ids))
  }

  /**
   * 规则切换：
   * - TOP → 自定义：自定义列表还是空的（没建过 / 被清空），就把当前 TOP 列表落成人工列表；
   *   列表里有内容就原样保留，不再被 TOP 覆盖。
   * - 自定义 → TOP：TOP 自己按设置的条数算，自定义列表留着，切回来还在。
   */
  const changeRule = async (section: HomeSectionView, rule: HomeRule): Promise<void> => {
    if (rule === section.rule) return
    if (rule === 'manual' && !section.customized && section.items.length > 0) {
      const ok = await act(
        window.api.home.reorderSectionItems(
          section.categoryId,
          section.items.map((item) => item.videoId)
        )
      )
      if (!ok) return
    }
    await act(window.api.home.saveSection(section.categoryId, { rule }), '已切换规则')
  }

  /** 搜索推荐的规则切换：语义跟分类推荐一致，只是没有分类 */
  const changeSearchRule = async (target: HomeSearchView, rule: HomeRule): Promise<void> => {
    if (rule === target.rule) return
    if (rule === 'manual' && !target.customized && target.items.length > 0) {
      const ok = await act(
        window.api.home.reorderSearchItems(target.items.map((item) => item.videoId))
      )
      if (!ok) return
    }
    await act(window.api.home.saveSearch({ rule }), '已切换规则')
  }

  const saveItem = async (patch: HomeItemPatch): Promise<void> => {
    if (!editor) return
    setSaving(true)
    const ok =
      editor.kind === 'poster'
        ? await act(window.api.home.updatePoster(editor.item.videoId, patch), '已保存')
        : editor.kind === 'search'
          ? await act(window.api.home.updateSearchItem(editor.item.videoId, patch), '已保存')
          : await act(
              window.api.home.updateSectionItem(editor.categoryId, editor.item.videoId, patch),
              '已保存'
            )
    setSaving(false)
    if (ok) setEditor(null)
  }

  const moveSearchItem = (videoId: number, delta: number): void => {
    if (!search) return
    const ids = search.items.map((item) => item.videoId)
    const from = ids.indexOf(videoId)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    void act(window.api.home.reorderSearchItems(ids))
  }

  const posterTab = (
    <div className="home-config">
      {posters.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有海报，去「视频」页挑几部加进来"
        />
      ) : (
        <div className="home-config-list">
          {posters.map((item, index) => (
            <HomeItemRow
              key={item.videoId}
              item={item}
              ratio={HERO_RATIO}
              index={index}
              total={posters.length}
              removeTitle="从海报里移除？"
              onMove={(delta) => movePoster(item.videoId, delta)}
              onEdit={() => setEditor({ kind: 'poster', categoryId: '', ratio: HERO_RATIO, item })}
              onToggleHidden={() =>
                void act(
                  window.api.home.updatePoster(item.videoId, { hidden: !item.hidden }),
                  item.hidden ? '已恢复显示' : '已在推荐页隐藏'
                )
              }
              onRemove={() => void act(window.api.home.removePoster(item.videoId), '已移除')}
              drag={rowDrag(
                posterIds,
                item.videoId,
                (next) => void act(window.api.home.reorderPosters(next))
              )}
            />
          ))}
        </div>
      )}
    </div>
  )

  const sectionTab = (
    <div className="home-config">
      {sections.length > 1 && (
        <p className="home-config-order-hint">
          按住分类名前的把手上下拖动，可以调整分类在推荐页上的先后顺序。
        </p>
      )}
      {sections.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有一级分类，先去「分类」创建"
        />
      ) : (
        sections.map((section) => {
          const isCollapsed = !expanded.includes(section.categoryId)
          const showRemoved = removedOpen.includes(section.categoryId)
          const sectionClasses = ['home-config-section']
          if (isCollapsed) sectionClasses.push('is-collapsed')
          if (sectionDragId === section.categoryId) sectionClasses.push('is-dragging')
          if (sectionDrop?.id === section.categoryId) {
            sectionClasses.push(`is-drop-${sectionDrop.edge}`)
          }
          return (
            <section
              className={sectionClasses.join(' ')}
              key={section.categoryId}
              onDragOver={(event) => {
                // 只有拖分组时才接落点；拖的是组里的卡片时交给卡片自己处理
                if (!sectionDragId) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const edge = sectionDropEdge(event, section.categoryId)
                setSectionDrop((prev) =>
                  prev?.id === section.categoryId && prev.edge === edge
                    ? prev
                    : { id: section.categoryId, edge }
                )
              }}
              onDrop={(event) => {
                if (!sectionDragId) return
                event.preventDefault()
                dropIntoSections(section.categoryId, sectionDropEdge(event, section.categoryId))
              }}
            >
              <div
                className="home-config-section-head"
                // 整行空白处也能展开 / 收起，但输入框、按钮、规则和开关要照常操作
                onClick={(event) => {
                  const target = event.target as HTMLElement
                  if (
                    target.closest(
                      'button, input, textarea, select, label, a, .ant-radio-group, .ant-switch, .ant-select, .home-config-section-grip'
                    )
                  ) {
                    return
                  }
                  toggleKey(setExpanded, section.categoryId)
                }}
              >
                <div className="home-config-section-title">
                  <span
                    className="home-config-grip home-config-section-grip"
                    draggable
                    title="按住拖动，调整这一组在推荐页上的先后顺序"
                    aria-label="拖动排序"
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', section.categoryId)
                      // 拖影用整行标题，只拖一颗小图标看不出在搬哪一组
                      const head = event.currentTarget.closest('.home-config-section-head')
                      if (head) event.dataTransfer.setDragImage(head, 16, 16)
                      setSectionDragId(section.categoryId)
                      setSectionDrop(null)
                    }}
                    onDragEnd={clearSectionDrag}
                  >
                    <HolderOutlined />
                  </span>
                  <button
                    type="button"
                    className="home-config-fold"
                    aria-expanded={!isCollapsed}
                    aria-label={isCollapsed ? '展开' : '收起'}
                    onClick={() => toggleKey(setExpanded, section.categoryId)}
                  >
                    <RightOutlined className={isCollapsed ? undefined : 'is-open'} />
                  </button>
                  <Input
                    key={`${section.categoryId}:${section.title}`}
                    defaultValue={section.title}
                    maxLength={60}
                    variant="borderless"
                    className="home-config-name-input"
                    title="点一下改推荐页显示名，留空使用分类名"
                    onBlur={(event) => {
                      const value = event.target.value.trim()
                      if (value === section.title) return
                      void act(
                        window.api.home.saveSection(section.categoryId, {
                          title: value === section.name ? '' : value
                        }),
                        '已更新显示名'
                      )
                    }}
                    onPressEnter={(event) => event.currentTarget.blur()}
                  />
                  <span className="home-config-section-count">
                    {section.rule === 'manual'
                      ? `${section.total} 部推荐`
                      : `共 ${counts[section.categoryId] ?? '…'} 部`}
                  </span>
                  {!section.categoryVisible && <Tag color="warning">分类已隐藏</Tag>}
                  {!section.visible && <Tag color="default">不在推荐页显示</Tag>}
                </div>
                <div className="home-config-section-actions">
                  <Radio.Group
                    size="small"
                    optionType="button"
                    value={section.rule}
                    options={[
                      { label: '自定义', value: 'manual' },
                      { label: 'TOP', value: 'latest' }
                    ]}
                    onChange={(event) => void changeRule(section, event.target.value as HomeRule)}
                  />
                  {section.rule === 'latest' && (
                    <label className="home-config-field">
                      <span>取前</span>
                      <InputNumber
                        size="small"
                        min={1}
                        max={50}
                        value={section.topN}
                        className="home-config-topn"
                        onChange={(value) => {
                          if (typeof value === 'number') {
                            void act(
                              window.api.home.saveSection(section.categoryId, { topN: value })
                            )
                          }
                        }}
                      />
                    </label>
                  )}
                  <label className="home-config-field">
                    <span>显示</span>
                    <Switch
                      size="small"
                      checked={section.visible}
                      title="在推荐页显示这条轨道"
                      onChange={(checked) =>
                        void act(
                          window.api.home.saveSection(section.categoryId, { visible: checked })
                        )
                      }
                    />
                  </label>
                  {section.rule === 'manual' && section.items.length > 0 && (
                    <Popconfirm
                      title="清空全部推荐？"
                      description={`「${section.name}」下的 ${section.items.length} 部推荐会被移除，之后可以重新推荐。`}
                      okText="清空"
                      cancelText="取消"
                      onConfirm={() =>
                        void act(
                          window.api.home.clearSectionItems(section.categoryId),
                          '已清空推荐'
                        )
                      }
                    >
                      <Button type="text" size="small" danger icon={<ClearOutlined />}>
                        清空推荐
                      </Button>
                    </Popconfirm>
                  )}
                </div>
              </div>

              {!isCollapsed && (
                <>
                  {section.items.length === 0 ? (
                    <p className="home-config-empty">
                      {section.rule === 'manual'
                        ? '还没有推荐视频，去「视频」页点「推荐」加进来'
                        : '这个分类下还没有视频，或者绑定还没配好'}
                    </p>
                  ) : (
                    <div className="home-config-shelf">
                      {section.items.map((item, index) => (
                        <HomeItemCard
                          key={item.videoId}
                          item={item}
                          ratio={CARD_RATIO}
                          index={index}
                          total={section.items.length}
                          removeTitle={
                            section.rule === 'manual'
                              ? '从推荐里移除？'
                              : '从推荐页移除这部剧？之后可以在下方恢复'
                          }
                          onMove={(delta) => moveSectionItem(section, item.videoId, delta)}
                          onEdit={() =>
                            setEditor({
                              kind: 'section',
                              categoryId: section.categoryId,
                              ratio: CARD_RATIO,
                              item
                            })
                          }
                          onToggleHidden={() =>
                            void act(
                              window.api.home.updateSectionItem(section.categoryId, item.videoId, {
                                hidden: !item.hidden
                              }),
                              item.hidden ? '已恢复显示' : '已在推荐页隐藏'
                            )
                          }
                          onRemove={() =>
                            void act(
                              window.api.home.removeSectionItem(section.categoryId, item.videoId),
                              '已从推荐页移除'
                            )
                          }
                          drag={rowDrag(
                            section.items.map((entry) => entry.videoId),
                            item.videoId,
                            (next) =>
                              void act(
                                window.api.home.reorderSectionItems(section.categoryId, next)
                              )
                          )}
                        />
                      ))}
                    </div>
                  )}

                  {section.rule === 'latest' && section.removedItems.length > 0 && (
                    <div className="home-config-removed">
                      <button
                        type="button"
                        className="home-config-removed-toggle"
                        aria-expanded={showRemoved}
                        onClick={() => toggleKey(setRemovedOpen, section.categoryId)}
                      >
                        <RightOutlined className={showRemoved ? 'is-open' : undefined} />
                        已移除 {section.removedItems.length} 部
                      </button>
                      {showRemoved && (
                        <div className="home-config-removed-list">
                          {section.removedItems.map((item) => (
                            <button
                              key={item.videoId}
                              type="button"
                              className="home-config-removed-chip"
                              title={`${item.title} · 点击恢复到推荐页`}
                              onClick={() =>
                                void act(
                                  window.api.home.restoreSectionItem(
                                    section.categoryId,
                                    item.videoId
                                  ),
                                  '已恢复到推荐页'
                                )
                              }
                            >
                              <span className="home-config-removed-thumb">
                                <HomePicture item={item} />
                              </span>
                              <span className="home-config-removed-name">{item.title}</span>
                              <UndoOutlined className="home-config-removed-icon" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )
        })
      )}
    </div>
  )

  const searchTab = search ? (
    <div className="home-config">
      <section className="home-config-section">
        <div className="home-config-section-head is-static">
          <div className="home-config-section-title">
            <span className="home-config-section-name">搜索页推荐</span>
            <span className="home-config-section-count">
              {search.rule === 'manual'
                ? `${search.total} 部推荐`
                : `共 ${counts.search ?? '…'} 部视频`}
            </span>
          </div>
          <div className="home-config-section-actions">
            <Radio.Group
              size="small"
              optionType="button"
              value={search.rule}
              options={[
                { label: '自定义', value: 'manual' },
                { label: 'TOP', value: 'latest' }
              ]}
              onChange={(event) => void changeSearchRule(search, event.target.value as HomeRule)}
            />
            {search.rule === 'latest' && (
              <label className="home-config-field">
                <span>取前</span>
                <InputNumber
                  size="small"
                  min={1}
                  max={24}
                  value={search.topN}
                  className="home-config-topn"
                  onChange={(value) => {
                    if (typeof value === 'number') {
                      void act(window.api.home.saveSearch({ topN: value }))
                    }
                  }}
                />
              </label>
            )}
            {search.rule === 'manual' && search.items.length > 0 && (
              <Popconfirm
                title="清空全部推荐？"
                description={`搜索页底部的 ${search.items.length} 部推荐会被移除，之后可以重新推荐。`}
                okText="清空"
                cancelText="取消"
                onConfirm={() => void act(window.api.home.clearSearchItems(), '已清空推荐')}
              >
                <Button type="text" size="small" danger icon={<ClearOutlined />}>
                  清空推荐
                </Button>
              </Popconfirm>
            )}
          </div>
        </div>

        {search.items.length === 0 ? (
          <p className="home-config-empty">
            {search.rule === 'manual'
              ? '还没有推荐视频，去「视频」页点「推荐」加进来'
              : '片库里还没有展示中的视频，采集之后这里会自动出现'}
          </p>
        ) : (
          <div className="home-config-shelf">
            {search.items.map((item, index) => (
              <HomeItemCard
                key={item.videoId}
                item={item}
                ratio={SEARCH_CARD_RATIO}
                index={index}
                total={search.items.length}
                removeTitle={
                  search.rule === 'manual'
                    ? '从推荐里移除？'
                    : '从搜索页推荐里移除？之后可以在下方恢复'
                }
                hideLabel="搜索页"
                onMove={(delta) => moveSearchItem(item.videoId, delta)}
                onEdit={() =>
                  setEditor({ kind: 'search', categoryId: '', ratio: SEARCH_CARD_RATIO, item })
                }
                onToggleHidden={() =>
                  void act(
                    window.api.home.updateSearchItem(item.videoId, { hidden: !item.hidden }),
                    item.hidden ? '已恢复显示' : '已在搜索页隐藏'
                  )
                }
                onRemove={() =>
                  void act(window.api.home.removeSearchItem(item.videoId), '已从搜索页移除')
                }
                drag={rowDrag(
                  search.items.map((entry) => entry.videoId),
                  item.videoId,
                  (next) => void act(window.api.home.reorderSearchItems(next))
                )}
              />
            ))}
          </div>
        )}

        {search.rule === 'latest' && search.removedItems.length > 0 && (
          <div className="home-config-removed">
            <button
              type="button"
              className="home-config-removed-toggle"
              aria-expanded={removedOpen.includes('search')}
              onClick={() => toggleKey(setRemovedOpen, 'search')}
            >
              <RightOutlined className={removedOpen.includes('search') ? 'is-open' : undefined} />
              已移除 {search.removedItems.length} 部
            </button>
            {removedOpen.includes('search') && (
              <div className="home-config-removed-list">
                {search.removedItems.map((item) => (
                  <button
                    key={item.videoId}
                    type="button"
                    className="home-config-removed-chip"
                    title={`${item.title} · 点击恢复到搜索页`}
                    onClick={() =>
                      void act(window.api.home.restoreSearchItem(item.videoId), '已恢复到搜索页')
                    }
                  >
                    <span className="home-config-removed-thumb">
                      <HomePicture item={item} />
                    </span>
                    <span className="home-config-removed-name">{item.title}</span>
                    <UndoOutlined className="home-config-removed-icon" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  ) : null

  return (
    <>
      <div className="settings-panel-head has-actions home-config-head">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">
            海报 {posters.length} 张 · 分类 {visibleSections}/{sections.length} 个 · 搜索推荐{' '}
            {search?.items.length ?? 0} 部
          </span>
          {/* 说明收进图标，标题行只留标题 / 数量 / 刷新，避免长文案截断后挂在顶部 */}
          <Tooltip title={<div style={{ maxWidth: 360 }}>{hint}</div>} placement="bottomLeft">
            <span className="home-config-tip" tabIndex={0} role="img" aria-label={hint}>
              <ExclamationCircleOutlined className="home-config-tip-icon" />
            </span>
          </Tooltip>
        </p>
        <div className="settings-panel-actions">
          <Tooltip title="重新读取推荐配置">
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              aria-label="刷新"
              onClick={() => void load()}
            />
          </Tooltip>
        </div>
      </div>

      {loading && !feed ? (
        <div className="home-config-loading">
          <Spin />
        </div>
      ) : failed && !feed ? (
        <Empty description="推荐配置读取失败">
          <Button onClick={() => void load()}>重新读取</Button>
        </Empty>
      ) : (
        <div className="home-config-tabs">
          <Tabs
            activeKey={tab}
            onChange={(key) => setTab(key as 'poster' | 'section' | 'search')}
            items={[
              { key: 'poster', label: '海报叠层', children: posterTab },
              { key: 'section', label: '分类推荐', children: sectionTab },
              { key: 'search', label: '搜索推荐', children: searchTab }
            ]}
          />
        </div>
      )}

      {editor && (
        <HomeItemEditor
          key={`${editor.kind}:${editor.categoryId}:${editor.item.videoId}`}
          item={editor.item}
          ratio={editor.ratio}
          kind={editor.kind}
          saving={saving}
          onCancel={() => setEditor(null)}
          onSave={(patch) => void saveItem(patch)}
        />
      )}
    </>
  )
}

export default HomeSettingsPanel
