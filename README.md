# cine-box

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

## 品牌资源（Logo / 图标）

Logo 源文件为 `build/icon.svg`，同一份副本放在 `src/renderer/src/assets/logo.svg`，供界面内直接引用。

| 文件 | 用途 |
| --- | --- |
| `build/icon.png` | 1024×1024 母版 PNG |
| `build/icon.ico` | Windows 窗口 / 任务栏 / 安装包图标，含 16–256 多尺寸 |
| `build/icon.icns` | macOS 应用图标，含 16–1024 |
| `resources/icon.png` | 运行时窗口图标（512×512），开发模式与 Linux 使用 |
| `src/renderer/src/assets/logo.svg` | 渲染进程内的 Logo（`index.html` 站点图标也用它） |

图形结构：蓝色圆角方框（`#1296db`）+ **白色实心六边形**（`#ffffff`）+ 蓝色 `TV` 字标，四角透明。
换色时改 SVG 里的 `fill` 即可（第一个 `path` 是白色六边形底衬，后两个是蓝框和字标）。

出图留白：Windows / Linux 用的 `icon.png`、`icon.ico` 和 `resources/icon.png` 按满幅渲染（四周约 0.5% 留白），
避免在任务栏、标题栏里比别的图标显小；macOS 的 `icon.icns` 保留约 6% 留白，符合 Dock 的观感。
