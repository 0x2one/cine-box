# 第三方组件与许可

## FFmpeg / ffmpeg-static

本应用内置 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 5.3.0 提供的 FFmpeg 6.1.1 可执行文件，仅用于把已缓存的 HLS 视频封装成 MP4（`-c copy`，不重新编码）。

FFmpeg 以 **GPL-3.0-or-later** 发布，完整许可证见 `node_modules/ffmpeg-static/LICENSE`（安装包内为 `resources/app.asar.unpacked/node_modules/ffmpeg-static/LICENSE`）。对应源码：

- ffmpeg-static：https://github.com/eugeneware/ffmpeg-static
- FFmpeg：https://ffmpeg.org/download.html

FFmpeg 作为独立进程被调用，不修改本应用自身的 MIT 许可。
