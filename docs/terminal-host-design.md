# 终端持久化、Windows 宿主与桌面生命周期设计

> 状态：目标设计，待实施。
> 本文扩展并更新 [Windows 会话守护进程早期设计](./windows-session-daemon.md) 的目标；其中“本轮不实现 Windows”的旧范围不再适用于本轮。

## 1. 必须区分的四种生命周期

| 对象         | 生命周期             | 关闭后的含义                                       |
| ------------ | -------------------- | -------------------------------------------------- |
| 画布节点     | 用户布局             | 移除展示；会话是否停止是单独决定                   |
| 前端终端视图 | DOM/xterm/WebGL      | 附着/分离；不终止会话                              |
| Host/Worker  | 服务及控制           | 重启后重认领会话、订阅和收据                       |
| SessionRun   | tmux/ConPTY/实际进程 | 终止后不可“重附着为活进程”；只能新 generation 恢复 |

后端统一 TerminalBackend 契约：Create、List、Attach、Detach、Input、Paste、Resize、Capture、Signal、Terminate、GetForeground、GetCapabilities。能力按后端返回，不能要求 Windows 伪造 tmux pane 状态。

目标后端：Unix 默认 tmux；Windows 默认独立 Session Host + ConPTY；direct PTY 为显式降级选项。SSH 项目由远端 Worker 选择该主机后端，本机不伪造远端进程树。

## 2. Windows 方案评估

| 方案                               | 可用性                               | 决定                               |
| ---------------------------------- | ------------------------------------ | ---------------------------------- |
| Worker 直接拥有 ConPTY             | 实现简单，但 Worker 退出影响所有会话 | 仅 direct 降级，不满足持久化主目标 |
| 要求用户安装 Unix 兼容层/tmux      | 增加系统依赖和 CLI 兼容链            | 不作为默认前提                     |
| 独立 Rust Session Host 拥有 ConPTY | 生命周期独立，可共享终端执行逻辑     | 本轮目标方案                       |
| Go Host 同时管理 ConPTY            | 将业务服务与终端生命周期重新绑定     | 不采用                             |

独立可执行文件 `armadra-session-host.exe`，每个 Windows 用户一个活动协议主版本实例，通过命名管道服务 Worker；不依赖 Node.js 或 Tauri UI 存活。只在相同用户上下文运行，默认不以管理员权限运行。

ConPTY 的创建、双向流和子进程必须由宿主维护；输入/输出分开处理，退出时继续排空输出以避免阻塞。依据 [Microsoft 创建伪控制台说明](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)。

## 3. Windows 进程与句柄所有权

1. Worker 查找命名管道并 Hello；无宿主时通过每用户互斥锁协调启动，避免同时打开两份服务。
2. Session Host 使用 Windows CreateProcessW 与明确的 argv 编码创建 Shell/CLI，建立 ConPTY 并持有 HPCON；环境以独立块传入，工作目录是执行主机的真实路径。
3. ConPTY 输入、输出、控制分别使用独立循环/线程；阻塞 Win32 I/O 不占 Tokio 异步线程。输出始终被读取，与 UI 是否附着无关。
4. 进程树 Job Object 由 Session Host 持有，绝不能由会退出的 Tauri/Worker 持有；不能让 Worker 的临时 job 在退出时杀掉持久宿主。宿主异常死亡时策略是回收其子进程，避免不可控孤儿，UI 诚实报告运行丢失。
5. 会话结束按“CLI 友好退出 → 有界等待 → 终止进程树 → 关闭 ConPTY → 排空/关闭管道”处理。不要把直接关闭 HPCON 当 detach。

关闭 ConPTY 会结束附着的控制台进程，因此只有显式终止会话才走该路径；依据 [ClosePseudoConsole 文档](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)。

Windows 下 Ctrl+C 作为终端输入/后端中断能力处理；Ctrl+Break、进程树终止另设操作。不套用 Unix kill(-pgid) 语义。PowerShell、cmd、Git Bash、原生 CLI 与 WSL 分别测试；WSL 会话在能力探测后走对应执行环境，不能混用 Linux 路径和 Win32 路径。

## 4. 命名管道与会话协议

命名管道名包含用户 SID hash 和协议 major；ACL 仅允许该用户及必要系统主体，服务身份额外验证客户端。默认拒绝远程 pipe 客户端；本机密钥保存在该用户受限目录中。worker epoch 与 generation 一起用于 fencing。

协议采用 [Host 文档](./host-protocol-design.md) 的长度前缀 Protobuf，命令包含 requestId、sessionId、generation 和幂等键。握手返回 hostInstanceId、protocolRange、capabilities、maxFrame、sessions；ping 不延长任何用户授权。

Session Host 维护执行收据和存活目录，收据至少区分 received / not-written / write-started / write-completed / unknown。同一 inputId 不允许不同 payload。常规键盘输入不落明文持久日志，只留有界去重摘要及序号；自动化投递需额外记录授权和结果边界。

调用者断线不停止会话。宿主只在无会话、无活跃控制操作且 idle timeout 到期后退出；版本升级时旧实例 drain，新会话走新主版本实例，旧会话保留到用户允许结束。

## 5. 无头 VT 屏幕与恢复

ConPTY 输出不是可随意裁剪的普通日志。Session Host 内维护无头 VT 状态：主/备用屏、光标与可见性、颜色/样式、滚动区域、宽字符/组合字符、换行模式、必要的终端模式和有界 scrollback。

M0 比较现有 Rust VT 解析/屏幕库的能力与维护状态，确定并锁定实现；不手写只认识几条 ANSI 的解析器。验收 corpus 包含 xterm 查询、alternate screen、鼠标模式、bracketed paste、emoji、中文宽字符和复杂 CLI TUI。

屏幕快照流程：

1. 在单一 session 状态锁下标记输出序号 S 并获取快照。
2. 注册附着者，缓存 S 后增量；发送 snapshot(epoch, S, size, screen, modes)。
3. 客户端完成渲染 ACK 后按序应用 S+1 起增量。
4. 缓冲超限则丢弃该附着者未发数据并重新生成快照，不能从任意字节边界截断 ANSI。

服务侧必须决定哪些终端查询由无头仿真器答复，不能让多个前端重复回复。剪贴板 OSC52 等交互需前端授权并绑定当前设备，不因后台捕获就写入用户剪贴板。

屏幕检查点只能用于历史查看或新进程恢复前的展示；机器重启后不能把检查点当活进程。冷恢复显示“上次会话记录”，创建新的 generation，并按适配器 resume 能力启动；失败保留历史，不伪装继续运行。

## 6. 多端附着与输入权

多设备可同时读取同一终端，写入默认单租约。焦点设备主动获取/接管，移动端旁观不会改变终端尺寸。人工输入和自动化共享同一个目标写入门；粘贴+提交期间不能插入另一个写者字节。

尺寸由写入租约持有者决定，无写者时保留最后尺寸；只读客户端按比例/滚动显示，不以最小屏幕不断缩小所有设备的 TUI。resize 有去抖和有效最小/最大值，focus 切换才请求尺寸所有权。

断线自动释放设备写入租约，有界 grace 防止短闪断频繁抢权；重新连接必须核对 generation 和当前所有者。过期终端输入不离线重放。终端 raw bytes 与业务事件分流，慢客户端只影响自己的画面。

## 7. 后台渲染与会话休眠

### 7.1 视图策略：不影响执行

| 视图状态            | 渲染与传输                      | 进程                              |
| ------------------- | ------------------------------- | --------------------------------- |
| focused             | 全速渲染，当前尺寸持有者        | 持续运行                          |
| visible-unfocused   | 限帧刷新，保留必要输入焦点判断  | 持续运行                          |
| offscreen/collapsed | 停 WebGL/高频 DOM，保留状态订阅 | 持续运行                          |
| detached            | 不保留重型前端终端实例          | 持续运行，执行端保留 VT/tmux 状态 |
| disconnected        | 缓存最后画面并标记离线          | 按实际宿主状态，不推断已结束      |

xterm 实例用有界 LRU；WebGL context 设设备预算（初始 4 个，可按测量调整），优先焦点实例，回收只释放渲染资源。不能因 `display:none` 仍让几十个终端每帧 fit 和重绘。

重新可见时：申请附着 → 收快照和 generation → 恢复尺寸 → 连续增量 → 开输入。用户唤醒节点的首个输入可短时保存在本设备内存，只有确认同一 generation 且租约有效时送出；超时/换代后丢弃并提示，不能送到新启动的无关 CLI。

### 7.2 会话休眠：明确改变执行

休眠与降低渲染分开。首版默认只回收视图，不自动结束 CLI。可选 Eco 模式仅对支持 resume 的 Agent，在成功空闲、无审批、无投递、无原生循环、无计划即将运行、无浏览器控制依赖时采用“保存恢复信息后友好退出 CLI”。

状态机 running → idle → hibernate-requested → hibernated → resuming → running/failed。收到确认退出前不能标记 hibernated。启动恢复使用 providerSessionId、模型、账号和工作目录快照；保留新 generation，恢复失败可手动处理。

普通 Shell 中运行的任意进程、无法确认状态的 Agent、带后台子进程的任务默认不自动休眠。Unix SIGSTOP/Windows suspend 不作为通用省内存策略，因为暂停进程不等于释放内存，也可能阻塞外部锁。

计划目标为 hibernated 时，仅在计划 coldStartPolicy 明确允许且凭据可用时恢复；未启用则记录 skipped/target-unavailable。页面隐藏不触发上述策略。

## 8. 主机与会话资源面板

底部 `ResourcePill` 展示当前执行主机内存概览，点击右侧 `ResourcePanel`。多执行主机时顶部筛选，始终显示测量来源；不能用控制电脑内存代表 SSH 主机。

| 数据     | 字段                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| Host     | total/available/used memory、swap、pressure（支持时）、CPU、uptime、sampledAt                |
| Session  | sessionId、generation、PID/startTime、进程树 RSS/CPU、childCount、cwd、Agent、worktree、状态 |
| 平台组件 | Host/Worker/Session Host/Browser Worker 自身占用，独立于用户 CLI                             |
| 孤立会话 | 未关联画布或项目的持久会话，可认领、查看、明确终止                                           |

RSS 树汇总标记为估计，多个进程共享页可能重复计算，不称为精确独占内存；按 PID + startTime 去重避免 PID 复用。macOS/Linux/Windows 使用各平台有效指标并标出可用性；不可测返回 unknown，不显示 0 B。pressure 与 usedPercent 分开，不以“已用比例高”自动判断系统内存压力。

建议采样：面板打开时每 2 秒，关闭时每 15 秒；远端合并为一轮读取、无逐 PID SSH。CPU 用连续采样差值，首次样本不显示假 0。面板支持按内存/CPU 排序、定位节点、查看进程树、友好停止与终止；不自动杀最高占用会话。

资源预算：终端屏幕/scrollback、Worker 收据/日志、浏览器进程、前端 LRU 分开配置。日志和转录有保留期与容量上限，清理前排除活跃会话及未完成交接引用。

### 8.1 实现状态（T02，M7）

已交付：`apps/runtime/src/resources/` 用锁定版本的 `sysinfo` 采集本机总览（CPU、内存、swap、负载、数据目录所在磁盘、uptime）与每个受管终端会话的进程树 CPU / RSS / 子进程数 / 状态；电源来源在 macOS 读 `pmset -g batt`、Linux 读 `/sys/class/power_supply`，其它平台 unknown。采样是订阅制：`POST …/resources/subscription` 拿带 TTL 的订阅，样本经既有工作空间事件流以 `resource.sample` 推送，最后一份订阅过期后采样循环自行停止；间隔取 `resources.intervalMs`（默认 2s，Runtime 侧夹在 500ms–60s）。所有指标是 `Option`，测不出来发 `null`，前端显示短横线。CPU 靠连续刷新求差，一次性 `GET` 会先垫一次基线再采，所以首屏和刚启动的进程都不会出现假 0。

孤立会话按两类列出：有行无节点（可认领）与有 tmux 会话无行（只能终止）。认领由 Runtime 把行绑回并回传应使用的 `nodeId`——即会话自己的 key，前端用它建节点，恢复出来的节点拥有的仍是原进程。

未实现：多执行主机筛选与远端一轮读取、内存 pressure。SSH 会话标为 `remote`、指标 unknown，不用控制机数据冒充远端。

### 8.2 实现状态（§4.3 补齐，M7）

平台组件在 `apps/runtime/src/resources/platform.rs`，与用户会话分开成一组：Runtime 是本进程，Go Host 是祖先或同一父进程下的兄弟进程，命令 Worker 是二者之中任一个用本可执行文件启动的子进程。发现只按相对本进程的位置，不扫描全机同名进程，所以另一份安装、另一个用户的 Armadra 都不会被认领；从 shell 直接起的 Runtime 就是没有 Host，如实报告而不猜一个。Runtime 那一行只算自己——它的子进程正是用户会话，加进来等于把 Agent 数两遍；命令 Worker 算整棵树，`tree` 字段写明是哪一种。Session Host 与 Browser Worker 尚不存在，因此没有对应行。

每个被测进程带 `startTime`，会话行与组件行都按 `(pid, startTime)` 去重，PID 复用不会把两个进程并成一个。会话额外回占用最高的至多 32 个子进程供面板展开，`childCount` 仍是真实总数——空列表配非零计数表示「没列出来」，不是「没有」。进程只有可执行文件名、pid 和两个数字，不含命令行。

采样节奏由订阅方提出：`POST …/resources/subscription` 接受 `intervalMs`，夹在 `[resources.intervalMs, 60s]`，采样循环按所有存活订阅里最快的一档跑。离屏（折叠、滚出视口或窗口在后台）的终端节点徽标要 30 秒，面板或任何一个可见徽标把大家拉回设置里的那档；订阅回执同时给自己的续约间隔与当前生效间隔。

终端节点头部内存徽标见 `apps/web/src/panels/resources/MemoryBadge.tsx`：显示进程树 RSS 之和（标为估计），测不出来显示 `unknown` 而非 0，超过阈值（`armadra.resources.sessionMemoryWarnBytes`，默认 2 GiB，设置 → 终端可改）变色并按 `sessionId:generation` 提醒一次。提醒只是提醒：不终止、不休眠、不压缩，面板同样只高亮不自动处置。

跨端契约在 `proto/armadra/v1/resources.proto`（`SessionMetrics`、`HostMetrics`、`PlatformComponentMetrics`、Read / Subscribe），三语言契约测试与共享样例已就位；Runtime 与 Web 之间当前仍走既有 camelCase JSON 与工作空间事件流，Worker 协议尚未接线。

## 9. Agent 工作时防休眠

PowerService 在实际执行主机管理租约：reason、session/runId、expiresAt、lastHeartbeat、policy。Agent working、活跃自动化运行、重要下载/提交等可按用户偏好申请系统空闲睡眠抑制；完成/失败/取消后释放。

只阻止系统空闲睡眠，不持续点亮屏幕，不承诺阻止用户手动睡眠、关盖或断电。原生 API 适配由 Worker 完成，桌面窗口是否打开不影响租约。

失联租约有 TTL，Worker 恢复时重查进程和活动状态；Host 崩溃不能永久留下防休眠。长时间 blocked 默认在宽限后释放，用户可选择保持；“等待明天的计划”不默认保持整晚唤醒，可单独启用“激活计划期间保持唤醒”。

设置显示生效的执行主机、原因、结束条件和手动停止入口。电池/低电量策略可覆盖自动申请；覆盖后计划页明确显示宿主可能休眠。手机 Screen Wake Lock 仅是前端体验，与执行主机 PowerService 无关。

### 9.1 实现状态（T02，M7）

已交付：`apps/runtime/src/resources/power.rs` 的租约表带 reason、source、可选 sessionId、TTL（默认 300s，夹在 10s–6h）与续期；`GET /api/power`、`POST /api/power/leases`、`…/renew`、`DELETE …`。策略 `power.policy` 有从不 / 有活跃 Agent 会话时 / 有自动化运行时 / 手动四档，默认「手动」；被策略或平台挡下的租约仍然列出，只是 `active: false` 并带 `blockedBy`。释放最后一份有效租约、租约过期（后台每秒检查）或 Runtime 退出时立即解除。

平台机制：macOS 用 `caffeinate -i -w <runtime pid>` 子进程而非进程内 IOKit 断言——`-w` 让 Runtime 被 SIGKILL 时断言随之消失，且断言在 `pmset -g assertions` 里以可见进程出现，用户能自己查和结束；Linux 用 `systemd-inhibit --what=idle --mode=block`，缺失时报 unavailable；Windows 用独立线程上的 `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)`，仅交叉编译验证过，未在真实 Windows 上跑过。

只阻止系统空闲睡眠；不常亮屏幕，不拦合盖与手动睡眠。未实现：电池 / 低电量策略覆盖、按活跃 Agent 会话与自动化运行自动申请（协议已就绪，调用方未接入）、计划期间保持唤醒的单独开关。

## 10. 快捷键配置

在现有命令注册表基础上增加 device/local overrides、profile、scope 和 when 条件。命令面板、菜单、提示、设置从同一来源生成。

- 系统按 macOS/Windows/Linux 自动填充默认键位；新命令只补没有用户设置的项。
- 支持录制、手工输入组合键、清空绑定、多组替代键、单项/分组重置、导入/导出。
- 配置层次：平台默认 → 用户同步配置 → 设备覆盖；OS 全局热键仅设备本地启用。
- 冲突检查考虑 app/canvas/terminal/editor/browser scope、输入框和 IME composition；不能只比字符串。
- 原生系统占用、浏览器保留快捷键及不支持的全局注册返回明确原因；不能显示已保存就假装注册成功。
- 默认保留终端/编辑器的基本控制键，只截获明确声明的应用动作；移动端提供等价工具条入口。

“手填快捷键”只绑定已注册命令，不把任意输入解释成 Shell 命令。如果后续支持用户脚本命令，应成为独立执行配置并遵守 Worker 授权。

## 11. 更新与 GitHub 发布预留

区分应用二进制更新与用户仓库 Git 同步：UpdatesService 管理 Armadra 发布，GitPanel 管理项目代码。

预留 stable/beta channel、ReleaseDescriptor、UpdateJob、签名、OS/arch、版本、下载 URL、hash、minimumProtocol、databaseCompatibility、componentVersions。将来可使用 GitHub Releases 承载工件，Host 适配发布源，不把仓库地址写死进各客户端。

桌面 Tauri updater 需要签名工件及验证配置，参考 [Tauri Updater 官方文档](https://v2.tauri.app/plugin/updater/)。GitHub 下载地址不是可信签名的替代。当前阶段交付 schema、能力位和设置结构，自动下载/安装保持 disabled，不能显示假的“已是最新版”。

更新顺序：检查协议/数据库兼容 → 下载并验证 → 暂停新操作 → 等待可中断任务边界 → 更新 Host/Worker/UI → 健康检查 → 恢复派发。Session Host 独立 drain，旧会话不能因为 UI 更新被强杀。数据库不兼容时要求维护窗口，不能在运行中自动破坏式迁移。

远程服务器更新单独操作，不因客户端检查更新自动 SSH 安装。多版本客户端的能力协商详见服务端设计。更新失败回滚二进制的前提是数据格式仍兼容；否则保留备份并进入恢复流程。

## 12. 测试与分阶段验收

### 12.1 Windows 最小阶段（M2）

- 建会话 → 终端输出 → 关闭 UI → 重开附着；分别重启 Worker/Go Host，PID 和屏幕确认连续。
- PowerShell、cmd、原生 Agent、UTF-8/中文/emoji、Ctrl+C、bracketed paste 和 resize。
- Host 独立启动与每用户 ACL；两个 Worker 并发发现只产生一个宿主。
- 断开最后附着者不结束会话；显式 terminate 才关闭 ConPTY。

### 12.2 加固阶段（M7）

- 快照/输出交界没有丢字或重复；两设备不同尺寸下不会连续 resize 抖动。
- 输入和输出管道压力、最终输出排空、ConPTY 关闭不死锁。
- 宿主异常退出、注销、重启显示真实丢失与冷恢复；不把屏幕缓存当存活进程。
- 系统实际支持的 Windows 版本分别实机验证；平台最低版本由 API 能力与打包基线确定，不只依赖编译成功。

### 12.3 资源与体验

- 固定测试场景为 1/10/30 个终端、2 个浏览器节点，记录硬件、系统、屏幕分辨率、CLI 输出速率和内存/CPU。
- 折叠/离屏后前端 CPU 明显下降，执行端连续输出和 Hook 不丢；恢复输入不重复。
- 多主机资源归属、未知指标、进程退出/PID 复用、面板开关采样策略均正确。
- 防休眠只对活跃租约生效，完成/超时/崩溃释放；锁屏和关盖限制有真实平台验证记录。
- 快捷键手填/录制冲突、导入覆盖、设备差异、终端 IME 与浏览器保留键通过。

本设计不预报节省百分比。性能验收先建立可复现基线，优化结果连同负载记录写入实施报告。
