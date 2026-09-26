# TypeScript Core 实施进度

> 本文只记已验证的事实：跑过的命令、量到的数字、当场看见的结论。目标设计在 [TypeScript Core](../design/typescript-core.md)，不在这里。
> 每条结论后面跟的是复现它的命令。

## 1. 阶段状态

| 阶段   | 范围                                                                                                                                                                                                                                                                                              | 状态                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **R0** | core 进程骨架、三种监听、`/health`、SQLite 账本                                                                                                                                                                                                                                                   | 已合入（`6f2207dd4`）                                    |
| **R1** | 画布 / 工作空间 / 设置 / 身份、统一库迁移                                                                                                                                                                                                                                                         | 已合入（`e7cbaf38c`）                                    |
| **R2** | 终端域：tmux 纵切、direct / sessionHost、SSH、GC                                                                                                                                                                                                                                                  | 已合入（`00d551f71`）                                    |
| **R3** | Hook 面、Agent / 协作、TS `armadra-hook`                                                                                                                                                                                                                                                          | 已合入（`00d551f71`）                                    |
| **R4** | Git、文件 / 导入导出、定时与事件 outbox                                                                                                                                                                                                                                                           | 已合入（`9131d4f59`）                                    |
| **R5** | 语言服务、GitHub / 资源 / 用量、浏览器授权与租约                                                                                                                                                                                                                                                  | 已合入（`9131d4f59`）                                    |
| **R6** | 服务器壳（R6a）、账号与共享（R6b）、远程浏览器（R6c）、Windows session-host（R6d）                                                                                                                                                                                                                | 全部已合入                                               |
| R7a    | GitHub 与自动化改打 JSON 面（R7 的前置）                                                                                                                                                                                                                                                          | 已合入                                                   |
| R7c    | 页面的身份 / 会话 / 事件流 / 更新脱离 `host-client`                                                                                                                                                                                                                                               | 已合入                                                   |
| R7d    | 收尾：删 Rust / Go / proto 与 `/rpc/` 面，CI、规则、打包与文档收口                                                                                                                                                                                                                                | 全部已合入；发布干跑六目标 + 公证 + 汇总全绿（§17、§18） |
| 补齐轮 | 2026-09-25/26 两批：远端执行主机 Worker 与补齐（§34、§44）、冷启动与防休眠（§35）、依赖编排（§36）、编辑器节点（§37）、搜索 / 文件树 / 语言授权 / Projects（§38）、浏览器与状态徽标（§39）、快捷键与更新器（§40）、在线设备与编辑租约（§41）、账号与共享（§42）、节能休眠（§43）、零散缺口（§45） | 全部已合入                                               |

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

### 9.1 2026-09-20 打包验收：动词家族在装出来的应用里跑通

在 `pnpm --filter @armadra/desktop dist` 的产物里，用独立数据目录与独立 CLI 配置目录（`ARMADRA_DATA_DIR`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`COPILOT_HOME`）跑了一遍真 CLI（Claude Code 2.1.260、Codex 0.155.1）。**单测全绿不等于装出来的应用能用**——下面五处都只在打包运行时才看得见，每一处都补了用例：

| 现象                                                                                         | 原因                                                                     | 修复                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| 新建菜单里没有任何 Agent，只能开普通终端                                                     | `GET /api/agents` 没有 handler，页面拿到 501                             | `core/agent/list.ts`                      |
| 安装集成后技能永远「未安装」，集成状态永远不完整                                             | `registerSkillInstaller` 这个接缝没有人填                                | `core/collab/skill.ts`                    |
| 画布终端里 `armadra-hook` 是 command not found，三族动词都够不着                             | `childEnvironment` 的 `hookBin` 所有调用点都没传                         | `core/terminal/install.ts` 启动时写启动器 |
| `context terminal`、`canvas interrupt`、`canvas close`、定时投递一律答「终端域还没有装配好」 | `setTerminalBridge` 没有人调用                                           | `core/terminal/bridge.ts`                 |
| 上下文动词的拒绝全变成 `(500) 核心处理 hook 请求时失败`                                      | 桥没有接 `Refusal`（`browser` 家族的分发器是返回拒绝的，所以只有这一族） | `core/agent/hook-bridge.ts`               |

另有两处会话身份问题：同一个 `session_key` 下的两行会话（重启后被接管的旧 pane + 这期间新开的会话）会被对账同时复活，接管又按无序的 `SELECT` 取行，于是「节点当前的会话」是随机的；空文本的粘贴在 tmux 后端走 `load-buffer` 报 `no buffer`，路由答 500。

跑通的：tmux 与 direct 两个后端的建/输入/resize/粘贴/Ctrl-C/十万行输出/颜色/中文宽字符/断开重附；`Cmd+Q` 后 tmux 会话存活并在重开后重附（同一个 shell pid）；`context list | summary | terminal`、`canvas list | post | inbox | ack | link | rename | interrupt | sticky --dry-run | handoff-read`、`browser read` 的拒绝；交接 prepare → accept → 收件箱通知 → `handoff-read`；会话索引（真实 CLI 目录下 1,974 条）。

**当时仍然没有的**：`GET /api/agents/{id}/models` 与 `GET /api/models/catalog` 仍是 501，所以节点头的「模型」子菜单开出来是空的；`agents.probes` 没有写者。两处都在 §19 补上了。

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

## 19. 模型目录与 CLI 版本探测

§9.1 记的那两处缺口补上了：三条路由不再是 501，`agents.probes` 有写者了。

### 19.1 三条路由

| 路由                               | 答什么                                                         | 位置                    |
| ---------------------------------- | -------------------------------------------------------------- | ----------------------- |
| `GET /api/models/catalog`          | 内存里那份目录：来源、抓取时间、年龄、能算价的模型数、全部条目 | `core/models/index.ts`  |
| `POST /api/models/catalog/refresh` | 现在就抓一次 models.dev，然后答同一个文档                      | 同上                    |
| `GET /api/agents/{agentId}/models` | 那个 CLI 的模型菜单，每条注明来源                              | `core/models/agents.ts` |

形状与页面的 zod 一致（`packages/shared/src/api/models.ts` 的 `modelCatalogSchema`、
`api/agents.ts` 的 `agentModelListSchema`），所以页面一个字节都没改：

```jsonc
// GET /api/models/catalog
{
  "source": "cache",            // network | cache | builtIn
  "fetchedAt": "2026-09-20T…",  // 从没抓到过时缺席
  "url": "https://models.dev/api.json",
  "ageHours": 3,
  "pricedModels": 21,
  "refreshError": "offline",    // 只有刚刚那次刷新没成时才有
  "models": [{ "provider": "anthropic", "modelId": "claude-opus-5", "name": "Claude Opus 5",
               "cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 },
               "limit": { "context": 200000 }, "releaseDate": "2026-05-01", "reasoning": true }]
}

// GET /api/agents/claude/models
[{ "id": "opus", "label": "opus", "source": "cli" },
 { "id": "claude-opus-5", "label": "Claude Opus 5", "source": "catalog", "releaseDate": "2026-05-01" },
 { "id": "haiku", "label": "haiku", "source": "builtin" }]
```

三条决定：

- **抓不到不是失败的请求。** 刷新答 200，`refreshError` 说明原因，其余字段仍然
  描述内存里那份能用的目录。一个错误状态码会用「什么都没有」顶掉它。
- **刷新有冷却**（60 秒）。冷却期内返回当前这份、不算失败；后台那趟一天一次，
  只有数据过期了才真的去抓。同时到的两次刷新共用一次抓取。
- **网络是惰性武装的。** 装配只读 `<dataDir>/models-catalog.json`，第一次有人读
  目录才武装定时器，第一抓在那之后 10 秒；定时器 `unref`。理由和用量域那条一样
  （`core/usage/index.ts`）：core 被大量集成测试反复拉起，一个每次装配都发请求的
  循环会去下载没人看的东西。

菜单的拼法（`core/models/agents.ts`）：CLI 自己说的 → models.dev 该 provider 的条
目（按发布日期倒序）→ 离线兜底，去重后分三档排序。CLI 那一档只有两个来源——
`claude --help` 里 `--model` 说明中被引号括起来的别名，和 `${CODEX_HOME:-~/.codex}/config.toml`
里顶层与每个 `[profiles.*]` 的 `model`（**只读**，从不写用户的配置）。
opencode / pi / omp 没有目录那一档：替它们猜一家 provider 会列出这个账号用不了的
模型。拼好的列表按 `(适配器, 启动程序)` 缓存 10 分钟，目录刷新时作废。

### 19.2 版本探测

`core/agent/probe.ts`，缓存写进 `settings.agents.probes[<agentId>]`（设置的
`normalize` 不碰这一节，所以它跨重启活着），24 小时过期，**换了启动程序就重探**。
六个内置适配器加用户的 `custom:` 条目都探，自定义条目探的是它自己的启动程序——借
基础适配器的版本等于替一个从没被问过的二进制作担保。

- **失败是一个单独的答案。** 程序不在、起不来、超时 → `status: "failed"`；跑起来
  了但没打印出可认版本 → `status: "ok"`、`version: null`（我们确实问到了）。
  `resolveAgentCapabilities` 据此把有版本门槛的能力判成 unknown，界面不画按钮。
  `CAPABILITY_MIN_VERSION` 仍然是空表，所以今天探测只提供「问不出来 → 不承诺」这
  一半，没有任何能力因此改变。
- **不阻塞装配。** 装配只武装一个 `unref` 的 3 秒定时器，扫描在后台跑；
  `GET /api/agents` 永远读缓存，一次列表不等任何子进程。探不到只是少一条缓存，
  挡不住启动。
- 除了 `--version` 什么都不执行：不过 shell、不带用户 argv、stdin 关掉、8 秒截止、
  64 KB 输出上限，跑的是 `resolveCommand` 找到的那个绝对路径。

### 19.3 没做的

- 目录里的价格**还没有**接进成本计算：`core/usage/cost.ts` 仍然只用内置表，所以
  `pricedModels` 报的是「内置表 ∪ 目录里带价格的条目」去重后的数——目录那一半今天
  只用于模型菜单与上下文上限的展示。接价格要改用量域，不在本批边界内。
- Copilot 的 `github-copilot` provider 条目留在目录里（`KEPT_PROVIDERS` 有它），
  但 `copilot --help` 列不列模型没有验证过，所以它的 CLI 那一档是空的。

## 20. 路由表收口与四处可用性缺口（2026-09-20）

对着 `pnpm --filter @armadra/desktop dist` 的产物跑的（独立数据目录
`/tmp/armadra-polish`，独立 `CLAUDE_CONFIG_DIR`），每一条结论后面是当场看到的数字。

### 20.1 路由表：28 条没有标记 → 12 条真 501

`ROUTES` 的 `implemented` 是手写的，而它是页面用来分辨「该等」还是「该改」的
唯一依据。真起 core 逐条打之后，28 条里只有 16 条需要动：

| 类别                                                | 条数 | 结论                                                                                        |
| --------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------- |
| 终端域（`/api/terminals*` 九条 + 工作空间会话一条） |   10 | 早就答得出来（`terminal/install.ts` 的 `route()`），只是没打标记 → 补标记                   |
| hook 面 `/context-link/{verb}`、`/control/{verb}`   |    2 | `HookServer` 构造里就注册了 → 补标记                                                        |
| `/api/power` 四条                                   |    4 | 真的 501 → 本批做实（§20.2）                                                                |
| `/api/ssh/askpass/prompts` 两条                     |    2 | **故意**留 501：助手走自己的 0600 socket，这两条路径从来不在 HTTP 面上（`remote/index.ts`） |
| `/automation/*` 十条（hook 面）                     |   10 | 真的 501，本批不做：全仓库没有任何调用者                                                    |

打包产物上逐条 `curl` 的结果（摘）：

```
GET  /api/terminals/backend            -> 200 {"effective":"tmux","tmuxVersion":"3.7b",…}
GET  /api/terminals/no-such-session    -> 404 not_found
POST /api/terminals                    -> 400 bad_request（缺少 workspaceId）
GET  /api/power                        -> 200
GET  /api/ssh/askpass/prompts/x        -> 501 未实现：/api/ssh/askpass/prompts/{promptId}
GET  /api/not-a-route                  -> 404
```

**防止再漂移的是两条用例**，不是这张表本身：`core/main.test.ts` 起一个真 core，
逐条断言「写着已实现的都有人接」且「答得出来的都打了标记」；`hook/server.test.ts`
对 hook 面做同一件事。一条路由有三种装法——`router.handle`、等升级的
`server.stream`、整段接管前缀的 `server.raw`（GitHub / 自动化 / 身份那三张 JSON
面）——三种都算，所以 `Router.claimed`、`CoreServer.streamed`、
`CoreServer.rawHandled` 是为这条用例加的。

### 20.2 `/api/power`：保持唤醒的租约

`core/resources/power.ts`。抑制机制是一个**子进程**：macOS `caffeinate -i`，
Linux `systemd-inhibit --what=idle:sleep --mode=block`，Windows 上 Node 够不到
`SetThreadExecutionState`，如实报 `unsupported`（租约照记，`blockedBy:
"unavailable"`）。

三条规矩：进程只在有**生效**租约时存在（起停只发生在 `settle()` 一个函数里）；
被策略挡下的申请照样回一条 `active: false` 的租约，因为「为什么跑一半睡过去了」
要有地方查；租约有 TTL（默认 300 s，上限 3600 s），没人续就到期消失，`stop()`
在 core 退出时清场。策略四档是递进的：`never` ⊂ `agentSessions` ⊂ `automation`
⊂ `manual`。

打包产物上看到的：

```
POST   /api/power/leases            -> 200 active:true   …  pgrep caffeinate = 1
POST   …/{id}/renew                 -> 200 createdAt 不变、expiresAt 后移
POST   …/nope/renew                 -> 404 No such power lease
POST   /api/power/leases {source:x} -> 400 source must be session, automation or manual
DELETE …/{id}                       -> 200 holding:false …  pgrep caffeinate = 0
```

快照里的电源那一段（`GET …/resources`）现在读的是同一本租约簿，不再恒空。

### 20.3 会话列表：一个节点一行

节点每重启 / 回收一次就多一行 `terminal_sessions`，打包验收里同一个节点出现四次、
三次是死的。面板问的是「这个节点现在在跑什么」，只有一个答案：**活着的那一行**，
一行都不活就是**最新那一行**（重附会接上它）。

打包产物上：同一个节点建三个终端、终止前两个 → 库里三行，`GET
/api/workspaces/{id}/sessions` 报一行，且是第三个。

### 20.4 错误文案：页面按 `code` 取，`message` 只兜底

core 的 `{ code, message }` 里 `message` 通篇中文，页面原样 toast 出去，英文界面
上就冒出一句中文。`apps/web/src/api/request.ts` 现在按 `code` 查
`i18n/errors.ts`（`not_found` / `forbidden` / `bad_request` /
`method_not_allowed` / `conflict` / `payload_too_large` / `unavailable` /
`not_implemented` / `internal` / `unsupported` / `unsupported_on_remote`，外加
GitHub 面的 `UNAUTHENTICATED` 等七个大写码），认不出的码才落回原话。

代价是具体度：`bad_request` 的原话常常说得出是哪个字段。原话没有丢——
`RuntimeRequestError.coreMessage` 留着它。这是唯一的出口，所以 toast、错误横幅
与设置页三处一次性都跟着变。

打包产物的渲染进程里：两种语言的串都在 chunk 里，整个界面切到英文后设置页
逐行是英文。

### 20.5 对话索引的范围

命令面板原先列出 `~/.claude/projects` 下**所有**项目的标题（这台机器上 1,974
条）。新设置 `conversations.scope`（默认 `workspaces`，可切 `all`）让扫描按本
应用登记的工作空间根目录过滤，判定用的是每条转录自己记下的 `cwd`——mtime 没动
的文件按库里那一行的 `cwd` 判，所以收着扫也不重新打开文件。

范围外的行被**清掉**而不是留在库里等 `LIKE` 扫到；切回 `all` 下一趟自己长回来。
打包产物上（造了两条转录，一条 cwd 在工作空间里、一条在外面）：

```
all        -> {"scanned":1432,"indexed":1431,"total":1432}  两条都在
workspaces -> {"scanned":1,   "indexed":0,   "removed":1431,"total":1}  只剩里面那条
```

### 20.6 目录价格进本地成本

`priceFor` 现在按**内置 → 目录 → 未定价**三级回退（`PriceLookup` 收一张表或一列
表，每张表都先按原名、再按去掉日期的名字查完才轮到下一张）。内置表仍在最前：
同一台机器算出的数字不能因为一次抓取而变。目录那一级是个**函数**，所以刚抓回来
的价格下一趟扫描就算得上。

打包产物上，抓完 models.dev（129 个模型 / 120 个带价格）之后：

```
目录才有价的: gpt-6-astra $1965.40, gpt-5.6-sol $603.41
unpriced 只剩 codex-auto-review 与四个 deepseek —— 它们的 provider 不在
KEPT_PROVIDERS 里，目录本来就没有它们，仍然只显示 token。
```

### 20.7 验证

`pnpm --filter @armadra/desktop test`、`pnpm --filter @armadra/web test`、
`pnpm -r typecheck`、`pnpm check` 全绿。

## 21. core 进程的常驻内存

空闲的 core 曾经占 **141 MB**（Node 26 自己的基线是 51 MB），一次成本扫描把 RSS 顶到 **2.8 GB** 再落回 788 MB。`heapUsed` 全程不到 15 MB —— 大头从来不是「还被引用着的对象」，而是**走了一趟就再也没还给系统的页**。所以这一节记的每一个数字都配着 `rss / heapTotal / heapUsed / external / arrayBuffers` 五个数，只看一个会得出相反的结论。

复现：起 `node apps/desktop/out/core/main.js --listen tcp:127.0.0.1:0 --data-dir <临时目录>`（HOME 保持真实），空闲 60 s → `POST /api/usage/cost/refresh` → `POST /api/conversations/refresh` → 开一个终端再关 → 再空闲 60 s；`ps -o rss=` 每 100 ms 采一次，各阶段之前先 `HeapProfiler.collectGarbage`。

### 21.1 前后

本机数据：`~/.claude/projects` 1.0 GB / 1,393 份 JSONL，`~/.codex/sessions` 3.7 GB；两棵树合起来 **5.0 GB / 2,823 个文件 / 158 万行**，对话索引 1,974 条。

| 时点               |       之前 |     之后 |
| ------------------ | ---------: | -------: |
| 绑定完成           |   143.3 MB |  88.6 MB |
| 空闲 60 s          |   143.6 MB |  88.9 MB |
| 成本扫描之后       | 2,805.9 MB | 218.4 MB |
| 成本扫描的**峰值** | 2,823.9 MB | 218.4 MB |
| 对话索引刷新之后   | 2,808.1 MB | 202.2 MB |
| 开一个终端 / 关掉  | 2,768.2 MB | 204.4 MB |
| 再空闲 60 s        |   787.7 MB | 143.9 MB |

任务书给的数据条件是「1 GB / 1,378 份」，也就是只有 `~/.claude` 那一棵。同一份代码在那个条件下（`CODEX_HOME` 指向空目录）：

| 时点            |     之后 | 目标     |
| --------------- | -------: | -------- |
| 空闲 60 s       |  90.5 MB | ≤ 90 MB  |
| 成本扫描之后    | 130.2 MB |          |
| 之后再空闲 60 s | 109.8 MB | ≤ 110 MB |

**两个目标在任务书写的数据条件下达到了；在这台机器的真实数据量（5 GB，其中 3.7 GB 是 `~/.codex/sessions`）下空闲达到、扫描后的 218 MB 没达到。** 差的那一段全部来自多出来的 4 GB / 120 万行——见 §20.4。

### 21.2 大头是谁：四处，全部是**瞬时**分配

堆快照的前十大保留者从头到尾都是同一批（`UsageService` 4.0 MB、`CostService` 4.0 MB、`ScanState` 3.9 MB、几个 Map 各 1 MB 上下），加起来不到 15 MB，**它们不是问题**。把每一层单独剥出来量（读 5 GB、逐行切、解码、`JSON.parse`、去重）才看得见钱花在哪：

| 改动                                                                     | 依据（同一趟 5 GB 扫描）                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `usage/cost.ts`：整段追加 → 256 KiB 按块读                               | 峰值 2,824 MB → 566 MB                                       |
| `usage/cost.ts`：**每块一个 carry Buffer** → 半行留在同一个缓冲区里挪    | 416 MB → 77 MB（剥出来单量；这一项一个人值 340 MB）          |
| `usage/cost.ts`：每个文件一个 256 KiB 缓冲区 → 全程共用一个              | 507 MB → 470 MB                                              |
| `conversations/scan.ts`：每个文件一个 `Buffer.alloc(512 KiB)` → 共用一个 | 一千九百多个文件 = 半个 G 的外部分配                         |
| 装配时无条件建对话索引 → 第一次有人读才建                                | 启动 141 MB → 90 MB，启动也快 1.1 s                          |
| 逐行 `JSON.parse` → 先在**字节**上找 `"usage"` / `"model"`               | 158 万行里只有 14 万行需要解析                               |
| 去重集合存 request id 原文 → 存 53 位摘要                                | 七万多个 id：二十多兆 → 两三兆；`heapUsed` 14.9 MB → 12.6 MB |

那个 carry 是整件事里最贵也最不显眼的一处：`Buffer.from(tail)` / `Buffer.concat([carry, tail])` 每块各一次，五千兆就是**两万次几 KB 的分配**，`heapUsed`、`external`、`arrayBuffers` 三个数全程看不出异常，只有 RSS 在涨。把同一个循环里这两行换成 `copyWithin`，其余一个字节不动，RSS 从 416 MB 掉到 77 MB。

### 21.3 排除掉的嫌疑

都量过，都不是：

- **`node:sqlite` 的页缓存 / mmap**：把 `CLAUDE_CONFIG_DIR` 与 `CODEX_HOME` 指向空目录，启动 RSS 是 88.3 MB，和带着 5 GB 记录时的 88.6 MB 一样——库、迁移、`PRAGMA` 都不在这条曲线上。`canvas.db-wal` 那 4 MB 是磁盘，不是常驻内存。没有为此改任何 `PRAGMA`。
- **对话索引常驻内存**：它本来就只落 SQLite，`listConversations` 每次按 `LIMIT` 查；1,974 行不在内存里。贵的是**建它那一趟**，不是留着它。
- **资源采样、事件 outbox、语言服务探测缓存**：采样是订阅制的，空闲时循环根本不存在；outbox 落表；语言服务在第一个会话打开之前不起任何东西。空闲 60 s 的 RSS 只涨 0.3 MB，这三处都没有在跑。
- **`ws` 连接缓冲**：空画布没有连接。
- **模型目录**：129 条，落磁盘缓存，装配时不联网。

剩下 88 MB 的空闲底座里，Node 26 自己是 51 MB，`heapUsed` 7.6 MB，`external` 4.8 MB；其余约 25 MB 是这个 2 MB 的包被编译出来的代码与元数据。要再往下走得拆包按域懒加载，那是另一件事。

### 21.4 还卡在哪

5 GB 那一列里成本扫描之后的 218 MB，减掉空闲的 89 MB 是 129 MB，来源是**每次 core 重启都要把两棵树从头读一遍**：`ScanState` 的偏移量只活在内存里。单独剥出来量，5 GB / 158 万行走一遍最省的实现也要 77 MB，再加上 14 万行 `JSON.parse`（约 54 MB）就是这个数。

要把它按下去只有两条路，两条都改语义，所以本批没走：

1. **只扫 30 天窗口以内的文件。** `summarize` 本来就把更旧的桶全丢掉，所以看板的数字一个都不会变；变的是 `result.current`（一台 30 天没用过 CLI 的机器会失去 `currentSession`）。
2. **把每个文件的偏移量落库。** 重启之后就只读追加的那一段，第一次之后近乎免费；代价是增量状态从「进程内的缓存」变成「要迁移、要对账的持久数据」。

另外：`LINES_PER_YIELD` 数的是**解析过**的行，按字节过滤之后一块里可能一行都不解析，所以 `eachAppendedLine` 每读完一块额外让一次路——不然一个几百兆的文件会把事件循环占住。

### 21.5 守门的用例

不是性能断言（那种在 CI 上必然抖），是结构断言：

- `usage/cost.test.ts`：扫过一个带两兆正文的记录之后，`ScanState` 能碰到的**所有**字符串加起来不到 4 KB，且不含那段正文；每个文件留下的桶数跟着 (日期 × 模型) 走而不是跟着行数走（两千行 → 一个桶）；去重集合里每个元素都是 `number`；一条比读块还长的行仍然被完整读出来。
- `conversations/conversations.test.ts`：没有人读过索引时表是空的；`refresh` 之后 `ensureIndexed` 不再走第二趟；共用的那个读缓冲区不会把上一个文件的字节漏进下一个（长 → 短、短 → 长两个方向各一次）。
- `agent/install.integration.test.ts`：真装配一次 core，`conversations` 表在任何人读之前是空的。

## 22. Agent 投递阶段 B：目标状态机与驱动租约（2026-09-20）

设计是 [Agent 之间的推式投递与终端驱动](../design/agent-delivery.md) §4、§6 与 §11 的「阶段 B」那张表。这一节只记做出来的形状与量到的结果；`send`、队列与 `outbox` 是阶段 C，不在这一批里。

### 22.1 租约状态机提到了中立模块

`core/drive/lease.ts` 是那台状态机本身：四个状态、四个 `LEASE_*` 码、代次，以及「持有者续期不换代次」。两个域共用**代码**，各自持有**实例**与常数——`browser/lease.ts` 现在只剩三样东西（两个时间常数、把它们绑上去的 `LeaseMachine`、浏览器措辞的 `leaseRefusal`），其余原样转出去，导入路径一个都没改。

| 常数                 | 浏览器 | 终端 |
| -------------------- | -----: | ---: |
| `HUMAN_IDLE_SECONDS` |     10 |   10 |
| `AGENT_IDLE_SECONDS` |     30 |  120 |

常数**不进**共用模块：那里没有默认值可以让人写错，窗口由各域在构造时传进去。

提取正确的判据是设计定的那一条：`browser/lease.test.ts` 一行不改仍然全过。跑过：`pnpm --filter @armadra/desktop exec vitest run src/core/browser` → 12 个文件 152 个用例全绿。

### 22.2 五态是投影，不是表

`core/agent/target-state.ts`，纯函数，无 I/O：

```ts
targetState(status: AgentStatus | undefined, live: number | undefined): TargetState
```

`live` 是终端域那边的 PTY 代次。三条容易读错的规矩落在这个文件里而不是散在调用点：`error` 归 `idle`（一轮失败结束了也是结束了）；`restored` 的 `idle` **不算** idle，走 `starting` 的路径（§4.1、Q4）；`observed` 与空 `stateSource` 也不算 idle——此时对这个节点一无所知，要不要放行由 §4.3 的启发式与 `--unverified` 决定，不在这里悄悄放过去。

没有 hook 的 CLI 那条启发式也在这个文件里（`observedQuiet`，`OBSERVED_QUIET_MS = 2000`），只用已有的输入围栏与输入 / 输出时刻，不解析提示符、不识别 OSC。它**只用于降级**，本阶段没有任何调用者。

### 22.3 终端有了驱动租约

`core/terminal/drive.ts` 挂在终端域，判据用的是已有的那条输入路径（`TerminalManager.noteInput` 旁边的 `noteDrive`），不新增观测：

| 触发                          | 结果                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| 人在终端敲一个键              | 人立刻拿到租约（抢占）；Agent 的下一次写入收 `LEASE_HELD_BY_HUMAN` |
| 人停手 10 秒                  | 租约自然过期，广播一帧 `free`，Agent 又能驱动                      |
| 人按「接管」                  | `humanTakeover`：Agent 收 `LEASE_REVOKED`，**不自动恢复**，写审计  |
| Agent 写完一条                | 它的租约保留 120 秒                                                |
| 另一个 Agent 在这段时间里写入 | `LEASE_HELD_BY_AGENT`                                              |

三处实现细节值得记：

- **`driver` 缺席就不碰租约。** 今天 `bridge.write`（协作动词与计划投递借的那条路）没说自己是谁，行为与这一批之前一字不差；阶段 C 的 `send` 会显式带上自己的 Agent 身份。
- **人敲键永不失败。** 人在自己的终端前面打字是他自己的事，因为一把软租约把一次按键弹回去是给用户造一个他无法解释的故障；Agent 那一侧该拒还是拒。
- **扫一遍。** 「停手十秒自动恢复」必须在没有任何输入的情况下发生，所以 `sweepDrives()` 每秒跑一次；接管没有过期窗口，扫不到它——那正是它与抢占的区别。

代次落 `terminal_sessions.drive_generation`（迁移 `0022_terminal_drive.sql`，已记进 `migrations.lock`）。它与 `generation` 是两个数：后者是 PTY 代次，会话被回收时变；驱动权换手时 PTY 一动不动。回收会**忘掉**租约（那个进程没了），代次不回头。

### 22.4 事件与界面

第 23 个 `WorkspaceEvent`：`terminal.lease`，与 `browser.lease` 同形状（`packages/shared/src/api/drive.ts` 现在是两边共用的那一份 zod，`browserLeaseSchema` 是它的别名）。契约 §5.4 约束的是**已有那 21 个的名字**，不禁止新增；守清单的那个用例跟着从 22 改到 23。

节点头的徽标是一个独立小组件 `apps/web/src/nodes/DriveBadge.tsx`，由终端节点通过 `headerChips` 挂上（`NodeShell.tsx` 没有改）。空闲不画任何东西：「没有人在驱动」是常态，画出来只是噪音。状态只从事件来，不按「我刚才敲过」推断——两台设备看着同一个终端时，各自推断会得到两个答案。

### 22.5 留给阶段 C 的接口（本阶段只提供，不调用）

```ts
// core/terminal/manager.ts
driveTarget(nodeId: string): DriveTarget;      // 五态 + 租约持有者 + drive_generation
writeSubmit(sessionId, generation, text, driver?): Promise<void>;  // 一次 write
driveLease(sessionId): Lease;
takeoverDrive(sessionId, actor, principalId?): Lease;
releaseDrive(sessionId, actor): Lease;
```

`writeSubmit` 的全部意义是那个拼接**只有一处**：`PASTE_START + sanitizePaste(text) + PASTE_END + "\r"` 必须是同一次 `write`，否则多行正文会一行一行地自己提交出去（§11 阶段 C 的风险项）。用例直接断言写出去的那个字符串的形状。

### 22.6 验收

真 core、真 PTY、真事件流，自己的实例（`ARMADRA_DATA_DIR=/tmp/armadra-phase-b`，`--listen tcp:127.0.0.1:0`），跑完即按 PID 关掉并清理：

- 库：`migrations` 21 条（1–20 与 22，0021 是并行的另一条线），`terminal_sessions` 第 19 列是 `drive_generation`。
- 脚本探针：建一个 owner 是节点的终端，从终端 socket 送一个 `input` 帧，事件流当场收到
  `{"type":"terminal.lease","nodeId":"3f7a…","lease":{"state":"human","generation":1,"expiresAt":"…15:26:17.187+00:00","holder":{"kind":"human","id":"probe-device"}}}`；
  停手 11 秒后收到 `{"state":"free","generation":2,"expiresAt":""}`。两帧之间正好是 10 秒的窗口。
- 界面：Vite 开发页连同一个 core，画布上新建一个终端节点，在终端里敲一个字符——节点头当场出现「你在驱动」；停手十几秒后徽标自己消失。

### 22.7 一处已知的红

`0021` 归并行的另一条线（阶段 A 的名字表），本分支里没有它，所以 `pnpm repo:check` 报「迁移编号不连续：第 21 个为 22」，`db/migrations.test.ts` 与 `db/unified.test.ts` 里那两条「连续序列」断言同因失败。两条线合到一起即消失，本批没有为它改任何编号。其余全绿：`pnpm --filter @armadra/web test`（2553）、`@armadra/shared test`（163）、`@armadra/desktop test`（2641 通过 / 2 失败即上述两条）、`pnpm -r typecheck`、`format:check`、`ci:workflows`、`release:check`。

## 23. 推式投递阶段 A：Agent 的名字（2026-09-20）

[Agent 之间的推式投递与终端驱动](../design/agent-delivery.md) 分五阶段，A 独立于其余四阶段。本节记 A 的实测结果；B–E 未实施。

### 23.1 名字从一个隐藏字段抬成产品概念

名字（`handle`）此前只有 `canvas rename --handle` 能写，界面上看不见，唯一性由改名动词自己扫一遍全画布保证。现在：

| 项       | 之前                               | 之后                                                                           |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| 存哪     | `nodes.data_json` 的 `handle` 字段 | `node_handles(board_id, handle)`，`node_id` 唯一；`data.handle` 降为渲染副本   |
| 唯一性   | 一次读-判-写                       | 主键；撞名时整次保存回滚                                                       |
| 谁写     | 只有 `rename --handle`             | `rename --handle`、`link --name-from/--name-to/--name`、页面的命名对话框       |
| 界面     | 看不见                             | 节点头 `@名字` 徽标（没起名就不画）、`···` 菜单的「名字…」、连线落点弹一次命名 |
| Agent 看 | 看不见                             | `ARMADRA_NODE_NAME`、技能文本、`context list` / `canvas list` / 收件箱的每一行 |
| 审计     | 不写                               | `canvas.handle.set`，`{from, to}`                                              |

### 23.2 与设计的两处偏差

1. **表与副本不是两次写，是一次。** 设计 §2.5 第 1 条说「副本与表不一致时以表为准，由一个用例守」。实现里 `saveBoard` 的同一个事务按刚写进 `nodes` 的文档重建这块画布的 `node_handles` 行（`canvas/handles.ts::syncHandles`），所以两者只有一个写入点，不一致这件事不会发生——比「发生了以表为准」更强。`canvas/handles.test.ts` 的最后两条守的是这个。
2. **跨画布移动今天走「删掉再建」。** `saveBoard` 的 upsert 带 `WHERE nodes.board_id = excluded.board_id`，不让一行被另一块画布抢走，所以设计 §2.5 第 3 条的「换 `board_id`」在这套装配里是两次保存。名字仍然跟着节点走，落点已经有人叫这个名字时拒绝而不是静默改名。

回填的日志那一条没做：迁移是 SQL，没有 logger。撞名的输家由用例断言（`db/names-migration.test.ts`），不靠日志追溯。

### 23.3 验证

- `pnpm --filter @armadra/desktop test`：172 个文件、1,906 条，全过。
- `pnpm --filter @armadra/web test`：256 个文件、2,560 条，全过。
- `pnpm -r typecheck`、`pnpm check` 全绿。
  真机验收跑在一个独立实例上（`ARMADRA_DATA_DIR=/tmp/armadra-phase-a`、临时工作空间、自己的 Chrome profile 与 `--remote-debugging-port=9495`，跑完按 PID 清理，不碰操作员自己的数据目录）。页面是应用自己的首页，两个 Agent 节点真的起了 Claude 与 Codex 的 CLI。逐条结果：

| 步骤                            | 结果                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| 命名对话框，默认值是最小空位    | `source=claude-1` / `target=codex-1`                                                  |
| 节点头徽标                      | `source@claude-1` / `target@codex-1`                                                  |
| `context list` 看得见对方的名字 | `- target 类型=terminal 名字=codex-1 id=… 可读：转录与终端画面`                       |
| `canvas list`                   | 两行都带 `名字=`                                                                      |
| `canvas post --to codex-1`      | 命中；收件人 `inbox` 的那条带 `fromHandle: "claude-1"`                                |
| `ARMADRA_NODE_NAME`             | 改名后新起的会话里 `echo "NODE_NAME=[$ARMADRA_NODE_NAME]"` 回显 `NODE_NAME=[codex-1]` |

**没验到的一条：从把手拖一条线出来。** 这套 CDP 夹具里拖拽落不成边，而仓库自带的 `tools/probes/connection-drag.mjs` 在**未改动的代码**上同样 0/3（按下那一刻指针确实在把手上，松手在目标节点内，边数仍是 0）——是夹具或 Chrome 侧的既有问题，不是本批引入的。所以验收里那条边改用 `canvas link` 建，命名对话框走节点菜单里的「名字…」——它与拉线落点是同一条 `requestNodeNames` 通道，只是入口不同。拉线那条入口由 `canvas/flow/use-flow-nodes.test.ts` 的用例守。

## 24. Agent 投递阶段 C：`send` 与投递队列（2026-09-21）

设计是 [Agent 之间的推式投递与终端驱动](../design/agent-delivery.md) §3、§4.6、§7 与 §11 的「阶段 C」那张表。阶段 B 留下的三个接口（`driveTarget` / `writeSubmit` / 租约）这一批第一次有了调用者。

### 24.1 三个动词，一条门链

`VERBS` 从 14 个变成 17 个：`send` / `outbox` / `cancel`。HTTP 面不用改——`/control/{verb}` 是一条通配路由，动词表在协作域，`armadra-hook canvas <verb>` 的客户端也从不校验动词名。

门链在 `core/collab/control/send.ts`，顺序是「从便宜且与此刻无关，走到贵且只在此刻成立」：

| 段         | 判什么                                | 拒绝码                                                           |
| ---------- | ------------------------------------- | ---------------------------------------------------------------- |
| 连线       | 目标在调用者自己的链接文档里          | `NOT_LINKED`                                                     |
| 资格       | 同工作空间、双方 `contextLink`、scope | `NOT_LINKED` / `TARGET_NOT_TERMINAL` / `DRIVE_DENIED`            |
| 正文       | 控制字符、2000 字符、幂等键           | `BODY_TOO_LONG` / `KEY_CONFLICT`                                 |
| 失控闸     | 环、跳数、每边 10 秒、一轮四个目标    | `LOOP_DETECTED` / `RATE_LIMITED`                                 |
| 会话与前台 | 有活着的会话，前台仍是它声称的 Agent  | `TARGET_GONE` / `TARGET_NOT_AGENT_PANE`                          |
| 五态       | `idle` 投，其余排队或拒绝             | `TARGET_BUSY` / `TARGET_STARTING` / `TARGET_AWAITING_APPROVAL`   |
| 状态来源   | `observed` 与空不满足空闲门           | `TARGET_STATE_UNVERIFIED`（`--unverified` 才走 `observedQuiet`） |
| 租约       | 人在打字、人接管、别的 Agent 在驱动   | `LEASE_HELD_BY_HUMAN` / `LEASE_REVOKED` / `LEASE_HELD_BY_AGENT`  |

前五条之外的那几条**出队时重跑一遍**，而且是同一段代码：`attempt()` 既是 `send` 的后半段，也是出队泵唯一调用的东西。一条排了两分钟的指令，投出去时世界早就不是它入队时的样子了——连线可以被删掉，能力位可以被关掉。环与跳数不重跑：那是消息自己的属性，入队时是什么出队时还是什么。

回执按 `outcome` 分支，不解析文案：

```json
{"ok":true,"protocol":"armadra.delivery.v1","outcome":"delivered","id":"…","traceId":"…","traced":"file","targetState":"idle","bodyChars":24,"hops":1}
{"ok":true,"protocol":"armadra.delivery.v1","outcome":"queued","id":"…","queuePosition":1,"expiresAt":…,"reason":"LEASE_HELD_BY_HUMAN","targetState":"idle"}
{"code":"TARGET_AWAITING_APPROVAL","message":"…","retryable":false}
```

`reason` 是排队回执里新增的一项：设计给了「忙就排队」，但**为什么**排队是调用者唯一能据以决定「等还是改用 post」的信息，而它正好就是 `agent_send_queue.last_reason` 那一列。拒绝体里的 `retryable` / `retryAfterMs` 走 `Refused.detail`，由 hook 桥摊平在 `{code, message}` 旁边——一个要靠解析中文句子才能知道该退避多久的调用者，没有退避，只有猜测。

### 24.2 队列是一张表，容量与插入是同一条 SQL

迁移 `0023_agent_send_queue.sql`，字节记进 `migrations.lock`。

一条 `send` 不管投没投出去都在这张表里留一行：直接投出去的落 `done`，排队的落 `queued`。不是记账癖——`--key` 的幂等要对**两种**结果都成立，而「已经投过了」的证据只能来自一张表；出队重跑门链时走的也是同一行。幂等在速率闸**之前**回答：一次重发不是一次新的投递，撞上 `RATE_LIMITED` 的话「同 key 同正文重发是安全的」这句话就不成立了。

两处并发只能靠 SQL：

- **容量**：`INSERT OR IGNORE … SELECT … WHERE (SELECT COUNT(*) …) < 16`，与 `mailbox.ts` 同一手法。用例并发投二十条，十六条进队、四条 `QUEUE_FULL`。
- **串行**：`UPDATE … SET state='delivering' WHERE state='queued' AND NOT EXISTS (… state='delivering' …)`。同一目标同时只有一条在投。

速率、扇出与来源链都**不落盘**（`core/collab/send-limits.ts`）。重启后窗口重来、链清空，最坏是多放行一条；而一个能活过重启的环，第二跳一样会被拦下。

### 24.3 出队由事件驱动，两种事件

不轮询队列。触发有两个，第二个是真机上撞出来的：

1. `agent.status` —— 目标报了一条状态。同一条事件同时回答「谁的一轮结束了」（发起者的扇出计数清零）与「谁空出来了」。
2. `terminal.lease` 的 `free` —— 人抢占之后停手十秒，租约自己过期。**目标那一侧此时什么都不会报**（它本来就空闲着，没有新的一轮），只听状态事件的话「停手十秒后自动投进去」会等一个永远不来的事件。这条是验收第三步当场卡住才发现的，有一条同名用例守着。

唯一的定时器是每 60 秒一次的过期清扫，它做的是相反的事：让一条永远等不到 idle 的排队项有明确的死亡时刻。

`agent_deliveries`（迁移 0006）重新有了写者，`agent.delivery` 事件同批发出去。同一个理由的重复等待只记一次：一条排了两分钟的指令会被每一次 `agent.status` 试一遍，每次都记一行的话，连线上那一下闪动说的就不再是「发生了一件事」而是「泵跑了一圈」。

### 24.4 验收：真 Claude Code、真 Codex、真 PTY

`ARMADRA_DATA_DIR=/tmp/armadra-phase-c`、`--listen tcp:127.0.0.1:60916`，画布上一个 `planner`（真 Claude Code）与两个 `codex-1` / `codex-2`（真 Codex 0.155.1），三条连线。跑完按 PID 关掉并删掉数据目录。

| 步骤 | 结果                                                                                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①    | Claude 自己执行 `armadra-hook canvas send --to codex-1 --body "在当前目录建一个 a.txt，内容写 hello"`，回执是 `queued`（那一刻 `codex-1` 还没报过第一条状态）；它报出第一条 `done` 的瞬间队列自动出队，Codex 开了一轮并写出了 `a.txt`（内容 `hello`） |
| ②    | 同一条走完了「忙→排队→空闲→自动投」的整条路；重启 core 之后排队项还在，但 `restored` 的 `done` 不算新鲜 idle，等到一条真上报才投——与 §4.1、Q4 一致                                                                                                    |
| ③    | 人在 `codex-2` 里敲半行（走 WebSocket 的 `input` 帧，页面用的那条路）→ 回执 `queued` + `reason: LEASE_HELD_BY_HUMAN`；停手十秒后租约过期，正文自动投进去并开了一轮                                                                                    |
| ④    | `codex-2` 停在 `blocked` 上，三种参数组合各试一次：默认 `queued/TARGET_AWAITING_APPROVAL`、`--no-queue` 409、`--interrupt` 409（连 `ESC` 都没发）。终端上那个问题**没有被回答**，composer 一个字节没变                                                |
| ⑤    | `planner → codex-2` 投成之后，`codex-2 → planner` 当场 `LOOP_DETECTED`：「已经在这条消息的来源链里（planner → codex-2）」                                                                                                                             |
| 附   | 紧接着再投同一条边 → `RATE_LIMITED`「3 秒后再来」；`canvas outbox` / `cancel --id` 都答得对                                                                                                                                                           |

三处与设计脚本的偏差，都记在这里：

1. **④ 的权限提示是上报出来的，不是 Codex 自己弹的。** 手上这台机器的 Codex 在几种写法下都没有弹出权限对话（它直接跑或直接用散文反问），所以那一条 `PermissionRequest` 是用**真的 `armadra-hook` 客户端**、真的 hook socket、真的归一化路径送进去的——除了「谁触发了它」之外每一段都是真的。屏幕上那个未被回答的提问是真的。
2. **⑤ 在第二跳就被拦下，不是第四跳。** 设计 §7 写明「环……这比跳数更早生效」，而两个节点互投的环在第二跳就闭合了。规则没变，脚本那句话描述的是一条更长的链。
3. **界面那一半没做。** 节点头的「排队 N」、连线上的闪动、顶部通知条都是 §10 / 阶段 E 的活；这一批只发事件（`agent.delivery`）。

一处已知的糙：③ 里人的半行还留在 composer 里，Agent 的正文接在它后面粘了进去（`我在打半行--- ARMADRA MESSAGE …`）。租约只回答「现在轮到谁」，不回答「那一行清干净了没有」；`InputSafety.pending` 知道这件事，但设计没有把它接到 `send` 的门链上，这里也就没接。

### 24.5 两处已知的红

`0021` 归并行的另一条线（阶段 A 的名字表），本分支里没有它，所以 `pnpm repo:check` 报「迁移编号不连续」，`db/migrations.test.ts` 与 `db/unified.test.ts` 里那两条「连续序列」断言同因失败。两条线合到一起即消失。其余全绿：`@armadra/desktop`（2691 通过 / 2 失败即上述两条）、`@armadra/web`（2553）、`pnpm -r typecheck`、`format:check`。

## 25. Agent 投递阶段 E：界面那一半，加上连线的角色（2026-09-21）

设计是 [Agent 之间的推式投递与终端驱动](../design/agent-delivery.md) §10 与 §11 的「阶段 E」那张表里**界面**那一行（尺寸与 `node.created` 的聚焦已在另一批落地）。阶段 C 结尾记的「界面那一半没做」到这里做完了，另外补上用户当场提的连线角色。

### 25.1 三条路由，两条是页面第一次够得到队列与租约

| 路由                                          | 答什么                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/workspaces/{id}/deliveries?node=`   | 那个**目标节点**还排着的队（不带正文），与不带 `node=` 的投递记录是同一条路径的两个切片 |
| `DELETE /api/workspaces/{id}/deliveries/{id}` | 目标那一侧的人拒收一条还在排的；`delivering` 收不回来，答 `cancelled:false`             |
| `POST /api/terminals/{id}/drive`              | `{action:"takeover"\|"release"}`，人显式接管与交还                                      |

`agent.delivery` 事件多了一个可选的 `code`，`outcome` 多了一个 `refused`：在这之前只有 `delivered` / `queued` / `unknown` 上过事件流，于是 `LOOP_DETECTED` 只有发起者读得到——而发起者是**没有人在看**的地方，环里的两个模型各自读到一句「这是一个环」，画布前面的人什么都看不到。帧里只有码，那句中文不上界面。

### 25.2 界面按码分支，计数按 core 的答案

- **「排队 N」**（`nodes/DeliveryQueueBadge.tsx`）：数字从上面那条只读路由重取，**不按事件加减**——队列会因为出队、取消、过期三种原因变短，自己推算迟早会与那张表说两个数。事件只说「这个节点的队伍动了」。队空不画；点开逐条列出谁排的、排第几、为什么还没投出去，每条都能拒收。
- **「接管 / 交还」**（`nodes/DriveBadge.tsx`）：租约镜像抬成 `agent/drive-store.ts` 的一份，节点头与命令面板读同一个答案。
- **连线**：一次投递让那条边闪两秒（`anim-delivery-flow`，`prefers-reduced-motion` 由 tokens.css 统一压掉，压掉之后线仍然高亮），`<title>` 里说最近一次的结果与时刻。
- **通知条**：`LOOP_DETECTED` / `RATE_LIMITED` / `TARGET_AWAITING_APPROVAL` 在顶部说一次，去重、计数、可关闭，关掉之后五分钟内不再来。文案按 `i18n/errors.ts` 的 `error.delivery.*` 码表取。
- **命令面板**：对选中的终端节点给「查看投递队列」与「接管 / 交还」；队列那条打开的是节点头上已经有的那个浮层，不另画一份列表——两份列表就会有两份「取消」。

### 25.3 连线分对等与主从

用户当场加的一条：一条边现在有 `role: "peer" | "supervises"`（`source` 是主，`target` 是从），缺省与对等同义。主从边用品牌色、**只画一个指向从的箭头**，`<title>` 写「主 @a → 从 @b」；节点头主画「主 · N 从」，从画「从 @主」，主被删掉之后画「主已离开」——那不是「没有上级」，是上级刚刚消失。拉线落点的命名对话框多一档角色（默认对等），从菜单点「名字…」与 Agent 自己建的边都不问：那里没有人可以回答这个问题。

头部徽标多到一行放不下时折成一枚「···N」，数的是**渲染出来的 DOM** 而不是传进来的子元素——一个 `return null` 的组件仍然是一个子元素。折起来的那些只隐藏不卸载：它们各自还在订阅事件。

写这一节时 core 的连线记录还没有这个字段，页面按约定的形状读，用 fixture 测。

### 25.4 验收：真 core、真 PTY、真 Claude Code 与真 Codex

`ARMADRA_DATA_DIR=/tmp/armadra-phase-e`、core 听 `127.0.0.1:59499`、页面是应用自己的首页（Vite 开发页连同一个 core）、新 profile 的 Chrome 开在 `--remote-debugging-port=9499`。跑完按 PID 关掉并删掉数据目录与 profile。

| 步骤 | 结果                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①    | `planner`（真 Claude Code）执行 `armadra-hook canvas send --to codex-1 …` → 回执 `delivered`，Codex 当场开了一轮并写出 `/tmp/a.txt`（内容 `hello`）        |
| ②    | 趁 `codex-1` 忙再投两条 → 节点头出现「排队 1」「排队 2」，点开列出「planner · 第 1 位 · 12 字 / 刚刚 · 目标正在一轮里」，每条带「拒收」                    |
| ③    | `codex-1 → planner` 当场 `LOOP_DETECTED`，顶部出现一条「「codex-1」向「planner」的投递被拦下：这两个节点在互相投递，已经停下」，带「看看这两个节点」与关闭 |
| ④    | 人在 `codex-1` 里敲一个键 → 节点头翻成「你在驱动」并出现「交还」；按下之后租约回到 `free`                                                                  |

三处与脚本的偏差：

1. **壳没起来，用的是 Vite 开发页。** 桌面壳在这台机器上反复起不出自己的 core（页面停在「本地服务已断开」，数据目录里连 `endpoints.json` 都没写出来），同一份 `out/core/main.js` 手动跑起来一切正常。那是壳装配的问题，不在这一批的改动面上，所以验收照阶段 B 的做法改用开发页 + 独立 core，其余每一段都是真的。
2. **连线上的闪动没在真机上拍到。** 用 API 直接写进画布文档的那条 `link` 边在 React Flow 里没有渲染出来（两端节点都在、投影也把它投出来了），与阶段 A 记的「拖拽落不成边」是同一类夹具问题。闪动与 tooltip 由 `LinkEdge.test.tsx` 在真的 React Flow 上守着。
3. **④ 撞出一个真 bug 并修掉了。** 人的抢占记在**敲键那条 socket 的设备 id** 上，而「交还」来自同一个人的另一条路（HTTP）；按 `local` 去交还被状态机当成「放别人的租约」，按钮于是什么都不做。现在这条路认的是当前持有者——这台壳前面只有一个人，他敲键和他按钮是同一个人；Agent 的租约不在此列。

### 25.5 一处已知的红，不是这一批的

`packages/shared` 的 `test/usage-dashboard.test.ts` 有一条失败（`costSummarySchema` 现在要求 `ranges`，那条用例的夹具还没跟上），来自基线上的 `2af95490`，与本批无关。其余全绿：`@armadra/web`（264 个文件 2,608 条）、`@armadra/desktop`（core 1,942 条 + 脚本 38 条）、`@armadra/server`、`pnpm -r typecheck`、`pnpm check`。

## 26. Agent 投递阶段 D：收件箱唤醒、带任务启动与连线的主从（2026-09-21）

设计是 [Agent 之间的推式投递与终端驱动](../design/agent-delivery.md) §5、§8 与 §11 的「阶段 D」那张表；连线的主从是这一批追加的需求，设计文档里还没有它。

### 26.1 收件箱唤醒：一条提示，同一条队列

`post` 的失效方式不是「消息丢了」，是**没有人来读**：一个停在空闲提示符上的 CLI 不会自发去调 `inbox`（§1.3）。所以目标进入 `idle` 而信箱里还有未读时，core 往 `agent_send_queue` 里塞一条 `origin = 'mailbox-wake'`。

| 项                          | 落点                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| 三档 `data.agent.inboxWake` | `off` 不做 / `notify` 投一行提示 / `deliver` 直接投最早那条未读的正文                 |
| 缺省                        | **`notify`**（设计 §5 写的是 `off`，见 25.5 的偏差一）                                |
| 同一批未读只提示一次        | 进程内记「已经为哪一批提示过」（那一批里最大的 `sequence`），外加五分钟窗口内的幂等键 |
| 署名                        | `from: Armadra 收件箱 (<目标 id>)   via: 收件箱`——它不是一次 Agent 之间的对话         |
| `deliver` 不替人 `ack`      | ack 的意思是「我接下了」；应用替人 ack 会让交接状态变成谎话                           |

三条边界照设计：共用队列、共用容量、共用串行门、共用整条门链（人在打字就等，停在权限提示上就不写）；TTL 一样五分钟；`deliver` 读了不算确认。

唯一加的一条是触发点。设计只说「进入 idle 时」，而一条投进**空闲**节点收件箱的消息不会让那个节点报任何状态——它本来就空着。只听 `agent.status` 的话，唤醒要等到它下一次跑完一轮，而那正是它最不需要被提醒的时刻。所以 `post` 落库即推一下泵（`CollabContext.nudge`，注入而不是 import：泵在 agent 域装配）。

### 26.2 带任务启动：第一条任务与第二条任务是同一条路

`--prompt` 删掉了，不是修好了。它今天整段丢失（§1.4 第一层），而修好它要同时修四处，只为保住一条本来就绕远的路。

`canvas open-agent --agent codex --task '…'` 现在做四件事：建节点（启动行**不带任何提示词**）、从发起者建一条 `supervises` 边与两份链接文档、把任务作为 `origin = 'first-task'` 的排队项入队、等新节点报出第一条真正的 idle 由出队泵投进去。`--prompt` 过渡期等价并带 `warning: "--prompt 已更名为 --task"`。同批补上 `--permission-mode` 与 `--model`：页面用 `agent` 字段重拼启动行，字段不在，拼出来的就是一条什么都没带的裸线。

### 26.3 启动参数表的两处错（§8.2 E1/E2）

`launchCommand` 从原样的 `custom:foo` 查 `PROFILES`，而那张表里没有这个键——于是每一个自定义 Agent 都掉进位置参数分支。base 是 Copilot 的那个本该拿 `--interactive`，拿到的是裸位置参数，也就是 `-p`：非交互，跑完就退出。现在传 `settings`、走 `baseAgent`，与 `planLaunch` 同一条解析。

`promptMode` 此前在 core 的 `CustomAgent` 上根本不存在，settings 读进来时还会把这个字段丢掉（重写设置文件就抹掉它）。补上之后 `stdin-after-start` 有了它唯一的意思：这条提示词不上启动行。六个内置项本身三方一致，由 `launch.test.ts` 的一条用例守着；指南那张表补了 `promptMode` 列。

### 26.4 连线分主从

一条边到 0023 为止只回答「有没有」。有了 `send` 之后这个答案不够用：把一段文字打进别人的终端并回车，在「我是你的主」和「我是你的下级」之间不是同一件事。

| 落点         | 形状                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 画布文档的边 | `edges.role`（迁移 `0024`）：`peer` 缺省、`supervises` 表示 `source` 是主、`target` 是从                                    |
| 链接文档     | `ContextLink.role`：`peer` / `main`（它管你）/ `sub`（你管它）——同一条边两端互补的视角                                      |
| `link`       | `--role peer\|supervises`，建边也改已有边的角色                                                                             |
| `open-agent` | 建出来的节点是创建者的**从**：`--task` 本来就是一次自上而下的指派                                                           |
| 从 → 主      | `send` / `interrupt` 回 `UPWARD_SEND_REFUSED`(403)；`post` 那条路一直开着                                                   |
| 主自己开门   | 节点设置 `data.agent.acceptSubDelivery`，默认关                                                                             |
| 模型看得见   | `context list` / `canvas list` 每行 `角色=`，收件箱每条 `fromRole`，`ARMADRA_NODE_ROLE` 给 `main` / `sub`（全对等时不注入） |
| 主没了       | 边随节点级联删除，从的会话一动不动，残留的链接文档照旧被拒而不是崩                                                          |

一条实现上的规矩值得记：**缺 `role` 是「没有意见」，不是「设回对等」。** 画布每挪一次节点就重存整份文档、每动一条边就重推两份链接文档，而页面那一半还没有这个字段——真机上第一次跑，`supervises` 在页面回存的一瞬间就被抹成了 `peer`。`saveBoard` 与 `putContextLinks` 现在对缺席的 `role` 保留库里那个（与白板快照「省略即保留」同一条规矩），重跑后主从活了下来。

### 26.5 三处与设计的偏差

1. **收件箱唤醒的缺省是 `notify` 而不是 `off`。** 设计 §5 那张表写的是 `off`。`post` 今天的失效方式不是「提示太吵」而是「没有人来读」，一个默认关掉、因而没有人会去打开的开关不解决那件事。关掉它仍然是一次设置的事。
2. **「还没报过第一条」与「这个 CLI 没有状态通道」分开了。** 两者在 `stateSource` 上长得一模一样（都是空的），而 `attempt` 先问的是后者——真机第一次跑，新节点刚起 PTY、一行 `agent_status` 都还没有，第一条任务当场被 `TARGET_STATE_UNVERIFIED` 取消，而三秒后同一个节点报出了完好的 `hook` 状态。现在问的是注册表（这个 provider 有没有状态通道），有就排队等它的第一条上报；`TARGET_STATE_UNVERIFIED` 只留给真的没有适配的节点。
3. **界面那一半没做。** 收件箱唤醒的三档开关、主从徽标、连线上的箭头都是 §10 / 阶段 E 的活；core 这一批只把字段与事件备好（边上的字段名就是 `role`，值 `peer` / `supervises`）。

### 26.6 验收：真 Claude Code 2.1.260、真 Codex 0.155.1、真 PTY

自己的一份实例，跑完按 PID 关掉并删干净：`ARMADRA_DATA_DIR=/tmp/armadra-phase-d`、`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 各指一份 `/tmp` 下的副本（**不碰操作员的 `~/.claude` 与 `~/.codex`**，两个 CLI 的凭据是拷过去的）、`--remote-debugging-port=9498`、`--user-data-dir=/tmp/armadra-phase-d-electron`。库里 `migrations` 24 条。

| 步骤 | 结果                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①    | Claude 自己执行 `canvas open-agent --agent codex --title codex-1 --task '在 /tmp 建 b.txt 写 hi'` → 新节点出现、`edges.role = supervises`、两份链接文档一个 `sub` 一个 `main`、队列一条 `first-task` |
| ②    | 那条排队项停在 `TARGET_STARTING` 等着；Codex 报出第一条真正的 idle 的瞬间自动出队，信封 `from: planner … via: planner` 投进去，Codex 开了一轮并写出 `/tmp/b.txt`（内容 `hi`）                        |
| ③    | Claude 的 `context list` 读回 `- codex-1 类型=terminal 角色=从（你管它） id=… `                                                                                                                      |
| ④    | Claude `canvas post --to codex-1` → 空闲的 Codex 终端里当场出现 `from: Armadra 收件箱 … 收件箱有 1 条新消息，运行 armadra-hook canvas inbox 查看。最早一条来自 planner。`，它读了 inbox 并自己 ack   |
| ⑤    | Codex 反过来 `canvas send --to planner` → `「planner」是你的主，下级不能把文字打进上级的终端；用 canvas post 留一条消息… (403)`                                                                      |

两处真机才看得见的事都已经修进代码：25.5 的第 2 条（第一条任务被当场取消）与 25.4 最后一段（页面回存抹平主从）。

一处等的时间比看起来长：④ 里唤醒先答了 `LEASE_HELD_BY_AGENT`——①投完之后 planner 的 Agent 租约还按 `AGENT_IDLE_SECONDS = 120` 压着那个终端，两分钟后租约自己过期、`terminal.lease` 的 `free` 推了泵一下，提示才投进去。这是对的（同一时刻只有一个驱动者），只是设计里没说唤醒也要排在它后面。

### 26.7 一处已知的红

`packages/shared` 的 `test/usage-dashboard.test.ts` 有一条 `ZodError`（`ranges` 缺失），在**未改动的基线上同样失败**，与本批无关。其余全绿：`@armadra/desktop`（2754 通过 / 6 跳过）、`@armadra/web`（2570）、`pnpm -r typecheck`、`pnpm check`。

## 27. Agent 投递阶段 C+：界面那一侧的上下文读取预算（2026-09-21）

设计是 [Agent 之间的推式投递与终端驱动](../design/agent-delivery.md) §10 新追加的两行。core 那一半（真正的摘要、`--since` 游标、读取预算、脱敏、审计表）由另一批落地，这一节只记**界面**这一侧：一个开关、一个徽标、一份线上类型。

### 27.1 一个开关、一个徽标，回答的是同一件事的两端

- **「允许相连 Agent 读取转录」**（`nodes/AgentSettingsDialog.tsx`）：写 `data.agent.contextShare`，开 = `full`（缺省，字段可以不存在），关 = `summary`——关掉不是「读不到」，是对方只拿得到一份 ≤2 KB 的摘要，所以两端都是一句完整的话而不是「删字段」。
- **「被读取 N 次」**（`nodes/ContextReadsBadge.tsx`）：读 `GET /api/nodes/{id}/context-reads`，`total > 0` 才画，悬停列最近五条（谁、什么动词、多少字节、多久以前）。数字来自 core 的审计表，页面不按事件累加。`staleTime` 30 秒，节点折叠或已退出、窗口切后台时不轮询。
- 少了任一半，另一半都没有意义：一个开关如果没有「被读过几次」这个事实，用户没有任何依据决定要不要关它。

设计 §10 那张表里的「节点设置」一行在这之前没有落点——`inboxWake` 与 `acceptSubDelivery` 两个字段 core 早就在读，界面上一直没有入口。这一批顺手把那个家建起来：终端节点菜单的「Agent 设置…」打开一个对话框，三项（收件箱唤醒三档、允许从向我投递、允许相连 Agent 读取转录）都在里面，写入一律走 `canvas-store` 的 `updateNodeData`。

### 27.2 core 还没就绪时，界面当作没有这件事

`contextReads` 的失败（404 / 501 / 连不上）一律不画徽标、不弹提示、不重试：一个还没实现的读取审计不是用户要处理的故障。线上类型在 `packages/shared/src/api/context-reads.ts`（zod，camelCase，`readerName` 可空，只有元数据没有正文——一份「谁读过我」的清单说的是读这件事，不是内容）。

### 27.3 验证

组件测试两份：`AgentSettingsDialog.test.tsx`（三项的默认值与写回，关掉读取写的是 `summary` 而不是删字段，裸终端不开这个对话框）、`ContextReadsBadge.test.tsx`（零次不画、数字取自 core、悬停四要素、最多五条、404/501 静默、可见时 30 秒一次而折叠时不轮询）。

全绿：`@armadra/shared`（29 个文件 163 条）、`@armadra/web`（266 个文件 2,623 条）、`pnpm --filter @armadra/web typecheck`、`pnpm -r typecheck`、`pnpm repo:check`、`pnpm ci:workflows`、`pnpm release:check`。

一处已知的红不在本批改动面上：`pnpm format:check` 对 `apps/web/src/panels/usage/{Heatmap,MetricCards,UsagePanel}.tsx` 报格式问题，这三个文件在本批里**一个字节都没改**，基线 `bc7560c7` 上同样报。

## 28. Agent 投递阶段 C+：上下文读取预算（2026-09-21）

分支 `feature/host-protocol-foundation`，设计 `design/agent-delivery.md` §13。core 这一批做完七条，界面那一半（节点头「被读取 N 次」、`contextShare` 开关）另算。

起因是一句实测：一个 Agent 连着三个节点、各读一次 `context summary`，十几万 token 就进了它的上下文，而它想知道的只有五句话。翻开代码之后发现 `summary` 根本不是摘要——它给的是对方转录**最近 40 条原文**，上限 200 KB，`tool_result` 还是全文。

### 28.1 七条落点

| 条   | 改成什么                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 摘要 | `collab/transcript-summary.ts`（新，纯函数）：名字与五态、最后一条人类提示与助手回复（各截 500 字）、碰过的文件（≤20）、工具调用次数、有没有待审批。≤ 2 KB，不再接受 `-n` |
| 原文 | 默认 20 条、每条 2 KB、`tool_result` 只留工具名/字节数/首行、单次 32 KB；`--full --max-kb <n>`（≤128）才更多；头部写「本次约 N KB ≈ M token」                             |
| 增量 | `transcript --since` 按（读者，目标）记游标 = 转录路径 + 字节偏移；换了文件从头；游标只走到**真交出去**的那一条                                                           |
| 预算 | 每条连线每分钟 64 KB、每小时 1 MB（`collab/read-budget.ts`），超了 `RATE_LIMITED`(429) 并指回 `summary` / `--since`                                                       |
| 脱敏 | `collab/redact.ts`（新，表驱动）：九种凭据形状换 `[已脱敏]`；四个动词的出口共用一处                                                                                       |
| 审计 | 每次读取一行 `context_reads`；`GET /api/nodes/{id}/context-reads` 给最近 N 条与总次数                                                                                     |
| 开关 | `data.agent.contextShare = "summary"` 时只剩摘要，其余 `FORBIDDEN`(403)                                                                                                   |

外加终端画面：默认仍 40 行，上限 400 → 200，去掉 CSI/OSC 转义序列并过同一道脱敏。

### 28.2 四处值得记的取舍

1. **预算落库，不落内存。** `send-limits.ts` 的窗口在内存里，理由是「一个能活过重启的环，第二跳一样会被拦下」。读取相反：一次读取的代价是**读者上下文里的 token**，而那个上下文活过重启、活过页面刷新。所以这一份的和从 `context_reads` 里算。
2. **游标存字节偏移，不存条数。** 转录是追加写的 JSONL，条数要重新解析整份文件才数得出来，偏移一次 `stat` 就对得上。路径是判据的另一半：对方换了 session 就换了文件，偏移在新文件里指的是另一段话。
3. **游标只走到真的交出去了的那一条。** 一开始写的是「走到文件尾」，那样一次超预算的 `--since` 会把没给出去的几十条永久吞掉——增量游标最不该有的失败方式。
4. **3.5 字符/token 是一个故意粗的数。** 真值随语言与分词器变（中文接近 1.5，英文代码接近 4）。那一行要回答的只有「大概占多大」；给一个假装精确的数，它会被当成预算来用。

一处**没有**改：脱敏只挂在跨连线读取上，不挂在转录渲染里。一个 Agent 读自己的转录是它自己的事，那些密钥本来就是它打出来的。

### 28.3 验证

`pnpm libs:build` 之后：`@armadra/desktop` 全绿（新增 `redact` 17、`transcript-summary` 17、`read-budget` 15、`context-budget` 28 条用例）、`@armadra/web` typecheck、`pnpm -r typecheck`、`pnpm check` 全绿。迁移 `0025_context_reads.sql` 已记进 `migrations.lock`，库里 `migrations` 25 条。

`packages/shared` 的 `test/usage-dashboard.test.ts` 那条红在 26.7 记过，本批未触及。

## 29. 拆掉「会话上下文」整条链路（2026-09-21）

分支 `feature/host-protocol-foundation`。用户的决定：终端节点 `···` 里的「会话上下文」以及它背后那整套遥测不要了，整体移除，不留死代码。

### 29.1 删了什么

| 层     | 删掉的东西                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| web    | `agent/context-usage/`（菜单、hook、诊断表）、`i18n/context-usage.ts`、`api/agents.ts` 的 `contextUsage`、设置页的 80/95 阈值与 `preferences-store` 里那两个键、`TerminalNode` 的读数接线                                                                                                  |
| shared | `context-usage.ts`、`model-context.ts`（随之全无引用）、`contextUsage` 能力位、SSH 主机排除表里的那一项                                                                                                                                                                                    |
| core   | `usage/context-usage.ts`、`GET …/nodes/{nodeId}/context-usage` 与 `/automation/session-context-usage` 两条路由、`ContextUsageCache` 及其装配、`hook/ingest.ts` 的 `armadraContextUsage` 分支、扩展模板里的 `armadraReportContextUsage` / `ctx.getContextUsage()` 与三份 `*_CONTEXT_EVENTS` |
| CLI    | `armadra-hook/context-usage.ts`；其中 `loadBinding` / `nextRevision` 是**普通 hook 报告**的 `terminalBinding` 在用的，搬到新的 `armadra-hook/binding.ts`                                                                                                                                   |

`ARMADRA_SESSION_ID` / `ARMADRA_SESSION_GENERATION` 两个环境变量**留着**：`canvas handoff-read` / `ack` 要用它们证明会话身份，hook 报告的 `terminalBinding` 也要。只把注释里「给上下文读数用」的说法改成现状。

### 29.2 statusLine：装 / 修 / 卸都要摘

这是已装机器升级后不残留的关键。以前 `hook/install/claude.ts` 会往用户自己的 `~/.claude/settings.json` 写 `statusLine: { command: "<armadra-hook> context-usage" }`。现在：

- 安装不再写；
- 安装、卸载（`retireGlobalEntries`）与设置页的「修复」（`repair.ts`，判据从「只认旧名字」扩成 `isRetiredStatusLine` = 旧名字 ∪ `managedContextCommand`）都会把**认得出是我们写的**那条摘掉；
- 别人自己的状态行一个字节不动，认不出来的一律保留——`managedContextCommand` 这一半本来就是保守的。

因此 `install` 不再产生 `context_statusline_preserved` 警告，界面上那句提示也一起去掉了。

### 29.3 `armadra-hook context-usage` 保留为 no-op

子命令保留，静默、退出码 0。理由写在 `cli/armadra-hook/main.ts` 的注释里：老的 `settings.json` 在修复跑到之前还会每次状态刷新调它一次，报错会刷屏。`--help` 里不再列出它。

### 29.4 顺带：终端节点的 `···` 只剩三样

用户同一轮的要求。终端自己那一段现在只有：顶部的 Agent / SSH 说明标签、「交接到…」、「模型 ›」。删掉的是会话上下文、搜索（⌘F 与头部搜索框仍在）、中断、打断这一轮、结束进程、销毁会话、回收会话、重新运行；`surfaceRef.terminate/recycle` 在这个组件里随之没有调用点（`TerminalSurface` 的方法本身仍被右键菜单用着），五个只有这些菜单项在用的 i18n 键中英一起删掉——`i18n.test.ts` 的「每个键都得有人用」那条守卫把它们逐个点了出来。

### 29.5 验证

`pnpm libs:build` 之后：`@armadra/shared`、`@armadra/web`、`@armadra/desktop`、`@armadra/server` 全绿，`pnpm -r typecheck`、`pnpm check`、`pnpm format:check` 全绿。新增用例两条：`claude.test.ts` 断言装与卸都会摘掉我们自己那条旧 statusLine、`repair.test.ts` 断言修复认得当前名字的那条而不动陌生的那条；`wire.test.ts` 的 `context-usage` 一节改成断言它静默且退出 0。

## 30. 连线的角色事后可改（2026-09-21）

真机上拉出来的四条线全是「对等」——连线时的命名对话框里虽然能选「主 → 从」，但它可以跳过，跳过之后没有任何入口改得回来，只能删线重连。对等边只能 `post`，不能往对方终端里打字，所以这不是一个装饰性的字段。

### 30.1 边的右键菜单多三项

`apps/web/src/canvas/menus/edge-menu.tsx` 原来只有「删除连线」。现在上下文连线的那一支是：设为对等 / 设为 主 → 从 / 设为 从 ← 主，分隔线，删除连线。当前那一项 `disabled`（`role` 缺席与 `peer` 同义）。

三项只认**右键命中的那一条**边，不像删除那样跟着选区展开：主从是有方向的，选区里每条边的两端各是各的。引用边（`whiteboard.references`）那一支不变，仍然是重新同步与移除。

### 30.2 `reverseEdge`

「从 ← 主」要的是让 `target` 当主，而方向写在两端上，所以 `store/canvas/edges.ts` 新增 `reverseEdge(id, role?)`：换两端、边 id 不变、`role` 给了就在**同一次 `commit`** 里一起落（撤销一步）。id 不变意味着这条线上的选区与投递记录都还在，而删线重连会把它们一起丢掉。

保存路径不需要配合：`sync/project.projectEdge` 每次从文档现读 `source` / `target`，`commit` 的差分按 id 比对，所以掉头登记成这条边的一次更新（`pending.markPatch`），与改标题走的是同一条路。core 一个字节没动。

### 30.3 文案与测试

`i18n/canvas.ts` 中英各三条：`edge.role.setPeer`、`edge.role.setSupervises`、`edge.role.setSupervisesReverse`。

`CanvasMenus.test.tsx` 断言对等边上「设为对等」不可点、另外两项各自落到 `setEdgeRole(id, "supervises")` 与 `reverseEdge(id, "supervises")`，以及主从边上「设为 主 → 从」不可点、「设为对等」落到 `setEdgeRole(id, "peer")`；`canvas-store.test.ts` 覆盖 `reverseEdge` 的四条（带角色、不带角色、撤销一步、不存在的 id 不换文档）。

边被点选时的反馈（品牌色 + 加粗）与主从边的箭头规则是 `LinkEdge` 已有的，没动。

### 30.4 验证

`pnpm libs:build` 之后：`@armadra/web` 测试 264 个文件 2619 条全绿，`pnpm --filter @armadra/web typecheck`、`pnpm -r typecheck`、`pnpm check`、`pnpm format:check` 全绿。

## 31. 启动时不上报的 CLI：首投放行路（2026-09-21）

实测（Codex CLI 0.155.1，真机）：hook 全部装好且 enabled，进程起到「› Ask Codex to do anything」提示符**一条事件都不发**，`agent_status` 里没有这个节点的行；第一条事件要等人在里面提交一次输入才来。于是 `open-agent --task` 与 `send` 对新建的 Codex 节点永远停在 `agent_send_queue` 的 `queued / TARGET_STARTING`——`targetState()` 对没有上报的节点答 `starting`，而那条「第一条真上报」按定义不会来。用户看到的是「主 Agent 开出的 Codex 一个都没收到任务」。

### 31.1 注册表那一位

`AgentDefinition.startsSilently`，今天只有 `codex` 带；读它的是 `registry.startsSilently(provider)`，与 `stateSourceFor` 并排——两个都是「这家 CLI 的适配长什么样」的事实，自定义 Agent 按 base 问。含义写在类型上：**启动完成不发任何 hook 事件，第一次「空闲」只能靠观察**；它不表示「没有状态通道」，投出第一条之后 `user_prompt_submit` 与 `stop` 照常来。

### 31.2 放行判据

五态一个字没改（`targetState()` 对这种节点仍然答 `starting`，它说的是「我们知道什么」）。新判据是 `agent/target-state.ts::silentStartIdle` 这个纯函数，由 `control/send.ts::attempt` 在 `!stateSourceIsReported(stateSource)` 那一支里调用，五条同时成立才当作 `idle`：标了 `startsSilently`、从未上报过、会话活着（门链更早的一条保证）、没有半截没提交的行（不看输出——真机上 Codex 的空闲屏有背景动画，每秒都有几行在变，「安静」永远不成立，第一版按输出安静判定在真机上一条都投不出去）、会话建立 ≥ `SILENT_START_MIN_AGE_MS = 6000`。「从未上报过」把 `restored` 的行自动排除在外——它的 `stateSource` 是 `hook`，所以重启恢复的节点仍按 §4.1 排队。会话年龄这个事实以前没有人取，`loadSession` 因此多答一个 `createdAtMs`。

### 31.3 触发源

泵不轮询（听 `agent.status` 与租约释放），而这类目标按定义不发那条事件。所以两处触发：入队经 `context.nudge` → `SendPump.noteQueued()`，目标若标了旗就转起一把 2 秒的快探（`SILENT_PROBE_INTERVAL_MS`），探完没有候选自动停；清扫定时器（60 秒）捎带一次同样的 `probeSilentStarters()` 兜底。探测只对「队里有 `queued` + 目标标了旗 + 目标从未上报过」三条同时成立的目标各试一次 `drain`，轮询没有扩大到别的目标。真机复现过：Codex 到提示符后 `agent_status` 无行，`--task` 停在 `TARGET_STARTING`。

### 31.4 可见性

`agent_deliveries` 多一列 `target_state`（迁移 `0026_delivery_target_state.sql`，缺省空串），记的就是回执里那个 `targetState`：五态之一，或者 `observed-quiet`。`GET …/deliveries` 随之多一个 `targetState` 字段，所以「按观察放行的 `delivered`」与「有上报的 `delivered`」事后分得开；board-log 的 receipt 也写 `written observed-quiet`，`agent.send` 审计的 detail 里带 `targetState`。前端徽标后补。

### 31.5 取舍

误判面两条写进了设计 §4.3 并接受：**目录信任提示**（Codex 首次进未信任目录先问「Do you trust」，那个提示也是安静的，正文会成为它的答案）与**安静的忙碌**。不解析提示符、不识别 OSC 的那条（§12 第 3 条）不变；`observed` 没有默认放行（§12 第 5 条）也不变——这条路要注册表显式标旗才存在，且一个节点一生只用得上一次。

### 31.6 验证

`pnpm libs:build` 之后 `@armadra/desktop` 测试、`@armadra/web` typecheck、`pnpm -r typecheck`、`pnpm check`、`pnpm format:check` 全绿。新增用例：`collab/silent-start.test.ts` 八条（放行一条，不放行五条：没标旗、半截输入、刚出过输出、会话太新、已上报 busy；探测两条：只挑该挑的目标、清扫那把定时器就是触发源）、`agent/target-state.test.ts` 七条纯函数用例、`collab/first-task.test.ts` 一条端到端形状。

### 31.7 真机上仍然一条都投不出去：终端应答被当成了半截输入（2026-09-25）

打包版（09-22 构建）真机复现：Claude 用 `send` 给两个新建的 Codex 0.155.1 节点各发一条任务，`agent_send_queue` 两行一直是 `queued / TARGET_STARTING`、`attempts = 0`，直到 5 分钟 TTL 过期。会话 `running / live`、建立远超 6 秒，卡住的是「没有半截没提交的行」这一条。

原因在 `terminal/input.ts` 的 `InputSafety`。Codex 启动时向终端发这些查询（在 PTY 里起 `codex` 抓前 8 秒输出得到）：`ESC[6n`、`ESC[c`、`ESC[?u`、`ESC[>7u`、`ESC]10;?ESC\`、`ESC]11;?ESC\`。xterm 6.0.0 的应答经页面的输入通道写回 PTY，而旧的识别只放过终止符为 `c` / `R` / `n` 的 CSI 应答：`ESC[?0u` 按终止符 `u` 算作按键，`ESC]11;rgb:…` 的 `ESC ]` 在第二个字节就被判成「不是 CSI 的 ESC x」。`pending` 从此一直是真，只有人按一次回车才会清掉。

修法：OSC / DCS / APC / PM 串（`ESC ]`、`ESC P`、`ESC _`、`ESC ^`，读到 BEL 或 `ESC \`）一律当应答，超过 4096 字节不终止就按输入算；CSI 应答多认两种：`?…u`（键盘协议标志）和 `?…$y`（模式报告）。都要求带 `?` 前缀，因为键盘协议下的 `CSI 97 u` 是真按键。`input.test.ts` 新增三条用例：应答不计为输入（含跨帧切开）、键盘协议按键仍计为输入、不终止的串按输入算。

## 32. Dock 白板工具组收纳与画框工具下线（2026-09-21）

用户实测提的三件事：抓手也弹样式面板、十个按钮里一半是成对的、画框工具看不出用处。

### 32.1 手形不再弹样式面板

`canvas/tools.ts` 的 `shouldShowStylePanel` 原来写的是 `toolId !== "select"`，于是选中手形也会在左上角弹出颜色 / 粗细 / 线型 / 填充那一整块。判据换成 `isDrawingTool`（`interaction/tool-store.ts`，与 `flow-options` 关框选、`use-tool-pointer` 接管指针共用的那一个），手形和选择一样只在「选中项里有白板对象」时显示。

### 32.2 成对的工具各收成一格

Dock 的排布从「一个工具一个按钮」改成一张 `DOCK_TOOL_ITEMS`（`canvas/tools.ts`）：

| 格                 | 内容                         |
| ------------------ | ---------------------------- |
| 选择 / 手形 / 文字 | 单个工具，照旧               |
| 笔                 | 画笔 / 高亮，下拉切换        |
| 形状               | 六种几何形，下拉切换（不变） |
| 线                 | 直线 / 箭头，下拉切换        |
| 引入               | 不是工具，开文件选择器       |

笔与线那两格的按钮**就是**组里当前那个工具：图标、`aria-label`、tooltip 上的键位都取自它，点一下等于按它的快捷键。`canvas.tool.draw / highlight / line / arrow` 四条命令与键位（`D` / `Shift+D` / `L` / `A`）原样保留，记忆由 `tool-store.setTool` 统一维护（`TOOL_GROUPS` + `getToolGroupChoice`），所以命令面板或快捷键切过去时 Dock 上那一格也跟着换人。手机那一份（`PHONE_TOOL_IDS` = 选择 + 手形）不变。

### 32.3 「图片」改成「引入」

图标换成 lucide `Import`，文案 `tool.import`（「引入…」/ "Import…"），行为仍是 `pickFilesForCanvas()`。文件选择器本来就没设 `accept`，所以图片落成白板图片对象、其余落成文件节点这两条路都通——这次只是把按钮的名字改成它真正做的事。

### 32.4 画框工具删除清单

「新建画框」留在 Dock 的「新建」菜单里（`menus/add-menu.ts` 的 `addFrameShape` 自己建 `group` 节点），工具这一份全部删掉：

- `interaction/tool-store.ts`：`CANVAS_TOOL_IDS` 去掉 `"frame"`；
- `canvas/tools.ts`：工具表里那一条；
- `keybindings/commands.ts`：`canvas.tool.frame`（`F` 键释放）；
- `i18n/canvas.ts`：`tool.frame`；`i18n/commands.ts`：`cmd.canvas.tool.frame`（中英各一）；
- `whiteboard/tools/draft.ts`：`FrameDraft`、`CLICK_FRAME_SIZE`、`startDraft` 的 `frame` 分支（`commitDraft` 因此不再有「落成不了」的第四种）；
- `whiteboard/tools/use-tool-pointer.ts`：`commitFrame` 与 `finish` 里那个分叉，连带不再 import `canvas-store` 与 `defaults`；
- `whiteboard/tools/DraftPreview.tsx`：虚线框预览；`ToolLayer.tsx`：光标表里那一行。

### 32.5 验证

`pnpm libs:build` 之后 `pnpm --filter @armadra/web test`、`typecheck`、`pnpm -r typecheck`、`pnpm check`、`pnpm format:check` 全绿。新增 `canvas/interaction/tool-store.test.ts`（组记忆：默认值、两组互不影响、组外工具不动记忆、重置）与 `shell/DockTools.test.tsx`（六格排布、两组下拉各切一次、快捷键切换后按钮跟着换）；`canvas/tools.test.ts` 补了排布与显隐的用例，`flow-options.test.ts`、`draft.test.ts` 去掉画框那一份。

## 33. Windows CI：真 bug 与按平台的门控（2026-09-22）

`ci.yml` 的三平台矩阵里 `windows-x86_64` 在 `pnpm -r --if-present test` 上红着：`apps/desktop` 有 25 个文件、73 条用例失败，Linux 与 macOS 全绿。按原因分成三类。

### 33.1 修掉的真 bug（Windows 是发布目标，这些路径线上会跑到）

- **路径包含判断写死了 `/`。** `core/git/` 的十来处边界检查形如 `path.startsWith(`${parent}/`)`。Windows 的分隔符是 `\`，所以「仓库在工作空间里」「文件在仓库里」「worktree 不在 Git 管理目录里」这些判断全部答错——`hunks`、`routes`、`repository-reads`、`operations` 的失败都源于这一处。`workspaces/roots.ts` 里本来就有一个用 `relative` 写对了的 `contains`，现在导出它（另加 `containsStrictly`），`git/{hunks,routes,discovery}` 与 `git/repository/{service,worktrees,stash,execute}` 一律改用它。`discovery.ts` 里按 `"/"` 数层级的排序也改成按两种分隔符数。
- **跨盘符时 `relative` 会答出绝对路径。** `conversations/index.ts` 的 `inScope` 用 `relative(root, target)` 判断范围，但只挡了 `..` 与前导分隔符。Windows 上 `C:\…` 与 `D:\…` 之间 `relative` 返回的是绝对的目标路径，两条都不触发，范围外的会话于是全被收进索引。补上 `isAbsolute` 这一项——`roots.ts` 的 `contains` 一直是这么写的。
- **`dataDir(platform, env)` 用的是宿主的分隔符。** 这个函数带 `platform` 参数，注释写明「so the resolution for all three platforms can be tested on any one of them」，但拼接用的是 `node:path` 的 `join`，在 Windows 上问 darwin 会答出 `\Users\dev\Library\…`。改成按被问的平台取 `posix` / `win32` 的 `join`；只有兜底的 `tmpdir()` 那一支仍用宿主的，因为它本来就是这台机器的目录。

### 33.2 按平台门控（Windows 上没有这件事）

每处一句注释说明为什么，粒度是用例而不是整个文件：

- `core/main.test.ts` 两条 `--listen unix:`：`listen.ts` 在 Windows 上明确拒绝 Unix socket，让人改用 `pipe:NAME`。健康文档那条改成按平台断言 `hook.sock` 在不在——`HookService.socketPath()` 在 Windows 上返回 `undefined` 是设计。
- `core/files/watch.test.ts` 的原子替换：`replaced` 与 `modified` 靠 dev+inode 区分，Windows 不便宜地给这个号，`watch.ts` 在那里如实报 `modified`。
- `core/git/message.test.ts` 两条走 `fakeClaude`：夹具是 `#!/bin/sh` 加 `chmod 0755`，Windows 按扩展名挑解释器、也没有执行位。

`session-host/server.test.ts` **没有**门控。它原先把 `%TEMP%` 下的一个文件路径当端点，Windows 上 `listen()` 回 `EACCES`；改成在 Windows 上从命名管道命名空间取名字（`PIPE_PREFIX` + 随机后缀），27 条用例于是在三个平台上都真的跑。ConPTY 那一半仍在 `windows.integration.test.ts`，它本来就是绿的——session-host 的产品代码没有 bug。

### 33.3 测试假设（源码没问题）

- **写死 POSIX 字面量的期望值。** `paths`、`cost-sources`、`hook/install/shared`、`terminal/environment`、`terminal/ssh/{argv,known-hosts}`、`cli/armadra-hook/endpoint`、`main/{branding,external,runtime-process}`：源码用 `join` / `resolve`，是对的；期望值改成同样拼出来。`paths.test.ts` 里问别的平台的那几条反过来写死那个平台的拼法——现在它们在哪台机器上都该是同一个答案。
- **CRLF。** `git/fixture.ts` 初始化后补 `core.autocrlf=false` 与 `core.eol=lf`：runner 的全局配置是 `autocrlf=true`，夹具写 LF、经 Git 检出再读回来就成了 CRLF。`.gitattributes` 早就把仓库自己的文件钉成 LF（`* text=auto eol=lf`），所以 `migrations.lock` 的 SHA-256 本来就没问题——`migrations.test.ts` 那条是按 `lastIndexOf("/")` 取文件名，改用 `basename`。
- **TOML 的转义。** `hook/install/codex.test.ts` 拿 `stateKeys` 的逻辑键去 `toContain` 文件正文；TOML basic string 要转义反斜杠，Windows 路径写进去是 `C:\\Users\\…`。断言改走一个 `asWritten`，安装器本身是对的。
- **`URL.pathname` 不是路径。** `tmux.test.ts` 那条扫源文件的守卫用 `new URL(".", import.meta.url).pathname`，Windows 上得到 `/D:/…`。改 `fileURLToPath`，和 9172826c 同一个坑。
- **`armadra-hook` 的旁车名字。** `launcher-client.test.ts` 建的是无扩展名的文件，Windows 上安装器找的是 `armadra-hook.cmd`。
- **`EBUSY`。** `language/routes.integration.test.ts` 的 teardown：Windows 不让删还被进程占着的目录，`rmSync` 加重试。重试不够——真原因见 33.4。

### 33.4 第二轮：`ServerProcess.terminate` 不等进程真的死

第一轮推上去后 Windows 只剩两条，仍是 `language/routes.integration.test.ts` 的 `EBUSY`。重试加到 2 秒也没用，因为句柄根本不会被放开：语言服务器的子进程以工作空间根目录为 cwd，而 `terminate()` 在 Windows 上发完 `taskkill /T /F` 就返回了——`taskkill` 在目标真的消失之前就退出。调用方 `await` 了这个 Promise，却拿不到它字面上承诺的那件事。

`ServerProcess` 现在持一个在 `exit` / `error` 上兑现的 `reaped`，`terminate()` 在两个平台上都等它（上限 5 秒，杀不掉的进程不该把关停挂住）。POSIX 上 `SIGKILL` 之后这一等几乎不花时间，但契约从此在两个平台上都是真的。

同一轮里 macOS 挂在 `browser/headless/live.integration.test.ts` 的 teardown：用例本身过了，Chromium 在管道关掉之后还在刷它的 profile，`rmSync` 撞上 `ENOTEMPTY`。这条与 Windows 无关，是一直存在的偶发；重试放宽并包上 `catch`——`$TMPDIR` 里剩一个目录是操作系统要扫的,不是测试结论。

### 33.5 第三轮：core 关停时根本没停语言服务器

Windows 仍剩那两条 `EBUSY`，而 33.4 的等待把那个文件从 12 秒拖到 28 秒——等的是一个永远不会退出的进程。真原因在 `core/main.ts`：`stop()` 只做了 `server.close()`、`opened.close()` 和 `releaseAll()`，从没调用 `languageDomain()?.stop()`。`Manager.shutdown()` 一直在那儿，注释还写着「Called when the core shuts down」，只是没人叫它。

所以**核心退出会漏掉每一个语言服务器进程**，每开过一个工作空间就漏一个。POSIX 上看不出来（目录照删不误，进程被 init 收养），Windows 上那个进程以工作空间根目录为 cwd，目录就删不掉——测试撞见的是这个泄漏的影子。

修法是在 `stop()` 里 `await language?.stop()`。`language` 在装配循环之后就地取下来而不是关停时再读：那个访问器是模块级单例，同一进程里起第二个 core 会把它改掉，关停时再读就会停错人。

第三轮之后 `apps/desktop` 在 Windows 上全绿。

## 34. 远端执行主机：Worker 服务端与按执行主机路由（2026-09-26）

H02 的控制端（帧、握手、重连）早就在，远端那一侧从没写过：`core` 没有 `worker` 子命令，建远端工作空间与切换执行主机两条路由校验完参数就抛 `unsupported`，文件与导入路由遇到 `executionHostId` 一律 501，Git 路由更糟——根本不看执行主机，直接在控制端磁盘上对一条远端路径跑 `git`。

### 34.1 做了什么

- **Worker 服务端**（`core/remote/server.ts`）：`armadra-core worker --stdio [--state-dir D] [--language-link]`，由 `main.ts` 在 `run()` 之前分流，不开数据库、不监听、不写端点文件。先主动发握手帧（`requestId = "hello"`，协议 2.0、服务契约 1、能力 `remote.execution.v1` / `remote.files.v1` / `remote.git.v1`），之后按 `action` 执行；发给别的会话的请求答 `instance_mismatch`，超过帧上限的答复答 413 `resource_exhausted`，不截断。`--language-link` 直接拒绝（退出码 3）。
- **一张操作表两处用**（`core/remote/operations.ts`）：控制端对本机工作空间直接调，Worker 收到帧后查同一张表。文件（列表、读写、版本、条目、回收站、索引、搜索、下载）、导入、Git（status、diff、head、init、stage / unstage / resolve / revert / commit、hunks、repositories、log、refs、identity、branches、tags、remotes、worktrees、stashes、history、reflog、commit / commit-file、cherry-pick 与 rebase 预览、message source）和根登记（规范路径 + 指纹）。每项标明能否重放。
- **唯一的缝**（`core/remote/execute.ts` 的 `executeOn`）：执行主机为空在本进程跑，否则经远端域发给 Worker；远端域没装配就是 501，绝不回退到本机磁盘。控制端 `RemoteWorker.request` 按合同处理传输失败：没写出去的在新连接上重发一次；写出去又丢了答复的，读重放一次、写报 `unknown_outcome` 不重发。
- **路由接通**：`files/routes.ts` 全部、`git/routes.ts` 除操作队列外全部、`imports/routes.ts` 的上传与本机拖入（字节在控制端读，在执行主机上暂存 → 原子发布）。`POST /api/workspaces/remote` 与 `PATCH …/execution-host` 在目标主机上登记根之后才写库；切换按 `remote/switch.ts` 的既有规则判：终端（库里仍在运行的会话）与进行中的 Git 操作列为阻塞项，`stopBlockers` 经终端域自己的 `terminate` 路由结束终端，HEAD 与顶层目录不一致答 409 `root_mismatch`，旧根读不到时也只有 `force` 能越过；成功后释放两种监听、清仓库发现缓存、发 `workspace.updated`。
- **远端文件监听**：控制端每 2 秒批量问一次版本（`core/remote/watch.ts`），变化发与本机相同的 `file.changed`，注册答 `mode: poll`，编辑器已有「轮询」徽标。
- **界面**：设置 → SSH 里「在执行主机上打开」成功后直接切到新工作空间；切换执行主机的界面原样可用（接口形状本来就对）。

### 34.2 没做 / 明确拒绝的

- **语言服务**：远端工作空间的服务行与开会话一律 `unsupported_remote`（501），不再报暗示「重连能好」的 `link_lost`；共享包的 `LANGUAGE_UNSUPPORTED_REASONS` 与中英文案同步加了这个键。要做需要一条承载 JSON-RPC 流的第二连接。
- **Git 操作队列、集成状态、工作树绑定、AI 提交信息生成**：远端答具名 501（列表答空数组），因为它们依赖控制端的操作归属表或要在两台机器上各跑一半。
- **交接**：远端工作空间与 SSH 终端里的 Agent 都拒绝（501，说明原因）。交接材料是同步读工作空间文件与仓库采出来的，照原样会读控制端磁盘上同名路径里不相干的东西。
- **大文件**：没有分块上传。远端导入合计上限 11 MiB（一帧 16 MiB 里放得下 base64），超过答 413；下载超过一帧同样 413。
- **Worker 主动推事件**、协议兼容范围放宽、白板资产导入（`assets/routes.ts` 仍拒绝远端）不在这一轮。

### 34.3 验证

- `remote/execution.test.ts`：把 core 真入口用 vite 打成 CJS 包，本机子进程跑 `worker --stdio`，控制端经同一套帧与握手说话，不需要 sshd。覆盖握手与能力、按会话拒绝、读重放 / 写不重放（第一个子进程握手后在首个请求上断开）、远端文件路由全套、远端轮询监听、上传与拖入导入、Git 读写与提交、操作队列 501、建远端工作空间（不存在的根不落库）、切换的一致 / 不一致 / 强制 / 终端阻塞 / 迁移文件拒绝，以及没装配远端执行时不回退本机。
- `pnpm --filter @armadra/desktop test`、`pnpm --filter @armadra/web test`（`i18n.test.ts` 里 `integration.legacy.list` 未引用是基线 b1811c85 带来的，与本节无关）、`pnpm --filter @armadra/web typecheck`、`pnpm --filter @armadra/server test`、`pnpm check`、`pnpm format:check`。

## 35. 冷启动、半截输入门、工作时防休眠与投递依据徽标（2026-09-26）

### 35.1 `LAUNCH_FROZEN` 冷启动（自动化设计 §4.2、§5）

计划早就接受这个策略，探到空节点却只会答离线、整次运行跳过。现在 `TerminalDispatcher.supports(target, { coldStart })` 多一个选项，**只有**引擎的运行探测传 `coldStart: true`——激活时的探测与写入前的复核都不起进程。授权了冷启动、节点上没有活会话时：

- 程序按 `agentId` 从注册表（含自定义 Agent）解析，冻结的参数逐个 shell 引用后拼成启动行（`schedule/cold-start.ts::launchLine`）；工作目录取冻结的那个，缺省用工作空间根目录。
- 起会话走终端域经接缝交回的启动器（`setAgentLauncher`，在 `terminal/install.ts` 装配）：与 `POST /api/terminals` 同一份节点环境（地址变量、节点令牌、审批等待），shell 出声并安静 400ms（最多 3 秒）后敲启动行，与页面挂载终端节点时的时序一致。
- 新会话写回节点 `data.sessionId`（画布同一条 CAS，撞上并发重读一次）并发 `board.changed`，然后报 `busy`，运行进入 `WAITING_TARGET`，由既有的 busy TTL 兜底过期。
- 冷启动的会话，旧会话留下的那行 `agent_status` 不算数：要一条晚于冷启动的真上报（非 `restored`、来自 hook/extension、`idle`/`done`/`error`），启动时不上报的 CLI 走 §4.3 的首投门（会话满 6 秒、没有半截的行）。
- 同一节点 60 秒内只冷启动一次，起之前就占住窗口；窗口里又探到空节点答离线，起来就退的 CLI 不会变成循环。

`/automation/*` 九条 hook 面路由是跨进程年代的私有门，同进程后没有任何调用者，也用不上：从 `ROUTES`、`route-scopes` 与 `hook/server.test.ts` 的注释里删掉。

已知限制：页面上**已挂载**的那个终端节点不会因为 `board.changed` 自动贴到新会话上（`TerminalSurface` 只在挂载与「重新运行」时找会话），要重新挂载才看得见；core 这一侧的投递不受影响。

### 35.2 `send` 的半截输入门

租约只管「人此刻在不在打字」，停手十秒就过期；输入行上的半行还在，而 hook 目标报的 `idle` 说的是这一轮结束了，不是输入行是空的。门链在租约之后、串行门之前加一条：`observed(sessionId).pending` 时排队（`--no-queue` 时拒绝），码 `TARGET_INPUT_PENDING`（409，回执 `targetState: idle`），设计 §3.5 的码表与页面的 `error.delivery.*` 同步。自动化的 Agent 目标探测同样把 pending 算作 `busy`。判据仍是 `terminal/input.ts` 的输入围栏，77b62763 对终端查询应答的豁免原样保留。

### 35.3 工作时防休眠（终端宿主设计 §9）

新文件 `core/resources/keep-awake.ts`：订阅 `agent.status` 与 `terminal.exit`，有节点在 `working` 时持一把 `session` 租约；另有运行占着目标门（`ScheduleEngine.hasActiveRuns()`，数 `automation_gates.active_run_id`）时持一把 `automation` 租约；TTL 120 秒、30 秒一拍续期与复查。`blocked`/`waiting` 不算在干活；30 分钟没有新上报的 `working` 不再算数；租约被人在面板上放掉而仍在干活时重新申请。开关 `power.keepAwakeWhileWorking`（默认开，与 `power.policy` 一样存本机那一半），界面在「终端」设置页防休眠策略下面，用 Switch。它只决定申不申请，生不生效仍由 `power.policy` 裁决。

### 35.4 投递记录的依据

shared 的 `agentDeliverySchema` 加 `targetState`（缺省空串）。投递队列浮层打开时读一次投递记录，列出最近投进这个节点的三条，并标「有上报」或「按观察放行」（`observed-quiet`）；0026 之前的行不标。

### 35.5 验证

- `pnpm --filter @armadra/desktop test`：243 文件 / 2848 条通过（新增 `schedule/dispatch.test.ts` 冷启动 6 条、`collab/send.test.ts` 半截输入 1 条、`resources/keep-awake.test.ts` 7 条、settings 默认值断言）。
- `pnpm --filter @armadra/server test`：通过。
- `pnpm --filter @armadra/web typecheck` 通过；`test` 只剩 `i18n.test.ts` 一条失败，是基线 b1811c85 留下的 `integration.legacy.list` 未被引用，与本节无关。

## 36. 依赖编排挪进 core（2026-09-25）

设计 `design/agent-automation-design.md` §6。此前 `open-agent --after` 只往节点数据里写一份 `pendingLaunch`，由页面挂载节点时自己判定、自己敲启动行：页面没开就没人等；判定看的是「现在是不是 done」，一条早就躺着的 done 当场放行。

### 36.1 做了什么

- **迁移 0027**：`agent_dependency_launches`（一个下游一行：状态、重试次数、延后的第一条任务及其来源链）与 `agent_dependencies`（一条边一行：上游、`condition`、基准状态与基准上报时刻、`observed_busy`、状态、原因、TTL）。
- **`core/dependencies/`**：`evaluate.ts` 是纯判定；`service.ts` 订阅 `agent.status` / `terminal.exit` / `board.changed`，外加 30 秒一次的扫描（过期、上下游被删、重启后的补判与启动重试）；`launch.ts` 在条件满足时启动下游——节点已有活着的 shell（页面开着）就往里敲，没有就经终端桥新增的 `spawnForNode` 起一个（与 `POST /api/terminals` 共用环境与节点令牌，抽成 `ownedEnvironment`），再把会话 id 写进节点数据。启动行与页面拼的是同一份（`planLaunch` + `GET /api/agents` 的解析路径与 `launchArgs`）。第一条任务在启动之后才以 `origin = 'first-task'` 进 `agent_send_queue`（带幂等键），出队泵照旧等第一条真正的 idle——没有另写往 PTY 里敲正文的路。
- **`open-agent`**：`--after` 写依赖表，新增 `--after-turn current|next`（缺省 `current`）与 `--ttl <分钟>`（缺省一天，上限一周）；建节点之前就拒掉普通终端、环与别的画布上的上游；带 `--after` 时任务不再当场入队（队列 TTL 五分钟，等依赖会过期）。节点数据不再写 `pendingLaunch`。
- **路由**（契约 `core-json-api.md` §8）：`GET/POST /api/workspaces/{id}/dependencies`（列出 / 迁入旧 `pendingLaunch`）、`DELETE …/dependencies/{dependencyId}`（取消一条边）。
- **页面**：节点头新增「等待 X」徽标（`DependencyWaitBadge`，浮层里可「不等了，现在启动」）；`use-launch` 在 core 说还在等时只起 shell 不敲启动行；带依赖的旧 `pendingLaunch` 在挂载时迁进 core 再从节点数据里摘掉（迁不进去才退回旧的页面侧等待）；rope 边的等待改由依赖表派生。不带依赖的 `pendingLaunch`（命令面板恢复会话）照旧由页面敲。

### 36.2 取舍

- **基准**：没有 turn id，用「创建时上游的状态 + 最后一次上报时刻」作基准；一次结束要晚于那个时刻，或者基准之后见过它忙（过期扫描把 working 改成 done 时不一定挪时刻）。`current` 遇到上游已干净停下的当场满足（旧 `--after` 的语义）；`next` 只认下一次成功结束，失败的一轮挪基准继续等。
- **不放行**：失败、中断、上游终端退出 → `failed`；上游被删 → `missing`（旧实现当作满足，这里不再）；过期 → `expired`。都要人取消那条边，其余边都满足时就在取消里启动。
- **启动安全**：已有 shell 时先看前台——已经在跑这个 Agent 就只记账不再敲；前台是别的程序或有半截输入就改天再试（最多 5 次，之后启动记 `failed`）。页面读不到依赖状态时放行，靠的就是这一条。
- 批量组队 / 多角度评审这一组合操作没有做；技能文案改了但没有提 `SKILLS_REVISION`（留给统一改技能的那一次）。

### 36.3 验证

- `pnpm --filter @armadra/desktop test`：243 文件通过（本 worktree 的 node-pty `spawn-helper` 没有执行位，`chmod +x` 之后终端用例全绿，与本改动无关）；新增 `core/dependencies/service.test.ts` 25 条（无页面服务端触发、已有 shell 时复用、旧 done 不重放、多上游、失败 / 中断 / 退出 / 删除、TTL、取消与列出、旧数据迁入、core 重启后补判、写完行未落账的重启不重敲）。
- `pnpm --filter @armadra/server test`：9 文件 68 条通过。
- `pnpm --filter @armadra/web test` / `typecheck`：新增 `DependencyWaitBadge.test.tsx`；唯一失败是基线就有的 `i18n.test.ts` 未引用键 `integration.legacy.list`（上一个提交留下，与本改动无关）。

## 37. 编辑器节点：最近文件、跳转行列、Git 行边标记、媒体预览与草稿保护（2026-09-26）

设计见[编辑器与浏览器设计](../design/editor-browser-design.md) §2 与 §3，这一节把两处「尚未实现」里除「搜索结果的取消按钮」「重新定位」之外的项都落了。

### 37.1 最近文件与跳转到行列

- 最近文件按工作空间记在本机 localStorage（`files/recent-files.ts`，二十条，最近的在前），编辑器节点每打开一个文件记一次；快速打开输入为空时先列这一组。不进 core：这是「这台设备上刚看过什么」，换台设备本来就该是另一份。
- 输入 `路径:行[:列]` 时只拿路径去查文件索引，选中后打开到那个位置；`:行[:列]` 不查文件，直接跳当前编辑器。`editor-reveal` 与 `revealLine` 加了列号，越界的行、列都夹到实际范围。
- 命令表加 `editor.goToLine`（⌃G，两个平台一样——macOS 上 ⌘G 是查找下一个）。编辑器里按下时带着那个节点的路径打开快速打开（`panels/quick-open-seed.ts`，单独一个模块，免得编辑器把快速打开连同符号查询一起拖进包里）；从命令面板执行时落在选中的编辑器上。

### 37.2 Git 行边标记

core 没有「取 HEAD 里这个文件」的接口，也不需要新加：`git/diff` 的 `worktree` 与 `staged` 两个作用域已经给出这个文件的两段 patch，拿磁盘正文依次倒着打回去就是 HEAD 的行（`nodes/editor/git-gutter.ts`）。倒打时逐行核对上下文与新增行，对不上（取 diff 与读正文之间磁盘又变了）就不画——错位的标记比没有标记更误导。未跟踪或刚 `git add` 的新文件整份算新增。

HEAD 的行交给 CodeMirror 的一个 StateField，按键后 250ms 用 `lib/line-diff` 的同一套对齐重算，所以标记跟着草稿走而不是等保存。重取时机：视图重建、保存 / 重载 / 草稿合并之后、窗口回焦，以及 Git 面板做完写操作（它会让 `git-status` 查询失效，这里订阅 QueryCache 的那一下；拿不到 QueryClient 时——比如单测——只是少这一条触发）。不在仓库、没有执行权限、旧 Runtime：没有标记，不报错。

### 37.3 媒体预览

`file-info` 的 `preview` 加了 `video` / `audio` / `pdf`（`shared/api/files.ts`）。判定在 core 的 `files/mime.ts`（`mediaPreviewOf`），`imports/batch.ts` 的 `fileInfo` 调它：只收页面引擎能播的容器（`.avi` / `.mkv` 仍是下载，免得打开一个永远在转圈的黑框），而且不超过下载路由的 16 MiB——页面是整份取回再包成 blob 的。

没有加路由：`file-download` 为了不让上传的 HTML 在 core 的来源里执行，永远回 `application/octet-stream` 附件，所以和图片一样由页面按 Runtime 报的 MIME 包成 blob 再交给原生 `<video>` / `<audio>` / `<iframe>`。为此 CSP 加了 `media-src 'self' blob:`、`frame-src` 加了 `blob:`（服务器壳的策略逐字继承），Electron 窗口开 `plugins: true`，内置 PDF 查看器才会启动。PDF 的框不加 `sandbox`：带沙箱时引擎直接拒绝启动查看器，而那个 blob 是页面自己按 PDF 类型包的，不会被当成 HTML 解析。

图片：适应 / 1:1 两档加滚轮缩放（节点体本来就是 `nowheel`，画布不会跟着缩；从「适应」开始滚以当前实际显示比例为起点），透明区域铺两种表面色的棋盘格，放大到 4 倍以上改成像素化采样。引擎解不开的媒体仍退回下载卡片。

### 37.4 草稿保护

- 未保存的正文去抖 400ms 写进 localStorage（`nodes/editor/drafts.ts`，工作空间 + 路径一条，记着改起时的内容版本与那一版正文）；关页面、切走标签页、节点卸载时立刻写掉排着队的那一截。用 localStorage 而不是 IndexedDB 是因为最后那次写必须同步——`pagehide` 里等不到一个异步事务提交。
- 重开时：磁盘还是那一版就原样放回，提示「已恢复」并可一键丢弃；磁盘变了就放回草稿，但保存凭据退回旧版本（直接保存会 409，不会悄悄盖掉别人的修改），提示条出现「合并」。
- 合并复用 `editor/merge/`：`merge-store` 加了 `draft` 模式与 `beginDraft`，对话框在这个模式下换成「打开时的版本 / 草稿 / 磁盘上的版本」的叫法，只有一个「应用到草稿」——结果放回编辑器，磁盘那一版成为新的保存凭据，写不写盘仍由保存决定。会话中途磁盘变了、有草稿时，提示条同样给出「合并」，base 是上一次读到或保存的正文。
- 打开时文件读不到而本机有草稿：先问 `file-version`，确认是文件没了（不是断线）才把草稿当正文打开，按新建保存。文件被删或移走时提示条多一个「另存为」：按新建写到新路径（已有文件就是 409，对话框里说出来），然后节点改指过去、标题原本是旧文件名时跟着改。
- 监听注册的回答可能比恢复后的那次渲染先到，恢复时同步写 `dirtyRef`，免得它把刚放回的草稿当成干净编辑器自动重载掉。

### 37.5 验证

`pnpm libs:build` 之后：`pnpm --filter @armadra/web typecheck` 通过；`pnpm --filter @armadra/web test` 2658/2660，失败的两条是 `i18n.test.ts` 的 `integration.legacy.list`（基线 `77b62763` 就在，不是这里引入的）和 `AutomationDrawer.test.tsx` 的一条（整套跑时超时，单独重跑 18/18 通过）；`pnpm --filter @armadra/desktop test` 2835 通过 13 跳过；`pnpm --filter @armadra/server test` 68/68；`pnpm check` 与 `pnpm format:check` 通过。新增用例：`nodes/editor/git-gutter.test.ts`（倒打 patch、核对失败、只删的 hunk、三种标记、新文件、CRLF）、`files/recent-files.test.ts`、`nodes/EditorNode.drafts.test.tsx`（草稿落本机与放回、保存后清掉、磁盘变了走合并再按新版本保存、文件没了另存为、行边标记随编辑变化），`QuickOpen.test.tsx` 补最近文件 / `路径:行:列` / 跳转到行，`EditorNode.test.tsx` 补音视频 / PDF / 图片缩放，`imports/batch.test.ts` 补媒体判定与下载上限。

没做：在打包应用里实测 PDF 查看器与视频解码（只在单测里验证了 DOM 与 CSP 串）；「重新定位」——把草稿接到一个已存在的文件上；标题的「未同步」状态。

## 38. 搜索取消、文件树路径项、语言服务随授权停、Projects 全量翻页（2026-09-26）

### 38.1 项目搜索可以取消

- `core/files/search.ts`：`searchContent(root, request, signal?)` 改成异步；walk 拆成生成器，`indexFiles` 同步用，搜索每 64 个文件 `setImmediate` 让一次事件循环、每个文件前 `signal.throwIfAborted()`。不让出事件循环，socket 的 `close` 要等整个 5s 预算花完才会被看到，取消等于没有。5s 总时长上限照旧。
- `core/files/routes.ts` 只动了搜索那条路由：`connectionSignal(request)` 挂在 **socket** 的 `close` 与请求的 `aborted` 上——请求体读完 `IncomingMessage` 就 close 了，只有 socket 活到处理结束；处理完摘掉监听（keep-alive 的 socket 会承载很多请求）。中止后答 499 `cancelled`，没人收。
- `ProjectSearchPanel`：同一时刻只留一个请求。新查询、卸载（关掉面板或切走搜索页）、点「停止」都中止上一个；停掉的是新查询的第一页就清掉屏幕上旧查询的结果，停掉的是「加载更多」则保留已有页。搜索中「搜索」按钮仍可提交。

### 38.2 文件树右键：复制路径、复制相对路径、在访达 / 资源管理器中显示

- 复制两项不受写权限约束；绝对路径按根目录的分隔符拼（Windows 根接反斜杠）。
- **取舍：「显示」不走壳的 `revealPath`。** 壳的 `shell:show-item-in-folder` 白名单只认数据目录和下载目录，并且是故意不收工作区根目录的（`shell-core/reveal-path.ts`：壳不知道哪些目录是工作区）。所以白名单不动，改在 core 新增 `POST /api/workspaces/{id}/reveal`（`core/files/reveal.ts`）：`resolveInRoot`（内部是 `contains`，跟随符号链接后再证明一次）确认在根目录内，越界 403 `forbidden`；远端工作区 501 `unsupported`；由 core 用 `execFile`（不经 shell）拉起 macOS `open -R`、Windows `explorer.exe /select,<path>`、Linux `xdg-open <父目录>`，平台与启动器都可注入。路由 scope 与开终端同一档（`terminal:create`）；handler 只要求工作区可读，不看工作区的 `execute` 开关——打开文件管理器不执行工作区里的东西，而那个开关默认关，看了这一项几乎永远不出现。
- 页面只在 `isDesktop()` 且工作区在本机时显示「显示」这一项：服务器壳上 core 不在用户眼前。文案按平台叫「访达 / 资源管理器 / 文件管理器」，放在 `i18n/explorer.ts`。

### 38.3 语言服务失去 execute 授权立即停

- `bus.ts` 新增 core 内部事件 `workspace.grants`（不下发客户端）；`workspaces/routes.ts` 在 PATCH 带了 `permissions` 与 DELETE 时发它。
- `language/policy.ts` 的 `grantChange`：工作区没了 → `stop` + `workspace_closed`；丢 `execute` → `stop` + `execution_not_granted`；只丢 `write` → `readOnly`。`Manager.applyGrants` 执行它：停止时先把 hub 移出表（关停宽限期内新开的会话会起新 hub 并在那里被拒），**先停进程再清会话**——`stopProcess` 会给每个还挂着的会话发 `language.session { state: "stopped", reason }`，先清会话就没人听得到；`readOnly` 把已开会话的 `allowWrite` 收回。
- 执行主机切换目前仍是 `unsupported`（R5），那条路由接上时也应发 `workspace.grants`。

### 38.4 Projects v2 状态映射翻完所有页

`projectStatuses` 按 cursor 一直翻到 `hasNextPage` 为假，50 页（5000 条）作保险上界；到上界、下一页没给 cursor、或 cursor 重复时返回 `partial: true`。`list-issues` 响应新增 `statusGroupsPartial`（`types.ts`、`schema.ts`、页面 zod、契约 §5.2 末段）。页面暂未展示这个标记。

### 38.5 验证

- `pnpm --filter @armadra/desktop test`：244 个文件通过、2 个跳过（2849 通过 / 13 跳过）。新用例：`files/search.test.ts`（预先中止与扫描中途中止）、`files/routes.test.ts`（真 HTTP 服务器上 fetch 中止 → 信号触发）、`files/reveal.test.ts`（三平台 argv、越界 / 符号链接逃逸、远端、不可读）、`http/route-scopes.test.ts`、`language/policy.test.ts`、`language/routes.integration.test.ts`（PATCH 去掉 execute → 会话收到 `stopped` + `execution_not_granted`、hub 清空、进程退出、再开会话 403）、`github/endpoints.test.ts`（GraphQL fixture：7 页翻完、50 页上界标 partial、cursor 原地打转、缺 cursor）。
- `pnpm --filter @armadra/web test`：2644 通过、1 失败——`i18n.test.ts` 报 `integration.legacy.list` 未被引用，这个键来自基线 b1811c85，不是本节改动；本节新增的键都被引用。新用例：`ProjectSearchPanel.test.tsx`（新查询 / 停止 / 卸载三种中止）、`FileTree.test.tsx`（两种复制、只读工作区也有复制、网页不显示「显示」、桌面调 core、远端工作区不显示）、`files/use-file-actions.test.ts`。
- `pnpm --filter @armadra/server test`：68 通过。`pnpm check`（含 `format:check`、typecheck、repo:check）通过。

## 39. 浏览器节点入口、浏览数据、状态页徽标与壳进程计量（2026-09-26）

### 39.1 服务器壳也能新建浏览器节点

`/health` 与 `/api/health` 的文档末尾追加 `capabilities`（`Record<string, boolean>`），由各域经 `CoreServer.capability(name, probe)` 自己登记、每次现问；浏览器域登记 `headlessBrowser`，只有选中 headless 后端**且找到了 Chromium** 才为真。页面侧 `nodes/browser/availability.ts` 只问一次（问不到按「没有」处理，下次挂载再问）：新建菜单在「桌面壳或 `headlessBrowser`」时给出浏览器项，手机焦点页与节点菜单的「整屏打开」在 `headlessBrowser` 时接受浏览器节点。取舍：放进 health 而不是新开路由，因为页面启动本来就问它；字段追加在末尾，壳按字段名解析，旧页面忽略不认的键。

### 39.2 清理浏览数据、项目内历史、起始页

- 新 IPC `browser:clear-data`（只追加）：主进程 `main/browser/clear-data.ts` 对 `persist:armadra-browser-*` 这一族 partition 调 `clearStorageData()` 与 `clearCache()`。清哪些取并集：`<userData>/Partitions` 下扫到的目录（删掉的工作空间的登录也在这里）+ 页面报上来的工作空间 id（本次启动新建、还没落盘的）；只认这一族前缀和 `[A-Za-z0-9_-]` 的 id。
- 地址栏右侧的历史下拉：按工作空间存本地偏好（`armadra.browser.history.<id>`，上限 50，去重、最近在前，只记 http(s)），在节点把活动标签的地址写回画布时记录。不写进节点数据：那样每次导航都是一次画布保存，节点删了历史也跟着没。清理浏览数据时连历史一起清。
- 设置 → 浏览器新增一张卡：「新节点起始页」（按地址栏同一套规则补全，空 = 内置默认页）与「清理浏览数据」（二次确认）。浏览器设置页仍只在桌面壳出现，所以服务器壳上的 headless 配置文件不在这次清理范围内。

### 39.3 Provider 状态页 / 事故徽标

`core/usage/status.ts`：并发读 Anthropic、OpenAI、GitHub 的 `/api/v2/status.json`，每家 5 秒超时，结果缓存 5 分钟，同一时刻只有一趟在路上；非 200、JSON 不对、指示值不认识、离线、超时一律 `unknown`，从不回退成正常。`GET /api/usage/status` 回 `{ enabled, providers }`；设置 `usage.statusPage`（默认开，账号与用量页可关）关掉时不联网、回 `enabled: false`。用量卡按 Claude→Anthropic、Codex→OpenAI、Copilot→GitHub 对应，只在 `minor / major / critical / maintenance` 时显示徽标，第三方原文只放在悬停提示里。测试对着 127.0.0.1 上的 HTTP fixture 跑（含挂起不回话、503、坏 JSON、没人监听），不碰真网络。

### 39.4 壳自身进程与 headless 浏览器计入平台组件

- 桌面壳每 5 秒用 `app.getAppMetrics()` 采一次，按 `webContents.getAllWebContents()` 里 `getType() === "webview"` 的 `getOSProcessId()` 区分浏览器节点的页面，经已有的 drive 通道发 `shellMetrics` 事件（不属于任何节点，`nodeId` 为空串）。core 在浏览器域收到后交给资源域，逐行校验、30 秒没有新报告即视为过期。平台组件新增 `shellMain / shellRenderer / shellGpu / shellUtility / browserGuest` 五种，都按单个进程算（主进程的子进程里有 core 本身，按树算会把会话再数一遍）；数字优先用 core 自己进程表里那一行，对不上才用壳报的。
- `service.ts` 里硬编码的 `browsers: []` 换成 headless 后端登记的来源：每个活着的节点的 Chromium 主进程（pid + 启动时间），按树计入渲染进程。
- 资源面板照旧按 `kind` 出行名；「只算这个进程；它启动的会话在上面」这句现在只给 Runtime，其余单进程行写「单个进程」。

### 39.5 验证

- `pnpm --filter @armadra/web test`：2651 条里 3 条在满载时超时（`AutomationDrawer` 两条、`CommitPage` 一条），单独重跑 27/27 通过；另 1 条是基线上已有的失败，与本节无关：`i18n.test.ts` 报 `integration.legacy.list` 没有引用（来自 b1811c85）。
- `pnpm --filter @armadra/desktop test`：`main.test.ts` 的 health 文档断言补上 `capabilities` 后全绿（vitest 2850 通过，live 1/1，脚本 38/38）。
- `pnpm --filter @armadra/server test` 通过；`pnpm check`（含 `format:check`、两边 `typecheck`、`repo:check`）通过。

## 40. 快捷键补齐三项、更新器拆掉 host 依赖（2026-09-26）

### 40.1 快捷键（终端宿主设计 §10.1）

S01 剩下的三项补上了，存储形状只加不改，旧数据不需要迁移：

- **设为无。** 一条空串覆盖。`readLayer` 以前把空串当「没写」丢掉，现在留下：没有这个键是「没覆盖」，空串是「覆盖为空」，来源照报本层，↺ 退回下一层。旧的扁平写法里空串仍然丢掉——那一版没有「清空」这回事。
- **多组替代键。** 存储本来就是逗号分隔。每行的「更多」菜单里「再添加一组按键」进入追加录制（`addChord`，修饰键别名归一后重复的不加），多于一组时可逐组移除（`removeChord`，删掉最后一组就是清空）。冲突检测逐组比较，第二组撞车或是窗口保留键同样报。
- **自定义 `when`。** 每层新增不分平台的 `when` 表（默认档在 `settings.keymap.when`，其余档在 `profiles.<id>.when`，本设备同形），空串表示「不设条件」。不按平台分是因为条件里本来就能写 `platform == mac`。对话框按 `when.ts` 的语法校验，语法错与不认识的键分开提示，有错时保存按钮不可用；读设置和导入时读不懂的条件直接丢掉，免得一条命令在任何地方都悄悄不触发。`keymapConflicts` 与 `useKeybindings` 都改读合并之后的条件（`commandWhen`）。

顺带修了一处：编辑器、浏览器节点装在子树上的监听器不传 `keymap`，以前只认默认键——用户在设置里改的编辑器 / 浏览器键位到了节点里不作数。`useKeybindings` 不传 `keymap` 时改读 `setActiveKeymap` 那一份。

全部重置时 `when` 那一格没改过就不带进 PATCH，平台两格照旧总是带上，与从前的形状一致。

### 40.2 更新器拆掉遗留的 host 依赖（§18.6）

`UpdatesDeps.host` 与装配处的空实现一起删掉；`shell-core/updates/coordinate.ts` 里只为它存在的 `launcherPath` / `hostDataDir` / `probeHostVersion` / `hostIsOurs` 一并删除，`HealthReadings` 与 `Component` 去掉 `host`。

这不只是清理：`restartReport()` 以前把「探不到 Host 版本」读成 `null`，而 `null` 永远算不一致——每一次更新重启后都会报「更新没有完成」。现在只核对壳与 Runtime 两个版本。原因码 `hostStopFailed` 保留原名：它是页面与文案共用的线上取值，含义仍是「后台停不下来，所以不装」。页面那边 `mismatched` 的联合类型里还留着 `"host"`，是超集，不影响。

### 40.3 验证

- `pnpm --filter @armadra/web typecheck` 通过；`pnpm --filter @armadra/web test`：2653 过、1 失败，失败的是 `i18n.test.ts` 的未引用键检查，报的是 `integration.legacy.list`，基线 77b62763 上就已存在，与本节无关。
- `pnpm --filter @armadra/desktop test`：2829 过、13 跳过，无失败（其中 `src/main/updates` 与 `src/shell-core/updates` 8 个文件 265 条）。
- `pnpm check`、`pnpm format:check` 通过。

## 41. 多设备画布：在线设备与编辑租约（2026-09-26）

H04 的前置（设计 `design/canvas-platform-design.md` §3 H04、`design/server-accounts-and-sharing.md` §5）。此前同一块画布被两台设备同时打开时，只有 revision CAS 兜底：后写的撞 409 再变基，两边对写时来回互相覆盖，谁也不知道对面有人。契约写在 `contracts/core-json-api.md` §9。

### 41.1 做了什么

- **core `canvas/presence.ts`**：按画布的在线表与写租约，**全在内存**，没有迁移（0028 没用）。客户端按 `clientId` 心跳，30 秒没心跳算断开；租约至多一个持有者。规则：只有一个客户端时第一次心跳就拿到租约；有别人在看时空租约归带 `active` 的心跳或带 `clientId` 的保存；持有者断开立刻释放，空闲 3 分钟且有别人在看时释放；`takeover` 无条件转手。5 秒一次的扫描把断开的设备摘掉并发事件。
- **路由**：`POST …/boards/{boardId}/presence`（心跳，只要 `canvas:read`）、`DELETE …/presence/{clientId}`（离开）、`POST …/boards/{boardId}/lease`（拿 / 接管）。`PUT …/document` 多一个可选 `clientId`：租约在别人手里时 423 `canvas_lease_held`，判在 CAS 之前，CAS 的 409 语义不变。core 自己的写者（控制动词、调度、依赖编排）直接调 `saveBoard`，不经过租约。
- **事件**：新增 `canvas.presence`（`bus.ts`、`packages/shared` 的事件联合），只在有人来、有人走、租约换手时发。它不进 outbox（`events/stream.ts` 的 `EPHEMERAL_EVENTS`）。
- **页面**：`store/canvas/presence.ts` 存最近一份在线表并回答「只读吗」（租约在**别人**手里才算）。`internal.commit`、`setWhiteboard`（本地编辑）与撤销回放在只读时不落，所以菜单、快捷键、粘贴、拖放一起被拦。`flowOptions` 在只读时关掉节点拖动和连线，自动保存不写编辑也不写视口。`use-board-sync` 负责每 10 秒心跳、回前台补一次、被 423 拒时马上补一次，切板或关页面时离开；丢了租约时丢掉本地未落盘的改动并按远端重载。画布右上角工具簇左侧的 `PresenceBar` 只在有别的设备时出现：每台设备一个小圆点，持有者用主色；只读时加一句「X 正在编辑」和「接管」，接管前弹确认框。
- `clientId` 存在 sessionStorage，读出后立即删除，页面隐藏时再写回。这样刷新一次沿用同一个 id，不会被刷新前的自己占住租约；复制出来的标签页则拿到新 id。

### 41.2 取舍

- 设备名来自客户端（系统，网页里再加浏览器名），没有读身份域的设备表。原因是域路由今天还不携带会话（`identity/gate.ts`），路由看不到请求来自哪台设备。等 R8 让路由带上 principal 之后，改成从会话取设备名，客户端报上来的值只作兜底。
- 没带 `clientId` 的保存：租约空着时放行、不拿租约，别人持有时拒绝。这样没有身份的旧写者不会被一刀切断，也绕不过别人手里的租约。
- 同一台机器开两个窗口也算两个客户端，后开的那个是只读。这是「同时只有一个写者」的直接结果。
- 只对画布文档加了租约。画布改名、删除和上下文链接的 PUT 不经过租约。

### 41.3 验证

- `pnpm --filter @armadra/desktop test`：253 个文件、2934 条通过（13 条跳过）。新增 `canvas/presence.test.ts` 12 条（单客户端无感、首拍之前的写入拿租约、两客户端争用、匿名写被拒 / 放行、接管、空闲释放、没人争时不释放、断线释放并交给剩下那台、显式离开、过期清表、参数校验）；`canvas/routes.test.ts` 加了 5 条 HTTP 用例（单客户端只发一帧、423 与接管、持有者的旧修订号仍然 409、离开释放、参数与 404）；`events/outbox.integration.test.ts` 加了「在线表只扇出、不进 outbox」；`stream.test.ts` 的事件类型表加上 `canvas.presence`。
- `pnpm --filter @armadra/server test`：9 个文件、68 条通过。
- `pnpm --filter @armadra/web test` / `typecheck`：277 个文件、2721 条全部通过。新增 `canvas/PresenceBar.test.tsx`（只有自己时不渲染、空租约可写、别人持有时只读且拦下编辑、别的画布的快照不算、接管先确认），`use-board-sync.test.tsx` 加了 3 条（单客户端无感、被接管后只读并重载、卸载时离开），`autosave.test.ts` 加了 3 条（带 `clientId`、只读不写、423 不报错），`flow-options.test.ts` 加了 1 条。
- `pnpm check`、`pnpm format:check`：通过。

没做：浏览器里的两设备实测（只跑了单测与路由测试）；审计日志里记一条「画布接管」；把设备名接到身份域。

## 42. 服务器账号、组与共享真正启用（R8，2026-09-26）

设计 `design/server-accounts-and-sharing.md`，契约 `contracts/core-json-api.md` §10。此前数据模型与接口都在（0019、`accounts-http.ts`），但判定恒为 owner：服务器壳认证完请求就把人丢了，core 里的每一处 `allows()` 问到的都是本机 owner；成员会话还把登录时的授予写进快照，撤销一条共享要等会话过期。

### 42.1 做了什么

- **请求主体**：`core/identity/gate.ts` 新增基于 `AsyncLocalStorage` 的 `runAs` / `requestIdentity` / `currentSubject`，门的 `subject()` 改成「当前请求的主体，没有就是本机 owner」。服务器壳（`serve.ts`）用 `auth.ts` 新的 `admit()` 认证出 `Principal`，把请求与升级都包进 `runAs`；匿名面给一个没有任何授权的成员身份，而不是留空（留空等于 owner）。
- **路由门**：`core/identity/route-access.ts`，经 `installRouteGuard` 挂在 `core/http/server.ts` 的分发与升级之前（这是对 `server.ts` 的唯一改动，十几行）。按 `router.requiredScope` 判；没有请求身份时放行，所以桌面壳行为不变。成员：表外路由与全局路由 403；`GET /api/workspaces` 放行但过滤；`POST /api/terminals` 按请求体的 `workspaceId` 要 `terminal:create`；已有终端按 `terminal_sessions.workspace_id` 找画布，读画面要 `terminal:read`，写与附着 `…/ws` 要 `terminal:drive`，自己在本进程里开的要 `terminal:create`。`route-scopes.ts` 补两条：`/api/workspaces/{id}` 的写要 `workspace:share`（改根目录与删除只给 owner），`/open` 按读算。
- **事件流**（`core/events/index.ts`）：升级前的 `events:read@workspace` 判定问的已是请求主体；guard 按升级请求记下身份，socket 打开后订阅 `onAccessChanged`，授权一变就先 `revalidate`（重新认证会话）再判，不够就以 4403 关掉。授予 / 撤销 / 改角色 / 组成员增删 / 删组 / 停用账号 / 撤销设备 / 登出都会发一次 `accessChanged()`。
- **快照**：成员口令登录只快照 `identity:read`，共享授权每次现编；`GET session` 报「快照 ∪ 现编」。`listDevices` 只列自己的设备（有了成员之后原实现会对 owner 抛 permission）。停用 owner 被拒。
- **接口补全**：`POST register` 持邀请注册（建成员 + 设口令 + 兑换，一笔事务，再照口令登录发会话；不带邀请仍 501）、`DELETE invitations/{id}` 作废邀请。成员增删、组成员与角色、授予与改角色原本就有。
- **服务器壳**：`hasAdmin()`（没有 owner 时启动日志提示用配对链接成为首个管理员）、`invite()` 与 `invitationUrl()`（邀请落在页面根的 `#invite=` 片段上）。
- **页面**：设置「账号与共享」（`AccountsSharingPage.tsx`，`nav.ts` 新增 `serverOnly`，只在服务器壳托管的页面出现）：我的账号（账号标识、设置口令）、未登录时的口令登录；管理员另有成员（添加、停用）、组（新建、成员与组内角色、删除）、邀请（按工作空间与角色生成链接、作废）、共享（按工作空间列授予、改角色、取消、添加成员或组）。`SettingsDialog` 看见 `#invite=` 自动打开到这一页，页面取走令牌弹出兑换对话框。客户端 `api/accounts.ts`，文案 `i18n/sharing.ts`。

### 42.2 取舍与没做的

- 共享只发工作空间上的授权，所以成员在全局路由上一律 403：设置、Agent 目录、模型、执行主机、审批答复、`/api/agent-status/*`、`/api/ownership`、`/api/nodes/{id}/context-reads` 都是。成员打开页面时这些面板会报无权限；要放开得逐条决定哪些全局读对成员无害，这次没做。
- 终端创建者只记在路由门的内存里（创建成功那一刻），core 重启后旧会话一律按「别人的」判；终端域自己的 `DriveBook` 仍不知道写入者是谁（没有改 `core/terminal`）。
- 事件流的复核用的是升级时那把访问密钥；它过期（15 分钟）之后再遇到一次授权变化，这条 socket 会被当成失效关掉，页面带新 Cookie 重连。复核只在授权变化时发生，不是定时的。
- 组角色（`admin`）只存不判：组管理员还不能管自己的组。成员不能自己停用、改名。
- passkey、OAuth 绑定、开放注册仍按设计返回 501（需要外部条件）。
- 没有用迁移（0029 未用）。

### 42.3 验证

- `pnpm --filter @armadra/desktop test`：253 文件 2927 条通过（node-pty `spawn-helper` 缺执行位，`chmod +x` 后终端用例全绿，环境问题）。新增 `core/identity/route-access.test.ts`（owner / driver / operator / editor / viewer / 非成员的路由矩阵、列表过滤、终端创建者）与 `accounts.test.ts` 的 R8 四条（持邀请注册、作废邀请、组共享入组即有移出即无、收权通知与 owner 不可停用）。
- `pnpm --filter @armadra/server test`：10 文件 79 条通过。新增 `sharing.integration.test.ts`：真起 `serve`，首个管理员配对，三人经邀请注册；矩阵（列表 / 读 / 写 / 开终端 / 改工作空间与全局设置 / 改共享）、非成员升级前 403、成员只收自己画布的帧、邀请一次性与作废、撤销共享后事件流 4403 关闭且下一个请求 403。
- `pnpm --filter @armadra/web test` / `typecheck`：新增 `AccountsSharingPage.test.tsx` 6 条；全量跑时 `AutomationDrawer` 与 `KeybindingsPage` 各有用例超时，单独重跑通过（负载所致）。
- `pnpm check`、`pnpm format:check` 通过。

## 43. 节能休眠：空闲 Agent 会话结束进程、用 resume 接回（2026-09-26）

设计 `design/terminal-host-design.md` §7.2，实现记录在同文件 §7.4。起因：tmux 后端下应用退出后闲置的 Claude / Codex 会话仍常驻，7 个闲置 5–9 天的会话占了约 800 MB；tmux 探测修好之后打包版恢复跨重启存活，这个问题会更明显。

### 43.1 做了什么

- **core**：`terminal/hibernate.ts`（判据、设置读取、计划目标检查、库里的休眠状态、唤醒接缝，纯函数为主）与 `terminal/hibernator.ts`（60 秒一轮的巡检、结束、接回）。`manager.ts` 只加三个钩子：`hibernate`（确认退出后才把行记成 `termination_intent = 'hibernate'`）、`revive`（同一会话 id、同一 `session_key` 起下一代）、`liveRecords`；会话行多一个 `hibernation` 字段。接回时把 `agent_status` 标成 `restored`，投递门链因此等 CLI 自己报一条再投。
- **唤醒**：`POST /api/terminals/{sessionId}/wake`（页面点击 / 聚焦）；终端桥新增 `wakeNode`，`collab/control/index.ts` 在 `send` 走门链之前调它（`send.ts` 未改），出队泵的排队项由巡检发现并叫醒；`schedule/dispatch.ts` 对授权了 `LAUNCH_FROZEN` 的休眠目标改走 resume，不另起会话，没授权的照旧答离线。同一节点并发唤醒只起一个。
- **事件与设置**：工作空间事件 `terminal.hibernation`（`hibernated` / `resuming` / `running` / `failed`）；设置键 `terminal.ecoMode`（缺省开）与 `terminal.ecoIdleMinutes`（5–1440，缺省 30）。
- **资源面板**：休眠的会话照列，`unknownReason: "hibernated"`，数字为空，不给「结束」。
- **页面**：`render-state.ts` 新增 `hibernated` 档；`use-session` 读到休眠不新建会话，新增 `surface/use-hibernation.ts`；节点头「休眠中 / 正在唤醒 / 唤醒失败」，终端体上「唤醒」按钮，点任何位置或聚焦都唤醒；设置 → 终端加「节能休眠」开关与「空闲多久后休眠」。
- 契约 `core-json-api.md` §11，架构指南补一段。

### 43.2 取舍

- **不加迁移**：休眠就是那一行以 `termination_intent = 'hibernate'` 结束；cwd、shell、Agent、provider 会话 id、权限模式与模型都已在库里，进程不在时没有东西改写它们。分配的 0030 没有用。
- **缺省开**：与 §7.2「首版默认只回收视图」不同，按上面的实测改；判据从严（有附着、半截输入、租约、排队、审批、后台作业、计划、状态不明都不睡）。
- **不看可见性**：有 socket 附着就不睡，页面隐藏只是让前端按原有规则关 socket，本身不触发休眠。
- **后台作业**：pane shell 下除 Agent 外还有作业，或 Agent 下面挂着 shell（CLI 放到后台的命令），都不睡；MCP 这类常驻子进程不是 shell，不算。
- **被取代**：依赖编排、手动「重新运行」起的新会话排在休眠行前面，休眠自然失效，不会同一节点两个 CLI。
- 「友好退出」就是结束会话，没有先发 CLI 的退出命令；原生循环与浏览器控制依赖没有可观测信号，没有实现。

### 43.3 验证

- `pnpm --filter @armadra/desktop test`：256 文件 2969 条通过、13 跳过（worktree 里 node-pty 的 `spawn-helper` 缺执行位，`chmod +x` 后通过）。新增 `terminal/hibernate.test.ts`（判据逐格、设置、后台作业）、`terminal/hibernator.test.ts`（假 CLI 后端：running → idle → hibernated、退出未确认不记休眠、关掉不睡、重启后重新起算、十余种不该睡的情况、同一 id 下一代接回并敲 `--resume <同一个 id>`、并发只起一个、被取代不再接回、失败、排队唤醒、Codex 子命令形状）、`terminal/hibernator.pty.test.ts`（真 PTY 上的假 `claude`：进程确实结束，接回后收到 `--resume prov-7`）、`terminal/hibernate-wake.test.ts`（`send` 先唤醒再排队、接不回来如实拒绝、计划授权与未授权两种）；`events/stream.test.ts` 事件类型表改为 24 个。
- `pnpm --filter @armadra/web test`：2711/2714，失败的三条（`AutomationDrawer.test.tsx` 一条、`KeybindingsPage.test.tsx` 两条）是整套跑时超时，单独重跑全过；新增 `session/gateway.test.ts`，`TerminalSurface.render.test.tsx` 补「读到休眠不新建、点唤醒后原样重连」，`render-state.test.ts`、`metrics.test.ts` 各补一条。`pnpm --filter @armadra/web typecheck` 通过。
- `pnpm --filter @armadra/server test` 68/68；`pnpm check` 与 `pnpm format:check` 通过。
- 没有在打包应用里实测 tmux 后端下的真实 Claude / Codex 续接。

## 44. 远端执行主机补齐：Git 长操作、语言连接、资源读取与推送监听（2026-09-26）

§34 之后远端工作空间还剩四块：Git 的操作队列 / 集成状态 / 工作树绑定 / AI 提交信息答 501，语言服务答 `unsupported_remote`，资源面板对 SSH 会话只标 `remote`，文件监听靠控制端 2 秒轮询。这一节把它们接到 Worker 上。

### 44.1 做了什么

- **推送通道**：Worker 会话（`core/remote/session.ts`）持有跨请求的状态，随 stdin 关闭统一收尾；`requestId` 为空的答复帧就是推送。控制端 `RemoteWorker` 新增 `onEvent / onConnected / onDisconnected`，远端域把它们接到 `remote/execute.ts` 的 `listenRemote`，各域按 `channel`（`control` / `language`）订阅，互不知道对方。
- **Git 长操作**：`git.operationStart` 在 Worker 自己的仓库队列里排（同一段 `startOperation`），Worker 每 200 ms 看一眼快照、变了才推一帧 `git.operation`（`remote/git-worker.ts`）。控制端 `remote/git-operations.ts` 记归属与镜像，`GET …/operations/{id}` 直接答镜像，取消经 `git.operationCancel`（幂等，可重放）。连接断开时镜像里排队的记为 `cancelled`、在跑的记为 `unknownOutcome`，晚到的帧不能把终态改回去；Worker 退出前 `RepositoryService.shutdown` 取消在途操作。集成状态（`git.integration`）与工作树绑定（`git.worktreeBinding`）在执行主机上读，归属对照仍在控制端。
- **AI 提交信息**：`message.ts` 拆出 `generateFrom(reads, …)`。远端工作空间的采集、敏感文件筛除、脱敏与复核在 Worker 上（`git.messageCapture` / `git.messageSource`），模型 CLI 与凭据只在控制端。
- **远端语言服务**：选了**第二个 Worker 进程**（`worker --stdio --language-link`，ssh 启动行早就按「只差这个旗标」写好），而不是在控制连接里多路复用。取舍写在 `remote/language.ts` 头注释：一根有序 stdio 管道上，几百 KB 的补全 / 诊断会堵住文件保存与 Git 状态；语言服务器是编译器级子进程，崩了不该拖着控制连接；连接一断 Worker 调 `Manager.shutdown`，服务器随之停，不留孤儿；帧、握手、能力、重连退避、读重放 / 写不重放全部沿用。代价是同一主机多一个 ssh 连接与一次认证（配了 `ControlMaster` 的复用同一条 TCP）。Worker 那头跑的就是本机的 `Manager`（发现、会话、影子文档、白名单、`WorkspaceEdit` 落盘）；控制端 `language/remote.ts` 只授权与搬运——浏览器的一条文本是一次 `language.send`，服务器发往会话的消息是 `language.message` 推送。设置随请求带去，去掉按主机记的探测缓存；Worker 开会话前先在自己机器上探测。语言连接断开时，该主机上每个会话收到 `disconnected / link_lost` 并关 socket，编辑器按原有退避重连。主机不可达时服务列表每种语言一行 `disconnected / link_lost`；Worker 太旧（不带 `remote.language.v1`）仍是 `unsupported_remote`。
- **多执行主机资源**：Worker 新增 `resources.read`（`remote/resources-worker.ts`），一轮答主机总览加若干会话进程树，CPU 基线存在 Worker 会话里（第一轮 `null`，第二轮起有数）。会话与远端进程树靠 SSH 连接对上（`resources/sockets.ts`）：控制端找到窗格里的 `ssh` 客户端和它连出去的本地端口，Worker 找本用户里握着对端端口正是它的连接的进程——`sshd` 的会话进程，shell 及其下都是它的后代。读取优先 `lsof`，Linux 上没有时读 `/proc`。控制端 `resources/remote.ts` 是按主机的缓存：采样仍是同步一拍，读缓存里上一轮的数并登记下一轮，一台主机一拍最多一个请求；读不到、对不上、超过 30 s 的缓存一律如实为 `null`（原因 `remote`）。`sessions.ts` 从终端节点的 `ssh.hostId`（退回工作空间执行主机）认出主机；`sample.ts` 的会话行带 `executionHostId`；`resources/hosts.ts` 以子类覆盖 `snapshot`，快照多一个 `executionHosts`（工作空间绑定的主机与 SSH 终端连到的主机，读不到的主机照样列出、各项为 `null`）。`service.ts` 没有改动。面板：主机筛选提到抽屉里，总览与会话表跟同一个筛选；筛选项包括没有会话的远端主机，显示设置里的主机名。
- **远端文件监听**：改成 Worker 侧 `fs.watch` 推送（`remote/watch-worker.ts`）：按工作空间整组登记（`files.watch`），看父目录（原子改名不丢），事件合并后按内容哈希判断再推 `files.changed`；看不了的目录 Worker 自己复查。注册答 `mode: events`。控制端保留轮询作退路：Worker 不认 `files.watch` 时一直轮询；连接断开先退回轮询，轮询的请求把连接拉起来，握手后整组重登并比对一次版本补上断线期间的变化，再停轮询。
- 新增能力 `remote.git.operations.v1`、`remote.watch.v1`、`remote.resources.v1`、`remote.language.v1`；缺哪组，控制端对那组答 501 并写明能力名。`remote/execute.ts` 的 `localOnly` 已无人用，删除。

### 44.2 没做 / 取舍

- **会话与远端进程树的对应**依赖连接端口两端一致：经 NAT 改写源端口、`ProxyJump`、`ControlMaster` 复用连接时对不上，如实为 `null`；不改 `ssh` 命令行（例如塞环境变量标记），因为那要改终端域的启动行且远端 `sshd` 默认不收 `SetEnv`。Windows 两侧都没有这条读法。
- **语言连接不做空闲关闭**：Worker 里的服务器按原有空闲策略停，连接本身留着到 core 关停或主机设置变更；长时间无会话时多一条闲置 ssh。
- Worker 重启（连接断开）后远端操作历史只剩控制端镜像里的那些；列表以 Worker 当次会话为准。
- 远端 `language.processes` 已在 Worker 上提供，但资源面板的平台组件行还没有接远端语言服务器（它们不在本机进程表里）。
- 设计文档 `terminal-host-design.md` §8.1 是追溯段落，未改写。

### 44.3 验证

- 新增 `remote/worker-push.test.ts`（本机子进程跑真 Worker，控制连接与 `--language-link` 各一个）：路由发起 `createBranch` 并跟随推送进度到 `succeeded`、列表与跨工作空间 404、终态取消、集成状态与工作树绑定、远端采集 + 本机假 CLI 的 AI 提交信息、镜像在断线时的 `cancelled / unknownOutcome` 与终态不回退、推送监听与断线退回轮询再升回推送、替身 `sshd` 的一轮资源读取（端口对上、树的 RSS 与子进程、第一轮 CPU 为 `null`、对不上的为 `remote`）、主机总览缓存、语言连接上开会话收发 JSON-RPC（诊断回到 socket、远端绝对路径不出主机）、断线告知 `link_lost` 并关 socket、主机不可达时的服务行。
- `execution.test.ts` 两处期望随行为更新（监听登记为 `events`、远端操作列表 200）；`resources/sockets.test.ts`、`sample.test.ts`、web `ResourceDrawer.test.tsx`（主机筛选联动总览）、`metrics.test.ts` 补用例。
- 命令与结果见 44.4。

### 44.4 命令

- `pnpm --filter @armadra/desktop test`：254 文件通过、2 跳过（2928 条通过；worktree 里 node-pty 的 `spawn-helper` 先 `chmod +x`）。
- `pnpm --filter @armadra/web test`：全量跑时 `AutomationDrawer.test.tsx` 与 `KeybindingsPage.test.tsx` 在机器高负载下超时，单独重跑两文件 38 条全过；`typecheck` 通过。
- `pnpm --filter @armadra/server test`：9 文件 68 条通过；`pnpm --filter @armadra/shared test`：155 条通过。
- `pnpm check`（含 `format:check`）通过。

## 45. 第一批留下的零散缺口（2026-09-26）

补 §35–§40 各自记下的「没做 / 已知限制」。

### 45.1 Issues 分组的「部分」标记（§38.4）

`allIssues` 任一页回 `statusGroupsPartial: true` 就在 `IssuePage` 上记下；`IssueList` 在分组上方放一个描边徽标「分组不完整」，悬停说明原因。没有 Issue 时不显示。

### 45.2 挂着的终端节点跟上 core 起的会话（§35.1 已知限制）

冷启动与依赖编排的 `spawnForNode` 都把新会话 id 写进节点数据并发 `board.changed`，页面合并后 `TerminalSurface` 的 `data.sessionId` 就变了。新增 `surface/use-session.ts::useAdoptedSession`：只在节点数据里的 id **变化**时换过去，不和手里的那个比——挂载时 `find` 可能找到比节点数据更新的会话，那时两者不同是正常的；自己新建的会话两边同时写，不触发；正在新建时不抢。换过去的会话不算本次挂载新建（`freshSessionRef = false`），启动行不会再敲一遍。`TerminalNode.tsx` 没有改动。

### 45.3 批量组队 `canvas team`（§36.2 没做的组合操作）

`team --member "agent[@模型]|标题|任务"`（最多 6 个，只切前两个 `|`）一次建一组 Agent 节点，每个都等同一次 `open-agent`：同样的节点数据、从调用者连主从线、第一条任务走投递队列。编排三种：缺省并行（带 `--after` 时一起等外部节点）；`--chain` 让第 N 个等第 N−1 个并互连对等线；`--gather` 加一个汇总节点，并行时等全部成员、流水线时等最后一个，与每个成员连对等线。`--after-turn` / `--ttl` / `--permission-mode` / `--inbox-wake` / `--dry-run` 作用于整队。所有校验（agent、模型、权限模式、外部依赖、来源链）都在建节点之前；依赖在节点全部存好之后写，团内上游那时才是画布上的 Agent 节点。`Args` 新增 `all(name)`：`list` 会按逗号切，任务正文里的逗号不能切。

`SKILLS_REVISION` 10 → 11，技能文本与 CLI 用法同步加了 `team`；`architecture.md` 的动词清单补齐（它还写着 `send` 已移除）。

### 45.4 编辑器草稿重新定位（§37.5 没做）

文件被删或移走时提示条多一个「重新定位」：填一个已存在的文件，「合并」以草稿改起时的正文（本机副本里的 `base`，没有就用编辑器基准）为 base、目标为 theirs 走同一个草稿合并对话框，结果写成**目标文件**的本机草稿（带它的内容版本）再把节点改指过去，由草稿保护放回——不写盘；「覆盖」再确认一次后带读到的 size / sha256 写盘，期间被改就 409。目标不存在答「该路径没有文件」，不代为新建（那是另存为）。代码在 `nodes/editor/use-relocate.ts` 与 `RelocateDialog.tsx`。

### 45.5 切换执行主机发 `workspace.grants`（§38.3）

`PATCH …/execution-host` 成功且主机或根目录真的变了才发，事件多一个可选的 `executionHostId`（新主机，本机为空串）。语言服务的 `grantChange` 据此停掉按旧根起的服务器：搬到别的主机报 `unsupported_remote`，本机换目录报 `workspace_closed`。原地「切换」到同一个根不发。

### 45.6 过期注释

`settings/execution-hosts.ts` 说 `/validate` 仍是 501（早由 `core/remote` 接上）；`language/index.ts` 说 Worker 的 `registerRoot` 等还没实现、远端答 `link_lost`（§34 已实现、现答 `unsupported_remote`）；`collab/control/index.ts` 的「十三个动词」。都改成现状。

### 45.7 验证

- `pnpm --filter @armadra/desktop test`：vitest 2921 通过、13 跳过；live 1/1；脚本 38/38。新用例：`collab/control.test.ts` 的 `team` 三条（并行 + 汇总、带外部依赖的流水线、建节点前拒绝与演练），`language/policy.test.ts`（搬家即停），`language/routes.integration.test.ts`（真 HTTP 切换根目录 → 会话收到 `stopped` + `workspace_closed`，原地切换不再发）。
- `pnpm --filter @armadra/web test`：2711 通过，4 条失败都是 `KeybindingsPage.test.tsx` 的 5 秒超时（机器负载 200+），单独以 `--testTimeout=30000` 重跑 20/20 通过，与本节无关。新用例：`TerminalSurface.render.test.tsx`（节点数据换 id 后重连到新会话且不新建、数据没变时不被拽回）、`GithubDrawer.test.tsx`（部分标记）、`EditorNode.drafts.test.tsx`（重新定位的合并、确认后覆盖、目标不存在）。
- `pnpm --filter @armadra/server test` 68/68；`pnpm check`、`pnpm format:check` 通过。

## 46. 测试收尾：临时目录泄漏、i18n 死键与高负载超时（2026-09-26）

### 46.1 临时目录泄漏

- 做法：`apps/desktop/src/core/testing/temp-dir.ts` 的 `tempDir(prefix)` 建目录即登记，`testing/setup.ts` 作为 desktop（含 live 配置）与 server 两个 vitest 配置的 `setupFiles`，在每个测试文件跑完后统一删（先停掉目录下的 tmux 服务器；`rmSync` 带重试，删不掉就放过）。setupFiles 的 afterAll 最先注册、最后执行，排在文件自己的收尾之后。只把确实漏删的 36 个测试文件（desktop 29、server 7）与工作区夹具改成 `tempDir`，已经自己删干净的没动。`killTmuxServer` 挪进同一模块，工作区夹具与 `tmux.test.ts` 从这里取。
- 实浏览器用例（`live.integration.test.ts`）的 profile 目录改为关掉浏览器后反复删、最多约 15 秒，Chromium 的辅助进程晚退或重写时不再留目录；`tools/probes` 下三份终端探针的收尾删除改成重试后放过，`browser-cdp.mjs` 的 profile 删除重试放宽到 20 次。`tools/release`、`tools/repo-check.test.mjs`、`apps/desktop/scripts` 的用例本来就用 try/finally 或 `after` 删，没有改。
- 前后数字（每次用独立的 `TMPDIR`，跑完数 `ls $TMPDIR | grep -c armadra`）：desktop 230 → 0，server 37 → 0，web 0 → 0；`pnpm release:test` + `pnpm ci:workflows` 为 0。desktop 在高负载下（与 web 全量并行）再跑一次也是 0。跑前跑后 `pgrep -fl "tmux.*armadra"` 均为空，09-26 修过的夹具与 `tmux.test.ts` 没有回退。

### 46.2 i18n 死键

- `UNREFERENCED` 白名单 139 → 0：
  - 97 个键全仓库（apps / packages / tools）无人引用，也不在任何动态前缀下，从中英两份模块里删掉，随之空掉的分组注释一并去掉。
  - `gitIntegration.continue${label}` / `abort${label}`（6 个）与 `mobile.key.ctrl${letter}`（9 个）是把变量接在词尾的拼法：`dynamicPrefixes` 改为认「静态部分至少含一个点」的前缀，不要求停在点上。
  - `desktop` 模块的 27 个 `menu.*` / `tray.*` 由 Electron 主进程引用，不在前端语料里；它们已由 `shell-core/messages.test.ts` 按「托盘与菜单要的键」全等守住，前端检查用 `REFERENCED_ELSEWHERE` 跳过这个模块。
- 白名单断言仍是全等，今后只许保持为空。

### 46.3 高负载下超时的 web 用例

- `KeybindingsPage.test.tsx`：剖析显示一半以上时间花在 `getByRole` 的可访问名与可见性计算上（整页上百个按钮，jsdom 的 `getComputedStyle` 每次都要过默认样式表）。改为按 `aria-label` 查按钮（`getByLabelText(…, { selector: "button" })`），对话框里的查询用 `within` 限在对话框内，菜单项按文字加角色选择器找。单独跑整文件 4.7 s → 2.9 s，最慢一条 570 ms → 350 ms。剩下的是每条用例挂整页的 React 渲染，改不动产品代码就压不下去，给这一组 `describe` 放宽到 15 s 并注明原因。
- `AutomationDrawer.test.tsx`：编辑表单的时区下拉即使关着也把全部选项（四百多个 IANA 时区）渲染进片段，每次重渲染都要走一遍。用例里把 `timezoneOptions` 换成三项，整文件 1.4 s → 0.75 s，编辑类用例 400 ms → 110 ms。产品里同样的开销仍在，没有在这里改。
- `ChangesHunks.test.tsx`：单独跑最慢 133 ms，负载 100 以上时最慢 239 ms，找不到可以省的地方，也复现不出超时；没有改。
- 负载平均 109（10 核，与 desktop 全量并行）下的全量 web：快捷键页最慢一条 1.65 s，自动化抽屉 0.2 s，全部通过。没有改全局 vitest 超时。

### 46.4 验证

- `pnpm --filter @armadra/desktop test`：260 文件通过、2 跳过（3015 条通过、13 跳过），scripts 的 node:test 全过。
- `pnpm --filter @armadra/server test`：10 文件 79 条通过。
- `pnpm --filter @armadra/web test`：279 文件 2741 条通过（含高负载一轮）；`typecheck` 通过。
- `pnpm release:test`、`pnpm ci:workflows`、`pnpm check`、`pnpm format:check` 通过。

## 47. 端到端探针全量复跑与打包版验证（2026-09-26）

基线 `8e436cfd`。`tools/probes/` 的六个探针逐个对当前代码跑；再打一次本机包（无签名），用 launchd 的 PATH 起打包版。机器同时在跑其他任务，负载平均 16–22（10 核），帧时类数字只作参考。

### 47.1 探针结果

| 探针                          | 结果                  | 说明                                                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser-cdp.mjs`             | 通过                  | Chrome 153.0.8010.53，七项能力全过                                                                                                                                                                                                                                             |
| `core-terminal-smoke.mjs`     | 通过                  | tmux 后端；回显、重附看得见前一屏、销毁、未知会话升级前 404                                                                                                                                                                                                                    |
| `core-terminal-lifecycle.mjs` | 通过                  | tmux 与 direct 两套：跨 core 接管、capture / paste / scroll / recycle、GC 空闲判定                                                                                                                                                                                             |
| `connection-drag.mjs`         | 探针过时 → 已改，通过 | 20/20，把手 14×14 px。§23 记过它在当时的代码上 0/3 落不成边；这次边能落下（第一次就连上），失败在「撤销后还剩 1 条边」：两端节点没有名字，连线一建立就弹起名对话框（`agent-delivery.md` §2.2），它的遮罩吃掉了紧接着的撤销点击。种子里给两端起好名字；点撤销前看到遮罩直接报错 |
| `git-tool-window.mjs`         | 通过                  | 9 张截图（`target/git-tool-window/`），目视正常                                                                                                                                                                                                                                |
| `canvas-stress.mjs`（30）     | 探针有误 → 已改，通过 | 见 47.2                                                                                                                                                                                                                                                                        |
| `core-terminal-packaged.mjs`  | 发现产品问题 → 已修   | 见 47.3                                                                                                                                                                                                                                                                        |

### 47.2 画布压力（30 个终端 + 真实会话）

- 探针的便签一段一直没打进便签：`document.querySelector("textarea")` 取到的是第一个终端 xterm 的 helper textarea（排在便签前面），100 个字符进了 PTY。这次暴露出来，是因为人在终端里每敲一下都会续一次驱动租约（`expiresAt` 变了），`terminal.lease` 广播一帧，`DriveBadge` 跟着重渲——输入期间 107 次 commit 里 98 次是它。改为点便签正文、只在 `[data-slot="sticky-node"]` 里找 textarea 之后，107 次 commit 里 100 次是 `StickyNode` 自己（受控 textarea，每键一次），保存 0 次。**`canvas-performance-baseline.md` 里「输入 100 字符」那几行（11 次 commit 等）量的也不是便签。**
- 改后两次复跑（`target/canvas-stress/`、`target/canvas-stress-2/`）与该文档 §5 对比：

| 指标                           | §5（P1–P3 后） | 本次                              |
| ------------------------------ | -------------- | --------------------------------- |
| 一次会话状态跳动的重渲组件数   | 7,894          | 7,985 / 7,985（首跑旧探针 7,125） |
| 一次会话状态跳动的 commit 次数 | 31             | 18 / 18                           |
| 平移最慢一帧 / >33.4 ms 帧数   | 33.4 ms / 1    | 100 ms / 4、99.9 ms / 4           |
| 拖节点最慢一帧                 | 50.0 ms        | 33.4 ms / 33.4 ms                 |
| 空闲、输入最慢一帧             | 16.8 ms        | 16.8 ms                           |
| 撤销栈深度                     | 1              | 2（拖节点一条 + 便签正文一条）    |

- 重渲组件数持平，commit 次数少了约四成；大头仍是 §5.3 说的两处（一次 `NodeComponentWrapperInner` 全表 ≈3,105，`AppShell` 查询失效四次 ≈3,560）。平移最慢一帧回到 100 ms，但同一台机器负载 20 以上，第一次（旧探针、负载较低时）是 33.3 ms / 0 帧，不据此判为回退。撤销栈多出的一条是便签这回真的提交了。

### 47.3 打包版

- `pnpm --filter @armadra/desktop dist`：没有 `CSC_LINK`，`signing-electron.mjs` 自动走 skip，electron-builder 报「0 identities」跳过签名与公证，产出 `apps/desktop/release/mac-arm64/Armadra.app` 与 dmg / zip。没有安装或替换 `/Applications/Armadra.app`。
- 探针改为按访达的方式起：`PATH=/usr/bin:/bin:/usr/sbin:/sbin`，`ARMADRA_DATA_DIR` 与 Chromium 的 `--user-data-dir` 都在临时目录（原来没有后者，第二个 Electron 会写操作员的 `~/Library/Application Support/Armadra`；`ps` 核对过辅助进程的 profile 都在临时目录）。
- c2df3466 的修复在打包版里生效：会话 `backend: "tmux"`。
- **新问题（已修，6189c391）**：资源面板里两个活着的 tmux 会话都显示「没有可用的进程号」。`resources/sessions.ts` 的 `panePids` 与 `resources/index.ts` 回收会话时的 `kill-session` 用继承来的 PATH 找 tmux，与 c2df3466 修的探测是同一类问题。改为和终端域一样用 `agentPath` 补过的 PATH；先加了单测（`sessions.test.ts`：PATH 为空、tmux 只在 `~/.local/bin` 时仍能读出 pane pid），修复前失败。探针同时要求资源采样给得出这个会话的 pid：旧包上失败（`no-pid`），重打包后通过（`resourcePid` 有值）。
- 目视（`target/packaged-visual/`，一次性脚本驱动，未入库）：`resources.png` 修复后会话行有 pid、CPU、内存估计，平台组件五行齐全；`settings-integration.png` 六个 CLI 集成行、中文、无溢出、无遮挡；控制台无 error / 异常。截图里侧栏发灰是窗口毛玻璃在 CDP 截图里没有底色，不是界面问题。集成页读的是本机真实 CLI 配置（只读展示），没有点安装 / 卸载。

### 47.4 发布演练

- `pnpm release:dry-run` 通过：0.1.0，16 个文件校验和、6 个更新平台，签名用本次生成的临时密钥。本机没有 `minisign`，签名只用 Node 实现校验过；真签名、公证与上传需要密钥，未做。

### 47.5 验证

- `pnpm --filter @armadra/desktop test`：261 文件通过、1 跳过（3023 条通过、6 跳过），scripts 的 node:test 38 条全过。
- 探针：上表六项 + 打包版 `core-terminal-packaged.mjs` 退出码 0。

## 49. 本轮界面功能的实浏览器端到端验证（2026-09-26）

新探针 `tools/probes/ui-features-e2e.mjs`（场景在 `tools/probes/ui-features/`，怎么跑、验什么、没验什么见 `tools/probes/README.md` 末节）。真 core（`out/core/main.js`）+ 真 Vite 页面 + 新 profile 的无头 Chrome，经浏览器级 CDP 连接驱动；数据目录、HOME、`CLAUDE_CONFIG_DIR` / `CODEX_HOME`、替身脚本与 profile 都是 `mktemp` 的，跑完删除并停掉 tmux 服务器，跑完后 `$TMPDIR` 下没有 `armadra-ui-*` 残留、没有遗留的 Worker 或 tmux 进程。每个场景截图目视检查并收集控制台，error 级别算失败。整套 7 个场景 78 项检查全过，产物在 `target/ui-features-e2e/`。

### 49.1 场景与实测

| 场景                            | 结果       | 实测                                                                                                                                                                                                                                                                                                                                           | 截图                                                           |
| ------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 多设备画布（§41）               | 已修后通过 | 两个 browser context（UA 分别报 Windows / macOS）；单页面无设备条且拖得动（x 360→472，已落盘）；第二台显示「Windows · Chrome 正在编辑」、拖不动；第一台一笔被 CDP 拦下保存的改动（y 469）在接管后回到远端的 320；关掉持有者后设备条消失、第一台重新可写                                                                                        | `presence-1…6`、`mobile-presence`                              |
| 编辑器（§37）                   | 通过       | PNG 棋盘格两色各占 0.51 / 0.49，滚轮 100%→146%；PDF 查看器区域 39 种颜色、亮像素 0.71（不是空白）；MP4 320 宽 1.77 s、MP3 4.17 s，都有原生控件；刷新后草稿放回并提示「已恢复」；磁盘改同一行出现三方合并（1 处冲突），取草稿后两边改动都在；`src/app.ts` 第 3 行出现修改标记；快速打开列出 6 个最近文件，`src/app.ts:3:12` 落在第 3 行第 12 列 | `editor-1…7`、`mobile-editor`                                  |
| 文件树（§38）                   | 通过       | 复制路径读回 `/private/var/…/src/lib/util.ts`，相对路径 `src/lib/util.ts`，目录 `src/lib`；菜单里没有「在访达中显示」                                                                                                                                                                                                                          | `tree-1`、`mobile-tree`                                        |
| 项目搜索取消（§38）             | 通过       | 36 038 个文件整轮扫描约 1.5 s；中途换关键词时 core 停在第 10 624 个，点「停止」时停在第 6 976 个；不打断的那次没有取消记录                                                                                                                                                                                                                     | `search-1…3`、`mobile-search`                                  |
| 快捷键（§40）                   | 通过       | 「资源管理器」设为无后 ⇧⌘E 不再开抽屉；「源码控制」追加 ⌃⇧Y 后两组都能开关；`platform ==` 报语法错、`canvasFocus && nosuchkey` 报未知键，两者都不能保存；`platform == windows` 时 ⇧⌘L 不收侧栏，改成 `platform == mac` 后生效；全部重置恢复                                                                                                    | `keys-1…3`、`mobile-keybindings`                               |
| 集成页（b1811c85）              | 通过       | 临时 HOME 里 11 个 Hook 事件各挂同一条旧命令；Claude 行高 46 px、名字在行内；弹层 z-index 55、在对话框之上、整块在视口内，同一命令一行 ×11；「修复」后只剩用户自己的 `echo mine`，留一份备份                                                                                                                                                   | `integration-1…3`、`mobile-integration`                        |
| 资源面板与用量页（§39 §43 §44） | 已修后通过 | 「构建机」经替身 ssh 跑本仓库的 Worker，总览由 `resources.read` 真读出；筛选为 全部主机 / 本机 / 构建机，选构建机时会话表为空、只剩那台的总览；休眠节点头「休眠中」、体上「唤醒」，面板里「已休眠，不占内存」；用量卡 Claude「部分中断」、Codex 无徽标、Copilot「维护中」，fixture 收到三家请求                                                | `resources-1…2`、`usage-1`、`mobile-resources`、`mobile-usage` |

### 49.2 发现并修掉的问题（各带单测，单独提交）

- **被接管的那台没有丢掉本地改动**（`app/use-board-sync.ts`）。远端这段时间没人改过时，丢租约后重取的文档与缓存逐字相同，React Query 的结构共享还回旧引用，「同一份响应只合一次」的闸门把它挡掉，只读的那台一直显示自己那笔作废的改动。丢租约改为自己取一份直接合并。`use-board-sync.test.tsx` 加一条。
- **绑定执行主机的工作空间里，本机会话被算到远端主机**（`panels/resources/metrics.ts`）。普通终端节点起的是本机 shell，core 在采样里明说 `local`，页面只信远端主机 id，本机的一律按工作空间改判成那台，筛「构建机」时列出本机的 pid 与内存。`metrics.test.ts` 加一条，旧的「跟随工作空间」用例改为「更旧的 core 不给 id」。
- **打开画布时休眠的终端显示成「已退出」**（`terminal/surface/use-transport.ts`）。挂载时按节点数据抢先连上的 socket 收到 core 的「没在跑」，这一帧落在读到休眠之后、连接收掉之前时把表面改回已退出，节点只剩「重新运行」——点下去就另起会话，休眠那段接不回来。在探针里稳定复现；`TerminalSurface.render.test.tsx` 加一条。

为了让探针看得见，core 加了两个观测点：文件搜索被取消时按 debug 记「文件搜索随连接断开中止」与 `visited`（`searchContent` 带一个进度对象，`search.test.ts` 断言中止时 visited < 400）；`ARMADRA_STATUS_PAGE_BASE` 把三家状态页改到同一个根地址下（与 `ARMADRA_GITHUB_API_BASE` 同一种做法，登记在开发指南的环境变量表，`status.test.ts` 加两条）。

### 49.3 看到但没改的

- **手机上右侧抽屉留一条缝**：资源管理器 / 资源这类抽屉按 `min(100vw, 360px)` 开，390 宽时左边留 30 px，工具簇被按抽屉宽度推到屏外只露出半截图标，底部导航也被抽屉盖住（`mobile-search.png`、`mobile-resources.png`）。能用，但像没做完；是改成窄屏铺满还是保留缝隙属于设计决定。
- **桌面上右侧抽屉盖住底部 Dock 的右端**：1440 宽开资源管理器时 Dock 的缩放百分比只露出「10」（`tree-1-context-menu.png`）。
- **顶部提示条压在节点标题栏上**：「Claude Code 的配置里有旧版接入残留」这类提示居中浮在画布顶端，正好盖住视口顶部节点的标题栏中段，按在上面拖不动节点（探针改为从标题栏左端起拖）。
- 设置对话框右上角关闭按钮的读屏文字是英文 `Close`（生成组件自带的 sr-only），界面上看不见。
- 终端节点在 ≤440 px 宽时按设计隐藏标题栏徽标，「休眠中」也跟着看不见，只剩体上的「唤醒」。

### 49.4 没验证

休眠的判据与接回（休眠状态是经 API 结束会话后把结束原因置成 `hibernate`，与 `Manager.hibernate` 写下的同形）；真实 SSH 与另一台机器；打包应用里的 PDF 查看器与视频解码；触屏手势。

### 49.5 验证

- `node tools/probes/ui-features-e2e.mjs`：7/7 场景通过（整套约 4 分钟）。
- `pnpm --filter @armadra/web typecheck` 通过；`pnpm --filter @armadra/web test`：279 文件 2744 条全过。
- `pnpm --filter @armadra/desktop test`：261 文件通过、1 跳过（3024 过、6 跳过），脚本用例全过（worktree 里 node-pty 的 `spawn-helper` 先 `chmod +x`）。
- `pnpm --filter @armadra/server test`：10 文件 79 条通过。
- `pnpm check`（含 `format:check`、两边 typecheck、`repo:check`）通过。

## 48. Agent 协作端到端：真 Claude Code 与真 Codex CLI（2026-09-26）

新探针 `tools/probes/agent-e2e.mjs`（说明在 `tools/probes/README.md`「Agent 协作端到端」）。真 core、Vite 页面、新 profile 的无头 Chrome，Claude Code 2.1.260 与 Codex CLI 0.155.1，tmux 后端。每个 Agent 节点都由页面挂载、由页面敲启动行，CLI 的终端查询经 xterm 写回 PTY——§31.7 那一类问题只在这条路上出现。

### 48.1 场景与结果（最后一次全量：245 秒，56 条断言全过，控制台错误 0，操作员配置与 CLI 版本未变）

| 场景          | 结果       | 实测                                                                                                                                                                                                                                                       |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Codex 首投  | 通过       | 源节点 `send` 给两个新 Codex：入队 `TARGET_STARTING`，约 6 秒后按首投放行门投出，`targetState = observed-quiet`，随后 hook 报 working → done；`open-agent --task` 建的第三个同样 `observed-quiet` 投出并跑完一轮                                           |
| 2 Claude 投递 | 已修后通过 | 首投 `targetState = idle`（上报），信任对话框确认后约 8 秒投出；半行在输入框里、人的租约过期后 `send` 排队 `TARGET_INPUT_PENDING`，回车后投出并又跑一轮                                                                                                    |
| 3 依赖与组队  | 通过       | `open-agent --after … --after-turn next`：上游这一轮结束前下游只有 shell，结束后由 core 敲启动行并投出任务；`team --chain`：第二棒（Claude）在第一棒（Codex）结束后启动并收到任务；关掉页面再来一次，core 经 `spawnForNode` 起会话并 `observed-quiet` 投出 |
| 4 节能休眠    | 已修后通过 | 阈值 20 秒（测试注入）：关页面后约 22 秒 Claude 与 Codex 都进入 hibernated，CLI 进程确实退出；重开页面两者都显示「休眠中」，点节点后同一会话 id 起第 2 代、恢复行带同一个 provider 会话 id，经页面问「之前让你记的数加一」两者都答 418                     |

截图在 `target/agent-e2e/`：`1-codex-idle.png`、`1-codex-delivered.png`、`1-codex-open-agent.png`、`2-claude-delivered.png`、`2-claude-input-pending.png`、`2-claude-after-enter.png`、`3-dependency-waiting.png`、`3-dependency-launched.png`、`3-team-chain.png`、`3-headless-launched.png`、`4-before-hibernate.png`、`4-hibernated.png`、`4-claude-resumed.png`、`4-codex-resumed.png`。

### 48.2 修掉的两个 bug

- **只报过开场的 Claude 永远收不到第一条任务。** Claude 起来报一条 `SessionStart`，归约按规则 4 把状态清空，此后停在输入框上不再发事件；`targetState()` 对空状态答 `starting`，`send` / `open-agent --agent claude --task` 的第一条一直停在 `queued / TARGET_STARTING`（实测两分钟 `attempts = 0`）。与 §31 的 Codex 同一个死锁，只是多报了一条开场。新增 `agent/target-state.ts::sessionStartIdle`：真上报的开场（hook / extension、`sessionPhase = start`、状态空、非 `restored`）+ 会话满 6 秒 + 没有半截的行，就当作 `idle`（回执照写 `idle`，那是一条上报）；`send.ts::attempt` 在五态之后调用它，出队泵的快探也把这类目标算进去（开场之后没有事件可听）。探针记下了信任对话框出现时 `agent_status` 还没有行——开场事件在信任之后才到，这条门不会把正文打进那个对话框。用例 `collab/session-start.test.ts`（修前两条失败）。
- **页面重开时休眠的节点显示「已退出」。** 挂载时按节点数据里的会话 id 抢先连的 socket 收到 `hello { alive: false }`，与挂载那次读谁先到没有保证；读先到、状态已是休眠而 socket 还没收掉时，它把「休眠中」改写成「已退出」，节点头给出「重新运行」，点击也不再唤醒——点「重新运行」就是另起一个 CLI，休眠的对话接不回来。`use-transport.ts` 在状态为 `hibernated` 时不理会这条 socket 的 hello / status。`TerminalSurface.render.test.tsx` 两种先后各一条（修前「读先到」那条失败）。

### 48.3 测试注入与取舍

- 休眠阈值的设置下限是 5 分钟，巡检 60 秒一轮，没有注入点。加了环境变量 `ARMADRA_TEST_ECO_IDLE_SECONDS`（1–600 秒，`hibernate.ts::ecoTestOverride`，巡检同时缩到 2 秒），开关仍听设置。不放宽设置下限：那是给人的下限，几秒的休眠会杀掉刚停下来等人看结果的 CLI；环境变量只有启动 core 的进程能给，不进设置与界面。
- 发送方是普通终端节点：普通终端的会话不带 `ARMADRA_NODE_ID`，探针以它的节点身份（`node-token/refresh` 签发的令牌）从探针进程跑 `armadra-hook canvas`，对 core 来说与在那个终端里敲是同一个请求。
- 「记住 417 / 问加一」由人经页面打进去，不用 `send`：投递正文带来源信封，Claude 按「同级消息是资料」处理，会拒绝回答一个像是在套上下文的问题（实测如此）。
- Codex：临时 CODEX_HOME 只复制 `auth.json`，关掉启动时的升级检查、预先信任工作目录，并先跑一次最小的 `codex exec` 让它完成自己的 sqlite 迁移（两个 Codex 同时第一次用全新 CODEX_HOME 会撞在迁移上直接退出；操作员自己的目录早已迁移过）。Claude：钥匙串登录在临时 `CLAUDE_CONFIG_DIR` 下认证不上，确认 `claude.ts` 是启动时注入（`--settings` 指向数据目录，不写 `~/.claude/settings.json`）后，只对 Claude 进程用真实配置目录；core 自己的 `CLAUDE_CONFIG_DIR` 仍指向临时目录。

### 48.4 发现但没有修

- **Codex 的升级提示会吃掉第一条任务。** 首跑时临时 CODEX_HOME 第一次启动记下了最新版本，第三个 Codex 起来就停在「Update now?」上；首投放行门按「没有半截的行、会话满 6 秒」放行，正文加回车选中了缺省的「升级」，Codex 执行了 `npm install -g @openai/codex`，把本机全局 CLI 从 0.155.1 升到了 0.157.0（已手动装回 0.155.1，探针此后关掉启动检查，并在跑后比对两个 CLI 的版本）。这是设计 §4.3 已记的「安静的提示」误判面的又一例，而且代价比目录信任大：它会改用户的机器。复现：新 CODEX_HOME 里起一次 Codex、退出，再用 `open-agent --agent codex --task …` 建一个节点。修法涉及要不要识别提示符（§12 第 3 条不做）或在启动行上替用户关掉升级检查（与「保留各 CLI 的策略」冲突），留给设计决定。
- 没验证：direct / 会话宿主后端、Claude 的权限提示与审批、休眠后经 `send` 唤醒、打包版。

### 48.5 验证

- `node tools/probes/agent-e2e.mjs`：四个场景全过（245 秒）；单跑 `--only 2`、`--only 4` 也各过一次。
- `pnpm --filter @armadra/desktop test`：262 文件通过、1 跳过（3027 条通过、6 跳过），scripts 的 node:test 全过；`typecheck` 通过。
- `pnpm --filter @armadra/web test`：279 文件 2743 条通过；`typecheck` 通过。
- `pnpm --filter @armadra/server test`：10 文件 79 条通过。
- `pnpm check`、`pnpm format:check` 通过。

## 50. 服务器壳与远端执行主机的端到端（2026-09-26）

两个新探针用真进程把 §42（账号与共享）、§39（服务器壳上的浏览器节点）与 §34 / §44（远端执行主机）在界面上走了一遍：`tools/probes/server-e2e.mjs` 与 `tools/probes/remote-e2e.mjs`，共用 `tools/probes/shell-e2e-lib.mjs`（临时目录与收尾、随机端口、浏览器级 CDP 连接上的多个页面与互不共享 Cookie 的浏览器上下文、控制台错误与失败应答的收集）。怎么跑见 `tools/probes/README.md`。走的过程中修了 11 处，每处先有复现用例。

### 50.1 服务器壳（`server-e2e`）

| 场景                                       | 结果         | 实测 / 截图（`target/server-e2e/`）                                                                                  |
| ------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 配对链接完成首个管理员                     | 已修，通过   | `01-admin-paired.png`                                                                                                |
| 「账号与共享」生成邀请，另一上下文兑换注册 | 已修，通过   | `02-admin-invite.png`、`03-member-redeem.png`                                                                        |
| 只读共享：看得见、写不进                   | 已修，通过   | 右上角「只读」，便签拖不动，不发保存；`POST boards` 403；`06-member-readonly.png`                                    |
| 改成「编辑」后能写                         | 已修，通过   | 下一拍心跳（≤10 s）解除只读，拖动 144 px 落盘；`07`、`08`                                                            |
| 撤销共享                                   | 已修，通过   | 事件流关闭码 4403，下一次 `GET boards` 403，页面离开那块工作空间；`09`、`10`                                         |
| 成员打开页面的全局 403                     | 记录，不放行 | 见 50.3                                                                                                              |
| headless 浏览器节点                        | 通过         | `health.capabilities.headlessBrowser = true`，画面流 1278×768，取样像素是探针页面的蓝；`11-admin-browser-stream.png` |

修的几处：

- **同源读请求一律 403**（`apps/server`）：Fetch 规范对同源 GET / HEAD 不发 Origin，服务器壳的页面与接口同源，门却要求 API 必带 Origin——真浏览器里页面的每个读请求都是「来源不被允许」，连配对面板都打不开。§42 的集成用例手工带着 Origin，所以没暴露。`auth.ts` 新增 `impliedOrigin`：只对读方法、只在 `Sec-Fetch-Site: same-origin` 且 `https://<Host>` 在白名单里时补上，写方法与非浏览器请求照旧拒绝；补在请求头上，门、身份域（`GET /api/identity/session` 自己读 Origin）与 CORS 看到同一个来源。
- **配对 / 邀请链接打开后什么都不发生**：`#invite=` 的判断写在设置对话框里，而对话框挂在浮层闸门后面、只有打开设置才挂载。判断挪到闸门外的 `app/use-link-fragments.ts`；`#pair=` 同样打开到「后台服务」，那一页看到配对片段时自己检查一次连接（身份面要先确认服务身份才取走票）。
- **写租约落到查看者手里**（core）：心跳只要读权限，查看者独自开着画布时第一拍就拿走空着的租约，管理员来了反而只读。心跳现判 `canvas:write`，租约只在能写的客户端之间分（`handToSole` 同理），回答多一个 `writable`（契约 §9.1；事件帧里没有，它因人而异）。
- **查看者打开画布就亮「画布保存失败 · 重试」**：排版副产物的保存被 403 拒。`writable: false` 时 `isReadOnly` 为真（编辑与视口都不落），`PresenceBar` 哪怕只有自己也写一句「只读」且不给「接管」；事件帧不带 `writable` 时沿用上一拍。仍有 403 的保存与 423 一样处理：丢掉本地这份、补一拍心跳、按远端重载。
- **撤销共享后停在旧画布上**：侧栏把当前工作空间永远列着，之后每个请求 403 却没人说为什么，事件流还按退避一直重连。`api/events.ts` 认 4403：不再重连、通知订阅者；`app/use-access-lost.ts` 离开那块工作空间并提示「已不再共享给你」，工作空间列表重取。

### 50.2 远端执行主机（`remote-e2e`，假 ssh）

本机 sshd 不收密钥，按要求不碰任何 SSH 或系统配置。core 已有注入点，不需要新增环境变量：`ARMADRA_REMOTE_WORKER_LAUNCHER`（`core/remote/index.ts`）替换每条 `ssh` 启动行的 argv[0]，Node 探测、握手、控制连接与语言连接都经它。探针在临时目录写一个假 ssh（按 `ssh(1)` 吃掉带参数的选项与目的主机，剩下的远端命令交给 `/bin/sh -c`，没有远端命令时起登录 shell），Worker 路径指向一个 `exec node apps/desktop/out/core/main.js "$@"` 的包装。

| 场景                                                       | 结果           | 实测 / 截图（`target/remote-e2e/`）                                                                                         |
| ---------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1. 在执行主机上建远端工作空间（设置 → SSH → 打开远程项目） | 通过           | `01-remote-workspace.png`                                                                                                   |
| 2. 文件树与编辑保存（⌘S）                                  | 已修，通过     | 落盘；`02-files-edit.png`                                                                                                   |
| 3. Git 状态、勾选暂存、提交                                | 已修，通过     | 远端索引与提交都在；`03a`–`03c`                                                                                             |
| 3. fetch 的进度与取消                                      | 已补界面，通过 | 提示依次「已排队 / 正在执行 / 正在执行 · 100%」；upload-pack 睡 30 s 的那次点「取消」2.5 s 结束、没取到提交；`03d`、`03e`   |
| 4. 远端语言服务（mock-lsp）                                | 通过           | 状态栏「1 个警告」，悬停出原文；进程树上 mock-lsp 的父进程是 `worker --stdio --language-link`；`04-language-diagnostic.png` |
| 5. 文件监听推送                                            | 通过           | 登记答 `mode: events`；远端磁盘上改开着的文件，编辑器 203–210 ms 跟上；`05-watch-pushed.png`                                |
| 6. 资源面板按主机筛选                                      | 已修，通过     | 远端主机卡约 1.8 s 拿到第一轮数字；全部 / 假远端 / 本机三档各自只剩对应的卡；`06a`–`06c`                                    |
| 7. 本机 → 远端 → 本机                                      | 通过           | 切过去后经 Worker 读到文件；`07a`–`07c`                                                                                     |

修的几处：

- **编辑器里 ⌘S 从来没保存过**（不限远端）：应用级键位在窗口上捕获，先于节点根元素上的编辑器监听，接了 `editor.save` 却交给不认识它的派发器，键被吞掉。F2 / F12 / ⇧⌥F 同理。与浏览器节点一样把编辑器作用域留给焦点所在的节点（`app/use-app-keybindings.ts`）。
- **Git 提交页的「提交」按钮在 1440×900 下点不到**：窗口停在底部默认 40vh，工具条 + 变更树下限 + 消息区超出它，而这一页不滚动，按钮顶边在 914 px。整页可滚。
- **提交之后日志页不重读**：日志页的历史与分支树两份查询只在日志页自己的写之后失效；并进 `invalidateGitQueries`。
- **fetch 这类长操作没有进度、也没有取消**：core 队列与远端 Worker 都支持取消（§44），界面上没有任何入口，日志页交出去只重读一次。新增 `panels/git/log/follow-operation.ts`：一条常驻提示写状态与 `git --progress` 的百分比，带「取消」，结束时收起或换成结局；结局提示显式清掉进行中那条的按钮与常驻时长（sonner 同 id 合并更新）。取消一条已在跑的网络命令，core 如实答「结果不确定」而不是「已取消」，界面照原样说。
- **资源面板没有会话时没有主机筛选**：筛选长在会话表里，一行会话都没有就整段不画，而它同时管主机总览——远端工作空间刚建好、还没开终端时正要看那张卡。
- **语言服务列表的重复 key**：typescript-language-server 同时服务 typescript 与 javascript，按服务器 id 作 key，打开设置 → 工作区就报 React 重复 key。

### 50.3 成员打开页面时的全局 403（记录）

成员打开共享画布：`/api/agents`、`/api/terminals/backend`、`/api/settings`、`/api/usage`、`/api/ssh/prompts` 各 403 一到两次，页面没有白屏、没有提示、没有控制台错误——这几处本来就静默降级（Agent 目录为空、用量徽标不出、设置读不到按缺省）。逐页打开设置：Agent 页多 403 `/api/agents`；终端页 403 `/api/settings/local`；账号与用量页 403 `/api/usage`、`/api/usage/copilot`、`/api/models/catalog`。这几页照样画出来，但画的是缺省值（例如「获取用量」开着），改动会以「设置保存失败」收场。没有影响基本使用，所以没有放行任何全局路由：放开哪一条要逐条判断它对成员是否无害（设置里有 SSH 主机与 Agent 配置），这次不做。撤销共享之后还有一次 `GET boards` 与心跳 403，那是离开工作空间之前在路上的请求。

### 50.4 没做 / 已知

- **被撤销的成员手里的写租约要等 30 秒 TTL**：他之前拖过便签、拿着租约，撤销之后心跳全是 403，core 要等过期才摘掉，这段时间管理员一侧是只读并显示「某设备正在编辑 · 接管」（实测 19.5 s 后释放）。管理员可以接管；要立刻释放得让在线表记下每个客户端的主体并在授权变化时复判，没做。
- 假 ssh 没有验证真实的 ssh 传输、主机密钥、askpass 与跨机器差异；远端终端节点走真 `ssh`，不经 `ARMADRA_REMOTE_WORKER_LAUNCHER`，没有覆盖。
- 本机传输下 git 只在结束时报 100%，中间的百分比没看到；进度条的中间态只由状态体现。
- 取消 fetch 时 git 不会带走它起的 upload-pack（探针的包装还在睡），探针收尾时按临时目录结束残留进程。

### 50.5 验证

- `node tools/probes/server-e2e.mjs`：22 项全部通过；`node tools/probes/remote-e2e.mjs`：21 项全部通过。两次跑完 `$TMPDIR` 下没有残留目录与进程。
- `pnpm --filter @armadra/web test`：283 文件 2758 条通过；`typecheck` 通过。
- `pnpm --filter @armadra/desktop test`：261 文件通过、1 跳过（3023 条通过、6 跳过；worktree 里 node-pty 的 `spawn-helper` 先 `chmod +x`）。
- `pnpm --filter @armadra/server test`：10 文件 82 条通过。

## 51. 画布内注入：Hook、技能与画布说明只在画布启动时生效（2026-09-26）

设计见 [画布内注入](../design/canvas-only-integration.md)。用户拍板：注入只在从画布启动时生效，画布外启动 CLI 零影响；升级后自动清掉现有的全局安装，清之前先备份。

### 51.1 做了什么

- **一个出口**：`core/hook/install/inject.ts::canvasInjection` 答 `{ args, words, env }`，产物固定在 `<数据目录>/integration/<cli>/`（插件目录、扩展、技能、说明文件、Claude 的 settings），修订变了就重写、字节不变不写。core 里拼启动行的只剩 `core/agent/canvas-launch.ts`：依赖编排、节能唤醒（带 resume）、计划任务冷启动都经它；页面的新节点 / `open-agent` / `team` / 历史对话恢复经 `web/agent/launch.ts`，接 `GET /api/agents` 的 `launchWords`。环境半边在终端域的 `ownedEnvironment`，也是「就要起这个 CLI」时确保产物最新的时刻。冷启动此前漏带注入（Claude 缺 `--settings`），已补。`canvas-launch.test.ts` 用源码扫描守住出口：`planLaunch(` 只在 `canvas-launch.ts`，页面的 `assembleLaunchCommand(` / `assembleLaunchArgv(` 只在 `web/agent/launch.ts`。
- **六个 CLI 按实测矩阵**：Claude `--settings` / `--plugin-dir` / `--append-system-prompt-file`；Codex 每事件一个 `-c hooks.<Event>`、`-c developer_instructions`（规则 + 完整 `SKILL.md` 的绝对路径）、`-c check_for_update_on_startup=false`；OpenCode `OPENCODE_CONFIG_DIR` + `OPENCODE_CONFIG_CONTENT`；Pi `--extension` / `--skill` / `--append-system-prompt`；OMP 的 `=` 形式 + `--config` 覆盖层；Copilot `--plugin-dir`（`hooks` 与 `skills` 在 `plugin.json`）+ `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`。恢复时同样全带。
- **Codex 的信任（方案 A）**：键 `/<session-flags>/config.toml:<事件>:0:0`，哈希沿用 `hookHash`；在临时 `CODEX_HOME` 里用 `codex app-server` 的 `hooks/list` 对照三种形状逐字节相同，写入后报 `trusted`，`codex exec` 下 Hook 真的调用并带着 `ARMADRA_NODE_ID`。启动时（本机有 Codex 配置目录才写）、起 Codex 终端时、「重新生成」时幂等写入，是唯一的全局写入。升级检查的键名从 0.155.1 的配置结构读出，并在 TUI 里对照：不加停在 `Update available!`，加上直接进目录信任提示。
- **Codex 的启动行要短**：第一次全量端到端里 Codex 节点全停在半行上——几 KB 的一行敲进刚起的 shell 被截断（PTY 输入队列约 1 KB）。长值改放节点终端的环境变量 `ARMADRA_CODEX_HOOK` / `ARMADRA_CODEX_INSTRUCTIONS`，启动行只写 `"hooks.X=$ARMADRA_CODEX_HOOK"`，约 450 字节；`packages/shared` 的 `assembleLaunchCommand` 加 `shellWords`（原样接在引用过的词后面、提示词前面，不进冻结 argv）。
- **一次性迁移**（`migrate.ts`）：core 启动时识别旧的全局安装——Claude `settings.json` 里的 Hook 与旧状态行、Codex `hooks.json` 条目及其信任记录、Copilot `hooks/armadra.json`、OpenCode / Pi / OMP 的 `armadra-status` 模块、各 `skills/armadra`（只认带修订号尾注的）与更早的技能目录。用户也编辑的文件备份成旁边的 `.armadra-backup-<时间戳>`，只有我们写的文件备份进 `<数据目录>/integration/global-backup-<时间戳>/`；只删自己的，结果记在 `integration/global-migration.json`，只做一次。测试套件设 `ARMADRA_NO_GLOBAL_WRITES=1`：测试起的 core 用真实 `HOME`，迁移与信任记录都不发生。
- **集成页**：每行「画布内注入」、Hook / 技能修订、Codex 行的「信任记录写在 ~/.codex/config.toml」、迁移清过东西时的「已清理全局安装」（悬停看备份）、旧残留与修复；「安装 / 卸载」换成一个「重新生成」。
- **画布说明与技能**（`SKILLS_REVISION` 12）：三种形式开头同一段「画布规则」——终端是画布节点、协作只走 `armadra-hook canvas`；要别的 Agent / 分工 / 并行一律 `canvas open-agent` / `canvas team`，不用 CLI 自带子代理；要浏览器用画布浏览器节点 `armadra-hook browser <动词>`，没有就先 `canvas open-browser --url`。动词表从 `core/browser/args.ts` 的 `VERBS` 生成。新增画布动词 `open-browser`（`collab/control/browser-node.ts`）：建浏览器节点，从调用者连一条对等边并写两份链接文档。
- 过期注释：`extensions.ts`「为什么不用 `--extension`」、`skills.ts` 关于 `AGENTS.md` 的一段、`codex.ts`「0.153.4 哈希失效」一节、`copilot.ts`「为什么不用 `--plugin-dir`」都按实测重写。原来的全局安装函数（`codex.install`、`copilot.install`、`installPi` / `installOpencode`、`claude.install`）删掉，只留迁移要用的卸载。
- `tools/probes/agent-e2e.mjs` 按场景拆开（单文件超 1500 行，repo:check 失败），加场景 5；探针的 core 环境把 XDG / Copilot / Pi 目录指到临时目录，比对的操作员文件加上旧版全局装的技能与模块。

### 51.2 实测

- 场景 5（真 Claude 2.1.260、真 Codex 0.155.1，同一份环境只差注入参数）：画布外 Codex 会话记录里没有画布说明与技能、Hook 没打到 core；画布内会话记录里有画布规则与 `integration/codex/skills/armadra` 路径、Hook 打到 core。画布外 Claude 的 init 里没有我们的插件与 `armadra:armadra`、Hook 没打到；画布内插件 `armadra@inline`（version 412）与 `armadra:armadra` 都在、Hook 打到。
- 本机真实 `~/.claude/skills/armadra`、`~/.codex/skills/armadra`、`~/.codex/hooks.json` 的 8 条、Copilot / OpenCode / Pi / OMP 的全局文件都还在——旧版装的，升级后真实应用第一次启动会备份并清掉；探针与测试都不碰，跑前跑后字节一致。

### 51.3 取舍与已知

- Codex 信任的是固定命令 `<数据目录>/bin/armadra-hook codex`：画布外有人手敲同样的 `-c` 也会跑，但客户端没有 `ARMADRA_NODE_ID` 时什么都不做。用户自己在命令行上用 `-c hooks.<Event>` 会占同一个 `…:0:0` 键：它本来就未被信任；若用户自己给这个键写过信任，会被我们覆盖。
- 环境早于本版本、跨升级存活的旧 shell 里敲 Codex 启动行，环境变量为空，Codex 当场报配置错误而不是悄悄不带 Hook。
- OpenCode / Pi / OMP / Copilot 的逐次注入只按 2026-09-26 的实测矩阵实现与单测，端到端只覆盖了 Claude 与 Codex。
- 远端（SSH）终端的注入路径指向本机数据目录，远端没有这些文件；本节没有处理。

### 51.4 验证

- `node tools/probes/agent-e2e.mjs`：五个场景 70 项全部通过（415 秒），控制台错误 0，操作员配置未改动。
- `pnpm --filter @armadra/desktop test`：265 文件通过、1 跳过（3054 条通过、6 跳过；worktree 里 node-pty 的 `spawn-helper` 先 `chmod +x`）。
- `pnpm --filter @armadra/web test`：283 文件 2761 条通过；`typecheck` 通过。`pnpm --filter @armadra/server test`：10 文件 82 条；`pnpm --filter @armadra/shared test`：28 文件 157 条。
- `pnpm check`、`pnpm format:check` 通过。

## 52. 浏览器节点的 Agent 工具补强（2026-09-26）

设计见 [浏览器节点的 Agent 工具](../design/browser-agent-tools.md)。

### 52.1 做了什么

- **快照。** `read` 缺省给无障碍快照（`Accessibility.getFullAXTree` 逐文档读，同源 iframe 按 frameId、跨源 iframe 经 `Target.setAutoAttach` 的子会话读，在 `<iframe>` 处拼起来）；可交互元素带稳定引用 `e12`，编号只增不复用；`--interactive` / `--depth` / `--max-bytes` 控量；可编辑字段只写 `[filled]` / `[empty]`。探针 fixture 的整页快照 26 行、899 字节。旧的 `elements` / `map` 读法改为 `snapshot --interactive`，CSS 枚举与按下标解析的五段脚本删掉。
- **引用失效**按角色与名称在同源页面重找一次，恰好一个才用并在回答里写明，否则 `browser_stale_ref` 并说明是零个还是多个；换了站点一律拒绝。
- **新动词与参数**：`hover`、`drag`（HTML5 拖放经拖拽拦截把页面自己的数据投回，从不带文件）、`fill`、自绘下拉的 `select`、组合键 `press`、`wait --text / --text-gone / --idle`、元素截图与真正的整页截图（原来 `captureBeyondViewport` 传的是 undefined）、`pdf`、`resize`、`--tab`、`--role --name`、`--snapshot` 差异快照、`navigate --action stop`。
- **开发者能力**（默认开放）：`read --mode console`（console API、Log、未捕获异常，按级别与文字过滤）与 `--mode network`（方法、地址、类型、状态、大小、耗时、失败原因；没有头、没有正文，地址里像凭据的参数值被抹掉）。白名单只加 `Log.enable/disable`、`Network.enable`（固定 `maxPostDataSize: 0`）/`disable`，取正文、Cookie、证书与改流量的 Network 方法逐个写进禁止表；`sole-call-site.test.ts` 改为钉住 Network 域恰好这两个方法、读请求事件的只有 `devlog.ts` 且不读任何头。执行任意 JS 仍不开放。
- **动词清单单一来源** `core/browser/verb-spec.ts`：`--help` 的浏览器段由它生成，core / 桌面壳 / hook 的动词表都从它派生，技能正文可直接读 `BROWSER_VERB_SPECS`、`BROWSER_NOTES_ZH`。`verb-spec.test.ts` 逐条核对参数转发、错误码、按键、读法 / 动作 / 方向，旧 help 的八处不一致全部修掉（`@N` 与 `e3-12@t1/…` → `e12`；`STALE_TARGET` / `DIALOG_PENDING` → 真实存在的 `browser_stale_ref` / `browser_dialog_pending`；console / network 已实现；F5 与组合键进白名单；`--tab` 转发、`--frame` 去掉；`--to-ref` 转发；`stop` 走 `Page.stopLoading`；左右滚改用 deltaX）。
- **对话框**：页面弹着对话框时其余动词立即以 `browser_dialog_pending` 拒绝并带上文字；引起对话框的点击不再在对话框后面等 45 秒。
- **before-input-event 自抢租约**：核实不存在。Electron 42 下 CDP 的键鼠不触发 guest 的 `before-input-event` 与 `focus`，只触发壳里没人监听的 `before-mouse-event`；探针桌面一段整批动词之后租约仍是「Agent 正在操作」。顺手修掉桌面壳每次重新接上调试器都多挂一个 message 监听、事件重复投递的问题。
- **原生下拉**：macOS 上方向键打开的是系统菜单，合成按键够不着，原来的实现在这里选不中。改为 `DOM.focus` + 逐字 `char` 事件的键入跳转，跳转不认 CJK 或选项重名时用冻结脚本表里唯一的写入脚本 `chooseOption`（只对已启用的 SELECT、只按下标、触发 input 与 change），源码测试钉住它。白名单为此放行「只带一个字符、没有键名与修饰键」的 char 事件。

### 52.2 端到端发现并修掉的

| 现象                                                                                 | 原因                                                                                                                                   | 修复                                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 桌面壳 `pdf` 报「没有这个接口」404；超过 1.5 秒的 `wait` 同样                        | hook 客户端对浏览器动词也用 hook 事件的 1.5 秒预算，超时后换下一个候选端点**重发同一个动词**（点击会点两次），落到不认 hook 路由的端口 | 浏览器请求预算 70 秒（`4fb4f1a7`），单测 + 探针「3 秒的 wait 如实超时」   |
| 桌面壳对含跨源 iframe 的页面 `pdf` 挂死                                              | Electron 42 给这种 `<webview>` 的 `printToPDF` 永远不返回，与调试器无关（最小复现里退出时 SIGTRAP）                                    | 先拒绝并指向 `capture --full-page`，其余加 20 秒上限（`e981065c`）        |
| 上传完成后画布上一直挂着「页面要选择文件」                                           | 两个后端回答选择框时都没有发关闭事件                                                                                                   | `fileChooserClosed` 事件（`fedafc8e`）                                    |
| `read --mode network` 里跨源 iframe 的文档请求永远「进行中」，`wait --idle` 等满超时 | 它从页面发出、在 iframe 进程里结束                                                                                                     | iframe 会话导航到该地址时记为结束，另有 5 / 10 秒的陈旧规则（`bff46d4c`） |
| 悬停之后点击或拖动落在错误位置                                                       | 指针离开原悬停处，菜单收起，下面的元素上移                                                                                             | 指针移过去之后再量一次（随主提交）                                        |
| 点击触发 alert 时动词挂 60 秒                                                        | 鼠标事件在对话框关闭前不返回，后续的读脚本也被挡住                                                                                     | 输入事件与「对话框打开」赛跑，打开后脚本调用立即拒绝（随主提交）          |

### 52.3 实测

`node tools/probes/browser-agent-e2e.mjs --electron`：111 项全部通过。headless 一段 59 次 hook 调用 14.2 s，Electron `<webview>` 一段 56 次 14.3 s；最慢的单个动词是连续第二次原生下拉选择（1.1 s，等上一次的键入跳转缓冲过期）。产物在 `target/browser-agent-e2e/`：`headless-snapshot.txt` / `electron-snapshot.txt`、两份请求与控制台输出、视口 / 整页（3212×3044）/ 元素截图、`headless-page.pdf`、`electron-next.pdf`、`electron-canvas.png` 与 `electron-canvas-after.png`。渲染页唯一的 error 是关标签页时 Electron 自己的 `Invalid guestInstanceId`（guest 已先销毁），单列未计入失败。

### 52.4 没做 / 已知

- 整页截图里跨源 iframe 在视口以外的部分是空白（Chromium 的 `captureBeyondViewport` 不重绘 OOPIF）。
- 桌面壳在 Agent 第一次驱动时才接调试器，之前的控制台与请求不在缓冲里。
- 多选 `<select>` 只选一个；Shadow DOM 里的元素靠无障碍树能读能点，`--selector` 穿不进去。
- hook 客户端在一个候选端点写出请求后失败仍会试下一个候选：浏览器动词靠 70 秒预算基本避开，`canvas` 动词没动（不在本任务范围）。
- Windows / Linux 没跑；关标签页时 `Invalid guestInstanceId` 的来源在前端的 `<webview>` 卸载顺序，没改。
- `core/collab/skill.ts` 的浏览器动词表属于另一个任务，未改；可直接从 `core/browser/args.ts` 读 `BROWSER_VERB_SPECS`（`name` / `synopsis` / `helpZh` / `flags[].helpZh`）与 `BROWSER_NOTES_ZH`。

### 52.5 验证

- `pnpm --filter @armadra/desktop test`：264 文件通过、1 跳过（3120 条通过、6 跳过），live 配置 2 文件 2 条（含新的 `verbs.live.integration.test.ts`，真 Chromium 跑全部动词），脚本 38 条通过（worktree 里 node-pty 的 `spawn-helper` 先 `chmod +x`）。
- `pnpm --filter @armadra/server test`：10 文件 82 条通过。
- `pnpm check`：format、typecheck、ci:workflows、release:check 通过；repo:check 报 `tools/probes/agent-e2e.mjs` 1675 行超限，基线 5017db32 上即如此，未改动。

## 53. 三平台 CI：远端执行主机、Windows 启动行与编辑器草稿串用例（2026-09-26）

接着 §33。依据是 PR #6 的两次运行：36171079430（8e436cfd）与 36217989294（ce0aa8cd）。后一次 Windows 上 `apps/desktop` 19 条失败，Linux 与 macOS 各 1 条（live 配置），三个平台都因 desktop 先失败而没跑到 web；前一次 macOS 的 web 有 1 条。本机没有 Windows，下面 Windows 的部分靠逻辑与 `path.win32` 单测，要等下一次 CI 证实。

原则照 §33：执行主机是 POSIX 机器（`worker.path` 本来就只收 `/` 开头），**控制端可以是 Windows**。远端路径在控制端一律按 POSIX 判；只属于某一台机器的路径（本机工作空间根、私钥、落盘位置）按那台机器自己的规则判。

### 53.1 产品 bug（Windows 控制端线上会遇到）

- **切回本机被 400。** `remote/switch.ts` 的 `validateRequest` 对所有目标写死 `startsWith("/")`，`remote/operations.ts` 的 `registerRoot` 同样。Windows 控制端把工作空间切回本机（`executionHostId: ""`）时根是 `C:\…`，两处都拒。现在：目标是本机按控制端的 `node:path` 判，目标是执行主机按 `path.posix` 判；`registerRoot` 与 Worker 帧入口（`remote/server.ts`）按「执行这一步的那台机器」的 `isAbsolute` 判——它们跑在哪台机器上，根就是哪台机器的路径。`language/routes.integration.test.ts` 的「moving the workspace to another root」失败正是这一条（本机 → 本机的强制切换）。
- **私钥路径配不上。** `settings/ssh-hosts.ts` 的 `validateHost` 要求 `identityFile` 以 `/` 开头且不含反斜杠，但 `ssh -i` 读的是控制端的文件，Windows 上是 `C:\Users\…\.ssh\id_ed25519`。改为按控制端规则判绝对、Windows 上放开反斜杠（它只进本机 argv，不进远端 shell）；`worker.path` / `worker.stateDir` 在执行主机上，照旧只收 POSIX。这一条 CI 没有覆盖到，是排查时顺带发现的。
- **画布启动行的单引号。** `hook/install/inject.ts` 的 `shellWord` 只会 POSIX 单引号，Windows 上节点 shell 默认是 `COMSPEC`（`cmd.exe`），它不认单引号，`--settings 'C:\…\settings.json'` 连引号一起到 CLI。Windows 上只含路径字符（含 `\`、`~`）的原样写，其余用 `cmd.exe` 与 PowerShell 都会剥掉的双引号。`.map(shellWord)` 两处改成显式箭头，免得数组下标被当成平台参数。`agent/canvas-launch.test.ts`、`terminal/hibernator.test.ts` 的两条失败由此而来，期望值改为经 `shellWord` 拼出。

### 53.2 测试假设（源码没问题）

- `browser/cdp/verbs.test.ts` 截图：回答里是落盘后的绝对路径，Windows 上是 `s\view.png`，期望改用 `join`。live 用例里同样的 `shots/view.png` 一并改掉（Windows 上 live 配置这次没跑到）。
- `hook/install/{codex,migrate}.test.ts`：夹具把 `[hooks.state."<路径>:stop:1:0"]` 原样写进 TOML，Windows 路径里的 `\U`、`\A` 成了转义序列，读回来的键已不是那个路径，于是「删掉我们的信任记录」无从匹配。夹具改为像 Codex 那样转义（`JSON.stringify` 与 TOML 基本字符串兼容），`codex.test.ts` 的断言改走 `stateKeys`。产品这边写与读都经 `escapeKey` / `unescapeKey`，本来就对。
- `browser/headless/verbs.live.integration.test.ts` 的 resize（Linux 与 macOS）：回答的是 `cssLayoutViewport` 的客户区——坐标检查用的就是它。fixture 两个方向都能滚，runner 上是经典滚动条，800×600 答成 785×585；本机是浮动滚动条所以一直是 800×600。断言改为两边各在一条滚动条厚度之内。
- `EditorNode.save.test.tsx`（macOS 的 web）：根因是**用例之间串了草稿**。「late save response」那条在 `note.txt` 里敲了 `one` 就换文件，卸载时的 flush 把它作为草稿写进 localStorage（base 版本 `aaa…`），之后没人清；下一条打开 `note.txt`，读到的版本正好也是 `aaa…`，恢复逻辑把 `one` 放回来——放回发生在用例敲 `draft` 之前还是之后取决于时序，CI 慢就撞上。本机复现不了的原因更隐蔽：Node 25 起全局自带 `localStorage` getter，没给 `--localstorage-file` 时答 `undefined` 且盖住 jsdom 的那一个，本机（Node 26）上所有本机存储读写都静默失败，CI 是 Node 22。修法两层：`app/test-setup.ts` 在存储不可用时换回 jsdom 自己的 `localStorage`，本机与 CI 跑同一件事；`EditorNode.{save,files,external}.test.tsx` 的 `beforeEach` 先 `localStorage.clear()`（`drafts.test.tsx` 本来就注入了自己的存储）。

### 53.3 按平台门控

- `remote/execution.test.ts` 的「opens a project on the host only once its root is proven there」与「rebinds to the same project elsewhere…」：它们把本机子进程当执行主机，经路由交给控制端一条远端根；控制端只收 POSIX 根，而 Windows runner 上的目录只有 `D:\…` 一种写法——「Windows 执行主机」本来就不存在。Windows 控制端切回本机的那一半由 `remote.test.ts` 的 `path.win32` 用例和 `language/routes.integration.test.ts` 覆盖。
- 同一批里其余 11 条（stdio 握手、读重放、远端文件 / 导入 / Git 路由、推送监听、语言连接）**没有**门控：它们失败都是因为 Worker 帧入口写死 `/`，改成按 Worker 自己的机器判之后，在 Windows 上照样能测控制端那一半——`RemoteWorker` 的 stdio、帧、重连就是 Windows 控制端线上要跑的代码。

### 53.4 没做的

- `agent/launch.ts` 给程序路径的引用、`codexWords` 的 `"$ARMADRA_CODEX_HOOK"` 仍是 POSIX shell 语法（`cmd.exe` 用 `%VAR%`，PowerShell 用 `$env:VAR`）。Windows 上的 Codex 画布启动行因此仍然不对，需要按节点实际 shell 生成，范围超出这次 CI 修复。
- `apps/web/src/panels/automation/CreatePlanForm.tsx` 对新会话根目录写死 `startsWith("/")`，Windows 控制端上同样会拒 `C:\…`；本次没有 CI 用例覆盖，未改。

### 53.5 验证

- `pnpm --filter @armadra/desktop test`：266 文件通过、2 跳过（3142 条通过、13 跳过）；live 配置 2 文件 2 条通过；脚本 38 条通过。
- `pnpm --filter @armadra/web test`：283 文件 2761 条通过（test-setup 换回真存储之后全量复跑）；`typecheck` 通过。`vitest run src/nodes/EditorNode --sequence.shuffle` 连跑 5 次，37 条全过。
- 新增用例：`remote.test.ts` 用 `path.win32` 模拟 Windows 控制端的切换校验；`settings/schema.test.ts` 的私钥路径；`hook/install/inject.test.ts` 的 `shellWord` 两个平台。
- `pnpm check`、`pnpm format:check` 通过。Windows 上的结论待推送后 CI 确认。

## 54. 启动行按节点 shell 的方言引用；本机路径按 core 的平台校验

接 §53.4 没做的两项。Windows 是发布目标：节点终端的 shell 缺省是 `COMSPEC`（`cmd.exe`，没有时 `powershell.exe`，见 `terminal/environment.ts::defaultShell`），画布启动行却一直按 POSIX 写。

### 54.1 按方言引用

- `packages/shared/src/shell.ts`（core 里逐字节同一份 `core/terminal/shell.ts`——core 不依赖 `@armadra/shared`，`agent/canvas-launch.test.ts` 比对两份）：四种方言 `posix`（sh/bash/zsh/dash/ksh）、`fish`、`cmd`、`powershell`（含 `pwsh`），`quoteShellWord` 引参数、`shellEnvWord` 引「前缀 + 环境变量」（`"${VAR}"` / `"$VAR"` / `"%VAR%"` / `"${env:VAR}"`），`shellCommandLine` 拼整行（PowerShell 的程序带引号时前面加 `&`）。
  - fish 单独一种：它的单引号里 `\\`、`\'` 仍是转义，以反斜杠结尾的值会吞掉收尾的引号；`%` 开头曾是进程展开。
  - `cmd.exe`：不含 `"`、`%`、`!` 的值用 C 运行库的双引号（引号前与末尾的反斜杠加倍）；含它们的值整体按 C 运行库引用后给每个活字符加 `^`，`%` 写成 `^%`，使 `%NAME%` 的变量名变成未定义的 `NAME^`。拒绝换行。
  - PowerShell：单引号（`'` 与弯单引号都加倍）。值里的 `"` 要靠 PowerShell 7.3+ 的原生参数传递才能原样到达；Windows PowerShell 5.1 会剥掉，这是那个 shell 的限制，没有绕。
- 启动行不再带已引用好的词：`canvasInjection` 的 `words` 与 `GET /api/agents` 的 `launchWords` 改成未引用的 `LaunchWord`（字面值，或 Codex 的 `{ prefix, env }`），由拼行的一方按方言引用。
- 方言取节点终端实际跑的 shell（`canvas-launch.ts::nodeDialect` / 页面 `agent/launch.ts::launchDialect`）：会话记录里的 `shell` → 节点指定的 → core 的缺省 shell；SSH 节点一律 POSIX。四条路都走同一个出口：页面（`use-launch.ts` 用会话记录的 shell，会话网关把它带出来）、依赖编排（活着的终端的 `shell` 列，否则节点数据）、休眠唤醒（`hibernatedSession` 带出那一行的 `shell`）、冷启动（缺省 shell）。
- Codex 由行展开的两个环境变量在 `cmd.exe` 下不能照原样：`cmd.exe` 先把值贴进引号再读，值里的 `"` 会结束引号、暴露后面的 `&`，程序再按 C 运行库剥掉裸引号。`inject.ts::codexTomlString` 在 `cmd` 方言下把 TOML 串的定界引号写成 `\"`、其间 `& | < > ^ ( ) % ! " \` 与控制字符写成 `\uXXXX`；其余方言照旧是 JSON 形状。所以 `canvasEnvironment` / `ownedEnvironment` 也按终端的方言答（`POST /api/terminals`、`spawnForNode`、冷启动、`Hibernator.environment` 都传进来）。
- `/api/health` 末尾追加 `platform`（`process.platform`）与 `defaultShell`（只报程序名）。页面的 `app/core-host.ts` 问一次，给缺省方言与本机路径规则用。
- 顺手：文件拖进 fish 终端时路径改用 fish 的引用。

### 54.2 本机路径按平台校验

- `apps/web/src/lib/host-path.ts`：`isAbsoluteHostPath(path, rules)`，POSIX 要 `/` 开头，Windows 收盘符与 UNC、拒 `"<>|?*` 与盘符之外的 `:`；`isAbsoluteExecutable` 在 POSIX 侧照旧不收空白，Windows 侧收（`Program Files`）。
- 自动化向导（`CreatePlanForm.tsx`、`wizard.ts::buildLaunchSpec`）：工作区绑在执行主机上时按 POSIX，否则按 core 的平台；占位符跟着换。全仓搜过 `startsWith("/")`：其余几处（文件拖放、画框绑定、Markdown 图片、工作区相对路径）已经分平台或本就是工作区相对路径，不动。

### 54.3 Windows 集成用例

- `core/agent/windows-launch.test.ts`（`it.runIf(process.platform === "win32")`）：把 `shellCommandLine` 生成的整行交给真的 `cmd.exe`（`/d /s /c`，原样传参）与 `pwsh`（`-EncodedCommand`，只在 7.x 存在时跑），程序是回显 argv 与环境变量的 node 脚本；断言十八个值（空格、引号、`%`、`^`、`&`、`|`、`$`、反引号、`!`、中文、反斜杠结尾、空串）与两个由行展开的环境变量（普通值；`codexTomlString` 写的 TOML 串，解析回来等于原文）原样到达。
- 程序直接是 `node.exe`，不经 `.cmd` 包装：批处理的 `%*` 会让 `cmd.exe` 再读一遍参数，含 `\"` 与 `&` 的参数在第二遍里露出来，这是 `.cmd` 包装本身的问题（npm 装的 CLI 在 Windows 上多是这种包装），任何引用都挡不住。
- `cmd.exe` 下由行展开的值不能含 `"`、不能以 `\` 结尾——环境是我们自己写的，Codex 的两个已按此写。

### 54.4 验证

- `packages/shared`：29 文件 247 条通过。`shell.test.ts` 表驱动四种方言 × 18 个值，`cmd.exe` 的读法（`%` 展开、引号外的 `^`、C 运行库切参数）在用例里模拟；core 的 `terminal/shell.test.ts` 把整行真的交给本机的 sh/bash/zsh/dash 读回（shared 没有 node 类型，真跑 shell 的用例放在 core）。
- `pnpm --filter @armadra/desktop test`：267 文件通过、3 跳过（3149 条通过、15 跳过），live 2 条通过；`windows-launch.test.ts` 在 macOS 上 2 条跳过、能编译。
- `pnpm --filter @armadra/web test`：284 文件 2780 条通过；`typecheck` 通过。
- `pnpm check`、`pnpm format:check` 通过。Windows 上的两条集成用例待 CI 确认。

## 57. Windows 启动：绕过 npm 的 `.cmd` 包装、Windows PowerShell 5.1 用 `--%`；节能休眠先敲 CLI 的退出命令（2026-09-26）

接 §54 的两条已知限制，以及 §43.2 里「友好退出只是结束会话」。

### 57.1 绕过 npm 的 `.cmd` 包装

- 批处理用 `%*` 把参数交给真正的程序，这一步 `cmd.exe` 会把参数文本再读一遍：值里的 `"` 让引号翻面，被它护着的 `&`、`|` 当成命令执行，敲进去的那一行怎么引用都挡不住。所以不去引用它，而是绕过它。
- `core/agent/windows-shim.ts`：读 npm / pnpm 写的包装脚本，找出最后那条命令。认 npm 7–10（cmd-shim 的 `SET "_prog=…"` 两支加 `endLocal & goto … & "%_prog%" "<脚本>" %*`，以及目标是原生程序时的 `"%dp0%\…\claude.exe" %*`）、npm 6 与 pnpm 的 `IF EXIST "%~dp0\node.exe" ( … ) ELSE ( node … )` 块、同一套生成器写的 `.ps1`（`& "$basedir/node$exe" "…" $args`）。`.cmd` 读不出来再试同名 `.ps1`。包旁边有 `node.exe` 用它，否则按 CLI 的 PATH 找 `node`；目标脚本不存在、程序是变量、先 `call` 别的批处理这类都答「读不出来」。
- 注册表：`GET /api/agents` 每行多一个可选的 `launchTarget: { program, args }`（`resolvedPath` 仍是包装本身，设置页照旧显示它）。页面 `agent/launch.ts` 有它就用 `program` 当程序、`args` 接在最前（`assembleLaunchCommand` 新增 `programArgs`，只进敲出来的行，不进冻结的计划 argv）；用户在设置里写了自定义启动命令时不用它。core 这边在唯一出口 `canvasLaunch` 里做同一件事，Windows 上调用方没给程序时先在 PATH 上解析，免得 shell 自己找到 `.cmd`。依赖编排、休眠唤醒、计划冷启动因此都不用改。
- 读不出来的包装留作程序：`shell.ts::shellCommandLine` 遇到 `.cmd` / `.bat` 程序时，词里有 `" % ^ & | < > ( )` 或换行就拒绝拼行（抛错，这次启动不发生），而不是敲一行会被拆开的命令。环境变量引用只看前缀；它的值由写的一方保证——`canvas-launch.ts::startsThroughBatch` 为真时 Codex 的两个环境变量不管节点跑什么 shell 都按 `cmd.exe` 的形状写（`codexTomlString` 的 `\"` 与 `\uXXXX`），两遍都读不坏。
- 任务里提到「有危险字符就把长值改走环境变量」，这里没这么做：`cmd.exe` 第一遍就把变量的值贴进行里，批处理的第二遍读到的还是那段文本，挪进环境变量挡不住任何东西；只有 CLI 自己能解码的写法（Codex 的 TOML `\uXXXX`）才有用，所以只对 Codex 这么写，其余拒绝。

### 57.2 Windows PowerShell 5.1

- 方言多一种：`shellDialect("powershell.exe")` 现在答 `windows-powershell`，`pwsh` 仍是 `powershell`。单个词的写法两者相同；整行上，5.1 在第一个它传不好的词（含 `"`、空串、带空白又以 `\` 结尾、环境变量引用）前面放停止解析符 `--%`，之后的词按 C 运行库的规则引用，变量写 `%NAME%`（`--%` 仍会展开的唯一一种）。`--%` 之前的词照旧是 PowerShell 的单引号词。
- 二选一选了 `--%`，理由：5.1 丢引号发生在它把参数交给原生程序的那一步，字符串从哪来都一样，值挪进环境变量再 `"${env:X}"` 引用照样被剥；`--%` 之后的文本原样交给程序，写成 C 运行库的引用就是程序看到的参数，而且变量正好是 `%NAME%` 这种展开，Codex 的值用 `cmd.exe` 那套现成的写法。代价：`--%` 之后带不了 `%`（会和后面的 `%` 配对吞掉变量）与 `|`（到那里就结束），这样的值拒绝拼行。
- 缺省 shell（`terminal/environment.ts::defaultShell`）：Windows 上仍是 `COMSPEC`；没有它时，PATH 上有 `pwsh.exe` 就用 PowerShell 7，再没有才是 `powershell.exe`。
- 顺手：`codexTomlString` 在 `windows-powershell` 下也写 `cmd.exe` 形状。

### 57.3 节能休眠先礼后兵

- 注册表加 `exitCommand`（`packages/shared` 的 `AGENT_REGISTRY` 与 core `agent/launch.ts` 的镜像各一份，两边用例逐个比对）：Claude、OpenCode、Oh My Pi、Copilot `/exit`，Codex、Pi `/quit`。Pi、Oh My Pi、Codex 从本机装的包里核对过命令表；自定义条目用 base 的。
- `Hibernator.hibernate`：判定该睡之后先敲退出命令，命令与回车分两次写（中间 150 ms，一口气写进去的回车有的 TUI 当成粘贴里的换行），然后每 200 ms 看一次前台，变回 shell 就接着结束会话，最多等 5 秒；敲不进去或等不到都照旧结束。CLI 自己退出时会写完会话状态，resume 接得更全。日志里记 `quit: quit | timeout | none`。
- 退出命令只在判据全过（空闲、没有半截输入、租约空闲、没人附着）之后敲，所以不会打进人正在用的输入框。

### 57.4 技能与说明

- 技能正文（`collab/skill.ts`）与各 help 里没有 Windows 专门的说明，无须改。设计文档同步：`canvas-only-integration.md` 的方言一段（五种方言、`--%`、绕过包装），`terminal-host-design.md` §7.4（退出命令，删掉「没先发退出命令」一条）。
- 发现但不在本任务的文件范围内：Agent 按技能调用的 `armadra-hook` 在 Windows 上也是 `.cmd` 启动器（`cli/armadra-hook/launcher.ts`），`canvas send --body '…'` 这类带正文的调用同样会被批处理再读一遍，正文里的 `&`、`"` 有同样的问题。

### 57.5 验证

- `core/agent/windows-shim.test.ts`：15 个样本表驱动（npm 7–10 的 node 脚本 / 包内 `node.exe` / shebang 参数 / 原生程序，npm 6 两支，pnpm 两种目录，`.ps1` 三种，读不出来的四种），加分派、`.cmd` 退到 `.ps1`、PATH 上没有 node。
- `packages/shared/test/shell.test.ts`：五种方言；模拟 5.1 的读法（单引号词、不转义地传参、`--%` 之后原样并展开 `%NAME%`、C 运行库切参数），断言值原样到达、不加 `--%` 时 `"` 会丢、`--%` 带不了的拒绝；批处理程序后各方言拒绝危险词、放行安全词并经模拟的 `cmd.exe` 读回。`agents.test.ts` 补 `programArgs` 与退出命令。
- `core/agent/canvas-launch.test.ts`：5.1 下 Codex 行的 `--%` 与环境变量形状；读不出来的包装（真文件）下 `startsThroughBatch`、环境变量按 `cmd.exe` 写、危险词拒绝。`web/agent/launch.test.ts`：有 `launchTarget` 时绕过 `.cmd`、带 `&` 与 `"` 的提示词照常引用，没有时拒绝；5.1 的 `--%`。
- `core/agent/windows-launch.test.ts`（`it.runIf(win32)`）新增三条：真 `powershell.exe` 5.1 跑 `--%` 行；照 cmd-shim 格式造一个包装指向回显 argv 的 node 脚本，`launchTargetOf` 读出 `node <脚本>`，整行交给 `cmd.exe`，§54 那十八个值与两个环境变量原样到达；读不出来的包装只放行安全词并真的经批处理到达。macOS 上跳过、能编译，待 Windows CI 确认。
- `core/terminal/hibernator.test.ts`：收到 `/exit` 自己退的假 CLI 不等满宽限期就结束、不退的等满 5 秒后被结束、Codex 敲 `/quit`；`hibernator.pty.test.ts`：真 PTY 上读输入的假 `claude` 收到 `/exit` 先写「saved」再退、5 秒内结束，原来那个不读输入的等满宽限期后被结束，接回照旧 `--resume`。`terminal/environment.test.ts` 补缺省 shell。
