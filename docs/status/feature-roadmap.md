# Armadra 功能预期总表

> 状态：2026-09-05 依据源码、[实施记录](./platform-implementation-status.md)与本轮新增需求整理的完整功能预期。
> 本文回答「产品最终要有什么」；实现进度以实施记录为准，架构现状以 [架构](../guides/architecture.md) 为准。
> 各条目标注：✅ 已交付 · 🔶 部分交付 · ⬜ 未开始。「可实现」指依赖与方案已具备，只差实施。

## 1. 产品定位

Armadra 是 local-first 的 AI Coding 画布：把真实 CLI Agent（Claude Code、Codex、Gemini CLI、OpenCode、Pi、OMP、GitHub Copilot）作为终端节点放在 tldraw 白板上，节点连线即共享上下文；周边提供编辑器、多仓库 Git、文件、浏览器、后台自动化、额度与资源监控。所有数据留在本机，服务集成在应用内部，关闭窗口不停止后台。

## 2. 技术框架

| 层          | 目录                                                              | 技术                                                                                 | 说明                                                  |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 前端        | `apps/web`                                                        | React 19、Vite、TypeScript、tldraw 5、xterm.js、CodeMirror 6、shadcn/ui、Tailwind v4 | 唯一页面，桌面与浏览器共用                            |
| 桌面壳      | `apps/desktop`                                                    | Tauri 2（tray、dialog、notification、opener）                                        | 窗口、托盘、sidecar 生命周期；不写业务                |
| 中转服务    | `apps/host`                                                       | Go 1.24、SQLite、cron、Protobuf                                                      | 身份、设备、调度、事件、业务状态；目标是唯一业务权威  |
| 执行层      | `apps/runtime`（目标：归为 Worker）                               | Rust、Axum、Tokio、SQLx、portable-pty、notify                                        | 终端、文件、Git、Hook、进程测量；当前仍持有业务数据库 |
| 协议        | `proto/`、`crates/protocol`、`packages/protocol`、`apps/host/gen` | Protobuf 3，三端生成                                                                 | 唯一跨进程契约，生成文件不手改                        |
| 共享模型    | `packages/shared`                                                 | zod                                                                                  | 节点/边/工作空间、CLI 注册表、Git/交接 schema         |
| Hook 客户端 | `crates/hook`                                                     | Rust，最小依赖                                                                       | CLI hook 回调、`canvas post/inbox/ack`、上下文读取    |

## 3. 功能总表

### 3.1 画布

| 功能                                                                               | 状态 |
| ---------------------------------------------------------------------------------- | ---- |
| 7 种节点：terminal（含 Agent）、sticky、group(frame)、editor、diff、files、browser | ✅   |
| 上下文链接 `link`，派生边（子代理 rope）不入库                                     | ✅   |
| tldraw 原生手绘、几何、文字、图片、高亮，与节点共用相机与撤销栈                    | ✅   |
| 图片内容寻址资产、CAS 保存、8 MiB 快照上限、自动保存队列                           | ✅   |
| 缩略图、用量球、命令面板、快捷键录制与冲突检测                                     | ✅   |
| 文件拖入终端插入路径 / 拖到画布开预览                                              | ✅   |
| 窄屏（<768px）抽屉布局                                                             | ✅   |
| Kanban 退役为只读归档；节点备注保留                                                | ✅   |
| 迁移到 Host 后 ID、位置、资源、嵌套 Frame 一致性验收（C02）                        | ✅   |
| 多设备画布编辑租约与 revision CAS（H04 前置）                                      | ⬜   |

### 3.2 Agent 终端与协作

| 功能                                                                                                                    | 状态 |
| ----------------------------------------------------------------------------------------------------------------------- | ---- |
| 7 种 CLI 启动、resume、权限模式、模型选择；保留各 CLI 账户与配置                                                        | ✅   |
| Hook 安装（Claude/Codex/Gemini/OpenCode）→ 归一化 → `working/waiting/blocked/done`                                      | ✅   |
| 权限请求在节点头部直答                                                                                                  | ✅   |
| `armadra.mailbox.v1`：`post/inbox/ack` 拉取消息箱；`send/reply/notify` 主动投递                                         | ✅   |
| 按连线读取转录 / 摘要 / 终端画面                                                                                        | ✅   |
| 对话交接：prepare → 预览 → accept/cancel → 后台投递，状态可追溯（A04）                                                  | ✅   |
| Claude 单会话上下文占用 Badge；`disabledCapabilities` 能力继承（A03）                                                   | 🔶   |
| 其他 Provider 上下文来源、tokenizer 估算器、80%/95% 阈值设置（A03）                                                     | ⬜   |
| 交接历史面板（按工作空间、含投递尝试次数）、真实 Agent 端 `handoff-read` 端到端（A04）；跨执行主机仍只在 prepare 处拒绝 | 🔶   |
| 自动命名：占位标题才应用、人工改名锁定、可预览（A05）                                                                   | ⬜   |
| 原生 Loop/Cron 观察卡片 AgentActivityNode（A01）                                                                        | ✅   |
| 子代理卡片                                                                                                              | ✅   |
| 会话索引（Claude/Codex/Gemini 历史会话检索）                                                                            | ✅   |
| 多账号与节点账号绑定 `credentialRef`/`AccountRef`（S02，预留）                                                          | ⬜   |

### 3.3 终端与主机生命周期

| 功能                                                                         | 状态 |
| ---------------------------------------------------------------------------- | ---- |
| tmux（跨 Runtime 重启存活）、直连 PTY、SSH 三种后端                          | ✅   |
| PATH 补齐、捕获 / 粘贴 / 回收 / 终止、IME、滚动回放                          | ✅   |
| Command W 隐藏到托盘；Command Q 停止 Host/Runtime/受管会话                   | ✅   |
| Windows ConPTY 独立 Session Host 持久会话（T01）                             | 🔶   |
| 后台渲染预算：focused / visible / offscreen / detached / disconnected（T03） | ✅   |
| 会话休眠与恢复，不重复启动（T03）                                            | ✅   |
| Agent 工作时防休眠租约，完成后释放（T02）                                    | ⬜   |

T01 是 🔶：`crates/session-host` 与 Worker 侧后端已交付并通过交叉编译，但**没有在任何 Windows 真机上运行过**，无头 VT 屏幕仍待选型。范围与限制见[终端与主机生命周期设计 §3.1](../design/terminal-host-design.md)。

### 3.4 Git（含多仓库）

| 功能                                                                                   | 状态 |
| -------------------------------------------------------------------------------------- | ---- |
| 状态、diff、文件 / hunk 级 stage、unstage、revert、提交、克隆、冲突中心                | ✅   |
| 分支增删切换、fetch/pull/push、操作队列、历史分页与父关系图、stash、merge、cherry-pick | ✅   |
| owned rebase（continue/abort）、Sync 三步 CAS、`--force-with-lease` 二次确认           | ✅   |
| worktree 列表、创建（预期 OID）、安全移除                                              | ✅   |
| AI 提交信息草稿（隔离预览、不自动提交）                                                | ✅   |
| **多仓库识别与切换**（本轮新增，详见 §4.1）                                            | ✅   |
| **提交图视图**：分支彩线、tag/分支徽标、作者、IDEA 式筛选与详情（本轮新增，详见 §4.1） | ✅   |
| `git init`、amend、还原来源区分、并排 diff、显式标记已解决（G01）                      | ⬜   |
| 交互式 rebase、rebase skip、reset/revert/tag/remote、reflog、历史行操作（G02）         | ⬜   |
| worktree 与 Frame 绑定、路径继承、解绑/删除区分、初始化脚本（G03）                     | ✅   |
| 提交信息语言 / 规范选项（A05）                                                         | ⬜   |

### 3.5 编辑器与文件

| 功能                                                               | 状态 |
| ------------------------------------------------------------------ | ---- |
| CodeMirror 语法高亮、SHA 内容版本保存、并发草稿保护                | ✅   |
| 目录级外部变更监听 `file.changed`；比较 / 重载 / 保留草稿          | ✅   |
| 文件树、新建目录、文件下载、图片导入                               | ✅   |
| 三方合并、项目搜索（Worker 侧、glob、分页、取消）、快速打开（E01） | ⬜   |
| 语言服务：补全、诊断、hover、定义、引用、重命名、格式化（E01）     | ⬜   |
| Markdown 编辑 / 预览 / 分屏；媒体预览（E01）                       | ⬜   |
| 文件管理：重命名、移动、删除、复制路径（E01）                      | ⬜   |
| 远程写入与草稿恢复（E01/H02）                                      | ⬜   |
| Windows / Linux 文件监听后端实机验证                               | ⬜   |

### 3.6 浏览器节点

| 功能                                                                           | 状态 |
| ------------------------------------------------------------------------------ | ---- |
| iframe 兼容预览                                                                | ✅   |
| Rust Browser Worker + CDP，持久 BrowserSession，人与 Agent 共用同一会话（B01） | ✅   |
| 导航、响应式尺寸、截图、Console/Network 摘要、下载队列、登录持久化（B01）      | ✅   |
| Agent 接口：Navigate/Read/Click/Type/Wait/Capture（B01）                       | ✅   |
| 画面流跨桌面 / 浏览器 / 手机查看（B01/H03）                                    | 🔶   |

### 3.7 后台自动化

| 功能                                                                                   | 状态 |
| -------------------------------------------------------------------------------------- | ---- |
| Go 持久调度内核：Cron / Interval / Once / LoopAfterCompletion，misfire、并发、重试策略 | ✅   |
| Rust 非交互命令 Worker；零客户端到点执行；Worker 被杀后按 generation 重建              | ✅   |
| HTTPS Define / Activate / Pause / RunNow / List（automation scope）                    | ✅   |
| 画布 AutomationNode、自动化面板、运行历史、计划级「需处理」状态（A01/A02）             | ✅   |
| 目标为 Agent 终端时的投递门（idle-success、TTL）与冻结 LaunchSpec 冷启动（A02）        | ✅   |
| 原生任务「转为平台计划」的确认流程（A01）：预填向导 → 人确认 → 草稿，不自动激活        | ✅   |

### 3.8 GitHub

| 功能                                                                                       | 状态 |
| ------------------------------------------------------------------------------------------ | ---- |
| Issues 列表、详情、按状态分组、`Move to…`、重开 / 关闭、状态映射远端回写（G04）            | ✅   |
| PR 列表、创建、查看差异 / 评审 / 检查、评审、预期 SHA 合并、本地检出到 worktree（G04）     | ✅   |
| `ExternalReference` 关联 Issue/PR 与会话、分支、worktree                                   | ✅   |
| GitHub API 凭据：`gh` 登录 / 粘贴 token（钥匙串，其他平台 0600 降级）、Enterprise API base | ✅   |
| Projects v2 状态字段映射：单页最多 500 条目，超出部分显示未映射                            | 🔶   |
| GitHub 发布与应用更新（S03）：读 Releases 判断新版本与签名存在性；不下载、不安装           | 🔶   |

### 3.9 额度、用量与成本看板（本轮新增，详见 §4.2）

| 功能                                                                                | 状态 |
| ----------------------------------------------------------------------------------- | ---- |
| Claude / Codex / Gemini 额度窗口（5h、7d、模型专属）与重置时间，用量球展示          | ✅   |
| **Copilot 额度**：premium interactions / chat 百分比                                | ✅   |
| **Codex 额度**校对 OAuth 来源、credits 余额；CLI RPC 回退                           | ✅   |
| **本地成本统计**：Claude / Codex 本地日志按日聚合 token 与费用，今日 / 30 天 / 会话 | ✅   |
| **独立用量看板**：多 Provider 总览、日柱状图、模型分解、刷新节奏、隐私边界          | ✅   |
| **桌面托盘迷你条**：会话 / 周窗口两条进度，读 `/api/usage/mini`，null 显示未知      | ✅   |
| Provider 状态页 / 事故徽标（可选）                                                  | ⬜   |

### 3.10 资源监控（本轮新增，详见 §4.3）

| 功能                                                                          | 状态 |
| ----------------------------------------------------------------------------- | ---- |
| **CLI Agent 内存监控**：按会话进程树采集 RSS / CPU，节点徽标与资源面板        | ✅   |
| Host 总览：内存、swap、CPU、uptime（T02）；内存压力未实现                     | 🔶   |
| 平台自身组件占用：Runtime / Go Host / 命令 Worker；Session Host、Browser 未有 | 🔶   |
| 孤立会话认领 / 查看 / 终止；进程树展开、排序、高占用高亮与每会话一次提醒      | ✅   |
| 多执行主机筛选与远端一轮读取（SSH 会话仍标 remote、指标 unknown）             | ⬜   |

### 3.11 Host、远程与移动

| 功能                                                                                                                                | 状态 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Protobuf 握手、本机控制、单实例、后台启停、私有 `host.db`、迁移导出 / staging 导入                                                  | ✅   |
| HTTPS 设备配对、`__Host-` 会话、CSRF 轮转、设备管理 UI                                                                              | ✅   |
| SSH 主机配置与连接测试                                                                                                              | ✅   |
| 业务 Protobuf 表面：canvas 已交付并可按 ownership epoch 切换写入方；session / agent / filesystem / git 未开始（H01）                | 🔶   |
| 事件 outbox、durable sequence、快照恢复（H01）                                                                                      | ✅   |
| 远端 Rust Worker、`WorkspacePath{executionHostId}` 统一执行位置（H02）：文件 / 搜索 / 基础 Git 已远端执行，仓库面板与文件管理仍 501 | 🔶   |
| 认证后可用的业务 API、静态前端托管、对外服务开关（H02）                                                                             | 🔶   |
| 手机焦点页、底部导航、软键盘工具条、断线重连不重复输入（H03）                                                                       | 🔶   |
| Presence / Mutation / 租约契约与 UNSUPPORTED 响应（H04，预留）                                                                      | ✅   |

### 3.12 桌面壳、服务集成与项目结构（本轮新增，详见 §4.4、§4.5）

| 功能                                                                                                                                           | 状态 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Runtime / Host sidecar 构建与跨平台暂存                                                                                                        | ✅   |
| **服务内嵌：默认不占用固定系统端口**，Unix socket / 命名管道优先                                                                               | 🔶   |
| **项目结构整理**：Desktop / Web / Go 中转服务 / Rust Worker 边界清晰                                                                           | ⬜   |
| 自动更新契约、签名与兼容检查（S03）：Host 检查与桌面壳「未配置」状态已实现，下载与安装仍预留                                                   | 🔶   |
| 服务器模式：`install` 生成 launchd / systemd / sc.exe 定义（不注册不启动）、`status` 报告定义与漂移、`logs` 尾读、`upgrade` 校验协议后原地替换 | ✅   |

Runtime 的 `--listen unix:/pipe:/tcp:`、`endpoints.json` 发布、Host 的 `--listen none`、
桌面 `armadra://` 转发与 CSP 收紧已实现（启动与变量见[开发指南](../guides/development.md)）。

H02 已实现 `--serve-web` 静态托管、认证设备的 `/api` 与 WebSocket 反向代理（按设备授权、
按工作空间与读 / 写 / 执行收窄）、以及「对外服务」开关；仍缺业务 Protobuf 表面与远端
Worker。H03 已实现手机底部导航、单节点焦点页、软键盘工具条与带序号确认的终端输入；
仍缺原生打包与后台推送。
仍缺：WebSocket 只能经壳的回环随机端口转发（自定义协议不支持 ws），Windows 命名管道未在实机验证。

### 3.13 设置与数据

| 功能                                                                     | 状态 |
| ------------------------------------------------------------------------ | ---- |
| 通用、工作空间、Agent、Hook、终端、SSH、白板、通知、快捷键、数据、关于页 | ✅   |
| SQLite 一致性备份；未知 / 损坏库拒绝启动不重建                           | ✅   |
| 主题、语言（中英同步）                                                   | ✅   |
| 快捷键按平台 / 设备覆盖、继承与重置（S01）                               | ⬜   |
| 用量看板与资源监控的刷新节奏、阈值设置                                   | ⬜   |

## 4. 本轮新增需求设计

### 4.1 多仓库 Git 与提交图

**目标**：一个工作空间目录下可能存在多个 Git 仓库（根目录本身、子目录、更深层目录、submodule、worktree）。Git 面板必须全部识别并允许切换，而不是只认工作空间根。

发现规则：

- Runtime 从工作空间根递归扫描，深度上限可配置（默认 4），跳过 `node_modules`、`target`、`dist`、`.git` 内部与 `.armadra`；遵守 gitignore 不作为跳过依据，因为被忽略的目录也可能是独立仓库。
- 每个命中的 `.git` 目录或 `.git` 文件（worktree、submodule）解析为一个 `GitRepository { repositoryId, repositoryPath, kind: root | nested | submodule | worktree, parentRepositoryId?, headBranch, dirtyCount }`，`repositoryId` 由规范路径派生并与现有 `repositoryId/repositoryPath` 字段兼容。
- 结果缓存并订阅 `file.changed`；新增 / 删除 `.git` 时增量更新。远端 SSH 工作空间使用同一接口，由远端 Worker 执行扫描。
- API：`GET /api/workspaces/{id}/git/repositories`；所有既有 Git 请求继续带 `repositoryPath`，缺省为工作空间根。

界面：

- Git 面板顶部增加仓库切换器；左侧列表按仓库分组，显示图标、名称、当前分支、脏文件数（对应参考图左侧列表样式）。
- 「Changes」页可切换单仓库或「全部仓库」聚合视图；提交操作始终作用于明确选中的仓库，不做跨仓库一次提交。
- worktree 与 Frame 绑定（G03）复用同一发现结果。

提交图（History 页）：

- 参考图 1：单列主线 + 分支彩线，每行显示提交信息、作者、右侧 tag/分支徽标；合并提交用空心点，分支线在合并处回收。
- 参考 IntelliJ IDEA：多车道图、按分支 / 作者 / 日期 / 路径 / 文本筛选，选中行下方显示提交详情（哈希、父提交、作者、日期、文件列表与 diff），支持右键行操作：checkout、从此提交建分支、cherry-pick、revert、reset、复制哈希、比较到当前。
- 数据来自现有历史分页与父关系接口；车道布局在前端计算，一次加载不超过 500 行，滚动继续分页。

### 4.2 额度、用量与成本看板

参考 `CodexBar` 的 Provider 数据源与 `cost` 命令；所有解析在本机进行，凭据不落库、不进入 API 响应，沿用 `apps/runtime/src/usage/` 模块的三条规则。

额度检查：

| Provider | 数据源                                                                                                                                             | 窗口                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Claude   | 已有：钥匙串 / `~/.claude/.credentials.json` OAuth → `api.anthropic.com/api/oauth/usage`                                                           | 5h、7d、7d-sonnet / opus、extra usage  |
| Codex    | 已有：`~/.codex/auth.json` → `chatgpt.com/backend-api/wham/usage`；新增 CLI RPC 回退（`codex app-server` `account/rateLimits/read`）、credits 余额 | primary / secondary 窗口、credits      |
| Gemini   | 已有：OAuth 配额接口                                                                                                                               | 按返回                                 |
| Copilot  | 新增：GitHub device flow（`read:user`）→ `api.github.com/copilot_internal/user`；token 存 OS 钥匙串                                                | premium interactions、chat；无重置时间 |

本地成本统计：

- Claude：扫描 `~/.claude/projects/**/*.jsonl`，按 `message.usage` 汇总 input / output / cache read / cache creation；按 `requestId` 去重。
- Codex：扫描 `~/.codex/sessions/**/*.jsonl` 的 token 计数事件。
- 价格表内置并可更新；无法定价的模型只显示 token，不显示估算费用。
- 输出：今日、最近 30 天（滚动、含当天）、当前会话；`daily[]` 含日期、各类 token、费用、模型分解。
- 扫描增量化：记录文件大小与 mtime，只解析新增部分；最短刷新间隔 5 分钟，手动刷新走 30 秒冷却。
- Copilot 与其他 CLI 没有本地成本日志，看板只显示额度。

看板界面：

- 独立小看板：从用量球或 Dock 打开，也可作为独立窗口常驻；桌面托盘迷你条已实现：菜单顶部两行只读进度（会话 / 周窗口），经壳已有的 Runtime 通道读 `/api/usage/mini`，间隔跟随 `usage.refreshMinutes`（手动模式与缺省用 5 分钟下限，只读缓存不触发上游请求）；缺数据显示「未知」，不画空条。
- 每个 Provider 一张卡：会话与周窗口进度条、重置倒计时、pace（按时间推算的预期用量）、credits；下方 30 天日柱状图与模型分解。
- 采集时间、过期、错误状态明确显示；`unavailable / error / stale` 不显示为 0。
- 设置页：Provider 开关、刷新节奏（手动 / 1 / 2 / 5 / 15 分钟）、Copilot 登录 / 登出、成本统计开关。

### 4.3 CLI Agent 内存监控

**目标**：监控在 Armadra 内启动的每个 CLI Agent 会话的内存与 CPU，定位高占用会话。

采集：

- Runtime 已知每个 `sessionId + generation` 的 PTY 根进程；采样时枚举其进程树（macOS / Linux 用 `sysinfo` 或 `ps`，Windows 用 Job Object 统计），汇总 RSS、CPU、子进程数、启动时间。
- 默认 5 秒采样；节点 offscreen 降到 30 秒；断连或进程结束停止采样并标记状态。
- 同时采集 Host / Worker / Session Host 自身占用，与用户 CLI 分开。
- 数据模型对齐 [终端宿主设计 §8](../design/terminal-host-design.md)：`SessionMetrics { sessionId, generation, pid, rssBytes, cpuPercent, childCount, cwd, agentId, sampledAt }`、`HostMetrics`。
- 通过工作空间事件 WebSocket 推送；协议侧新增 `resources.proto`（Read / Subscribe）。

界面：

- 终端节点头部内存小徽标（如 `512 MB`），超过阈值（默认 2 GB，可设）变色并可通知。
- 右侧「资源」面板：Host 总览 + 会话表格（可按内存 / CPU 排序、跳回画布节点、终止）+ 孤立会话。
- 采集不到的字段显示 `unknown`，不显示 0；不采集终端内容或命令历史。

### 4.4 端口与服务集成

**现状**：Runtime 监听 `127.0.0.1:43120`，Go Host 监听 `127.0.0.1:43121`，开发时 Vite 占 `1420`。这三个都是固定 TCP 端口，与 VS Code 的做法不同：VS Code 主进程与扩展宿主之间使用 IPC，不监听固定端口。

**目标**：

- 桌面模式默认不监听 TCP：Runtime / Worker 与 Host 之间、Host 与桌面 WebView 之间使用 Unix socket（macOS / Linux）或命名管道（Windows），Tauri 通过自定义协议或本地转发把请求交给 socket。
- 只在「浏览器模式」或「对外服务开启」时监听 TCP；端口默认随机分配并写入 `<数据目录>/endpoints.json`（0600），前端与脚本从该文件读取，不再硬编码。
- 保留 `ARMADRA_RUNTIME_PORT` 等变量作为显式覆盖；端口被占用直接报错，不自动跳号后静默运行。
- Hook 客户端已优先走 Unix socket，保持不变。
- 验收：桌面启动后 `lsof -i` 看不到 Armadra 的监听端口；浏览器模式只暴露一个端口且 CORS / 身份校验不变。

### 4.5 项目结构整理

完整的目录规则、校验命令与调整顺序见[仓库结构与校验](../design/repository-structure.md)；本节只保留目标形状。

**目标结构**：

```text
apps/desktop     Tauri 壳（窗口、托盘、sidecar、更新）
apps/web         React / tldraw 前端
apps/host        Go 中转服务（身份、调度、事件、业务状态、GitHub、Worker 管理）
apps/worker      Rust 执行层（终端、文件、Git、Hook、进程测量；现 apps/runtime 演进）
crates/          protocol、armadra-hook 等共享 crate
packages/        shared、protocol、host-client
proto/           Protobuf 唯一来源
docs/            现行文档；history/ 与 research/ 只作追溯
```

整理事项：

- `apps/runtime` 随 H01 写入所有权切换后改名为 Worker，HTTP 业务路由逐步移入 Host；改名前不做无意义的目录移动。
- 清理 `output/`（Playwright 产物）、`assets/brand` 之外的临时资源；`target/`、`node_modules/` 保持忽略。
- `.gitignore` 此前因用户全局 `~/.gitignore_global` 忽略 `.gitignore` 而从未被跟踪；本轮已 `git add -f .gitignore` 纳入索引，下次提交生效。
- 代码注释、侧栏与菜单中残留的「看板」旧称已改为「画布」（C01 尾项，i18n 中英同步）。仍写作「看板」的两处是别的东西：用量看板是 dashboard，`legacyArchive.*` 说的是已退役的任务看板本身。SQLite 表名与已发布迁移未动。
- 顶层脚本统一到 `armadra.sh` 与 `tools/`，每个 app 的 README 只描述自身。

## 5. 优先级与阶段映射

| 顺序 | 内容                                                       | 对应阶段 / ID         |
| ---- | ---------------------------------------------------------- | --------------------- |
| 1    | 多仓库 Git 发现与切换器；提交图视图                        | M4 / G01–G03 新增     |
| 2    | 用量看板：Copilot 额度、Codex 校对、本地成本统计、独立看板 | §4.2 新增             |
| 3    | CLI Agent 内存监控与资源面板                               | M7 / T02 提前         |
| 4    | 自动化前端节点与面板；原生循环卡片；自动命名               | M3 / A01、A02、A05    |
| 5    | 服务内嵌与端口整改                                         | §4.4                  |
| 6    | Go Host 业务表面与写入所有权切换                           | M1–M2 / H01           |
| 7    | 编辑器搜索、语言服务、Markdown；Git 进阶操作               | M4 / E01、G02         |
| 8    | GitHub Issues / PR；受控浏览器                             | M5 / G04、B01         |
| 9    | 远端 Worker、手机焦点页；Windows 持久会话                  | M6–M7 / H02、H03、T01 |
| 10   | 多人、多账号、自动更新                                     | M8 / H04、S02、S03    |

项目结构整理（§4.5）单独标为**延后**，不占上表排序：待进行中的任务完成后按[仓库结构与校验](../design/repository-structure.md) §5 的顺序整体进行，期间不做零散目录移动。

## 6. 验收原则

- 每项功能按真实行为验收：真实仓库、真实 CLI 日志、真实进程采样；不以页面或接口数量代替。
- `unknown / unsupported / stale / denied / disconnected` 是有效状态，不显示为 0 或成功。
- 凭据、终端原始输出、文件正文不进入画布持久化、日志或 API 响应。
- 每个异步动作有 operationId 与可查询状态；前端按钮没有后端支撑不算交付。
- 中英文本地化同步；协议改动运行 `pnpm protocol:check` 与 `pnpm protocol:test`。
