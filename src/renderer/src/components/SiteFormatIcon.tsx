import type { ReactElement } from 'react'

/**
 * 采集格式图标：XML 用「</>」、JSON 用一对花括号，比「XML / JSON」文字 Tag 省地方，
 * 一瞥就能分开两种接口。尺寸跟随字号（1em），颜色由外层的 `.site-card-format` 给。
 * 图形尽量铺满 1024 的画布，和 antd 图标（地球）放一起时才不会显得小一圈。
 */
export default function SiteFormatIcon({ format }: { format: SiteFormat }): ReactElement {
  if (format === 'json') {
    return (
      <svg
        viewBox="0 0 1024 1024"
        width="1em"
        height="1em"
        fill="none"
        stroke="currentColor"
        strokeWidth="96"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M352 96c-72 0-72 96-72 168v132c0 72-56 92-104 116 48 24 104 44 104 116v132c0 72 0 168 72 168" />
        <path d="M672 96c72 0 72 96 72 168v132c0 72 56 92 104 116-48 24-104 44-104 116v132c0 72 0 168-72 168" />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 1024 1024"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="96"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M430 200 150 512 430 824" />
      <path d="M640 132 430 892" />
      <path d="M594 200 874 512 594 824" />
    </svg>
  )
}
