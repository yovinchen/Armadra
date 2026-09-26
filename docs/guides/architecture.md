# 架构

> 下一阶段目标见 [画布工作平台设计总纲](../design/canvas-platform-design.md)及其专项文档。本文件描述当前实现，不把目标能力提前计入现状。

> 当前实现的架构。画布层细节见 [画布换成 React Flow](../design/canvas-react-flow.md)，
> Agent 运行时与接口契约见 [v3-agent-terminal-plan.md](../contracts/v3-agent-terminal-plan.md)。
> 选型演进的原始讨论见 [ChatGPT 会话归档](../research/chatgpt-conversation-archive.md)。

## 1. 定位

业务由**一个 Electron-free 的 TypeScript core**（`apps/desktop/src/core/`）执行，两种壳装配它：Electron 桌面壳（`apps/desktop`）与无窗口服务器壳（`apps/server`）。2026-09 之前的 Rust Runtime（`apps/runtime` + `crates/`）、Go Host（`apps/host`）与它们之间的 Protobuf 已在 R7d 整体删除；那个时代的设计文档移入 `docs/history/`。进度见 [TypeScript Core 进度](../status/typescript-core-status.md)。

关闭桌面窗口隐藏前台并保留服务；Command Q / 托盘退出经私有控制结束受管会话与后台。core 重启保留 tmux 恢复语义。

Armadra 是一个 local-first 的桌面画布：把 Claude Code、Codex、
opencode 等 CLI Agent 作为终端节点放在一块无限画布上，节点之间连一条线即
建立上下文链接，Agent 可以读取被链接一端的转录、终端画面或白板内容。

所有数据留在本机：SQLite 一个库 + 工作区里的 `.armadra/` 目录。桌面安装没有服务端；
要多设备或多人时，把同一套 core 装进服务器壳（见 §2 末段）。

## 2. 三层结构

```text
┌──────────────────────────── apps/desktop ────────────────────────────┐
│ Electron 桌面壳：窗口、托盘、通知、系统目录选择器、外部链接、          │
│ 拖入文件的真实路径，以及把 core 作为子进程（`ELECTRON_RUN_AS_NODE`）  │
│ 拉起 / 健康检查 / 停止                                                │
│ 健康检查只认自己拉起的那个实例（`/health` 的 instanceId 与子进程      │
│ 启动时打到 stdout 的一致）；不一致时按 endpoints.json 与进程表确认    │
│ 是同一数据目录、由桌面启动的旧 core 后发 SIGTERM 再重拉               │
│  └── 随包资源：`resources/cli/armadra-hook.js`、`resources/migrations/`│
│      （Windows 另有 `resources/session-host/host.cjs`）               │
│  └── 回环 HTTP 静态服务：内核分配端口，页面从这里加载                 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 加载同一套页面（preload 给出基址与凭据）
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/web  React 19 + Vite + React Flow 12 + shadcn/ui + Tailwind v4   │
│ 画布、节点、终端 UI（xterm.js）、编辑器（CodeMirror 6）、设置、会话侧栏 │
│ 浏览器节点在壳里是进程内 `<webview>`                                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP + WebSocket 直连，无协议转发
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/desktop/src/core  TypeScript + node:http(s) + ws + node:sqlite    │
│ 工作空间与画布、终端（tmux / 直连 PTY / SSH / Windows session-host）、 │
│ 文件、Git、GitHub、身份、调度与自动化、语言服务、浏览器、Hook 服务、   │
│ 会话索引、协作动词、用量快照                                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 本机回环 TCP / Unix socket
┌───────────────────────────────▼──────────────────────────────────────┐
│ src/cli/armadra-hook  各 CLI 的 hook 与技能调用的小客户端（单文件 JS）│
└──────────────────────────────────────────────────────────────────────┘
```

三条边界不变：

- **apps/web 是唯一页面**。桌面壳与服务器壳加载同一份构建产物。
- **`src/core/` 是唯一执行服务**。所有进程、文件、Git、权限判定都在这里，
  业务逻辑不写进壳的 IPC 处理器，避免出现第二套后端。core 不 import
  `electron`，也不 import 壳的任何目录，由 `core/no-electron.test.ts` 的源码
  扫描守住——它能脱离 Electron 以纯 Node 运行，是服务器壳存在的前提。
- **apps/desktop 的 `src/main/` 只做壳**。主进程提供目录选择、外部链接、系统
  通知与窗口，能给页面的东西只有 `src/shared/ipc.ts` 那张表。

第四个目录 `apps/server` 是无窗口服务器壳：同一份 `apps/web` 产物、同一套 core，
对外只有 TLS 一个面，认证走设备配对与可撤销会话。用法见
[开发指南](development.md#无窗口服务器壳)，进度见
[TypeScript Core 实施进度](../status/typescript-core-status.md) §11。

## 3. 画布层

窗口浮层以侧栏之外的可用画布区域为布局容器。标题栏图标共用 44px 高度的
中心线；底部 Dock 与右侧导航区分别预留空间。窄窗口使用紧凑工具菜单，并把
缩略图与用量球移到 Dock 上方；缩略图是自写的 `canvas/flow/Minimap.tsx`，
按窗口宽度自己决定收起，不跟随画布库的断点。用量球位于缩略图左侧。

用量快照保留供应商返回的基础与模型专属额度窗口，每个窗口独立显示已用比例和
重置时间。数据采集时间与额度重置时间分开显示；后台刷新和手动刷新共用串行化
与冷却时间，前端只轮询缓存，不把缓存轮询时间当成数据更新时间。

本地成本按 agent 采集：`core/usage/cost-sources.ts` 里每个 `AgentCostSource` 声明
自己的转录根目录、字节预筛与逐行解析，`COST_SOURCES` 按注册表 id 登记（目前
claude、codex）。扫描器只认这张表——没有本地来源的 agent 不在表里，`byAgent`
里标 `source: "none"`，界面显示「暂无本地用量数据」而不是零。接入一家新 agent
就是写一个适配器并登记，聚合（`summarize()` 的 `ranges`：24h / 7d / 30d / 全部）、
契约与界面都不用改。

**工作面板一次只开一个**（`panels/WorkPanelSheet.tsx`）：资源管理器、资源、
问题、用量、GitHub、自动化、交接停在右侧，宽度来自一张表——右上工具簇也读
那张表，好让开着抽屉时它自己让开。Git 是唯一停在**底部**的一块
（[Git 工具窗口](../design/git-tool-window.md)）：它是「日志 / 提交」两个页签
的窗口，日志页三栏要的是宽度而不是高度，所以它不在那张宽度表里，高度记进偏
好、可拖动、可最大化。占地方这件事仍然共用同一条规则，所以打开它照样会关掉
右侧那一块。

Git 的读分两级。逐检出的那一批（status、diff、branches、history、reflog、
worktrees、stashes、tags、remotes、integration、hunks、commit / commit-file）
都带一个工作空间相对的 `path`，缺省是工作空间根。工作空间级的三条不带：
`POST …/git/log` 把所有已发现检出的提交合并成一张图，`GET …/git/refs` 一次
给出所有检出的分支树，`GET …/git/identity` 说这个检出提交出去会署谁的名。写
全部经仓库队列（`GitRepositoryAction`）；队列与 Git 命令都在执行主机上——本机
工作空间在 core 里，远端工作空间在 Worker 里（下一段）。

执行位置只有一条缝：`core/remote/execute.ts` 的 `executeOn`。文件、导入与
Git 的路由做完权限与参数解析后，按工作空间的 `executionHostId` 要么在本进程
里查 `core/remote/operations.ts` 的操作表，要么把同一个操作名经 `ssh` 发给那
台主机上的 Worker——Worker 就是同一份 core 包以 `worker --stdio` 启动，不开
数据库、不监听端口，只读写 stdio 帧（`core/remote/server.ts`）。两边跑同一段
代码，远端工作空间绝不回退到控制端的磁盘。Worker 也能主动推帧（`requestId`
为空），各域经 `listenRemote` 订阅：Git 长操作在 Worker 的仓库队列里排，进度
与结局推回控制端的镜像（`core/remote/git-operations.ts`）；文件监听由 Worker
的平台 watcher 推变化，连接断开或 Worker 太旧时退回控制端 2 秒轮询；资源面板
每拍对每台远端主机做一轮 `resources.read`（`core/resources/remote.ts`）。语言
服务走同一台主机上的第二个 Worker（`worker --stdio --language-link`，
`core/remote/language.ts`），语言服务器是它的子进程；长时间没有会话时控制端
关掉这条连接（`core/remote/language-idle.ts`），下次按需重连。交接材料经 Worker
在执行主机上采集（`handoff.capture`）。比一帧大的上传与下载分块传输、按 Worker
已收的字节续传（`core/remote/transfer.ts`）。画布 SSH 终端里的 CLI 由 Worker
同步过去的产物与垫片注入，Hook 经 Worker 的 unix socket 中继回控制端
（`core/remote/integration.ts`，见[远端画布注入](../design/remote-canvas-injection.md)）。

画布引擎是 React Flow 12（`@xyflow/react`，MIT），白板层自写。
**`canvas-store` 是画布在内存里的唯一真相**，React Flow 只是受控视图：
`nodes` / `edges` 由 `document.nodes / edges` 与白板文档投影出来
（`canvas/sync/project.ts`），用户手势经 `onNodesChange` 等回调翻译成
`canvas-store` 的动作，没有反向派生。

- **节点**是 `armadra` 类型的自定义节点（`canvas/flow/nodes/ArmadraNode.tsx`），
  节点体是普通 React 组件，所以终端、编辑器、iframe 直接渲染在节点里。
  拖拽只从头部起（`dragHandle`），体内的指针事件归节点体自己。
- **分组**是 `group` 节点（`canvas/flow/nodes/GroupNode.tsx`），子节点用
  React Flow 的 `parentId` 子流，坐标相对父级。
- **上下文链接**是 `link` 类型的边（`canvas/flow/edges/LinkEdge.tsx`）：
  两端节点相对边的中点之间的贝塞尔曲线，方向与标签由两端的节点类型算出来。
- **白板内容**（手绘、几何、文字、图片、直线）是 `wb.*` 节点，与节点共用
  同一套相机、选择和撤销栈；内容引用是 `reference` 边。引用的来源可以是一个
  白板对象，也可以是一个 Frame——引用 Frame 等于引用它圈住的那一片（成员清单
  加上成员一起栅格化的图，`canvas/frame-reference.ts`）。
- **撤销 / 重做**是自写的逐实体差异栈（`store/canvas/history.ts`），
  远端在撤销期间新增的实体不受影响。
- **⌘/Ctrl + 滚轮缩放**由画布自己算（`canvas/interaction/wheel-zoom.ts`），
  不依赖 React Flow 的按键状态：那份状态由 keydown 落在谁身上决定，终端拿到
  焦点时并不可靠。

节点类型共 9 种（`packages/shared/src/domain/primitives.ts` 的 `NODE_TYPES`）：
`terminal`（含 Agent）、`sticky`、`group`、`editor`、`diff`、`files`、`browser`、
`automation`、`agentActivity`。
入库的连线只有一种：`link`；派生的视觉边（子代理 rope 等）每帧算出来，不入库。

## 4. Agent 运行时

Agent 节点就是终端节点里跑着一个 CLI，没有中间协议：

1. core 在 PTY 里启动 CLI，注入 `ARMADRA_NODE_ID`、`ARMADRA_ENDPOINT_FILE`
   等环境变量。
2. 用户在设置中显式安装后，core 往该 CLI 的配置目录写适配（`apps/desktop/src/core/hook/install/`）。
   形式按 CLI 分两种：Claude / Codex / Copilot 装**命令 Hook**，行是 `armadra-hook` 这个小二进制；
   Pi / Oh My Pi 装一份生成的 **TS 扩展**（`extensions/armadra-status.ts`），OpenCode 装插件。
3. 命令 Hook 每个事件调一次 `armadra-hook`；进程内扩展在 CLI 自己的进程里说同一套 HTTP。
   两者都读 `<数据目录>/hook-endpoint.env` 找到 core（优先 Unix socket，其次回环 TCP），
   带 per-node token 与终端绑定回报——同样的凭据、同样的请求，core 不因来源多给权限。
4. core 归一化各家载荷（`hook/normalize/`）、reduce 成节点状态
   （`working` / `waiting` / `blocked` / `done`），连同来源标识 `stateSource`
   （`hook` / `extension` / `observed`）通过工作空间事件 WebSocket 推给前端，
   并随 `GET /api/workspaces/{id}/sessions` 一起返回，使刷新后节点头部的来源徽标不丢。
5. 没有任何适配的终端只有 `observed`：core 按已有的输入围栏与输出计数给一个弱提示，
   它不写进状态、也不能满足自动化提示词的空闲门（`core/terminal/` 的 `input_idle`）。
6. 权限请求在节点头部直答，答案写回 `<数据目录>/pending/`，hook 客户端阻塞读取。

内置 Agent 定义集中在 `packages/shared/src/agents.ts`（launch 命令、prompt 传递方式、
权限模式对应的 argv、resume 方式、能力位），core 侧只镜像 id 与启动程序
（`core/agent/`）。自定义 CLI 用 `custom:<id>`。

模型列表不写死：`GET /api/agents/{id}/models` 依次取 CLI 自己的说法
（`claude --help` 的 `--model` 别名、Codex `config.toml` 里配好的 `model` 与各
profile）、models.dev 目录中该 provider 的条目、以及离线兜底表，按发布日期倒序
并标注每条的来源。目录本身启动时读 `<数据目录>/models-catalog.json`，
缓存超过 24 小时就拉一次 `https://models.dev/api.json`，之后每天一次；联网只发生在
core 侧。同一份目录供计费（内置表 → 目录 → `model-pricing.json`）与上下文上限
（目录 → 家族规则）使用，
来源与更新时间在设置页「账号与用量」里显示（`GET /api/models/catalog`）。

Agent 之间的协作走 core 的两个动词表面：

- `POST /context-link/{verb}`：读取被链接节点的转录、摘要或终端画面。
- `POST /control/{verb}`：`list` / `open-terminal` / `open-agent` / `team` / `sticky` /
  `link` / `rename` / `color` / `post` / `inbox` / `ack` / `handoff-read` / `interrupt` / `close` / `send` / `outbox` / `cancel`。`team` 一次建一组 Agent 节点，成员之间的先后写进依赖表（`core/dependencies`）。

依赖编排在 core 里（`core/dependencies/`，迁移 0027）：`open-agent --after` 与 `team`
把「下游等哪些上游、等当前还是下一轮结束」写进依赖表，服务订阅 `agent.status` /
`terminal.exit` / `board.changed` 并每 30 秒扫一次（过期、上游被删、重启后补判）。
条件满足时由 core 启动下游——节点已有 shell 就往里敲，没有就经终端桥起一个——
再把第一条任务放进投递队列，与 `send` 走同一条出队路；页面不在也照样生效。节点头的
「等待 X」徽标读的是这张表，不再是节点数据里的 `pendingLaunch`。契约见 [core JSON 契约](../contracts/core-json-api.md) §8。

所有 Agent 终端都能调用 `armadra-hook canvas help` 读取短帮助。默认协作采用
`post` / `inbox` / `ack` 拉取消息箱，不自动注入终端输入或追加启动提示。显式安装
Hook 时提供独立的按需技能，不再追加全局长指令。详见
[Agent 适配与协作协议](./agent-collaboration.md)。

## 5. 数据模型与持久化

```text
                  ┌──────────────── 内存真相 ────────────────┐
                  │  canvas-store（document + whiteboard）     │
                  └───┬───────────────────────┬──────────────┘
          nodes/edges  │                       │ 白板文档整份序列化
                        ▼                       ▼
        Workspace / Board / Node / Edge      白板快照（不透明 JSON）
        （SQLite 的 nodes / edges 表）        （boards.whiteboard_json）
```

- 持久化两条通道由 `PUT /api/workspaces/{id}/boards/{boardId}/document` 一次带走。
  节点与连线仍是 `nodes` / `edges` 表——core、hook、控制动词、会话侧栏只认这张表；
  节点 id 就是那一行的 uuid，白板对象是 `wb:<uuid>`，都不查表；分组是 `group` 节点。
- 白板对象与内容引用序列化成一份 `{"engine":"armadra-flow","version":2,…}` 的
  JSON 存进 `boards.whiteboard_json`，**core 不解析它**（只看长度与摘要）。
  上限 8 MiB，超了这一轮不保存并提示。不认识的 `engine` / 更高的 `version`
  按「保留原文」处理：不覆盖，也不显示成空白板。
- **图片资产不进快照**：字节走 `POST /api/workspaces/{id}/assets`（或按路径
  `.../assets/import`），内容寻址落在工作区的
  `.armadra/assets/<sha256 前 16 位>.<ext>`，快照里只留 URL 与工作区相对路径。
- 保存是 CAS：请求带 `expectedUpdatedAt`，冲突返回 `409`。请求体仍是整份文档
  （服务端按 id 做 upsert + 删掉请求里没有的行），所以「谁的改动算数」由
  CAS 加客户端变基决定，不是按字段合并。
- 保存成功后 core 广播 `board.changed{boardId, updatedAt}`。同一块板的另一个
  窗口按这个 `updatedAt` 判断这条事件是不是自己刚存的那一次：不是就重取文档，
  经 `canvas/sync/merge.ts` 合进 `canvas-store`——视口留本地的，本地这一轮动过的
  实体（`store/canvas/pending.ts` 记账）留本地的，其余照收远端的。远端灌入
  **不进也不清**撤销栈，手势进行中先不合，等松手。
- 多设备同开一块板时，core 在内存里记在线表与**一把写租约**（`core/canvas/presence.ts`，
  不入库、不进 outbox）：页面每 10 秒心跳，只有一个客户端时无感；有别人在看时租约归
  正在编辑的一方，别人手里的租约让 `PUT …/document` 答 423 `canvas_lease_held`（判在
  CAS 之前），本页转只读并在右上角显示谁在编辑、可确认接管。core 自己的写者（控制
  动词、调度、依赖编排）不经租约。契约见 [core JSON 契约](../contracts/core-json-api.md) §9。
- 控制动词新建节点时，core 在 `board.changed` **之后**再广播一条
  `node.created{boardId, nodeId, nodeType, originNodeId}`。前者只说「板变新了」，
  后者说「新出现的是哪一个、谁要的」：正开着这块板的页面据此把新节点选中并把
  相机对准它，和从新建菜单建出来的一模一样（`canvas/created-node.ts`）。后台
  标签页、开着别的板的窗口、以及正在拖拽或输入的时候都不跟。
- 节点的默认尺寸只有一份，在 `apps/web/src/nodes/registry.ts`：控制动词建节点
  时**不写 `size`**，页面投影时按类型补（`canvas/sync/project.ts`）。

SQLite 的迁移只有一个目录——`apps/desktop/src/core/db/migrations/`，0001 起一条
连续序列，字节由根 `migrations.lock` 守住（R7d 把原先分散在两处的来源合成一处）。
基础表由 `0001_initial.sql` 创建；`0002_agent_mailbox.sql` 增量添加消息箱：

| 表                                    | 内容                                                |
| ------------------------------------- | --------------------------------------------------- |
| `workspaces` / `boards`               | 工作空间与看板，`boards.whiteboard_json` 存白板快照 |
| `nodes` / `edges`                     | 节点与入库的上下文链接                              |
| `terminal_sessions` / `terminal_logs` | 终端会话与回放日志                                  |
| `agent_status`                        | 每个 Agent 节点的当前状态（hook reduce 的结果）     |
| `agent_approvals`                     | 权限请求与答复                                      |
| `agent_mailbox`                       | 持久化拉取消息箱（幂等发送、确认、过期）            |
| `context_links`                       | 供 Agent 查询的链接视图                             |
| `hook_installs`                       | 每个 CLI 的 hook 安装记录                           |
| `conversations`                       | 会话索引（provider + session id → 标题）            |

`core/db/open.ts` 在同一 `BEGIN IMMEDIATE` 事务内先检查迁移账本，再执行已知迁移与启动恢复。未知版本、校验和不符、脏记录、损坏账本、无账本的非空 schema 或迁移历史缺口均拒绝启动；失败回滚并关闭连接，不改名、删除或重建原库。账本表与校验和算法沿用最初那套（SHA-384），所以装过旧版本的库照常打得开。既有 SQL 迁移文件保持原字节。

迁移 0015 是**单向门**：它把原先另一个进程的私有库并了进来，应用之后这个 `canvas.db` 旧实现再也打不开。所以应用它之前 core 先 `VACUUM INTO` 一份 `canvas.db.before-ts-core-<时间戳>` 并验证那份副本能打开——回滚不是再跑一条迁移，而是用这份备份替换整个文件。

终端原始输出、密钥和 `.env` 不进入画板持久化。

**写入所有权机制已删除（历史注记，R7c/R7d）。** 画布、设置、文件、会话、Agent、Git
六个域曾各有一行 `write_ownership` 记录，声明「此刻由哪个实现写」，页面按它路由每
一次读写，切换窗口里画布变成只读。那个机制存在的唯一理由是**有两个写者**；一个
core 里没有第二个，所以 2026-09-20 连同 `/api/ownership`、`/api/ownership/domains`
两条路由、前端的 `canvas-ownership/` 与各域的 `host-session.ts` 一起删除，页面收口
为「本地总是可编辑」。当时的设计见 [Host 业务所有权迁移](../history/host-business-migration.md)（历史文档）。

## 6. 进程、端口与文件位置

来源与凭据检查**按壳分档**。桌面壳里 core 就在壳的进程树内，壳经 preload 直接把
凭据注入页面，没有中间的票据链。服务器壳保留完整的设备配对、可撤销凭据、会话轮转、
CSRF 与 Origin 校验（[服务器账号、中转与共享](../design/server-accounts-and-sharing.md)）。
分进程时代的票据链设计见 [桌面壳原生 Host 会话](../history/host-native-session.md)
与[设备认证](../history/host-device-auth.md)，两份都是历史文档。

| 项                  | 值                                                                   | 覆盖方式                                        |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| core 监听           | `127.0.0.1:43120`                                                    | `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` |
| core 监听（壳内）   | `tcp:127.0.0.1:0`，端口由内核分配、stdout 公告                       | `ARMADRA_RUNTIME_LISTEN`                        |
| 壳的静态服务        | `127.0.0.1:<内核分配>`，页面从这里加载                               | —                                               |
| Web 开发服务器      | `127.0.0.1:1420`                                                     | `vite --port`                                   |
| 数据目录（macOS）   | `~/Library/Application Support/Armadra`                              | `ARMADRA_DATA_DIR`                              |
| 数据目录（Windows） | `%LOCALAPPDATA%\Armadra`                                             | 同上                                            |
| 数据目录（Linux）   | `$XDG_DATA_HOME/armadra`                                             | 同上                                            |
| 数据库              | `<数据目录>/canvas.db`                                               | `ARMADRA_DATABASE_URL`                          |
| 迁移目录            | `apps/desktop/src/core/db/migrations`（包内 `resources/migrations`） | `ARMADRA_CORE_MIGRATIONS_DIR`                   |
| Hook 端点文件       | `<数据目录>/hook-endpoint.env`（0600）                               | —                                               |
| 节点 token          | `<数据目录>/node-tokens/<nodeId>`                                    | —                                               |
| 待答权限            | `<数据目录>/pending/`                                                | —                                               |
| 账号偏好            | `<数据目录>/settings.json`                                           | —                                               |
| 本机偏好            | `<数据目录>/worker-settings.json`                                    | —                                               |
| 模型目录缓存        | `<数据目录>/models-catalog.json`（0600）                             | —                                               |
| 价格覆盖            | `<数据目录>/model-pricing.json`                                      | —                                               |
| 私有 tmux server    | `<数据目录>/tmux.sock` + `tmux.conf`（0700 目录）                    | —                                               |
| 工作区产物          | `<工作区>/.armadra/`（assets、exports、板日志）                      | —                                               |

偏好分两个文件：`settings.json` 跟着账号走，`worker-settings.json` 属于这台
机器（`core/settings/local.ts`：终端后端、浏览器可执行文件、电源策略、
CLI 路径覆盖与探测缓存）。载入时合成一份文档、写入时再拆开，所以
`GET /api/settings` 仍是一个对象；`GET /api/settings/local` 告诉界面哪些键属于
本机。

core 启动时把 PATH 换成补齐过的版本（Homebrew、mise shims、mise Node 安装
目录），并把同一份 PATH 交给所有终端子进程——从 `.app` 启动的 GUI 进程拿到的是
裸系统 PATH，否则终端里能用的 CLI 会被误判为未安装。

终端后端（`core/terminal/`）：`tmux`（默认，会话跨 core 重启存活）、`direct`
（node-pty 直连）、`ssh`（设置里配置的远程主机），Windows 另有 session-host
守护进程（`src/session-host/`，包内 `resources/session-host/host.cjs`），
它持有 ConPTY 会话，使之比壳活得更久。早期方案见
[windows-session-daemon.md](../design/windows-session-daemon.md)。

节能休眠（`core/terminal/hibernate.ts` 判据、`hibernator.ts` 执行）：空闲满阈值、
能用 CLI 自己的 resume 接回来的 Agent 会话被结束以释放内存，行以
`termination_intent = 'hibernate'` 记下；页面聚焦、投递或计划冷启动时在同一个会话
id 上起下一代并敲恢复行。设计见 [terminal-host-design.md](../design/terminal-host-design.md) §7.2。

## 7. 安全边界

- 桌面壳里的 core 只绑回环地址；CORS 只放行回环 HTTP 来源（`http://127.0.0.1:*`、
  `http://localhost:*`，以及 Unix socket / 命名管道调用者用的无端口形式）。
  自定义 scheme 不在放行之列，页面也不再用任何一种。
- Hook 表面有独立鉴权（per-node token）和独立 body 上限，优先走 Unix socket。
- 所有路径参数都限制在工作区根目录内（core 的路径解析）；导入的图片
  字节复制进 `.armadra/assets/`，不暴露原位置。
- 页面能让壳做的事只有 `apps/desktop/src/shared/ipc.ts` 那张表；`shell:open-external`
  按 scheme 白名单限 `http` / `https`，对话框返回路径而不是字节。渲染进程
  `contextIsolation: true`、`nodeIntegration: false`，唯一桥是 preload。
- CSP 见 `apps/desktop/src/shell-core/csp.ts`：`connect-src` 只留本机 core 的
  http/ws，`<webview>` 供浏览器节点使用。
- 服务器壳默认不监听非回环地址，对外服务是显式动作；它的配对码不可复用，
  token 不出现在 URL 里，撤销设备后正在进行的流立即终止。
- 服务器壳认证出的主体经 `AsyncLocalStorage` 跟着请求走（`core/identity/gate.ts` 的
  `runAs`），`core/identity/route-access.ts` 挂在 core 分发与升级之前，按
  `route-scopes.ts` 给每条路由的 scope 判定：成员只拿到被共享工作空间上的授权，
  全局路由一律 403，工作空间列表按授权过滤；授权一变，已开的事件流重新判定，不够就
  以 4403 关掉。没有请求主体时放行——桌面壳里没有第二个人，行为不变。契约见
  [core JSON 契约](../contracts/core-json-api.md) §10。

## 8. 未实现

- **Windows 持久化会话**：session host 已实现并在 Windows CI 上通过，没有在真机上
  长时间运行过（进度 §13、§33）。
- **多人实时协同**：同一块板同时只有一个写者（§5 的编辑租约）；白板快照对 core 是
  不透明字符串，真要多人同时改时再引入 CRDT。
- **自动更新**：electron-updater 已接通（`apps/desktop/src/main/updates/`），但未
  签名的构建里更新器是关闭的——「没签名 = 什么也验证不了 = `notConfigured`」，
  它绝不会报 `upToDate`（`shell-core/updates/availability.ts`）。
