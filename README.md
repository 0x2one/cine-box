# 映盒剧场（cine-box）

一款用 Electron 构建的桌面影音应用。界面**仅提供简体中文**，无多语言切换。

技术栈：Electron 44 + React 19 + TypeScript 5.9 + antd 6 + Tailwind CSS 4，构建用 electron-vite 6 / Vite 8，打包用 electron-builder 26，自动更新用 electron-updater 6。

## 功能

- **自绘窗口操作栏**：Windows / Linux 无边框（`frame: false`），macOS 保留原生红绿灯；左侧 Logo 与标题，右侧控制台、设置、最小化、最大化、关闭。支持拖拽移动、双击标题栏最大化。
- **设置页面**：偏好设置（开机自启、关闭时最小化到托盘、自动下载更新）、快捷键（全局快捷键录制与恢复默认）、外观（跟随系统 / 浅色 / 深色，9 种主题色，默认取 Logo 蓝 `#1296db`）、关于。
- **控制台**：左侧菜单（概览 / 站点 / 任务 / 日志）+ 右侧面板；「站点」以卡片列出采集站点，可新增、编辑、删除（右上角 + 按钮、卡片上的标签 / 铅笔 / 垃圾桶图标按钮），字段为名称、显示名、地址、XML / JSON、备注，并自动生成 32 位 UUID 与创建 / 更新时间，数据存 `userData/Data/cine-box.db`（SQLite）；点卡片上的标签按钮会按站点格式请求 `ac=list`，弹窗展示该站点返回的视频分类。其余分区仍是空状态占位。
- **关于与更新**：应用介绍与版本号、检查更新、下载、重启安装、更新说明。
- **托盘与快捷键**：关闭到托盘、托盘菜单（显示主窗口 / 检查更新 / 退出）、全局快捷键唤起或收起主窗口（默认 `Ctrl+Shift+Space`）。
- **主题系统**：`data-theme` + CSS 变量与 antd token 双轨，浅色冷灰、深色近黑，切换不闪白。
- **内容区**：首页仍是空状态占位，业务界面尚未接入。

## 快速开始

环境要求：Node.js 22+、pnpm 12（仓库只有 `pnpm-lock.yaml`，请勿混用 npm / yarn）。

```bash
pnpm install   # postinstall 会下载 Electron 并重建应用依赖
pnpm dev       # 启动开发环境（主进程 / 预加载改动会自动重启）
```

## 常用命令

| 命令                | 作用                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`          | 开发模式，HMR                                                               |
| `pnpm lint`         | ESLint（`eslint --cache .`）                                                |
| `pnpm typecheck`    | 主进程 / 预加载 + 渲染层两套 tsconfig 类型检查                              |
| `pnpm build`        | typecheck 后执行 `electron-vite build`，产物在 `out/`                       |
| `pnpm build:win`    | 出 Windows 安装包（`pnpm build:mac` / `build:linux` 同理）                  |
| `pnpm build:unpack` | 只出免安装目录（`dist/win-unpacked`、`dist/mac`、`dist/linux-unpacked` 等） |
| `pnpm format`       | Prettier 格式化                                                             |

没有测试套件；验证门槛是 `pnpm lint && pnpm build`（CI 在 Node 22 / pnpm 12.15.0 上先 lint 再 build）。

`build:win` / `build:mac` / `build:linux` 需要在本机对应系统上执行（安装包不能跨平台出）；CI 的 Release 工作流已经按平台拆成四个 job。

## 目录结构

```
src/main        主进程：窗口、托盘、全局快捷键、设置与站点存储、自动更新
src/preload     contextBridge 暴露的 API，渲染层类型见 src/preload/api.d.ts
src/renderer    React 应用（@renderer/* 指向 src/renderer/src）
build/          打包资源：图标源文件与各平台图标
resources/      运行时窗口 / 托盘图标
docs/           外部采集接口说明（暂无代码接入）
out/            electron-vite 产物（git 忽略）
dist/           electron-builder 产物（git 忽略）
```

IPC 接口新增要改三处：主进程 `ipcMain.handle`、`src/preload/index.ts` 的 `ipcRenderer.invoke`、`src/preload/api.d.ts` 里手写的 `Api` 类型。渲染层只允许通过 `window.api` / `window.electron` 访问。

## 设置与本地数据

- 应用设置存 `app.getPath('userData')/app-settings.json`（Windows 为 `%APPDATA%\cine-box\app-settings.json`），明文 JSON，没有用 electron-store。

| 字段           | 含义                                           | 默认值             |
| -------------- | ---------------------------------------------- | ------------------ |
| `openAtLogin`  | 开机自启，以系统登录项为准，每次读取都回读系统 | `false`            |
| `closeToTray`  | 关闭窗口时最小化到托盘，而不是退出             | `false`            |
| `autoDownload` | 检测到新版本后自动下载                         | `true`             |
| `showShortcut` | 全局快捷键，空字符串表示未启用                 | `Ctrl+Shift+Space` |

- 外观偏好存在渲染层 `localStorage`：`theme`（`system` / `light` / `dark`）与 `accent`（主题色 key）。
- 控制台站点存 `app.getPath('userData')/Data/cine-box.db`（SQLite，`sites` 表，WAL 模式），新增时由主进程生成 32 位 UUID（UUID 去掉横线）与 ISO 8601 创建 / 更新时间；字段缺失或手工改坏时按默认值兜底。每次抓取到的视频分类写入 `site_categories` 表，通过 `site_id` 关联站点，同样带 32 位 ID 与创建 / 更新时间，同一站点内按采集接口的分类 ID 去重。

## 自动更新

应用内更新走 `electron-updater`，更新源是 `electron-builder.yml` 里 `publish` 指向的 GitHub Releases（`0x2one/cine-box`）。

- 启动 5 秒后检查一次，之后每 4 小时轮询；只有**已发布**的 Release 会被检测到，草稿对客户端不可见。
- 是否自动下载由「偏好设置 - 自动下载更新」控制；下载完成后可立即重启安装，正常退出时也会自动安装。

开发模式下更新检查默认关闭，需要联调时：

```bash
# Windows PowerShell
$env:CINEBOX_DEV_UPDATE='1'; pnpm dev
# macOS / Linux
CINEBOX_DEV_UPDATE=1 pnpm dev
```

此时「关于 → 软件更新」会真实请求 GitHub Releases（配置见 `dev-app-update.yml`）。

平台限制：

- **Windows**：NSIS 安装包支持增量更新；安装包未签名，首次运行会触发 SmartScreen 提示。
- **macOS**：自动更新需要 `zip` 产物 + 代码签名；当前 `notarize: false`，可以打包但 Squirrel.Mac 无法自动安装更新。
- **Linux**：只有 AppImage 支持自更新，deb 需手动升级。

国内网络打包时若卡在下载 Electron / electron-builder 二进制资源，可补镜像环境变量：

```bash
# Windows PowerShell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

## 发布流程

打包与发布由 GitHub Actions 完成：

| 工作流                                                           | 触发                       | 作用                                                                           |
| ---------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml)           | push 到 `master`、PR、手动 | 安装依赖、lint、typecheck + 生产构建                                           |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | 推送 `v*` 标签、手动       | 四平台打包并上传到 GitHub Releases **草稿**，再用 CHANGELOG 填好草稿标题与说明 |

发版（完整清单见 [`.agents/skills/cine-box-release/SKILL.md`](.agents/skills/cine-box-release/SKILL.md)）：

1. 在 [`CHANGELOG.md`](CHANGELOG.md) 顶部新增 `## 映盒剧场 vX.Y.Z` 小节；
2. 把 `package.json` 的 `version` 改成同一版本；
3. 提交后打标签：`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`；
4. CI 的 guard job 校验「标签 = `package.json` 版本」且 CHANGELOG 小节存在，四平台全绿后生成草稿 Release；
5. 确认产物齐全后人工发布：`gh release edit vX.Y.Z --draft=false -R 0x2one/cine-box`。

草稿是有意为之：四个平台并发上传时，`publish.releaseType: release` 会被拆成多条同 tag 的 Release。

产物命名统一为 `cine-box-<version>-<platform>-<arch>.<ext>`：

| 文件                                                 | 说明                                      |
| ---------------------------------------------------- | ----------------------------------------- |
| `cine-box-<ver>-win-x64.exe`                         | Windows NSIS 安装包                       |
| `cine-box-<ver>-mac-x64.dmg` / `.zip`                | Intel                                     |
| `cine-box-<ver>-mac-arm64.dmg` / `.zip`              | Apple Silicon（`zip` 是自动更新必需产物） |
| `cine-box-<ver>-linux-x86_64.AppImage`               | Linux                                     |
| `cine-box-<ver>-linux-amd64.deb`                     | Linux                                     |
| `latest.yml` / `latest-mac.yml` / `latest-linux.yml` | 自动更新索引，文件名固定不可改            |

## 品牌资源

Logo 源文件为 [`build/icon.svg`](build/icon.svg)，`src/renderer/src/assets/logo.svg` 是同一份副本，供界面直接引用；改 Logo 时两者与下面的图标要一起更新。

| 文件                               | 用途                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `build/icon.png`                   | 1024×1024 母版 PNG                                   |
| `build/icon.ico`                   | Windows 窗口 / 任务栏 / 安装包图标，含 16–256 多尺寸 |
| `build/icon.icns`                  | macOS 应用图标，含 16–1024                           |
| `resources/icon.png`               | 运行时窗口与托盘图标（512×512）                      |
| `src/renderer/src/assets/logo.svg` | 渲染进程内的 Logo（`index.html` 站点图标也用它）     |

图形结构：蓝色圆角方框（`#1296db`）+ 白色实心六边形（`#ffffff`）+ 蓝色 `TV` 字标，四角透明。换色时改 SVG 里的 `fill`（第一个 `path` 是白色六边形底衬，后两个是蓝框和字标）。

出图留白：Windows / Linux 用的 `icon.png`、`icon.ico` 和 `resources/icon.png` 按满幅渲染（四周约 0.5% 留白），避免在任务栏、标题栏里比别的图标显小；macOS 的 `icon.icns` 保留约 6% 留白，符合 Dock 观感。

## 其它文档

- [`AGENTS.md`](AGENTS.md)：工程约定（命令、目录、IPC、窗口与主题的坑、发版约束）。
- [`CHANGELOG.md`](CHANGELOG.md)：版本变更记录，同时作为 Release 说明与客户端更新说明。
- [`docs/采集接口参数说明.md`](docs/采集接口参数说明.md)：外部 XML 采集接口参数，目前还没有代码接入。

## License

[MIT](LICENSE)
