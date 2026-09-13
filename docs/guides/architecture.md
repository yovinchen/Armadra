# 架构

> 下一阶段目标见 [画布工作平台设计总纲](../design/canvas-platform-design.md)及其专项文档：Go 常驻 Host、Protobuf、后台调度和跨端能力均为待实施方案。本文件继续描述当前实现，不将目标能力提前计入现状。

> 当前实现的架构。画布层细节见 [画布换成 React Flow](../design/canvas-react-flow.md)，
> Agent 运行时与接口契约见 [v3-agent-terminal-plan.md](../contracts/v3-agent-terminal-plan.md)。
> 选型演进的原始讨论见 [ChatGPT 会话归档](../research/chatgpt-conversation-archive.md)。

## 1. 定位

独立 Go Host 已有身份、单实例、后台启停和 Protobuf 基础。桌面启动时异步启动/发现 Host，设置页可显式检查连接；Go Host 的生命周期独立于界面。默认应用业务仍由下述 Rust Runtime 提供。关闭桌面窗口隐藏前台并保留服务；Command Q/托盘退出经私有控制结束受管会话和后台。普通 Runtime 重启信号保留 tmux 恢复语义；尚未切换业务数据库或接入 Host 调度。实际进度见 [平台实施记录](../status/platform-implementation-status.md)。

Armadra 是一个 local-first 的桌面画布：把 Claude Code、Codex、Gemini CLI、
opencode 等 CLI Agent 作为终端节点放在一块无限画布上，节点之间连一条线即
建立上下文链接，Agent 可以读取被链接一端的转录、终端画面或白板内容。

所有数据留在本机：SQLite 一个库 + 工作区里的 `.armadra/` 目录，没有服务端。

## 2. 三层结构

```text
┌──────────────────────────── apps/desktop ────────────────────────────┐
│ Tauri 2 薄壳：启动 / 健康检查 / 停止 sidecar、系统目录选择器、        │
│ 外部链接、拖入文件的真实路径、托盘与通知                              │
│ 健康检查只认自己拉起的那个实例（`/health` 的 instanceId 与子进程      │
│ 启动时打到 stdout 的一致）；不一致时按 endpoints.json 与进程表确认    │
│ 是同一数据目录、由桌面启动的旧 Runtime 后发 SIGTERM 再重拉            │
│  └── sidecar: armadra-runtime、armadra-hook                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 加载同一套页面
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/web  React 19 + Vite + React Flow 12 + shadcn/ui + Tailwind v4   │
│ 画布、节点、终端 UI（xterm.js）、编辑器（CodeMirror 6）、设置、会话侧栏 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP + WebSocket，127.0.0.1:43120
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/runtime  Rust + Axum + Tokio + SQLx/SQLite                       │
│ 工作空间与画布、终端（tmux / 直连 PTY / SSH）、文件、Git、Hook 服务、  │
│ 会话索引、协作动词、用量快照                                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 本机回环 TCP / Unix socket
┌───────────────────────────────▼──────────────────────────────────────┐
│ crates/hook  各 CLI 的 hook 与技能调用的小客户端二进制         │
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
缩略图与用量球移到 Dock 上方；缩略图是自写的 `canvas/flow/Minimap.tsx`，
按窗口宽度自己决定收起，不跟随画布库的断点。用量球位于缩略图左侧。

用量快照保留供应商返回的基础与模型专属额度窗口，每个窗口独立显示已用比例和
重置时间。数据采集时间与额度重置时间分开显示；后台刷新和手动刷新共用串行化
与冷却时间，前端只轮询缓存，不把缓存轮询时间当成数据更新时间。

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
全部经仓库队列（`GitRepositoryAction`），队列在 Host 接管 git 域之后搬到
Host，Git 命令始终在执行主机上跑。

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

节点类型共 7 种（`packages/shared/src/domain.ts`）：
`terminal`（含 Agent）、`sticky`、`group`、`editor`、`diff`、`files`、`browser`。
入库的连线只有一种：`link`；派生的视觉边（子代理 rope 等）每帧算出来，不入库。

## 4. Agent 运行时

Agent 节点就是终端节点里跑着一个 CLI，没有中间协议：

1. Runtime 在 PTY 里启动 CLI，注入 `ARMADRA_NODE_ID`、`ARMADRA_ENDPOINT_FILE`
   等环境变量。
2. 用户在设置中显式安装后，Runtime 往该 CLI 的配置目录写适配（`apps/runtime/src/hook/install/`）。
   形式按 CLI 分两种：Claude / Codex / Gemini / Copilot 装**命令 Hook**，行是 `armadra-hook` 这个小二进制；
   Pi / Oh My Pi 装一份生成的 **TS 扩展**（`extensions/armadra-status.ts`），OpenCode 装插件。
3. 命令 Hook 每个事件 fork 一次 `armadra-hook`；进程内扩展在 CLI 自己的进程里说同一套 HTTP。
   两者都读 `<数据目录>/hook-endpoint.env` 找到 Runtime（优先 Unix socket，其次回环 TCP），
   带 per-node token 与终端绑定回报——同样的凭据、同样的请求，Runtime 不因来源多给权限。
4. Runtime 归一化各家载荷（`hook/normalize/`）、reduce 成节点状态
   （`working` / `waiting` / `blocked` / `done`），连同来源标识 `stateSource`
   （`hook` / `extension` / `observed`）通过工作空间事件 WebSocket 推给前端，
   并随 `GET /api/workspaces/{id}/sessions` 一起返回，使刷新后节点头部的来源徽标不丢。
5. 没有任何适配的终端只有 `observed`：Runtime 按已有的输入围栏与输出计数给一个弱提示，
   它不写进状态、也不能满足自动化提示词的空闲门（`terminal/observation.rs` 的 `input_idle`）。
6. 权限请求在节点头部直答，答案写回 `<数据目录>/pending/`，hook 客户端阻塞读取。

内置 Agent 定义集中在 `packages/shared/src/agents.ts`（launch 命令、prompt 传递方式、
权限模式对应的 argv、resume 方式、能力位），Runtime 侧只镜像 id 与启动程序
（`apps/runtime/src/agent.rs`）。自定义 CLI 用 `custom:<id>`。

模型列表不写死：`GET /api/agents/{id}/models` 依次取 CLI 自己的说法
（`claude --help` 的 `--model` 别名、Codex `config.toml` 里配好的 `model` 与各
profile）、models.dev 目录中该 provider 的条目、以及离线兜底表，按发布日期倒序
并标注每条的来源（`apps/runtime/src/models/agents.rs`）。目录本身由
`apps/runtime/src/models/catalog.rs` 维护：启动时读 `<数据目录>/models-catalog.json`，
缓存超过 24 小时就拉一次 `https://models.dev/api.json`，之后每天一次；联网只发生在
Runtime 侧。同一份目录供计费（`usage/cost/pricing.rs`：内置表 → 目录 →
`model-pricing.json`）与上下文上限（`context_models.rs`：目录 → 家族规则）使用，
来源与更新时间在设置页「账号与用量」里显示（`GET /api/models/catalog`）。

Agent 之间的协作走 Runtime 的两个动词表面：

- `POST /context-link/{verb}`：读取被链接节点的转录、摘要或终端画面。
- `POST /control/{verb}`：`list` / `open-terminal` / `open-agent` / `sticky` /
  `link` / `rename` / `color` / `post` / `inbox` / `ack` / `handoff-read` / `interrupt` / `close`；`send` / `reply` / `notify` 已移除，消息只进信箱由接收方自己读。

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
  节点与连线仍是 `nodes` / `edges` 表——Runtime、hook、控制动词、会话侧栏只认这张表；
  节点 id 就是那一行的 uuid，白板对象是 `wb:<uuid>`，都不查表；分组是 `group` 节点。
- 白板对象与内容引用序列化成一份 `{"engine":"armadra-flow","version":2,…}` 的
  JSON 存进 `boards.whiteboard_json`，**Runtime 不解析它**（只看长度与摘要）。
  上限 8 MiB，超了这一轮不保存并提示。不认识的 `engine` / 更高的 `version`
  按「保留原文」处理：不覆盖，也不显示成空白板。
- **图片资产不进快照**：字节走 `POST /api/workspaces/{id}/assets`（或按路径
  `.../assets/import`），内容寻址落在工作区的
  `.armadra/assets/<sha256 前 16 位>.<ext>`，快照里只留 URL 与工作区相对路径。
- 保存是 CAS：请求带 `expectedUpdatedAt`，冲突返回 `409`。请求体仍是整份文档
  （服务端按 id 做 upsert + 删掉请求里没有的行），所以「谁的改动算数」由
  CAS 加客户端变基决定，不是按字段合并。
- 保存成功后 Runtime 广播 `board.changed{boardId, updatedAt}`。同一块板的另一个
  窗口按这个 `updatedAt` 判断这条事件是不是自己刚存的那一次：不是就重取文档，
  经 `canvas/sync/merge.ts` 合进 `canvas-store`——视口留本地的，本地这一轮动过的
  实体（`store/canvas/pending.ts` 记账）留本地的，其余照收远端的。远端灌入
  **不进也不清**撤销栈，手势进行中先不合，等松手。

SQLite 基础表由 `0001_initial.sql` 创建；`0002_agent_mailbox.sql` 增量添加消息箱：

| 表                                    | 内容                                                |
| ------------------------------------- | --------------------------------------------------- |
| `workspaces` / `boards`               | 工作空间与看板，`boards.whiteboard_json` 存白板快照 |
| `nodes` / `edges`                     | 节点与入库的上下文链接                              |
| `terminal_sessions` / `terminal_logs` | 终端会话与回放日志                                  |
| `agent_status`                        | 每个 Agent 节点的当前状态（hook reduce 的结果）     |
| `agent_approvals`                     | 权限请求与答复                                      |
| `agent_mailbox`                       | 持久化拉取消息箱（幂等发送、确认、过期）            |
| `agent_deliveries`                    | 已弃用：Runtime 不再写入，仅 Host 侧保留读取        |
| `context_links`                       | 供 Agent 查询的链接视图                             |
| `hook_installs`                       | 每个 CLI 的 hook 安装记录                           |
| `conversations`                       | 会话索引（provider + session id → 标题）            |

`db::connect` 在同一 `BEGIN IMMEDIATE` 事务内先检查迁移账本，再执行已知迁移与启动恢复。未知版本、校验和不符、脏记录、损坏账本、无账本的非空 schema 或迁移历史缺口均拒绝启动；失败回滚并关闭连接池，不改名、删除或重建原库。SQLx 的 SQLite 迁移锁本身为空操作，外层事务用于防止校验与迁移之间的并发写入。既有 SQL 迁移文件保持原字节，文件中旧的重建说明是历史注释，不能为了更新说明而改变其校验和。

终端原始输出、密钥和 `.env` 不进入画板持久化。

Go Host 现在独占私有 `host.db`，通用实体 revision、操作收据和事件在同一事务内提交。Runtime 的离线 `export` 生成一致性数据库与受管资产包；Host 的离线 `import` 校验 Protobuf 清单后写入不激活的 staging。该链路保留原始数据和类型，用于维护窗口切换，任何阶段都不双写。

**画布写入方随 ownership 记录变化。** 工作空间与画布（boards / nodes / edges / annotations / 资产引用）的写入所有权由 `write_ownership` 单行记录声明：`{ domain: canvas, owner: runtime | host, epoch }`，两侧各存一份，epoch 单调。默认 owner 是 Runtime，此时 Host 的 `armadra.v1.CanvasService` 只读、所有变更返回稳定错误码 `ownership_moved`；切换后反过来，Runtime 的画布/工作空间写入路由返回同一个 `ownership_moved`（HTTP 409），读取继续可用作只读后备。终端、文件、Git、Hook 的执行始终在 Runtime，不随该记录变化。

切换只能由操作者在维护窗口内用 `armadra-host ownership switch|rollback|status` 触发，命令持有数据目录锁，因此运行中的 Host 必须先停止；没有自动切换，也没有双写。切换前必须依次完成 Runtime 一致性导出 → Host staging 导入 → 投影为画布实体 → 逐项核验（ID、位置、尺寸、Frame 嵌套、上下文链接、白板摘要、标注、资产哈希），出现任何差异即中止且不改任何所有权状态。epoch 经现有 Worker stdio 协议下发（`armadra-runtime worker --stdio --canvas-database FILE`，能力位 `canvas.ownership.v1`）。回滚方向相同，并要求 Host 先写出反向导出包；把该包重新导入 `canvas.db` 尚未实现，因此 Host 在持有期间产生过画布事件时回滚会被拒绝，除非操作者显式声明只要导出包。

## 6. 进程、端口与文件位置

Go Host 已增加独立私有设备认证表与 Protobuf 会话接口。浏览器认证只在配置证书和准确公共来源的 HTTPS 上开放，本机 OS 控制通道签发两分钟配对票据；默认 HTTP 对浏览器来源仍不能登录。打包桌面壳是唯一例外：页面来源 `tauri://localhost` 经同一条控制通道取票，向回环 HTTP 的 Host 换取 Bearer 会话，凭据只在页面内存（[设计](../design/host-native-session.md)）。会话轮转、CSRF 与设备撤销由 Host 校验，详细使用与当前边界见[设备认证](./host-device-auth.md)。

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
| 本机偏好            | `<数据目录>/worker-settings.json`                 | —                                               |
| 模型目录缓存        | `<数据目录>/models-catalog.json`（0600）          | —                                               |
| 价格覆盖            | `<数据目录>/model-pricing.json`                   | —                                               |
| 私有 tmux server    | `<数据目录>/tmux.sock` + `tmux.conf`（0700 目录） | —                                               |
| 工作区产物          | `<工作区>/.armadra/`（assets、exports、板日志）   | —                                               |

偏好分两个文件：`settings.json` 跟着账号走，`worker-settings.json` 属于这台
机器（`apps/runtime/src/settings/local.rs`：终端后端、浏览器可执行文件、电源
策略、CLI 路径覆盖与探测缓存）。载入时合成一份文档、写入时再拆开，所以
`GET /api/settings` 仍是一个对象；`GET /api/settings/local` 告诉界面哪些键属于
本机。settings 域的写入所有权切到 Host 再切回来时，本机那一半原地不动。

Runtime 启动时把 PATH 换成补齐过的版本（Homebrew、mise shims、mise Node 安装
目录），并把同一份 PATH 交给所有终端子进程——从 `.app` 启动的 GUI 进程拿到的是
裸系统 PATH，否则终端里能用的 CLI 会被误判为未安装。

终端后端三选一（`apps/runtime/src/terminal/`）：`tmux`（默认，会话跨 Runtime 重启存活）、
`direct`（portable-pty 直连）、`ssh`（设置里配置的远程主机）。Windows 的持久化会话
设计见 [windows-session-daemon.md](../design/windows-session-daemon.md)（只有设计，未实现）。

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

## 9. Worker 只读桥接

Rust可使用独立 `worker --stdio` 入口，通过父Go进程私有管道提供规范目录与文本分块读取。该入口不启动旧Runtime HTTP或PTY；Go客户端验证Host与进程实例并负责关闭回收。当前为执行层接管的第一批，只报告已实现的只读能力，尚未切换现有业务。传输帧1MiB、文本1MiB、单块256KiB，后续块以首块SHA绑定内容版本。

只有显式加 `--canvas-database FILE` 时该入口才打开 `canvas.db`，且仅为读写 `write_ownership` 一行；它不跑迁移，缺少该表直接拒绝，并只在真的打开了数据库时才报告能力 `canvas.ownership.v1`。该模式与命令调度模式互斥，因此常驻的调度 Worker 不可能被用来移动写入所有权。

## 10. 会话上下文来源

上下文统计与账号额度分离。读数按真实 PTY 会话 / generation 与单调序号更新运行期缓存；
模型或会话变化、压缩后的空报告、断连都会清除不再可信的显示。源时间仅展示，陈旧年龄使用单调时间。
未知容量与预留量不填 0。

来源分三档：Claude 的状态行与 Pi / Oh My Pi 扩展里的 `ctx.getContextUsage()` 都是提供方**实测**的当前窗口
（`provider_hook` / `reported`）；Codex 与 Gemini 按需读本地结构化转录尾部**估算**（`structured_transcript`）；
OpenCode 与 Copilot 没有可信的本地读数，界面留空——Copilot 的会话事件文件只在压缩开始与退出时写占用数字，
晚于描述一个活着的会话所需的时刻。自定义 Agent 能力可收窄，既有用户状态栏不会被安装器覆盖。
