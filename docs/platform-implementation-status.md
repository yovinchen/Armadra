# 画布工作平台实施记录

> 目标范围见 [设计总纲](./canvas-platform-design.md)。本文件只记录经过核验的进度，不以设计文档代替实现。
> 各批次的详细验证过程归档在 [实施批次记录](./history/platform-implementation-log.md)；本文件保留阶段状态、需求核对、提交登记、当前工作树与下一步。

## 接续基线

- 代码基线 `334a57e`，实施分支 `feature/host-protocol-foundation`；自基线起 76 次提交，含 2026-09-05 晚间的 5 个拆分提交、4 批并行实施与 2 次格式修正。
- 2026-09-05 由四个只读审计子 Agent 按 Runtime、Go Host、Web/shared、协议/桌面/文档分工重新核对源码并实际运行验证命令；本文件的阶段与需求状态以该次核对为准。
- 审计时的 66 项未提交改动已按协议→命令 Worker→交接后端→文档拆成可独立编译的提交；随后四个 worktree 隔离的实施 Agent 分别完成 A04 接线、A02 装配、E01 外部变更、G02 rebase/sync，由主 Agent 审阅后线性合入并在主树重跑全部回归。
- 主 Agent 协调子 Agent 分工、复核、暂存及提交；每项独立功能验证后单独提交并即时更新本记录。

## 阶段状态

| 阶段 | 状态     | 已完成 / 剩余                                                                                                                                                 |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0   | 部分完成 | 三语言协议、真实 Host 握手、macOS CDP 探针完成；Windows ConPTY 仅离线编译检查，受控浏览器三平台与 Windows 重附着未完成                                        |
| M1   | 大部完成 | 身份、单实例、本机控制、HTTPS 设备认证、持久存储、迁移导出/导入核验、桌面生命周期、Kanban 退役已提交；业务写入所有权仍在 Rust Runtime                         |
| M2   | 进行中   | 只读 Worker、命令执行 Worker、Claude 单会话上下文、能力继承已提交；Windows Host 最小可用与其他 Provider 上下文未开始                                          |
| M3   | 进行中   | Host 进程已能零客户端到点执行非交互命令并在 Worker 被杀后重建；交接 API、后台投递与前端预览/确认已交付；自动化计划前端节点/面板、原生循环卡片与自动命名未开始 |
| M4   | 进行中   | Git 基础与进阶（rebase、sync、leased force push）、编辑器内容版本与外部变更监听已提交；Frame 分组绑定、历史行操作、语言服务未完成                             |
| M5   | 未开始   | GitHub 面板无交付；浏览器节点仍为 iframe 兼容预览，不计入 B01                                                                                                 |
| M6   | 部分基础 | SSH 配置/连接测试、设备配对与窄屏布局已有；远端 Worker、手机焦点页、协作契约未交付                                                                            |
| M7   | 部分基础 | 快捷键录制/冲突检测已有；Windows 持久会话、资源/电源、渲染休眠、更新契约未交付                                                                                |
| M8   | 预留范围 | 多人、多账号及发布更新只按设计交付前期契约；当前仅身份 scope 与 `account_id` 显式拒绝                                                                         |

## 按需求核对的接续清单

三列分别为已提交并验证的能力、工作树中未提交的进展、尚未开始或未验收的部分。「已交付」只说明可复用的基础，不等于通过目标场景验收。

| ID  | 已交付（提交内）                                                                                                                                                                                                                                                                | 进行中（工作树，未提交）                       | 待交付与验收                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| C01 | 可写 Kanban 从 Canvas/API/保存链路移除；SQLite v3 不可变归档与只读浏览/导出；节点备注保留                                                                                                                                                                                       | —                                              | 代码注释与侧栏命名仍有「看板」旧称；`architecture.md` Runtime 职责已同步                                                         |
| C02 | tldraw 自由图形、图片、Frame、上下文链接与原生内容引用；`ContextLink.content` 供 Agent 读取                                                                                                                                                                                     | —                                              | 迁移到 Host 后的 ID、位置、资源、嵌套 Frame 一致性验收                                                                           |
| A01 | 无                                                                                                                                                                                                                                                                              | —                                              | AgentActivityNode / AutomationNode、领域类型、面板与操作全部未开始                                                               |
| A02 | Go 持久调度内核；Rust 非交互命令 Worker 与 Go 命令客户端；Host `serve` 按 `--worker-binary/--worker-state-dir` 启动 Worker、dispatcher 与 Engine；命令定义/payload/授权持久化（Host 迁移 3）并在 Worker 换代后重建；HTTPS Define/Activate/Pause/RunNow/List 走 automation scope | —                                              | 前端计划节点与面板；计划级「需处理」状态（目标不可重建时 run 记 Skipped，计划仍显示 Active）；Windows 守护与 Job Object 实机验收 |
| A03 | Claude 状态栏用量、unknown/stale/estimated 区分、会话代次绑定、`disabledCapabilities` 继承、Hook 绑定校验                                                                                                                                                                       | 输入围栏序列推进与 Hook `terminalBinding`      | 其他 Provider 来源、估算器、阈值设置、模型选择 UI、CLI 版本与执行主机能力求交集                                                  |
| A04 | 交接 bundle 持久化与冻结、串行终端投递门、`/handoffs` prepare/list/get/accept/cancel 路由、后台投递随 Runtime 启停、shared schema 导出、终端菜单「交接到…」与预览/确认对话框及状态 chip                                                                                         | —                                              | 真实 Agent 端 `handoff-read` 端到端；交接历史面板；跨执行主机快照显式拒绝                                                        |
| A05 | AI 提交信息草稿（隔离预览、过滤、独立填入）；手动触发的标题建议接口                                                                                                                                                                                                             | —                                              | 自动命名规则（占位标题才应用、人工改名锁定）、提交信息语言/规范选项                                                              |
| G01 | 状态、diff、文件与 hunk 级暂存/取消/还原、提交、克隆、冲突中心、执行权限门                                                                                                                                                                                                      | —                                              | `git init`、amend、还原来源区分、并排 diff、显式标记已解决                                                                       |
| G02 | 分支增删切换、fetch/pull/push、操作队列、历史分页与父关系图、stash、merge、cherry-pick、owned rebase（继续/中止、原分支恢复）、Sync 三步 CAS、`--force-with-lease` 二次确认                                                                                                     | —                                              | 交互式 rebase、rebase skip、reset/revert/tag/remote、历史行操作、跨 Runtime 持久恢复                                             |
| G03 | worktree 列表、创建（预期 OID）、安全移除、私有 exclude                                                                                                                                                                                                                         | —                                              | Frame 分组绑定、路径继承、解绑与删除区分、初始化脚本、repair                                                                     |
| G04 | 无                                                                                                                                                                                                                                                                              | —                                              | Issues 状态映射与远端回写、PR 创建/评审/检查/合并及预期 SHA 校验                                                                 |
| E01 | CodeMirror 语法、SHA 内容版本保存、并发草稿保护；`notify` 目录级监听经 WS 推送 `file.changed`（modified/removed/replaced），自保存不误报，不可用时退化为按需版本检查；编辑器比较/重载/保留草稿提示条                                                                            | —                                              | 三方合并、搜索与文件工作流、远程写入、语言服务、Markdown 预览；Windows/Linux 监听后端未实机                                      |
| B01 | iframe 预览节点（设计明确的兼容模式）；独立 CDP 探针                                                                                                                                                                                                                            | —                                              | Rust Browser Worker、持久浏览会话、输入/帧流、人与 Agent 共用会话                                                                |
| H01 | Protobuf 握手/本机控制、Host 后台启停、单实例、桌面引导、私有 SQLite 存储、一致性导出与 staging 导入                                                                                                                                                                            | Worker 命令协议增量                            | 业务 Protobuf 表面（canvas/session/agent/filesystem/git 等）、写入所有权 epoch 切换、事件恢复                                    |
| H02 | SSH 配置与连接测试；TLS 启动检查、设备配对、`__Host-` 会话、CSRF 轮转、设备管理 UI                                                                                                                                                                                              | —                                              | 认证后可用的业务 API、静态前端托管、远端 Worker、统一执行位置                                                                    |
| H03 | 767px 断点、窄屏侧栏 Sheet、100dvh、触屏命中尺寸                                                                                                                                                                                                                                | —                                              | 各工作流手机焦点页、底部导航、Git 三级导航、断线重连不重复输入                                                                   |
| H04 | 身份 scope 显式构造，空 scope 不扩权                                                                                                                                                                                                                                            | —                                              | Presence/Mutation/租约契约与能力响应                                                                                             |
| T01 | Unix tmux 持久后端；direct PTY；Windows 下禁用 tmux                                                                                                                                                                                                                             | Windows 命令执行 Job Object 隔离（仅交叉编译） | Windows 持久会话后端完全缺失；Windows 命令守护进程缺失                                                                           |
| T02 | 无                                                                                                                                                                                                                                                                              | —                                              | 资源采集、会话表格、防休眠租约；协议层连预留都未提供                                                                             |
| T03 | 终端附着、恢复与渲染生命周期代码                                                                                                                                                                                                                                                | —                                              | 统一后台渲染预算、隐藏/休眠/恢复策略与压力验收                                                                                   |
| S01 | 默认键位、录制、跨 scope 冲突检测、窗口键保护、非拉丁布局                                                                                                                                                                                                                       | —                                              | 平台分别覆盖（存储写死 mac/other 同值）、设备覆盖、继承与重置全流程                                                              |
| S02 | `accountId` 领域字段预留；命令启动非 `default` 账号显式 UNSUPPORTED；身份权限含 `credential:use`                                                                                                                                                                                | —                                              | `credentialRef` / `AccountRef` 协议、节点绑定 UI                                                                                 |
| S03 | 桌面 `updater` 配置骨架（注释）                                                                                                                                                                                                                                                 | —                                              | 更新契约、签名与兼容检查、`tauri-plugin-updater` 未引入                                                                          |

## 本轮实施（2026-09-05 晚）

审计时的工作树先按语言拆为 5 个提交（格式修正、命令协议、命令 Worker、交接后端、文档），再由四个 worktree 隔离的 Opus 子 Agent 并行实施；每个 Agent 在自己的分支提交并给出验证数字，主 Agent 审阅 diff 后以 cherry-pick 线性合入，只在 `main.rs` 关停顺序处解决过一次冲突。

- **A04 交接接线**：Runtime 五条 `/handoffs` 路由与路由级测试（跨 workspace 拒绝、重复 accept 幂等、取消后不投递）；`start_background` 随 Runtime 启动、关停前 4 秒排空；shared 导出 schema 并对照 Runtime 类型测试；Web 终端菜单入口、预览对话框（目标、预算档、文件/Git 指纹、遗漏清单）、状态 chip。真实 Runtime 验证 prepare→get→stale digest 409→accept queued→cancel→目标退出 failed/targetEnded；实际粘贴需 Hook 报告 idle，裸 shell 正确停在 queued。
- **A02 Host 装配**：`automation.proto` 增补服务请求/响应与命令会话定义（字段号不变）；Host 迁移 3 持久化 `command_roots/command_sessions/automation_payloads/automation_grants`；`internal/automationhost` 负责 Worker 启动、定义重建、有界重启、PayloadResolver 与授权；`serve` 启动顺序与 `stop` 反序关停。真实 Host 端到端：配对→定义 `/bin/echo` 会话→Once 计划→约 12 秒后 SUCCEEDED→`kill -9` Worker→按 generation 重建且不重复 run→stop 无残留进程。
- **E01 外部变更**：`notify 8.2.0` 监听父目录，`file-watch` 注册/注销与 `file-version` 退化接口，写入前登记 sha 消除自保存竞态，120 ms 合并突发；编辑器未脏自动重载、已脏提示比较/重载/保留，删除后转 create-only。真实浏览器验证三种选择与 `rm` 分支。
- **G02 rebase/sync**：`StartRebase{onto,expectedStateToken}` 所有权绑定 `rebase-merge` 记录与 `orig-head` 文件身份；continue 可在下一提交再次停下，abort 校验恢复到记录的分支+OID；`Sync` 先对已观察远端 OID 做 CAS 再 fetch→ff pull→push，失败报告停在哪一步；push 保留 `--no-force`，lease 时追加 `--force-with-lease=ref:oid`，UI 需勾选确认。只用本地 bare remote。
- **格式与配置**：`cargo fmt` 修正 9 个历史文件；prettier 修正 61 个历史源码文件，`.prettierignore` 排除 `.claude/worktrees|skills|agents`。发现用户全局 `~/.gitignore_global` 忽略了 `.gitignore` 本身，仓库的 `.gitignore` 因此从未被跟踪（新 worktree 没有忽略规则）；未擅自改动，待用户决定。

## 本轮验证（2026-09-05，全部合入后于主树重跑）

| 范围         | 命令                                                                                                      | 结果                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime      | `cargo test -p armadra-runtime`、`cargo clippy … --all-targets -- -D warnings`、`cargo fmt --all --check` | 517 项通过，clippy 与 fmt 干净                                                                           |
| 协议         | `pnpm protocol:check`、`pnpm protocol:test`                                                               | 生成物无漂移；Go 契约、Rust 14 项、TS 17 项通过                                                          |
| Go Host      | `go -C apps/host test -race -count=1 ./...`、`vet`、Windows/Linux amd64 交叉构建                          | 13 个包通过；真实 Worker 用例在设置 `ARMADRA_TEST_REAL_WORKER` 后同样通过                                |
| Web / shared | `pnpm --filter @armadra/web test`、`typecheck`、`@armadra/shared test`                                    | Web 109 文件 1103 项，shared 81 项，类型检查通过（需先 `pnpm --filter @armadra/shared build` 刷新 dist） |
| 格式         | `pnpm format:check`                                                                                       | 通过（排除第三方技能目录后）                                                                             |
| 真实进程     | 各 Agent 的临时 Runtime/Host/Vite 端到端                                                                  | 见「本轮实施」；均使用临时目录与端口，结束后清理，未启动收费 Agent，未访问用户远端                       |

Windows Job Object、ConPTY、Windows/Linux 文件监听仅交叉编译；桌面 `src-tauri` 的 18 项 Rust 测试本轮未运行。

## 独立提交与已验证功能

自 `334a57e` 起的功能提交按时间倒序登记；详细验证过程见[归档](./history/platform-implementation-log.md)对应小节。

| 提交       | 功能                                                       | 验证要点                                                                                 |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `f4050e08` | 历史源码 prettier 修正                                     | Web 1103、shared 81、TS 契约 17、typecheck                                               |
| `051baf0a` | G02 rebase/sync 设计文档状态                               | 章节编号未动                                                                             |
| `eeacd67b` | Web rebase/sync 与 leased force push 确认                  | Web 1081 项、6 项新增、typecheck                                                         |
| `9a1a7454` | shared rebase/sync/lease 契约                              | shared 77 项                                                                             |
| `5ce3f482` | Runtime owned rebase、Sync、lease push                     | Runtime 506 项；真实临时仓库 rebase/sync/lease 场景                                      |
| `fd12da8d` | 编辑器外部变更设计文档状态                                 | —                                                                                        |
| `7148d083` | 编辑器比较/重载/保留草稿                                   | Web 1090 项、15 项新增；真实浏览器三分支验证                                             |
| `8abc9b2e` | Runtime 文件监听与版本退化接口                             | Runtime 508 项、9 项新增；路由级权限撤销 403                                             |
| `53d9cb96` | Host 调度表面与 Worker 参数说明                            | README 同步                                                                              |
| `2f3e5265` | Host serve 启动调度并随停止关停                            | 真实 Host 端到端、stop 无残留                                                            |
| `27ad71fb` | automationhost 装配 Worker/dispatcher/Engine 与 HTTPS 路由 | Worker 被杀重启、state-dir 清空重建、root 删除 UNREBUILDABLE                             |
| `b4f0b20b` | 自动化 RunNow 与按 workspace 列表                          | Go automation 测试                                                                       |
| `938220ca` | Host 迁移 3：命令定义、payload、授权                       | 迁移 1/2 摘要守卫                                                                        |
| `98ffc461` | automation 服务表面 Protobuf                               | Go/Rust 14/TS 17 契约样例、protocol:check                                                |
| `0cff3294` | 交接流程文档                                               | —                                                                                        |
| `da332f92` | Web 交接预览与确认                                         | Web 1082 项、7 项新增、i18n 守卫                                                         |
| `20642770` | shared 导出交接 schema                                     | shared 78 项、4 项新增                                                                   |
| `2557da71` | Runtime 交接路由与后台投递启停                             | Runtime 439+62 项；真实 Runtime prepare/accept/cancel/targetEnded                        |
| `1ac0fdc`  | 状态文档审计与历史归档                                     | 链接与 prettier 检查                                                                     |
| `65c050c`  | 交接 bundle 持久化与终端投递门                             | 迁移 0004、Hook 绑定、能力门；提交时尚无路由                                             |
| `c0bca23`  | 非交互命令 Worker（Rust+Go）                               | 独立 worktree 编译验证；真实 Worker 7 项                                                 |
| `bddd534`  | 命令执行 Protobuf 契约                                     | Go/Rust 13/TS 16 契约与 3 个 fixture                                                     |
| `e22490c`  | 历史格式修正                                               | `cargo fmt`、prettier                                                                    |
| `427d0f2`  | Git 执行权限与可操作提示                                   | 6 项配置脚本/远程 helper 回归、6 项 Git API、54 项客户端定向、Web 全套 1075              |
| `3222891`  | 编辑器内容版本传输与 create-only 测试                      | 真实 API 读取→外改→拒绝覆盖→重读保存                                                     |
| `1f3fc4f`  | 编辑器内容版本与保存竞态                                   | Rust 文件 10 项、CodeMirror 竞态 4 项、shared 74                                         |
| `2adf463`  | 单会话上下文与能力继承                                     | Hook 101、context 7、Agent 7、真实 PTY 代次绑定、Chrome 8%→Unknown 与重连清旧值          |
| `af81266`  | Cherry-pick 与空结果 Skip                                  | Rust 43 项、组件 28 项、真实 API 预览→应用→空结果→跨 workspace 拒绝→Skip                 |
| `abc918f`  | 持久自动化内核                                             | 26 组临时 DB/可控时间测试、race/vet、跨语言未知 enum 样例；仅内核，未接生产              |
| `f23cdda`  | Go→Rust 只读 Worker 桥接                                   | Rust Worker 5 项、文件 7 项、Go 11 组子进程场景、60 万字节分块与 SHA                     |
| `62f1cac`  | 退役任务看板，保留不可变归档                               | 归档只读、写字段 400 拒绝、导出含 `kanbanSha256`                                         |
| `8c07b17`  | 合并与冲突恢复                                             | owned merge、冲突继续/中止、状态 token 校验                                              |
| `7337410`  | 设备管理客户端与设置界面                                   | 设备分页、撤销 CAS、会话续期 UI                                                          |
| `6efdd61`  | Git 写入后的面板刷新                                       | hunk 视图与 AI 来源刷新                                                                  |
| `5c888ce`  | HTTPS 设备配对与会话接口                                   | 真实 HTTPS 子进程链路、`__Host-` Cookie、CSRF 轮转                                       |
| `6528edd`  | Stash 工作流                                               | 固定快照、冲突安全恢复                                                                   |
| `1da24fe`  | 设备认证 Protobuf 与私有引导通道                           | 跨语言样例、一次性票据                                                                   |
| `7071a2b`  | AI 提交信息草稿                                            | 隔离预览、过滤、独立填入，不自动提交                                                     |
| `632ca23`  | 逐片段 Git 操作                                            | `diffDigest` 前置校验的 hunk stage/unstage/revert                                        |
| `ac29537`  | 设备认证内核                                               | scope 权限、轮转会话、撤销                                                               |
| `18d0c2c`  | Git 操作恢复与进程清理                                     | 关停时回收受管命令、操作状态恢复                                                         |
| `abaebb6`  | Go Host 迁移核验与 staging 导入                            | 可恢复导入、staging 所有权                                                               |
| `93b18af`  | 一致性迁移导出                                             | 快照、Protobuf 清单、受管资产校验                                                        |
| `8c08750`  | 分支/同步/历史/worktree 工作流                             | 17 个临时仓库场景、bare remote 同步、Web 992 项                                          |
| `d93689c`  | Go Host 持久存储                                           | CAS/tombstone、幂等 receipt、同事务事件、交叉构建                                        |
| `e199fa7`  | 无损迁移包 Protobuf                                        | Rust 9、TS 12 样例、生成漂移检查                                                         |
| `e3fc670`  | 文件管理器拖拽到终端与画布                                 | Web 982 项、shared 58 项、headless Chrome 拖放实测                                       |
| `f37fa1e`  | 放大连接按钮与手势清理                                     | 27 项定向、100%/50% 缩放与触屏模拟                                                       |
| `d2eff4f`  | 应用主程序名称统一                                         | `target/debug/Armadra`、Cargo metadata                                                   |
| `23c249a`  | 桌面关闭/退出分离                                          | 18 项桌面 Rust 测试；原生按键未验收                                                      |
| `f3bb770`  | Runtime 明确退出                                           | 全套 359 项、真实进程 EOF/关停                                                           |
| `0f3d913`  | 快捷键录制与窗口键保护                                     | 76 项定向、真实浏览器录制                                                                |
| `598222e`  | 数据库拒绝破坏式重建                                       | 26 项数据库专项、迁移/恢复同事务回滚                                                     |
| `64f1c1a`  | 私有桌面退出协议                                           | Go/Rust/TS 共享帧样例                                                                    |
| `7687ff5`  | SQLite 一致性手动备份                                      | 4 项快照回归、WAL 与并发命名                                                             |
| `40dc141`  | 桌面自动启动/发现 Host                                     | 10 项 Rust 测试、真实启动器与 macOS 保活                                                 |
| `f03c23a`  | 原生管理结果 Protobuf                                      | start/status/stop 二进制输出、跨语言样例                                                 |
| `fd240f6`  | Go Host sidecar 准备                                       | 6 项目标/路径测试、Windows PE 交叉产物                                                   |
| `3339a88`  | 后台启停 CLI                                               | 独立 start/status/stop/serve、并发收敛、HTTP 排空                                        |
| `f3b3326`  | 实例绑定控制协议                                           | 22 项控制测试、帧/深度/丢 ACK 分类                                                       |
| `ac5c6b0`  | 同用户本机 IPC                                             | Unix socket 与 Windows 管道身份校验                                                      |
| `c2e55eb`  | 设置与窄屏侧栏互斥                                         | 12 项侧栏测试、宽→窄切换实测                                                             |
| `51cbcfd`  | Host 连接设置页                                            | 39 项定向、真实跨源握手、390px 边界                                                      |
| `44c1dff`  | 精确 Origin 许可                                           | 来源/预检拒绝规则、Go race/vet                                                           |
| `b4a21e8`  | 独立 Protobuf HostClient                                   | 63 项单测、真实重启前后握手                                                              |
| `41b9b15`  | 持久 Host 身份与单实例                                     | 文件锁、损坏身份拒绝、强杀恢复                                                           |
| `89128f1`  | 执行器核验探针                                             | Chromium CDP 与 Windows ConPTY 编译探针，见 [核验记录](./research/m0-executor-probes.md) |
| `ad564c0`  | 本机 Go Host 与实机握手                                    | TS→Rust→Go 往返、断连重协商、畸形请求拒绝                                                |
| `e91fa2d`  | Protobuf 三语言基础                                        | 单一 schema、生成与漂移检查、共享样例                                                    |
| `279ef23`  | 设计文档与接续基线                                         | 文档范围对齐前置界面决定                                                                 |

协议验收覆盖：中文/emoji、uint64 最大值、int64 最小值、超过 JS 安全整数的 generation、optional 未传/零值、oneof 分支、截断拒绝、未知字段与未知枚举。Go/TS 保留未知字段，prost 丢弃，Rust 透明中继必须转发原始载荷。

## 运行环境与限制

- Go `1.26.5`（`go.mod` 要求 ≥ 1.24），macOS arm64；生成流程使用 vendored protoc `31.1`，不依赖系统 protoc `35.1`。
- Rust 已安装 macOS arm64、Windows x64 MSVC、Linux x64 目标；安装 target 不代表能在本机运行 Windows/Linux 实机测试。
- Rust Runtime 仍是唯一业务权威。Go Host 已具备身份、认证、存储、调度与 Worker 客户端，但没有业务 Protobuf 表面，也没有拒绝旧 Runtime 写入的 epoch 机制。
- 真实 Worker 测试与桌面 `src-tauri` Rust 测试不在默认命令内，验收时需单独运行。

## 下一步

1. A01/A02 前端：自动化计划节点与面板（Define/Activate/Pause/RunNow/List 经 Host HTTPS），计划级「需处理」状态；原生循环观察卡片与数据类型分离。
2. A05 自动命名闭环：占位标题才应用、人工改名锁定、按 session/generation 缓存。
3. G03 Frame↔worktree 绑定与路径继承；G02 历史行操作（checkout/建分支/复制 OID/revert）。
4. H01 业务 Protobuf 表面与写入所有权 epoch 切换；在此之前 Rust Runtime 仍是唯一业务权威。
5. Windows：命令守护进程、Job Object、ConPTY 与文件监听实机验收需要 Windows runner；T01 持久会话后端单独立项。
6. 用户决定是否跟踪 `.gitignore`（当前被全局忽略规则隐藏）；每次功能提交后在本记录登记哈希与验证要点，详细过程写入归档文件。
