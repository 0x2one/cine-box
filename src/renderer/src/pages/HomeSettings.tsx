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
/** 分类轨道的封面比例，和首页卡片一致 */
const CARD_RATIO = 2 / 3

/** 两个 tab 的说明：放在标题行右侧，超长省略，悬停看全文 */
const POSTER_HINT =
  '顺序就是首页叠层的顺序，拖动行或点上 / 下箭头都能调整；「添加到海报」在控制台「视频」页每行的操作里。隐藏的不会出现在首页，配置仍保留。'
const SECTION_HINT =
  '每个一级分类对应首页上的一条轨道。自定义用「视频」页的「推荐」按钮加片；TOP 按视频更新时间自动取前 N 部。两种规则都能排序、移除、隐藏、改图。'

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
  kind: 'poster' | 'section'
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
      .detail(item.videoId, { autoFetch: false })
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
            留空表示沿用视频库里的值；这里改的只影响首页，不会动采集到的数据。
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
              <span className="home-editor-label">在首页隐藏</span>
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
        <Tooltip title={item.hidden ? '恢复显示' : '在首页隐藏'}>
          <Button
            type="text"
            size="small"
            icon={item.hidden ? <EyeOutlined /> : <EyeInvisibleOutlined />}
            aria-label={item.hidden ? '恢复显示' : '在首页隐藏'}
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
 * 一张推荐卡片：封面按轨道比例取景（和首页看到的一致），点封面或片名编辑。
 * 整卡可拖，落点按指针在卡片的左 / 右半边决定插到前面还是后面；操作条悬停或聚焦时浮出。
 */
function HomeItemCard({
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
            title={item.hidden ? '恢复显示' : '在首页隐藏'}
            aria-label={item.hidden ? '恢复显示' : '在首页隐藏'}
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
 * 控制台「首页」：海报叠层的排序 / 隐藏 / 移除，一级分类在首页的显示与推荐规则。
 * 条目本身（视频信息覆盖、自定义图片与裁剪）走同一个编辑弹窗。
 */
function HomeSettingsPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [feed, setFeed] = useState<HomeFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<'poster' | 'section'>('poster')
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<{
    kind: 'poster' | 'section'
    categoryId: string
    ratio: number
    item: HomeItemView
  } | null>(null)
  /** 拖动排序的源行与落点：海报和分类推荐共用，同一时间只会有一个拖动 */
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: number; edge: DragEdge } | null>(null)
  /** 展开的分组（默认全收起，展开状态记到 localStorage）；「已移除」列表只在本页 */
  const [expanded, setExpanded] = useState<string[]>(readExpanded)
  const [removedOpen, setRemovedOpen] = useState<string[]>([])

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
    } catch {
      // 存不下就只在本次会话里生效
    }
  }, [expanded])

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    try {
      const result = await window.api.home.get()
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
  const posterIds = posters.map((item) => item.videoId)
  const visibleSections = sections.filter(
    (section) => section.visible && section.categoryVisible
  ).length
  /** 标题行右侧的说明跟着当前 tab 走 */
  const hint = tab === 'poster' ? POSTER_HINT : SECTION_HINT

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
   * - TOP → 自定义：只有「从没编辑过自定义列表」时才把当前 TOP 列表落成人工列表；
   *   编辑过（改信息 / 移除 / 排序 / 清空）就原样保留，不再被 TOP 覆盖。
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

  const saveItem = async (patch: HomeItemPatch): Promise<void> => {
    if (!editor) return
    setSaving(true)
    const ok =
      editor.kind === 'poster'
        ? await act(window.api.home.updatePoster(editor.item.videoId, patch), '已保存')
        : await act(
            window.api.home.updateSectionItem(editor.categoryId, editor.item.videoId, patch),
            '已保存'
          )
    setSaving(false)
    if (ok) setEditor(null)
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
                  item.hidden ? '已恢复显示' : '已在首页隐藏'
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
      {sections.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有一级分类，先去「分类」创建"
        />
      ) : (
        sections.map((section) => {
          const isCollapsed = !expanded.includes(section.categoryId)
          const showRemoved = removedOpen.includes(section.categoryId)
          return (
            <section
              className={`home-config-section${isCollapsed ? ' is-collapsed' : ''}`}
              key={section.categoryId}
            >
              <div className="home-config-section-head">
                <div className="home-config-section-title">
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
                    title="点一下改首页显示名，留空使用分类名"
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
                      : `共 ${section.total} 部`}
                  </span>
                  {!section.categoryVisible && <Tag color="warning">分类已隐藏</Tag>}
                  {!section.visible && <Tag color="default">不在首页显示</Tag>}
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
                      title="在首页显示这条轨道"
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
                              : '从首页移除这部剧？之后可以在下方恢复'
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
                              item.hidden ? '已恢复显示' : '已在首页隐藏'
                            )
                          }
                          onRemove={() =>
                            void act(
                              window.api.home.removeSectionItem(section.categoryId, item.videoId),
                              '已从首页移除'
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
                              title={`${item.title} · 点击恢复到首页`}
                              onClick={() =>
                                void act(
                                  window.api.home.restoreSectionItem(
                                    section.categoryId,
                                    item.videoId
                                  ),
                                  '已恢复到首页'
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

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">
            海报 {posters.length} 张 · 分类 {visibleSections}/{sections.length} 个
          </span>
          <Tooltip title={<div style={{ maxWidth: 360 }}>{hint}</div>} placement="bottomLeft">
            <span className="home-config-tip" tabIndex={0}>
              <ExclamationCircleOutlined className="home-config-tip-icon" />
              <span className="home-config-tip-text">{hint}</span>
            </span>
          </Tooltip>
        </p>
        <div className="settings-panel-actions">
          <Tooltip title="重新读取首页配置">
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
        <Empty description="首页配置读取失败">
          <Button onClick={() => void load()}>重新读取</Button>
        </Empty>
      ) : (
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as 'poster' | 'section')}
          items={[
            { key: 'poster', label: '海报叠层', children: posterTab },
            { key: 'section', label: '分类推荐', children: sectionTab }
          ]}
        />
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
