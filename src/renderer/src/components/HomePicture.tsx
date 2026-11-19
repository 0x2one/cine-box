import '../assets/home.css'

/**
 * 首页图片的统一渲染：自定义图片按归一化裁剪框定位，其余按 cover 铺满。
 * 首页卡片、海报叠层与控制台的预览缩略图共用，保证三处看到的是同一块画面。
 */
function HomePicture({
  item,
  eager
}: {
  item: Pick<HomeItemView, 'pic' | 'crop' | 'customPic' | 'title'>
  eager?: boolean
}): React.JSX.Element {
  const crop = item.crop
  const cropped = item.customPic && crop.w > 0 && crop.h > 0
  const style = cropped
    ? {
        width: `${100 / crop.w}%`,
        height: `${100 / crop.h}%`,
        left: `${(-crop.x / crop.w) * 100}%`,
        top: `${(-crop.y / crop.h) * 100}%`
      }
    : undefined

  return (
    <div className="home-picture">
      <span className="home-picture-letter" aria-hidden="true">
        {item.title.trim().slice(0, 1) || '映'}
      </span>
      {item.pic && (
        <img
          src={item.pic}
          alt=""
          style={style}
          className={cropped ? 'is-crop' : undefined}
          loading={eager ? 'eager' : 'lazy'}
          decoding={eager ? 'sync' : 'async'}
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden'
          }}
        />
      )}
    </div>
  )
}

export default HomePicture
