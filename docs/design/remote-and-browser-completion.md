> 状态：目标设计。承接 [编辑器与浏览器](./editor-browser-design.md) §5–§9 的 B01 首轮与 [Host 与协议](./host-protocol-design.md) §5.1 的 H02 首轮，只写两条线各自「已交付之外」的部分；现状以 [实施记录](../status/platform-implementation-status.md) 的 B01 / H02 / H03 行为准，本文不重复已实现的内容。

# 受控浏览器补全与远端执行补全设计

## 0. 结论

| 线           | 基线（已提交）                                                                                                                               | 本轮目标                                                                                                                                                                       | 不变量                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| A 受控浏览器 | `apps/runtime/src/browser/`：本机 Chromium 发现、单页 CDP 会话、screencast 经工作空间事件、6 个 Agent 动词、下载暂存、重启恢复（macOS 实机） | 受管二进制、多标签与 frame 寻址、上传/对话框/弹窗、重定向复检、控制租约与徽标、动词补全到设计 §7 全表、专用帧流经 Host 到手机、Windows/Linux 进程组、SIGKILL 后 profile 锁恢复 | 没有 `eval`、没有裸 CDP；人与 Agent 共用一个 session；缺浏览器时明确不可用，不下载不假装；关闭节点不结束页面 |
| B 远端执行   | `apps/runtime/src/remote/`：`ssh … worker --stdio` 版本锁定握手、文件/搜索/基础 Git 远端执行、2 秒轮询监听、写出后失联 `UNKNOWN_OUTCOME`     | 仓库面板/文件管理/上传与资产导入远端执行、执行主机可按规则重绑定、远端 notify 事件、协议兼容范围替代精确版本、真实 SSH 认证与 host key 用户确认、与 H01 后 Worker 角色对齐     | 远端工作空间绝不静默回退本机；写出后失联仍是 `UNKNOWN_OUTCOME`；不自动信任 host key；凭据不入库              |

两条线共用一个前提：**远端 Worker 需要一条 Worker→控制端的事件通道**（§3.4）。它先服务文件监听；浏览器帧流跨执行主机复用同一通道，但**本轮浏览器 session 仍只运行在控制端主机**（§7）。

## 1. 现状与缺口

| 能力         | 已交付位置                                                                                      | 缺口（来源）                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 浏览器二进制 | `browser/launch.rs::availability`：设置 → 环境变量 → 标准安装位置                               | 受管下载与校验（设计 §5、状态 B01 行）                                                           |
| 目标寻址     | 单 page target，`Page.frameNavigated` 推进 `navigation_epoch`，元素引用 `e<epoch>-<idx>`        | 多标签、iframe、popup（设计 §6/§7 未实现项）                                                     |
| 页面能力     | 下载暂存 + 人工接受；Console/Network 环形缓冲                                                   | 上传、JS Dialog、popup、重定向后策略复检（`browser/mod.rs::admit_url` 注释自述）                 |
| 控制权       | 无租约；人与 Agent 输入直接交错                                                                 | `BrowserControlLease`、接管、活动徽标（设计 §7 未实现项）                                        |
| Agent 动词   | `navigate/read/click/type/wait/capture`（`browser/agent.rs::VERBS`、`armadra-hook` 同表）       | Select/Press/Scroll/Upload/Download/Back/Forward/Close（设计 §7 表）                             |
| 画面         | JPEG 帧走 `WS /api/workspaces/{id}/events`，按 focused/visible/hidden 定预算                    | 手机经 Host 代理观看与接管、带宽与帧率策略（状态 3.6 行 🔶）                                     |
| 进程         | Unix 进程组 SIGTERM→SIGKILL；Windows 只杀主进程；SIGKILL 后残留进程占住 profile（设计 §9 限制） | Windows Job Object、Linux 实机、profile 锁恢复                                                   |
| 远端 Git     | `WorkerServiceOperation` 10–18：status/diff/stage/unstage/revert/resolve/commit/init            | `git_api.rs::workspace` 对分支/历史/worktree/stash/操作队列一律 501                              |
| 远端文件管理 | 列表/读/写/版本/搜索/快速打开                                                                   | `api.rs` 中 `refuse_remote` 的 11 处：file-info、下载、上传、本地导入、file-entries ×5、资产导入 |
| 远端监听     | `remote/watch.rs` 2 秒 `WATCH_POLL`                                                             | Worker 侧 notify，事件推回控制端                                                                 |
| 执行主机     | 迁移 0009 `execution_host_id`，创建时确定                                                       | 生命周期内切换规则                                                                               |
| 握手         | `runtime_version` 精确相等，否则 `UNSUPPORTED`                                                  | 协议兼容范围                                                                                     |
| SSH          | `BatchMode=yes`，host key 与认证交给 `ssh` 自身                                                 | 首次指纹/指纹变化的用户确认、密码与口令短语提示（Host 设计 §5）                                  |

## 2. 受控浏览器补全

### 2.1 受管浏览器二进制

结论：新增「受管」来源，**永远不自动下载**；用户在设置里点一次安装，Runtime 按构建内固定清单下载、校验、原子安装。已装 Chrome 的机器不受影响。

| 项        | 决定                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源      | Chrome for Testing 固定版本；清单 `apps/runtime/browser-manifest.json` 随构建内置：`{ version, targets: { "<os>-<arch>": { url, sha256, bytes } } }`。Runtime 运行期不拉取任何清单                  |
| 查找顺序  | `browser.executablePath` → `ARMADRA_BROWSER_PATH` / `CHROME_PATH` → **受管已安装** → 标准安装位置。受管排在检测之前：它的 CDP 表面是被测试过的固定版本，系统 Chrome 会自动升级                      |
| 安装路径  | `<data_dir>/browser-managed/<version>-<os>-<arch>/`；下载到 `…/.download/<uuid>`，全量 sha256 通过后解压到 `…/.staging/<uuid>`，再 `rename` 到最终目录；任一步失败只删临时目录                      |
| 二次校验  | macOS `codesign --verify --deep --strict` 通过才算安装；Windows 交叉编译阶段只做 sha256，Authenticode 校验列入实机验收；Linux 仅 sha256                                                             |
| 接口      | `GET /api/browser/managed` → `{ state: absent \| downloading \| verifying \| installed \| failed, version, receivedBytes, totalBytes, reasonCode }`；`POST …/install`、`DELETE …`；进度由客户端轮询 |
| 事件与 UI | `UnsupportedPanel` 增加「安装受管浏览器（约 N MB）」按钮，显示版本与字节数；失败显示 `reason_code`（`manifest_missing_target`、`sha256_mismatch`、`signature_invalid`、`network`）而非原始错误      |
| 协议      | `BrowserAvailability.managed = 6`（新消息 `BrowserManagedState`），见 §2.11                                                                                                                         |

### 2.2 多标签与 iframe 目标寻址

结论：一个 session 仍是一个浏览器进程 + 一个 profile；session 内引入 **tab**（CDP target）与 **frame** 两级目标，所有动作请求可带可选 `BrowserTarget { tab_id, frame_id }`，缺省为活动标签的主 frame，因此现有调用方不变。

| 项         | 决定                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 附着       | `Target.setAutoAttach { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }` 于浏览器级 session；每个 `page` / `iframe`（OOPIF）target 得到自己的 CDP sessionId，由 `cdp.rs` 按 sessionId 路由 |
| Tab 模型   | `BrowserTab { tab_id, target_id, url, title, active, opener_tab_id, navigation_epoch, pending_dialog }`；`tab_id` 是 Runtime 自己的稳定序号（`t1`、`t2`…），不暴露 CDP targetId                             |
| 活动标签   | 一个 session 一个活动标签；screencast、输入、viewport 只作用活动标签；切换标签 = 停旧 screencast、起新 screencast、补首帧                                                                                   |
| Frame 模型 | `Page.getFrameTree` 得到主 frame 与子 frame；同进程 iframe 用其 `executionContextId` 求值，OOPIF 用其自动附着的 target session 求值；两者对外都是 `frame_id`                                                |
| 元素引用   | 主 frame 保持 `e<epoch>-<idx>`；非主 frame 为 `e<epoch>-<idx>@<tab_id>/<frame_id>`。引用绑定 tab + frame + 该 frame 的 epoch；任一层导航后返回 `STALE_TARGET`                                               |
| 坐标       | frame 内元素的点击坐标 = 元素在 frame 视口内的 rect + 逐级 frame owner 元素的 rect（`DOM.getBoxModel`）；OOPIF 的 owner rect 在父 frame 求，结果仍在主 frame 视口坐标下派发 `Input.*`                       |
| 弹窗       | `Target.targetCreated` 带 `openerId` → 新 tab 并广播 `browser.tab`；先过 §2.5 的 URL 策略，拒绝即 `Target.closeTarget` 并写 console 条目 `popup_blocked`；工作空间策略 `popups: tab \| block`，默认 `tab`   |
| 关闭       | `close --tab` 只能关标签；最后一个标签拒绝关闭（`LAST_TAB`）；结束 session 仍只有 `terminate=true`                                                                                                          |
| 上限       | 每 session ≤ 16 个标签，超出时新开被拒并记录 `tab_limit`                                                                                                                                                    |

### 2.3 下载与上传

| 方向 | 决定                                                                                                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 下载 | 保留「暂存 → 人工接受」；`Browser.setDownloadBehavior` 升到浏览器级并带 `eventsEnabled`，所以每个标签的下载都进入同一队列，`BrowserDownload.tab_id = 11`、`sha256 = 12`（完成后计算）。Agent `download --list` 无需租约；`download --id X --accept` 需要租约 **且** 工作空间 write 权限                        |
| 上传 | `Page.setInterceptFileChooserDialog(true)`；`Page.fileChooserOpened { frameId, backendNodeId, mode }` → session 记 `pending_file_chooser { chooser_id, tab_id, frame_id, multiple }` 并广播 `browser.fileChooser`；人从项目文件选择器选文件，Agent 用 `upload --path <相对路径>`；回填 `DOM.setFileInputFiles` |
| 路径 | 只接受工作空间相对路径，经 `security::resolve_in_root` 解析到执行主机绝对路径；拒绝 `.armadra/trash`、符号链接逃逸；无 chooser 时 Agent 可对 `input[type=file]` 直接回填（同一 CDP 命令），但仍受同样的路径规则                                                                                                |
| 超时 | chooser 60 秒无人应答 → 回填空列表并记录 `file_chooser_timeout`；不让页面永远挂着                                                                                                                                                                                                                              |

### 2.4 JS 对话框

| 项       | 决定                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 捕获     | `Page.javascriptDialogOpening { type: alert \| confirm \| prompt \| beforeunload, message, defaultPrompt }` → `BrowserDialog` 记入 tab，广播 `browser.dialog` |
| 处理     | `POST …/dialog { tabId, accept, promptText }` → `Page.handleJavaScriptDialog`；Agent 动词 `dialog --accept \| --dismiss [--text]`                             |
| 阻塞语义 | 对话框未处理时，该标签的输入/点击/输入文本一律 409 `DIALOG_PENDING`，响应体带对话框文本，Agent 据此决定；`read` 不受影响                                      |
| 超时     | 120 秒无人处理 → dismiss 并写 console 条目 `dialog_timeout`；`beforeunload` 也不自动接受——离开页面是否丢表单是人的决定                                        |
| 交接     | 人接管后未处理的对话框仍显示；Agent 的等待中动作按 §2.6 变 `unknown`                                                                                          |

### 2.5 URL 策略与重定向复检

结论：`admit_url` 从「导航时检查一次」改为「**每个文档请求**都检查」，实现方式是 `Fetch.enable` 拦截 `Document` 资源类型；重定向的每一跳都是一次 `Fetch.requestPaused`，因此自然覆盖。

| 项           | 决定                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拦截范围     | `Document` 类型请求（顶层与 iframe 导航、popup 首个请求）走完整策略；其余子资源只做元数据地址与保留端口的廉价检查（与现有 `admit_url` 一致），不做 DNS                                                               |
| 完整策略     | scheme 只 http/https → 拒实例元数据（`169.254.169.254`、`metadata.google.internal`、`fd00:ec2::254`）→ 拒本机 43120/43121 → `tokio::net::lookup_host` 解析，任一结果落在 link-local 或（策略关闭时）RFC1918/ULA 即拒 |
| 工作空间策略 | 工作空间设置 `browserPolicy { allowPrivateNetworks: true, loopbackPorts: "any" \| [..], popups: "tab" \| "block" }`；默认允许私网（开发者要看局域网设备）、允许除保留端口外的任何回环端口                            |
| 拒绝方式     | `Fetch.failRequest { errorReason: BlockedByClient }`；console 条目 `navigation_blocked { url, reasonCode }`；`browser.session` 事件里 `reason_code = navigation_blocked` 供地址栏显示                                |
| 已知限制     | 检查时的解析结果与 Chrome 自己的解析可能不同（DNS rebinding），本文不声称能防；列入 §7                                                                                                                               |
| 纯函数化     | 策略判定落在 `browser/policy.rs`，输入是 URL + 解析结果 + 策略，输出是 `Admit \| Refuse(reason)`，无需 Chrome 即可测试                                                                                               |

### 2.6 人机控制租约

结论：一个 session 一个 `BrowserControlLease`；读永远不需要租约，输入类动作需要。人显式「接管」立刻撤销 Agent 租约并拒绝其后续动作；人只是顺手点了一下，则 Agent 动作短暂排队。

| 状态 / 事件                     | 规则                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Free`                          | 任何一方首个输入动作即获得租约（人：`POST …/input`；Agent：任一需租约动词）                                                                                     |
| `Human { device_id, until }`    | 人的输入不断续期，空闲 10 秒自动释放。此时 Agent 动作 **排队** 等待释放，最多 5 秒，超时以 `LEASE_HELD_BY_HUMAN` 拒绝并附提示「人正在操作，稍后重试」           |
| `HumanTakeover { device_id }`   | 人点「接管」进入；Agent 租约立即撤销，队列中的动作以 `LEASE_REVOKED` 拒绝，已派发未返回的动作结果记为 `unknown` 写入活动日志且不重试；人点「交还」才回到 `Free` |
| `Agent { node_id, session_id }` | Agent 每个动作续期，空闲 30 秒释放；人的普通输入直接抢占（Agent 下一个动作被拒并说明），人的接管同上                                                            |
| 世代                            | 每次持有者变化 `lease_generation + 1`；输入请求可带 `lease_generation`，过期即拒                                                                                |
| 事件                            | `browser.lease { sessionId, holder, generation }`；所有客户端同步徽标                                                                                           |
| 权限                            | 接管/交还需要执行权限（Host 代理时对应 `terminal:write`），只读设备只能观看                                                                                     |

租约是内存状态，Runtime 重启后为 `Free`；`generation` 从存储的 `lease_generation` 列继续递增，避免旧客户端的世代号复活。

### 2.7 Agent 动词补全

现有 6 个动词不变。新增动词及其对应的 CDP 路径：

| 动词               | 参数                                                                                                              | 执行                                                                                                  | 租约     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| `select`           | `--ref/--selector`，`--value` 或 `--label`（可重复=多选）                                                         | `dom.rs` 固定脚本设置 `<select>` 选项并派发 `input`/`change`；非 `<select>` 目标返回 `NOT_SELECTABLE` | 是       |
| `press`            | `--key`（白名单：Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/F1–F12/单字符），`--modifiers` | `Input.dispatchKeyEvent` keyDown+keyUp 对；组合键不拆中文                                             | 是       |
| `scroll`           | `--direction up\|down\|left\|right --amount px` 或 `--to-ref`                                                     | 前者 `Input.dispatchMouseEvent wheel`（限幅同现有 `clamp_delta`），后者 `scrollIntoViewIfNeeded`      | 是       |
| `upload`           | `--path`（可重复），可选 `--ref/--selector`                                                                       | §2.3                                                                                                  | 是       |
| `download`         | `--list` 或 `--id --accept/--reject`                                                                              | §2.3                                                                                                  | 接受时是 |
| `back` / `forward` | 无                                                                                                                | 等价于 `navigate --action back/forward`，保留旧写法                                                   | 是       |
| `close`            | `--tab`                                                                                                           | §2.2；不提供结束 session 的动词                                                                       | 是       |
| `tabs`             | `--list` 或 `--switch ID` 或 `--new URL`                                                                          | §2.2；`--list` 无需租约                                                                               | 部分     |
| `dialog`           | `--accept/--dismiss [--text]`                                                                                     | §2.4                                                                                                  | 是       |
| `lease`            | `--status` 或 `--release`                                                                                         | 查看/释放自己的租约                                                                                   | 否       |

`tabs`、`dialog`、`lease` 超出设计 §7 的表，是多标签与租约引入后必需的配套；三者都不是新的能力面（不能执行页面代码，不能触达 profile）。`armadra-hook` 的 `BROWSER_VERBS` 与 `browser/agent.rs::VERBS` 同步扩到 16 项，帮助文本同步。每个动作（含被拒绝的）继续写 `.armadra/board-log.jsonl`。

### 2.8 活动徽标

| 位置           | 内容                                                                                                | 数据源                                    |
| -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 浏览器节点头部 | 控制者：无 / 你 / 其他设备 / Agent《节点标题》；接管 / 交还按钮；最近动作一行（`click e3-12 · 2s`） | `browser.lease`、`browser.activity`       |
| 标签条         | 每个标签的标题与加载态、待处理对话框圆点、下载数                                                    | `browser.tab`、`browser.dialog`、下载队列 |
| Agent 节点头部 | 「正在操作浏览器」小图标，指向该浏览器节点                                                          | 同上，按 `node_id` 过滤                   |
| 手机焦点页     | 同一组件，按钮进入软键盘工具条上方的常驻行                                                          | 同上                                      |

`browser.activity { sessionId, actor, verb, target, outcome, at }` 是新事件，只保留最近 20 条于 session 内存，不入库；持久记录仍是 board-log。

### 2.9 跨端画面

结论：帧流从工作空间事件通道搬到 **每 session 一条专用 WebSocket**，Host 已有的 `proxyStream` 原样代理；输入也可走这条通道以减少往返。工作空间事件通道只保留 `browser.session/tab/lease/dialog/activity` 等低频事件。

| 项         | 决定                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 端点       | `WS /api/workspaces/{id}/browser/sessions/{sid}/stream`；二进制帧：`BrowserStreamFrame` Protobuf（`BrowserFrame` 去掉 base64，直接 `bytes data`）；上行 `BrowserStreamClient`（oneof：`hello`/`ack`/`input`/`visibility`）                  |
| 订阅       | 连接建立即订阅，断开即退订；`hello` 带 `visibility`、`bandwidth_class`、`max_width`；服务端在 `BrowserSubscription` 里回实际预算，客户端显示降级而不是猜                                                                                    |
| 带宽等级   | `lan`（默认）：focused 65/1×/15fps；visible 40/2×/5fps。`wan`（Host 对外服务或非同源）：focused 50/2×/8fps + `maxWidth 1280`；visible 35/3×/3fps。`metered`（手机 `navigator.connection.saveData` 或用户选择）：45/3×/4fps + `maxWidth 960` |
| 扇出       | Chrome 每页只有一路 screencast；Worker 以所有订阅者中最高预算启动 screencast，再按每个订阅者的预算与未确认帧数（>2 帧未 ack 即跳过）逐路丢帧。每个订阅者独立，手机慢不拖累桌面                                                              |
| 输入       | `input` 上行沿用 `BrowserInputRequest` 语义（带 `navigation_epoch`、`frame_seq`、`lease_generation`）；HTTP `POST …/input` 保留作为回退                                                                                                     |
| Host 授权  | `scopes.go` 新增 `browserArea`：`GET`/stream 为 read；`navigate/input/dialog/upload/download decision/lease/tabs` 为 execute（浏览器在主机上打开网页，与终端同级）；`subscription` 为 write                                                 |
| 手机       | `MobileFocusPage` 直接渲染同一个节点组件；焦点页默认 `visibility = focused`、`bandwidth_class` 由 `navigator.connection` 推断；触摸事件已存在，接管按钮进入常驻行                                                                           |
| 目标与测量 | 设计 §8 的 p95 目标不变；批次 3 在本机与 Host 代理两条路径各测一次「点击→新帧」并写入实施记录，未达标不改标目标为完成                                                                                                                       |

### 2.10 进程组、清理与 profile 锁恢复

| 平台          | 进程边界                                                                                                                                                                                           | 清理                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| macOS / Linux | 现有 `process_group(0)`；SIGTERM→等待 2 秒→SIGKILL 整组                                                                                                                                            | 现有                                                |
| Windows       | 复用 `command/platform_windows.rs` 的 Job Object 模式：`CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，浏览器子进程 `AssignProcessToJobObject`；Chrome 自身的沙箱 job 作为嵌套 job 允许 | 关闭 job 句柄即终止全部；只能交叉编译，实机验收待办 |

SIGKILL 后恢复：Runtime 被 `kill -9` 时来不及结束浏览器，Chrome 在 profile 内留下 `SingletonLock`（Unix 是指向 `<hostname>-<pid>` 的符号链接；Windows 是命名互斥量 + `lockfile`）。恢复流程：

| 步骤 | 动作                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 迁移 0010 在 `browser_sessions` 增加 `pid`、`pid_started_at`、`cdp_port`、`lease_generation`；启动成功即写入，正常结束即清空                                      |
| 2    | `restore` 读到 `pid` 非空：核对进程存活且启动时间与 `pid_started_at` 一致（Unix 读 `ps -o lstart=`/`/proc/<pid>/stat`，Windows `GetProcessTimes`）                |
| 3    | 存活且匹配 → **重新附着**：读 profile 的 `DevToolsActivePort`（或存储的 `cdp_port`），走现有 `attach`，页面与 JS 堆都还在，`generation + 1`，`reason_code` 空     |
| 4    | 不存活 → 删除 `SingletonLock`、`SingletonSocket`、`SingletonCookie`（Windows 删 `lockfile`），按现有流程重新拉起                                                  |
| 5    | 存活但身份不匹配（pid 被复用）→ 不杀；状态 `disconnected`、`reason_code = profile_locked`，UI 显示占用者 pid 与「结束并恢复」按钮，用户确认后才 kill 再回到步骤 4 |

`launch.rs::remove_profile` 的「只删 browser-profiles 下的目录」保护不变。

### 2.11 协议增量（`browser.proto` 字段号）

已有消息只追加字段，编号接在现有最大值之后；新消息放到 `browser_control.proto`（同 package，避免单文件超 800 行）。

| 消息                         | 追加 / 新增                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserSession`             | `15 active_tab_id`、`16 tab_count`、`17 lease`（`BrowserLease`）、`18 pending_dialog`（`BrowserDialog`）、`19 pending_file_chooser`（`BrowserFileChooser`）、`20 lease_generation`                                                                                                                                                                                                                                                                             |
| `BrowserAvailability`        | `6 managed`（`BrowserManagedState`）                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BrowserFrame`               | `11 tab_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `BrowserSubscribeRequest`    | `5 bandwidth_class`（enum `BrowserBandwidthClass`：0 未指定、1 LAN、2 WAN、3 METERED）、`6 max_width`                                                                                                                                                                                                                                                                                                                                                          |
| `BrowserSubscription`        | `5 max_width`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `BrowserElement`             | `11 tab_id`、`12 frame_id`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BrowserDownload`            | `11 tab_id`、`12 sha256`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `BrowserNavigateRequest`     | `5 target`（`BrowserTarget`）                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `BrowserInputRequest`        | `6 target`、`7 lease_generation`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `BrowserReadRequest`         | `6 target`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BrowserClickRequest`        | `10 target`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `BrowserTypeRequest`         | `9 target`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BrowserWaitRequest`         | `7 target`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BrowserCaptureRequest`      | `5 target`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BrowserAction.action`       | `13 select`、`14 press`、`15 scroll`、`16 upload`、`17 dialog`、`18 tabs`、`19 lease`、`20 close_tab`、`21 managed_install`                                                                                                                                                                                                                                                                                                                                    |
| `BrowserActionResult.result` | `18 tabs`（`BrowserTabList`）、`19 lease`、`20 dialog`、`21 managed`                                                                                                                                                                                                                                                                                                                                                                                           |
| 新消息                       | `BrowserTarget`、`BrowserTab`、`BrowserTabList`、`BrowserLease`（`holder` oneof human/agent + `generation` + `expires_at_unix_ms`）、`BrowserDialog`、`BrowserFileChooser`、`BrowserManagedState`、`BrowserSelectRequest`、`BrowserPressRequest`、`BrowserScrollRequest`、`BrowserUploadRequest`、`BrowserDialogRequest`、`BrowserTabRequest`、`BrowserLeaseRequest`、`BrowserCloseTabRequest`、`BrowserStreamFrame`、`BrowserStreamClient`、`BrowserActivity` |

每个新消息各一份 `proto/fixtures/browser_*.hex` 与三端契约测试，按 [协议说明](../../proto/README.md) 的流程 `protocol:generate → check → test`。Runtime 的 JSON 字段名继续与 proto snake_case 一一对应。

### 2.12 存储增量

| 迁移                                   | 内容                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime `0010_browser_process.sql`     | `browser_sessions` 加 `pid`、`pid_started_at`、`cdp_port`、`lease_generation`、`active_tab_url`；标签不入库——重启后只恢复活动标签的 URL，其余标签的丢失在节点上如实显示 |
| Host `legacy/0010_browser_process.sql` | 与 `285e54ae` 对 0009 的处理一致，镜像给 H01 导入器，否则 staging 导入会因未知列拒绝                                                                                    |

## 3. 远端执行补全

### 3.1 仓库面板与文件管理

结论：全部收敛到 `WorkerServiceOperation`（Rust↔Rust 的版本锁定 JSON），只有字节流（上传、下载）用 `worker.proto` 的类型化消息。控制端删掉 `refuse_remote` 的 11 处调用与 `git_api.rs::workspace` 的 501，改走 `remote::resolve` + `proxy`。

| 操作（枚举值）                                                                                                                                                                                                                                                                                                                                               | Worker 侧执行                                           | 重放 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---- |
| `GIT_REPOSITORIES = 19`、`GIT_BRANCHES = 20`、`GIT_HISTORY = 21`、`GIT_COMMIT_DETAIL = 22`、`GIT_COMMIT_FILE_DIFF = 23`、`GIT_WORKTREES = 24`、`GIT_REBASE_TODO = 25`、`GIT_TAGS = 26`、`GIT_REMOTES = 27`、`GIT_STASHES = 28`、`GIT_STASH_DETAIL = 29`、`GIT_INTEGRATION = 30`、`GIT_CHERRY_PICK_PREVIEW = 31`、`GIT_HUNKS = 32`、`GIT_MESSAGE_SOURCE = 33` | Worker 进程内自己的 `REPOSITORIES` 注册表，路径是远端根 | 总是 |
| `GIT_OPERATIONS = 34`、`GIT_OPERATION_GET = 35`                                                                                                                                                                                                                                                                                                              | 同上                                                    | 总是 |
| `GIT_OPERATION_START = 36`、`GIT_OPERATION_CANCEL = 37`、`GIT_APPLY_HUNK = 38`                                                                                                                                                                                                                                                                               | 同上；需要 execute 授权                                 | 从不 |
| `FILE_INFO = 40`                                                                                                                                                                                                                                                                                                                                             | `imports::file_info`                                    | 总是 |
| `FILE_ENTRY_CREATE = 41`、`FILE_ENTRY_RENAME = 42`、`FILE_ENTRY_MOVE = 43`、`FILE_ENTRY_DELETE = 44`、`FILE_ENTRY_RESTORE = 45`                                                                                                                                                                                                                              | `file_ops`，回收站仍是远端 `.armadra/trash/<id>/`       | 从不 |
| `ASSET_IMPORT = 46`                                                                                                                                                                                                                                                                                                                                          | 源文件已在执行主机：按路径复制进远端 `.armadra/assets/` | 从不 |
| `WATCH_SUBSCRIBE = 47`、`WATCH_UNSUBSCRIBE = 48`                                                                                                                                                                                                                                                                                                             | §3.4                                                    | 总是 |

操作队列：现在 `git_api::REPOSITORIES` 是控制端进程全局、按本地路径串行。远端时队列在 Worker 进程内，控制端只转发；单连接互斥已经把同一主机的请求串行化，Worker 内再按 worktree 串行与仓库锁排序（[Git 设计](./git-github-design.md) §2）。Worker 重启后内存里的操作记录丢失，`GIT_OPERATION_GET` 回 404，界面显示「操作记录已丢失，仓库状态可读」，与设计里「外部或 Runtime 重启后的序列仍可读、不可驱动」一致。

帧上限：`MAX_FRAME` 1 MiB 不变。历史分页在 Worker 侧强制 ≤ 200 行/页；任何响应超出帧上限返回 413 `RESOURCE_EXHAUSTED` 并注明操作名，不截断。

字节流：

| 消息（`worker.proto`）                                                                                                                                                                       | 用途                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerUploadRequest = 17`（oneof `begin { root_id, path, total_bytes, sha256, overwrite_sha256? }` / `chunk { upload_id, offset, data }` / `commit { upload_id }` / `abort { upload_id }`） | 浏览器上传与白板资产 blob；Worker 写同目录临时文件，`commit` 时核对 sha256 后原子发布；`overwrite_sha256` 缺省即仅新建，与 `WorkerWriteFileRequest` 同语义 |
| `WorkerUploadResponse = 19`（`upload_id`、`received_bytes`、`sha256`、`path`）                                                                                                               | 每块回执，`commit` 回最终路径                                                                                                                              |
| 下载                                                                                                                                                                                         | 复用 `WorkerReadFileRequest` 分块读，控制端流式写 HTTP 响应并保持 `Content-Disposition: attachment`                                                        |

上传块 ≤ `max_file_chunk_bytes`（256 KiB）；经 Host 代理时单个 HTTP 请求受 `MaxProxyBodyBytes` 64 MiB 限制，控制端把浏览器的一次 multipart 拆成多块转发，超过工作空间上限（沿用 `imports::MAX_FILES` 与大小上限）在 `begin` 就拒绝。

### 3.2 白板资产导入

| 入口                             | 本机                              | 远端                                                                                          |
| -------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST …/assets/import`（按路径） | 现有                              | `ASSET_IMPORT`：路径解析、类型判断、去重 sha256 全在 Worker；返回同样的 `UploadAssetResponse` |
| `POST …/assets`（浏览器 blob）   | 现有                              | `WorkerUpload` 到远端 `.armadra/assets/<sha256>.<ext>`；去重逻辑在 Worker                     |
| 画布引用                         | `assetRef` 只含 `sha256` 与扩展名 | 不变；画布不关心资产在哪台机器，读取经 `file-download` 的远端路径                             |

### 3.3 执行主机切换规则

结论：切换 = **重绑定并核验**，不搬文件；搬文件是用户用 Git 做的事。任何不满足核验的切换拒绝并列出阻塞项，不做「部分切换」。

| 场景                                          | 结果                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本机 ↔ 远端、远端 A → 远端 B，目标路径已存在 | `PATCH /api/workspaces/{id}/execution-host { executionHostId, rootPath }`：新主机 `RegisterRoot` 成功 → 比较 `HEAD` OID 与顶层目录列表摘要 → 一致才写入            |
| 目标路径不存在或摘要不一致                    | 409 `root_mismatch`，返回两侧摘要；`force: true` 需要 write 权限并写审计事件 `workspace.executionHostChanged { from, to, forced }`                                 |
| 阻塞项存在                                    | 409 `switch_blocked`，`blockers[]` 列出：打开的编辑器草稿、该工作空间的活动终端会话、活动浏览器 session、指向它的自动化计划、进行中的 owned Git 操作、进行中的上传 |
| 要求「迁移文件」                              | `UNSUPPORTED`，消息提示在新主机 clone 后另开工作空间                                                                                                               |
| 切换成功后                                    | 释放本地 `file_watch` 与 `remote::watch` 登记、清空 Git 仓库发现缓存、广播 `workspace.updated`，前端全量重取；节点与画布不动                                       |
| H01 之后                                      | 同一规则表由 Host 的工作空间表面执行（`canvas.proto` 的 `Workspace.executionHostId` 已存在）；Runtime 只做核验回调                                                 |

终端会话绑定主机，不迁移；`A04` 的「跨执行主机交接」仍不支持。

### 3.4 远端监听：从轮询到 notify 事件

结论：Worker 在执行主机上运行同一份 `file_watch`（notify crate），事件作为 **主动帧** 沿现有 stdio 连接推回；控制端把 `Connection` 从「写一帧读一帧」改成「写请求 + 读任务按 `request_id` 解复用」。没有该能力的旧 Worker 继续 2 秒轮询。

| 项       | 决定                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 能力     | `WorkerHelloResponse.capabilities` 增 `remote.watch.v1`                                                                                                            |
| 订阅     | `WATCH_SUBSCRIBE { paths[] }` / `WATCH_UNSUBSCRIBE`，按 root 计数；`MAX_WATCH_PATHS` 上限不变                                                                      |
| 事件帧   | `WorkerResponse.result = watch_event = 17`（`WorkerWatchEvent { root_id, sequence, changes[] { path, kind, sha256, size, mtime } }`），`request_id` 为空标识主动帧 |
| 顺序     | `sequence` 每连接单调；控制端重连后重新订阅并做一次 `WATCH_POLL` 对账，弥补断线期间的缺口                                                                          |
| 请求语义 | 请求仍由互斥串行，`UNKNOWN_OUTCOME` 与重放规则不变；读任务 EOF 即刻标记断线，不再等下一次请求才发现                                                                |
| `.git`   | 命中 `.git` 的事件同样推送，控制端据此失效仓库发现缓存（与本机一致）                                                                                               |
| 复用     | 这条通道就是将来远端浏览器帧流与 Host→Web 事件的载体；本轮只承载监听                                                                                               |

### 3.5 版本锁定放宽为「协议兼容范围」

结论：精确 `runtime_version` 相等改为三项判定；满足则允许两端补丁/次版本不同，`runtime_version` 差异降为节点徽标提示。

| 判定                                                                                   | 来源                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol.major` 相等且 `minor` ≥ 控制端要求                                           | 现有握手                                                                                                                                                                                              |
| `service_contract_version` 相等（`WorkerHelloResponse.service_contract_version = 11`） | 新常量 `remote::service::CONTRACT_VERSION`；契约测试把每个 `WorkerServiceOperation` 的请求/响应 serde 类型的 JSON 快照写在 `apps/runtime/tests/fixtures/service/*.json`，快照变化而常量未升即测试失败 |
| 逐操作 capability                                                                      | `remote.git.panel.v1`、`remote.files.manage.v1`、`remote.upload.v1`、`remote.watch.v1`；缺哪项，哪项 501 并写明能力名，其余照常                                                                       |

放宽的前提条件（未满足前保持精确匹配）：快照测试存在并进 CI；服务载荷的响应类型对未知字段宽容（serde 默认），请求类型不依赖 `deny_unknown_fields` 做安全判断（安全判断在 `security::*` 与授权位，不在字段集合）。

### 3.6 真实 SSH 认证与 host key 确认

结论：host key **永远不由 `ssh` 自己接受**；认证提示经 Runtime 的 askpass 助手转到界面，密码只在内存中经过一次。

| 项          | 决定                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 指纹获取    | 保存/测试主机时 Runtime 以 argv 运行 `ssh-keyscan -p PORT -t ed25519,ecdsa,rsa HOST`，用 `ssh-keygen -lf` 得出 SHA256 指纹；返回 `{ keys[] { type, fingerprint, line } }` 给设置页                                                                                         |
| 用户确认    | 设置 → SSH → 主机 显示指纹，用户点「信任」后写入 `<data_dir>/ssh/known_hosts`（0600），仅此一处；不改用户的 `~/.ssh/known_hosts`                                                                                                                                           |
| 启动参数    | 所有 Worker / 探测 argv 加 `-o UserKnownHostsFile=<data_dir>/ssh/known_hosts ~/.ssh/known_hosts -o StrictHostKeyChecking=yes`；`extra_args` 禁止覆盖 `stricthostkeychecking`、`userknownhostsfile`、`globalknownhostsfile`（加入 `FORBIDDEN_OPTIONS`，现有测试用例随之改） |
| 指纹变化    | `ssh` 因 key 变化失败 → Runtime 识别 stderr 的 `REMOTE HOST IDENTIFICATION HAS CHANGED` 并重新 keyscan → 界面显示旧/新指纹与「替换」按钮，替换只改 Runtime 自己的文件                                                                                                      |
| 密码 / 口令 | Worker 启动改 `BatchMode=no` + `NumberOfPasswordPrompts=1` + `SSH_ASKPASS=<runtime 可执行> ssh-askpass` + `SSH_ASKPASS_REQUIRE=force`（OpenSSH ≥ 8.4，旧版设 `DISPLAY` 兜底）；助手用一次性令牌经端点文件连回 Runtime                                                      |
| 提示流程    | Runtime 广播 `ssh.prompt { promptId, hostId, kind: password \| passphrase, prompt }`（`prompt` 经 `redact_secrets`）→ 界面 Dialog → `POST /api/ssh/hosts/{id}/prompts/{promptId} { answer }` → 助手打印到 stdout → `ssh`；答案不落盘不入日志；120 秒无应答助手退出 1       |
| 权限        | 应答提示需要执行权限（Host 代理时 `terminal:write`）                                                                                                                                                                                                                       |
| 终端 SSH    | 终端节点本来有 TTY，`ssh` 在终端内自己提示；只把 known_hosts 两个 `-o` 一并加上，行为一致                                                                                                                                                                                  |
| Agent 转发  | 默认继承 `SSH_AUTH_SOCK`，不做 agent forwarding（`-A`）                                                                                                                                                                                                                    |

### 3.7 与 H01 迁移后 Worker 角色的关系

| 阶段                       | 谁持有 SSH 连接                         | 本轮设计如何对齐                                                                                                                                   |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现在（Runtime 为业务权威） | Rust Runtime（`remote/client.rs`）      | 所有远端能力收敛在 `WorkerServiceOperation` + 少量类型化字节流消息                                                                                 |
| H01 完成后（Host 为权威）  | Go Host（`apps/host/internal/worker`）  | Host 对 `WorkerServiceRequest` **只校验 `root_id` 与授权位、不解析 `request_json`**，作为不透明字节转发给远端 Worker；本机 Runtime 退为本机 Worker |
| 事件                       | Host 事件 outbox（durable sequence）    | `WorkerWatchEvent` 进入 Host outbox 再到 Web，替代目前的 3 秒轮询；`sequence` 语义与 H01 一致                                                      |
| 授权                       | Host 的 scope（read / write / execute） | 与 `allow_write` / `allow_execute` 一一对应，Worker 侧复核不变                                                                                     |

这就是为什么本轮不给远端操作定义 Go 能读的类型化 Protobuf：Host 迁移期间它本来就不需要读懂，读懂了反而要在 Go 里重写一遍 Rust 的校验。

### 3.8 协议增量（`worker.proto`）

| 消息                     | 变化                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `WorkerHelloResponse`    | `11 service_contract_version`                                            |
| `WorkerServiceOperation` | 19–48 见 §3.1、§3.4；`reserved 39, 49` 留给后续 Git/文件项               |
| `WorkerRequest.action`   | `16 watch`（`WorkerWatchRequest`）、`17 upload`（`WorkerUploadRequest`） |
| `WorkerResponse.result`  | `17 watch_event`（主动帧）、`18 watch`（订阅回执）、`19 upload`          |

## 4. 代码布局

规则：单文件 ≤ 800 行、测试与实现分离（子模块 `tests/*.rs` 或 `apps/runtime/tests/*.rs`）、一级包按组件分目录。现有超限文件（`browser/session.rs` 2167、`browser/tests.rs` 1095、`browser/mod.rs` 731、`remote/client.rs` 772）随本轮拆分，不另开豁免。

### 4.1 Rust：`apps/runtime/src/browser/`

| 文件                                                     | 职责                                                                                                         | 来源                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `mod.rs`                                                 | 模块声明、`BrowserService` 注册表、re-export                                                                 | 现 `mod.rs` 精简             |
| `model.rs`                                               | `SessionState`、`Viewport`、`BrowserSession`、`Element`、`Download`、`Tab`、`Lease`、`Dialog`、`FileChooser` | 现 `mod.rs` 域类型移出       |
| `store.rs`                                               | `browser_sessions` 读写、迁移 0010 列                                                                        | 现 `mod.rs` storage 段       |
| `policy.rs`                                              | `admit_url`、网络策略、`Fetch` 决策纯函数                                                                    | 现 `mod.rs` URL admission 段 |
| `launch/mod.rs`                                          | `availability`、候选路径                                                                                     | 现 `launch.rs`               |
| `launch/managed.rs`                                      | 清单、下载、校验、安装                                                                                       | 新                           |
| `launch/process.rs`                                      | spawn、进程组 / Job Object、terminate、SingletonLock 恢复、pid 身份                                          | 现 `launch.rs` + 新          |
| `cdp.rs`                                                 | CDP 客户端，增加按 sessionId 路由                                                                            | 现                           |
| `dom.rs`                                                 | 固定脚本，增 select / scroll / frame rect                                                                    | 现                           |
| `session/mod.rs`                                         | `Live` 结构、`ensure` / `start` / `attach` / `restore` / `shutdown`                                          | 现 `session.rs` 拆           |
| `session/pump.rs`                                        | CDP 事件泵：导航、console、network、下载、对话框、target                                                     | 同上                         |
| `session/stream.rs`                                      | screencast 预算、扇出、ack 背压                                                                              | 同上 + 新                    |
| `session/input.rs`                                       | 输入编码、租约与对话框检查                                                                                   | 同上                         |
| `session/actions.rs`                                     | click / type / select / press / scroll / wait / capture                                                      | 同上 + 新                    |
| `session/targets.rs`                                     | tab / frame 寻址、元素引用解析、坐标换算                                                                     | 新                           |
| `session/dialogs.rs`                                     | JS dialog、file chooser、popup 策略                                                                          | 新                           |
| `session/downloads.rs`                                   | 下载队列与接受                                                                                               | 现 `session.rs` 拆           |
| `session/lease.rs`                                       | 租约状态机（纯逻辑，可无 Chrome 测试）                                                                       | 新                           |
| `agent/mod.rs`                                           | 动词分发、三重授权、活动日志                                                                                 | 现 `agent.rs`                |
| `agent/render.rs`                                        | 文本渲染                                                                                                     | 现 `agent.rs` 拆             |
| `routes/mod.rs`                                          | HTTP 路由                                                                                                    | 现 `routes.rs`               |
| `routes/stream.rs`                                       | 专用帧流 WebSocket                                                                                           | 新                           |
| `tests/{policy,lease,targets,model}.rs`                  | 无需 Chrome 的单元测试                                                                                       | 现 `tests.rs` 拆             |
| `apps/runtime/tests/browser_{process,actions,stream}.rs` | 真实 Chrome 集成测试，沿用 `browser_or_skip` 的显式跳过                                                      | 现 `tests.rs` 拆             |

### 4.2 Rust：`apps/runtime/src/remote/`、`worker/`、`terminal/ssh/`

| 文件                                                               | 职责                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `remote/mod.rs`                                                    | `resolve` / `Execution` / `JsonAnswer` / `proxy`（现有） |
| `remote/client/mod.rs`                                             | `RemoteWorker` 公开 API                                  |
| `remote/client/connection.rs`                                      | 帧读写、读任务与 `request_id` 解复用、主动帧分发         |
| `remote/client/supervisor.rs`                                      | 重连、退避、冷却                                         |
| `remote/client/handshake.rs`                                       | hello 校验、兼容范围判定、capability 检查                |
| `remote/service/mod.rs`                                            | `handle` / `dispatch` 入口与授权位复核                   |
| `remote/service/{files,git,assets}.rs`                             | 各组操作                                                 |
| `remote/service/replay.rs`                                         | `Replay` 表与 `CONTRACT_VERSION`                         |
| `remote/watch/{mod,poll,events}.rs`                                | 登记表、轮询回退、事件通道                               |
| `remote/upload.rs`                                                 | 控制端分块上传状态机                                     |
| `remote/switch.rs`                                                 | 执行主机切换核验与阻塞项收集                             |
| `worker/{mod,service,watch,upload}.rs`                             | Worker 侧分发、监听、上传                                |
| `terminal/ssh/{mod,argv,known_hosts,askpass,prompts}.rs`           | 配置校验、argv、指纹与信任文件、askpass 助手、提示路由   |
| `apps/runtime/tests/remote_{execution,watch,upload,switch,ssh}.rs` | 伪 SSH 集成测试，沿用 `ARMADRA_REMOTE_WORKER_LAUNCHER`   |

### 4.3 TypeScript：`apps/web/src/nodes/browser/`、`packages/shared`

| 文件                                                                         | 职责                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `BrowserNode.tsx`                                                            | 壳：模式切换、状态、布局（≤ 300 行）            |
| `surface/Surface.tsx`                                                        | 位图 canvas、输入映射、IME 透明层               |
| `surface/stream.ts`                                                          | 帧流 WebSocket 客户端、ack、带宽等级推断        |
| `surface/input.ts`                                                           | 事件编码与合批（现有纯函数）                    |
| `toolbar/{AddressBar,TabStrip,Badges}.tsx`                                   | 地址栏、标签条、控制者/活动徽标                 |
| `panels/{DownloadsSheet,DialogPrompt,FileChooser,UnsupportedPanel}.tsx`      | 下载队列、对话框、上传选择、不可用与受管安装    |
| `hooks/{useBrowserSession,useLease,useStream}.ts`                            | 状态订阅                                        |
| `geometry.ts`                                                                | `surfacePoint` / `clampViewport` / `renewDelay` |
| `index.ts`                                                                   | 注册表导出                                      |
| `*.test.tsx`                                                                 | 与实现同目录、单独文件                          |
| `apps/web/src/i18n/browser.ts`                                               | 浏览器文案独立文件                              |
| `apps/web/src/panels/settings/pages/ssh/{HostKeyDialog,SshPromptDialog}.tsx` | 指纹确认、认证提示                              |
| `packages/shared/src/browser.ts`                                             | 从 `api.ts`（2055 行）抽出的浏览器 schema       |

### 4.4 Protobuf 与 Go

| 位置                                     | 变化                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `proto/armadra/v1/browser.proto`         | §2.11 的追加字段                                                     |
| `proto/armadra/v1/browser_control.proto` | 新消息（tab / lease / dialog / chooser / managed / stream / 新动作） |
| `proto/armadra/v1/worker.proto`          | §3.8                                                                 |
| `proto/fixtures/`                        | 每个新消息一份 `.hex`                                                |
| `apps/host/internal/server/scopes.go`    | `browserArea` 与路径分类                                             |
| `apps/host/internal/migration/legacy/`   | `0010_browser_process.sql` 镜像                                      |

## 5. 实施拆解

批次 0 串行先行，1–5 可并行；每批独立 worktree、私有 `CARGO_TARGET_DIR`，验证通过后单独提交。

| 批次 | 范围                                                                                                                                                                                          | 验收命令                                                                                                                                                                                                | 真实进程验证                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 协议与类型冻结：§2.11、§3.8 全部消息与 fixture；`packages/shared/src/browser.ts`；迁移 0010 与 Host 镜像；`browser/model.rs`、`policy.rs`、`store.rs` 拆分（纯搬迁）                          | `pnpm protocol:generate && pnpm protocol:check && pnpm protocol:test`；`cargo test -p armadra-runtime browser::`；`go -C apps/host test ./internal/migration/...`；`pnpm --filter @armadra/shared test` | 无；搬迁后现有 17 项浏览器测试在本机 Chrome 上全数通过是门槛                                                                                                                                                                                                                                                                                                                                                    |
| 1    | 浏览器进程与二进制：`launch/managed.rs`、`launch/process.rs`（Job Object、SingletonLock 恢复、pid 身份）、`policy.rs` 的 Fetch 重定向复检                                                     | `cargo test -p armadra-runtime --test browser_process`；`cargo check -p armadra-runtime --target x86_64-pc-windows-msvc`；`cargo check -p armadra-runtime --target x86_64-unknown-linux-gnu`            | 本机 Chrome：启动 session → 丢弃 `Live` 不 terminate（模拟 SIGKILL）→ 新服务 `restore` 经存储端口重附着且 URL 不变；再 `kill -9` Chrome → `restore` 清锁重启。本地静态页 `/redirect` 跳到 `http://169.254.169.254/` 被拦并出现 console 条目。受管安装用本地 HTTP 服务提供假 zip，正确/错误 sha256 各一例                                                                                                        |
| 2    | 目标、对话框、上传下载、动词：`session/{targets,dialogs,downloads,actions}.rs`、`dom.rs`、`agent/*`、`armadra-hook` 动词与帮助                                                                | `cargo test -p armadra-runtime --test browser_actions`；`cargo test -p armadra-hook`                                                                                                                    | 本机 Chrome + 两个端口的本地静态页：同源 iframe 与跨源 iframe 内 `read/click`；`<select>` 经 `select`；`input[type=file]` 经 `upload` 回填项目文件；`window.open` 成新标签且被策略拦截的 popup 关闭；`alert/confirm/prompt` 经 `dialog`；`<a download>` 进队列并 `download --accept`                                                                                                                            |
| 3    | 租约、徽标、帧流与跨端：`session/{lease,stream}.rs`、`routes/stream.rs`、`scopes.go`、`nodes/browser/*`、`MobileFocusPage` 接入、i18n                                                         | `cargo test -p armadra-runtime --test browser_stream`；`go -C apps/host test ./internal/server/...`；`pnpm --filter @armadra/web test && pnpm --filter @armadra/web typecheck`                          | `pnpm browser:e2e`（仿 `canvas:e2e`）：真实 Runtime + Host `--serve-web`，无头 Chrome 以 390×844 打开焦点页，断言收到帧、点击后新帧到达、接管撤销 Agent 租约（Agent 动作返回 `LEASE_REVOKED`）；记录两条路径的点击→新帧 p95                                                                                                                                                                                     |
| 4    | 远端仓库面板、文件管理、上传与资产：`remote/service/*`、`worker/{service,upload}.rs`、`remote/upload.rs`、删除 11 处 `refuse_remote` 与 `git_api` 501                                         | `cargo test -p armadra-runtime --test remote_execution --test remote_upload`；`pnpm --filter @armadra/web test`                                                                                         | 伪 SSH 运行器（现有脚本）：分支/历史/stash/worktree/操作队列 start+cancel、file-entries 新建/改名/删除/还原、3 MiB 分块上传 sha256 校验、按路径资产导入；操作中途 `kill -9` Worker → `UNKNOWN_OUTCOME` 且重连后只重放读操作                                                                                                                                                                                     |
| 5    | 远端 notify、兼容范围、SSH 认证、主机切换：`remote/client/*` 重构、`remote/watch/events.rs`、`worker/watch.rs`、`handshake.rs` + 快照测试、`terminal/ssh/*`、`remote/switch.rs`、设置页对话框 | `cargo test -p armadra-runtime --test remote_watch --test remote_switch --test remote_ssh`；`pnpm --filter @armadra/web test`                                                                           | 伪 SSH：远端目录写文件 → `file.changed` 在 500 ms 内到达；断连重连后对账无重复事件。伪 `ssh` 脚本打印 `password:` 并调用 `SSH_ASKPASS` → Runtime 广播 `ssh.prompt` → 应答后连接继续。`ARMADRA_SSH_KEYSCAN` 指向假脚本输出固定公钥行，`ssh-keygen -lf`（本机真实二进制）算指纹 → 信任 → 文件内容断言；指纹变化 → 替换流程。切换：两台伪主机指向同一目录成功，不同目录 409 `root_mismatch`，有草稿 409 列出阻塞项 |

实施状态 · 批次 0（已完成，本机 macOS）：§2.11 的追加字段与 20 个新消息全部落在 `browser.proto`（769 行）而非新开 `browser_control.proto` —— 拆分会形成循环导入（`BrowserStreamClient` 需要 `BrowserInputRequest`，`BrowserSession` 需要 `BrowserLease`），单文件行数目标已经满足；27 份 fixture 与三端契约测试（`contract_browser_v2.rs` / `contract-browser-v2.test.ts` / `browser_v2_contract_test.go`）、`packages/shared/src/api/browser.ts`、迁移 0010 与 Host legacy 镜像、`browser/{model,policy,store}.rs` 拆分均已提交；`pnpm protocol:check`、`pnpm protocol:test`、`go -C apps/host test ./internal/migration/...`、`cargo test -p armadra-runtime --lib browser::`（搬迁后 17/17）通过。`BrowserTab` 不带 CDP `targetId`。

实施状态 · 批次 1（已完成，本机 macOS + 本地静态页）：`launch/{managed,process}.rs` 落地受管清单与「下载 → 全量 sha256 → 解压 → codesign → 单次 rename」校验链、受管优先于本机检测、Unix 进程组与 Windows Job Object、启动即写 pid/started_at/cdp_port、SIGKILL 后按 pid 身份重附着或清 `SingletonLock` 重启、`Fetch` 对 Document 请求逐跳复检；浏览器测试 17 → 27 项全绿（新增 SIGKILL 重附着与清锁、重定向复检、受管清单四条失败路径、纯策略判定）。两处未做：`browser-manifest.json` 的 `targets` 留空且下载默认关闭（本仓库没有经真实下载核对过的 sha256，写一个猜的摘要只会让每次安装以 `sha256_mismatch` 失败），受管安装的 HTTP 路由与设置页按钮随批次 3 的面板一起做；Windows/Linux 的 `cargo check` 在本机无法运行（缺 Windows SDK 头文件与 `x86_64-linux-gnu-gcc`，`aws-lc-sys` 构建失败），与本轮改动无关，仍按「只能交叉编译、实机待办」记。

实施状态 · 批次 3（已完成，本机 macOS + 本机 Chrome + 真实 Host 代理）：`session/lease.rs` 的状态机按 §2.6 逐行落地（人的普通输入抢占 Agent、Agent 排队 ≤ 5 秒后 `LEASE_HELD_BY_HUMAN`、接管即 `LEASE_REVOKED` 且不排队、世代随持有者变化 +1 并落 `lease_generation` 列、人 10 秒 / Agent 30 秒空闲自动释放、接管不自动过期）；`session/stream.rs` 改为每订阅者独立预算与背压，`routes/stream.rs` 提供 `WS …/browser/sessions/{sid}/stream`（下行 `BrowserStreamFrame`、上行 `BrowserStreamClient` 的 hello / ack / input / visibility，连接即订阅、断开即退订，输入被拒时回 `{ code, message }`）；`POST …/lease`、`GET …/activity` 与 `GET/POST/DELETE /api/browser/managed` 落地，`scopes.go` 新增 `browserArea`（读=`terminal:read`，`subscription`=write，其余=execute；`/api/browser/managed` 是该空间唯一的机器级路由，其余一律拒绝）；Web 拆成 `nodes/browser/{BrowserNode,Frame,Lease,Managed,geometry,input,session,stream}`（最大 400 行）、文案移入 `i18n/browser.ts`，`MobileFocusPage` 为浏览器节点加常驻控制行。

实测（本机 macOS，Chrome 141，20 次「点击 → 新帧」）：本机路径 p95 **69 ms**（中位 68 ms，LAN focused 15 fps）；经真实 Host 代理、配对设备、390×844 手机视口的路径 p95 **145 ms**（中位 128 ms，WAN focused 8 fps，其中约 125 ms 是带宽等级自己的节流间隔）。两条都优于 §8 的 p95 ≤ 350 ms。测量脚本是 `cargo test -p armadra-runtime --test browser_stream` 与 `go -C apps/host test ./cmd/armadra-host -run TestAPhoneWatches`，没有 Chrome 时两者显式跳过。

真实运行改掉了设计里两处会失效的写法，均已在代码注释里写明原因：**一、`everyNthFrame` 不再下发给 Chrome（固定 1）**——它数的是重绘次数而不是时间，一次点击只重绘一次时那一帧会被整个吞掉，观看者会一直停在旧画面上；实测 N=2 时点击只有在 5 秒扫描重启 screencast 时才出画面（p95 4.8 s），改成按订阅者节流后降到 145 ms，`Budget::every_nth` 保留为等级宽窄的判据。**二、背压计的是「已发未确认的帧数」而不是序号差**——`frame_seq` 是 session 计数器，会跳过这一路自己节流掉的帧，用序号差会让完全跟得上的客户端被误判为落后，实测每 20 次点击有 1 次白等一个 `ACK_PATIENCE`。另外 `StreamState.running` 存的是「要求的预算」而不是「告诉 Chrome 的宽度」，否则两者不相等会让扫描每 5 秒拆一次 screencast。

批次 3 的协议增量：§2.11 的表没有为「哪个设备在操作」留字段，而 §2.6 的 `Human { device_id }` 与 §2.8 的「你 / 其他设备」都需要它，Host 又不会把认证过的设备身份转发给 Runtime。因此追加三个字段：`BrowserSubscribeRequest.device_id = 7`、`BrowserInputRequest.device_id = 8`、`BrowserLeaseRequest.{device_id = 5, display_name = 6}`。它们是客户端自报的不透明串，只用于把持有者区分开，不授予任何权限；`browser_action_lease` fixture 与三端契约测试同步覆盖。

批次 3 未做：帧流仍只有 JPEG（视频通道按 §7 保留）；`browser.frame` 工作空间事件通道保留给尚未迁移的客户端，Web 节点已不再使用它，因此没有订阅者时不再产生 base64；`pnpm browser:e2e` 没有单开脚本——同样的真实链路由上面两个测试覆盖，无头 Chrome 的画布 e2e 不需要再跑一遍；手机实机仍是待办，390×844 是视口模拟。

实施状态 · 批次 2（已完成，本机 macOS + 两个端口的本地静态页）：CDP 连接从单个 page target 改为**浏览器级 socket**（`launch::browser_target` + `cdp.rs` 按 `sessionId` 路由 `call_on` / `notify_on`），`Target.setAutoAttach` 带 `filter:[{type:"page"}]`（旧构建回落到无 filter 并跟进一层 `tab` 目标）；新增 `session/{targets,tabs,dialogs,actions}.rs`，`session.rs` 的 click/type 与元素引用迁入 `actions.rs` / `targets.rs`，`input.rs` 只留人的原始输入。元素引用为 `e<epoch>-<idx>`（活动标签主 frame）与 `e<epoch>-<idx>@<tab>/<frame>`（其余），引用自带地址、优先于请求上的 `--tab/--frame`；`read --mode elements` 会一并读出各 iframe 的元素并换算到标签视口坐标，这是 Agent 拿到 frame id 的唯一途径（设计原文没有写 frame 的发现方式，`BrowserElement.tab_id/frame_id` 正是为此留的）。跨 frame 坐标经 `DOM.getFrameOwner` + `DOM.resolveNode` + 固定函数 `dom::FRAME_ORIGIN` 逐级累加。下载升到浏览器级并带 `tab_id` 与完成后的 `sha256`（完成即回到 `pending`，与「暂存 → 人工接受」一致）；上传走 `Page.setInterceptFileChooserDialog` + `DOM.setFileInputFiles`，只收工作空间相对路径、拒绝绝对路径与 `.armadra/trash`、60 秒无人应答回填空列表；对话框记入标签并广播，输入类动作对该标签一律 `DIALOG_PENDING`（含 `POST …/input`），120 秒无人处理即 dismiss，`beforeunload` 不自动接受。动词补全到 16 个（`lease` 留给批次 3），`armadra-hook` 的 `BROWSER_VERBS` 与帮助同步，两端一致由测试断言；每个动作写入 `BrowserActivity`（session 内存 20 条 + `browser.activity` 事件）与 board-log。浏览器测试 27 → 37 项全绿（跨源/同源 iframe 读点与导航后 `STALE_TARGET`、`window.open` 成标签与切换/关闭/`LAST_TAB`、策略拦截弹窗、alert/confirm/prompt 与 `DIALOG_PENDING`、`beforeunload`、上传三条拒绝路径与 chooser 回填、下载 sha256 一致、select/press/scroll、动词表一致、引用解析纯函数）。

批次 2 的偏差与未做项：`Target.attachedToTarget` 后必须立刻 `Runtime.runIfWaitingForDebugger`，否则 `window.open` 的那次点击不会返回；frame 的执行上下文只在 `Runtime.executionContext{Destroyed,sCleared}` 时作废，不在 `frameNavigated` 时作废——同源子 frame 的首次导航会复用初始上下文，跟着导航清掉会让该 frame 读不到。真实 Chrome 测试仍放在 `apps/runtime/src/browser/tests/`（`frames` / `tabs` / `dialogs` / `transfers` / `verbs`）而不是 `apps/runtime/tests/browser_actions.rs`，与批次 1 的做法一致，验收命令相应是 `cargo test -p armadra-runtime --lib browser::`。`NetworkPolicy` 新增 `popups`，但工作空间设置尚未写入它（`Live::set_policy` 是唯一入口，界面随批次 3）；上传的 HTTP 响应 `Uploaded` 没有对应的 proto 消息与 shared schema；每 session 16 个标签的上限只有纯逻辑与 `TabList.limit` 覆盖，没有开 16 个真实标签去测；人的输入不写 `BrowserActivity`（会随每次鼠标移动刷屏），留到批次 3 与租约一起做；帧载荷仍走工作空间事件通道且不带 `tab_id`，属批次 3。

批次 2 + 3 合并（已完成，本机 macOS + 本机 Chrome）：两批各自改了同一批文件，合并按语义而非按行做。帧流落在多目标模型上——`screencast.rs` 的改动进了批次 3 改名后的 `session/stream.rs`，`Page.screencastFrameAck` 回到出帧的那个 CDP session，非活动标签的帧只确认不发布，`StreamState` 记住 screencast 起在哪个 session，切标签时按记住的那个停、按订阅者预算在新标签重起（切标签不改预算，也不重建订阅）。租约按 session 而非按 target：一个会话一个租约，换标签不换持有者。`POST …/input` 先查对话框再取租约——被 `DIALOG_PENDING` 拒掉的一批输入不应顺手改变谁在控制。`events.rs` 同时保留两批的事件变体（`browser.lease` / `tabs` / `dialog` / `fileChooser` / `activity`），`Activity` 只留批次 3 的 `&'static str` 版本，`describe_target` 保留，`NetworkPolicy.popups` 保留。

第十七个动词 `lease --status | --release` 在此补上：批次 2 把它留给批次 3，批次 3 只做了 `POST …/lease` 的人机接管而没有动词，两批合并后 §2.7 的表才完整。它不取租约（取租约就没法用来查「谁在挡着我」），也不能替人接管——接管是人在客户端做的决定。同时按 §2.7 的「部分」列把 `tabs --list` 与 `download --list` 排除在取租约之外，只有 `--switch/--new` 与 `--accept/--reject` 取。`BROWSER_VERBS` 与 `agent::VERBS` 同步为 17 项，帮助文本补上 `lease` 与两条租约拒绝码，两端一致仍由测试断言。

合并后验证：`cargo test -p armadra-runtime --lib browser::` 59 项全绿（批次 1 的 27 + 批次 2 的 10 + 批次 3 的 22），`--test browser_stream` 2 项通过、本机路径「点击 → 新帧」p95 70 ms（中位 68 ms，20 次）；`cargo test -p armadra-runtime`、`cargo test -p armadra-hook`、`cargo clippy --workspace --exclude armadra-desktop --all-targets -D warnings`、`cargo fmt --all --check`、`pnpm protocol:check`、`pnpm --filter @armadra/web test` 与 `typecheck`、`pnpm check`、`go -C apps/host test ./internal/server/...` 通过。Host 侧不需要改：`browserClass` 按「读=read、`subscription`=write、其余=execute」分类，批次 2 的 `tabs` / `dialog` / `upload` 路由已经落在正确的一档。

合并未做（已在下面的「浏览器收尾」里补上）：`browser.tabs` / `browser.dialog` / `browser.fileChooser` 三个事件仍不在 `packages/shared` 的事件联合里，Web 的 `safeParse` 只会丢掉它们并告警——标签条与对话框的界面本就是批次 2 记下的未做项，补 schema 而不补界面只是把缺口挪个位置。批次 2 与批次 3 各自的未做项都仍然成立。

实施状态 · 浏览器收尾（已完成，本机 macOS + 本机 Chrome 152）：把上面记下的浏览器未做项一次补齐。

**事件联合**：`packages/shared/src/api/events.ts` 加入 `browser.tabs`（带整张 `BrowserTabList`）、`browser.dialog` 与 `browser.fileChooser`（两者的载荷可缺席，缺席即「已答复 / 已超时」）。整张标签表一起推而不是逐条差分：一次 `window.open` 同时改活动标签和标签数量，分两条推会让标签条在中间那一刻显示一个从未存在过的状态。

**标签条**：`apps/web/src/nodes/browser/TabStrip.tsx`——先取一次 `GET …/tabs` 再听事件（节点是后挂上来的，会话可能已经开了三个标签），一个标签时整条不显示（标题在节点头部，地址在地址栏）。加载中与待答复对话框是两个不同的记号：前者自己会结束，后者要人答复。手机焦点页渲染的就是同一个 `BrowserNode`，所以标签条、对话框、文件选择器在焦点页上一并生效，不另写一套。

**图标**：`BrowserTab.favicon = 9` 是 `data:` URL，不是地址。给地址意味着每个画标签条的客户端用**自己**的浏览器和 cookie 去访问那个站点——包括 Host 另一头的手机——而正在访问它的是受控会话。所以由页面自己 `fetch` 自己的图标（`dom::FAVICON` 固定脚本，`credentials: "omit"`、8 KB 上限），在 `Page.loadEventFired` 后经 `session/favicon.rs` 取一次；导航提交即清空旧图标，取不到就是空串，界面退回站点首字母。

**对话框与文件选择**：`Prompts.tsx` 用 shadcn `Dialog` 呈现 `alert/confirm/prompt/beforeunload` 并回传 `POST …/dialog`；`alert` 只给一个按钮（给「取消」等于暗示有第二种答复），关掉弹层等于「不接受」而不是「当作没看见」——页面还停在那里。文件选择两条路：桌面端用 Tauri 对话框拿到绝对路径、换算成工作空间相对路径直接回填（文件不进项目），Web 端只拿得到字节，先经 `POST …/imports` 落到 `.armadra/imports/` 再按路径回填，这一步在文案里写明。远端工作空间即使在桌面端也走 Web 那条：`rootPath` 是**那台**主机上的路径，本机选择器选出来的文件在那边不存在。越界路径在选完的那一刻就拒，不发一个注定 400 的请求。

**受管清单的真实 sha256**：Chrome for Testing **不发布任何摘要**——`last-known-good-versions-with-downloads.json` 每个平台只有 `platform` 与 `url`，没有同名 `.sha256`（实测 404），响应头只有 GCS 自己的 `x-goog-hash`（crc32c + md5），与字节同源，证明不了同源之外的任何事（2026-09-07 对线上端点核对）。因此摘要只能**观测**：`tools/browser-manifest.mjs`（`pnpm browser:manifest`）在有网络的机器上下载一次、算 sha256、用 `unzip -Z1` 核对可执行文件路径确实在包里，再写进清单；本轮只提交 macos-arm64（`152.0.7977.82`，187 616 945 字节），其余平台留空并在清单的 `$comment` 里写明原因与补法。没有条目的平台改走 TOFU：`launch/managed.rs` 在首次安装成功后把观测到的摘要记进 `<data_dir>/browser-managed/pinned.json`，之后每次安装都按它校验；同一版本同一 URL 的字节变了是 `sha256_mismatch`，同一版本换了 URL 是 `pin_url_changed`（这里分不出哪个是真的，就不替人选）。失败的安装不落 pin。下载默认仍关（`ARMADRA_BROWSER_MANAGED_DOWNLOAD`）：180 MB 与「首次信任」都是该由人做的决定。

**WebP 帧流**：Chrome 的协议自述里 `Page.startScreencast` 的 `format` 只列 `jpeg` / `png`，但真实 Chrome 152 对 `format: "webp"` 返回的是货真价实的 VP8 WebP（`RIFF … WEBP`），实机验证过。于是订阅者用 `BrowserSubscribeRequest.accepted_encodings` 声明自己解得开什么，订阅回执 `BrowserSubscription.encoding` 如实回报这条流实际发的编码。一个页面只有一路 screencast、本模块不逐订阅者转码，所以**所有**在线订阅者都接受 WebP 时才用 WebP——一个老客户端拖累大家用 JPEG，好过给它一张画不出来的图。真按枚举办事的浏览器会拒绝，那一次拒绝被接住并回落 JPEG，此后本会话不再问。质量按编码各自的标尺换算（同一个数字在两种编码里是不同的画质），差值由 `ARMADRA_BROWSER_WEBP_QUALITY_SHIFT`（默认 10）配置。工作空间事件通道保持 JPEG：它的订阅者早于专用帧流，没有地方声明自己解得开什么。实测本地静态页 800×600 首帧：JPEG 3 609 字节，WebP 1 510 字节。

**上传回包**：新增 `BrowserUploadResponse`（`BrowserActionResult.upload = 22`）与 `browserUploadedSchema`，补上批次 2 记下的「`POST …/upload` 的响应没有对应消息」。

验证：`cargo test -p armadra-runtime --lib browser::` 63 项全绿（新增标签图标、WebP 协商、TOFU 首次信任与 `pin_url_changed`）、`--test browser_stream` 3 项通过；`cargo test -p armadra-runtime`、`cargo clippy --workspace --exclude armadra-desktop --all-targets -D warnings`、`cargo fmt --all --check`、`pnpm protocol:check`、`pnpm protocol:test`、`pnpm --filter @armadra/shared test`、`pnpm --filter @armadra/web test`（1985 项）与 `typecheck`、`pnpm check` 通过。Host 侧不需要改：新界面用的都是已有路由，`browserClass` 已经把它们分在正确的一档。

浏览器收尾未做：`pinned.json` 的 TOFU 路径只有单元测试覆盖（本机是已固定摘要的 macos-arm64，走不到 TOFU 那一支）；Windows / Linux 的清单条目仍空，要在那些平台上各跑一次 `pnpm browser:manifest`；`favicon` 只取 `link[rel~=icon]` 与 `/favicon.ico`，不解析 manifest 里的图标，也不挑尺寸；标签条没有拖拽排序（CDP 也没有对应命令）。§7 的「不做的事」不变。
实施状态 · 批次 4（已完成，本机 macOS + 伪 SSH）：`remote/service/{mod,git,files,assets,replay}.rs`、`remote/{upload,download,imports}.rs`、`worker/upload.rs` 落地仓库面板、文件管理、资产导入与 `WorkerUpload` 分块上传；`api/files.rs` 的 9 处与 `api/assets.rs` 的 1 处 `refuse_remote` 已删除，`git/api.rs::workspace` 的整块 501 换成逐 handler 的 `proxied`。伪 SSH 集成测试新增 `remote_panel`（分支/历史/stash 明细/worktree/仓库扫描、操作队列 start→succeeded→list→cancel、file-entries 新建/改名/移动/删除/列表/还原、file-info 与二进制下载、SIGKILL 后写操作重连）与 `remote_upload`（3 MiB 十二块上传后核对落盘 sha256、无残留临时文件、下载回读一致、资产 blob 与按路径导入去重到同一 id）。

三处与设计不同，都是设计表未覆盖的空缺：① 回收站**列表**是读、还原是写，两者重放规则相反，不能共用一个编号，因此占用了设计里留白的 `39` 作 `FILE_ENTRY_TRASH_LIST`（`reserved 49` 未动）；② `WorkerReadFileRequest` 追加 `bool raw = 6`（加字段不改任何既有编号，默认 false 时编码不变），否则 §3.1 说的「下载复用分块读」对二进制与图片资产不成立——`files::read_text_file` 会拒绝含零字节的文件，远端白板资产将只能写不能读；③ `import-local-files` 与 `assets/import` 都按路径导入，但设计只给后者定了「源文件已在执行主机」，前者没有编号，实现为控制端读取字节后经 `WorkerUpload` 上传，与 multipart 上传同路；差异记在此处而非悄悄对齐。另有 `POST …/assets` 与 `GET …/assets/{id}` 两条原本就会写/读控制端磁盘的路由一并接上远端（不在 11 处之列，属同一功能的正确性缺口）。

实施状态 · 批次 5（已完成，本机 macOS + 伪 SSH）：`remote/client/{mod,connection,supervisor,handshake}.rs` 拆分完成，读任务按 `request_id` 解复用、空 `request_id` 即主动帧、EOF 立即唤醒全部等待者；请求仍由同一把互斥锁串行，`UNKNOWN_OUTCOME` 与重放表未变，并对批次 4 新增的九个写操作补了断言。`remote/watch/{mod,poll,events}.rs` 与 `worker/watch.rs` 落地 notify 主动帧，`WatchRegistration` 增 `mode: events | poll`，无 `remote.watch.v1` 的旧 Worker 保持 2 秒轮询并在 `reason` 里说明；重连后重新订阅并做一次对账。`service_contract_version = 1` 与 `apps/runtime/tests/fixtures/service/*.json`（44 份）落地，`remote_contract` 快照变化而常量未升即失败；逐操作 capability（`remote.git.panel.v1` / `remote.files.manage.v1` / `remote.upload.v1` / `remote.watch.v1`）在客户端发送前拦截并点名。`terminal/ssh/{mod,argv,known_hosts,askpass,prompts}.rs` 落地 `ssh-keyscan` → 用户确认 → `<data_dir>/ssh/known_hosts`(0600) 与全部 argv 的 `StrictHostKeyChecking=yes`，`FORBIDDEN_OPTIONS` 增三项禁止覆盖；Worker argv 从 `BatchMode=yes` 改为 askpass 助手（`armadra-runtime ssh-askpass`，经 data_dir 里 0700 的 wrapper 与一次性 token），探测仍是 batch。`remote/switch.rs` 与 `PATCH …/execution-host` 落地重绑定核验：`root_mismatch` 带双方指纹、`switch_blocked` 列出阻塞项、迁移文件 `UNSUPPORTED`。

批次 5 未做：`remote_ssh` 的伪 `ssh` 端到端（打印 `password:` 并调用 `SSH_ASKPASS`）没有写——伪 SSH 运行器是一个丢弃选项的 shell 脚本，它不实现 OpenSSH 的 askpass 协议，要写这条测试得先实现一个假的 `ssh`，那测的是这个假程序而不是 Armadra；`known_hosts`、`prompts`、`askpass` 三个模块的规则改由单元测试覆盖（指纹归属校验、一问一答一次读取、提示文本脱敏、三个环境变量缺一即拒、全部 argv 带 `StrictHostKeyChecking=yes`）。`ssh-keyscan`/`ssh-keygen` 的真实调用路径同理只有 argv 与解析被测，没有连过真实主机。切换的阻塞项目前覆盖编辑器草稿、活动终端与本进程持有的 Git 操作；浏览器 session 与自动化计划未纳入（本轮浏览器 session 只跑在控制端，自动化计划没有指向执行主机的登记）。

批次 4 + 5 合并进主线（本机 macOS）：两批与主线上的语言服务 C/D、B1 设置域、B2 文件系统域、浏览器 1/2/3 改了同一批文件，合并按语义而非按行做。协议侧没有撞号——远端新增的 request 16/17 与 response 17/18/19 都落在主线未占用的编号上，`WorkerServiceOperation` 19–48、`service_contract_version` 与 `WorkerReadFileRequest.raw = 6` 原样保留，生成产物由 `pnpm protocol:generate` 重出。`worker/mod.rs` 同时保留语言链路（`language_link::CAPABILITY_V1` 无条件、`CAPABILITY` 随链路）、设置域（帧 25，随 `--settings-file`）、文件系统域（帧 26）与远端的仓库面板 / 文件管理 / 上传 / watch capability，dispatch 里五种语言动作是真实实现而不是远端分支留的 UNSUPPORTED 桩。`worker/transport.rs` 拆分后的 `serve` 与 `serve_commands` 都重新带上 `settings_file`，否则 `--settings-file` 会在拆分中被静默丢掉。

合并时的三处取舍：① `terminal/ssh/argv.rs` 里重新长出 `language_link_argv`，但用的是远端分支的新选项（askpass 助手 + `known_hosts`）而不是主线原来的 `BatchMode=yes`——语言链路和 Worker 连接是同一种连接（无 TTY、stdio 上跑帧），密码主机不该「能起 Worker、起不了语言服务」；`remote/language.rs` 的 spawn 相应补上 `askpass::child_environment`，主线原来没有这一步是因为那时这条线还是 batch 模式。② `RemoteWorker` 只保留主线的 `display_name()` / `controller_id()`，删掉远端分支同义的 `host_name()`（无调用方）。③ Host 侧 `worker/wire.go` 的 result oneof 合法号集合不加 17/18/19：Go Host 走的是 `serve_commands`，那条路不开 watch、也不发主动帧，把这些号加进白名单等于让 Host 接收它读不懂的帧。

只能交叉编译、实机待办：Windows Job Object 与 `lockfile` 处理、Windows Authenticode 校验、Windows/Linux 标准安装路径、Linux 沙箱（不默认加 `--no-sandbox`，容器 CI 用 `ARMADRA_BROWSER_ARGS` 显式给）、Windows 的 `GetProcessTimes` 进程身份。每批的实施记录只登记本机 Chrome、本地静态页与伪 SSH 的结果。

## 6. 验收清单

| #   | 场景                                                                                                                                                                                        | 证据                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | 无 Chrome 的机器：不可用面板显示查过的路径与「安装受管浏览器（N MB）」；点安装后进度与版本可见                                                                                              | 批次 1 集成测试 + 设置页手动 |
| 2   | Runtime `kill -9` 后重启：页面与登录仍在，节点 `generation + 1`，无 `launch_failed`                                                                                                         | 批次 1                       |
| 3   | 重定向到元数据地址或保留端口被拦，地址栏与 console 说明原因                                                                                                                                 | 批次 1                       |
| 4   | 页面 `window.open`：标签条出现新标签，Agent `tabs --list` 看到它并能 `tabs --switch`                                                                                                        | 批次 2                       |
| 5   | 跨源 iframe 内元素可 `read` 与 `click`，导航后引用 `STALE_TARGET`                                                                                                                           | 批次 2                       |
| 6   | `alert` 弹出时 Agent 输入得到 `DIALOG_PENDING` 并能 `dialog --accept`                                                                                                                       | 批次 2                       |
| 7   | Agent `upload --path` 回填项目文件；工作空间外路径拒绝                                                                                                                                      | 批次 2                       |
| 8   | 人正在输入时 Agent 动作排队 ≤ 5 秒；人点接管后 Agent 得到 `LEASE_REVOKED`，徽标显示控制者                                                                                                   | 批次 3                       |
| 9   | 手机经 Host 配对后在焦点页看到同一 session 的画面，点击后新帧到达，可接管                                                                                                                   | 批次 3 `pnpm browser:e2e`    |
| 10  | 帧流按 `bandwidth_class` 降级，订阅回执如实报告实际预算                                                                                                                                     | 批次 3                       |
| 11  | 远端工作空间的 Branches / History / Worktrees / Stash 与操作队列可用，文件树可新建/改名/删除/还原                                                                                           | 批次 4                       |
| 12  | 远端上传 3 MiB 文件与白板资产，sha256 一致；Worker 中途被杀报 `UNKNOWN_OUTCOME`                                                                                                             | 批次 4                       |
| 13  | 远端文件外部修改 500 ms 内到达编辑器；旧 Worker 回退 2 秒轮询并在徽标说明                                                                                                                   | 批次 5                       |
| 14  | 补丁版本不同的 Worker 可连接并显示版本徽标；契约版本不同则 `UNSUPPORTED`                                                                                                                    | 批次 5                       |
| 15  | 新 SSH 主机首次连接必须确认指纹；指纹变化不自动接受；密码提示经界面应答且不落盘                                                                                                             | 批次 5                       |
| 16  | 执行主机切换：核验通过写入并广播；阻塞项与路径不一致均 409 且列出原因                                                                                                                       | 批次 5                       |
| 17  | `pnpm protocol:check`、`protocol:test`、`cargo test -p armadra-runtime`、`go -C apps/host test ./...`、`pnpm --filter @armadra/web test`/`typecheck` 全绿；Windows/Linux `cargo check` 通过 | 每批                         |

## 7. 不做的事

| 项                                | 原因                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| 浏览器 session 运行在远端执行主机 | 需要 §3.4 的事件通道承载帧流与输入；本轮先落通道，远端工作空间上的浏览器节点继续 501 并写明功能名 |
| 视频通道（WebRTC / H.264）        | 设计 §8 保留为后续替换帧载荷；本轮只做逐帧图片（JPEG，能协商时 WebP）+ 背压                       |
| Cookie / 凭据导出给 Agent         | 设计 §7 要求另设能力与审计                                                                        |
| 扩展、DRM、音视频、同步账号       | 设计 §5 明确不在验收目标                                                                          |
| 通用 `eval` 与裸 CDP              | 不变的边界                                                                                        |
| DNS rebinding 的强保证            | 检查时解析 ≠ Chrome 解析；只做请求时复检并如实记录                                                |
| 受管浏览器自动更新                | 版本随构建清单固定；升级 = 新构建 + 用户再点一次安装                                              |
| 自动信任 host key、保存 SSH 密码  | 不变的边界                                                                                        |
| 在主机之间搬文件                  | 切换只重绑定；文件由 Git 搬                                                                       |
| Host 持有 SSH 连接                | 随 H01 业务表面迁移一起做；本轮保证载荷对 Host 是不透明字节即可                                   |
| 多人租约（`WriterLease`）         | H04 预留；本轮租约是单 session 单持有者                                                           |
| Windows / Linux / 手机实机验收    | 本机只能交叉编译与浏览器视口模拟，状态保持「待实机」                                              |

## 8. 风险

| 风险                                                                                                  | 影响                                           | 缓解                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| CDP 多目标语义（`--headless=new` 下的自动附着、OOPIF、popup 时序）不稳定，元素引用与坐标跨 frame 出错 | 批次 2 的 Agent 动词在真实页面上失灵或点错位置 | 受管二进制固定版本；两个端口的跨源静态页做真实 Chrome 测试；引用带 tab/frame/epoch 三层，宁可 `STALE_TARGET` 也不猜                 |
| 帧流经 Host 代理到手机的延迟与带宽：JPEG + WebSocket + Go 代理，p95 ≤ 350 ms 可能达不到               | 手机观看/接管体验差，验收目标不达              | 每订阅者独立背压与降级；批次 3 实测两条路径的 p95 并写入实施记录；不达标保持 🔶 而不是标完成                                        |
| `remote/client` 从「一问一答」改为读任务解复用，触及 H02 的 `UNKNOWN_OUTCOME` 与重放保证              | 远端写操作被重复执行或结果被误判，属于数据风险 | 请求仍互斥串行，只新增主动帧；保留并扩展伪 SSH 的 `kill -9` 测试；先在旧 Worker（无 `remote.watch.v1`）上跑一遍轮询回退再切事件通道 |
| `SSH_ASKPASS` 在各平台 OpenSSH 版本上的行为差异（`SSH_ASKPASS_REQUIRE` 需 ≥ 8.4）                     | 密码提示不出现或卡住                           | 旧版走 `DISPLAY` 兜底；120 秒助手超时保证 `ssh` 干净失败；设置页显示检测到的 OpenSSH 版本                                           |
