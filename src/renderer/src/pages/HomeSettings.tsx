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
  Slider,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  LinkOutlined,
  ReloadOutlined,
  UndoOutlined,
  UploadOutlined
} from '@ant-design/icons'
import HomePicture from '../components/HomePicture'

/** 海报叠层的宽高比：1180 窗口下约 984 × 420 */
const HERO_RATIO = 2.34
/** 分类轨道的封面比例，和首页卡片一致 */
const CARD_RATIO = 2 / 3

const HOME_ERRORS: Record<string, string> = {
  NOT_FOUND: '条目已不存在，刷新后再试',
  DUPLICATE: '这个视频已经在海报里了',
  FULL: '海报数量已达上限',
  INVALID_INPUT: '配置内容不合法',
  CACHE_UNAVAILABLE: '视频缓存库不可用'
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * 图片裁剪器：一个按目标比例固定的取景框，拖动图片改变显示区域，滑杆缩放。
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

  const zoomTo = (value: number): void => {
    if (!view || !natural || baseScale <= 0) return
    const width = natural.w * baseScale * view.zoom
    const height = natural.h * baseScale * view.zoom
    const centerX = (view.left + frame.w / 2) / width
    const centerY = (view.top + frame.h / 2) / height
    const zoom = clamp(value, 1, 4)
    const nextWidth = natural.w * baseScale * zoom
    const nextHeight = natural.h * baseScale * zoom
    const next = clampView({
      zoom,
      left: frame.w / 2 - centerX * nextWidth,
      top: frame.h / 2 - centerY * nextHeight
    })
    setView(next)
    emit(next)
  }

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
        <span className="home-editor-crop-hint">拖动调整显示区域</span>
      </div>
      <div className="home-editor-crop-tools">
        <span className="home-editor-crop-label">缩放</span>
        <Slider
          min={1}
          max={4}
          step={0.01}
          value={view?.zoom ?? 1}
          disabled={!natural}
          onChange={zoomTo}
          tooltip={{ formatter: (value) => `${Math.round((value ?? 1) * 100)}%` }}
        />
        <Button size="small" onClick={reset} disabled={!natural}>
          重置
        </Button>
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
              {draftPic ? '拖动图片选择显示区域，保存后按这块区域显示' : '当前使用视频封面'}
            </span>
          </div>

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

          <div className="home-editor-image-actions">
            <Button size="small" onClick={() => selectPic('')} disabled={!draftPic}>
              使用视频封面
            </Button>
            <Button size="small" icon={<UploadOutlined />} onClick={() => void pickLocal()}>
              本地上传
            </Button>
            <Button
              size="small"
              icon={<LinkOutlined />}
              onClick={() => setUrlOpen((value) => !value)}
            >
              图片地址
            </Button>
          </div>

          {urlOpen && (
            <div className="home-editor-url">
              <Input
                autoFocus
                value={url}
                placeholder="https://…/poster.jpg"
                onChange={(event) => setUrl(event.target.value)}
                onPressEnter={applyUrl}
              />
              <Button size="small" onClick={applyUrl}>
                应用
              </Button>
            </div>
          )}

          {covers.length > 0 && (
            <div className="home-editor-covers">
              <span className="home-editor-covers-label">换来源封面</span>
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

/** 一行条目：缩略图 + 标题 / 状态 + 排序、隐藏、编辑、移除 */
function HomeItemRow({
  item,
  ratio,
  index,
  total,
  removeTitle,
  onMove,
  onEdit,
  onToggleHidden,
  onRemove
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
}): React.JSX.Element {
  return (
    <div className={`home-config-row${item.hidden ? ' is-hidden' : ''}`}>
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
  const visibleSections = sections.filter(
    (section) => section.visible && section.categoryVisible
  ).length

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
   * 最新 TOP 切到手动推荐时，先把当前自动带上来的这十几部落成人工列表，
   * 否则切过去会瞬间清空；反过来手动 → 最新，人工条目仍然排在前面。
   */
  const changeRule = async (section: HomeSectionView, rule: HomeRule): Promise<void> => {
    if (rule === section.rule) return
    if (rule === 'manual' && section.items.length > 0) {
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
      <p className="home-config-hint">
        顺序就是首页叠层的顺序；「添加到海报」在控制台「视频」页每行的操作里。隐藏的不会出现在首页，配置仍保留。
      </p>
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
            />
          ))}
        </div>
      )}
    </div>
  )

  const sectionTab = (
    <div className="home-config">
      <p className="home-config-hint">
        每个一级分类对应首页上的一条轨道。手动推荐用「视频」页的「推荐」按钮加片；最新 TOP
        按视频更新时间自动取前 N 部。两种规则都能排序、移除、隐藏、改图。
      </p>
      {sections.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有一级分类，先去「分类」创建"
        />
      ) : (
        sections.map((section) => (
          <section className="home-config-section" key={section.categoryId}>
            <div className="home-config-section-head">
              <div className="home-config-section-name">
                <h3>{section.name}</h3>
                {!section.categoryVisible && <Tag color="warning">分类已在展示端隐藏</Tag>}
                {!section.visible && <Tag color="default">不在首页显示</Tag>}
              </div>
              <div className="home-config-section-actions">
                <label className="home-config-field">
                  <span>在首页显示</span>
                  <Switch
                    checked={section.visible}
                    onChange={(checked) =>
                      void act(
                        window.api.home.saveSection(section.categoryId, { visible: checked })
                      )
                    }
                  />
                </label>
                <label className="home-config-field">
                  <span>显示名</span>
                  <Input
                    key={`${section.categoryId}:${section.title}`}
                    defaultValue={section.title === section.name ? '' : section.title}
                    placeholder={section.name}
                    maxLength={60}
                    className="home-config-title-input"
                    onBlur={(event) => {
                      const value = event.target.value.trim()
                      const current = section.title === section.name ? '' : section.title
                      if (value !== current) {
                        void act(
                          window.api.home.saveSection(section.categoryId, { title: value }),
                          '已更新显示名'
                        )
                      }
                    }}
                    onPressEnter={(event) => event.currentTarget.blur()}
                  />
                </label>
                <label className="home-config-field">
                  <span>规则</span>
                  <Radio.Group
                    size="small"
                    optionType="button"
                    value={section.rule}
                    options={[
                      { label: '手动推荐', value: 'manual' },
                      { label: '最新 TOP', value: 'latest' }
                    ]}
                    onChange={(event) => void changeRule(section, event.target.value as HomeRule)}
                  />
                </label>
                {section.rule === 'latest' && (
                  <label className="home-config-field">
                    <span>数量</span>
                    <InputNumber
                      size="small"
                      min={1}
                      max={50}
                      value={section.topN}
                      className="home-config-topn"
                      onChange={(value) => {
                        if (typeof value === 'number') {
                          void act(window.api.home.saveSection(section.categoryId, { topN: value }))
                        }
                      }}
                    />
                  </label>
                )}
              </div>
            </div>

            {section.rule === 'latest' && (
              <p className="home-config-section-meta">
                该分类共 {section.total} 个视频，按更新时间取前 {section.topN} 部
              </p>
            )}

            {section.items.length === 0 ? (
              <p className="home-config-empty">
                {section.rule === 'manual'
                  ? '还没有推荐视频，去「视频」页点「推荐」加进来'
                  : '这个分类下还没有视频，或者绑定还没配好'}
              </p>
            ) : (
              <div className="home-config-list">
                {section.items.map((item, index) => (
                  <HomeItemRow
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
                  />
                ))}
              </div>
            )}

            {section.rule === 'latest' && section.removedItems.length > 0 && (
              <div className="home-config-removed">
                <span className="home-config-removed-title">
                  已移除 {section.removedItems.length} 部
                </span>
                {section.removedItems.map((item) => (
                  <div className="home-config-removed-row" key={item.videoId}>
                    <span className="home-config-removed-name" title={item.title}>
                      {item.title}
                    </span>
                    <Button
                      type="text"
                      size="small"
                      icon={<UndoOutlined />}
                      onClick={() =>
                        void act(
                          window.api.home.restoreSectionItem(section.categoryId, item.videoId),
                          '已恢复到首页'
                        )
                      }
                    >
                      恢复
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))
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
            { key: 'poster', label: `海报叠层（${posters.length}）`, children: posterTab },
            { key: 'section', label: `分类推荐（${sections.length}）`, children: sectionTab }
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
