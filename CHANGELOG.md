# Changelog

映盒剧场（cine-box）的版本变更记录。

发版时在顶部新增一节 `## 映盒剧场 vX.Y.Z`，CI 会把这个小节的正文写进 GitHub Release 说明，
客户端的「关于 → 软件更新」也会把它当作更新说明展示。

## 映盒剧场 v1.0.0

> 发布时间：2026-11-16

首个版本：无边框窗口 + 自绘操作栏、中文化的设置与关于页面、托盘与全局快捷键、应用内更新。

### ✨ 新功能

- 自绘窗口操作栏：左侧 Logo 与标题，右侧关于、设置、最小化、最大化、关闭；支持拖拽移动与双击标题栏最大化。
- 设置页面：偏好设置（开机自启、关闭时最小化到托盘、自动下载更新）、快捷键（全局快捷键录制与恢复默认）、外观（跟随系统 / 浅色 / 深色，9 种主题色，默认取 Logo 蓝 `#1296db`）、关于。
- 关于页面：版本与运行环境（Electron / Chromium / Node / 平台架构）、软件更新（检查、下载、重启安装、更新说明）。
- 主题系统：`data-theme` + antd token 双轨，浅色为冷灰底、深色为近黑底，切换不闪白。
- 托盘与快捷键：关闭到托盘、托盘菜单（显示主窗口 / 检查更新 / 退出）、全局快捷键唤起或收起主窗口（默认 `Ctrl+Shift+Space`）。
- 应用内更新：启动 5 秒后静默检查、之后每 4 小时轮询；新版本可自动下载，也可手动确认；下载完成提示重启，正常退出时自动安装；错误提示已中文化。
- 界面固定简体中文：antd `ConfigProvider` 中文语言包与 dayjs 中文日期。

### ⚙️ 构建与发布

- GitHub Actions：CI（lint、typecheck、生产构建）与 Release（Windows / macOS Intel / macOS Apple Silicon / Linux 四平台打包）。
- 统一安装包命名：`cine-box-<version>-<platform>-<arch>.<ext>`。
- electron-builder：Windows NSIS（中文快捷方式与卸载项）、macOS `dmg + zip`、Linux `AppImage + deb`，并裁剪 Chromium 语言包。
- Release 先落草稿，四平台全绿后人工发布；更新源为 GitHub Releases（`0x2one/cine-box`）。
