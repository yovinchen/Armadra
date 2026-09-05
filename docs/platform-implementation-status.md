# 画布工作平台实施记录

> 目标范围见 [设计总纲](./canvas-platform-design.md)。本文件只记录经过核验的进度，不以设计文档代替实现。
> 各批次的详细验证过程归档在 [实施批次记录](./history/platform-implementation-log.md)；本文件保留阶段状态、需求核对、提交登记、当前工作树与下一步。

## 接续基线

- 代码基线 `334a57e`，实施分支 `feature/host-protocol-foundation`，当前 HEAD `427d0f2`；自基线起 52 次提交（46 次功能/修复、6 次文档），366 个文件、约 6.8 万行新增。
- 2026-09-05 由四个只读审计子 Agent 按 Runtime、Go Host、Web/shared、协议/桌面/文档分工重新核对源码并实际运行验证命令；本文件的阶段与需求状态以该次核对为准。
- 工作树另有 66 项未提交改动（44 项修改、22 项未跟踪），内容见「当前工作树」；它们尚未计入任何「已交付」状态。
- 主 Agent 协调子 Agent 分工、复核、暂存及提交；每项独立功能验证后单独提交并即时更新本记录。

## 阶段状态

| 阶段 | 状态     | 已完成 / 剩余                                                                                                                                     |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0   | 部分完成 | 三语言协议、真实 Host 握手、macOS CDP 探针完成；Windows ConPTY 仅离线编译检查，受控浏览器三平台与 Windows 重附着未完成                            |
| M1   | 大部完成 | 身份、单实例、本机控制、HTTPS 设备认证、持久存储、迁移导出/导入核验、桌面生命周期、Kanban 退役已提交；业务写入所有权仍在 Rust Runtime             |
| M2   | 进行中   | 只读 Worker、Claude 单会话上下文、能力继承已提交；命令执行 Worker 在工作树；Windows Host 最小可用与其他 Provider 上下文未开始                     |
| M3   | 进行中   | 持久调度内核已提交；命令执行器与调度器在库级别打通但未装配进 Host 主程序；交接后端在工作树且无 API/UI；原生循环卡片与自动命名未开始               |
| M4   | 进行中   | 分支/同步/历史/worktree、hunk、AI 提交草稿、stash、merge、cherry-pick、执行权限、编辑器内容版本已提交；rebase、Frame 分组绑定、外部变更监听未完成 |
| M5   | 未开始   | GitHub 面板无交付；浏览器节点仍为 iframe 兼容预览，不计入 B01                                                                                     |
| M6   | 部分基础 | SSH 配置/连接测试、设备配对与窄屏布局已有；远端 Worker、手机焦点页、协作契约未交付                                                                |
| M7   | 部分基础 | 快捷键录制/冲突检测已有；Windows 持久会话、资源/电源、渲染休眠、更新契约未交付                                                                    |
| M8   | 预留范围 | 多人、多账号及发布更新只按设计交付前期契约；当前仅身份 scope 与 `account_id` 显式拒绝                                                             |

## 按需求核对的接续清单

三列分别为已提交并验证的能力、工作树中未提交的进展、尚未开始或未验收的部分。「已交付」只说明可复用的基础，不等于通过目标场景验收。

| ID  | 已交付（提交内）                                                                                                     | 进行中（工作树，未提交）                                                              | 待交付与验收                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| C01 | 可写 Kanban 从 Canvas/API/保存链路移除；SQLite v3 不可变归档与只读浏览/导出；节点备注保留                            | —                                                                                     | 代码注释与侧栏命名仍有「看板」旧称；`architecture.md` Runtime 职责已同步                             |
| C02 | tldraw 自由图形、图片、Frame、上下文链接与原生内容引用；`ContextLink.content` 供 Agent 读取                          | —                                                                                     | 迁移到 Host 后的 ID、位置、资源、嵌套 Frame 一致性验收                                               |
| A01 | 无                                                                                                                   | —                                                                                     | AgentActivityNode / AutomationNode、领域类型、面板与操作全部未开始                                   |
| A02 | Go 持久调度内核（Once/Interval/Cron/Loop、CAS 认领、target 门、收据对账、崩溃恢复）；Go→Rust 只读 Worker 桥接        | Rust 非交互命令 Worker、Go 命令客户端与 `commanddispatch`；真实端到端 7 项通过        | 装配进 `armadra-host` 主程序、计划/命令会话的 API 与 UI、Host 侧命令会话持久化、Windows 守护实机验收 |
| A03 | Claude 状态栏用量、unknown/stale/estimated 区分、会话代次绑定、`disabledCapabilities` 继承、Hook 绑定校验            | 输入围栏序列推进与 Hook `terminalBinding`                                             | 其他 Provider 来源、估算器、阈值设置、模型选择 UI、CLI 版本与执行主机能力求交集                      |
| A04 | `collab/mailbox.rs` 持久消息箱、幂等键与确认                                                                         | Runtime `handoff/` 准备/接受/投递与迁移 0004；`paste_handoff` 串行投递门；shared 类型 | HTTP 路由与后台投递启动均未接线，前端零实现；跨执行主机快照显式拒绝                                  |
| A05 | AI 提交信息草稿（隔离预览、过滤、独立填入）；手动触发的标题建议接口                                                  | —                                                                                     | 自动命名规则（占位标题才应用、人工改名锁定）、提交信息语言/规范选项                                  |
| G01 | 状态、diff、文件与 hunk 级暂存/取消/还原、提交、克隆、冲突中心、执行权限门                                           | —                                                                                     | `git init`、amend、还原来源区分、并排 diff、显式标记已解决                                           |
| G02 | 分支增删切换、fetch/ff-only pull/非 force push、操作队列、历史分页与父关系图、stash、merge、cherry-pick、空结果 Skip | —                                                                                     | rebase 发起、sync 三步、force-with-lease、reset/revert/tag/remote、历史行操作、跨 Runtime 持久恢复   |
| G03 | worktree 列表、创建（预期 OID）、安全移除、私有 exclude                                                              | —                                                                                     | Frame 分组绑定、路径继承、解绑与删除区分、初始化脚本、repair                                         |
| G04 | 无                                                                                                                   | —                                                                                     | Issues 状态映射与远端回写、PR 创建/评审/检查/合并及预期 SHA 校验                                     |
| E01 | CodeMirror 语法、SHA 内容版本保存、并发输入/切换文件/权限变更草稿保护、1 MiB 只读降级                                | —                                                                                     | 外部变更监听与比较/重载、搜索与文件工作流、远程写入、语言服务、Markdown 预览                         |
| B01 | iframe 预览节点（设计明确的兼容模式）；独立 CDP 探针                                                                 | —                                                                                     | Rust Browser Worker、持久浏览会话、输入/帧流、人与 Agent 共用会话                                    |
| H01 | Protobuf 握手/本机控制、Host 后台启停、单实例、桌面引导、私有 SQLite 存储、一致性导出与 staging 导入                 | Worker 命令协议增量                                                                   | 业务 Protobuf 表面（canvas/session/agent/filesystem/git 等）、写入所有权 epoch 切换、事件恢复        |
| H02 | SSH 配置与连接测试；TLS 启动检查、设备配对、`__Host-` 会话、CSRF 轮转、设备管理 UI                                   | —                                                                                     | 认证后可用的业务 API、静态前端托管、远端 Worker、统一执行位置                                        |
| H03 | 767px 断点、窄屏侧栏 Sheet、100dvh、触屏命中尺寸                                                                     | —                                                                                     | 各工作流手机焦点页、底部导航、Git 三级导航、断线重连不重复输入                                       |
| H04 | 身份 scope 显式构造，空 scope 不扩权                                                                                 | —                                                                                     | Presence/Mutation/租约契约与能力响应                                                                 |
| T01 | Unix tmux 持久后端；direct PTY；Windows 下禁用 tmux                                                                  | Windows 命令执行 Job Object 隔离（仅交叉编译）                                        | Windows 持久会话后端完全缺失；Windows 命令守护进程缺失                                               |
| T02 | 无                                                                                                                   | —                                                                                     | 资源采集、会话表格、防休眠租约；协议层连预留都未提供                                                 |
| T03 | 终端附着、恢复与渲染生命周期代码                                                                                     | —                                                                                     | 统一后台渲染预算、隐藏/休眠/恢复策略与压力验收                                                       |
| S01 | 默认键位、录制、跨 scope 冲突检测、窗口键保护、非拉丁布局                                                            | —                                                                                     | 平台分别覆盖（存储写死 mac/other 同值）、设备覆盖、继承与重置全流程                                  |
| S02 | `accountId` 领域字段预留；命令启动非 `default` 账号显式 UNSUPPORTED；身份权限含 `credential:use`                     | —                                                                                     | `credentialRef` / `AccountRef` 协议、节点绑定 UI                                                     |
| S03 | 桌面 `updater` 配置骨架（注释）                                                                                      | —                                                                                     | 更新契约、签名与兼容检查、`tauri-plugin-updater` 未引入                                              |

## 当前工作树（未提交）

66 项改动全部来自同一批「命令执行器 + 交接」工作及一轮 README/文档精简。2026-09-05 核对结论如下；提交前需按语言拆分并保持每个提交可编译。

**命令执行 Worker（A02，已接线到 Worker 入口）**

- `proto/armadra/v1/command.proto` 新增：`CommandSessionKind` 仅 `NON_INTERACTIVE_COMMAND`；`CommandPhase` 含 `NOT_DISPATCHED`（无副作用肯定证明）与 `UNKNOWN`；收据带请求/执行摘要、序号、`cleanup_confirmed`、`no_effect_proven`。`worker.proto` 以字段号 20 挂载能力与请求/响应，只读模式下缺省。Go/TS 生成物与 3 个 fixture 同步，`pnpm protocol:check` 通过。
- Rust `apps/runtime/src/command/`：独立 `worker.db` 与目录权限校验、执行日志先落库再启动、Unix 进程组隔离与 `setsid` 守护子进程、输出截断、重试要求 phase/cleanup/no-effect/sequence 四者匹配；`worker --stdio --state-dir` 与 `worker-guardian` 入口。Windows 版 Job Object 隔离 624 行未经编译验证，且守护入口只在 Unix 存在。
- Go `internal/worker/commands.go` 七个 RPC 封装做请求前置与响应回校验；`process.go` 的 `StateDir` 开启命令模式并在关闭时先发 Shutdown；`containment_windows.go` 用 Job Object kill-on-close；`wire.go` 增加 oneof 唯一性校验。`internal/commanddispatch` 实现调度器 `Dispatcher`，重投递必须先取得 `NOT_DISPATCHED` 证据。
- 未接线：`cmd/armadra-host` 不引用 automation/worker/commanddispatch，进程内没有 `Engine.Run`；HTTPS 只暴露 Hello 与 Identity；Host 不持久化命令会话，Worker 换代后计划会停在 TargetUnknown。

**对话交接（A04，仅后端且未接线）**

- `apps/runtime/src/handoff/`：准备/读取/列表/接受/取消、转录仅按 Provider 明确路径读取并脱敏、文件与 Git 指纹、按优先级裁剪预算；迁移 `0004_agent_handoffs.sql` 建 `agent_handoffs`（触发器冻结 bundle）与 outbox，Rust 与 Go legacy 校验各一份。
- `terminal/mod.rs` 新增输入安全解析、按会话键串行的投递门与 `paste_handoff`（要求前台程序为 Agent，普通终端不注入）；`collab/control.rs` 提供 `handoff-read`，mailbox 对 `handoff:` 键做授权 ack；`context_usage.rs` 序列推进与 Hook `terminalBinding` 校验；`HOOK_CLIENT_REVISION` 2→3。
- 未接线：`lib.rs` 无任何 handoff 路由，`delivery::start_background` 全仓无调用点，`packages/shared/src/handoff.ts` 未从 index 导出且无测试，`apps/web` 零引用。迁移 0004 已随启动执行，属于「建表已上线、消费者未上线」，合入前必须补路由与后台投递或拆出迁移。

**文档与配置**

- 根与各包 README、`docs/README.md`、`docs/development.md`、`proto/README.md` 精简重写（净减约 200 行）；`development.md` 新增 Go ≥ 1.24 要求与 Go/协议/桌面独立检查行，但删除了目录树。`AGENTS.md`、`CLAUDE.md` 为未跟踪新文件。`.claude/launch.json` 改为 `dev` 脚本并新增 `runtime` 条目。
- 本轮修正：`handoff/tests.rs` 补 `ContextLink.content`、静态计数 SQL、移除未用 import、锁不跨 await；`crates/protocol/tests/contract.rs` 补 `expected_not_dispatched_sequence`。修正前 `cargo test -p armadra-runtime` 与 `-p armadra-protocol` 均无法编译。
- `docs/architecture.md` Runtime 职责移除「看板」；历史批次原文迁至 `history/platform-implementation-log.md`。

## 本轮验证（2026-09-05）

| 范围         | 命令                                                                                  | 结果                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | `cargo test -p armadra-runtime`                                                       | 通过：lib 439 项（含 handoff 6 项）、集成测试 60 项                                                                                   |
| 协议 / Hook  | `cargo test -p armadra-protocol`、`-p armadra-hook`                                   | 通过：契约 13 项、Hook 12 项                                                                                                          |
| Clippy       | `cargo clippy -p armadra-runtime -p armadra-protocol --all-targets -- -D warnings`    | 通过（修正测试后）                                                                                                                    |
| 格式         | `cargo fmt --all --check`                                                             | **失败**：9 个文件，其中 `context_api.rs`、`error.rs`、5 个 `tests/git_*_api.rs` 为已提交代码，`lib.rs`、`main.rs` 为工作树改动       |
| Go Host      | `go -C apps/host test -race ./...`、`vet`、`GOOS=windows GOARCH=amd64 go build ./...` | 全部通过（12 个包）；真实 Worker 测试默认跳过，设置 `ARMADRA_TEST_REAL_WORKER` 指向 debug Runtime 后 7/7 通过，含零 UI 调度→Rust 收据 |
| 协议生成     | `pnpm protocol:check`、`pnpm protocol:test`                                           | 通过：Go 契约、Rust 13 项、TS 16 项                                                                                                   |
| Web / shared | `pnpm --filter @armadra/web test`、`typecheck`、`@armadra/shared test`                | 通过：Web 106 文件 1075 项，shared 74 项，类型检查无错误                                                                              |
| 桌面脚本     | `pnpm --filter @armadra/desktop test`                                                 | 通过 6 项（sidecar 脚本；`src-tauri` 的 18 项 Rust 测试需 `cargo test -p armadra-desktop`，本轮未运行）                               |
| 运行         | `cargo run -p armadra-runtime` + Web 1421 端口                                        | 前端正常连接 43120，加载工作空间、Agent 与设置；桌面启动的 Host 43121 因 Origin 限制拒绝 1421 来源，属预期                            |

Windows Job Object、ConPTY 与 Linux 相关代码仅交叉编译，未在对应系统运行；未启动收费 Agent，未向用户远端仓库写入。

## 独立提交与已验证功能

自 `334a57e` 起的功能提交按时间倒序登记；详细验证过程见[归档](./history/platform-implementation-log.md)对应小节。

| 提交      | 功能                                  | 验证要点                                                                                 |
| --------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `427d0f2` | Git 执行权限与可操作提示              | 6 项配置脚本/远程 helper 回归、6 项 Git API、54 项客户端定向、Web 全套 1075              |
| `3222891` | 编辑器内容版本传输与 create-only 测试 | 真实 API 读取→外改→拒绝覆盖→重读保存                                                     |
| `1f3fc4f` | 编辑器内容版本与保存竞态              | Rust 文件 10 项、CodeMirror 竞态 4 项、shared 74                                         |
| `2adf463` | 单会话上下文与能力继承                | Hook 101、context 7、Agent 7、真实 PTY 代次绑定、Chrome 8%→Unknown 与重连清旧值          |
| `af81266` | Cherry-pick 与空结果 Skip             | Rust 43 项、组件 28 项、真实 API 预览→应用→空结果→跨 workspace 拒绝→Skip                 |
| `abc918f` | 持久自动化内核                        | 26 组临时 DB/可控时间测试、race/vet、跨语言未知 enum 样例；仅内核，未接生产              |
| `f23cdda` | Go→Rust 只读 Worker 桥接              | Rust Worker 5 项、文件 7 项、Go 11 组子进程场景、60 万字节分块与 SHA                     |
| `62f1cac` | 退役任务看板，保留不可变归档          | 归档只读、写字段 400 拒绝、导出含 `kanbanSha256`                                         |
| `8c07b17` | 合并与冲突恢复                        | owned merge、冲突继续/中止、状态 token 校验                                              |
| `7337410` | 设备管理客户端与设置界面              | 设备分页、撤销 CAS、会话续期 UI                                                          |
| `6efdd61` | Git 写入后的面板刷新                  | hunk 视图与 AI 来源刷新                                                                  |
| `5c888ce` | HTTPS 设备配对与会话接口              | 真实 HTTPS 子进程链路、`__Host-` Cookie、CSRF 轮转                                       |
| `6528edd` | Stash 工作流                          | 固定快照、冲突安全恢复                                                                   |
| `1da24fe` | 设备认证 Protobuf 与私有引导通道      | 跨语言样例、一次性票据                                                                   |
| `7071a2b` | AI 提交信息草稿                       | 隔离预览、过滤、独立填入，不自动提交                                                     |
| `632ca23` | 逐片段 Git 操作                       | `diffDigest` 前置校验的 hunk stage/unstage/revert                                        |
| `ac29537` | 设备认证内核                          | scope 权限、轮转会话、撤销                                                               |
| `18d0c2c` | Git 操作恢复与进程清理                | 关停时回收受管命令、操作状态恢复                                                         |
| `abaebb6` | Go Host 迁移核验与 staging 导入       | 可恢复导入、staging 所有权                                                               |
| `93b18af` | 一致性迁移导出                        | 快照、Protobuf 清单、受管资产校验                                                        |
| `8c08750` | 分支/同步/历史/worktree 工作流        | 17 个临时仓库场景、bare remote 同步、Web 992 项                                          |
| `d93689c` | Go Host 持久存储                      | CAS/tombstone、幂等 receipt、同事务事件、交叉构建                                        |
| `e199fa7` | 无损迁移包 Protobuf                   | Rust 9、TS 12 样例、生成漂移检查                                                         |
| `e3fc670` | 文件管理器拖拽到终端与画布            | Web 982 项、shared 58 项、headless Chrome 拖放实测                                       |
| `f37fa1e` | 放大连接按钮与手势清理                | 27 项定向、100%/50% 缩放与触屏模拟                                                       |
| `d2eff4f` | 应用主程序名称统一                    | `target/debug/Armadra`、Cargo metadata                                                   |
| `23c249a` | 桌面关闭/退出分离                     | 18 项桌面 Rust 测试；原生按键未验收                                                      |
| `f3bb770` | Runtime 明确退出                      | 全套 359 项、真实进程 EOF/关停                                                           |
| `0f3d913` | 快捷键录制与窗口键保护                | 76 项定向、真实浏览器录制                                                                |
| `598222e` | 数据库拒绝破坏式重建                  | 26 项数据库专项、迁移/恢复同事务回滚                                                     |
| `64f1c1a` | 私有桌面退出协议                      | Go/Rust/TS 共享帧样例                                                                    |
| `7687ff5` | SQLite 一致性手动备份                 | 4 项快照回归、WAL 与并发命名                                                             |
| `40dc141` | 桌面自动启动/发现 Host                | 10 项 Rust 测试、真实启动器与 macOS 保活                                                 |
| `f03c23a` | 原生管理结果 Protobuf                 | start/status/stop 二进制输出、跨语言样例                                                 |
| `fd240f6` | Go Host sidecar 准备                  | 6 项目标/路径测试、Windows PE 交叉产物                                                   |
| `3339a88` | 后台启停 CLI                          | 独立 start/status/stop/serve、并发收敛、HTTP 排空                                        |
| `f3b3326` | 实例绑定控制协议                      | 22 项控制测试、帧/深度/丢 ACK 分类                                                       |
| `ac5c6b0` | 同用户本机 IPC                        | Unix socket 与 Windows 管道身份校验                                                      |
| `c2e55eb` | 设置与窄屏侧栏互斥                    | 12 项侧栏测试、宽→窄切换实测                                                             |
| `51cbcfd` | Host 连接设置页                       | 39 项定向、真实跨源握手、390px 边界                                                      |
| `44c1dff` | 精确 Origin 许可                      | 来源/预检拒绝规则、Go race/vet                                                           |
| `b4a21e8` | 独立 Protobuf HostClient              | 63 项单测、真实重启前后握手                                                              |
| `41b9b15` | 持久 Host 身份与单实例                | 文件锁、损坏身份拒绝、强杀恢复                                                           |
| `89128f1` | 执行器核验探针                        | Chromium CDP 与 Windows ConPTY 编译探针，见 [核验记录](./research/m0-executor-probes.md) |
| `ad564c0` | 本机 Go Host 与实机握手               | TS→Rust→Go 往返、断连重协商、畸形请求拒绝                                                |
| `e91fa2d` | Protobuf 三语言基础                   | 单一 schema、生成与漂移检查、共享样例                                                    |
| `279ef23` | 设计文档与接续基线                    | 文档范围对齐前置界面决定                                                                 |

协议验收覆盖：中文/emoji、uint64 最大值、int64 最小值、超过 JS 安全整数的 generation、optional 未传/零值、oneof 分支、截断拒绝、未知字段与未知枚举。Go/TS 保留未知字段，prost 丢弃，Rust 透明中继必须转发原始载荷。

## 运行环境与限制

- Go `1.26.5`（`go.mod` 要求 ≥ 1.24），macOS arm64；生成流程使用 vendored protoc `31.1`，不依赖系统 protoc `35.1`。
- Rust 已安装 macOS arm64、Windows x64 MSVC、Linux x64 目标；安装 target 不代表能在本机运行 Windows/Linux 实机测试。
- Rust Runtime 仍是唯一业务权威。Go Host 已具备身份、认证、存储、调度与 Worker 客户端，但没有业务 Protobuf 表面，也没有拒绝旧 Runtime 写入的 epoch 机制。
- 真实 Worker 测试与桌面 `src-tauri` Rust 测试不在默认命令内，验收时需单独运行。

## 下一步

1. 恢复检查基线：`cargo fmt --all` 修正 9 个文件后重新执行 `./armadra.sh check`；提交本轮测试修正。
2. 拆分并提交工作树：先协议与生成物（`command.proto` 及三语言产物、fixture），再 Rust 命令 Worker 与 Go 命令客户端/隔离/dispatcher，最后文档精简；每个提交独立可编译。交接迁移 0004 与 `handoff/` 需先补路由与后台投递再提交，否则拆出迁移。
3. A02 装配：`cmd/armadra-host` 按配置启动 Worker→`commanddispatch`→`automation.Engine.Run` 并纳入停止路径；补 `automation.proto` 服务表面与生产 `PayloadResolver`；Host 侧持久化命令会话。完成后才能宣称零客户端定时运行。
4. A04 接线：Runtime 加 prepare/get/list/accept/cancel 路由与后台投递启动/关停；shared 导出 `handoff` 并补测试；前端预览/接受与交接关联边。
5. M4 剩余：rebase 发起与 sync、Frame↔worktree 绑定、历史行操作、编辑器外部变更监听。
6. Windows：命令守护进程、Job Object 与 ConPTY 实机验收需要 Windows runner；T01 持久会话后端单独立项。
7. 文档：`development.md` 考虑恢复目录树；每次功能提交后在本记录登记哈希与验证要点，详细过程写入归档文件。
