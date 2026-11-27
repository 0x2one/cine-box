# MCP 服务

映盒剧场的 MCP（Model Context Protocol）服务把站点、分类、采集、推荐、共享、备份、网络、下载等操作暴露给 AI 客户端。服务运行在应用主进程内，工具调用复用桌面界面同一套 IPC 处理逻辑，所以副作用（缓存失效、推荐重算、采集唤醒、局域网状态刷新等）与点界面按钮完全一致。

- 协议：MCP `2026-07-28`（Streamable HTTP），并兼容 2025-era 客户端。
- 传输：只做 HTTP，不做 stdio；旧版 HTTP+SSE 传输不支持。
- 能力：只声明 `tools`，没有 resources / prompts / sampling / OAuth。
- 响应：JSON（`responseMode: 'json'`），不实现服务端 SSE 推送；GET / DELETE 返回 405。

## 1. 开启

打开「设置 › MCP」：

1. 打开「MCP 服务」开关。
2. 监听地址默认 `127.0.0.1`（仅本机），端口默认 `3927`。
3. 本机访问可以留空令牌；监听 `0.0.0.0` 或本机局域网 IP 前必须先设置访问令牌。
4. 点「保存并应用」。开关保存的是「期望状态」，应用重启后会按它自动启动。
5. 复制面板里的客户端配置，粘贴到 AI 客户端。

默认地址：`http://127.0.0.1:3927/mcp`。

配置存放在 `app-settings.json` 的 `mcp` 字段（`enabled` / `host` / `port` / `token`）。MCP 配置**不进入备份**；备份只覆盖站点、在线分类、本地分类、绑定与定时计划。

## 2. 访问与安全

- **默认只监听回环**：`127.0.0.1` 只有本机进程能访问。选择 `0.0.0.0` 或本机局域网 IP 时，强制要求非空令牌。
- **令牌**：支持两种传法：
  - `Authorization: Bearer <token>`
  - URL 查询参数 `?token=<token>`
    令牌使用 `crypto.timingSafeEqual` 比较；修改令牌不需要重启服务，下一次请求立即生效。
- **Host 校验**：只接受 `localhost` / `127.0.0.1` / 本机 IPv4 的 Host 头，防止 DNS rebinding；非法 Host 返回 403。
- **Origin 校验**：没有 Origin 的原生客户端放行；有 Origin 时只接受回环 / 本机 IPv4 来源，非法 Origin 返回 403。
- **限流**：每来源 600 次 / 分钟，超出返回 429。
- **体积**：请求体上限 8 MiB，超出返回 413。
- **无 TLS / 无 CORS / 无 OAuth**：只适合本机或可信局域网。不要在公共 Wi-Fi 上监听 `0.0.0.0`；局域网下令牌是明文 HTTP 传输。
- **写操作没有二次确认**：MCP 客户端可以直接修改 / 删除数据；`backup_restore` 额外要求 `confirm: true`，恢复前应用会自动备份当前数据。

## 3. 客户端配置

### Cursor（`mcp.json`）

```json
{
  "mcpServers": {
    "cine-box": {
      "url": "http://127.0.0.1:3927/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

没有设置令牌时省略 `headers`。

### Claude Desktop（通过 mcp-remote 转发）

```json
{
  "mcpServers": {
    "cine-box": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:3927/mcp",
        "--header",
        "Authorization: Bearer <token>"
      ]
    }
  }
}
```

### 只接受 URL 的客户端

设置令牌后，也可以直接使用带查询参数的地址：

```text
http://127.0.0.1:3927/mcp?token=<token>
```

### Cherry Studio / 其它 Streamable HTTP 客户端

- 传输类型：Streamable HTTP
- URL：`http://<监听地址>:<端口>/mcp`
- 请求头：`Authorization: Bearer <token>`（有令牌时）

## 4. 协议与自检

### 2026-07-28（现代）

每个请求都是独立 POST，需要：

- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method: <method>`；`tools/call` 还要 `Mcp-Name: <tool name>`
- `params._meta` 里带 `io.modelcontextprotocol/protocolVersion` 与 `io.modelcontextprotocol/clientCapabilities`
- `Accept: application/json, text/event-stream`

服务端支持 `server/discover`、`tools/list`、`tools/call`；没有 `initialize` / 会话 / ping。

```bash
curl -s -X POST http://127.0.0.1:3927/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

### 2025-era（兼容）

旧版客户端仍可使用无状态 `initialize`：

```bash
curl -s -X POST http://127.0.0.1:3927/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

随后直接 POST `tools/list` / `tools/call` 即可。服务端不维护会话，GET / DELETE 返回 405。

### 工具结果

工具结果统一是 `content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]`。业务失败返回 `isError: true`，文本里是 `{ "ok": false, "error": "...", "message": "..." }`；被标记为只读的工具带 `readOnlyHint`，删除 / 清空 / 恢复类工具带 `destructiveHint`。

## 5. 工具目录

id 说明：站点 / 分类 / 在线分类 / 下载记录 id 是 32 位十六进制字符串；视频 id 是数字。写工具只接受已存在的 id，先用对应的 list / get 工具取。

### 站点

| 工具                     | 作用         | 关键参数                                                                                   |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------ |
| `site_list`              | 列出全部站点 | 无                                                                                         |
| `site_add`               | 添加站点     | `name`、`address` 必填；`format`、`display`、`remark`、`onlineSearch`、`disabled`、`adult` |
| `site_update`            | 编辑站点     | `id` + 要改的字段；未传字段沿用当前值                                                      |
| `site_test_search`       | 在线检索自检 | `siteId`、`keyword`；只请求不写库                                                          |
| `site_online_categories` | 站点在线分类 | `siteId`；库里没有时抓取一次                                                               |

### 分类与绑定

| 工具                    | 作用                   | 关键参数                                                      |
| ----------------------- | ---------------------- | ------------------------------------------------------------- |
| `category_list`         | 列出分类树             | `includeAdult`（默认 true）                                   |
| `category_create`       | 创建分类               | `name`、`parentId?`、`adult?`                                 |
| `category_create_child` | 创建子分类             | `parentId`、`name`、`adult?`                                  |
| `category_update`       | 编辑分类               | `id`、`name?`、`parentId?`、`adult?`                          |
| `category_move`         | 排序 / 移动            | `id`、`targetId?`、`placement`：`before` / `after` / `inside` |
| `category_set_adult`    | 标记 18+               | `id`、`adult`                                                 |
| `category_set_visible`  | 显示 / 隐藏            | `id`、`visible`                                               |
| `category_bindings`     | 分类的绑定             | `categoryId`                                                  |
| `binding_counts`        | 各分类绑定数           | 无                                                            |
| `site_bindings`         | 站点的绑定             | `siteId`                                                      |
| `binding_bind`          | 绑定在线分类到本地分类 | `items: [{ siteId, siteCategoryId }]`、`categoryId`           |
| `binding_unbind`        | 解除绑定               | `items`                                                       |

### 采集与进度

| 工具                      | 作用            | 关键参数                                                                                            |
| ------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `collect_start`           | 创建采集任务    | `siteId`、`mode`（incremental / full / search）、`fetchRange`、`restart?`、`cacheDetail?`、`words?` |
| `collect_pause`           | 暂停            | `siteId`、`mode?`、`fetchRange?`                                                                    |
| `collect_resume`          | 按断点继续      | `siteId`、`mode`、`fetchRange`；检索模式自动补未完成关键词                                          |
| `collect_restart`         | 从头重采        | `siteId`、`mode`、`fetchRange`、`words?`                                                            |
| `collect_progress`        | 采集进度        | `siteId?`                                                                                           |
| `collect_set_concurrency` | 采集并发        | `value`（1–4）                                                                                      |
| `collect_clear_progress`  | 清空进度        | 无；有任务在跑 / 排队时返回 `BUSY`                                                                  |
| `collect_schedule_list`   | 定时计划列表    | 无                                                                                                  |
| `collect_schedule_save`   | 创建 / 更新定时 | `siteId`、`timing`、`intervalMinutes` / `dailyTime`、`mode`、`fetchRange`、`enabled`、`cacheDetail` |
| `collect_schedule_remove` | 删除定时        | `siteId`                                                                                            |

### 视频

| 工具                | 作用            | 关键参数                                                                                                         |
| ------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `video_list`        | 搜索 / 列出视频 | `keyword`、`categoryId`、`categoryIds`、`page`、`pageSize`、`visibility`、`includeDisabledSites`、`includeAdult` |
| `video_get`         | 视频详情        | `videoId`、`autoFetch`（默认 true）、`includeAdult`（默认 true）                                                 |
| `video_update`      | 编辑信息        | `videoId` + `note` / `intro` / `vodActor` / `vodClass` / `pic` / `picSiteId` / `hidden` / `adult`                |
| `video_set_hidden`  | 隐藏 / 显示     | `videoId`、`hidden`                                                                                              |
| `video_set_adult`   | 人工 18+        | `videoId`、`adult`                                                                                               |
| `video_add_poster`  | 加入推荐海报    | `videoId`                                                                                                        |
| `video_add_section` | 加入推荐分类    | `videoId`、`categoryId`；视频必须绑定该一级分类                                                                  |
| `video_cache`       | 触发缓存        | `videoId`、`sourceId?`、`lineIndex?`、`episodeIndexes?` 或 `allEpisodes: true`                                   |

### 推荐

| 工具                               | 作用             | 关键参数                                             |
| ---------------------------------- | ---------------- | ---------------------------------------------------- |
| `home_get`                         | 推荐配置         | `full?`；默认精简字段，`full: true` 返回原始 feed    |
| `poster_reorder`                   | 海报排序         | `videoIds`                                           |
| `poster_remove`                    | 删除海报         | `videoId`                                            |
| `poster_update`                    | 编辑海报         | `videoId` + 展示字段 / 图片 / 裁剪 / `hidden`        |
| `poster_set_hidden`                | 隐藏海报         | `videoId`、`hidden`                                  |
| `section_configure`                | 分类推荐配置     | `categoryId` + `visible` / `title` / `rule` / `topN` |
| `section_set_visible`              | 显示 / 隐藏轨道  | `categoryId`、`visible`                              |
| `section_reorder_categories`       | 轨道排序         | `categoryIds`                                        |
| `section_reorder_items`            | 轨道内视频排序   | `categoryId`、`videoIds`                             |
| `section_item_update`              | 编辑轨道条目     | `categoryId`、`videoId` + 展示字段 / `hidden`        |
| `section_item_remove`              | 移除轨道条目     | `categoryId`、`videoId`                              |
| `section_item_restore`             | 恢复轨道条目     | `categoryId`、`videoId`                              |
| `search_recommend_configure`       | 搜索推荐配置     | `rule` / `topN`                                      |
| `search_recommend_reorder`         | 搜索推荐排序     | `videoIds`                                           |
| `search_recommend_item_update`     | 编辑搜索推荐条目 | `videoId` + 展示字段 / `hidden`                      |
| `search_recommend_item_set_hidden` | 隐藏搜索推荐     | `videoId`、`hidden`                                  |
| `search_recommend_item_remove`     | 移除搜索推荐     | `videoId`                                            |
| `search_recommend_item_restore`    | 恢复搜索推荐     | `videoId`                                            |

### 共享与容量

| 工具           | 作用                | 关键参数                                 |
| -------------- | ------------------- | ---------------------------------------- |
| `lan_state`    | 共享服务状态 / 地址 | 无                                       |
| `lan_start`    | 启动 / 修改监听     | `host?`、`port?`；成功后配置落盘         |
| `lan_stop`     | 停止共享            | 无                                       |
| `capacity_get` | 缓存容量详情        | `sites`（默认 true）；只读，没有清理工具 |

### 备份与日志

| 工具               | 作用     | 关键参数                                          |
| ------------------ | -------- | ------------------------------------------------- |
| `backup_create`    | 立即备份 | 无                                                |
| `backup_restore`   | 恢复备份 | `id` 或 `path` 二选一，且必须 `confirm: true`     |
| `backup_list`      | 备份列表 | 无                                                |
| `backup_directory` | 备份目录 | 无                                                |
| `log_list`         | 获取日志 | `siteId?`、`level?`、`since?`、`order?`、`limit?` |
| `log_clear`        | 清空日志 | `siteId?`                                         |

### 网络与内容

| 工具                | 作用          | 关键参数                                   |
| ------------------- | ------------- | ------------------------------------------ |
| `network_get`       | 代理配置      | 无；密码脱敏为 `***`                       |
| `network_set`       | 修改代理      | 部分字段；`password: '***'` 表示保留原密码 |
| `network_test`      | 验证代理      | `settings?`（草稿）、`url?`                |
| `content_get_adult` | 读取 18+ 开关 | 无                                         |
| `content_set_adult` | 设置 18+ 开关 | `enabled`                                  |

### 下载设置

| 工具                               | 作用           | 关键参数           |
| ---------------------------------- | -------------- | ------------------ |
| `download_usage`                   | 存储占用       | 无                 |
| `download_get_path`                | 读取保存位置   | 无                 |
| `download_set_path`                | 设置保存位置   | `path`（绝对路径） |
| `download_get_concurrency`         | 读取同时下载数 | 无                 |
| `download_set_concurrency`         | 设置同时下载数 | `value`（1–5）     |
| `download_get_segment_concurrency` | 读取分片并发   | 无                 |
| `download_set_segment_concurrency` | 设置分片并发   | `value`（1–6）     |

### 下载中心

| 工具                         | 作用        | 关键参数                                        |
| ---------------------------- | ----------- | ----------------------------------------------- |
| `download_center_list`       | 下载记录    | `id?`、`videoId?`、`status?`、`kind?`、`limit?` |
| `download_center_progress`   | 进度 / 状态 | `ids?`                                          |
| `download_center_export_mp4` | 缓存转 MP4  | `ids`、`force?`                                 |

## 6. 常见问题

**连接返回 401**

监听时设置了令牌，但客户端没有带 `Authorization: Bearer <token>`，或带了错误的令牌。检查面板里的令牌和客户端配置；查询参数 `?token=` 也可以。

**连接返回 403**

- `Invalid Host`：客户端用了域名或非本机 Host。请使用面板里显示的 IP / `127.0.0.1`。
- `Invalid Origin`：请求来自浏览器且 Origin 不是本机地址；请用原生 MCP 客户端。

**端口被占用 / 启动失败**

换一个 1024–65535 的端口。面板会保留「已开启」状态并显示错误，修正后点「保存并应用」重试。

**监听 0.0.0.0 被拒绝**

非回环监听必须设置访问令牌。先设置令牌再保存。

**客户端只支持 stdio**

用 `mcp-remote` 或客户端自带的 HTTP 桥接转发到 `/mcp`；本服务不提供 stdio。

**工具调用返回 BUSY / NO_PROGRESS / NOT_BOUND**

这些是业务错误：采集任务在跑时不能清空进度；继续采集需要已有进度；推荐分类要求视频已绑定该一级分类。按返回的 `message` 调整参数。

**`home_get` 太大**

默认已经是精简口径；仍嫌大时不要传 `full: true`，或改用具体分类的工具读取需要的那条轨道。

## 7. 开发说明

目录：

```
src/main/mcp/
  mcp-settings.ts   配置类型 / 默认值 / 规范化 / 校验（不依赖 electron）
  mcp-types.ts      状态、快照、controller 注入类型
  mcp-server.ts     HTTP 监听、鉴权、Host/Origin、SDK handler、启停
  channels.ts       工具依赖的 IPC 通道清单
  tools/            按域分组的工具注册
    sites.ts / categories.ts / collect.ts / videos.ts / home.ts
    lan-capacity.ts / backup-logs.ts / network-content.ts / downloads.ts
```

新增工具：

1. 在 `tools/*.ts` 里 `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`。
2. 工具 handler 用 `runTool(async () => { ... })` 包住；内部用 `callTool(invoke, MCP_CHANNELS.xxx, ...)` 调既有 IPC。
3. 如果用到新的 IPC 通道，在 `channels.ts` 增加常量；启动时会检查 `MCP_REQUIRED_CHANNELS` 是否都注册。
4. 只读工具标 `readOnlyHint`，删除 / 清空 / 恢复标 `destructiveHint`。

主进程的约定：

- 新增 / 修改 IPC handler 时继续使用 `handleIpc`（`src/main/index.ts` 顶部），它会同时注册到 `ipcMain` 并留一份引用给 `invokeInternal`，MCP 工具才能复用同一套逻辑。
- MCP controller 不 import electron；`settings` / `version` / `invoke` / `onChange` 都由 `index.ts` 注入，方便独立烟测。
- 协议由 `@modelcontextprotocol/server@2.4.0` + `@modelcontextprotocol/node@2.1.2` 处理，Zod 为 `4.2.0`；不要手写 JSON-RPC 头校验。
- MCP 配置随 `app-settings.json` 落盘，不进入备份；修改配置的 IPC 是 `mcp:get` / `mcp:set`，状态变化推 `mcp:changed`。
