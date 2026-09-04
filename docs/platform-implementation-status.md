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
| M1    | 进行中   | 身份、单实例、HostClient、显式来源许可与连接设置页已完成；自动服务管理、认证和业务迁移未完成       |
| M2–M7 | 待实施   | 后台调度及其他产品工作流仍按各阶段交付                                                             |
| M8    | 预留范围 | 多人、多账号及发布更新只按设计交付前期契约                                                         |

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

## 执行器 PoC 结果（M0）

- 独立临时 Chrome profile，Chrome `152.0.7977.76` / CDP `1.3`，macOS arm64。
- 实际完成 headless 启动、HTTP 导航、1000×700 viewport、点击、英文/中文/emoji 文本注入、表单/Canvas 截图、400 px 滚轮、screencast 帧及 ACK；探针退出后 CDP 端口关闭。
- 这是 CDP 接口实证，未验证操作系统 IME composition、tldraw 裁剪缩放、交互延迟预算或 Windows/Linux 浏览器运行；生产 Rust Browser Worker 尚未实现。
- Windows `windows-sys 0.61.2` ConPTY API 及 `portable-pty 0.9.0` 最小程序的离线 target 检查通过；链接失败为缺少 `link.exe`，无 Windows 可执行工件及运行证据。
- Windows 下一步需要独立 Session Host、无头 VT 和 IPC；现有 Unix `ps` 前台检测与 direct detach 销毁行为不能直接复用为持久化方案。光标继承查询必须处理或禁用。

## 下一步

1. M1 下一批：建设 Host 后台服务的启动/状态/停止管理、认证接入与业务存储迁移准备；原 Rust Runtime 在切换完成前保持业务权威，禁止双写。连接设置页及其客户端、持久身份和来源许可已完成，不重复实现；当前检查按钮不承担启动或切换服务的语义。
2. 在具备 Windows runner 后补链接与会话重附着实测；macOS 可继续建设 Browser Worker，不让平台专属验证阻止其他模块推进。
3. 后续继续使用子 Agent 分工，每个功能验证后独立提交。自动检查维持 15 分钟，全部当前范围完成前保持启用。
