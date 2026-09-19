# nodeterm 的终端与会话连续性（只读分析）

> 参考项目 `/Users/yovinchen/Projects/Rust/Tauri/nodeterm`（Electron + React + React Flow）。行号基于 2026-09-19 工作树，全部只读摘录。

## 结论

nodeterm 的会话连续性不是一个功能，而是一条被严格守住的所有权链：**跑 CLI 的进程必须属于一个比 UI 活得久的进程**。Unix 上是私有 socket 上的 tmux server，Windows 上是自写的 `session-host` 常驻进程，两者之上是同一个 `TerminalTransport` 接口。这条链决定其余一切：关窗、切项目、离屏、内存压力、Eco 休眠都只能"丢客户端"，不能"丢会话"；而每一处丢客户端的杠杆都必须先问"下面真的是 tmux 吗"——在无 tmux 的降级路径上同一个调用会连 agent CLI 一起杀掉（issue #126）。

Armadra 的 Rust Runtime 已经把同一套结论实现了一遍：私有 tmux server、`armadra-<ws>-<key>-<gen>` 命名、generation 栅栏、`paste-buffer -p`、Windows `armadra-session-host` crate、10 分钟回收扫描。所以迁 Electron 不是"要不要上 tmux"（已经上了），而是**终端域留在 Rust 还是搬到 Electron main**。第 6 节推荐：**留在 Rust Runtime**；向 nodeterm 借的是渲染侧预算/回收策略、tmux 踩坑清单和测试隔离机制，不是它的 node-pty 主机模型。第 6.4 节另有一处可直接落地的 Armadra 缺陷（idle 判据用错时钟）。

---

## 1. CLAUDE.md 四章提炼

覆盖 `CLAUDE.md` §162（TerminalTransport）、§418（tmux 连续性）、§783（节点生命周期）、§3217（测试不碰活 tmux）。

### 1.1 TerminalTransport（`CLAUDE.md:162-169`）

渲染器只依赖 `src/renderer/terminal/transport.ts` 的接口，"never on IPC or node-pty directly"。当前实现 `LocalTransport`（IPC → node-pty），未来 `RemoteTransport`（WebSocket 到远端 agent）实现同一接口，于是远程访问可以在不碰画布与终端 UI 的前提下加上。规则：**加会话特性时扩接口，不要绕过**。`CLAUDE.md:3302` 提到 iOS 客户端（SwiftUI + SwiftTerm/Citadel）说同一套协议——这个抽象已经收回成本。

### 1.2 tmux 连续性

启动 `tmux new-session -A -D -s nt-<nodeId>`，socket `-L node-terminal`，配置 `-f <userData>/tmux.conf`（状态栏关、**mouse on**、50k history、`set-clipboard on` + `terminal-features ",*:clipboard"`、copy-mode 鼠标绑定）；SSH 项目用 `shared/ssh.ts` 的 `remoteTmuxConf`。server 活过 app，无 client 时会话照活（`:418-426`）。

**禁令一：不要把滚动从 tmux 手里拿走**（`:448-454`）。旧设计用 `mouse off` + `terminal-overrides ',*:smcup@:rmcup@:indn@'` 把 tmux 留在普通屏幕、输出流进 xterm scrollback、reattach 时 `capture-pane` 水化：

> "**tmux is a screen PAINTER, not a stream.** Every redraw (attach, resize, refresh) erases and repaints, so blank and duplicated rows leaked into the emulator's scrollback — users saw black bands and duplicated screens."

**禁令二：复制走 OSC 52**（`:456-466`，tmux 3.4 实测）。`terminal-overrides ',xterm*:Ms=…'` 在 3.2+ 上**一个 OSC 52 都不发**，`terminal-features` 才是开关；copy-mode 绑定是裸 `copy-pipe-and-cancel`，不接 `pbcopy`（macOS 专属，且经 SSH 会复制到远端）。

**client 计数是数字不是布尔**（`:468-479`）。一个 session 可同时挂 app 的 painter、用户自己的 attach、另一台 nodeterm、我们的 control-mode shadow。reaper 要减掉自己的影子；塌成布尔就只能强行置 false，于是会把别人 client 下的 session 回收掉。**任何未来读 `list-clients`/`session_attached` 的人欠同一次减法。**

生命周期（`:481-593`）：

| 事件 | 行为 | 会话 |
|---|---|---|
| 离屏释放（默认 10 min）| 就地销毁 xterm + PTY client，节点仍挂载显示占位板；靠近时重附着重绘，实测 <500 ms | 存活（进 reaper 候选池，6h grace）|
| 节点卸载（切项目）| 渲染层 **park**：xterm 与 PTY 都留着，`.xterm` 脱离 DOM，5 min 内重挂直接认领 | 存活 |
| 关窗 / 退出 | `killAll()` 只 detach，**刻意不 kill session** | 存活 |
| 重开 / 重启 app | 新 PTY 附回同名会话，tmux 重绘 | 存活 |
| 点 × | `destroy(persistKey)` → `kill-session` | 销毁 |

park 有硬约束：**不要"优化"成 respawn+redraw**——tmux client 从未 detach，鼠标追踪/备用屏模式与 scrollback 都还在；新 xterm 复用旧 client 会漏掉 attach 时的模式序列，滚动就坏了（`:508-514`）。

**每个内存杠杆都必须问"这一刀会不会杀掉活儿"**（`:488-507`）。渲染层四处回收终端内存（park 过期、park LRU、内存压力 drop，均在 `park-budget.ts`；离屏释放在 `offscreen-policy.ts`）都按"丢 PTY client 是免费的"写——**这句话只在真有 tmux 时成立**。纯 shell 下 pty 就是 shell，同一调用会连 agent CLI 一起杀。issue #126：一次项目切换终止了工作中的 Claude，它随后从被杀处自动 resume。判据 `terminal/live-work.ts` 取最窄集合：tmux-backed 会话从不保护（代价只是重绘），普通终端、已完成 agent、未知状态也不保护。第五个杠杆（armed 节点的离屏释放）后来补同样的门：held launch 按 session **名字**投递，有 tmux 时释放无害，纯 shell 时会毁掉要投递进去的 pane。实测：被释放的 QUEUED 节点在依赖变 `done` 时仍扣着 launch，徽标说"终端还没启动"，只有相机移过去才触发——"我一看它就工作了"说的就是这个。

**冷恢复**（`:671-693`）。tmux 只跨 **app** 重启存活，机器重启杀掉 server。`create()` 在 spawn 前跑 `has-session`，返回 `PtyCreateResult.fresh`。冷启动时渲染层重建：① `scrollback-store.ts` 的 **256 KB 封顶**快照回放（带 "session restored" 分隔线）；② 对 `RESUMABLE_AGENTS` 重发 `resumeCommand`（`claude --resume` / `codex resume`），一次性 `initialCommand` 在首开时优先，避免双启动。

**播种规则**（`:753-781`）：`none`（park 或新节点，播了会重复）/ `cold-snapshot`（回放快照）/ `warm-attach`（**什么都不播**）。`warm-history` 的 `capture-pane` 水化已删除，正是它造成黑带和重复屏幕。唯一例外是 co-attach 加入者：tmux 只在 SIGWINCH 重绘，服务端在 `create()` 里抓的 `PtyCreateResult.screen` 是唯一能把屏幕画出来的东西；加入者还收不到鼠标追踪模式（`?1000h/?1002h/?1006h` 只在 tmux 自己 attach 时发，`capture-pane` 不带私有模式），故 `join()` 置 `coAttachMouse`、渲染层补写 `CO_ATTACH_MOUSE_SEQ`——这就是"看板卡片里的终端不按键滚不动"。

**先问模拟器，再问 tmux**（`:695-751`）。曾用 tmux 的 `#{bracket_paste_flag}` 判括号粘贴——该格式首发于 **tmux 3.7（2026-06-26）**，而 Ubuntu 24.04=3.4、22.04=3.2a、Debian 12/13=3.3a/3.5a，在这些上一律展开成 `''`，比较对每个 pane 都是 false；SSH 项目更无法从我们这边修。规则：**pane 里的 app 在干什么**（VT 模式、备用屏、光标形状）是字节里已有的，问 `term.modes`；**会话本身**（存不存在、前台进程组、有哪些 pane）才问 tmux。最终解法比问题还老：`paste-buffer -p`（tmux 1.7 起），让 tmux 按 pane 真实状态决定加不加框。

### 1.3 节点生命周期的坑（`TerminalNode.tsx`）

- xterm + PTY 在 `useEffect(…, [respawnNonce, offscreenEpoch])` 创建一次；React Flow 按 `id` 做 key，**永不改节点 id**（`:787-789`）。
- **刻意不用 React StrictMode**：双挂载会给每个节点开两个 PTY（`:805-806`）。
- 离屏 "released" 态两条不可破的规则（`:794-804`）：(1) 可见性 `IntersectionObserver` 必须活在自己那个 **mount-stable `[termKey]`** effect 里——向下跃迁会重跑生命周期 effect，挂那儿的 observer 会跟着死，revive 永远到不了（永久占位板）；(2) 远程排除问 `offscreenCoreIsRemote(session.source)` 而非 `data.remote`——后者**没有任何代码赋值**，基于它的门恒为 false 且类型上看不出来。
- xterm 容器 `nodrag nowheel` + 透明 hover-guard，悬停 600 ms 后才交出输入（快拖=移节点，滚轮=平移）。
- `ResizeObserver` 驱动 `fit()` + `resize`；**画布缩放是 CSS transform，不改 `clientWidth`**，cols/rows 跨缩放稳定；`scale-fix.ts` 修 xterm 鼠标坐标使缩放后选择对齐（`:810-812`）。

### 1.4 测试套件永不碰活的 tmux server（`:3217-3259`）

这个仓库在 nodeterm 里开发，`-L node-terminal` / `-L nodeterm-rmt` 不是 fixture 名，而是开发者所有打开终端所在的 server。故障形态不是红用例，而是**每个 pane 打印 `[server exited unexpectedly]`**（issue #629）。三条腿：

1. **结构腿**：每次 vitest run 一个私有 `TMUX_TMPDIR`。tmux 把 `-L <s>` 解析成 `$TMUX_TMPDIR/tmux-<uid>/<s>`，改这一个变量一次性重定向**所有** socket 名，包括没人想到的套件。`tmux-sandbox.ts`（globalSetup）建/清/删目录；`tmux-worker-env.ts`（setupFiles）在每个 worker 重新断言，缺了就**拒绝运行**——vitest 的 env 继承是实现细节，静默回退等于把测试放回活 server。`enterSandbox` 还剥 `TMUX`/`TMUX_PANE`（生产同理）。
2. **行为腿**：真在真实 socket 名上起 server，证明 socket 文件落在沙箱里——断言环境变量只证明我们设了个变量，解析规则是 tmux 的属性。
3. **扫描腿**（最弱）：让"第三个白名单条目"成为要签字的决定。两个既有白名单带理由写在 `tmux-socket-isolation.guard.test.ts`。

**沙箱不解决什么**：同名 socket 的两个套件仍共享一台 server。CI 实测：guard 自己对 `node-terminal` 的 `kill-server` 在断言中途结束了 `host-destroy-tmux.test.ts` 的会话。所以套件要么按精确目标 `-t =<name>` 杀（否则落到前缀匹配），要么独占一个没人用的 socket 名。诚实声明：#629 的 server 死亡**未**归因到测试，证据指向 tmux 自己的 `server_accept()` 在内存紧张机器上 `fatal()`——这移除的是隐患，不是已证实的原因。

---

## 2. PTY 管理层

### 2.1 spawn 与分支

`pty-manager.ts`（4934 行）是所有活 PTY 的所有者兼 IPC 桥。四条分支按序：**远程 ssh tmux** → **本地 tmux**（`tmuxPath && tmuxEnabled && persistKey`）→ **session-host** → **纯 shell**（无持久化）。

```ts
// src/core/pty-manager.ts:3032-3048（节选）
const attachFlags = tmuxAttachFlags(!!sinks)
args = ['-L', TMUX_SOCKET, '-f', this.confPath, 'new-session',
  ...attachFlags, ...hookEnvArgs, ...pathEnvArgs, ...langEnvArgs,
  ...colortermEnvArgs, ...accountEnvArgs,
  '-c', cwd, '-s', sessionName(options.persistKey)]
```

`tmuxAttachFlags(detached)`（`:687-699`）：本地 renderer client 用 `['-A','-D']`，relay 服务的 detached pty 只能用 `['-A']`——加 `-D` 会踢掉 host 自己的本地 client，曾让每个 host 窗口显示 `[detached]`。于是"app 对每个 session 永远只有一个 client"，tmux 的多 client 尺寸协商从不参与，"最小订阅者赢"由 `pty-size.ts` 自己决定。

**spawn 预检**在调用 node-pty 之前就拒绝（`:2595-2611`）：`if (ptyDevicesExhausted(readPtyDevices())) throw this.spawnFailureError('not attempted', …)`。动机（`:2550-2559`）：node-pty 的 darwin spawn 在 `posix_spawn` 失败时**泄漏它开的 pty**，实测每次失败泄 2 个 `/dev/ptmx` fd + 1 个 `/dev/ttys*`（= 2 个设备）；一个跑了 31 分钟的主进程握着 479 个 master 对着 28 个 pane。结果："40 one-shot creates used to cost 80 devices, and now cost none."

### 2.2 resize

`pty-size.ts`（35 行）：co-attach 下 pty 跑所有订阅者的**最小 cols × 最小 rows**——列数比 pty 少的会折行毁屏，多的只是留黑边。单订阅者时 min 就是它自己，与 co-attach 前逐字节一致。`Math.floor` 后 `Math.max(1, …)`：node-pty 的 0 维会抛，HiDPI fit 会给小数。

```ts
// src/core/pty-manager.ts:3396-3419（节选）
const size = effectiveSize(session.sizes.values())
if (!size) return                       // 全 park：保持原尺寸，别糟蹋 parked xterm
if (session.appliedSize?.cols !== size.cols || session.appliedSize?.rows !== size.rows) {
  session.appliedSize = size
  try { session.proc.resize(size.cols, size.rows) } catch { /* proc 已退出 */ }
}
```

`resize` 入口刻意用 `== null` 松比较（`:3648-3657`）：尺寸丢失必须退化成 park（删这一票），不能退化成 1×1。输出批处理 `FLUSH_MS = 8`、`MAX_BUF_BYTES = 256 KB`。

### 2.3 三层回收

| 层 | 文件 | 判据与常量 |
|---|---|---|
| 空闲 pty 回收 | `pty-reap.ts` | `REAP_IDLE_MS = 10 min`、扫描 60 s；**只收 tmux-backed 且无人看**，**永不 kill session** |
| detached 会话预算 | `session-budget.ts` | `GRACE_HOURS=6`、`REAP_BATCH=8`、`MIN_AVAILABLE_MB=max(1024, 10%)`、`SWAP_FREE_PCT=20`、`PSI_FULL_AVG60=10`、扫描 10 min |
| 进程内存压力 | `memory-pressure.ts` | host 可用 <10%/<5%，self RSS `4096/8192 MB`；间隔 30 s，重触发地板 60 s |

```ts
// src/core/pty-reap.ts:61-64
export function shouldReap(c: ReapCandidate, now: number, idleMs = REAP_IDLE_MS): boolean {
  if (!c.tmuxBacked || c.watched || c.unwatchedSince === null) return false
  return now - c.unwatchedSince >= idleMs
}
```

为什么 10 分钟（`pty-reap.ts:34-39`）：比 5 分钟 park 窗口 "comfortably longer"，且刻意留余量 "so that the two mechanisms cannot come to depend on each other's timing"；十分钟没人看远超任何"我马上回来"——回收代价是一次重绘，不回收代价是永久占一个 pty 设备。

`session-budget.ts` 最重要的是**两个时钟的实测**（`:64-77`，2026-08-15，私有 socket）：tmux 每次有 **client attach** 都把 `session_activity` 顶到 `now`，与 pane 输出无关（control-mode attach 和 pty attach 各顶一次，`#{window_activity}` 纹丝不动；`capture-pane`/`list-panes`/`list-sessions`/`display-message`/`has-session`/`resize-window` 都不动）。67 个会话里最旧的 `session_activity` 是 **33 分钟**，最旧的 `window_activity` 是 **37 小时**；一个会话在前者读 469 s，后者读 133 513 s。**idle 判据只能用 `#{window_activity}`。** `NOMINAL_SESSION_MB = 491` 也是实测：62.7 GB 机上 67 个活会话共 32 877 MB 树 RSS。现场报告：一台主机 **95 个会话 / 34 GB 的空闲 claude 进程**。诚实声明（`CLAUDE.md:2306`）：reaper 只吃超 grace 的 **detached** 会话，那台机器 60 个会话里 50 个 attached，合格 kill list 是**空的**——该功能加的是可见性，不是策略。

`pty-release.ts:9-13`：node-pty 的 `kill()` 只发 SIGHUP，master fd 要等 socket EOF 才关，而 xterm 流控会 `pause()` 忙 pty，于是每次 detach 泄一个 `/dev/ptmx` fd，直到所有 spawn 报 `posix_spawnp failed.`。修法：`resume()` → 优先 `destroy()` → 回退 `kill()`。

### 2.4 pty 设备限流（macOS 硬墙）

`pty-devices.ts:8-13` 记录 2026-08-11 事故：macOS 以 `kern.tty.ptmx_max`（默认 **511**）全系统封顶，当时 62 个 app PTY + 18 个 tmux 会话 + ~19 个 ssh 子进程 = **515** 个 `/dev/ttys*`，此后每次 spawn 报光秃秃的 `posix_spawnp failed.`——和跨架构 spawn-helper 是同一句，旧错误信息把排查引向了根本没问题的架构。

- `PTY_DEVICE_HEADROOM = 4`：既是快照余量也是预检抢先带（511 的机器上 507 就拒），因为 tmux-backed spawn 要两个设备。
- `pty-pressure.ts`：`ELEVATED_RATIO = 0.8`（≈409）、检测 60 s、重播报 300 s；`critical` **复用** `ptyDevicesExhausted` 而非第二套阈值——横幅变红的线必须和 spawn 报"没设备了"的线完全一致。测不到就是 `none`（"猜测只能退化成沉默"）。
- `spawn-resources.ts`：失败时量 `/dev/fd` 条目数、`RLIMIT_NOFILE`/`RLIMIT_NPROC`（`NEAR_LIMIT = 16`），全路径 fail-open——node-pty 把 errno 丢了，"EMFILE vs EAGAIN vs ENOENT"这个唯一能立刻回答的信息永远到不了我们手里。
- `src/main/ptmx-limit.ts`：一次特权操作同时 `sysctl -w` 抬上限**并**装 LaunchDaemon 持久化；`PTMX_MIN_TARGET = 2048`、`ptmxTarget(c)=max(2048, c*2)`；只由显式点击触发，命令由纯函数构造并被测试钉死。

### 2.5 node-pty 的两个补丁

`scripts/patch-node-pty.mjs`（603 行）在 `postinstall`/`rebuild` 里、electron-rebuild **之前**跑，对 node-pty **1.1.0** 打版本钉死的原生补丁，幂等，锚点缺失即非零退出。

- **darwin**（`src/unix/pty.cc`，upstream node-pty#950）：失败 spawn 漏 master+slave；成功 spawn 因 low-fd 清理循环 off-by-one 漏 1 个设备——`for (; count > 0; count--) close(low_fds[count]);` 停在 0，`low_fds[0]` 永不关闭。现场速率：**~16 次成功 spawn/分**（park/离屏/reap + 重附着的正常churn）× 每次 1 个设备，几小时内撞上 511。
- **Windows**（`src/win/conpty.cc`）：原生 exit 线程删 `pty_baton` 时不关它拥有的 HPCON，于是 session-host 的 taskkill-first kill 路径**每杀一个会话留一个 host-parented conhost**，活到 session-host 进程结束，而 `conpty.kill(id)` 什么都不报。补丁串行化 baton 访问、删 baton 前关精确 HPCON、让 `kill(id)` 只在有实证时返回 `true`。`CLAUDE.md:78-82` 警告：**不要把 `closeExactWindowsConpty` 接进普通 kill 路径**——taskkill 后 exit 线程通常赢竞态并已自己关掉 HPCON，此时该原语会报 `false`；它只服务于"首个输出之前的拆除"。

`node-pty-patch.test.ts` 只断言源码里两个 marker 和具体片段在（`:50, :59`），刻意不测 fd/句柄数（环境相关）。"**If that test is red, your `node_modules` is unpatched, not your code.**"

### 2.6 粘贴与大输入

`paste-injection.ts`：`sanitizePasteText` 一行删掉所有 ESC（`\x1b` 与 C1），防止 payload 提前关掉 paste 帧、后续字节被当按键（在 herdr 多路复用器里承载 Claude Code 时观察到，#47）。文件尾是 `bracketedInjection` 的墓碑：tmux 3.7 起 paste buffer 过 `vis(3)`，ESC 被改写成可打印的 `^[`，JS 侧自己加的框**肉眼可见地毁掉**（issue #453，实测于 bundled 的 3.7b：pane 收到字面的 `^[[200~ … ^[[201~`，消息卡在输入框没提交）；而关 vis 的 `-S` 标志本身也是 3.7 新增，不可能是老服务器的解法。现行规则：**永不把 ESC 放进 paste buffer**，由 `paste-buffer -p` 自己加框，Enter 是同一命令列表里独立的 `send-keys`。

另两条 ARG_MAX 实测（`tmux-naming.ts:109-111`）：`set-buffer -- "$text"` 300 KB 直接 "Argument list too long"（单参数上限 `MAX_ARG_STRLEN` 128 KB），同样 300 KB 经 `load-buffer -` 的 stdin 完整落地并正确加框。

后台写入（实现在 `pty-manager.ts:1322/1382/1426/3608`，测试 `pty-background-write.test.ts`）三级回退：**painter pty → 该节点已有的 shadow → 整个 server 共用一个控制 client**（懒启动，`BACKGROUND_WRITE_LINGER_MS = 10 s` 后释放）。10 s 的排序论证：远短于 5 min park、10 min 离屏销毁、10 min 空闲回收。

---

## 3. tmux 集成

### 3.1 control mode vs 普通 attach

边界是**谁画屏**。可见终端永远是 node-pty 跑的真 attach client（painter）；control mode 只用于没有 painter 的后台会话，因为它**不占 pty 设备**：

> "The point of the whole exercise is the pty device it does NOT hold — `tmux -C attach-session` streams a session's bytes and accepts `send-keys` while allocating zero pty devices."（`tmux-control-client.ts:1-7`）

必须是 `-C` 而**非** `-CC`，有源码级 + 实测双重依据（`plans/2026-08-11-tmux-control-mode-shadow-clients.md:28`）："verified in tmux source (`client.c`: `-CC` calls `tcgetattr(STDIN)` and exits on failure) and empirically (tmux 3.6a: `-CC` over a fifo dies `tcgetattr failed`; `-C` over the same fifo streams cleanly, holds **0 ptys**)."

第三类是一次性 CLI 调用：`display-message -p`、`capture-pane -p -e`、`has-session`、`load-buffer`/`paste-buffer`。

control mode 解码有硬约束（`tmux-control.ts:8-13`）：必须喂 **latin1** 解码的 chunk。tmux 只转义 `< 0x20` 的字节和反斜杠，`>= 0x80` 原样过通道，对传输层做 UTF-8 解码会静默毁掉它们（跨 chunk 切开的 `ç` 变 U+FFFD 且不可恢复）。

### 3.2 shadow client

shadow = 给"painter 已释放"的节点挂一个 `tmux -C attach-session`，0 个 pty 设备，让后台功能够到没人看的会话，而不必重开终端（那要一个 pty 设备、一个 client、一个 ssh 子进程和一次用户没要的全量重绘，`:1085-1090`）。

> "WHAT A SHADOW IS NOT: not a subscriber, not a `Session`, not a renderer client id. Nothing in this process that decides 'is somebody watching' can see it … It IS a real tmux client, so anything that asks TMUX 'is this session attached' does see it, and must subtract it."（`:1105-1113`）

进程内它对 reap/park/offscreen 隐形；对 tmux 它是真 client，故 session budget 经 `shadowedTmuxSessions(socket)` 减掉（`:1199-1221`）。

**一个 session 绝不同时有 painter 和 shadow**，换出在 spawn 之前、同一同步函数内（`:2595-2600`）：painter 用 `-D` 本来也会踢掉 shadow，但要等 tmux 处理完两次 attach，中间有"我们自己的两个 client 争一个 pane"的窗口；先礼貌 `dispose()`（发 `detach-client`）意味着任何时刻恰好一个 client。

`SHADOW_CMD_TIMEOUT_MS = 5000`（`:759-771`）：control mode **按到达顺序**配对回复，一个永不到达的回复不只卡住一个调用方，而是让**之后每个回复都配错命令，永久性地**——所以超时必须销毁而非重试。

### 3.3 重启后重新附着

靠**名字**找回：`pty:create` 先探 `has-session -t nt-<nodeId>` 得 `fresh`，然后仍走 `new-session -A`（attach-or-create）。关键在错误分类（`:2392-2404`）：

```ts
// tmux 的 exit 1（无 session / 无 server，即重启场景）才是"不存在"；
// spawn 失败（批量加载时的 EAGAIN）不是，按不存在做冷恢复会把内容打进一个活会话里。
return !probeSaysAbsent(e)
```

温附着特有的坑是 **cwd 失效**（#464）：`new-session -A` 可能附回一个 shell 蹲在已删除 inode 上的会话。`pane-cwd.ts` 的实测差异：Linux（3.4）读 `/proc/<pid>/cwd`，未链接目录内核报 `<path> (deleted)`，**即使同名目录已重建**仍如此；macOS 走 `proc_pidinfo(PROC_PIDVNODEPATHINFO)`，对未链接目录 vnode 给不出路径，tmux 答 NULL、format 展开成空串（这一条标注为从 tmux 源码推断、未设备实测）。判定只产生可关闭横幅 + 显式用户动作，**不自动杀任何东西**。

Windows 的 `warmWindowsBackend === 'tmux'` 分支用 **attach-only**（`attach-session -t`，`:2985-2994`），因为那条路径刻意跳过可信 profile 解析，不能让它冷建 shell。

### 3.4 命名与 socket 隔离

```ts
// src/core/tmux-naming.ts:6-26（节选）
export const TMUX_SOCKET = 'node-terminal'
/** Per-node tmux session name. Must stay stable — it is the persistence key. */
export function sessionName(persistKey: string): string {
  return `nt-${persistKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}
export function isSessionName(target: string): boolean { return /^nt-[A-Za-z0-9_-]+$/.test(target) }
```

`isSessionName` 不是洁癖：control-mode 命令是一整行文本，`encodeSendKeysHex` 把 target **不加引号**插进去，带空格会拆错参数，带换行会**执行第二条命令**。远程 SSH 项目用另一个 socket `nodeterm-rmt`，故 `nt-<node>` 只在 socket 内唯一。

测试 socket 两个约束（`tmux-test-socket.ts:5-16`）：必须私有（实测一台开发机在该模块出现前积了 **14 个陈旧 `nt-envtest-*` socket**），且必须**短**——`SUN_PATH_MAX = 103`（macOS `sun_path[104]`、Linux 107 取小），`local-send-keys.realtmux.test.ts` 路径长到 106，每个用例挂在 `File name too long`，兄弟文件 97 通过，"六个字符之差"。

### 3.5 bundled tmux

`scripts/build-tmux.mjs` 构建**静态 universal** tmux 到 `resources/bin/tmux`，electron-builder 只在 macOS 段 `extraResources` 进 `<app>/Contents/Resources/bin/tmux`。版本钉死带 sha256：**tmux 3.7b**、libevent 2.1.13、utf8proc 2.11.3；静态链接 libevent/utf8proc（不依赖可能不存在的 Homebrew dylib），ncurses 取自 macOS 自身，`lipo` 合并双架构，**刻意零 npm 依赖**。

查找顺序 **固定路径 → 登录 shell PATH → bundled（最后）**（`findTmux`，`:344-379`）。bundled 排最后的理由（`:328-333`）：client 要连的是活过 app、由**用户装的那个 tmux** 启动的 server，优先用我们的二进制会把新 client 配给旧 server，upstream 直接拒绝（"server version is too old"）。`resourcesPath` 在 Server Edition 上是 `undefined`，那里按构造够不到 bundled。`findTmux` 本身也由测量驱动（`:321-326`）：旧实现是**同步**登录 shell `command -v tmux`，sourcing profile（nvm/conda）**100–800 ms**，还被 tmux-missing 横幅的安装轮询每 3 秒触发一次，每次冻住所有窗口和 IPC。`pty-bundled-tmux.test.ts` 钉死五条（系统优先、PATH 次之、无 tmux 用 bundled、packaged mac 下横幅不可达、dev 认 repo 根产物）。

`ensureTmux()` 写完 conf 还要对**已在跑的 server** 执行 `source-file`（server 只在启动时读 `-f`）；conf 里有两条 MIGRATION 复位 `set -su terminal-overrides` / `set -su terminal-features`——长寿 server 的这两个数组只增不减，残留的 `smcup@` 会让滚动永远坏掉（`:294-306, 1546-1564`）。

### 3.6 依赖 tmux 能力的四个小模块

| 模块 | 依赖的 tmux 能力 | 用途 |
|---|---|---|
| `pane-cwd.ts` | `#{pane_current_path}`（1.7+）| 温附着后"目录被删/重建"横幅（#464）|
| `pane-process.ts` | `#{pane_pid}` + `#{pane_current_command}` + `ps -o tpgid=` | 只终止前台 agent；pane PID 是登录 shell/进程组组长，**杀它等于毁掉 shell，一律拒绝** |
| `pane-cursor.ts` | `#{cursor_x} #{cursor_y} #{cursor_flag}` | 补 `capture-pane` 丢失的光标位置（2026-08-05 报告：刷新 agent CLI 后光标块停在状态行末尾直到第一次按键）|
| `scrollback-store.ts` | `capture-pane -p -e` | 只服务**冷启动**；`MAX_BYTES = 256 KB`，15 s 定时 + detach 补一次，全 async（同步写会卡住主事件循环，进而拖停 PTY 流和所有 IPC）|

---

## 4. 无 tmux 的平台：`src/session-host/`

**形态**：普通 Node 进程，`ELECTRON_RUN_AS_NODE=1` + `process.execPath` detached 拉起，argv 只有 `userDataDir`（`session-host-launcher.ts:53-64`）。

> "This is the Windows-and-anywhere-tmux-is-missing analogue of a tmux server. … Everything the host needs is DERIVED from userDataDir alone; nothing else is ever passed on argv, so nothing sensitive ever appears in this process's command line."（`host.ts:1-13`）

endpoint 按平台分叉（`paths.ts:36-47`）：Windows 命名管道 `\\.\pipe\nodeterm-session-host-<fp>`，POSIX unix socket 放 `os.tmpdir()`（AF_UNIX 路径 ~104–108 字节上限）。目录职责：`host.ts`（入口/锁/分派/kill）、`session.ts`（单会话 + 屏幕 + launch 账本）、`protocol.ts`、`generation-barrier.ts`、`state-file.ts`、`existing-host-state.ts`、`hello-probe.ts`、`socket-flow.ts`、`socket-request-queue.ts`、`kill-session.ts`、`terminal-emulator.ts`、`process-tree.ts`、`windows-process-tree.ts`、`windows-conpty.ts`。

**协议**：NDJSON，共享有状态 framer，单行硬上限 `MAX_FRAME_BYTES = 64 MB`——framer 跑在 `hello` 鉴权**之前**，无界缓冲就是 pre-auth 内存耗尽 DoS（`protocol.ts:203-216`）；畸形单行**丢弃而非抛出**（一个坏帧不能卡死后续帧）。请求集 `hello/attach/attachExisting/hasSession/write/resize/pause/resume/sendKeys/paneCommand/capture/executeLaunch/killSession/detach/listSessions/ping`；push 事件只有 `data`、`exit` 两种、不带 id。`PROTOCOL_VERSION = 2` 写进状态文件，client 在 hello 前强校验。`attachExisting` 是"与存在性检查原子的热附着"，**不带 spawn 计划**，缺席即报错——永不用过期 profile 重建会话。鉴权是 256-bit hex bearer token，0600 落盘，`crypto.timingSafeEqual` 常数时间比较。

**generation barrier**：线协议按**会话名**标识 data/exit 帧，名字复用时旧代未发完的收尾帧与新代不可分。

```ts
// src/session-host/generation-barrier.ts:26-42（节选）
/** Waiting rather than deleting is the protocol-compatible generation boundary: a socket may receive
 *  the old exit before its attach response, but never after it has attached to a new same-name PTY. */
for (;;) {
  const current = sessions.get(name)
  if (!current || (!current.exited && !current.retiring)) return current
  if (!current.ending) throw new Error(`exited session ${name} has no retirement barrier`)
  await current.ending
}
```

只 `await ending` 不够——两个等待者会同时看到空 Map 并重复 spawn，故 `SessionGenerationCoordinator` 把"退休旧代 / 取消 grace / 检查或创建新代"整段串行化，不同名字仍全并发。client 侧交叉校验：重连 `attachExisting` 报的 generation 必须与首次 `attach` 相同，否则拒绝热重放。

**状态文件**一个文件两个角色：启动竞争的排他创建锁 + 就绪后的信息性状态 `{pid, endpoint, tokenPath, startedAt, protocolVersion}`。`openSync(statePath,'wx')` 抢锁；失败则 `probeExisting()` 轮询 10 × 150 ms 读 state + hello 探测，活着就静默 `exit(0)`，确认陈旧才 unlink 重抢。**fail-closed**：只有 ENOENT 算"不存在"，权限错误/目录占位/I/O 错误/畸形 JSON/空 token 全部抛出——不能当作抢占许可（`existing-host-state.ts:85-91`）；并拒绝 state 里的重定向（`endpoint`/`tokenPath` 必须与调用方独立推导一致）。发布是原子 rename，temp 名带 pid+序号+UUID（固定 `.tmp` 会让竞争的 host 互相覆盖），Windows 共享冲突有界重试 `[10,25,75,200] ms`。listen 回调顺序：chmod socket 0700 → 写 token 0600 → 发布 state → `scheduleGraceExitIfEmpty()`；任一步失败走 `abortListeningStartup` 清理后非零退出。零会话后 `GRACE_EXIT_MS = 30 s` 退出——对齐 tmux "最后一个 session 死了 server 就退"，但给 app 重启留窗口。

**ConPTY 与 kill**：Windows 走 **taskkill-first**，因为 node-pty 把 `WindowsTerminal.kill()` 推迟到首个输出字节之后，静默进程会永远杀不掉。

```ts
// src/session-host/host.ts:717-731（节选）
void terminateWindowsProcessTree(session.proc.pid).then(() => {
  if (sessions.get(name) !== session || session.exited) return
  session.releaseWindowsPtyAfterExternalTreeKill()
  // No manual endSession here. Closing the ConPTY handle must produce node-pty's real onExit,
  // which is the proof that shell descendants *and* host-parented conhost are gone.
  void beginKillRetirement(session).catch(failOperation)
```

`releaseWindowsPtyAfterExternalTreeKill()`（`session.ts:609-627`）经私有 `_close()` + `_agent.kill()` 释放 ConPTY 句柄，node-pty 不暴露该原语时显式抛错。`windows-process-tree.ts` 超时 **8 s**，**只有观察到 root PID 也消失才算成功**——宁可让 client 超时"不确定"，也不给虚假的破坏性确认。

**启动失败与降级**：host 侧 `EADDRINUSE` 时再做一次诚实探测（活着 `exit(0)`，否则清理 `exit(1)`）。client 侧先试连既有 host（对"state 文件刚建好还空"这唯一瞬态重试 5 × 50 ms，其他不可读/畸形立刻算完整性失败），失败才 spawn，再 30 × 150 ms 轮询。后端选择 fail-closed：`sessionHostSupported()` 在 `platform()` 未初始化时返回 false，"never select an unusable backend"（`session-host-backend.ts:38-46`）。`pty-manager.ts:3055-3072` 的分支：只有「非 SSH + 有 persistKey + `tmuxEnabled` + `sessionHostSupported()`」才走 session-host；存在性探测失败**不**当作"不存在"（`.catch(() => true)`）。client 常量：请求超时 10 s、重连退避 `[50,100,250,500,1000,2000] ms`、kill 二次确认 2 次。

---

## 5. 渲染侧

### 5.1 `src/renderer/terminal/`

不是"终端组件"，而是围绕 xterm 的一圈**纯策略模块 + 单测**（几乎每个 `.ts` 配一个 `.test.ts`），真正的 `new Terminal()` 在 `nodes/TerminalNode.tsx`。xterm 构造选项唯一来源是 `terminal-config.ts` 的 `xtermOptionsFromSettings()`——"the point is that there is no per-site options literal left to drift"。addon 在 park 命中时复用而非新建（`TerminalNode.tsx:1878-1896`）。**SerializeAddon 不在渲染侧**，只在 `session-host/terminal-emulator.ts`：那里逐行核对了编译后的 `_serializeModes()` 究竟恢复哪些 DEC 私有模式，并手工补上它**不**发的 `CSI ?1006h`（SGR 扩展鼠标坐标）。

WebGL 预算：`WEBGL_BUDGET = 12`（浏览器 Server Edition）；桌面 Chromium 用 `--max-active-webgl-contexts=32` 抬顶、预算升 24，macOS 桌面压到 16。规则（`CLAUDE.md:514-543`）：模块级协调器拥有**所有**授予决定与时序，节点自己永不重新获取（那个循环就是设计所惧怕的驱逐战争）；获取要过 `ACQUIRE_DEBOUNCE 150 ms`（快速平移不该抓只闪两帧的 context）；超预算时按 `hiddenAt` LRU 从**最久未见的隐藏持有者**按需回收；若持有者当前全可见（缩到很小），新来者**不授予、留在 DOM 渲染器**——绝不越预算；隐藏持有者**无限期**保留（没有基于时间的释放）。配套坑：`WebglAddon.dispose()` 也是回退 DOM 渲染器的路径，而它从生命周期 effect 的 cleanup 跑（React 已摘元素），新 DOM 渲染器于是按 `offsetWidth = 0` 的缓存推导 `letter-spacing`，每字符多烘进一个 cell——这就是"切项目后字母短暂散开"；`resyncDomRendererSpacing(term)` 在测量仍为 0 时**直接放弃**而非烘错数。

### 5.2 glyphgrid：整块画布共用一个 WebGL2 context

`terminalGpuRendering` 解析为 `dom | webgl | shared`，`'shared'` 即 glyphgrid（经 `terminal/glyphgrid-attach.ts` 接入；此模式下每终端预算关闭）。自研动机（`plans/2026-08-05-glyphgrid-phase2-promotion.md:5`）："so the black/flickering-terminal failure class is closed **by construction (one context)** rather than by avoiding the GPU."

分层铁律：`glyphgrid/` 内部**绝不 import xterm**，终端知识经手写窄接口 `TermInternals` 注入——"xterm's private surface is the part of that library most likely to move under us, and keeping it behind one injected interface means a bump breaks ONE thin shell instead of the renderer"（`addon.ts:1-9`）。模块：`cells.ts`（`CELL_STRIDE = 4` 个 uint32 lane，与 GL instanced attribute 绑定同步）、`feed.ts`（base→inverse→dim→decoration→selection→cursor 的解析顺序）、`atlas.ts`+`raster.ts`、`box-glyphs.ts`（制表符/块元素几何绘制，不信任字体）、`engine.ts`、`gl.ts`/`gl-webgl2.ts`、`camera.ts`、`plate.ts`、`cursor.ts`/`decorations.ts`、`frame-driver.ts`。

两处测量：**彩色图集而非单色+染色**（`atlas.ts:6-15`）——旧单色覆盖度图集要自己做抗锯齿混合，而 CoreText 对浅色压深色的光栅化自带 gamma 与平滑补偿，"a tuning knob with no correct setting (**six device rounds of BLEND_GAMMA** say so)"；**每 grid 独立 GPU buffer**（`gl.ts:4-9`）——Phase 0 每次变更重传整个可见 grid 的 cell 数组，在"50 个终端里 1 个繁忙"的负载下是 **~90 MB/s**。

帧循环 park（`frame-driver.ts:5-16`）：空闲画布的 `frame()` 永远返回 false，但只要 rAF 回调还注册着，Chromium 就让渲染主线程、合成器和 GPU 进程按刷新率空转。反向失败更严重——**漏一次唤醒不是画布变慢，是画布冻住**，故三重保守：对脏标志唯一写者的边沿订阅、`IDLE_FRAMES_BEFORE_PARK = 30` 后才 park、park 中 `HEARTBEAT_MS = 1000` 复查。闪烁光标必须走一次性 `pulse()`：走 `onDamage` 会每 500 ms 唤起 30 帧，等于悄悄废掉 park。

**注意文档漂移**：该计划 Task 9 是"macOS 默认切 `shared`"，但 `CLAUDE.md:560-569` 记录默认值**后来又改回 `webgl`**——黑屏被根因定位为 addon-webgl 0.19 的 dispose 在 5.5 core 上崩溃并中断自己的 DOM-renderer 恢复（依赖偏移），而非 context 数量；真正守住 macOS 的是更低的预算 16。该计划只能当历史动机文档读。

### 5.3 重连 repaint 的不变量

`session-host-client-repaint.test.ts`（244 行单个 it）：真 net server 伪造 host，首次 `attach` 返回序列化屏幕 → 销毁 socket → client 自动重连发 `attachExisting` → host 再回同一份 `screen`。

```ts
// src/core/session-host-client-repaint.test.ts:236-242
expect(actual.buffer.active.length).toBe(expected.buffer.active.length)
expect(actualLines).toEqual(expectedLines)
expect(markerCount(actualLines, marker)).toBe(1)
expect(actual.modes.bracketedPasteMode).toBe(true)
expect(actual.modes.mouseTrackingMode).toBe('drag')
```

即：① 替换而非追加（marker 只 1 次）；② 含 scrollback 的逐行保真；③ `?2004`/`?1002`/`?1006` 私有模式恢复；④ generation 必须一致否则拒绝热重放。实现是 `RECONNECT_REPAINT_PREFIX = '\x1b[3J\x1b[2J\x1b[H'` + 序列化屏幕。**顺序不变量**（`session-host-client.ts:883-888`）：校验与 repaint 投递必须**同步**发生在响应帧的解析过程中，不能推到 `await` 之后的 microtask——unix socket 上 host 的下一个 raw `data` 帧可能与响应共享一次读 chunk，延后会让实时帧先到 `deliverData`，颠倒 repaint-then-live 顺序。

### 5.4 RAM 优化五阶段（`plans/2026-08-10-ram-optimization.md`）

目标："看不见的地方静默做，几乎感觉不到的地方用保守默认，用户会感觉到的地方做成 opt-in"。Phase 1–3 静默开，Phase 4 默认开但阈值保守，Phase 5 默认关。

| 项 | 数值 |
|---|---|
| 单终端满 xterm buffer | 最高 **~16 MB**（注释原话 "pure cost"）|
| Agent CLI 进程本身 | **数百 MB —— 真正的 RAM 大头** |
| subagent-tail 单 tick 读取上限 | **1 MB**，tick 400 ms（fixture 用 ~2.5 MB 单块）|
| parked terminal 计数上限 | **12**（≈一个繁忙项目的终端数，与 `WEBGL_BUDGET` 同量级）|
| 离屏销毁窗口 | **10 分钟**（park 窗口 5 分钟）|
| 浏览器节点丢弃窗口 | **5 分钟**；发声页面永不丢弃、加载中阻塞丢弃 |
| Eco 休眠 | 空闲 **30 分钟**、sweep 60 s、每轮 ≤ **2** 个 |
| RTK/Headroom/Caveman | 实测真实语料节省 **3.7%**，计划要求"必须如实陈述" |

明确**不做**（已决策，非遗漏）：React Flow `onlyRenderVisibleElements`（会 park 风暴并丢掉"节点保持挂载"的契约）、给 parked 终端做 PTY 流控暂停（`setFlow` 会饿死 co-attach 观看者）、按字节的 xterm scrollback + 降低 tmux `history-limit` 默认值（渲染层 10k 行钳位已封顶，砍 tmux 历史是重度用户唯一会感觉到的改动）。

---

## 6. 对 Armadra 的映射

### 6.1 现状：两边已收敛到同一套结论

Armadra 终端域在 `apps/runtime/src/terminal/`（约 8000 行），契约是 `docs/contracts/v3-agent-terminal-plan.md` §15（2026-09-04 定案）。

| 机制 | nodeterm | Armadra | 差异 |
|---|---|---|---|
| 后端选择 | tmux → session-host → 纯 shell（if 分支）| `TerminalBackend` trait：`TmuxBackend`/`DirectBackend`/`SessionHostBackend`（Windows，cfg-gated）| 同构，Armadra 用 trait |
| socket 隔离 | `-L node-terminal`（默认 tmpdir）| `-S <data_dir>/tmux.sock -f <data_dir>/tmux.conf`，目录 0700 | **Armadra 更强**（绝对路径，完全不共享）|
| 会话命名 | `nt-<nodeId>` | `armadra-<ws前8>-<key前8>-<gen>`（`backend.rs:290-296`）| 名字里带代次 vs 靠 barrier 区分代 |
| 代次栅栏 | 仅 Windows session-host 有 | `generation` 是一等列，WS 帧与事件都带，旧代一律 409/`stale` | Armadra 统一到所有后端 |
| attach | node-pty 里跑 `tmux attach-session` | 同：`openpty()` + `CommandBuilder::new("tmux") … attach-session`（`tmux/mod.rs:130-160`）| 一致 |
| 粘贴 | `load-buffer -` → `paste-buffer -p -d -r` → `send-keys Enter`，copy-mode 用 `if-shell` 内部门控 | `load-buffer -b armadra-<uuid> <file>` → `paste-buffer -p -d` → `send-keys Enter`，先 `sanitize_paste` 剥 ESC（`tmux/mod.rs:316-345`）| Armadra 缺 `-r`；copy-mode 是两次往返而非门控 |
| 回收 | 10 min 空闲 reap + 6 h grace 预算 | `gc.rs` 每 10 min `sweep`，grace 默认 24 h，每轮 ≤8 | 一致 |
| 启动对账 | per-node `has-session` | `reconcile()` 启动时一次性对账 DB 与 `list-sessions`，孤儿进回收 | Armadra 更系统 |
| Windows | `src/session-host/`（TS，NDJSON，state 文件锁）| `crates/session-host/`（Rust，ConPTY + Job Object + 命名管道 + SID，`replay.rs` 做无头屏幕）| 同构 |
| Agent 环境注入 | tmux `-e` 注入 hook/PATH/账号 env | `agent_environment()` 给 `ARMADRA_NODE_ID/AGENT_ID/ENDPOINT_FILE/CANVAS_CONTROL`，**per-node token 在 0600 文件，绝不进环境**（`mod.rs:481-494`）| **Armadra 更严格** |

所以问题应重述为：**迁 Electron 后终端域留在哪。**

### 6.2 两条路

**A：终端域留在 Rust Runtime，Electron 只做壳与渲染。**
- Runtime 已是 PTY、tmux server 句柄、replay 日志、SSH ControlMaster、Hook 服务的持有者。`bridge.rs:1-9` 说得直白：Host 决定会话该不该存在，"this Runtime still runs it, because a PTY, a tmux server handle and a replay log cannot live in another process"。
- **远端/SSH 不受影响**：`ssh/` 的 argv 构造、`known_hosts` 人工确认、`askpass`/`prompts` 密码对话框、远端执行主机全挂在 Runtime。搬走等于用 TS 重写四块。
- **Agent 注入不受影响**：`agent_environment()`、`hook-endpoint.env` 的 0600 token、`issue_node_token`、`context_session_environment` 的序号初始化都在 Runtime；Hook 回报走同一个 Unix socket + app bearer，Electron 插进来会多一道跨进程转发和一套新凭据故事。
- 代价：终端字节多一跳。但 nodeterm 的 `TerminalTransport` 正好证明这一跳可接受——它自己也为 RemoteTransport 预留了完全相同的形状，而 Armadra 的 `apps/web/src/terminal/transport.ts` 已经是那个形状（`hello`/`snapshot`/`output`/`stale` 状态机）。

**B：Electron main 用 node-pty 直接起 tmux。**
- 收益只有少一跳 + 可直接复用 nodeterm 的 `pty-manager.ts` 家族。
- 代价（均对应本文前五节）：① 继承 node-pty 两个原生补丁与 `postinstall` 打补丁流程（Rust `portable-pty` 没这两个泄漏）；② 继承 macOS `ptmx_max` 的整套限流、压力分级、LaunchDaemon 提权；③ SSH 路径要么留在 Runtime（终端域被劈成两半，两进程各持一半会话，对账噩梦），要么整体 TS 重写；④ Agent 注入与 Hook token 要么由 Electron 转发 Runtime 签发（多一道信任边界），要么把 Hook 服务也搬走；⑤ Armadra 的 `session-host` 是能交叉编译的 Rust crate（`docs/research/m0-executor-probes.md` 记录本机无法为 Windows 交叉编译 runtime crate，所以 Windows 代码被刻意隔离到该 crate）——搬走等于放弃这个隔离；⑥ Go Host 已接管 session 域的**决策**（`platform-implementation-status.md` B3：`sessionhost` 服务，终端 WS 升级前按记录校验 `session_id/generation`），执行方换成 Electron 等于让 Host 的 Worker 去指挥一个渲染壳。

### 6.3 推荐

**推荐 A：终端域留在 Rust Runtime。** 理由按重要性：

1. **所有权链已经正确。** nodeterm 全部设计的根是"跑 CLI 的进程要属于比 UI 活得久的进程"。Armadra 的 tmux server 由 Runtime 拉起、pane 进程归 tmux 自己，Runtime 崩了 agent 也活着（`tmux/mod.rs:1-8`）。换成 Electron 拉 node-pty 跑 tmux，这个性质**不变**——收益到此为止，代价却是 §6.2 的六项。
2. **远端与注入恰是最贵的两块。** SSH 的 argv/known_hosts/askpass 与 Hook token 的 0600 语义都是"已想清楚并写成不变量"的部分，搬家没有设计增量，只有翻译风险。
3. **Electron 该借的是渲染侧，不是主机侧。** Armadra 缺的正是 nodeterm 已付过学费的：WebGL 预算协调器（Armadra `render-budget.ts` 已有雏形——默认 4、范围 1–24、焦点优先且可超限、LRU 平局确定序——但无 acquire 去抖、无 context loss 重授、无回退 DOM 时的字距修复）、park/离屏释放、冷启动播种规则、以及"每个内存杠杆都要问下面是不是 tmux"那道门。

**迁移的正确形态**：Electron main 只管窗口、菜单、原生剪贴板/托盘、以及 Runtime 与 Host 的进程管理；`apps/web` 的 `TerminalSurface` 继续对 Runtime 说 `/api/terminals/{id}/ws`；唯一值得新增的是 `--max-active-webgl-contexts` 这类只有壳能设的 Chromium 开关（nodeterm 设 32）。

### 6.4 可直接吸收的条目

1. **`#{window_activity}` 而非 `#{session_activity}`**：`tmux/mod.rs:450` 的 `list_alive` 取的是 `#{session_name} #{session_attached} #{session_activity}`。按 §2.3 实测，`session_activity` 会被**每次 attach** 顶到 now，用它做 idle 判据会系统性把久置会话判成活跃（实测差距 33 分钟 vs 37 小时）。**这是本文发现的、可直接落地的一处缺陷。**
2. **`paste-buffer` 两个守卫**：copy-mode 下 `-p` 静默不加框（需 `if-shell -F '#{pane_in_mode}'` + `send-keys -X cancel` 在同一次调用里），以及 `-r` 保持 `\n` 不被改写成 `\r`。
3. **xterm 缩放坐标**：Armadra 已在 2026-09-16 踩过（`platform-implementation-status.md:216`，62% 缩放时点第 100 列落到第 62 列，包一层 `MouseService` 的两个坐标函数）；nodeterm 的 `scale-fix.ts` 是同一个解，可交叉验证。
4. **测试 tmux 隔离**：Armadra 的 `-S` 已比 `-L` 安全，但"在 Armadra 自己的终端里跑测试"这条路径仍应按 §1.4 补一条守卫（剥 `TMUX`/`TMUX_PANE` + 断言 socket 落在测试目录）。
5. **纯 shell 降级下的"活儿"门**：Armadra 的 `DirectBackend` 与 nodeterm 的纯 shell 回退同构；目前 dormancy/离屏只 detach 不杀进程，风险比 nodeterm 小，但将来加"离屏销毁"类杠杆前必须先补 `live-work` 那道门。
6. **bundled tmux 若要做**：务必"系统优先、bundled 垫底"（§3.5 的 server 版本配对理由）。

---

## 7. 建议的实施批次

**批次 0 · 缺陷修正（不依赖 Electron 迁移，可立即做）**
把 idle 判据换成 `#{window_activity}`；`paste` 加 `-r`，copy-mode 退出改为同一次 tmux 调用里的 `if-shell` 门控。
验收：`cargo test -p armadra-runtime`，新增两个单测（format 串含 `window_activity`；paste 计划的参数序列），并在本机私有 socket 上手工验证"attach 一次后 idle 判据不归零"。

**批次 1 · tmux 测试隔离守卫**
给 Runtime 的 tmux 测试加守卫：断言 socket 路径落在测试专属目录内，并剥离 `TMUX`/`TMUX_PANE`。
验收：在已有 Armadra 终端运行的环境里跑 `cargo test -p armadra-runtime`，确认既有会话不受影响。

**批次 2 · Electron 壳骨架（终端域不动）**
Electron main 只做窗口/菜单/托盘 + 启动并发现 Runtime 与 Host；`apps/web` 原样加载，终端仍走 Runtime WS；加 `--max-active-webgl-contexts=32`，`render-budget` 默认按平台抬到 16（mac）/24（其他）。
验收：空数据目录冷启动 25 秒内画布稳定无错误（沿用现有打包验收口径）；30 节点 + 若干终端的平移/缩放帧率不低于现 Tauri 壳。

**批次 3 · 渲染侧预算补齐**
`render-budget.ts` 补 acquire 去抖、context loss 后的单次延迟重授（带连败上限）、回退 DOM 时的字距重算门（测量为 0 时放弃）、内存压力下释放所有隐藏持有者。
验收：`pnpm --filter @armadra/web test`；手工——快速平移穿过 20 个终端不出现 "lost context" 占位符；休眠唤醒后终端 1 秒内恢复 GPU 渲染。

**批次 4 · 生命周期分级（park / 离屏释放）**
引入 park（切画布保留 xterm + WS，N 分钟内重挂认领）与离屏释放（就地销毁 xterm，节点保持挂载显示占位板）。**前置硬性要求**：先落地"这一刀会不会杀掉活儿"的判据——`DirectBackend` 支撑的会话不得被任何释放杠杆触碰。
验收：`pnpm --filter @armadra/web test` + 手工——tmux 后端下离屏释放再靠近画面完整且 <500 ms；direct 后端下同一路径不得导致任何进程退出（用 `sleep 600` 做探针）。

**批次 5 · Windows 收口**
在真实 Windows 上验证 `crates/session-host` 的 generation 栅栏、状态文件抢锁、ConPTY 释放与进程树终止；按 §4 检查是否存在 conhost 泄漏（Armadra 用 Rust ConPTY 不继承 node-pty 的 bug，但要实测确认）。
验收：`cargo test -p armadra-session-host`（平台无关的那一半）+ 实机：反复杀会话后 conhost 进程数不随次数增长。

**批次 6 · 文档与登记**
本文所在目录 `docs/research/nodeterm/` 需按 AGENTS.md 登记进 `docs/README.md`，并跑 `pnpm repo:check` 确认目录规则通过（本次分析按"只写一个文件"的约束未做登记）。
