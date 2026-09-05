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
| M1    | 进行中   | 身份、HTTPS设备认证、持久存储、迁移核验和生命周期已完成；业务权威切换、Worker和剩余平台验收未完成 |
| M2–M3 | 待实施 | Worker、后台调度和完整 Agent 流程仍待实施 |
| M4 | 进行中 | 分支/同步/历史/worktree、hunk、AI提交草稿和stash已落地；合并/冲突恢复、分组与其余进阶流程继续 |
| M5–M7 | 待实施 | GitHub、受控浏览器、远程设备及系统能力仍按阶段交付 |
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
| A05 | `TerminalSurface.tsx` 已处理 OSC 标题与手工标题保护 | 持久命名来源与 AI 命名仍待；AI 提交草稿、过滤和独立填入/提交已交付 |
| G01 | `git.rs` 已有状态、diff、文件暂存/取消暂存/还原、提交与克隆 | hunk和统一操作/关停状态已交付；冲突恢复与跨平台完整场景验收继续 |
| G02 | 分支管理、fetch/ff-only pull/non-force push、操作队列、稳定历史分页和父关系图已实现 | 操作重载恢复、stash已交付；merge/rebase/cherry-pick及冲突继续/中止进行中 |
| G03 | worktree 列表、创建、安全移除及私有目录排除已实现 | repair、Frame 分组绑定、路径继承与初始化脚本 |
| G04 | 无目标 GitHub 面板交付记录 | Issues 状态映射与远端回写、PR 创建/评审/检查/合并及预期 SHA 校验 |
| E01 | `EditorNode.tsx` 已有 CodeMirror、语法扩展、脏状态与保存冲突提示 | 文件工作流完整性、外部变更处理、远程版本保存与语言服务 |
| B01 | `BrowserNode.tsx` 为 iframe 预览；另有独立 CDP 探针 | Rust Browser Worker、持久浏览会话、输入/帧流、权限及人与 Agent 共用会话 |
| H01 | Protobuf 握手/本机控制、Go Host 后台启停、Tauri 启动接线 | 持久存储与staging导入验证已交付；业务协议、写入所有权切换、Worker及事件恢复继续 |
| H02 | `terminal/ssh.rs` 已有 SSH 配置、连接测试与命令启动 | TLS/设备认证内核与API已交付；前端/原生接线、远端Worker及统一执行位置继续 |
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
| `598222e` | 数据库拒绝破坏式重建 | 26 项数据库专项，迁移/恢复同事务回滚 |
| `0f3d913` | 快捷键录制与窗口键保护 | 76 项定向测试、类型检查与真实浏览器录制 |
| `f3bb770` | Runtime 明确退出 | 全套 359 项、追加关停回归、真实进程 EOF/关停验证 |
| `23c249a` | 桌面关闭/退出分离 | 18 项桌面测试、开发/发布检查；原生按键待验收 |
| `d2eff4f` | 应用主程序名称统一 | 实际 Armadra Mach-O、Cargo metadata、编译/Clippy |
| `f37fa1e` | 放大连接按钮与手势清理 | 27 项定向、100%/50%/触屏模拟及取消实测 |
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

## 桌面快捷键与退出补齐

- 前端不再把窗口关闭组合默认绑定到节点关闭；macOS 的 Command W/Q 与其他平台的 Ctrl W/Alt F4 留给窗口系统。旧自定义覆盖也不会拦截，Windows Ctrl Q 仍可送入终端。
- 快捷键录制会暂停应用原监听器，结束或卸载时恢复；IME 组词不保存为快捷键。跨 scope、修饰键别名和旧物理键别名按实际匹配规则提示冲突。
- 修复逗号与加号等符号录制后无法匹配的问题：存储规范化按键名，非拉丁布局与 Shift 符号可通过物理键匹配。
- 76 项 Web 定向测试通过；Web 类型检查/生产构建通过。独立审查发现并补齐逗号、加号和旧物理键别名的录制/冲突边界。
- 实际 headless Chrome 在独立 Vite 与 mock API 中验证：录制 Mod K 不误开命令面板，Mod Comma/Shift Equal 保存后显示和再次触发正确，旧 W/Q 覆盖的 DOM 事件不阻止默认动作。390px 下设置页和说明文字无横向溢出。
- 实测 API 来源仅测试端口 1444；未向常用服务发送测试数据。异步保存/弹窗完成前连按的初次失败按真实状态等待后复测通过。独立浏览器及 Vite 已清理；截图为 `output/playwright/keymap-desktop.png`、`keymap-mobile-390.png`，不提交临时 profile。
- 原生按键验收仍待完成：隔离 macOS bundle 的 System Events 定位及进程稳定性出现异常，未可靠完成 Cmd W/X/Q 实际操作；不以单测、DOM 事件或退出协议探针冒充原生快捷键验收。

## 桌面关闭与明确退出

- Command W/窗口叉号关闭到托盘，保留 WebView 草稿与后台；托盘菜单、菜单栏和 macOS Dock 可恢复前台。Command Q/“退出并停止后台”单次协调 Go Host 与桌面持有的 Runtime，只有确认退出后才退出桌面进程。
- macOS 明确安装标准菜单，其他平台提供关闭窗口的 Ctrl W 与无 Ctrl Q 占用的退出菜单。关停与 Host 启动串行，防止迟到启动使服务复活；错误或超时不伪装为整体成功。
- `./armadra.sh run desktop` 显式将 debug Runtime 交给桌面持有私有控制管道。独立 `pnpm ... dev` 保留外部 Runtime 模式，桌面不按 PID 猜测终止它。生产从包内启动受管 Runtime。
- 主 Agent 实际执行桌面完整 18 项测试通过；开发/发布编译与 Clippy、`bash -n armadra.sh` 通过。可用 `ARMADRA_DESKTOP_LIFECYCLE_TRACE=1` 输出有限阶段诊断，默认关闭，不记录按键或文档内容。
- macOS 原生按键验收未完成：仅观察到关闭请求和恢复窗口，未可靠派发 Cmd W/Q；隔离 bundle 后续退出的原因未确认。测试 App、注册、数据和独立服务已清理。默认服务后续状态也发生变化，来源未知，不能把“未向其发测试请求”当作其状态始终不变的证据。

## 应用名称统一

- 主可执行目标、Cargo default-run 与 Tauri mainBinaryName 统一为 `Armadra`；产品、窗口和托盘展示沿用同一名称，避免开发模式按 `armadra-desktop` 可执行文件名显示在 Dock/进程信息中。
- 实际构建产物为 `target/debug/Armadra`；Cargo metadata 验证唯一 bin target 与默认运行目标，编译及 Clippy 通过。Windows 文件名按系统规则为 `Armadra.exe`，Windows 实机显示尚未验收。
- 旧进程不会因源码更新而原地改名，需从新构建重启应用。此处记录主应用身份，后台协议与内部 package ID 保持兼容。

## 连接按钮易用性

- 鼠标圆点由 10px 提升为 14px，命中区 34px；触屏 16px/36px，默认透明度 0.85。扩展区域朝外，保持节点边界几何中心；低缩放仍有 14px 屏幕圆点。
- 外侧拖动明确绑定所属源节点，保留原生箭头位置和终点命中；转换后的链接保持同一步撤销。原生绘图、重复/自连校验及内容链接继续使用原规则。
- 手势按 token、editor 与 pointerId 归属，Esc/卸载/取消清理监听。独立审查发现并修复旧 pointerup 可能污染新画布工具及新手势的问题。
- 27 项定向测试与类型检查通过。真实 Chrome 在 100%/50% 缩放均可从外侧 22px 起线，中心偏移为 0，正文内侧 12px 不被遮挡；触屏模拟拖线及单次撤销通过。
- 实际 Esc 与拖动中卸载源节点后均无残留箭头/孤立 binding，测试 pageerror 为空。独立浏览器/Vite 已清理；结果保存在 `output/playwright/connection-handles-result.json` 和 `connection-handles-cancel-result.json`。触屏模拟不等同于移动设备实机验收。

## 文件管理器拖拽

- 左侧 FileTree 与画布 Files 节点传递同 Runtime/工作空间的版本化文件引用。终端落点只经 xterm paste 与当前 WS generation 插入路径；画布落点复用编辑器/图片/目录预览，内部引用不走外部文件复制。
- 核对真实 session、Agent、shell、规范路径及异步结果的目的地；处理 POSIX/PowerShell/CMD 引用、Windows extended drive/UNC，拒绝控制字符和不能可靠表示的路径。已标识的 SSH/跨执行位置不猜本机路径，普通 shell 保持兼容旧端缺少 Agent 身份的响应。
- 独立审查补齐自动启动/提示词/重试与文件路径冲突：这些状态阻止插入；已确认启动的剩余重试仅在所有校验成功后取消。同步连接状态阻止验证途中退出的会话接收路径。
- Windows 桌面内部拖拽使用指针适配，保留 Tauri 原生 OS 文件导入。阈值、捕获、失焦/Esc/离窗/卸载、同工作空间切画布和拖后点击均有清理；一次 drop 由终端或画布单独消费。
- 文件浏览面板改为 nonmodal，展开时可到达画布/终端，保留关闭与固定行为。此项来自实际交互核验，避免只有固定面板后才能拖放。
- 主 Agent 完整执行 Web 90 个文件/982 项与 shared 58 项测试通过；后续 pointer/Explorer 11 项、Windows 根路径 3 项增量回归通过。纯路径与引用测试共 82 项，POSIX 引用还经过 `/bin/sh` 验证。最终类型检查与生产构建通过。
- 最终执行 `cargo build --locked -p armadra-desktop -p armadra-runtime --bins` 通过，生成包含最新前端的本机 `target/debug/Armadra` 及最新 Runtime；这不是签名发布包或跨平台安装验收。
- 实际 headless Chrome 使用独立 Vite 1458，REST/WS 全部映射到 1457 mock：真实 FileTree → xterm 仅 1 条输入（正确引用及 bracketed-paste，无 CR/LF），不增编辑器；FilesNode → 画布新增 1 个编辑器并显示正文，输入数不增加，无外部复制请求。未启动收费 Agent 或使用用户后台服务。
- Chrome 中模拟 Win/Tauri 标识后验证实际 pointer 分支：禁用 HTML5 draggable、成功捕获、ghost 1→0、drop 仅新增一条输入；Esc 取消后输入/预览数不变。此结果不等于 Windows WebView2、PowerShell/CMD 或移动端实机验收。
- 限制：Finder/系统文件到终端仍提示从应用内文件树拖拽；原 OS → 画布导入保留。会话元数据不能识别用户在 shell 里手动再进入 SSH/更换 shell 的所有前台状态，不作此保证。
- 测试浏览器与 Vite 已清理；截图为 `output/playwright/file-drag-terminal.png`、`file-drag-canvas.png`、`file-drag-pointer-fallback.png`。初始 fixture 缺少 workspace/open 响应已修正，不把 mock 404 或构建引起的 HMR 重载误记为产品回归。

## Runtime 明确退出控制

- 新增仅在 `--desktop-control-stdin` 启用的继承 stdin Protobuf 控制，4 字节长度前缀及 4096 字节限额。EOF、未知动作、截断、重复/非规范消息不视为退出许可；未开放 HTTP 管理接口。
- 明确退出停止接收新业务并锁住会话创建/恢复/附着，验证 owned direct 子进程与 tmux 会话实际结束。普通重启信号仍保留 tmux；历史已完成/失败会话与项目节点不被重写。
- 迟到 detach/live 更新不能把已结束会话恢复成在线；元数据读取失败时仍尽力结束持有的进程，并保留失败结果。终端清理与 HTTP 排空有时限，清理未确认则进程非零退出。
- Runtime 提前占有监听端口，再迁移数据库或恢复会话；同端口重复启动不再提前修改活跃实例的会话记录。
- 子 Agent 使用临时数据目录、隔离 HOME 与真实进程验证：EOF 后服务/会话存活，未知动作不退出，同端口第二实例失败且不改 running 行，有效帧使 Runtime code 0 退出、端口关闭、受管 child PID 消失。另有隔离 tmux 重启保留/明确退出销毁测试。
- 主 Agent 完整执行 Runtime 359 项测试通过；补齐元数据故障路径后，3 项关停专项再次通过。Windows 实机进程树退出仍待平台验收，不能用 macOS 结果代替。

## 执行器 PoC 结果（M0，历史记录）

- 独立临时 Chrome profile，Chrome `152.0.7977.76` / CDP `1.3`，macOS arm64。
- 实际完成 headless 启动、HTTP 导航、1000×700 viewport、点击、英文/中文/emoji 文本注入、表单/Canvas 截图、400 px 滚轮、screencast 帧及 ACK；探针退出后 CDP 端口关闭。
- 这是 CDP 接口实证，未验证操作系统 IME composition、tldraw 裁剪缩放、交互延迟预算或 Windows/Linux 浏览器运行；生产 Rust Browser Worker 尚未实现。
- Windows `windows-sys 0.61.2` ConPTY API 及 `portable-pty 0.9.0` 最小程序的离线 target 检查通过；链接失败为缺少 `link.exe`，无 Windows 可执行工件及运行证据。
- Windows 下一步需要独立 Session Host、无头 VT 和 IPC；现有 Unix `ps` 前台检测与 direct detach 销毁行为不能直接复用为持久化方案。光标继承查询必须处理或禁用。

## 下一步

1. M1 下一批：建设 Go Host 持久业务存储、可复核导入报告与维护窗口/写入 epoch 切换，再接设备认证和 Worker。数据库拒绝重建、一致性备份、桌面关闭/退出、名称及本批交互已完成，不重复实现；原 Rust Runtime 在切换完成前保持业务权威，禁止双写。任务调度、执行器接管和 Kanban 残留迁移仍待继续。
2. 在具备 Windows runner 后补链接与会话重附着实测；macOS 可继续建设 Browser Worker，不让平台专属验证阻止其他模块推进。
3. 根据最新要求，已删除 15 分钟 heartbeat（工具确认 deleted）。改为当前任务中持续实施，继续使用子 Agent 分工；每项功能验证后独立提交并即时更新本记录，不再依赖定时接续。


## 当前连续实施批次

- Go Host 持久存储：SQLite 事务、revision、幂等操作和事件记录；独立数据目录，不与 Runtime 双写。
- 迁移导出/导入：一致性快照、Protobuf 清单、资产及兼容归档核验，先形成可检查的 staging 导入，后续完成写入所有权切换。
- Git 工作流：分支、同步、历史图数据与 worktree 后端并行完善；完成后接入现有工作面板。
- 以上三项当前在实现中，未记为交付完成。运行模式更新不改变原方案范围与验收门槛。


## 连续实施：已完成的基础功能

- `e199fa7`：迁移导出清单及无损 SQLite 值 Protobuf；生成器支持多个 schema，Go/Rust/TS 共享样例通过（Rust 9、TS 12），生成漂移检查通过。
- `d93689c`：Go Host 私有 SQLite 存储、Host 身份绑定、CAS/tombstone、幂等 receipt、同事务事件及 staging 所有权。CGO=0、race/vet 与 Windows/Linux 交叉构建通过，Windows ACL 实机仍待验收；尚不代表业务所有权已切换。
- Git 基础工作流：Branches/History/Worktrees 与原 Changes 共用工作面板，提供具体目标/HEAD 确认、真实操作状态与取消，稳定 OID 历史游标及真实父关系图；worktree 不强删脏内容，新建目录加入 Git 私有 exclude，已有分支需预期 OID。
- Git 后端 17 个真实临时仓库场景及路由作用域/权限验证通过；本机 bare remote 验证 fetch/pull/push，不向用户远端写入。前端组件/契约、类型检查及真实 Chrome 390px/460px 面板检查通过；一次前端全套执行为 992 项通过，后续增量回归也通过。
- 所有 Git 写路径正合并到 common Git directory 队列，旧同步请求在后台线程持有 guard，客户端断开不会提前解锁。应用锁不排除外部 Git/编辑器操作；仍执行状态校验和 Git 自身冲突检查。
- 当前 Git 操作追踪支持抽屉关闭重开，整页重载恢复与完整关停正在接续；完整 M4 尚未完成。迁移与 hunk 的未提交工作仍在独立推进，不归入本次 Git 基础交付。

## 连续实施：一致性迁移导出

- Runtime 新增离线 `export --database FILE --destination NEW_DIRECTORY`，只读连接源库，不启动终端、恢复会话或监听服务；支持 JSON 摘要与 Protobuf 清单输出。
- 复用一致性快照，支持 WAL、内存源及跨目录目标；目标不得存在，清单最后发布。原始数据库完整保留，受管资产逐个核对路径、大小与 SHA-256；缺失资产输出明确问题，不声明迁移完成。
- 12 项导出测试通过，覆盖原始数据、旧版本、未知/损坏 schema、符号链接、资产变化、重复目标与 WAL 快照；独立快照及原备份回归也已通过。真实离线 CLI → Go staging 冒烟验证成功且源会话状态不变。导入端正在独立完成验证与提交。

## 连续实施：Go Host 迁移核验与 staging 导入

- `armadra-host import --bundle DIRECTORY --data-dir DIRECTORY` 在持有 Host 单实例锁时离线导入，支持 Protobuf/JSON 报告；常驻 Host 启动时同步打开自己的私有数据库。
- 校验数据库/资产哈希、账本结构与原始 success 类型、已知 SQL 校验和、完整 schema、实体 ID、画布摘要、备注、外键及路径；拒绝未知 journal companions、符号链接和越界。原始 SQLite 存储类型通过 Protobuf 原样保存，时间文本不被驱动转换。
- 多批导入具有稳定操作 ID、幂等收据、归属和事件记录；故障后重放不重复写入。导入资产留在私有 staging，报告和历史兼容数据可核验；尚未激活任何工作空间或转移业务权威。
- Go Host CGO=0 全套测试通过；真实 fixture 含 300 条日志，覆盖跨批失败恢复、原库字节不变、精确大整数/二进制/时间/NULL、资产缺失及篡改拒绝；迁移包 vet 通过。真实 Rust export → Go import 两次重放冒烟通过。Windows 原生 ACL/文件系统验收仍待独立 runner。

## 连续实施：Git 操作恢复与进程清理

- 后台新增受工作空间 ID、根目录与仓库共同约束的操作列表；新页面可恢复正在执行的任务，面板显示本次 Runtime 生命周期内的历史与取消入口。列表不声称跨 Runtime 重启持久化。
- RepositoryService 统一登记读写命令、外部 AI/片段 runner 及仓库 guard；停止时拒绝新工作、取消并等待受管 child 回收。Runtime 将 Git 与终端清理并行执行，未确认清理明确报错并非零退出。旧 Git/clone runner 增加超时、输出上限和受管取消，克隆取消保留部分目录供用户处理。
- ff-only pull 固定本次获取 OID，合并禁止自动 stash 与覆盖 ignored 文件，常规完成路径按预期 OID 清理自己的临时 ref；取消或停机可能保留诊断 ref，不自动重试未知结果。
- 24 项真实 Git 仓库回归、路由权限/同路径不同工作空间隔离、前端 10 项含新 Query cache 恢复及类型检查通过。真实 child 测试覆盖排队、读取、写入、HTTP 取消、外部 lease、超时和未确认回收；旧 Git/clone 32 项回归已通过。

## 连续实施：设备认证内核

- Host 数据库新增 v2 私有身份表；保持已发布 v1 SQL 原始摘要与既有实体。ticket、session、设备撤销版本独立于普通实体/事件同步，凭据只存 SHA-256 摘要。
- 单 owner 多设备：两分钟一次性配对材料绑定 Host/实例/精确 Origin/设备名及授权范围；access 有效十五分钟、会话绝对三十天，刷新同时轮转 access、refresh 和 CSRF。空授权不扩大为全权限，窄范围不能执行全 Host 操作。
- 每次认证核对持久设备撤销版本；支持 CSRF 恢复、注销、设备分页与撤销 CAS。角色 operator/viewer 仅保留定义，当前不签发多人身份。
- 12 组身份真实 DB 测试与 2 组新增存储测试、race/vet 通过；跨 DB 句柄 16 路 ticket 消费及 12 路 refresh 仅一次成功，故障回滚、重启、期限、范围、无 outbox/明文泄漏均验证。Windows amd64/arm64 CGO=0 交叉编译通过，实机与 WSS 撤销断流未验收。HTTP/CLI 接线另批提交。

## 连续实施：逐片段 Git 操作

- Changes 每个文件提供独立片段视图，支持暂存、取消暂存与带内容确认的还原。服务器从当前 diff 重新构造所选 hunk，核对完整 diff 摘要和 HEAD，不接受客户端提交任意 patch。
- 片段操作与其他 Git 写操作共享队列；HTTP 断开后受管任务持有锁至命令结束，退出取消后确认 child 回收。二进制、新增/删除、模式改变、过滤器等不支持场景明确退回整文件操作。
- 13 项真实仓库测试覆盖两个独立片段、CRLF/空文件/无结尾换行、中文路径、过期数据及越界；实际路由测试通过，验证过期 mutation 返回409、成功应用及读写权限。前端7项、shared2项、类型检查通过。

## 连续实施：AI 提交信息草稿

- 源码控制提供独立 AI 草稿预览与填入按钮，不自动调用模型、不自动提交。源数据仅使用已暂存文本，展示纳入/排除文件、截断与脱敏状态；生成前后及填入前核对 HEAD/index/来源摘要，期间人工编辑不会被迟到结果覆盖。
- 首个适配器为已验证隔离参数的 Claude bare CLI：空工作目录、无工具/MCP/项目设置、无会话持久化、明确单次预算与超时；仅在 CLI 支持且配置 Runtime ANTHROPIC_API_KEY 时可用，不伪装支持订阅凭据或其他端点。
- 生成与辅助命令使用统一生命周期 lease，退出时可取消并确认回收；模型等待期间不占仓库写锁。输出错误不回显私有 stderr，敏感文件/密钥材料不发送。
- 最新11项 fake CLI/真实临时仓库回归、HTTP read/execute权限测试、前端6项与shared2项通过；未调用真实收费模型。真实浏览器面板交互继续独立核验。

## 连续实施：设备认证 Protobuf 与私有引导通道

- 新增身份/会话契约，权限明确带工作空间与执行主机范围，实际 grants 属于会话而非设备列表。浏览器响应只含已认证设备、权限、期限与 CSRF，access/refresh 不在业务载荷中返回。
- OS 私有控制新增 Bootstrap 请求/响应，调用端绑定所观测 Host 与实例；未显式配置签发器则返回 unsupported，错误不暴露凭据或内部详情，未知结果不自动重试。
- Go/Rust/TypeScript 二进制样例覆盖中文设备名、范围绑定及 uint64 最大 revision；Rust10、TS13与Go契约测试通过，生成漂移检查通过。私有通道回归验证错误Host/实例不调用签发器、签发不触发停止及默认拒绝。HTTPS/CLI使用该契约的接线另批提交。

## 连续实施：Stash 工作流

- 源码控制新增 Stash 页签：读取固定 OID 列表、工作区/暂存区/未跟踪快照差异；显式创建、Apply、Pop 与 Drop，创建可选择未跟踪文件，ignored 文件不自动收纳。
- 操作确认绑定 HEAD/分支、index、工作区内容、未跟踪内容和 Stash 列表摘要。Pop 仅在应用成功且列表仍一致时移除；冲突/取消保留记录，ignored 文件或父路径碰撞拒绝应用。
- Git reflog selector 不提供跨外部 Git 进程的原子 CAS；界面明确并发限制，当前应用内共用队列并在写入前重核 OID 和列表，不手工伪造 Git 元数据。
- 29 项真实仓库回归（新增5）、Stash7及仓库面板10项组件、shared6项通过；新增实际路由验证创建→操作轮询→列表→未跟踪快照详情及权限拒绝，类型检查与Clippy通过。

## 连续实施：HTTPS 设备配对与会话接口

- Host 增加显式证书/私钥/public-origin 配置，检查证书主机名与有效期，只在具体接口 IP 上监听；默认 HTTP 保留元数据能力，拒绝浏览器配对与 Cookie 认证。不会自动安装证书或跳过客户端验证。
- 本机 pair CLI 经私有 IPC 取得一次性票据，绑定服务实际 HTTPS 来源；HTTP 与未开放来源拒绝签发。HTTPS Protobuf接口完成Pair/Current/Refresh/RenewCsrf/Logout/设备分页/撤销CAS，Cookie为Secure/HttpOnly/Strict/__Host前缀。
- 独立审查修复回环 Cookie 跨端口泄露边界、access过期不能注销、会话权限与设备权限混淆、metadata allowlist扩大认证来源等问题。过期access仍可通过refresh+CSRF事务注销；协议错误隐藏内部详情与凭据。
- Go Host CGO=0全套与vet通过；身份/服务器race通过。新增真实子进程pair CLI→证书验证HTTPS→安全Cookie恢复链路通过；另有真实HTTPS的期限/撤销/范围/CSRF/双cookie/编码/超限/深group回归。测试证书只加入私有客户端RootCAs，未修改系统信任。
- 使用与限制见[设备认证](./host-device-auth.md)。客户端设置UI正在下一批接入；Host尚未完成业务权威切换、静态前端与Worker接管，不将本批记为完整远程工作平台。

## 连续实施：Git 写入后的面板刷新

- 统一整文件、片段和仓库操作的缓存失效，包含AI暂存来源与片段视图；刷新按钮同步重新读取这些视图。修复首次暂存后AI按钮仍因旧空来源而禁用的问题。
- 新增真实组件回归通过：初始未暂存→暂存首个文件→生成按钮自动可用，无需手动检查来源，且不会自动请求模型。原源码控制页签/快捷键回归同时通过。

## 连续实施：设备管理客户端与设置界面

- Host设置挂载独立设备登录区域：先核对已协商Host与实例，仅HTTPS同源且已报告能力时允许配对；HTTP/不同来源给出准确未配置状态。接入配对JSON/票据、恢复、权限/期限、分页设备列表、撤销确认及注销。
- Protobuf客户端仅在私有内存保留CSRF，轮转请求串行；取消/dispose后忽略旧结果，未知副作用不自动重试。票据提交后清空，不写localStorage或画布。撤销使用项目AlertDialog及默认取消焦点。
- 客户端36、面板12、既有HostPage7、i18n7项与类型检查通过。真实Chrome完整设置窗口及390px检查通过，无横向溢出；Escape保留外层窗口并归还原按钮焦点，配对/撤销/注销各一次，JS storage写入为0。
- 浏览器检查使用隔离二进制fixture；真实证书链和CLI→HTTPS由上一批Go测试覆盖，两者不混报为同一次浏览器网络验收。独立Vite与Chrome已清理；结果位于output/playwright/identity-result.json。静态前端托管与原生认证代理仍在后续服务接管范围。
