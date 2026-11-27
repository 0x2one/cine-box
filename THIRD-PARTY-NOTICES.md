# 第三方组件与许可

## FFmpeg / ffmpeg-static

本应用内置 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 5.3.0 提供的 FFmpeg 6.1.1 可执行文件，仅用于把已缓存的 HLS 视频封装成 MP4（`-c copy`，不重新编码）。

FFmpeg 以 **GPL-3.0-or-later** 发布，完整许可证见 `node_modules/ffmpeg-static/LICENSE`（安装包内为 `resources/app.asar.unpacked/node_modules/ffmpeg-static/LICENSE`）。对应源码：

- ffmpeg-static：https://github.com/eugeneware/ffmpeg-static
- FFmpeg：https://ffmpeg.org/download.html

FFmpeg 作为独立进程被调用，不修改本应用自身的 MIT 许可。

## Model Context Protocol TypeScript SDK

本应用通过 [@modelcontextprotocol/server](https://www.npmjs.com/package/@modelcontextprotocol/server) 2.4.0 与 [@modelcontextprotocol/node](https://www.npmjs.com/package/@modelcontextprotocol/node) 2.1.2 提供 MCP Streamable HTTP 服务，二者以 **Apache-2.0** 发布；完整许可证见各自 npm 包内的 `LICENSE`。

## zod / hono / @hono/node-server

MCP 服务的参数校验与 Node HTTP 适配使用 [zod](https://github.com/colinhacks/zod) 4.2.0、[hono](https://github.com/honojs/hono) 与 [@hono/node-server](https://github.com/honojs/node-server)，均以 **MIT** 发布；完整许可证见对应 npm 包内的 `LICENSE`。
