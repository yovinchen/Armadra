# 架构

> 下一阶段目标见 [画布工作平台设计总纲](./canvas-platform-design.md)及其专项文档：Go 常驻 Host、Protobuf、后台调度和跨端能力均为待实施方案。本文件继续描述当前实现，不将目标能力提前计入现状。

> 当前实现的架构。画布层细节见 [tldraw-canvas-plan.md](./tldraw-canvas-plan.md)，
> Agent 运行时与接口契约见 [v3-agent-terminal-plan.md](./v3-agent-terminal-plan.md)。
> 选型演进的原始讨论见 [ChatGPT 会话归档](./research/chatgpt-conversation-archive.md)。

## 1. 定位

独立 Go Host 已有身份、单实例、后台启停和 Protobuf 基础。桌面启动时异步启动/发现 Host，设置页可显式检查连接；Go Host 的生命周期独立于界面。默认应用业务仍由下述 Rust Runtime 提供，其原退出清理保留；尚未切换业务数据库或接入 Host 调度。实际进度见 [平台实施记录](./platform-implementation-status.md)。

Armadra 是一个 local-first 的桌面画布：把 Claude Code、Codex、Gemini CLI、
opencode 等 CLI Agent 作为终端节点放在一块 tldraw 白板上，节点之间连一条线即
建立上下文链接，Agent 可以读取被链接一端的转录、终端画面或白板内容。

所有数据留在本机：SQLite 一个库 + 工作区里的 `.armadra/` 目录，没有服务端。

## 2. 三层结构

```text
┌──────────────────────────── apps/desktop ────────────────────────────┐
│ Tauri 2 薄壳：启动 / 健康检查 / 停止 sidecar、系统目录选择器、        │
│ 外部链接、拖入文件的真实路径、托盘与通知                              │
│  └── sidecar: armadra-runtime、armadra-hook                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 加载同一套页面
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/web  React 19 + Vite + tldraw 5 + shadcn/ui + Tailwind v4        │
│ 画布、节点、终端 UI（xterm.js）、编辑器（CodeMirror 6）、设置、会话侧栏 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP + WebSocket，127.0.0.1:43120
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/runtime  Rust + Axum + Tokio + SQLx/SQLite                       │
│ 工作空间与看板、终端（tmux / 直连 PTY / SSH）、文件、Git、Hook 服务、  │
│ 会话索引、协作动词、用量快照                                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 本机回环 TCP / Unix socket
┌───────────────────────────────▼──────────────────────────────────────┐
│ crates/armadra-hook  各 CLI 的 hook 与技能调用的小客户端二进制         │
└──────────────────────────────────────────────────────────────────────┘
```

三条边界不变：

- **apps/web 是唯一页面**。桌面壳与浏览器加载同一份构建产物。
- **apps/runtime 是唯一执行服务**。所有进程、文件、Git、权限判定都在这里，
  业务逻辑不写进 Tauri command，避免出现第二套后端。
- **apps/desktop 只做壳**。插件提供目录选择、外部链接与系统通知。

## 3. 画布层

窗口浮层以侧栏之外的可用画布区域为布局容器。标题栏图标共用 44px 高度的
中心线；底部 Dock 与右侧导航区分别预留空间。窄窗口使用紧凑工具菜单，并把
缩略图与用量球移到 Dock 上方；缩略图由自定义 NavigationPanel 承载，不跟随
tldraw 默认的移动端断点隐藏。用量球位于缩略图左侧。

用量快照保留供应商返回的基础与模型专属额度窗口，每个窗口独立显示已用比例和
重置时间。数据采集时间与额度重置时间分开显示；后台刷新和手动刷新共用串行化
与冷却时间，前端只轮询缓存，不把缓存轮询时间当成数据更新时间。

tldraw 5 的 store 是画布在内存里的唯一真相：

- **节点**是自定义 `ShapeUtil`（`apps/web/src/canvas/shapes/ArmadraShapeUtil.tsx`），
  节点体是普通 React 组件，所以终端、编辑器、iframe 直接渲染在 shape 里。
- **分组**是 tldraw 原生 frame。
- **上下文链接**是两端有 binding 的自定义箭头（`LinkShapeUtil` + `LinkBindingUtil`）。
- **白板内容**（手绘、几何、文字、图片、高亮）是 tldraw 原生 shape，与节点共用
  一套相机、选择和撤销栈。

节点类型共 7 种（`packages/shared/src/domain.ts`）：
`terminal`（含 Agent）、`sticky`、`group`、`editor`、`diff`、`files`、`browser`。
入库的连线只有一种：`link`；派生的视觉边（子代理 rope 等）每帧算出来，不入库。

## 4. Agent 运行时

Agent 节点就是终端节点里跑着一个 CLI，没有中间协议：

1. Runtime 在 PTY 里启动 CLI，注入 `ARMADRA_NODE_ID`、`ARMADRA_ENDPOINT_FILE`
   等环境变量。
2. 用户在设置中显式安装后，Runtime 往支持的 CLI 配置文件里装 hook（`apps/runtime/src/hook/install/`），
   hook 命令是 `armadra-hook` 这个小二进制。
3. CLI 在回合开始 / 结束 / 请求权限时调用 `armadra-hook`，它读
   `<数据目录>/hook-endpoint.env` 找到 Runtime（优先 Unix socket，其次回环 TCP），
   带 per-node token 回报。
4. Runtime 归一化各家 hook 载荷（`hook/normalize/`）、reduce 成节点状态
   （`working` / `waiting` / `blocked` / `done`），通过工作空间事件 WebSocket 推给前端。
5. 权限请求在节点头部直答，答案写回 `<数据目录>/pending/`，hook 客户端阻塞读取。

内置 Agent 定义集中在 `packages/shared/src/agents.ts`（launch 命令、prompt 传递方式、
权限模式对应的 argv、resume 方式、能力位），Runtime 侧只镜像 id 与启动程序
（`apps/runtime/src/agent.rs`）。自定义 CLI 用 `custom:<id>`。

Agent 之间的协作走 Runtime 的两个动词表面：

- `POST /context-link/{verb}`：读取被链接节点的转录、摘要或终端画面。
- `POST /control/{verb}`：`list` / `open-terminal` / `open-agent` / `sticky` /
  `link` / `rename` / `color` / `post` / `inbox` / `ack` / `send` / `reply` / `notify` / `close`。

所有 Agent 终端都能调用 `armadra-hook canvas help` 读取短帮助。默认协作采用
`post` / `inbox` / `ack` 拉取消息箱，不自动注入终端输入或追加启动提示。显式安装
Hook 时提供独立的按需技能，不再追加全局长指令。详见
[Agent 适配与协作协议](agent-collaboration.md)。

## 5. 数据模型与持久化

```text
                  ┌──────────────── 内存真相 ────────────────┐
                  │  tldraw store（shape / binding / asset）   │
                  └───┬───────────────────────┬──────────────┘
       派生 nodes/edges │                       │ 其余记录整份序列化
                        ▼                       ▼
        Workspace / Board / Node / Edge      白板快照（不透明 JSON）
        （SQLite 的 nodes / edges 表）        （boards.whiteboard_json）
```

- 持久化两条通道由 `PUT /api/workspaces/{id}/boards/{boardId}/document` 一次带走。
  节点与连线仍是 `nodes` / `edges` 表——Runtime、hook、控制动词、会话侧栏只认这张表；
  节点 `<uuid>` ↔ shape `shape:<uuid>`，不查表；分组是原生 frame。
- 白板原生内容序列化成一份 tldraw 快照存进 `boards.whiteboard_json`，
  **Runtime 不解析它**。写之前先剔掉节点记录（`canvas/sync/snapshot.ts`），
  上限 8 MiB，超了这一轮不保存并提示。
- **图片资产不进快照**：字节走 `POST /api/workspaces/{id}/assets`（或按路径
  `.../assets/import`），内容寻址落在工作区的
  `.armadra/assets/<sha256 前 16 位>.<ext>`，快照里只留 URL 与工作区相对路径。
- 保存是 CAS：请求带 `expectedUpdatedAt`，冲突返回 `409`。

SQLite 基础表由 `0001_initial.sql` 创建；`0002_agent_mailbox.sql` 增量添加消息箱：

| 表                                    | 内容                                                |
| ------------------------------------- | --------------------------------------------------- |
| `workspaces` / `boards`               | 工作空间与看板，`boards.whiteboard_json` 存白板快照 |
| `nodes` / `edges`                     | 节点与入库的上下文链接                              |
| `terminal_sessions` / `terminal_logs` | 终端会话与回放日志                                  |
| `agent_status`                        | 每个 Agent 节点的当前状态（hook reduce 的结果）     |
| `agent_approvals`                     | 权限请求与答复                                      |
| `agent_mailbox`                       | 持久化拉取消息箱（幂等发送、确认、过期）            |
| `agent_deliveries`                    | Agent 之间的消息投递记录                            |
| `context_links`                       | 供 Agent 查询的链接视图                             |
| `hook_installs`                       | 每个 CLI 的 hook 安装记录                           |
| `conversations`                       | 会话索引（provider + session id → 标题）            |

`db::connect` 在同一 `BEGIN IMMEDIATE` 事务内先检查迁移账本，再执行已知迁移与启动恢复。未知版本、校验和不符、脏记录、损坏账本、无账本的非空 schema 或迁移历史缺口均拒绝启动；失败回滚并关闭连接池，不改名、删除或重建原库。SQLx 的 SQLite 迁移锁本身为空操作，外层事务用于防止校验与迁移之间的并发写入。既有 SQL 迁移文件保持原字节，文件中旧的重建说明是历史注释，不能为了更新说明而改变其校验和。

终端原始输出、密钥和 `.env` 不进入画板持久化。

## 6. 进程、端口与文件位置

| 项                  | 值                                                | 覆盖方式                                        |
| ------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Runtime 监听        | `127.0.0.1:43120`                                 | `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` |
| Web 开发服务器      | `127.0.0.1:1420`                                  | `vite --port`                                   |
| 数据目录（macOS）   | `~/Library/Application Support/Armadra`           | `ARMADRA_DATA_DIR`                              |
| 数据目录（Windows） | `%LOCALAPPDATA%\Armadra`                          | 同上                                            |
| 数据目录（Linux）   | `$XDG_DATA_HOME/armadra`                          | 同上                                            |
| 数据库              | `<数据目录>/canvas.db`                            | `ARMADRA_DATABASE_URL`                          |
| Hook 端点文件       | `<数据目录>/hook-endpoint.env`（0600）            | —                                               |
| 节点 token          | `<数据目录>/node-tokens/<nodeId>`                 | —                                               |
| 待答权限            | `<数据目录>/pending/`                             | —                                               |
| Runtime 偏好        | `<数据目录>/settings.json`                        | —                                               |
| 私有 tmux server    | `<数据目录>/tmux.sock` + `tmux.conf`（0700 目录） | —                                               |
| 工作区产物          | `<工作区>/.armadra/`（assets、exports、板日志）   | —                                               |

Runtime 启动时把 PATH 换成补齐过的版本（Homebrew、mise shims、mise Node 安装
目录），并把同一份 PATH 交给所有终端子进程——从 `.app` 启动的 GUI 进程拿到的是
裸系统 PATH，否则终端里能用的 CLI 会被误判为未安装。

终端后端三选一（`apps/runtime/src/terminal/`）：`tmux`（默认，会话跨 Runtime 重启存活）、
`direct`（portable-pty 直连）、`ssh`（设置里配置的远程主机）。Windows 的持久化会话
设计见 [windows-session-daemon.md](./windows-session-daemon.md)（只有设计，未实现）。

## 7. 安全边界

- Runtime 只绑回环地址；CORS 只放行 `http://127.0.0.1:*`、`http://localhost:*`、
  `tauri://localhost`、`https://tauri.localhost`。
- Hook 表面有独立鉴权（per-node token）和独立 body 上限，优先走 Unix socket。
- 所有路径参数经 `security::resolve_in_root` 限制在工作区根目录内；导入的图片
  字节复制进 `.armadra/assets/`，不暴露原位置。
- 桌面壳 capability 只放行 `dialog:allow-open` 与 `opener:allow-open-url`，
  后者 scope 限 `http://*` / `https://*`。
- CSP 见 `apps/desktop/src-tauri/tauri.conf.json`：`connect-src` 只留本机 Runtime 的
  http/ws，`frame-src` 供 Browser 节点使用。

## 8. 未实现

- **网关 / 外部端**：`GET /api/gateway` 只返回配置与 `implemented: false`，
  不开监听端口，也不返回伪造设备。
- **Windows 持久化会话**：只有设计文档。
- **多人协同**：白板快照对 Runtime 是不透明字符串，跨端协议不会直接用画布引擎的
  内部数据结构；真要做实时协作时再引入 CRDT。
- **自动更新**：`tauri.conf.json` 里是关闭的骨架，启用步骤写在该文件的注释里。
