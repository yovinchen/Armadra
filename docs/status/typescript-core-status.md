# TypeScript Core 实施进度

> 本文只记已验证的事实：跑过的命令、量到的数字、当场看见的结论。目标设计在 [TypeScript Core](../design/typescript-core.md)，不在这里。
> 每条结论后面跟的是复现它的命令。

## 1. 阶段状态

| 阶段   | 范围                                                                               | 状态                  |
| ------ | ---------------------------------------------------------------------------------- | --------------------- |
| **R0** | core 进程骨架、三种监听、`/health`、SQLite 账本                                    | 已合入（`c1644c10d`） |
| **R1** | 画布 / 工作空间 / 设置 / 身份、统一库迁移                                          | 已合入（`0b098c650`） |
| **R2** | 终端域：tmux 纵切、direct / sessionHost、SSH、GC                                   | 已合入（`aa180c6e7`） |
| **R3** | Hook 面、Agent / 协作、TS `armadra-hook`                                           | 已合入（`aa180c6e7`） |
| **R4** | Git、文件 / 导入导出、定时与事件 outbox                                            | 已合入（`601095795`） |
| **R5** | 语言服务、GitHub / 资源 / 用量、浏览器授权与租约                                   | 已合入（`601095795`） |
| **R6** | 服务器壳（R6a）、账号与共享（R6b）、远程浏览器（R6c）、Windows session-host（R6d） | 全部已合入            |
| R7a    | GitHub 与自动化改打 JSON 面（R7 的前置）                                           | 已合入                |
| R7c    | 页面的身份 / 会话 / 事件流 / 更新脱离 `host-client`                                | 已合入                |
| R7d    | 收尾：删 Rust / Go / proto，CI、规则、打包与文档收口                               | 仓库层已合入（本节）  |

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

验证：`pnpm --filter @armadra/desktop test` 里的身份与迁移用例，以及 `identity/accounts.integration.test.ts` 真起 core 走完取票 → 配对 → 重放被拒 → 撤销 → 401（原先的 `core-identity-smoke` 工具走的是 `/rpc/` 面，随那一面一起删除）。

## 9. R3 与 R5c：Hook 面上的三个动词家族

Hook 服务（`apps/desktop/src/core/hook/`）只认证——bearer、per-node token、请求体上限——然后把 `{ nodeId, verified }` 交给 `hook/collab.ts` 登记的家族分发器。三个家族都由 `core/agent/hook-bridge.ts` 接入：`context-link` 与 `browser` 应答 prose（客户端原样打印），`control` 应答 JSON。`browser` 家族的动词表在 `core/browser/`（授权三规则、租约状态机、URL 策略、`browser:drive` 回环 WS 客户端），桥只负责解析 `Caller` 并把 `args` 原样转交。

TS `armadra-hook` 客户端由安装步骤写成 `<dataDir>/bin/armadra-hook` 启动器；启动约 79 ms（Rust 3.7 ms），输出字节一致。

验证：`pnpm --filter @armadra/desktop test`（含 `hook-bridge.test.ts`、`core/browser/**` 60 例，以及对 Rust 用例的移植）。

## 10. R4 / R5：路由表只剩电源租约与所有权两类未认领

R4 与 R5 的六条线全部合入。迁移编号合入时重排为：`0017_event_outbox`（定时与事件 outbox）、`0018_github`（GitHub 三张表）；R6 的账号迁移预分配 `0019`。

| 域                          | 位置                                             | 与 Rust / Go 的对账                                            | 测试   |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | ------ |
| Git（37 条路由）            | `core/git/`                                      | `scripts/git-parity.mjs`：30 条读 + 14 条写逐字段相同          | 162    |
| 文件 / 导入导出（15 条）    | `core/files/`、`core/imports/`                   | 42 组请求 40 组相同（差异：正则引擎报错原话、各自数据目录）    | 68     |
| 定时 / 自动化 / 事件 outbox | `core/schedule/`、`core/events/outbox.ts`        | Go 的 43 + 6 个用例移植；`?cursor=` 断线续订走带外控制帧       | 100    |
| 语言服务（7 条）            | `core/language/`                                 | 手写 LSP 分帧（理由见 `jsonrpc.ts`）；远端会话回 `unsupported` | 55 + 6 |
| GitHub / 资源 / 用量        | `core/github/`、`core/resources/`、`core/usage/` | `/rpc/…GitHubService` 24 个方法；采样用 `ps` 一次全表读        | 166    |
| 浏览器授权 / 租约 / 17 动词 | `core/browser/`                                  | 三个稳定错误码与 Rust 一致；`browser:drive` 出站回环 WS        | 60     |

已知偏差（都写在对应模块的注释里）：用量后台刷新在第一次读时武装而非装配时；语言域 `$/cancelRequest` 归还在途额度（Rust 泄漏）；两条导入路由的请求体上限按路由抬到 65 MiB（`server.bodyLimit`）；调度的 `LAUNCH_FROZEN` 冷启动未接。

## 11. R6a：`apps/server` 无窗口服务器壳

`apps/server`（pnpm 工作区成员 `@armadra/server`）在**同一个进程**里装配 core：直接 `import { run, DOMAINS }`，再向装好的 `CoreServer` 要一个**不绑定地址**的交接点，把 TLS 那一侧的 `request` / `upgrade` 原样转过去。没有代理进程、没有第二个套接字——Go Host 时代的 `proxy.go` 存在的唯一理由是两个进程。core 自己仍在回环上监听一个内核分配的端口，hook 客户端与 `endpoints.json` 的发现打那里。

它同时是「core 不依赖 Electron」的运行时证明：`core/no-electron.test.ts` 扫的是源码，`apps/server` 能把 core 整个装起来并对外服务，扫的是运行时。

### 11.1 做了什么

- **CLI**：`serve | install | uninstall | status | logs | upgrade | version`，解析是纯函数，`main(argv, io)` 返回退出码而不自己 `process.exit`。
- **监听与 TLS**：`--listen`（默认 `127.0.0.1:0`）+ TLS。**监听非回环地址而不给 `--public-origin` 直接拒绝启动**。`--tls-cert/--tls-key` 成对给出就用运维那份；没给就在 `<数据目录>/tls/` 生成一张自签名的 P-256 证书（私钥 0600，目录 0700，SAN 覆盖监听地址与每个对外来源），并在 `status` 与启动日志里标注**自签名**。证书是手写 DER 拼的（`src/der.ts`），没有引入新依赖，单测拿 `node:crypto` 的 `X509Certificate` 反向解回来验。
- **托管 `apps/web` 产物**：根限定两道——字符串上塌缩（解码、`..`、重复分隔符），以及打开前的 **realpath 复核**（包内指向包外的符号链接只有这一道拦得住）。SPA 回退只接住没有扩展名的路径；带哈希的资产 `immutable`，`index.html` `no-store`；CSP 复用桌面壳的 `shell-core/csp.ts` 并摘掉回环授权（页面与 core 同源），指令集合由单测盯着与桌面壳逐条相同。
- **认证**：沿用 `core/identity` 已有的配对票 → 可撤销凭据 → 会话轮转，**不写第二套**。服务器壳自己加的是门（`src/auth.ts`）：回环专用面（`/hook/`、`/control/`、`/rpc/`…）在公网一侧一律 404；Origin 只接受 `--public-origin` 与监听地址自己那个；写方法要求 `x-armadra-csrf` 双提交（密钥由 `IdentityService` 常量时间比），外加「发了 `Sec-Fetch-Site` 就必须是 `same-origin`」；会话 Cookie 是 core 已有的 `__Host-armadra_<hostId>_<access|refresh>`（`HttpOnly; Secure; SameSite=Strict; Path=/`）。设备 token 不进 URL，配对码只进 URL 片段。
- **配对**：`serve` 启动时铸一张两分钟的一次性票并打印 `armadra-server pairing <origin>/#pair=<票>`；POSIX 上 `SIGUSR2` 再铸一张，不必为一台新设备重启服务。
- **`CorePlatform` 的服务器实现**（`src/platform-node.ts`）：不提供 `sealSecret`/`unsealSecret`（落到 core 已有的「keychain 不可用就降级 0600 文件并标注」那条路径）、没有 `resourcesPath`、`openExternal` 是 no-op 并记日志、`notify` 落日志。
- **服务定义**：`install` 只**生成** launchd / systemd / `sc.exe` 定义并记一个 0600 的标记，绝不调用 launchctl / systemctl / sc.exe；`--service-dir` 与 `--run-as` 必须显式给，root / Administrator / SYSTEM 一类账号拒绝；`--env` 名字里带 TOKEN / SECRET / PASSWORD / CREDENTIAL 一类字样是**拒绝**而不是删掉；`uninstall` 只删通得过归属检查的那份文件；`status` 重新渲染一次定义与磁盘上的比字节，报 `matches` / `drifted` / `missing`；`upgrade` 先查文件本身、再查 sha256 校验文件、再在有超时的子进程里查候选自报的身份，**没有 `--confirm` 只打印计划**，替换是旁写改名，失败放回原文件，`--rollback` 回到 `<目标>.previous`。

### 11.2 core 侧的两处接口点

- `core/http/cors.ts` 加了 `allowOrigins(origins)`：回环之外的来源由壳在绑定之后注入一次。判定仍只有 `corsHeaders` 与 `websocketOriginAllowed` 两处，注入的是数据不是第二套规则；桌面壳不调用它。
- `core/main.ts` 的 `RunOptions` 加了可选的 `platform` 工厂：数据目录要等参数解析完才知道，所以给的是工厂而不是对象。不给就是原来的 `nodePlatform`，桌面壳一行不改。

### 11.3 怎么验证

```sh
pnpm --filter @armadra/server test      # 9 个文件 68 例，含装配级用例
pnpm --filter @armadra/desktop test     # 跑之前先 node apps/desktop/scripts/ensure-node-pty.mjs
pnpm --filter @armadra/server typecheck
pnpm --filter @armadra/server build     # esbuild → apps/server/out/main.js
```

装配级用例（`src/serve.integration.test.ts`）真起一次 `serve`（临时数据目录、随机端口、自签名 TLS）并断言：`/health` 200；`index.html` 200 且带 CSP、`no-store`；带哈希的资产 `immutable`；根限定挡住 `..`、编码过的 `..` 与指向包外的符号链接；未认证的 `/api/workspaces` 401；Origin 不在白名单 403；回环专用面 404；配对之后带 Cookie 的请求 200 且 Cookie 带 `__Host-`/`HttpOnly`/`Secure`/`SameSite=Strict`；写方法没有 CSRF 头 403；配对票重放 401；撤销设备之后下一个请求立刻 401。

### 11.4 没做什么

- **R6b（账号与共享）不在本批**：`identity_*` 的表结构一个字节没动，配对出来的设备拿 `allScopes()` 的全量授权。按 principal 编译 scope 的接口点就是 `serve()` 里 `issueBootstrap` 的那一个 `scopes` 参数。
- **R6c 远程浏览器节点、R6d Windows session-host 不在本批**。
- **不注册服务**：`install` 没有 `--register`，也不打算有——「只生成定义」是这条线的硬规则。
- **不自动更新**：`upgrade` 只认运维指过来的本地候选，不下载发布清单（设计里服务器壳本来就是「不自动更新，`status` 报版本」）。
- **`serve` 要求数据目录已经过统一库迁移**（`ARMADRA_CORE=ts` 的单向门），否则拒绝启动而不是自己去过门。

## 12. R6b：服务器账号、组与共享的数据模型与预留

落地的是 [服务器端账号、数据中转与共享](../design/server-accounts-and-sharing.md) 的 §2 数据模型、§3 接口与 §4 五处预留。**功能上今天什么都没变**：桌面壳里只有 owner，判定入口对 owner 恒真，页面看不出区别。变的是此后可以有第二个 principal。

### 12.1 迁移 0019

`apps/desktop/src/core/db/migrations/0019_accounts.sql`：

- `identity_owner`（单行表）→ `identity_principals`（`kind` ∈ owner / member / service），owner 行在同一条迁移里搬过来，`principal_id` 一个字节不变；「只有一个 owner」由 `WHERE kind='owner'` 的唯一索引接住；
- `identity_devices.role` 从 `CHECK(role='owner')` 放开成 `'owner' | 'member'`，外键改指 `identity_principals`。SQLite 改不动 CHECK 与外键，所以设备表整表重建，**会话表跟着重建一次**——删一个还被引用的父表会记下延迟外键违例，改回同名也消不掉，提交时照炸；顺序与理由写在迁移的注释里；
- 新增 `identity_credentials`（口令走 `crypto.scrypt`，KDF 参数逐列存）、`identity_invitations`、`identity_groups` / `identity_group_members`、`identity_grants`、`audit_log`（**无外键**：审计要比它提到的组、授予活得久）；
- 角色 → scope 的编译表**不在库里**，在 `core/identity/roles.ts`：库里存角色名，改权限集合是改一个常量而不是一条迁移。

`core/db/absorb-host.ts` 跟着改：旧 `host.db` 的 `identity_owner` 现在是一次**投影**而不是拷贝（列不同、行的含义相同）。

**这个 worktree 里 `pnpm repo:check` 会报「迁移编号不连续：第 18 个为 19」**——0018 属于并行的另一条线，合并之后这条提示自行消失。

### 12.2 五处预留各在哪儿

| 设计 | 落点                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.1 | `core/http/route-scopes.ts`（路径族 → 权限）+ `Router.requiredScope()`；单条路由可用 `handle(..., { scope })` 就地声明并覆盖表                                                        |
| §4.2 | `core/events/index.ts` 的升级 guard：`allows([scope("events:read", workspaceId)])`，拒绝发生在升级**之前**                                                                            |
| §4.3 | `core/terminal/input.ts` 的 `DriveBook` + `core/terminal/manager.ts` 的 `input()`：写入者 ≠ 会话创建者才要 `terminal:drive`                                                           |
| §4.4 | 同上（设计里 §4 的第 3、4 条合在一处判定）                                                                                                                                            |
| §4.5 | 审计写入点：登录与设备撤销在 `core/identity/service.ts`，授予 / 组 / 凭据变更在 `core/identity/accounts.ts`，审批答复在 `core/agent/routes.ts`，终端接管在 `core/terminal/manager.ts` |

判定入口是 `core/identity/authorize.ts`（`Authorizer`）与 `core/identity/gate.ts`（模块级的门，域们问它，身份域装配时换成真实现）。**owner 恒真**；其余主体按「会话快照 ∪ 编译出来的授予」判。

### 12.3 接口：做实的与 501

全部挂在身份域已有的 `/api/identity/` 前缀下。**与设计的一处偏差**：设计把组写作 `/api/groups`、共享写作 `/api/workspaces/{id}/grants`、审计写作 `/api/audit`；这里是 `/api/identity/{groups,grants,audit}`，因为 `/api/workspaces/*` 属于那张与 Rust Runtime 逐条对账的路由表（契约到 R7），往里加一条 Rust 没有的路由就是让两边对不上。改回设计里的写法时，改的是 `core/identity/accounts-http.ts` 的分发表。

做实：principal 列表 / 新建 / 停用、口令设置与撤销、`POST login`（口令登录，落在同一张 `identity_sessions` 上，授权快照 = owner 全量 / 成员的 `identity:read` + 编译出来的授予）、邀请签发 / 列表 / 接受（一次性、会过期）、组与成员的增删改查、授予的读 / 写 / 撤销（返回编译后的权限名）、审计只读。

501（形状一致的 `{ code: "NOT_IMPLEMENTED", message }`）：passkey 的注册与断言、OAuth 绑定的 start / callback、开放注册（要一个还不存在的 `allowRegistration` 设置）。

### 12.4 验证

`pnpm --filter @armadra/desktop test`（2250 例通过，其中 R6b 新增 43 例：迁移升级、角色编译快照、判定入口、口令派生与参数升级、邀请一次性与过期、审计写入、路由 scope 声明无遗漏，以及 `ARMADRA_CORE=ts` 真起 core 跑通 `/api/identity/principals`、登录与 501 形状）、`typecheck`、`pnpm check`（除 10.1 那条迁移编号提示）。

## 13. R6d：Windows session host 迁到 TypeScript

`crates/session-host`（4,221 行 Rust）迁到 `apps/desktop/src/session-host/`（守护进程）与 `apps/desktop/src/core/terminal/session-host/auth.ts`（握手，客户端与宿主共用）。Rust crate **没有删**，`ARMADRA_SESSION_HOST=rust` 仍然拉得起它；两边说同一条线协议，R7 再删。

**本机没有 Windows，下面凡是标「只能在 Windows 上验证」的，本批一次也没真机跑过。**

### 13.1 协议没有换

线协议原样保留：24 字节头 + JSON 控制帧 + 裸输出帧，`magic 0xA1`，四种 kind，generation / sequence 小端。理由是 R6 之前 `core/terminal/session-host/protocol.ts` 已经按 Rust 的单测向量写成第二个说话人，现在只是第三个说话人（宿主）接到同一条线上——换成别的格式要同时改三处、作废一批已经对过的向量，换来的是零收益。它本来就不是 protobuf，不受 R7 删 `proto/` 影响。

唯一的增量是 `hello` 多了一个可选字段 `auth`。Rust 的 serde 忽略未知字段，所以带着它连 Rust 宿主也不会被拒；TS 宿主则**必须**有它。core 侧按 `ARMADRA_SESSION_HOST` 决定发不发。

### 13.2 管道安全：DACL + SID 换成密钥文件 + 一次性 HMAC

Rust 版用受保护 DACL（`D:P(A;;GA;;;SY)(A;;GA;;;<sid>)`）加每连接 `GetNamedPipeClientProcessId` 核对 SID。`node:net` 两样都够不到：它经 libuv 用默认安全描述符建管道，返回的是 `Socket` 不是 `HANDLE`。

替代方案：`<userDataDir>/session-host.key`（32 字节随机数，0600；Windows 上 `icacls /inheritance:r /grant:r <user>:F`，**收紧失败就拒绝启动**），每条连接的 `hello` 带 `HMAC-SHA256(key, 上下文‖major‖endpoint‖nonce‖issuedAt)`，宿主校验后立即断开不合格的连接。

残余风险三条，写在 `auth.ts` 的头注释里：

1. 证明在 ±60 s 内可重放——前提是能看到管道字节，而那已经是本用户；
2. 宿主只知道对端**能读密钥文件**，不知道它是哪个进程。Rust 版对同一用户的不同进程还能按 SID 区分，这里不能。对「同机另一个账户」这个真正的威胁，两者等价，因为文件的 ACL 就是管道原来那份 ACL；
3. 收紧权限靠外部 `icacls`，没有进程内的 Win32 调用；`icacls` 不在或失败，宿主就不起。

### 13.3 相对 Rust 版的退化

| 项                                  | Rust                        | TS                                                                                 | 后果                                                  |
| ----------------------------------- | --------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 管道 ACL                            | 受保护 DACL                 | 默认描述符 + 密钥文件                                                              | 见 §10.2                                              |
| 客户端身份                          | 逐连接核对 SID              | 逐连接核对 HMAC                                                                    | 同用户的进程之间不再区分                              |
| Job Object `KILL_ON_JOB_CLOSE`      | 有                          | **没有**，Node 无此 API                                                            | 宿主被 `SIGKILL` 时进程树不会被系统带走               |
| 进程树收容                          | Job Object + 按 pid 兜底    | ConPTY 自身 + 退出时逐会话显式关闭（`SIGINT/SIGTERM/SIGHUP/SIGBREAK` 都接）        | 有序退出等价；被强杀时不等价                          |
| 并发闸                              | `first_pipe_instance(true)` | `listen` 的 `EADDRINUSE`（libuv 设了 `FILE_FLAG_FIRST_PIPE_INSTANCE`）+ 锁文件兜底 | 等价，但 libuv 的行为不是 Node 的文档承诺，故加锁文件 |
| `--idle-exit-minutes`               | 有                          | **没有**，argv 只收一个                                                            | 空闲退出固定 30 分钟                                  |
| 日志过滤 `ARMADRA_SESSION_HOST_LOG` | tracing EnvFilter           | 无，全量写 stderr                                                                  | 量很小（每连接一两行）                                |

`useConpty: true` 显式写上（默认会在老版本 Windows 上退回 winpty，而 winpty 不满足「伪控制台活得比壳久」这个前提）。`conptyInheritCursor` **没有**打开：它正是让 ConPTY 先问光标位置再吐字节的开关，不开就少一次在无 UI 时会死锁的握手；`QueryResponder` 仍然保留，因为 CLI 自己随时会问同样的问题。

### 13.4 ConPTY 关闭要阳性证明

`ConsoleSession.close()` 先挂上等待再 kill，等 node-pty 的 `exit`；5 s 内没等到就抛 `CloseTimeout`（带 sessionKey 与等待时长），**不假设成功**。`destroy` 请求在这种情况下回 `error/internal` 而不是 `ok`——行还是会被忘掉，因为客户端不该继续握着一个还应答的 key，但「关掉了」这句话不会被说出口。状态机用假 pty 测了六例（正常关、超时、超时后重试成功、已退出、幂等、退出通知只发一次）。

这正是 §4.3 那条竞态：宿主修不了 node-pty，但可以拒绝**汇报**一次它没看见的关闭，于是泄漏的 conhost 变成日志里一条具名错误，而不是一台慢慢被填满的机器。

### 13.5 构建与拉起

`electron.vite.config.ts` 多一个 target（第六个），产出 `out/session-host/host.cjs`（64 KB，`--external node-pty`）。用的是既有的 `vite build`（底层 rolldown/esbuild），不是单独调 esbuild——`esbuild` 不是这个包的直接依赖，而本批不新增依赖。

拉起：`ELECTRON_RUN_AS_NODE=1 <Electron> <resources>/session-host/host.cjs <userDataDir>`，与 `armadra-hook` 启动器同一套路（打包机器不保证有系统 node）。`electron-builder.yml` 的 Windows 段加了 `extraResources`，`files` 里排除 `out/session-host/**`（必须是磁盘上的真文件）。Rust 的 `armadra-session-host.exe` 仍在列，R7 一起删。

`scripts/sidecar-targets.mjs` 新增 `bundleResources(triple)`，`scripts/sidecar-targets.test.mjs` 拿它和 `electron-builder.yml` 逐条对账——electron-builder 对不存在的 `from` 是**静默跳过**，不对账就查不出改名。

### 13.6 验证

本机（macOS）跑过：

- `pnpm --filter @armadra/desktop test` —— 2,307 passed / 19 skipped；新增 81 例。
- `pnpm --filter @armadra/desktop typecheck`、`pnpm check` —— 全绿。
- `ARMADRA_DESKTOP_EXTERNAL_RENDERER=1 pnpm --filter @armadra/desktop build` —— 产出 `out/session-host/host.cjs`；`node out/session-host/host.cjs /tmp/x --extra` 退 2 并打印「只在 Windows 上运行」。

`server.test.ts` 把**整条协议**在 Unix socket 上跑通（握手四例、建 / 附 / 重放 / 截断告警、写 / 中断 / resize 夹紧、flow 与断连释放、代与冲突、destroy 与关闭超时、退出通知、关停清场），因为除了 ConPTY 与管道命名空间，两端的代码完全一样。

**只能在 Windows 上验证的**，都在 `src/session-host/windows.integration.test.ts`（`skipIf` 非 Windows，或 node-pty 载不起来时带原因跳过）：真 ConPTY 的建 / 跑命令 / 附 / 断 / 重附重放 / destroy / 进程自退 / 关停，以及同名管道上第二个宿主必须 `EADDRINUSE`。CI 的 Windows 矩阵（`windows-latest`）本来就跑 `pnpm -r --if-present test`，这批用例随之进去，不另加 job；预计多花 10 s 上下（每例起一个 shell 并等它说话）。

还没在真机上看过的：`icacls` 收紧密钥文件、`\\.\pipe\` 名字派生的实际连通、ConPTY 的 `exit` 到底多快、以及宿主被强杀后进程树的实际下场。

## 14. R6c：服务器壳上的远程浏览器节点

浏览器节点现在有两套后端，按**这个 core 是怎么被启动的**分：环境里有 `ARMADRA_SHELL_DRIVE_WS` 就是桌面壳，页面是本窗口的一个 `<webview>`，走原来的 `DriveClient`；没有就是服务器壳，core 自己起 headless Chromium（`core/browser/headless/`）。授权三规则、租约状态机、17 个动词与四个错误码两边共用同一份，不同的只是页面在哪。

### 14.1 先做的一步：CDP 动词执行下沉

`core/browser/cdp/` 现在持有允许列表与参数校验、frozen script 表、ref 代际、workspace 路径牢笼，以及 17 个动词的 CDP 调用序列与结果整形。`main/browser` 只剩 Electron 那一半（`webContents.debugger` 的 attach/detach 与事件），`shell-core/browser` 只改了 import 指向。动词里非 CDP 的那部分抽成 `VerbHost`（标签表、暂存下载、文件选择器、对话框），两个后端各实现一份。

`sendCommand(` 仍然只出现在 `main/browser/cdp.ts` 一个文件里，`sole-call-site.test.ts` 的扫描照旧；`Runtime.evaluate` 这串字面量现在只出现在 `core/browser/cdp/allowlist.ts`（拒绝它的地方）。纯搬家，用例原样跟着走。

### 14.2 headless 后端

- **找浏览器**：`ARMADRA_BROWSER_PATH` > 三平台常见的 Chrome / Chromium / Edge 路径。**不做按需下载**（与设计里「或按需下载」的措辞不同，这是本批的决定）：找不到时每个动词回 `browser_unavailable`，`status()` 里带着找过的每一条路径，够运维一条命令修好。配置了却不存在时**不回退**到别的浏览器——那是另一套登录态。
- **启动**：`--headless=new --remote-debugging-pipe`，**全程不开调试端口**（回环上的调试端口等于一扇谁都能走的门），协议走子进程 fd 3/4 的 NUL 分帧 JSON；管道一关 Chromium 就退，所以 core 死了浏览器跟着走，不需要 Job Object。每个节点一个 `<dataDir>/browser-profiles/<nodeId>`，登录态按节点保留。
- **CDP 客户端**：自写，`Target.attachToTarget { flatten: true }` 一条管道跑所有 target；标签就是 page target，页面自己开的窗口被收成标签。
- **画面流**：`Page.startScreencast`（JPEG、quality 60、`maxWidth/maxHeight` 由观看者的框决定），一条 JSON 元数据配一帧二进制，逐帧 `Page.screencastFrameAck`，没有观看者就 `stopScreencast`。`everyNthFrame` **必须是 1**：Chromium 在页面重绘时才发帧，已经加载完的静态页只重绘一次，设成 2 就把唯一那一帧丢掉了——这是真机上量出来的，不是推演。
- **输入**：观看者的输入按「人在操作」处理，发 `humanInput` 事件进原来的 `onShellEvent`，租约转给人、Agent 的下一个动词照旧得到 `LEASE_HELD_BY_HUMAN`。这条路**不走 Agent 的允许列表**（一个人在自己的浏览器里按 q 不是 Agent 行为），但方法面仍然只有四个：`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` 与 `Emulation.setDeviceMetricsOverride`，坐标一律夹进本进程设定的视口。

### 14.3 单观看者：第二个回 409，不接管

`GET /api/workspaces/{workspaceId}/browser/{nodeId}/stream` 在升级之前就判：节点不存在 / 不是浏览器节点 / 不在这个工作空间 → 都回同一个 404（区分开就成了探测别人画布的工具）；桌面壳 → 501；已经有人在看 → **409**。

选 409 而不是接管：这个页面只有一个租约，两个人同时打字时谁都分不清哪一下是自己的；接管还会把正在看的人踢掉，而浏览器节点的全部价值就是「有人正看着它」。扇出被否掉的理由更直白——编码器是贵的那一头，一路扇出就是 N 份 JPEG。

### 14.4 验证

- `pnpm --filter @armadra/desktop test`（2245 通过 / 14 跳过）与 `pnpm --filter @armadra/web test`（2520 通过），两边 `typecheck` 与 `pnpm check` 全绿。
- 假 CDP 端（进程内管道 + 一个会应答的假浏览器）覆盖：目标/标签管理、截屏帧逐帧 ack（包括观看者已经走了仍然要 ack）、输入映射与夹取、单观看者、崩溃后 `guestLost` 与 `isAlive` 转假、被允许列表拒掉的 `Runtime.evaluate`、撤销后再驱动。
- **真浏览器**跑过：`src/core/browser/headless/live.integration.test.ts`，本机 Chrome 153.0.8010.48（`/Applications/Google Chrome.app/…`，Apple Silicon、Darwin 25.6）——起进程到第一个标签 **593 ms**，挂上观看者到第一帧 **52 ms**，`read` 动词读回 `data:` 页面的正文。机器上找不到浏览器时这条用例 `skip` 并打印找过的路径，不是失败。

### 14.5 路由表多了一条

`/api/workspaces/{workspaceId}/browser/{nodeId}/stream` 是 Rust Runtime 没有的（那边没有 headless 后端可流）。它在 `ROUTES` 里带 `beyondContract: true`，对账用例按名字把这类条目剔除后再与 Rust 比对，契约的 163 条仍然逐条相等——放松断言会让下一条溜进来。

## 15. R7c：页面的身份 / 会话 / 事件流 / 更新脱离 `host-client`

R7 要删 `proto/`、`packages/protocol`、`packages/host-client` 与 core 的 `/rpc/*` 兼容面。这一批把页面上除 GitHub 与自动化之外的全部消费者搬到 core 的 JSON 面，并整段删掉写入所有权机制。

### 15.1 写入所有权整段删除

`write_ownership` 那六行记录回答的是「此刻由 Rust Runtime 还是 Go Host 写这个域」。单一 core 里没有第二个写者，这个问题没有第二个答案，所以删的是**机制**而不是某一处调用：

- 前端：`canvas-ownership/`（10 个文件）、`ownership/store.ts`、`{agent,files,git,session,settings}/host-session.ts`、设置页的所有权面板与只读闸 `WriteGuard`、`i18n/ownership.ts`。五个网关（agent / files / git / session / settings）与画布的读写收口成对 core 的直接调用，保存队列的自动变基改用普通的 409 判定。
- core：`http/routes.ts` 删掉 `/api/ownership` 与 `/api/ownership/domains`。它们曾是路由表里唯一「没有任何阶段认领」的两条，`core/main.test.ts` 与 `core/files/install.integration.test.ts` 拿它们当 501 的例子，现在换成 `/api/power`。
- **与契约 §5.1 的偏离**：Rust Runtime 仍注册这两条路由，所以 `routes.test.ts` 里多了一条 `RETIRED` 名单，逐条断言「Rust 有、这张表没有」，其余 161 条仍与 Rust 逐条相等。放松比较会让下一条偏离溜进来；Rust 侧随 crate 在 R7 删除。

### 15.2 身份与会话：`apps/web/src/api/identity.ts`

一个文件持有页面全部的身份凭据，zod 校验、`{ code, message }` 错误信封：

| 动作            | 路径                                                             |
| --------------- | ---------------------------------------------------------------- |
| hello           | `GET /api/identity/hello`                                        |
| 配对            | `POST /api/identity/pair`                                        |
| 当前会话        | `GET /api/identity/session`                                      |
| 轮转 / 换 CSRF  | `POST /api/identity/session/{refresh,csrf}`                      |
| 登出            | `POST /api/identity/session/logout`                              |
| 设备列表 / 撤销 | `GET /api/identity/devices`、`POST /api/identity/devices/revoke` |

`GET hello` 是这一批给 core 补的唯一一条（与兼容面的 `HostService/Hello` 同一份内容）。

**两条认证时序，页面只在一处判断走哪条（`host/native-session.ts::isNativeShell`）：**

- **桌面壳**：页面停在壳的回环 HTTP 静态服务上（端口内核分配），core 在另一个回环端口。Cookie 按 host 不按 port 隔离，所以这条路上不能用 Cookie。打开设置 → 后台服务 → `GET hello` → 页面向 preload 桥要一张两分钟的票（`window.armadra.identity.ticket()`）→ `POST pair` 换回 `{ native: { accessToken, refreshToken } }` → 此后每次带 `Authorization: Bearer`，`credentials: "omit"`，凭据只在内存。
- **服务器壳**：`armadra-server` 启动时打印 `https://…/#pair=<票>`。页面读 `location.hash` 一次、立刻 `history.replaceState` 抹掉片段 → `POST pair`（`credentials: "include"`）→ core 发 HttpOnly Cookie 并在响应体里给 `csrfToken` → 此后所有写方法带 `x-armadra-csrf`（`api/request.ts` 的 `RUNTIME_VIA_SERVER_SHELL` 那条分支）。刷新页面后内存是空的但 refresh Cookie 还在，`POST session/csrf` 换一枚；403 作废一次并重试一次，其余 403 是 core 在拒绝这台设备。

后台服务设置页不再有可填的服务地址：单一 core 没有第二个地址可指。`isHostServed` 更名 `isServerShellServed`，`RUNTIME_VIA_HOST` 更名 `RUNTIME_VIA_SERVER_SHELL`。

### 15.3 事件流：`?cursor=` 续订，并入 `api/events.ts`

`host/event-stream.ts` 那条独立于 `api/events.ts` 的流删除。页面现在记下控制帧 `{"type":"cursor",…}` 报的位置，断线重连时带 `?cursor=<数>`，core 把那一段补发出来。

第一次连上时页面**还没有位置**，而 `cursor=0` 的意思是「把这个 core 发过的一切重放一遍」（保留上限 5,000 条）——那是另一个问题的答案。为此 core 的 `parseCursor` 多认一个值 `now`：不补发任何历史，只在订阅一开始报一次当前水位。升级被拒（`409 SNAPSHOT_REQUIRED` / `CURSOR_AHEAD`，发生在 socket 打开**之前**）时页面放弃续订回到实时订阅——拿同一个数重连只会撞同一堵墙，而重连是按秒退避的。

### 15.4 更新：发布侧暂时没有来源

`host/updates-session.ts`（host-client 的 updates 面）删除。桌面壳那一半照常：staged 包的下载、安装、取消与重启报告都走 `apps/desktop/src/main/updates/**` 的桥。发布侧——「有没有新版本」——**没有来源**：R5 计划里的 `core/updates` 没有写，而 Go Host 的那条面在 `ARMADRA_CORE=ts` 下本来就连不上。所以 `updates/use-update-state.ts` 把发布侧固定报 `blocked: noReleaseSource`，`mergeUpdatesState` 的那条规则照旧成立：**任何一边没回答，都不写「已是最新」**。补上 `core/updates` 之后这里换一个真的来源即可，合并逻辑一行不动。

Go Host 的「对外服务」开关（`/host/external-service`）与它的设置面板一并删除：那是 Host 自己的一条管理路由，服务器壳由运维用 `armadra-server` 起，页面不再是它的开关。

### 15.5 剩下的 `host-client` 引用

GitHub 与自动化两个面由并行的一条线改造。它们依赖的旧接线集中到 `apps/web/src/host/host-client-compat.ts` 一个文件（地址偏好、`hostSessionBlock`、`createHostIdentity`、共享的原生凭据），那条线落地之后整文件删除，`packages/host-client` 随之退出前端。

### 15.6 验证

`pnpm --filter @armadra/web test`、`pnpm --filter @armadra/desktop test`、`pnpm -r typecheck`、`pnpm check` 全绿。新增用例：`api/identity.test.ts`（两条传输各自的凭据、CSRF 只取一次、会话变更只通知一次、`#pair=` 只读一次）、`api/request.csrf.test.ts`（服务器壳那条路上的双提交头与一次性重试）、`api/events.test.ts` 的续订四例、`core/events/outbox.integration.test.ts` 的 `cursor=now` 一例。

## 16. R7a：GitHub 与自动化切到 JSON 面

R7 要删 `proto/`、`packages/protocol`、`packages/host-client` 与 core 里的 `/rpc/*`。删之前页面必须先不再依赖它们——这一批做的就是那一步，前后端一起纵切。形状写在[core 的 JSON 面](../contracts/core-json-api.md)，本节只记事实与偏差。

### 16.1 自动化：载荷从 protobuf 字节改成 JSON

迁移 `0020_automation_json.sql` 给 `automation_plans`、`automation_activations`、`automation_runs`、`automation_receipts` 与 `command_sessions` 各加一个 JSON 列，BLOB 列改可空；SQLite 去不掉 `NOT NULL`，所以这五张表按「建新表 → 搬数据 → 换名字」重建，索引按原名建回去。

迁移本身不解码任何字节（SQL 里没有 protobuf 解码器）。转换由 core 启动时的 `core/schedule/convert-legacy.ts` 做一遍：只碰 `payload_json IS NULL AND payload IS NOT NULL` 的行、一个事务、解不开就整体回滚。跑第二遍什么也不做。**R7 删掉那个文件与那两组 BLOB 列。**

`core/db/absorb-host.ts` 的自动化投影改为投影时就解码成 JSON；`command_sessions` 从「逐列拷贝」变成一次投影，因为旧 `host.db` 那张表的 `launch` 是字节而新表是 JSON。

**摘要换了一个数。** `configSha256` 与 `command_sessions.launch_sha256` 从「protobuf 字节的 SHA-256」改成「规范 JSON（键排序、无空白、UTF-8）的 SHA-256」。直接后果是**已经激活的计划要重新授权一次**；产品未发布，这是可接受的代价，换来的是摘要不再依赖一份 protobuf 序列化器的字段顺序。`convert-legacy.test.ts` 有一条用例就是断言这个数**确实变了**，而不是希望它没变。

### 16.2 三张面上的认证多一条

`/api/github/*` 与 `/api/automations/*` 本来只认会话凭据。问题是页面经 `apps/web/src/api/request.ts` 打这一面，而**桌面壳的会话是原生的**：密钥在壳里，既不发 Cookie 也到不了那个 `fetch`（`HostIdentityClient` 只会发 `/rpc/` 的 protobuf 帧，令牌是它的私有字段）。

所以这两面多一条：**明文回环来源 + 没带任何凭据**时，按本机主人处理（`IdentityService.localOwner`：owner principal + 它最新一台没被撤销的设备）。TLS 的服务器壳上这条路不存在。主人必须是一台真设备——自动化的授权记录要拿它的 epoch 复核，一个编出来的设备标识会让计划在第一次投递时被自己的复核拒掉；找不到设备时答 `unauthenticated`（「还没配过对」）而不是 `forbidden`。

新增 `GET /api/identity/hello`，能力表与 `HostService/Hello` 是同一张。三条新路径在 `ROUTES` 里带 `beyondContract: true`（Rust Runtime 时代 GitHub 与自动化活在 Go Host 的 protobuf 面上），契约内的 163 条仍然逐条相等。

### 16.3 页面：枚举从数字变成名字

`apps/web/src/api/github.ts` 与 `apps/web/src/api/automations.ts` 取代 `HostGithubClient` / `HostAutomationClient`，方法名与参数逐条对得上。`panels/github/**`、`panels/automation/**`、`nodes/AutomationNode*` 里对 `@armadra/protocol` 与 `@armadra/host-client` 的引用全部消失。

两处**行为对使用者可见的变化**：

1. **枚举的值变了**。`GithubIssueState.OPEN` 从 `1` 变成 `"GITHUB_ISSUE_STATE_OPEN"`。读的地方仍然写 `GithubIssueState.OPEN`，但几个 `<select>` 的 `value` 因此是名字而不是序号，而两处按序号取标签的数组改成按名字索引的表——少一项现在是一个读不出来的键，而不是一个悄悄错位的标签。
2. **计划载荷在界面层是文本**。`CreatePlanRequest.payload` 从 `Uint8Array` 变成 `string`，读回来也是原文。编辑一个计划时那段 prompt 不再经过一次编解码。

`bigint` **保留**：Issue / PR 的编号、id 与时间戳都是 64 位，`number` 在 2^53 之上会悄悄改值。线上是十进制字符串，zod 在边界上转回 `bigint`。

### 16.4 四处与任务措辞的偏差

1. **GitHub 的 JSON 面仍然是「一个动词一条 POST」**，没有改成 `GET/PUT/DELETE` 的 REST 形状。理由写在契约 §5.1：读动词的参数是结构化过滤器，塞进查询串要么被截断要么要一层自定义编码。
2. **`automation_payloads` 没有加 JSON 列。** 它存的是用户敲进去的 stdin / prompt 原文，不是 protobuf，而且按内容寻址——换一种表示会改掉所有已冻结计划指向的那个引用。JSON 面把它当 UTF-8 文本读出去（契约 §4.3），库里仍然是字节。它不挡 R7。
3. **`core/identity` 多了一个读方法**（`localOwner`），超出「identity 只加 hello JSON 面」的边界。理由在 §15.2：没有它，这两面在桌面壳上一个请求都答不了。
4. **`apps/web/src/host/{github,automation}-session.ts` 仍然 import `@armadra/host-client`** 的三个类型（`HostIdentityClient` / `HelloResponse` / `HostIdentitySession`）。它们来自 `connection.ts` 与 `native-session.ts`——那两个文件归 R7c，本批不碰。会话仍然负责「能不能打开这块面板」（能力、授权位、那次配对），但面板的每一次调用已经不走它了。

### 16.5 验证

- `pnpm --filter @armadra/desktop test`、`pnpm --filter @armadra/web test`、`pnpm -r typecheck`、`pnpm check` 全绿。
- core 侧新用例：自动化 JSON 面每条路由一条（形状、错误码、匿名回环、两张面对账）、GitHub JSON 面六条（24 个动词齐、工作空间缺席、动词不存在、零值照写、两张面对账、列表不带正文）、Hello 两张面逐字段对账、迁移 0020 + 转换一条（字节行 → JSON 行 + 摘要确实变了 + 跑第二遍无操作）。
- web 侧新用例：两个 api 模块的 zod（`int64` → `bigint`、`bytes` → `Uint8Array`、摊平的 `oneof` → `{ case, value }`、认不出来的枚举名落回 `UNSPECIFIED`）、请求形状（工作空间在查询串、`bigint` 发成字符串、载荷发原文）、错误分档各一条。既有的面板用例改到 JSON 假服务上继续绿。

## 17. R7d-repo：仓库层的收尾

R7d 分两条线：源码层（`apps/desktop/src/**`、`apps/web/**`、删 `packages/protocol` 与 `packages/host-client`）与本节记的仓库层。两条线同时进行，所以本节里的「全绿」指的是仓库层这几道门，不含 `typecheck`——它要等源码层删掉 protobuf 引用之后才可能过。

### 17.1 迁移合成一个目录

`apps/runtime/migrations` 的 0001–0014 搬进 `apps/desktop/src/core/db/migrations/`，字节不变（`migrations.lock` 里的 sha256 逐条对得上，只是键从两个目录并成一个）。之后迁移只有一个来源，0001–0020 一条连续序列：

- `resolveMigrationsDir()` 的查找顺序是 `ARMADRA_CORE_MIGRATIONS_DIR` → 包内 `resources/migrations` → 往上走到检出里的 `apps/desktop/src/core/db/migrations`。`ARMADRA_MIGRATIONS_DIR` 这个名字不再存在。
- `resolveUnifiedMigrationsDir()` 与 `unifiedEnabled()` 删除，`openDatabase` 少一个 `unifiedMigrationsDir` 参数。**单向门留着**：判据从「传没传第二个目录」变成「这批迁移里含不含 15」，过门前照旧 `VACUUM INTO` 一份 `canvas.db.before-ts-core-<时间戳>` 并验证那份副本打得开。已经装了旧版本的机器仍然会第一次经过这道门，所以这段逻辑一个字都不能少。
- `repo.rules.json` 的 `migrations.sources` 收成一条，`reserved` 占位删除；`tools/repo-check.mjs` 里 `reserved` 与 `go-constants` 两个分支随之删除。

### 17.2 删掉的目录与工具

| 删的东西                                                                                          | 行数       |
| ------------------------------------------------------------------------------------------------- | ---------- |
| `apps/runtime/` + `crates/` + `Cargo.toml` / `Cargo.lock`（含 interop 测试）                      | 154,016    |
| `apps/host/`（含 `gen/` 的生成码与 `go.mod` / `go.sum`）                                          | 144,662    |
| `proto/`（22 份 schema + 191 份 fixture）与 `tools/protocol.mjs`                                  | 这一批合计 |
| 写入所有权的 e2e 与 harness（`tools/ownership*`、`tools/canvas-ownership-*`）                     | 同上       |
| Host 的烟囱测试、`tools/github-e2e.mjs` 与它的 mock、Rust↔Go 归档互通                            | 同上       |
| `tools/probes/core-terminal-bench.mjs`（比较两套实现）、`tools/probes/conpty-smoke`（Rust crate） | 同上       |

`tools/probes/` 里另外三个探针（`connection-drag`、`git-tool-window`、`canvas-stress`）**保留**：它们量的是页面，后端只是背景。启动行从 `target/debug/armadra-runtime` 换成 `node apps/desktop/out/core/main.js --data-dir …`，读 `endpoints.json` 的那一段不动（core 写同一个文件的同一段）。

`agent:smoke` 与 `handoff:read-smoke` 一并删除：两者的参数是「受管二进制的绝对路径」，而那两个二进制不存在了。它们验证的事实由 core 各域的用例覆盖，但**真 CLI 的端到端那一层目前没有替代品**——对着 core 的等价脚本要重写，还没有。

### 17.3 打包

这个壳不再有 sidecar 二进制，所以 `stage-binaries.mjs`、`sidecar-targets.mjs`、`prepare-host.mjs` 及其测试删除，`dist.mjs` 从三步变两步。`after-pack.mjs` 自己持有 `bundleResources()`（hook 客户端，Windows 另加 session-host），并新增 `migrationResources()`：把 `src/core/db/migrations/*.sql` 逐个放进 `Resources/migrations/`——正是打好包的 core 找迁移的那个位置。之前谁也没放，打包后的 core 只能靠「往上走到检出」这条开发期路径。

发布侧：组件包（host / worker / hook / session-host 的 tar/zip）与 `package-components.mjs` 删除，`artifacts.mjs` 只剩桌面产物与 `armadra-web_<version>.tar.gz`（服务器壳要托管的那份前端产物）。`version.mjs` 的版本源从 `Cargo.toml` 换成根 `package.json`，另两处是两种壳的 manifest。`compatibility.json` 收成一条 `minimumInstalled`：`protocolMajor` / `minimumProtocolMinor` 曾经必须等于 Go Host 的 `ProtocolMajor`，那个常量不存在了，所以它们现在是 `normalize()` 会拒绝的未知键（有一条用例就断言这件事）。

`verify-linux-glibc-baseline.sh` 保留但换了检查对象：从 `target/release` 里的四个二进制换成 `apps/desktop/release/linux*-unpacked/` 里的 `armadra` 启动器与 asar 外的原生插件（node-pty 的 `pty.node` 与 `spawn-helper`）。原生插件是在 runner 上现编的，所以这条检查仍然是「runner 镜像往前走了」的出声处。

### 17.4 CI

`ci.yml` 删 Rust / Go 的 setup、缓存、`Rust lint`、`Rust 测试`、`Go vet 与测试`、`Go 交叉编译` 与`三端协议契约`。三平台矩阵保留（平台差异在终端域，不在前端），每行跑：`pnpm check`、`pnpm repo:test` / `release:test`、`pnpm -r test` / `typecheck`、`pnpm --filter @armadra/web build`、桌面壳四个 target 的构建。`go_race` 矩阵键随之消失。

`release.yml` 删`构建受管二进制`、`打组件包`、Rust / Go 工具链与缓存、`腾出磁盘`（那是为 `cargo test --workspace` 腾的）、`verify` 里的 `cargo test` / `go test` / `protocol:*`，以及 build 矩阵里只有组件包用的 `triple` 列。Linux glibc 基线保留。

### 17.5 根脚本与规则

根 `package.json`：删 `protocol:*`、`rust:fmt`、`check:rust` 与那批被删脚本对应的入口；`libs:build` 变成只 build `@armadra/shared`；`check` = `libs:build + format:check + typecheck + repo:check + ci:workflows + release:check`。

`armadra.sh`：`doctor` 不再找 cargo / rustc，`install` 不再 `cargo fetch`，`check` 就是 `pnpm check`，`test` 是 shared 构建加 `pnpm -r test`，`build` 只构建前端与两种壳的产物。`run web` 起的是 `node apps/desktop/out/core/main.js`，`runtime_endpoint()` 读 `endpoints.json` 的那段不变——core 写的是同一个文件的同一段。

`repo.rules.json`：根白名单去掉 `Cargo.toml` / `Cargo.lock` / `crates` / `proto`，黑名单去掉 `target/` 与 `apps/desktop/resources/`（两者都不再产生），命名规则只剩 `packages`，`fileSize.extensions` 只剩 `.ts` / `.tsx` / `.mjs` / `.js`，`proto` 段整段删除。`tools/repo-check.mjs` 的 `proto-coverage` 规则与 `readAll()` 随之删除，`RULES` 从 8 条变 7 条。

### 17.6 文档

四份只描述分进程时代的文档移进 `docs/history/` 并在索引里登记为历史：`host-protocol-design.md`、`host-business-migration.md`、`host-native-session.md`、`host-device-auth.md`（最后一份原本在 `guides/`，因为它讲的是 `armadra-host` 这个二进制的命令面）。

`guides/{architecture,development,ci-release,agent-collaboration}.md` 与 `AGENTS.md` 按现状重写，不是加注释：三层结构的中间一层现在写的是 `apps/desktop/src/core`，端口表少了 Host 的 43121、多了迁移目录那一行，检查表里没有 cargo 与 go。`contracts/v3-agent-terminal-plan.md` 只在抬头多一行说明执行服务已经换成 core，§N 编号与正文不动。

### 17.7 四处对账测试换了对面

`core/http/{routes,cors,health}.test.ts` 与 `core/instance.test.ts` 里各有一条断言，对面是 `apps/runtime/` 的源码本身（解析 `.route(...)`、比对 CORS 字面量、health 的字段名、公告前缀的常量声明）。那份源码已删，所以：

- 路由表改成直接钉住契约的 161 条（146 主面 + 15 hook 面）与四条 `beyondContract`，退休的两条 ownership 路径按名字排除。**数字现在就是契约**，不再有第二处可比。
- CORS、health、公告前缀三处保留断言本身，去掉「再去读一遍对面源码」那一半。`ANNOUNCE_PREFIX = "armadra-runtime instance "` 现在只写在 `instance.ts` 一处：它是线上字面量，已装的壳按字节匹配，名字里那个词只是历史。

### 17.8 验证

在本线的 worktree 里跑（源码层的 R7d-core 尚未合入，所以 `packages/protocol` 与 `packages/host-client` 此刻还在）：

| 门                                                                                   | 结果                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `pnpm check`                                                                         | 全绿（format / typecheck / repo / CI / 版本） |
| `pnpm repo:check`                                                                    | 通过，7 条规则                                |
| `pnpm ci:workflows`                                                                  | 通过，两份工作流                              |
| `pnpm release:check`                                                                 | 通过，三处版本一致                            |
| `node --test apps/desktop/scripts/*.test.mjs`                                        | 38 条通过                                     |
| `node --test tools/release/*.test.mjs tools/ci/*.test.mjs tools/repo-check.test.mjs` | 70 条通过                                     |
| `pnpm --filter @armadra/desktop test`                                                | 2560 通过 / 18 跳过                           |
| `pnpm --filter @armadra/server test`                                                 | 68 条通过                                     |

`pnpm --filter @armadra/desktop dist`（macOS arm64，无签名证书，打包器按计划跳过签名）产出 `Armadra-0.1.0-arm64.dmg` 与 `-mac.zip`。包内 `Armadra.app/Contents/Resources/` 里属于我们的东西只有四样：

```
app.asar                       壳 + core + 渲染进程
app.asar.unpacked/…/node-pty/  pty.node 与 spawn-helper（唯一的原生模块）
cli/armadra-hook.js            hook 客户端
migrations/                    0001–0020，20 个 .sql
```

没有任何 sidecar 二进制——这正是 R7d 要的形状。`after-pack` 逐个打印了它放进去的 21 个文件。

## 18. R7d-core：源码层面删掉 protobuf、`/rpc/*` 与 Rust / Go 进程

分支 `feature/host-protocol-foundation` 的 worktree，七个提交。这一节只记 core 与
页面这一半；删目录、CI、打包脚本与 `repo.rules.json` 是并行的 R7d-repo 那一线。

### 18.1 两个域各自有了自己的类型

自动化与 GitHub 两块的形状原来由 `proto/armadra/v1/*.proto` 说了算，类型来自
`packages/protocol` 的生成码。现在：

- `core/contract/message.ts` —— 字段表，以及照着它做的三件事（造一份、编成
  JSON、从 JSON 读回来）。写成一张表而不是几百个手写函数，是因为这两个域有几十
  种记录，而三件事各只该有一份实现。线上的形状仍然是 [core 的 JSON
  面](../contracts/core-json-api.md) §2。
- `core/schedule/types.ts`、`core/github/{types,schema}.ts` —— 这两个域的类型与
  字段表。**枚举的值就是它的名字**（`"GITHUB_ISSUE_STATE_OPEN"`），所以编码这
  一步没有一张会对错的映射表；`int64` 仍然是 `bigint`。

**内部摘要换了算法。** 激活摘要、投递摘要、收据摘要与 GitHub 状态映射存进库里的
那份字节，原来都是 protobuf 序列化的 SHA-256，现在是**规范 JSON 的 UTF-8** 的
SHA-256——和配置摘要在 0020 那次换掉的理由一样（契约 §4.2）：一个只有 protobuf
序列化器才算得出来的数不能是「这条记录」的身份。直接后果与那次相同：**升级之后
已经激活的计划要重新授权一次**，已存的状态映射读不回来。产品未发布。

### 18.2 三张 `/rpc/*` 面删除

`/rpc/armadra.v1.{AutomationService,GithubService,HostService,IdentityService}/*`
连同 `schedule/rpc.ts`、GitHub 的 24 方法表与帧上限检查、身份的八方法表一起删掉。
能力表只在 `GET /api/identity/hello` 上。协议版本与帧上限搬进
`core/identity/protocol.ts`——只剩一端，它们住在报它们的那个域里。

`schedule/convert-legacy.ts`、store 里读 protobuf BLOB 的那一支、以及
`db/absorb-host.ts` 对自动化实体的投影与命令会话的解码一并删除。那两个 BLOB 列还
在表上（已发布的迁移不改），但没有任何一条路径再去读它们。

### 18.3 路由表只说四件事

`path` / `methods` / `surface` / `implemented`。`feature`、`phase`、
`beyondContract` 三列与 `routes.test.ts` 里逐条对着 Rust 源码的对账都是迁移期的
东西：那时候有两个实现，表得说清每条路由归谁、哪一批写、哪几条是对面没有的。
没写的路由仍然答 501，正文改成「未实现：<路径>」，和一个拼错的 URL（404）仍然
分得开。

统一库迁移（0015 起）不再看 `ARMADRA_CORE`：没有第二个读者会因为「这条迁移本
构建不认识」而拒绝启动。单向门与应用前的备份照旧。

### 18.4 壳只起 TS core

`main/runtime-process.ts` 剩下一条路：`fork` 出 `out/core/main.js`，SIGTERM 停
它，「接管上一个还活着的 core」那一段照旧（命令行标记从二进制名改成
`core/main.js`）。`ARMADRA_CORE` 开关、Rust 二进制的探测与 stdin 上那帧 protobuf
控制帧一起删掉。

`main/host/**` 与 `shell-core/host/**` 整目录删除；core 私有通道取票那一半搬到
`main/core-ticket.ts` 与 `shell-core/ticket.ts`。退出只剩一步：core 确认停了才
退。端点里的 `hostBase` 去掉——core 就是全部，两个 base 本来就是同一个。
`ARMADRA_SESSION_HOST` 的 `rust` 分支删掉，会话主机只剩 TS 那一个。

### 18.5 页面

`host/host-client-compat.ts` 与 `host/proxy-session.ts` 两个垫片删除。GitHub 与
自动化两块面板直接打 `api/identity.ts`（`identityHello` / `resumeIdentity` /
`hasSessionCapability` / `permits`）。`tlsRequired` 与 `sameOrigin` 两档拒绝理由
连同文案一起去掉：它们描述的是一个填错的 Host 地址，而那个输入框已经没有了。

`packages/protocol` 与 `packages/host-client` 两个目录删除，锁文件跟着更新。
`packages/shared/src/host-events.ts` 一并删除——它投影的是 Go Host 的 protobuf
事件信封，页面里没有第二个消费者。

### 18.6 留给别人的两件事

- `apps/desktop/electron.vite.config.ts` 的 `BUNDLED_WORKSPACE_PACKAGES` 还写着
  `@armadra/protocol`。那个文件在本线的边界之外，没有动。
- `main/updates/updater.ts` 还有一个 `host` 依赖（装更新前停 Host）。装配处已经
  传了一个永远为 `null` 的实现，那条分支不再触发；真正拆掉它连着
  `shell-core/updates` 的几个函数，留作单独一批。
