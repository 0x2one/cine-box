import type { ReactElement } from 'react'

/**
 * 下载中心图标：一根细箭头落进托盘，描边和旁边的控制台 / 设置图标一样细，
 * 比 antd 的 DownloadOutlined（实心厚箭头 + 长底托）在小尺寸下干净得多。
 * 尺寸跟随字号（1em），颜色由外层的 `.titlebar-action` 给。
 */
export default function DownloadIcon(): ReactElement {
  return (
    <svg
      className="titlebar-download-icon"
      viewBox="0 0 1024 1024"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="88"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M512 144v480" />
      <path d="M304 432l208 208 208-208" />
      <path d="M880 640v171a85 85 0 0 1-85 85H229a85 85 0 0 1-85-85V640" />
    </svg>
  )
}
