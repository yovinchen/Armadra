# TypeScript Core 实施进度

> 本文只记已验证的事实：跑过的命令、量到的数字、当场看见的结论。目标设计在 [TypeScript Core](../design/typescript-core.md)，不在这里。
> 每条结论后面跟的是复现它的命令。

## 1. 阶段状态

| 阶段   | 范围                                                 | 状态                  |
| ------ | ---------------------------------------------------- | --------------------- |
| **R0** | core 进程骨架、三种监听、`/health`、SQLite 账本      | 已合入（`c1644c10d`） |
| **R1** | 画布 / 工作空间 / 设置 / 身份、统一库迁移            | 进行中                |
| **R2** | 终端域                                               | **纵切已完成**，见下  |
| R3–R7  | Hook / Agent、Git / 文件、语言服务等、服务器壳、收尾 | 未开始                |

## 2. R2 纵切：只有 tmux 后端的建 / 附 / 输入 / 断

设计 §10 要求先做这一刀，理由是整个方案里**唯一可能被证伪**的三件事都在这里：字节吞吐、单事件循环的相互干扰、原生模块打包。三件都量了，三件都过。

### 2.1 已实现

- `TerminalBackend` 契约十二个方法（`apps/desktop/src/core/terminal/backend.ts`），与 Rust trait 的对应关系写在文件头的表里。
- `TmuxBackend`：Create / Attach / Detach / Input / Paste / Resize / Terminate / List 与真值 `GetCapabilities`；Capture / Signal / GetForeground 抛 `not_implemented`（501）。
- 私有 socket `-S <数据目录>/tmux.sock` + `-f <数据目录>/tmux.conf`（0700 / 0600），会话名 `armadra-<ws8>-<key 尾 8>-<generation>`，attach 走 node-pty 的 pty 跑 `tmux attach-session`，粘贴走 `load-buffer` + `if-shell -F '#{pane_in_mode}'` 同一次调用里的 `paste-buffer -p -r -d`，`list-sessions -F` 读 `#{window_activity}`。
- HTTP/WS：`POST /api/terminals`、`POST /api/terminals/{id}/terminate`、`GET /api/terminals/{id}/ws`。其余终端路由仍按 R0 的表回 501 并带功能名。
- Agent 环境注入：创建时四个变量，`contextSessionEnvironment` 再补两个；per-node token 不进环境。

### 2.2 不在本批

不做 GC、不做启动恢复、不做 recycle、不做 SSH、不做 `direct` / `sessionHost`、不做输入序号的跨连接账本（`hello.acknowledgedInput` 本批恒为 0，页面据此只重发自己未确认的那几条）。

## 3. 三项量测

机器：Apple Silicon macOS 25.6.0，tmux 与两端实现相同。复现：

```
pnpm --filter @armadra/desktop build          # 产出 out/core/main.js
cargo build -p armadra-runtime                # 产出 target/debug/armadra-runtime
node tools/probes/core-terminal-bench.mjs --megabytes 200 --requests 200
```

### 3.1 吞吐：差 0.1%，预算是 20%

同一台机器、同一分钟、同一个 tmux、同一个 200 MB 文件，`cat` 到一个 pane 里，从 WS 客户端的 `hello` 计时到命令结束标记。五次连跑：

| 次数 | Rust Runtime |   TS core |        差 |
| ---- | -----------: | --------: | --------: |
| 1    |        7.1 s |     7.2 s |     +1.4% |
| 2    |        7.0 s |     7.0 s |     −0.1% |
| 3    |        6.9 s |     6.9 s |     −0.2% |
| 4    |        7.0 s |     7.1 s |     +1.5% |
| 5    |        7.3 s |     7.2 s |     −1.4% |
| 中位 |    **7.0 s** | **7.1 s** | **−0.1%** |

**冷盘的第一轮差别大得多，方向也相反**：Rust 36.3 s / 37.6 s，TS 26.9 s / 30.0 s（TS 快 20%–26%）。差的不是实现，是 200 MB 文件还没进页缓存；把它记在这里，是为了让下一个人看到 7 秒和 37 秒时知道两者都是真的，区别只在跑第几次。

**这个数字量的是什么**：不是「Node 能不能搬 200 MB」。经 tmux 的 pane，客户端实际收到的只有 2.1–2.4 MB —— tmux 渲染的是一屏，不转发每个字节。两端都一样，所以 `seconds` 可比，而 `socketMegabytes` 只说明吞吐瓶颈在 tmux 而不在任何一个传输层。

### 3.2 干扰：不劣化，预算是不劣化 50%

同一轮里，200 次 `/health` 与一条 R0 的 501 路由交替打，与同一进程安静时的同样 200 次比：

| 实现         | 安静 P95 | 满负载 P95 |     比值 |
| ------------ | -------: | ---------: | -------: |
| Rust Runtime |  0.95 ms |    0.94 ms |     1.00 |
| TS core      |  2.83 ms |    0.59 ms | **0.21** |

五轮里 TS 的最大比值是 0.54，没有一轮接近 1.5 的门槛。**满负载比安静还快**是个真实但无聊的原因：安静那一轮紧跟进程启动，JIT 还没热；到满负载那一轮已经热了。这条的结论只能说到「没有可测量的劣化」，不能说成「终端流量让 HTTP 变快」。

**不需要 `worker_threads`。** 设计里写的「超标就把 `TmuxBackend` 搬进 worker」这一步没有触发，因此也没有做——`TerminalBackend` 契约本来就是消息式的，真要搬不改调用方。

量测本身有一个坑值得记：**探针不能用 `fetch`**。同一个 core、同一条路由，`fetch` 稳定报 ~494 ms，而 `curl` 与 `node:http` 都报 ~1.1 ms。基线比被测量大 450 倍的探针回答不了它被写出来要回答的问题，所以 `core-terminal-bench.mjs` 走 `node:http`。

### 3.3 打包：产物位置对，打包版真能开终端

`pnpm --filter @armadra/desktop dist` 出 `mac` 与 `mac-arm64` 两个 `Armadra.app`（未签名、未公证：本机没有证书，`signing-electron.mjs` 三态判定走的是 skip）。两项检查都过：

```
node tools/probes/core-terminal-bench.mjs --packaging   # 产物位置
node tools/probes/core-terminal-packaged.mjs            # 打包版 + ARMADRA_CORE=ts 真开一个终端
```

第一项断言两个 app 的 `Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/` 下同时有 `pty.node` 与**可执行的** `spawn-helper`。两者都必须在 asar **外面**：`posix_spawn` 执行不了归档里的文件，而 node-pty 的 macOS 路径就是 spawn 那个 helper。

第二项起打包版、CDP 连真渲染进程，在页面里按页面自己的方式取地址（`window.armadra.transport.endpointsSync()`）、`POST /api/terminals`、开 WS：

```json
{
  "type": "hello",
  "generation": 1,
  "backend": "tmux",
  "rows": 24,
  "cols": 80,
  "alive": true,
  "acknowledgedInput": 0
}
```

`hello` 到达，随后打字的 `echo` 原样回显。这条走完才算证明 asar 外的 `.node` 在真壳里加载得起来。

探针的调试端口是运行时选的空闲端口。固定端口踩过一次：机器上另一个 Electron 占着 9333，探针连上了**别人的**渲染进程，报出来的样子和打包失败一模一样。

## 4. node-pty 的两个已知缺陷

`apps/desktop/scripts/patch-node-pty.mjs` 对 node-pty **1.1.0** 打钉住版本的补丁（同时校验 `src/unix/pty.cc` 的 SHA-256），在 `electron-rebuild` 之前跑，由 `ensure-electron.mjs` 串起来。

### 4.1 macOS：每次 spawn 泄漏 pty 设备（已修）

`pty_posix_spawn` 三处：

1. 低位 fd 的清理循环写的是 `low_fds[0..count]`，关的是 `count..1` —— **entry 0 永远不关**，而正常进程里 0/1/2 已占用，第一次 `posix_openpt` 就返回 ≥3，循环体一次都不执行。`count == 3` 时它还会读 `low_fds[3]`，越界一格。
2. 父进程从不 `close(slave)`：子进程拿的是 dup 过去的副本，父进程这一份只是让 pty 对一直占着。
3. `posix_openpt` 与 `posix_spawn` 之间的每一处早 `return`（`grantpt`/`unlockpt`、`TIOCPTYGNAME`、`open(slave)`、`tcsetattr`、`TIOCSWINSZ`）都带着 master 离开，`*err` 还停在调用方的 `-1`。

实测（20 次成功 spawn + 20 次注定失败的 spawn，数进程持有的 `/dev/ptmx`）：

|        |                          泄漏的 ptmx |
| ------ | -----------------------------------: |
| 补丁前 | **40**（另有 3 次预热也各泄漏 1 个） |
| 补丁后 |                                **0** |

本机 `kern.tty.ptmx_max` 是 511，也就是**约 511 个终端之后整台机器再也 spawn 不出 pty**，并且波及与本应用无关的进程。

### 4.2 `electron-rebuild` 的架构默认值（已修）

不是 node-pty 的缺陷，但同一条链路上、症状一模一样，所以记在一起。

`electron-rebuild -f -w node-pty` **不带 `--arch`** 时，在 arm64 Mac 上产出的是 **x86_64** 的 `pty.node` 与 `spawn-helper`。addon 照样加载——它是 N-API，ABI 对得上——然后每一次 spawn 都报：

```
Error: posix_spawnp failed.
```

那就是 node-pty 里 exec 一个架构不对的 Mach-O 的样子，而这句话里没有任何一个字指向架构。`ensure-electron.mjs` 现在显式传 `--arch ${process.arch}`，并在 rebuild 之后用 `file -b` 核对两个产物的架构，不符就非零退出。

打包产物不受影响：electron-builder 按目标架构自己重建，`release/mac-arm64` 里那份一直是 arm64。错的只有工作区的 `node_modules`，也就是只有开发和探针会撞上。

### 4.3 Windows：ConPTY 释放竞态（未修）

`src/win/conpty.cc` 在原生退出线程里先 delete baton 再关 HPCON，外部 `taskkill /T` 掉进程树后会留下 `conhost.exe`。本批是 macOS/Linux（tmux），没有一行代码走得到它，补丁脚本里留 `TODO(R6)`：R6 的 Windows session host 是第一段真正打开 ConPTY 的代码，也是第一次有人能在真机上验证这个修法。

## 5. 与页面的协议：帧仍然是文本 JSON

设计 §9 写的是 `ws.send(Buffer, { binary: true })`，三条里两条照做了——这条路径不碰数据库，payload 也只拼一次 Buffer。**第三条做不到**：`apps/web/src/terminal/transport.ts` 对每一帧做 `JSON.parse(String(event.data))`，二进制帧会被 `String()` 成 `"[object Blob]"`、解析失败，然后按它自己的第 4 条规则**静默丢弃**。那个文件是验收标准且本批不能改，所以帧与 Rust 逐字同形，省掉的是每帧那次多余的字符串编码。

真要换二进制，得和 `packages/shared` 的 schema、`transport.ts` 在同一个提交里改——不是 core 这一侧单独能做的决定。

## 6. 单向门：应用 0015 之后 Rust Runtime 不再打得开这个库

这是整轮迁移里唯一一处**不可逆**的动作，任何人在生产数据目录上开 `ARMADRA_CORE=ts` 之前都要先读懂这一节。

**发生了什么。** `ARMADRA_CORE=ts` 时 core 会在 `apps/runtime/migrations` 的 14 条迁移之后，多应用一条统一库迁移 `0015_unified_core.sql`（文件在 `apps/desktop/src/core/db/migrations/`，只有 TS core 读它）。它把 Go Host 的身份表按原样建进 `canvas.db`：`store_meta`、`identity_owner`、`identity_devices`、`identity_sessions`、`identity_bootstrap_tickets`。

**为什么回不去。** Rust Runtime 的启动前检查有一条规则是「账本里有本构建不认识的迁移版本就拒绝启动」（`apps/runtime/src/db/mod.rs`）。0015 不在 Rust 编译进去的那个目录里，所以它永远不认识 15。应用过 0015 的 `canvas.db`，Rust Runtime 打开时会报：

```
Database migration 15 is unknown to this build; startup refused without changing its data
```

拒绝是**只读**的：库的字节一个都不变，可以反复重试。

**回滚怎么做。** 不是再跑一条迁移，是**用备份替换整个文件**。core 在应用 0015 之前会先把整个库复制成 `canvas.db.before-ts-core-<UTC 时间戳>`（`VACUUM INTO`，已提交的 WAL 内容一起带上，写完立刻校验能打开且有账本），这是唯一的回滚点：

```sh
# 关掉 core，然后
mv <数据目录>/canvas.db          <数据目录>/canvas.db.ts-core
cp <数据目录>/canvas.db.before-ts-core-<时间戳> <数据目录>/canvas.db
rm -f <数据目录>/canvas.db-wal <数据目录>/canvas.db-shm
# 如果 host.db 被吸收过，把它改回来
mv <数据目录>/host.db.absorbed-<时间戳> <数据目录>/host.db
```

之后 `ARMADRA_CORE=rust` 就能正常启动。**备份之后写进新库的东西不会回来**——过门之后产生的会话、设备、画布改动都留在 `canvas.db.ts-core` 里。

**空库不备份。** 新建的数据目录没有可丢的东西，那里不会出现备份文件；日志里会说明。

## 7. 旧 `host.db` 的一次性吸收

过门之后，如果同一个数据目录里还有 Go Host 的 `host.db`，且统一库里那五张表都是空的，core 会在一个事务里把它们整体搬进来，逐表核对行数，然后把原库改名 `host.db.absorbed-<UTC 时间戳>`（**不删除**，WAL 与 shm 跟着走）。

任何一张目标表已经有行就整体跳过：合并两份身份记录没有正确答案，而跳过的代价只是一次重新配对。

`store_meta.host_id` 必须跟着搬，否则页面记住的那个 Host 就认不出来了——所以吸收发生在任何域第一次读 `store_meta` 之前。

## 8. R1c：身份 / 设备 / 会话

已落地（`apps/desktop/src/core/identity/`）：

- 设备配对：私有通道签一次性票（两分钟、绑定 host / instance / origin），票换 Bearer 会话；
- 会话：访问令牌 15 分钟、绝对期限 30 天，轮转一次换三把密钥且不延长绝对期限；
- 撤销：推进设备 epoch，旧会话在下一个请求上 401；每次认证都重读库，没有内存缓存；
- 来源：回环明文 HTTP **不**发 Cookie 会话（Cookie 按 host 不按 port 隔离），走 Bearer；HTTPS 那一支留给 R6 的服务器壳。

**私有通道** = 数据目录下 0600 的 Unix socket `core-control.sock`，只答一个方法 `POST /control/identity/ticket`。文件权限就是鉴权。`ARMADRA_CORE=ts` 时桌面壳的 `identity:ticket` 走它，不再 spawn `armadra-host pair`。

**Windows 尚未支持**：命名管道那一版要带受保护的 DACL 与逐连接的客户端 SID 核对，`node:net` 的普通管道达不到，留给 R6。在 Windows 上这条通道不开，壳应继续用 `ARMADRA_CORE=rust`。

**两张面**：新面 `/api/identity/*`（JSON，`{ code, message }`）是设计 D9 的目标；兼容面 `/rpc/armadra.v1.{HostService,IdentityService}/…`（二进制 protobuf）覆盖 `packages/host-client` 今天发的 8 个方法，让前端在不改一行的情况下走通登录，活到 R7。

验证：`node tools/core-identity-smoke.mjs`（真进程跑完 Hello → 取票 → 配对 → 重放被拒 → 撤销 → 401），以及 `pnpm --filter @armadra/desktop test` 里的身份与迁移用例。
