# 画布工作平台实施记录

> 目标范围见 [设计总纲](./canvas-platform-design.md)。本文件只记录经过核验的进度，不以设计文档代替实现。
> 各批次的详细验证过程归档在 [实施批次记录](./history/platform-implementation-log.md)；本文件保留阶段状态、需求核对、提交登记、当前工作树与下一步。

## 接续基线

- 代码基线 `334a57e`，实施分支 `feature/host-protocol-foundation`；自基线起约 140 次提交。2026-09-05 晚至 09-06 凌晨由 worktree 隔离的 Opus 子 Agent 分三轮并行实施，主 Agent 审阅后 cherry-pick 线性合入，每次合入后在主树以私有 `CARGO_TARGET_DIR` 重跑全部回归。
- 2026-09-05 由四个只读审计子 Agent 按 Runtime、Go Host、Web/shared、协议/桌面/文档分工重新核对源码并实际运行验证命令；本文件的阶段与需求状态以该次核对为准。
- 用户于 2026-09-05 新增 [功能预期总表](./feature-roadmap.md)（多仓库 Git 与提交图、用量/成本看板、CLI 内存监控、端口/IPC 内嵌、结构整理延后）与 [仓库结构与校验](./repository-structure.md)，并跟踪了 `.gitignore`；本记录的需求核对以设计总纲 §3 加路线图 §4 为准。
- 共享 `CARGO_TARGET_DIR` 会被并发构建覆盖测试二进制（两个 Agent 实测「Fresh」却运行旧二进制），因此实施 Agent 与主树验证都改用私有目标目录；机器满载时 `git_message`/`git_repository` 关停类测试与 `armadra-hook` wire 测试偶发超时，单独重跑均通过。
- 主 Agent 协调子 Agent 分工、复核、暂存及提交；每项独立功能验证后单独提交并即时更新本记录。

## 阶段状态

| 阶段 | 状态     | 已完成 / 剩余                                                                                                                                                                                                                     |
| ---- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0   | 部分完成 | 三语言协议、真实 Host 握手、macOS CDP 探针完成；Windows ConPTY 仅离线编译检查，受控浏览器三平台与 Windows 重附着未完成                                                                                                            |
| M1   | 大部完成 | 身份、单实例、本机控制、HTTPS 设备认证、持久存储、迁移导出/导入核验、桌面生命周期、Kanban 退役已提交；业务写入所有权仍在 Rust Runtime                                                                                             |
| M2   | 大部完成 | 只读/命令 Worker、多 Provider 上下文（Claude 精确、Codex/Gemini 估算）、CLI 版本探测与能力求交集、模型选择、阈值设置已提交；Windows Host 最小可用未实机                                                                           |
| M3   | 大部完成 | Host 零客户端到点执行、自动化面板与计划/活动两类节点、交接 API/UI、自动命名已提交；Agent 会话目标投递、原生转平台计划、交接历史面板在第三轮实施中                                                                                 |
| M4   | 大部完成 | Git 全流程（init/amend/还原来源/标记已解决/并排 diff/历史行操作/reset/tag/remote/rebase todo/sync/lease push）、编辑器搜索/快速打开/项目搜索/文件管理/Markdown 预览/外部变更已提交；多仓库发现、提交图与 Frame 绑定在第三轮实施中 |
| M5   | 进行中   | GitHub 面板与受控浏览器在第三轮实施中；浏览器节点当前仍为 iframe 兼容预览                                                                                                                                                         |
| M6   | 进行中   | SSH 配置、设备配对、窄屏布局已有；Host 静态托管与认证代理、手机焦点页在第三轮实施中；远端 Worker 未开始                                                                                                                           |
| M7   | 大部完成 | 资源采集、防休眠租约、内存徽标与平台组件占用、快捷键三层覆盖、桌面 socket 模式已提交；渲染预算/休眠、Windows Session Host、更新契约在第三轮实施中                                                                                 |
| M8   | 预留交付 | account/presence Protobuf 与 Host UNSUPPORTED 响应、`capability_status` 能力位、节点账号字段（无绑定入口）已提交；多人与自动更新按设计只交付契约                                                                                  |

## 按需求核对的接续清单

三列分别为已提交并验证的能力、工作树中未提交的进展、尚未开始或未验收的部分。「已交付」只说明可复用的基础，不等于通过目标场景验收。

| ID  | 已交付（提交内）                                                                                                                                                                                                                                                                             | 进行中（工作树，未提交）                                                                                  | 待交付与验收                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| C01 | 可写 Kanban 从 Canvas/API/保存链路移除；SQLite v3 不可变归档与只读浏览/导出；节点备注保留                                                                                                                                                                                                    | —                                                                                                         | 代码注释与侧栏命名仍有「看板」旧称；`architecture.md` Runtime 职责已同步                                         |
| C02 | tldraw 自由图形、图片、Frame、上下文链接与原生内容引用；`ContextLink.content` 供 Agent 读取                                                                                                                                                                                                  | —                                                                                                         | 迁移到 Host 后的 ID、位置、资源、嵌套 Frame 一致性验收                                                           |
| A01 | `automation` 与 `agentActivity` 两类节点（数据类型分开）、右侧「自动化」页（计划列表、创建向导含 IANA 时区/五字段 cron 校验、激活确认显示绑定摘要、运行历史与收据、移除展示/停用并移除）、Host 未连接时明确不可用；计划级 needsAttention                                                     | 原生任务「转为平台计划」确认流程（第三轮）                                                                | 编辑已有计划、运行历史服务端分页、原生循环观察器数据源                                                           |
| A02 | Go 持久调度内核；Rust 非交互命令 Worker；Host `serve` 装配 Worker/dispatcher/Engine，命令定义/payload/授权持久化并按代次重建；HTTPS Define/Activate/Pause/RunNow/List；host-client 类型化调用与前端面板                                                                                      | Agent 会话目标投递门与冻结 LaunchSpec 冷启动（第三轮）                                                    | Windows 守护与 Job Object 实机验收                                                                               |
| A03 | Claude 状态栏精确用量；Codex/Gemini 结构化转录估算（source=structured_transcript, quality=estimated, 模型容量表）；阈值设置；CLI `--version` 探测缓存；能力=适配器∩配置∩探测∩执行主机并显示来源；模型选择菜单（新会话生效）                                                                  | —                                                                                                         | opencode/Pi/OMP/Copilot 无本地结构化转录故不声明 contextUsage；`nativeRecurrence` 无适配器声明；压缩后估算为上界 |
| A04 | 交接 bundle 持久化与冻结、串行终端投递门、`/handoffs` prepare/list/get/accept/cancel 路由、后台投递随 Runtime 启停、shared schema 导出、终端菜单「交接到…」与预览/确认对话框及状态 chip                                                                                                      | —                                                                                                         | 真实 Agent 端 `handoff-read` 端到端；交接历史面板；跨执行主机快照显式拒绝                                        |
| A05 | AI 提交信息草稿含语言与 Conventional Commits 选项；自动命名：仅占位标题应用、手动改名锁定（titleSource）、按 session/generation 缓存、设置开关                                                                                                                                               | —                                                                                                         | 普通终端（无 Agent 状态行）不自动命名；未用真实模型验证措辞                                                      |
| G01 | 状态、diff、文件与 hunk 级操作、提交、克隆、冲突中心、执行权限门、`git init`、amend（需确认）、从 index 还原与从 HEAD 覆盖分开、标记已解决（校验无冲突标记）、并排 diff 与忽略空白/搜索                                                                                                      | —                                                                                                         | —                                                                                                                |
| G02 | 分支、fetch/pull/push、队列、历史分页与父关系图、stash、merge、cherry-pick、owned rebase、Sync 三步 CAS、lease push、历史行操作（checkout/建分支/cherry-pick/revert/复制）、reset（hard 前自动 stash 快照）、tag 与 remote 面板、rebase todo 预览（reorder/pick/squash/drop）                | 提交图多车道与筛选（第三轮）                                                                              | rebase todo 的 reword/edit/exec/fixup、rebase skip、reflog                                                       |
| G03 | worktree 列表、创建（预期 OID）、安全移除、私有 exclude                                                                                                                                                                                                                                      | Frame 绑定、路径继承、解绑/删除区分、初始化脚本、repair（第三轮）                                         | —                                                                                                                |
| G04 | 无                                                                                                                                                                                                                                                                                           | Go Host GitHub 客户端、Issues/PR、状态映射回写、`ExternalReference`、前端面板（第三轮，mock GitHub 验证） | 真实远端回写只能由用户凭据验证                                                                                   |
| E01 | 内容版本保存、外部变更监听与比较/重载/保留、编辑器内搜索替换、快速打开、项目内容搜索（正则/glob/上限）、文件新建/重命名/移动/删除到回收站（可撤销，编辑器路径跟随）、Markdown 预览、EOL/BOM/编码状态栏（CRLF 与 BOM 保真）、语言服务能力探测显示未启用                                       | —                                                                                                         | 三方合并、LSP、搜索取消按钮、FilesNode 文件操作菜单、Windows/Linux 监听实机                                      |
| B01 | iframe 预览节点；独立 CDP 探针                                                                                                                                                                                                                                                               | Rust Browser Worker（CDP、持久 profile、帧流、输入、Agent 动词）（第三轮）                                | 跨端画面查看、Windows/Linux                                                                                      |
| H01 | Protobuf 握手/本机控制、Host 后台启停、单实例、桌面引导、私有 SQLite、导出/导入核验、命令与自动化 HTTPS 表面、`capability_status` 能力位                                                                                                                                                     | —                                                                                                         | 业务 Protobuf 表面（canvas/session/agent/filesystem/git）、写入所有权 epoch 切换、事件 outbox/快照恢复           |
| H02 | SSH 配置与连接测试；TLS、设备配对、`__Host-` 会话、CSRF、设备管理；Host `--listen none`/socket 与 endpoints.json                                                                                                                                                                             | Host 静态托管、认证后业务代理、对外服务开关（第三轮）                                                     | 远端 Rust Worker 与统一执行位置                                                                                  |
| H03 | 767px 断点、窄屏侧栏 Sheet、触屏命中尺寸                                                                                                                                                                                                                                                     | 手机焦点页、底部导航、软键盘工具条、Git 三级导航、断线重连不重复输入（第三轮）                            | 实机验收                                                                                                         |
| H04 | `presence.proto`（Presence/WriterLease/Mutation 信封）与 Host UNSUPPORTED 响应、`capability_status` 报告 unsupported                                                                                                                                                                         | —                                                                                                         | 多人协同实现按 M8 单独排期                                                                                       |
| T01 | Unix tmux 持久后端；Windows 命令 Job Object 隔离（交叉编译）                                                                                                                                                                                                                                 | `crates/session-host` Windows Session Host 与 Runtime 接线（第三轮，交叉编译）                            | Windows 实机                                                                                                     |
| T02 | `sysinfo` 采集 Host 总览与会话进程树（订阅按需、首样本 null）、孤立 tmux 会话认领/终止、防休眠租约（macOS caffeinate 断言实测出现/释放，Windows/Linux 交叉）、资源面板、终端节点内存徽标（阈值默认 2 GiB、每会话提醒一次、offscreen 30 秒采样）、平台组件占用与进程树展开、`resources.proto` | —                                                                                                         | 内存压力、多执行主机过滤、Session Host/Browser Worker 组件、Windows 组件发现实机                                 |
| T03 | 终端附着、恢复与渲染生命周期代码                                                                                                                                                                                                                                                             | 渲染状态机、统一预算、会话休眠与恢复、30 节点压力验收（第三轮）                                           | —                                                                                                                |
| S01 | 三层键位：内置按平台默认 → 全局覆盖 → 本设备覆盖；来源显示、逐层重置、平台预览、三层合并冲突检测、JSON 导入/导出、旧格式一次性迁移                                                                                                                                                           | —                                                                                                         | 配置档、when 条件、编辑器/浏览器 scope、OS 全局热键                                                              |
| S02 | `account.proto`（AccountRef/CredentialBinding，不含密钥）与 Host UNSUPPORTED；节点 `agent.account` 可选字段有界校验；launch 透传 accountId，Runtime 非 default 显式拒绝；无绑定入口                                                                                                          | —                                                                                                         | 账号创建/列表/切换实现按 M8                                                                                      |
| S03 | 桌面 `updater` 配置骨架                                                                                                                                                                                                                                                                      | `updates.proto`、Host CheckForUpdate、`tauri-plugin-updater` 接入与设置页（第三轮）                       | 自动安装、签名发布                                                                                               |

### 路线图 §4 新增需求

| 需求                     | 已交付                                                                                                                                                                                                                        | 待交付                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| §4.1 多仓库 Git 与提交图 | —                                                                                                                                                                                                                             | 仓库发现与切换器、聚合 Changes、多车道提交图与筛选（第三轮实施中）                                 |
| §4.2 用量与成本看板      | Copilot device flow 额度（钥匙串/0600 降级）、Codex RPC 回退与 credits、Claude/Codex 本地日志成本统计（requestId 去重、增量扫描、5 分钟节奏）、看板（Provider 卡、30 天柱状图、模型分解）、设置页、`/api/usage/mini` 托盘数据 | 托盘迷你条桌面接线、Codex 模型价格表、扫描缓存持久化、Provider 状态页                              |
| §4.3 CLI Agent 内存监控  | 见 T02                                                                                                                                                                                                                        | 内存压力、远程主机                                                                                 |
| §4.4 端口与服务集成      | Runtime `--listen tcp:/unix:/pipe:`、桌面默认 socket 且 `armadra://` 协议转发、TCP 随机端口写入 0600 `endpoints.json` 并占用即报错、Host `--listen none`、前端/脚本地址发现；实测桌面模式 `lsof` 无监听端口                   | WebSocket 仍需一个回环端口（自定义协议不能承载 ws），Windows 命名管道未编译，WebView 侧未 GUI 验收 |
| §4.5 项目结构整理        | `.gitignore` 跟踪、`.prettierignore` 排除第三方技能与 worktree                                                                                                                                                                | 按 repository-structure.md 顺序延后到功能任务完成后                                                |

## 本轮实施（2026-09-05 晚）

审计时的工作树先按语言拆为 5 个提交（格式修正、命令协议、命令 Worker、交接后端、文档），再由四个 worktree 隔离的 Opus 子 Agent 并行实施；每个 Agent 在自己的分支提交并给出验证数字，主 Agent 审阅 diff 后以 cherry-pick 线性合入，只在 `main.rs` 关停顺序处解决过一次冲突。

- **A04 交接接线**：Runtime 五条 `/handoffs` 路由与路由级测试（跨 workspace 拒绝、重复 accept 幂等、取消后不投递）；`start_background` 随 Runtime 启动、关停前 4 秒排空；shared 导出 schema 并对照 Runtime 类型测试；Web 终端菜单入口、预览对话框（目标、预算档、文件/Git 指纹、遗漏清单）、状态 chip。真实 Runtime 验证 prepare→get→stale digest 409→accept queued→cancel→目标退出 failed/targetEnded；实际粘贴需 Hook 报告 idle，裸 shell 正确停在 queued。
- **A02 Host 装配**：`automation.proto` 增补服务请求/响应与命令会话定义（字段号不变）；Host 迁移 3 持久化 `command_roots/command_sessions/automation_payloads/automation_grants`；`internal/automationhost` 负责 Worker 启动、定义重建、有界重启、PayloadResolver 与授权；`serve` 启动顺序与 `stop` 反序关停。真实 Host 端到端：配对→定义 `/bin/echo` 会话→Once 计划→约 12 秒后 SUCCEEDED→`kill -9` Worker→按 generation 重建且不重复 run→stop 无残留进程。
- **E01 外部变更**：`notify 8.2.0` 监听父目录，`file-watch` 注册/注销与 `file-version` 退化接口，写入前登记 sha 消除自保存竞态，120 ms 合并突发；编辑器未脏自动重载、已脏提示比较/重载/保留，删除后转 create-only。真实浏览器验证三种选择与 `rm` 分支。
- **G02 rebase/sync**：`StartRebase{onto,expectedStateToken}` 所有权绑定 `rebase-merge` 记录与 `orig-head` 文件身份；continue 可在下一提交再次停下，abort 校验恢复到记录的分支+OID；`Sync` 先对已观察远端 OID 做 CAS 再 fetch→ff pull→push，失败报告停在哪一步；push 保留 `--no-force`，lease 时追加 `--force-with-lease=ref:oid`，UI 需勾选确认。只用本地 bare remote。
- **格式与配置**：`cargo fmt` 修正 9 个历史文件；prettier 修正 61 个历史源码文件，`.prettierignore` 排除 `.claude/worktrees|skills|agents`。发现用户全局 `~/.gitignore_global` 忽略了 `.gitignore` 本身，仓库的 `.gitignore` 因此从未被跟踪（新 worktree 没有忽略规则）；未擅自改动，待用户决定。

## 第二轮实施（2026-09-05 深夜至 09-06 凌晨）

按路线图 §5 优先级并行推进，12 批全部合入；每批的详细验证在各自提交正文。

- **A03/A05**（`654c4b3b`…`21cd00bc`）：能力求交集、Codex/Gemini 估算器、CLI 版本探测、阈值设置、自动命名、模型选择、提交信息选项。真实 Runtime 用 fixture Codex 转录得到 estimated 3000 tokens。
- **T02**（`c9e7ef3b`…`9e712289`）：资源采集、孤立会话、防休眠租约与面板。实测 `yes` 会话 CPU 98.8%，`pmset -g assertions` 出现/消失 caffeinate 断言，SIGKILL Runtime 后断言随之消失。
- **E01 工作流**（`d910b686`…`bfefece1`）：索引/搜索/文件管理、搜索替换、Markdown 预览、状态栏、快速打开与项目搜索、LSP 未启用状态；修正 CRLF 被改写为 LF 与 BOM 丢失两个既有缺陷。真实浏览器验证快速打开、搜索跳转、重命名跟随。
- **A01/A02 前端**（`3ca7609a`…`086f1b72`）：needsAttention、host-client automation 调用、两类节点、自动化页。真实 Host+Worker+Runtime+Vite 端到端：向导创建 Once 计划→到点 SUCCEEDED→运行历史显示；顺手修正新建计划跳走的缺陷。
- **G01/G02 补齐**（`f4a0f7b3`…`bccce1d3`）：init、amend、还原来源、标记已解决、并排 diff、历史行操作、reset、tag/remote、rebase todo；25 个真实临时仓库测试。
- **§4.2 用量看板**（`0866909a`…`1fc103bc`）：本地 mock 验证 device flow；成本算术与去重核对；看板与设置实测。
- **§4.4 端口/IPC**（`1825cc70`…`df093188`）：socket 监听、endpoints.json、桌面协议转发、Host 无端口控制 IPC、地址发现；实测桌面模式零监听端口。
- **§4.3 内存监控**（`b8ff34d5`…`f774c563`）：`resources.proto`、平台组件采样、订阅节流、内存徽标与进程树；实测 300 MB 分配显示 308.3 MB。
- **S01/S02/H04**（`77fbad94`…`b116e068`）：三层键位、预留契约与 UNSUPPORTED；真实浏览器验证设备覆盖与重置。
- **合并修正**（`895fc70e`、`04edf08d`、`70d08e6f`、`12cc100e`）：合并引起的 fixture/签名/clippy 修正，均为测试或字面量补齐，不改行为。

## 本轮验证（2026-09-06 凌晨，第二轮全部合入后于主树重跑，私有目标目录）

| 范围                       | 命令                                                                                                                             | 结果                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Rust                       | `cargo test --no-fail-fast -p armadra-runtime -p armadra-hook -p armadra-desktop -p armadra-protocol`                            | 全部通过：runtime lib 581 项、集成 12 个套件、hook 41+12、desktop 29、protocol 17 |
| Rust 检查                  | `cargo clippy -p armadra-runtime -p armadra-desktop -p armadra-protocol --all-targets -- -D warnings`、`cargo fmt --all --check` | 通过                                                                              |
| 协议                       | `pnpm protocol:check`、`pnpm protocol:test`                                                                                      | 无漂移；Go 契约、Rust 17、TS 23 通过                                              |
| Go Host                    | `go -C apps/host test -race -count=1 ./...`、`vet`、Windows amd64 交叉构建                                                       | 全部通过                                                                          |
| Web / shared / host-client | `pnpm --filter @armadra/web test`、`typecheck`、shared、host-client、desktop 脚本                                                | Web 131 文件 1305 项，shared 121，host-client 125，desktop 脚本 6，类型检查通过   |
| 格式                       | `pnpm format:check`、`bash -n armadra.sh`                                                                                        | 通过                                                                              |

各批次的真实进程验证（临时 Runtime/Host/Vite、fixture、mock 服务）见「第二轮实施」；Windows/Linux 仅交叉编译；未使用用户真实凭据或远端。

## 独立提交与已验证功能

自 `334a57e` 起的功能提交按时间倒序登记；详细验证过程见[归档](./history/platform-implementation-log.md)对应小节。

| 提交                                                   | 功能                                                                                       | 验证要点                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `654c4b3b`…`21cd00bc`                                  | A03/A05：能力求交集、估算器、版本探测、阈值、自动命名、模型选择、提交信息选项              | Runtime 462+69、hook 53、shared 94、Web 1117                                             |
| `c9e7ef3b`…`9e712289`                                  | T02：资源采集、孤立会话、防休眠租约、资源面板                                              | Runtime 477+68、shared 93、Web 1121；pmset 断言实测                                      |
| `d910b686`…`bfefece1`                                  | E01：索引/搜索/文件管理、搜索替换、Markdown、状态栏、快速打开、LSP 状态                    | Runtime 469+69、shared 85、Web 1131；真实浏览器                                          |
| `3ca7609a`…`086f1b72`                                  | A01/A02 前端：needsAttention、host-client、两类节点、自动化页                              | Go 13 包、host-client 125、Web 1158；真实 Host 端到端                                    |
| `f4a0f7b3`…`bccce1d3`                                  | G01/G02 补齐：init/amend/还原/标记已解决/并排 diff/历史行操作/reset/tag/remote/rebase todo | Runtime 542、Web 1126                                                                    |
| `0866909a`…`1fc103bc`                                  | §4.2 用量与成本看板                                                                        | Runtime 570、shared 100、Web 1131；mock device flow                                      |
| `1825cc70`…`df093188`                                  | §4.4 socket 监听、endpoints.json、桌面协议转发、地址发现                                   | Rust 582、Go 14 包、Web 1123；lsof 零监听                                                |
| `b8ff34d5`…`f774c563`                                  | §4.3 resources.proto、组件采样、订阅节流、内存徽标                                         | Runtime 519+69、Web 1176、协议 Rust 15/TS 18                                             |
| `77fbad94`…`b116e068`                                  | S01 三层键位；S02/H04 预留契约与 UNSUPPORTED                                               | Rust 583、Go 13 包、Web 1194、TS 契约 22                                                 |
| `895fc70e` `04edf08d` `70d08e6f` `12cc100e` `d0cdb2a0` | 合并修正与忽略规则                                                                         | 主树回归见「本轮验证」                                                                   |
| `644d7638`                                             | 功能预期总表、仓库结构方案、跟踪 `.gitignore`（用户新增）                                  | 链接检查                                                                                 |
| `f4050e08`                                             | 历史源码 prettier 修正                                                                     | Web 1103、shared 81、TS 契约 17、typecheck                                               |
| `051baf0a`                                             | G02 rebase/sync 设计文档状态                                                               | 章节编号未动                                                                             |
| `eeacd67b`                                             | Web rebase/sync 与 leased force push 确认                                                  | Web 1081 项、6 项新增、typecheck                                                         |
| `9a1a7454`                                             | shared rebase/sync/lease 契约                                                              | shared 77 项                                                                             |
| `5ce3f482`                                             | Runtime owned rebase、Sync、lease push                                                     | Runtime 506 项；真实临时仓库 rebase/sync/lease 场景                                      |
| `fd12da8d`                                             | 编辑器外部变更设计文档状态                                                                 | —                                                                                        |
| `7148d083`                                             | 编辑器比较/重载/保留草稿                                                                   | Web 1090 项、15 项新增；真实浏览器三分支验证                                             |
| `8abc9b2e`                                             | Runtime 文件监听与版本退化接口                                                             | Runtime 508 项、9 项新增；路由级权限撤销 403                                             |
| `53d9cb96`                                             | Host 调度表面与 Worker 参数说明                                                            | README 同步                                                                              |
| `2f3e5265`                                             | Host serve 启动调度并随停止关停                                                            | 真实 Host 端到端、stop 无残留                                                            |
| `27ad71fb`                                             | automationhost 装配 Worker/dispatcher/Engine 与 HTTPS 路由                                 | Worker 被杀重启、state-dir 清空重建、root 删除 UNREBUILDABLE                             |
| `b4f0b20b`                                             | 自动化 RunNow 与按 workspace 列表                                                          | Go automation 测试                                                                       |
| `938220ca`                                             | Host 迁移 3：命令定义、payload、授权                                                       | 迁移 1/2 摘要守卫                                                                        |
| `98ffc461`                                             | automation 服务表面 Protobuf                                                               | Go/Rust 14/TS 17 契约样例、protocol:check                                                |
| `0cff3294`                                             | 交接流程文档                                                                               | —                                                                                        |
| `da332f92`                                             | Web 交接预览与确认                                                                         | Web 1082 项、7 项新增、i18n 守卫                                                         |
| `20642770`                                             | shared 导出交接 schema                                                                     | shared 78 项、4 项新增                                                                   |
| `2557da71`                                             | Runtime 交接路由与后台投递启停                                                             | Runtime 439+62 项；真实 Runtime prepare/accept/cancel/targetEnded                        |
| `1ac0fdc`                                              | 状态文档审计与历史归档                                                                     | 链接与 prettier 检查                                                                     |
| `65c050c`                                              | 交接 bundle 持久化与终端投递门                                                             | 迁移 0004、Hook 绑定、能力门；提交时尚无路由                                             |
| `c0bca23`                                              | 非交互命令 Worker（Rust+Go）                                                               | 独立 worktree 编译验证；真实 Worker 7 项                                                 |
| `bddd534`                                              | 命令执行 Protobuf 契约                                                                     | Go/Rust 13/TS 16 契约与 3 个 fixture                                                     |
| `e22490c`                                              | 历史格式修正                                                                               | `cargo fmt`、prettier                                                                    |
| `427d0f2`                                              | Git 执行权限与可操作提示                                                                   | 6 项配置脚本/远程 helper 回归、6 项 Git API、54 项客户端定向、Web 全套 1075              |
| `3222891`                                              | 编辑器内容版本传输与 create-only 测试                                                      | 真实 API 读取→外改→拒绝覆盖→重读保存                                                     |
| `1f3fc4f`                                              | 编辑器内容版本与保存竞态                                                                   | Rust 文件 10 项、CodeMirror 竞态 4 项、shared 74                                         |
| `2adf463`                                              | 单会话上下文与能力继承                                                                     | Hook 101、context 7、Agent 7、真实 PTY 代次绑定、Chrome 8%→Unknown 与重连清旧值          |
| `af81266`                                              | Cherry-pick 与空结果 Skip                                                                  | Rust 43 项、组件 28 项、真实 API 预览→应用→空结果→跨 workspace 拒绝→Skip                 |
| `abc918f`                                              | 持久自动化内核                                                                             | 26 组临时 DB/可控时间测试、race/vet、跨语言未知 enum 样例；仅内核，未接生产              |
| `f23cdda`                                              | Go→Rust 只读 Worker 桥接                                                                   | Rust Worker 5 项、文件 7 项、Go 11 组子进程场景、60 万字节分块与 SHA                     |
| `62f1cac`                                              | 退役任务看板，保留不可变归档                                                               | 归档只读、写字段 400 拒绝、导出含 `kanbanSha256`                                         |
| `8c07b17`                                              | 合并与冲突恢复                                                                             | owned merge、冲突继续/中止、状态 token 校验                                              |
| `7337410`                                              | 设备管理客户端与设置界面                                                                   | 设备分页、撤销 CAS、会话续期 UI                                                          |
| `6efdd61`                                              | Git 写入后的面板刷新                                                                       | hunk 视图与 AI 来源刷新                                                                  |
| `5c888ce`                                              | HTTPS 设备配对与会话接口                                                                   | 真实 HTTPS 子进程链路、`__Host-` Cookie、CSRF 轮转                                       |
| `6528edd`                                              | Stash 工作流                                                                               | 固定快照、冲突安全恢复                                                                   |
| `1da24fe`                                              | 设备认证 Protobuf 与私有引导通道                                                           | 跨语言样例、一次性票据                                                                   |
| `7071a2b`                                              | AI 提交信息草稿                                                                            | 隔离预览、过滤、独立填入，不自动提交                                                     |
| `632ca23`                                              | 逐片段 Git 操作                                                                            | `diffDigest` 前置校验的 hunk stage/unstage/revert                                        |
| `ac29537`                                              | 设备认证内核                                                                               | scope 权限、轮转会话、撤销                                                               |
| `18d0c2c`                                              | Git 操作恢复与进程清理                                                                     | 关停时回收受管命令、操作状态恢复                                                         |
| `abaebb6`                                              | Go Host 迁移核验与 staging 导入                                                            | 可恢复导入、staging 所有权                                                               |
| `93b18af`                                              | 一致性迁移导出                                                                             | 快照、Protobuf 清单、受管资产校验                                                        |
| `8c08750`                                              | 分支/同步/历史/worktree 工作流                                                             | 17 个临时仓库场景、bare remote 同步、Web 992 项                                          |
| `d93689c`                                              | Go Host 持久存储                                                                           | CAS/tombstone、幂等 receipt、同事务事件、交叉构建                                        |
| `e199fa7`                                              | 无损迁移包 Protobuf                                                                        | Rust 9、TS 12 样例、生成漂移检查                                                         |
| `e3fc670`                                              | 文件管理器拖拽到终端与画布                                                                 | Web 982 项、shared 58 项、headless Chrome 拖放实测                                       |
| `f37fa1e`                                              | 放大连接按钮与手势清理                                                                     | 27 项定向、100%/50% 缩放与触屏模拟                                                       |
| `d2eff4f`                                              | 应用主程序名称统一                                                                         | `target/debug/Armadra`、Cargo metadata                                                   |
| `23c249a`                                              | 桌面关闭/退出分离                                                                          | 18 项桌面 Rust 测试；原生按键未验收                                                      |
| `f3bb770`                                              | Runtime 明确退出                                                                           | 全套 359 项、真实进程 EOF/关停                                                           |
| `0f3d913`                                              | 快捷键录制与窗口键保护                                                                     | 76 项定向、真实浏览器录制                                                                |
| `598222e`                                              | 数据库拒绝破坏式重建                                                                       | 26 项数据库专项、迁移/恢复同事务回滚                                                     |
| `64f1c1a`                                              | 私有桌面退出协议                                                                           | Go/Rust/TS 共享帧样例                                                                    |
| `7687ff5`                                              | SQLite 一致性手动备份                                                                      | 4 项快照回归、WAL 与并发命名                                                             |
| `40dc141`                                              | 桌面自动启动/发现 Host                                                                     | 10 项 Rust 测试、真实启动器与 macOS 保活                                                 |
| `f03c23a`                                              | 原生管理结果 Protobuf                                                                      | start/status/stop 二进制输出、跨语言样例                                                 |
| `fd240f6`                                              | Go Host sidecar 准备                                                                       | 6 项目标/路径测试、Windows PE 交叉产物                                                   |
| `3339a88`                                              | 后台启停 CLI                                                                               | 独立 start/status/stop/serve、并发收敛、HTTP 排空                                        |
| `f3b3326`                                              | 实例绑定控制协议                                                                           | 22 项控制测试、帧/深度/丢 ACK 分类                                                       |
| `ac5c6b0`                                              | 同用户本机 IPC                                                                             | Unix socket 与 Windows 管道身份校验                                                      |
| `c2e55eb`                                              | 设置与窄屏侧栏互斥                                                                         | 12 项侧栏测试、宽→窄切换实测                                                             |
| `51cbcfd`                                              | Host 连接设置页                                                                            | 39 项定向、真实跨源握手、390px 边界                                                      |
| `44c1dff`                                              | 精确 Origin 许可                                                                           | 来源/预检拒绝规则、Go race/vet                                                           |
| `b4a21e8`                                              | 独立 Protobuf HostClient                                                                   | 63 项单测、真实重启前后握手                                                              |
| `41b9b15`                                              | 持久 Host 身份与单实例                                                                     | 文件锁、损坏身份拒绝、强杀恢复                                                           |
| `89128f1`                                              | 执行器核验探针                                                                             | Chromium CDP 与 Windows ConPTY 编译探针，见 [核验记录](./research/m0-executor-probes.md) |
| `ad564c0`                                              | 本机 Go Host 与实机握手                                                                    | TS→Rust→Go 往返、断连重协商、畸形请求拒绝                                                |
| `e91fa2d`                                              | Protobuf 三语言基础                                                                        | 单一 schema、生成与漂移检查、共享样例                                                    |
| `279ef23`                                              | 设计文档与接续基线                                                                         | 文档范围对齐前置界面决定                                                                 |

协议验收覆盖：中文/emoji、uint64 最大值、int64 最小值、超过 JS 安全整数的 generation、optional 未传/零值、oneof 分支、截断拒绝、未知字段与未知枚举。Go/TS 保留未知字段，prost 丢弃，Rust 透明中继必须转发原始载荷。

## 运行环境与限制

- Go `1.26.5`（`go.mod` 要求 ≥ 1.24），macOS arm64；生成流程使用 vendored protoc `31.1`，不依赖系统 protoc `35.1`。
- Rust 已安装 macOS arm64、Windows x64 MSVC、Linux x64 目标；安装 target 不代表能在本机运行 Windows/Linux 实机测试。
- Rust Runtime 仍是唯一业务权威。Go Host 已具备身份、认证、存储、调度与 Worker 客户端，但没有业务 Protobuf 表面，也没有拒绝旧 Runtime 写入的 epoch 机制。
- 真实 Worker 测试与桌面 `src-tauri` Rust 测试不在默认命令内，验收时需单独运行。

## 下一步

1. 第三轮正在实施（各自 worktree）：§4.1 多仓库发现与提交图 + G03 Frame 绑定；G04 GitHub 面板（Go Host + mock 验证）；B01 受控浏览器 Worker；H02 Host 静态托管与认证代理 + H03 手机焦点页；T03 渲染预算与休眠 + T01 Windows Session Host（交叉编译）；A02 Agent 会话目标投递、A01 转平台计划、A04 交接历史、S03 更新契约、服务器模式、C01 旧称清理。
2. 第四轮：H01 业务 Protobuf 表面与写入所有权 epoch 切换；H02 远端 Rust Worker；C02 迁移一致性验收；托盘迷你条桌面接线。
3. 全部合入后把 `main` 快进到功能分支；结构整理按 repository-structure.md 顺序在功能任务完成后单独进行。
4. 需要 Windows runner 与手机实机的验收项保持「交叉编译/模拟」状态，不标为完成。
