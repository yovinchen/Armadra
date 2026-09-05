# Windows 持久终端：会话守护进程设计

> 状态：**只是设计，Phase 4 不实现**。日期：2026-09-04。归属：desktop-packaging。
> 上游契约：[v3-agent-terminal-plan.md §15](./v3-agent-terminal-plan.md)（终端后端选择树、`TerminalBackend` trait、WS 协议、回收策略）。
> 本文只描述 Windows 侧第三种后端 `SessionDaemonBackend` 的形状；macOS / Linux 继续走 tmux，无 tmux 时走 direct，两者都不受影响。

## 1. 为什么 Windows 需要一个独立进程

§15.1 的选择树在 Windows 上只剩两条不理想的路：

- **tmux (MSYS2)**：默认关。MSYS 的 pty 兼容层与原生 Win32 CLI（claude / codex / gemini 的 Node 与 Rust 二进制）之间要经过一次额外的字符与信号翻译，鼠标追踪、括号粘贴、窗口尺寸事件都会掉；而且它要求用户先装 MSYS2。
- **DirectPtyBackend**：ConPTY 的伪控制台句柄归创建它的进程所有。Runtime 一退出（更新、崩溃、用户退出桌面壳），伪控制台连同里面的 CLI 一起没。这正是 §2 表格里"Runtime 重启即丢"的那一行。

所以持久终端在 Windows 上只有一个办法：**把 ConPTY 的所有权从 Runtime 挪到一个活得比 Runtime 长的小进程里**。这个进程就是 `aicc-session-host.exe`，它在 Windows 上扮演 tmux server 的角色。

### 目标

1. Runtime / 桌面壳重启后，终端节点能重新 attach，屏幕内容完整。
2. attach 的第一帧是**当前屏幕快照**，而不是回放拼接——和 tmux client 重绘的观感一致。
3. 一个会话可以被多个 socket 同时看（画布上打开、看板里预览），任何一个慢下来都不能把 CLI 的输出卡住。
4. 不引入第三方运行时（不装 MSYS2、不装 tmux、不需要 curl）。

### 非目标

- 跨机器 / 跨用户共享会话（远程 Runtime 已在 §17「暂缓」里）。
- 复刻 tmux 的窗口、pane、复制模式。守护进程只管**一个会话一块屏**。
- 在 Unix 上替换 tmux。`SessionDaemonBackend` 只在 `cfg(windows)` 下注册。

## 2. 进程模型

```text
桌面壳 (Tauri)
  └─ ai-coding-canvas-runtime.exe        ← 可以随时重启
       └─ 命名管道 client（每会话一条 attach 流）
             ↕  \\.\pipe\aicc-session-<user-hash>
aicc-session-host.exe                    ← 独立进程，DETACHED_PROCESS 启动
  ├─ 会话 A：ConPTY + Job Object + 无头 VT 屏 + 订阅者表
  ├─ 会话 B：…
  └─ 状态文件 + token 文件（0700 等价 ACL）
```

- **一个用户一个 host**。管道名里带用户 SID 的哈希，多用户会话（RDP、快速用户切换）各自一个 host，互相看不见。
- **启动**：Runtime 起来时先读状态文件、试连管道；连不上就用 `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW` 起一个，再退避重试连接（50 ms 起，最多 3 s）。host 与 Runtime 是同一个安装目录里的兄弟二进制，路径解析方式和 `aicc-hook` 一样（`current_exe().parent()`）。
- **并发启动**：host 启动的第一件事是拿一个命名互斥体 `Global\aicc-session-host-<user-hash>`；抢不到就说明已经有一个在跑，直接退出。两个 Runtime 同时冷启动不会开出两个 host。
- **空闲退出**：没有任何会话、且最后一次会话结束已过 `idleExitMinutes`（默认 30）时 host 自行退出。只要还有会话活着就永不退出，哪怕没有任何 client attach。
- **升级**：host 的协议版本写在 hello 里。Runtime 发现 host 版本低于自己要求的最小版本时，发 `shutdown {drain: true}`——host 停止接受新会话，等现有会话全部结束后退出，Runtime 期间继续用旧 host 服务旧会话，新会话开在新 host 上（新管道名带版本后缀）。

## 3. 状态文件

`%LOCALAPPDATA%\aicc\session-host\state.json`，host 独占写，Runtime 只读：

```json
{
  "version": 1,
  "pid": 4312,
  "pipe": "\\\\.\\pipe\\aicc-session-a1b2c3d4-v1",
  "startedAt": "2026-09-04T09:00:00Z",
  "sessions": [
    {
      "sessionKey": "node-7f3a…",
      "generation": 3,
      "workspaceId": "ws-01…",
      "cwd": "C:\\src\\demo",
      "cols": 120,
      "rows": 34,
      "pid": 9182,
      "startedAt": "2026-09-04T09:01:12Z",
      "lastOutputAt": "2026-09-04T09:14:03Z",
      "exited": false
    }
  ]
}
```

写入用"写临时文件 + `MoveFileEx(REPLACE_EXISTING)`"保证原子性，每次会话表变化后节流 1 s 写一次。**状态文件不是真相**——真相在 host 的内存里，文件只是给 Runtime 冷启动时对账用的（对应 §15.2 的 `list-sessions` 对账）：文件里有、`list_alive` 里没有的会话记 `exited`；`list_alive` 里有、数据库没有的记孤儿进回收。

同目录下 `token`（32 字节随机，`CryptGenRandom`，文件 ACL 只给当前用户）是管道的认证凭据，见 §4.2。

## 4. 命名管道协议

### 4.1 传输

`\\.\pipe\aicc-session-<user-hash>-v<major>`，`PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE`，双向，实例数 = 无限。管道的安全描述符只授予创建者 SID 与 SYSTEM（`FILE_ALL_ACCESS`），拒绝 `NULL` DACL——否则同机任意进程都能连上并读走 Agent 的终端内容。

一条管道连接 = 一个 socket = 一个订阅者。控制请求和 attach 流走**同一条连接**：Runtime 为每个 attach 开一条专属连接，另外保留一条常驻的控制连接。

### 4.2 握手

```text
C → S  hello   {protocol: 1, client: "runtime/0.1.0", token: "<base64 32B>"}
S → C  welcome {protocol: 1, host: "0.1.0", pid: 4312, sessions: [<会话摘要>]}
```

token 逐字节常量时间比较，不匹配则回 `error {code: "unauthorized"}` 后立刻断开，并按 IP 无关的全局计数做 5 次/分钟的失败限流。握手必须在连接后 2 s 内完成，否则 host 主动断开（防挂死连接占实例）。

### 4.3 请求 / 响应（JSON，UTF-8，每消息一帧）

| 请求 | 语义 | 对应 trait 方法 |
| --- | --- | --- |
| `create {sessionKey, generation, cwd, shell, command, args, env, cols, rows}` | 新建 ConPTY 会话 | `create` |
| `attach {sessionKey, generation, cols, rows}` | 把**本连接**变成输出流订阅者 | `attach` |
| `write {sessionKey, data(base64)}` | 写入 PTY | `write` |
| `resize {sessionKey, cols, rows}` | `ResizePseudoConsole` | `resize` |
| `capture {sessionKey, lines, escapes}` | 从无头 VT 屏取文本 | `capture` |
| `paste {sessionKey, text, enter}` | 括号粘贴序列 + 可选 `\r` | `paste` |
| `foreground {sessionKey}` | 前台进程信息 | `foreground` |
| `signal {sessionKey, kind: "interrupt"｜"process"}` | Ctrl+C / 结束进程树 | `interrupt` / `terminate_process` |
| `destroy {sessionKey}` | 结束会话并删表项 | `destroy` |
| `list {}` | 活跃会话表 | `list_alive` |
| `flow {sessionKey, action: "pause"｜"resume"}` | 本连接的背压控制 | 见 §6 |

响应一律 `ok {id, ...}` / `error {id, code, message}`，`id` 由请求方生成、单调递增。

事件（无请求对应，host 主动推）：

- `exit {sessionKey, generation, exitCode}` —— 进程退出。
- `stale {sessionKey, generation}` —— attach 的 generation 已过期，对应 WS 的 `stale` 帧。
- `warning {sessionKey, message}` —— 例如输出溢出导致丢弃。
- `bye {reason}` —— host 即将退出（drain / 空闲）。

### 4.4 输出帧（二进制）

输出不走 JSON（base64 会让 60 fps 的 TUI 重绘多花 33% 带宽和一次额外拷贝）。attach 之后，本连接上的消息按第一个字节区分：`0x7B`（`{`）= JSON，`0xA1` = 输出帧。

```text
偏移  长度  含义
0     1     0xA1  魔数
1     1     帧类型：1=output 2=snapshot 3=snapshot-end
2     2     保留（0）
4     8     generation (u64 LE)
12    8     sequence   (u64 LE，每会话单调递增，从 1 开始)
20    4     payload 长度 (u32 LE，≤ 256 KiB)
24    N     原始字节，不做任何转义
```

`sequence` 让 Runtime 能判断"我这条连接有没有漏帧"：收到的 sequence 不连续即说明 host 因为背压丢过数据，Runtime 把这一次 attach 降级成"重取快照"（重新发 `attach`），而不是把一段错位的输出写进 xterm。`generation` 与 §15.2 一致：不等于当前 generation 的帧一律丢弃。

## 5. 无头 VT 屏幕

每个会话在 host 里挂一份 `vt100::Parser`（列数 × 行数 + `scrollback_len` 行回滚，默认 5000，对应设置项 `tmux.scrollbackLines` 在 Windows 上的等价物）。ConPTY 的所有输出先喂给它，再广播给订阅者。

它解决三件事：

1. **attach 快照**：新连接 attach 时，host 先用 `Screen::state_formatted()` 生成一串"把终端恢复到当前状态"的转义序列，拆成若干 `snapshot` 帧发出去，最后一帧类型 `snapshot-end`；之后才开始转发实时 `output`。前端因此不需要 §15.5 里 direct 后端那套"回放拼接"，行为与 tmux client 重绘一致——`TerminalSurface` 那边一行不用改。
2. **`capture`**：`capture` 直接读屏，`escapes=false` 时取纯文本，`true` 时取带属性的重建序列。Agent 读终端（§5）用前者。
3. **resize 语义**：`ResizePseudoConsole` 之后同步 `Parser::set_size`，多个订阅者尺寸不一致时以**最近一次活动的连接**为准（对应 tmux 的 `window-size latest`）。

代价是每会话常驻 `cols × (rows + scrollback) × cell` 的内存，120×5034 大约 3 MB；host 对总量设上限（默认 24 个会话），超了就把最久未 attach 的会话的 scrollback 砍到 1000 行。

## 6. 背压与暂停所有者

ConPTY 读线程是唯一的生产者，订阅者是多个消费者。每个订阅者一个有界队列（默认 512 帧 / 8 MiB，先到者为准）：

- 队列水位到 75% → host 给该连接发 `warning`，并把该连接标记为 **slow**。
- 队列满 → host 代表这个连接向会话申请**暂停**：把该连接的 id 加进会话的 `pause_owners` 集合。集合非空时，读线程停止从 ConPTY 读（ConPTY 内部缓冲区满后会自然背压到 CLI 侧，和 tmux 的行为一致）。
- 队列降到 25% → 从 `pause_owners` 移除自己；集合空了读线程才恢复。
- 连接断开 → 无条件从 `pause_owners` 移除。**这是关键的一条**：暂停的所有权必须跟着连接的生命周期走，否则一个崩掉的前端会把 CLI 永久卡死。
- 客户端也可以主动 `flow {action: "pause"}`（前端节点折叠但还没到 detach 宽限期时用），语义与队列满完全一样，走同一个集合。

`pause_owners` 用集合而不是计数器，就是为了让"同一个连接重复 pause"幂等，断开时一次性清干净。

### generation 屏障

`recycle`（§15.5）在 host 里的实现：`create` 一个新 generation 的会话 → 把旧会话标记为 `superseded` → 给所有订阅旧 generation 的连接发 `stale` → 旧会话进入 `destroy` 流程。屏障保证**旧 generation 的输出帧永远不会在新 generation 的 `snapshot` 之后到达**：host 在发 `stale` 的同时就把旧会话的广播通道关掉，队列里剩下的帧直接丢弃。

## 7. `TerminalBackend` 映射

`SessionDaemonBackend`（`apps/runtime/src/terminal/session_daemon.rs`，`#[cfg(windows)]`）实现 §15.4 的 trait，`BackendKind` 新增 `SessionDaemon`（`GET /api/terminals/backend` 报 `"session-daemon"`）。

| 动作 | 实现 |
| --- | --- |
| create | 保证 host 在跑 → `create` 请求 → 返回 `TerminalHandle { backend_ref: Some("<sessionKey>#<generation>"), pid }` |
| attach | 新开一条管道连接 → `hello` → `attach` → 把 snapshot/output 帧转成 `broadcast::Sender<Bytes>`；`DetachGuard` 关闭这条连接（**detach，不结束会话**） |
| write / resize / paste / capture / foreground | 走常驻控制连接的同名请求 |
| interrupt | `signal {kind: "interrupt"}`；host 侧 `GenerateConsoleCtrlEvent(CTRL_C_EVENT, <会话进程组>)`，失败则回退到向 PTY 写 `\x03` |
| terminate_process | `signal {kind: "process"}`；host 侧关闭会话的 Job Object（`TerminateJobObject`），整棵进程树一起走 |
| destroy | `destroy` 请求；host `ClosePseudoConsole` + 关 Job + 删表项 |
| list_alive | `list` 请求；host 不在时读状态文件返回空表并触发对账 |
| destroy_by_reference | 用 `backend_ref` 里的 sessionKey 调 `destroy`（孤儿回收） |
| detach_all | 关掉所有 attach 连接与控制连接，**不动 host** |

`BackendSelector` 在 Windows 上的顺序变成：设置强制 `direct` → direct；设置强制 `tmux` 且探测到 tmux → tmux；否则 → `SessionDaemon`（host 起不来时降级 direct 并发一条通知条，与 §15.6 的 tmux 缺失处理同形）。

回收（§15.6）不变，只是 `destroy` 的落点从 `kill-session` 变成 `destroy` 请求；host 的空闲退出是回收之外的第二道保险。

## 8. Windows 上做不到 / 必须换做法的

| tmux 做法 | Windows | 替代 |
| --- | --- | --- |
| `load-buffer` + `paste-buffer -p` | ConPTY 没有 paste buffer 的概念，也没有"由服务端代打"的通道 | host 直接向 PTY 写 `ESC[200~` + 清洗后的正文 + `ESC[201~`（复用 `backend.rs` 里的 `PASTE_START` / `PASTE_END` / `sanitize_paste`），需要回车时再写 `\r`。**差别是真实的**：目标 CLI 没开括号粘贴时，多行文本会被逐行当成回车提交；host 因此对超过 1 行且未探测到括号粘贴模式的 paste 回 `warning`，前端提示"目标程序不支持粘贴块" |
| `send-keys C-c` | 没有 SIGINT | `GenerateConsoleCtrlEvent`；进程不在同一控制台进程组时回退写 `\x03` |
| SIGTERM → 2 s → SIGKILL | 没有 SIGTERM | Job Object 直接 `TerminateJobObject`（等价 SIGKILL）。想给 CLI 一个体面的收尾窗口，只能先写 `\x03` 等 2 s 再终止 Job |
| `#{pane_current_command}` + `ps --ppid` | 没有 `/proc` | `CreateToolhelp32Snapshot` 遍历进程表按 `th32ParentProcessID` 建树；命令行用 `NtQueryInformationProcess` + 读 PEB（同用户进程可读）。拿不到时 `ForegroundInfo.children` 留空，不阻塞调用方 |
| tmux 自带 `exit-empty` / `exit-unattached` | —— | host 的空闲退出计时器（§2） |
| tmux socket 文件权限 0700 | 文件权限模型不同 | 管道安全描述符 + token 文件 ACL（§4.1、§4.2） |
| 会话在 Runtime 崩溃后仍被 tmux server 持有 | 同理 | host 持有；但 **host 自己崩溃 = 会话全丢**，没有第二层。缓解只能是 host 保持极小的代码面（无 HTTP、无数据库、无插件） |

另外两条已知限制，写进设置页的说明文案：

1. **Windows 上的 attach 快照是"重建"而不是"重绘"**。`vt100` 的状态重建覆盖不了 sixel / iTerm 图片协议这类带外内容，Runtime 对这类会话在 attach 后额外向 CLI 发一次 `Ctrl+L`（可在设置里关）。
2. **ConPTY 会主动重排输出**（它自己就是个 VT 转换层），所以逐字节比对"CLI 写了什么"和"我们收到了什么"在 Windows 上不成立；hook 状态（§5）因此仍然由 `aicc-hook` 上报，绝不从终端输出里解析。

## 9. 测试矩阵

| 场景 | 期望 |
| --- | --- |
| Runtime 重启 | 节点重新 attach，屏幕内容与重启前一致，CLI 未收到任何信号 |
| 桌面壳退出后重开 | 同上；host 全程存活 |
| host 版本升级（drain） | 旧会话继续可用，新会话开在新 host，旧 host 在最后一个会话结束后退出 |
| 两个 Runtime 冷启动竞争 | 只有一个 host（互斥体），另一个连上现有 host |
| 同一会话两个 socket | 两边都看到输出；关掉其中一个不影响另一个 |
| 慢消费者 | 慢的那条连接收到 `warning`，快的那条不掉帧；慢连接断开后 CLI 立即恢复输出（`pause_owners` 清空） |
| 慢消费者进程被强杀 | 同上，且 5 s 内恢复（管道断开检测） |
| recycle | 旧连接收到 `stale`，新 attach 拿到新 generation 的快照，旧帧不混入 |
| 输出洪水（`type bigfile`） | 无 OOM，sequence 断裂时前端重取快照而不是渲染错位内容 |
| Ctrl+C | claude / codex 的 TUI 收到中断并回到提示符 |
| terminate_process | 进程树（node → 子进程）全部消失，会话仍在，可重新跑 |
| destroy | 会话消失，状态文件更新，`list` 不再返回 |
| 空闲退出 | 最后一个会话结束 30 min 后 host 自行退出，状态文件清空 |
| token 不匹配 | 连接被拒，限流生效，日志里有一条 `unauthorized` |
| 非当前用户连接管道 | `ERROR_ACCESS_DENIED` |
| 多行粘贴到不支持括号粘贴的程序 | 前端出现"目标程序不支持粘贴块"提示 |
| 中文 / emoji / 组合字宽度 | 快照与实时输出的光标位置一致（`vt100` 与 xterm 的宽度表对齐） |

## 10. 实施顺序（未排期）

1. `aicc-session-host` crate（ConPTY + Job Object + `vt100` + 管道服务端），单元测试跑在 host 进程内，不经 Runtime。
2. `SessionDaemonBackend` + `BackendKind::SessionDaemon` + 选择树分支 + 设置项文案。
3. 打包：host 作为第三个 sidecar 进 `prepare-sidecar.mjs` 与 `bundle.externalBin`（macOS / Linux 构建时跳过）。
4. 上表的测试矩阵，其中"Runtime 重启""慢消费者""recycle"三条进 CI（Windows runner）。
