# 画布工作平台实施记录

> 目标范围见 [设计总纲](./canvas-platform-design.md)。本文件只记录经过核验的进度，不以设计文档代替实现。

## 接续基线

- 前置任务：`01a06ddd-d6e7-7b22-8acd-04d80a5a2237`，目标回合 `01a06e06-4b9a-7712-8a0f-22583e1313f5`。
- 已通过任务等待接口及最新结果读取确认：目标回合 completed、error=null，任务 idle；完成时间 Unix `1788556374`。
- 代码基线：`334a57e`；前置任务报告分 15 次提交完成标题编辑、拖入、原生内容引用、移动布局及终端外框等修复。
- 前置任务报告的验证：Web 830、shared 57、Rust 391 项测试以及构建、类型检查、clippy。此处是交接证据，不冒充本轮重新运行的结果。
- 接续时未提交内容仅为本任务的六份设计文档及三处文档入口修改；保留前置代码，不回滚其标签/配色移除等最新界面决定。
- 实施分支：`feature/host-protocol-foundation`。主 Agent 协调子 Agent 分工、复核、暂存及提交；每项独立功能验证后单独提交。

## 阶段状态

| 阶段  | 状态     | 已完成 / 剩余                                                                                      |
| ----- | -------- | -------------------------------------------------------------------------------------------------- |
| M0    | 部分完成 | 三语言协议及真实 Host 握手完成；macOS CDP 核验通过，Windows 仅交叉检查，实机与完整 Worker 仍待完成 |
| M1    | 进行中   | 身份、后台启停及桌面自动启动接线已完成；设备认证、业务迁移和剩余平台验收未完成                     |
| M2–M7 | 待实施   | 后台调度及其他产品工作流仍按各阶段交付                                                             |
| M8    | 预留范围 | 多人、多账号及发布更新只按设计交付前期契约                                                         |

## 按需求核对的接续清单

以下状态对应设计总纲中的需求 ID，按源码核对。已有能力只说明可复用的基础，不等于通过目标场景验收；M2–M7 的“待实施”也不表示现有应用没有任何相关功能。

| ID | 当前可复用能力 / 证据入口 | 尚需交付与验收 |
| --- | --- | --- |
| C01 | 画布已为主工作面；`canvas-store.ts`、保存队列和 Runtime 模型仍读写 Kanban | 一致性备份、旧列/卡片归档；停止新写入；正式迁移移除残留，保留备注 |
| C02 | 已有 tldraw 自由图形、图片、Frame 与上下文链接 | 迁移前后 ID、位置、资源、嵌套 Frame、白板摘要和链接一致 |
| A01 | 原生 Agent 状态和子任务展示已有基础 | 原生循环活动与平台 Loop/Cron/Schedule 两套独立数据、节点与操作 |
| A02 | Go Host 已可独立于桌面进程存活 | 持久计划、时区、执行收据、运行历史；零客户端与崩溃恢复实测 |
| A03 | `agent.rs` 已支持自定义 Agent 继承基础定义 | CLI/主机能力协商；会话上下文准确/估计/未知状态，模型切换与分母校验 |
| A04 | `collab/mailbox.rs` 已有持久消息箱、幂等键与确认 | 带预算、来源、文件及提交指纹的交接预览/接受/失败恢复 |
| A05 | `TerminalSurface.tsx` 已处理 OSC 标题与手工标题保护 | 持久命名来源与 AI 命名；AI 提交信息预览、敏感内容过滤与人工确认提交 |
| G01 | `git.rs` 已有状态、diff、文件暂存/取消暂存/还原、提交与克隆 | hunk/冲突边界、统一操作状态及从克隆到提交的完整验收 |
| G02 | 当前显示分支名称 | 分支管理、fetch/pull/push/sync、操作队列、历史分页/图与冲突继续/中止 |
| G03 | Frame 与本地项目目录已有基础 | worktree 创建/移除/修复、分组绑定、路径继承与初始化脚本 |
| G04 | 无目标 GitHub 面板交付记录 | Issues 状态映射与远端回写、PR 创建/评审/检查/合并及预期 SHA 校验 |
| E01 | `EditorNode.tsx` 已有 CodeMirror、语法扩展、脏状态与保存冲突提示 | 文件工作流完整性、外部变更处理、远程版本保存与语言服务 |
| B01 | `BrowserNode.tsx` 为 iframe 预览；另有独立 CDP 探针 | Rust Browser Worker、持久浏览会话、输入/帧流、权限及人与 Agent 共用会话 |
| H01 | Protobuf 握手/本机控制、Go Host 后台启停、Tauri 启动接线 | 业务协议与持久存储、导入验证、写入所有权切换、Worker 及事件恢复 |
| H02 | `terminal/ssh.rs` 已有 SSH 配置、连接测试与命令启动 | 对外 TLS/设备认证；远端 Worker 与文件/Git/浏览器统一执行位置 |
| H03 | 当前画布与设置已有窄屏适配验证 | 各新增工作流手机焦点页、触摸/软键盘操作、远程断线恢复与实机验收 |
| H04 | 设计约定身份、权限、租约和 Presence | 将预留契约落实到协议与能力响应；暂不开放多人操作 |
| T01 | 当前 direct PTY 与 Unix tmux；Windows ConPTY 仅编译探针 | 独立 Windows Session Host、无头 VT；UI/Host/Worker 分别退出后重附着 |
| T02 | 无目标资源/电源工作流交付记录 | 执行主机与会话采集、防休眠租约及释放、未知指标状态 |
| T03 | 当前终端有附着、恢复与渲染生命周期代码 | 统一后台渲染预算、隐藏/休眠/恢复策略及不重复创建进程的压力验收 |
| S01 | `KeybindingsPage.tsx` 已有录制、覆盖与冲突提示 | 默认自动填充、手填、平台差异、继承/设备覆盖/重置全流程 |
| S02 | 当前账号设置不等于节点多账号绑定 | credentialRef、节点绑定、授权与账号分离的协议/能力预留 |
| S03 | 有更新目标设计 | 发布兼容、签名与更新作业的契约及不支持状态；自动更新后续开放 |

交付顺序先完成 M1 数据安全和可验证导入，再接业务所有权与 Worker。后续功能按所属阶段逐项实现；每项附代码提交和实际验证结果，未完成的验收不得勾选。

## 已采用的分工

- protocol_foundation：统一 `.proto`、Go/TS/Rust 生成代码、二进制互通及边界测试。
- windows_browser_probe：独立临时环境下验证 CDP 与 Windows ConPTY 编译条件，随后整理可重复执行的探针。
- host_review：独立只读审查 Host 请求边界、关闭生命周期、生成器跨平台启动及实际链路。
- 主 Agent：本机 Go Host 握手入口、验证、独立审查与分功能提交。

M1 第一批继续复用子 Agent：windows_browser_probe 实现跨平台 hoststate；protocol_foundation 实现独立 HostClient；host_review 审查锁/文件边界和客户端协商；主 Agent 负责协议增量、CLI 集成与真实进程重启验证。

## 运行环境与限制

- Go `1.26.5`，macOS arm64；生成流程使用锁定的 vendored protoc `31.1`，不依赖系统 protoc `35.1`。
- Rust 已安装 macOS arm64、Windows x64 MSVC、Linux x64 目标；安装 target 不代表能在本机运行 Windows/Linux 实机测试。
- 当前已有 Runtime 仍是应用执行服务。新增 Host 在 M0 使用独立入口，未切换生产数据所有权、未启用设备远程认证、未承诺后台计划已经可用。

## 独立提交与已验证功能

| 提交      | 功能                       | 验证证据                                                                                                        |
| --------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `279ef23` | 设计文档与接续基线         | 文档范围对齐前置任务的新界面决定                                                                                |
| `e91fa2d` | Protobuf 三语言基础        | 单一 schema；可重复生成及漂移检查；Go/Rust/TS 对照共享样例                                                      |
| `ad564c0` | 本机 Go Host 与实机握手    | TS → Rust → Go HTTP → Rust → TS；两次连接强制关闭 TCP 后重新协商；错误协议/畸形请求拒绝                         |
| `89128f1` | 可重复执行器核验工具       | 独立 Chromium CDP 探针与 Windows ConPTY 编译探针；结果和未验范围见 [核验记录](./research/m0-executor-probes.md) |
| `41b9b15` | 持久 Host 身份与单实例保护 | OS 文件锁、损坏身份拒绝、跨进程竞争/强杀恢复、真实 CLI 重启与 minor 0 兼容                                      |
| `b4a21e8` | 独立 Protobuf HostClient   | 63 项单测及实际 Host 重启前后握手；代理路径前缀、响应限额、取消/超时与错误分类                                  |
| `44c1dff` | 精确 Origin 许可           | 来源/预检/authority 拒绝规则、配置前置校验、Go race/vet、真实 HTTP 验证                                         |
| `51cbcfd` | Host 连接设置页            | 39 项定向测试、类型检查/构建；真实浏览器连接、失败清理、390px 页面边界                                          |
| `c2e55eb` | 设置与窄屏侧栏互斥         | 12 项侧栏测试；最新代码实际宽→窄切换、偏好恢复与手机侧栏导航验证                                                |
| `ac5c6b0` | 同用户本机 IPC             | Unix 私有短路径 socket、Windows 管道及服务端身份校验、长路径/别名/权限测试                                      |
| `f3b3326` | 实例绑定控制协议           | Status/Stop Protobuf、22 项控制测试、帧/深度/丢 ACK/断连分类和跨语言样例                                        |
| `3339a88` | 后台启停 CLI               | 独立 start/status/stop/serve、真实子进程保活、并发收敛、HTTP 排空与重启身份                                     |
| `fd240f6` | Go Host sidecar准备        | 6 项目标/路径测试，本机构建与Windows PE交叉产物；保留Rust sidecar流程                                           |
| `f03c23a` | 原生管理结果Protobuf       | start/status/stop二进制输出、跨语言样例及CLI生命周期验证                                                        |
| `7687ff5` | SQLite 一致性手动备份 | 4 项快照回归及实际 API；WAL、并发命名和失败保护 |
| `64f1c1a` | 私有桌面退出协议 | Go/Rust/TS 共享帧样例与生成漂移检查 |
| `40dc141` | 桌面自动启动/发现Host      | 10项Rust测试、clippy、真实Rust启动器和macOS原生进程保活；窗口菜单退出未验收                                     |

协议验收覆盖：中文/emoji、uint64 最大值、int64 最小值、超过 JS 安全整数的 generation、optional 未传/零值、oneof 三个分支、截断拒绝、未知字段行为。Go/TS 默认保留未知字段；prost 会丢弃，未来 Rust 透明中继必须转发原始载荷。尚未引入枚举，不将未知枚举检查记为已完成。

本轮实际执行且通过：

- `pnpm protocol:generate` 与 `pnpm protocol:check`；锁定生成器无产物漂移。
- `pnpm protocol:test`：Go 4 个测试函数（含共享样例子测试）、Rust 6 项、TS 7 项及类型检查。
- `go -C apps/host test -race ./...`、`go -C apps/host vet ./...`：Host 6 个测试函数，含 13 种非法/越界请求子场景、同源 IPv6、重连和退出。
- `cargo clippy --locked -p armadra-protocol --all-targets -- -D warnings`。
- `pnpm host:smoke`：临时 Go 二进制、临时端口，真实跨语言请求和响应；测试后退出进程并移除临时二进制。
- `pnpm --filter @armadra/web typecheck`、新增文件格式检查和 `git diff --check`。

审查发现并解决：Host 退出需等待 Shutdown 请求排空；Windows 生成脚本不能直接执行 `.cmd`；握手实例稳定测试需显式关闭 TCP 才能作为重连证据。Windows 脚本已按进程创建规则修正，仍待实机验证。

## M1 第一批验收

- `hoststate.Open/Close/DefaultDir` 已接入 Go CLI，支持 `--data-dir`；同目录只允许一个持锁 Host，不改现有 `canvas.db`。
- 数据目录持久身份为 `identity.json` 的 ID；协议 minor 1 增加 `HelloResponse.host_id=5`，进程身份 `host_instance_id` 每次启动变化。旧 minor 0 消息与协商仍兼容，生成产物与样例已同步。
- 新 `@armadra/host-client` 包提供 `hello()`，直接返回生成类型，无自动重试；拒绝服务端返回高于客户端请求的协商 minor，缺字段、错误媒体、超大响应和过期请求有稳定错误。
- 实际执行：协议漂移检查、Go/Rust/TS 契约测试（TS 增至 8 项）、Go `test -race ./...` 与 `vet ./...`，新增 CLI 启动失败释放锁测试，HostClient 63 项单测、类型检查、构建。
- `pnpm host:smoke` 实际启动临时 Host，通过重复启动拒绝、强制断开 TCP 后重连、服务重启、旧 minor 握手和 HostClient 连接；同目录 hostId 稳定，instanceId 变化。所有临时进程/目录在结束时清理。
- Go Host Windows amd64 可执行文件已交叉构建成功；hoststate 的 Windows 测试二进制与 Linux 构建检查通过。它们未在相应系统运行，也不替代 Rust ConPTY 的链接和实机验证。
- Unix 使用 0700/0600；Windows 继承目录 ACL，未建立自定义目录的私有 DACL，不将其记为凭据/业务数据权限隔离完成。当前仅保存公开身份元数据。
- 独立 HostClient 已通过 Node 实际网络验证，但尚未接入应用运行页面、Tauri 生命周期、远程登录或跨源认证；本轮不宣称 M1 已整体完成。

## M1 第二批验收

- Go CLI 支持重复传入 `--allow-origin`，仅明确允许的规范化来源可读取 metadata；保留回环 authority 限制。合法 OPTIONS 返回精确 ACAO/Vary，未启用 credentials CORS，未知路由/方法/header/Origin 拒绝。
- 无效来源配置在数据目录和监听操作前失败；错误不回显潜在凭据。Tauri 的三种精确来源可显式配置，未将此等同于设备认证。
- 设置 → 连接 → 后台服务可显式检查/取消、保留本设备有效地址、展开查看持久/进程标识。编辑、失败、卸载不保留旧连接成功。当前仍不自动启动 Host、不切换 Runtime 业务。
- 默认桌面 CSP 新增 `http://127.0.0.1:43121`，未开放任意远程地址。Web 依赖链的 predev/prebuild 构建协议和客户端包。
- 定向测试：连接状态 16 项、页面 7 项、i18n 7 项、SettingsDialog 9 项，共 39 项；独立侧栏修复另 12 项。web typecheck/build、Go race/vet 与 Windows Go 交叉构建通过。
- Playwright 使用独立浏览器和 Vite 1442、真实 Go Host 43121，验证显式跨源握手成功，改错地址后旧 ID 清除，重新连接成功；1280px 与 390×844 视口下控件可见、无面板横向溢出。
- 复测发现开发服务器返回旧模块，重启并确认返回最新代码后重新执行宽→窄回归：设置保持可操作、关闭后恢复侧栏偏好、手机侧栏进入设置会收起抽屉。不能将旧模块上的失败算为新代码验证。
- 实测时旧 Rust Runtime 故意未运行，其连接拒绝日志为已知环境状态；Host 连接检查仍独立成功。没有验证 iOS/Android 实机或打包 Tauri 原生窗口。
- 本地截图位于 `output/playwright/host-connection-desktop.png`、`host-connection-mobile.png`、`host-connection-mobile-resize.png`，不提交临时截图/profile。测试浏览器、Vite 与 Host 均已关闭。

## M1 第三批验收

- `armadra-host start/status/stop/serve` 已实现；省略子命令仍以前台 serve 兼容运行。CLI JSON 仅作状态展示，控制通信为长度前缀 Protobuf。
- start 使用独立进程会话/进程组和独立诊断日志，启动命令退出后 HTTP 仍可达。重复启动返回已有状态，不偷偷改动运行配置。
- 本机控制不使用公开 TCP/CORS，不读 PID 文件并强杀进程。Unix 验证目录/socket 的 owner、类型和权限；Windows 在同一已连接 handle 上核验 pipe owner 与服务进程 SID。
- Stop 绑定实例 ID，完整 ACK 只表示接受；CLI 继续等待 HTTP 排空及目录锁释放。零字节断连和部分帧损坏分类不同，停止结果不确定时不盲目重发。
- 修复独立审查和真实并发测试发现的竞争：短暂锁探测不会令 serve 立即误判已有服务；无主过渡有宽限；竞争者返回前回收自己多余的子进程，防止获胜服务停止后延迟复活。诊断 processId 仅用于辨认自建进程，发送信号使用已持有的子进程对象。
- 控制帧上限 1 MiB、期限 3 秒、最多 32 条连接；descriptor-aware 预检拒绝 group 并限制已知消息深度，未知 bytes 保持不透明。固定 Go 解码器的 RecursionLimit 不单独覆盖未知 group，已用实际失败测试确认并补齐。
- 实际通过 `go test -race ./...`、`go vet ./...`、协议生成漂移检查和跨语言契约（Rust 7 项、TS 9 项）；daemon 控制测试 22 项。Windows Go Host、控制/管道测试程序交叉构建通过，未在 Windows/Linux 实机运行。
- `pnpm host:lifecycle-smoke` 实际验证：启动父命令退出后服务可达、独立状态、重复/并发启动、在途 HTTP 停止排空、停止后无子进程复活、身份重启保持、损坏身份不修复、无效配置不创建目录。
- `pnpm host:smoke` 的原有 Protobuf HTTP/CORS 链路仍通过。测试使用临时目录和私有端点，结束后停止服务并清理；本次未启动长期用户服务。
- 不包含登录/开机自启动安装、Tauri 自动管理、远程设备认证、业务数据库切换或实际定时任务。Windows 身份/日志目录仍沿用目录 ACL，未保存账号凭据；控制管道的受保护 DACL 不等于整个数据目录隔离已验收。

## M1 第四批验收

- desktop predev 准备本机 Go Host，生产 sidecar 准备包含 Runtime/Hook/Host；支持明确的 macOS/Linux/Windows x64/arm64 目标，未知目标拒绝。构建来源尊重 CARGO_TARGET_DIR，Tauri 暂存按配置固定路径。
- `start/status/stop --output protobuf` 返回单个 HostManagementResult，原生启动器不解析 JSON；默认 CLI JSON 展示不变。跨语言样例区分运行状态与已完成停止，协议生成漂移检查通过。
- Tauri setup 异步调用 Rust 启动器，校验默认端点、两个身份、协议、OPTIONS/Hello来源许可。已有服务不兼容时不重配或重启，失败不阻断原 Runtime/UI；退出钩子没有 Go stop。
- 生产仅使用包内 sidecar；开发支持绝对二进制覆盖和 CARGO_TARGET_DIR，空目标目录值与准备脚本默认行为一致。CLI输出/HTTP体有界，CLI15秒及清理2秒期限，丢弃私密stderr。
- 10项Rust测试通过，包含实际CLI输出/退出/超时回收、流大小边界与实际HTTP探针；cargo check（发布默认feature）、cargo clippy（no-default-features/all-targets/-D warnings）通过。修正了测试跨await持有同步锁及脚本尚未写PID的时序依赖。
- `pnpm host:bootstrap-smoke` 使用同一Rust代码实际启动Go，验证启动器进程结束后的Host保活、重复发现、来源不兼容时已有实例保持不变；`host:lifecycle-smoke`包含二进制start/status/stop结果，均通过。
- macOS实际运行新桌面二进制及临时测试bundle，观察到Host自动启动；桌面进程退出后，临时目录的Host与实例ID保持一致，之后已明确停止并清理。测试中原Runtime使用未运行端口，未触及正常业务数据。
- 原生窗口自动化工具返回timeoutReached，未由工具确认正常菜单/窗口关闭动作，不将其记为完整GUI退出验收。临时测试bundle、Host数据目录及Vite均已清理，未操作已有应用窗口。
- Windows Go x64/arm64构建为对应PE；没有Windows/Linux原生Tauri、安装包或签名发布验收。Go Host保活不能替代尚未迁移的Rust执行器或实际定时任务。

## M1 数据安全补齐

- 数据库启动在同一 SQLite 写事务内先校验账本，再执行已知前缀迁移和恢复；未知/损坏/脏历史明确拒绝，失败回滚并关闭连接池，取消自动改名重建。
- 子 Agent 实际通过 26 项 `db::tests`：合法旧版升级、后续失败回滚、WAL 已提交数据保留、拒绝时不改变运行会话、账本异常、编码文件路径及内存库。不修改既有迁移文件，不把 SQLite 自身日志维护描述为文件逐字节不变。

- 手动数据库备份已改为当前连接的 SQLite 一致性快照；包含 WAL 已提交数据，不再直接复制主文件。SQL 绑定文件名，私有暂存文件验证完整性并同步后以不覆盖方式发布。
- 备份源通过连接自身的 `PRAGMA database_list` 定位，内存库或已消失的源明确拒绝；同秒并发操作使用独立名字。HTTP 请求取消后任务继续负责完成和清理，避免 SQLite 仍写入时删除目标。
- 子 Agent 实际通过 4 项快照回归及真实数据页 API 路由测试：WAL 与活跃 reader、同秒并发、失败清理/既有备份保护、内存与缺失源。文件系统不支持硬链接时安全失败；Runtime 强制中断可能留下私有 `.partial`，不会把半成品返回为成功。
- 一致性备份是迁移准备，不代表旧数据已经导入 Go Host，Runtime 仍为业务唯一权威。

## 执行器 PoC 结果（M0，历史记录）

- 独立临时 Chrome profile，Chrome `152.0.7977.76` / CDP `1.3`，macOS arm64。
- 实际完成 headless 启动、HTTP 导航、1000×700 viewport、点击、英文/中文/emoji 文本注入、表单/Canvas 截图、400 px 滚轮、screencast 帧及 ACK；探针退出后 CDP 端口关闭。
- 这是 CDP 接口实证，未验证操作系统 IME composition、tldraw 裁剪缩放、交互延迟预算或 Windows/Linux 浏览器运行；生产 Rust Browser Worker 尚未实现。
- Windows `windows-sys 0.61.2` ConPTY API 及 `portable-pty 0.9.0` 最小程序的离线 target 检查通过；链接失败为缺少 `link.exe`，无 Windows 可执行工件及运行证据。
- Windows 下一步需要独立 Session Host、无头 VT 和 IPC；现有 Unix `ps` 前台检测与 direct detach 销毁行为不能直接复用为持久化方案。光标继承查询必须处理或禁用。

## 下一步

1. M1 下一批：推进Host业务存储/迁移准备与设备认证，先保证未知数据库版本或校验失败不会触发破坏式重建，再建立可验证的迁移流程；原Rust Runtime在切换完成前保持业务权威，禁止双写。桌面启动器、CLI、本机IPC及连接设置已完成，不重复实现；任务调度、工作执行器接管和Kanban残留迁移仍按设计继续。
2. 在具备 Windows runner 后补链接与会话重附着实测；macOS 可继续建设 Browser Worker，不让平台专属验证阻止其他模块推进。
3. 后续继续使用子 Agent 分工，每个功能验证后独立提交。自动检查维持 15 分钟，全部当前范围完成前保持启用。
