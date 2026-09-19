# TypeScript Core：Go Host 与 Rust Runtime 合一

> 状态：目标设计，待实施。基线 `359058afd`（`feature/host-protocol-foundation`）。
> 决定：**不再维护三种后端语言**。把 Go Host（非生成码 51,304 行）与 Rust Runtime（`apps/runtime` 135,530 行 + `crates/` 12,855 行）合并重写为**一个 Electron-free 的 TypeScript core**，由两种壳装配：桌面 Electron 壳（`apps/desktop`，已实施）与新增的无窗口服务器壳（浏览器与手机）。
> 直接后果：进程从三个（壳 / Host / Runtime）变成两个（壳 / core），跨进程业务协议**整体消失**——`proto/`、三处生成码、`crates/protocol`、`packages/protocol`、Host↔Worker stdio 帧、写入所有权切换机制全部删除。
> 本文给结构、选型、吸收与删除清单、不可变契约、分阶段、并行、风险。盘点数字与统计命令在附录 A，全部实测于 `359058afd`。

## 1. 结论

| #   | 决定                                                                                                                                                                                                      | 依据                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 一个 core，两种壳。core 落在 `apps/desktop/src/core/`；服务器壳落在 `apps/server`                                                                                                                         | core 与桌面壳共用 `electron-vite` 构建与原生模块 rebuild；服务器壳是纯 Node，只多一个 `node:http` + TLS + 托管前端的入口                                                                                           |
| D2  | core **必须能脱离 Electron 以纯 Node 运行**，由 `no-electron` 源码扫描守住                                                                                                                                | 服务器壳没有 Electron；`apps/server` 就是这条约束的第二个消费者，也是它的持续验证                                                                                                                                  |
| D3  | **跨进程业务协议整体删除**：`proto/` 22 个文件、`apps/host/gen`（59,746 行）、`packages/protocol`（27,310 行）、`crates/protocol`、`pnpm protocol:*`、191 个 fixture                                      | 协议存在的唯一理由是 Go / Rust / TS 三端各有一份手写 DTO。合一之后只剩 TS 一端，类型就是类型。手机端是服务器壳托管的**同一份前端**（Host 的 `WebRoot` 已经这么做），不是原生 App，所以 proto 没有剩余消费者        |
| D4  | **写入所有权机制整体删除**：`write_ownership` 表、epoch、settled/switching/rolling_back 三相、导出→staging→投影→核验五步、`armadra-host ownership *`、`host_imports`、`migration/legacy` 的 14 份迁移副本 | 它是「Go 与 Rust 不能同时写一个库」的解法。同进程之后没有第二个写者，这个问题不存在                                                                                                                                |
| D5  | **两个数据库合成一个**。Host 的 `host.db`（10 个 schema 版本、36 张表）与 Runtime 的 `canvas.db`（14 个迁移、21 张表）并成一份，迁移编号只增、账本语义保留，`migrations.lock` 三处校验**收敛为一处**      | 两份库的表集合基本不重叠（见 §6）：Host 侧是身份/调度/事件/GitHub/通用实体，Runtime 侧是画布/终端/Agent。合并是并集，不是对账                                                                                      |
| D6  | 来源与凭据检查**按壳分档**：桌面壳同进程直连（无票据链、无 `--allow-origin`），服务器壳保留完整的设备配对与会话                                                                                           | 票据链（私有控制通道签票 → 换 Bearer）存在的理由是「页面来源与 Host 是两个进程、Cookie 按 host 不按 port 隔离」。桌面壳里 core 就在壳进程树内，壳可以直接把凭据经 preload 注入，不需要中间的票                     |
| D7  | 双实现并存期由 `ARMADRA_CORE=ts` 一个开关决定：壳拉 TS core 还是拉 Rust Runtime + Go Host                                                                                                                 | `apps/desktop/src/main/runtime-process.ts`（592 行）已经知道怎么拉起一个二进制并按 `/health` 的 `instanceId` 对账；TS 版换成 `utilityProcess(out/core/main.js)`，对账逻辑不改。`ARMADRA_CORE=ts` 时壳**不拉 Host** |
| D8  | 对外契约在 R1–R5 期间逐字节不变：163 条 Runtime HTTP 路由、3 条入站 WS、21 个事件、`armadra-hook` 命令面、0600 文件语义                                                                                   | 前端 `apps/web/src/api/` 20 个文件 155 处路由字面量、`packages/shared` 347 个 zod schema 按现状编译；契约不动 = 切换只是换实现                                                                                     |
| D9  | Host 的 119 个 RPC 方法**不逐条保留**：能力吸收进 core 的域模块，前端的 `apps/web/src/host/`（64 个文件引用）改打同一套 `/api/`                                                                           | 前端现在同时说两套（`runtimeApi` 说 `/api/`，`@armadra/host-client` 说 `/rpc/`）。合一之后只剩一套，`packages/host-client`（8,033 行）删除                                                                         |
| D10 | 不做双写、不做「TS 与 Rust 同时对外服务」。切换粒度是**整个 core 进程**，回滚是开关切回                                                                                                                   | 双写 SQLite 与双持 PTY 都是对账噩梦                                                                                                                                                                                |

**不做**：不改 HTTP/WS 接口形状（R7 之前）；不改已发布迁移的字节；不把终端域搬出 core；不在重写期间做与重写无关的目录移动；不引入 MCP；不为「将来可能的原生 App」保留 proto——真要做时再引入。

## 2. 目标结构

```text
apps/desktop/                     Electron 桌面壳
  src/main/                       窗口、托盘、IPC、静态服务、<webview>、utilityProcess 装配
  src/shell-core/                 壳的纯逻辑（已有 no-electron 扫描）
  src/core/                       ← 新增：Electron-free 的 core（两种壳共用）
    main.ts                       进程入口：--listen、--data-dir、装配各域
    platform.ts                   CorePlatform 接口 + platform-node.ts / platform-electron.ts
    no-electron.test.ts           源码扫描，正则自带单测
    http/                         路由表、来源与凭据分档、CORS、错误信封、body 上限、WS 升级
    db/                           连接、迁移账本 preflight、每张表一个模块
    bus/                          进程内事件总线 → WS 广播（替代 Host 的 eventstream + outbox）
    identity/                     owner、设备、配对、会话、撤销（吸收 Host identity + server/auth）
    canvas/ settings/ models/     工作空间、看板、文档、资产、偏好、模型目录
    terminal/                     tmux / direct / sessionHost / ssh、输入门、回放、GC
    hook/ collab/                 Hook 端点与归一化、安装单元、context-link / control 动词、mailbox
    git/ github/ files/           Git 队列与仓库操作、GitHub、文件读写搜索监听导入导出
    language/ browser/ resources/ usage/  LSP、浏览器授权与租约、采样与电源、用量
    schedule/                     定时与自动化（吸收 Host automation 的 engine/schedule/plans/receipts）
    remote/                       SSH 远端执行（ssh + ControlMaster）
    updates/                      发布清单读取与校验，壳侧 updater 消费
  src/session-host/               ← 新增：Windows ConPTY 守护进程（独立 esbuild 产物）
apps/server/                      ← 新增：无窗口服务器壳
  src/main.ts                     node:http(s) + ws + 托管 apps/web 产物 + 单 owner 认证
  src/platform-node.ts            CorePlatform 的服务器实现（无 safeStorage、无 resourcesPath）
tools/hook/                       ← 新增：armadra-hook 的 sh shim 生成器
```

**`CorePlatform`**：core 与壳之间唯一的缝，收窄到 8 个成员——只读的 `userDataDir` / `appVersion` / `isPackaged` / `resourcesPath?`，成对可选的 `sealSecret?` / `unsealSecret?`（缺其一是编程错误；服务器壳两个都不提供，落到已有的「keychain 不可用就降级 0600 文件并在设置页标注降级」那条路径），`openExternal`，以及单向的 `notify(channel, payload)`（托盘通知、更新提示）。其余一切走 HTTP/WS，因为 core 本来就是个服务。

**边界守卫**：`core/no-electron.test.ts` 与壳已有的 `shell-core/no-electron.test.ts` 同一写法（正则 + 第二个 `it` 用必须命中/必须放过的样本自测正则），禁止清单三条：不得 import `electron` 及其子路径、不得 import `../main/`、不得 import `../shell-core/`。`apps/server` 能跑起来本身就是这条约束的端到端验证。

**两种壳的差别**（core 一字不改）：

| 项       | 桌面壳                                    | 服务器壳                                                                                              |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 进程     | `utilityProcess(out/core/main.js)`        | core 直接在主进程里，或同一二进制的子进程                                                             |
| 页面     | 壳的回环静态服务（端口内核分配）          | core 托管 `apps/web` 产物（复用 Host 的 WebRoot 结构：整棵树经 `os.Root` 打开，符号链接无法指向包外） |
| 监听     | 回环 TCP（内核分配）+ unix socket         | 配置的地址 + TLS                                                                                      |
| 认证     | 壳经 preload 注入凭据，同进程树，无票据链 | 设备配对 → 可撤销凭据 → 会话轮转 + CSRF + Origin 校验                                                 |
| 凭据密封 | `safeStorage`                             | 无，降级 0600 文件                                                                                    |
| 更新     | electron-updater（已接通）                | 不自动更新，`status` 报告版本                                                                         |

## 3. 技术选型

| 域                 | 现状                                           | TS 选型                                                               | 理由                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTY                | `portable-pty 0.9`（Rust）                     | `node-pty` 1.1.0 + 两个必打的原生补丁                                 | 没有第二个成熟选项。补丁必须连带：macOS `pty.cc` 的 fd 泄漏（失败 spawn 漏 2 个 pty 设备；成功 spawn 因 low-fd 清理循环 off-by-one 再漏 1 个，数小时内撞满 `ptmx_max`，之后所有 spawn 报 `posix_spawnp failed`）与 Windows `conpty.cc` 的 HPCON 竞态（外部 taskkill 进程树后原生退出线程先 delete baton 而不关 HPCON，conhost 泄漏到守护进程退出）。这是本次重写**净新增**的债务 |
| SQLite             | `sqlx 0.9`（Rust，异步）+ Go 的 `database/sql` | `node:sqlite`（Node 22+ 内建，同步）                                  | 实测 Electron 43.4.0 的 `process.versions.node = 24.18.1` 且 `require('node:sqlite')` 返回 object（附录 A.8）；仓库 `engines.node >= 22`。内建 = **没有原生模块**，省掉 `electron-rebuild`、`asarUnpack` 与公证下的原生模块签名。`better-sqlite3` 作为备选，接口由 `db/driver.ts` 包住                                                                                           |
| 同步 SQLite 的阻塞 | tokio / goroutine                              | core 主循环直接调用；**长事务与终端热路径分离**                       | 同步调用阻塞的是 core 自己的事件循环。R1 验收量化门槛：8 MiB 白板文档保存 P95 < 20 ms；超阈值把 `documents` 的保存搬进 `worker_threads`。终端字节流不经 SQLite（回放日志是追加写文件）                                                                                                                                                                                           |
| 文件监听           | `notify 8.2`                                   | `node:fs.watch` + 自写 debounce / 重绑                                | 已验证 126 行零依赖实现足够；`chokidar` 的递归轮询在大仓库上更贵。`file.changed` 的 `Replaced` 判定改用 `fs.statSync` 的 `dev`/`ino`                                                                                                                                                                                                                                             |
| Git                | shell out `git`                                | shell out `git`，`node:child_process`                                 | 现状本就不用 libgit2。仓库级锁与操作队列改成 core 内的 `Map<repoPath, Promise>` 串行链；固定 `LC_ALL=C` 等环境照抄                                                                                                                                                                                                                                                               |
| LSP                | 自写 JSON-RPC（`language/mux.rs` 839 行）      | `vscode-jsonrpc`                                                      | 官方 Node 传输层，省掉 `Content-Length` 分帧与 cancel/progress；多客户端复用一个 server 的 mux 仍自写                                                                                                                                                                                                                                                                            |
| HTTP / WS          | `axum 0.8` + `net/http` + `tokio-tungstenite`  | `node:http(s)` + `ws`                                                 | 不引 express/fastify：路由是一张显式表，中间件只有来源分档、凭据、body 上限三层。`ws` 无原生依赖                                                                                                                                                                                                                                                                                 |
| TLS                | Go 的 `crypto/tls`（Host）                     | `node:https` + `node:tls`                                             | 服务器壳专用；证书由运维提供，core 不签发                                                                                                                                                                                                                                                                                                                                        |
| Unix socket / 管道 | 手写                                           | `node:net` + 显式 chmod 0600                                          | `node:net` 原生支持 `\\.\pipe\` 与 unix 路径；调用方 SID/uid 校验按平台分支                                                                                                                                                                                                                                                                                                      |
| 进程测量           | `sysinfo =0.39.6`                              | 分平台自写：`/proc`（Linux）、`ps`（macOS）、`tasklist`（Windows）    | 不用 `pidusage`：它内部就是这三条，且在 macOS 上对进程树的累加与 `resources/` 现有语义不一致。「未知就显示未知、不填 0」的契约不变                                                                                                                                                                                                                                               |
| SSH                | `ssh` 二进制 + ControlMaster                   | 同样 `ssh` 二进制 + ControlMaster                                     | 不引 `ssh2`：host key、agent、askpass 全交给用户的 `ssh`。**ControlPath 必须短且无空格**——macOS 的 `~/Library/Application Support/Armadra` 同时违反 `sun_path` 104 字节与「无空格」两条，ssh 会静默 bind 失败，所以 ControlPath 走 `~/.armadra/ssh-cm/<hash>`                                                                                                                    |
| HTTP 客户端        | `reqwest`（rustls）+ Go 的 `net/http`          | `fetch`（Node 内建 undici）                                           | 用量轮询、models.dev 目录、GitHub API、更新清单四处；undici 自带 CA，不依赖系统 OpenSSL                                                                                                                                                                                                                                                                                          |
| 归档               | `zip 4.6`                                      | `yauzl`（只读解包）                                                   | 只用于受管浏览器归档，流式 + sha256 边下边算                                                                                                                                                                                                                                                                                                                                     |
| 哈希 / HMAC / 签名 | `sha2` / `hmac` / `subtle` / Go crypto         | `node:crypto`（含 `timingSafeEqual`、Ed25519）                        | bearer 常量时间比较是硬要求；发布清单的 minisign 校验在 `node:crypto` 里有对应原语                                                                                                                                                                                                                                                                                               |
| 定时               | Go 的 `time.Timer` + 自写 cron                 | `node:timers` + 自写 cron 解析（照搬现有 `schedule.go` 320 行的语义） | 不引 `node-cron`：现有实现已覆盖 once/interval/cron/loop 四种与时区、错过窗口的策略                                                                                                                                                                                                                                                                                              |
| 日志               | `tracing` + Go `slog`                          | 自写三级 + `ARMADRA_LOG` 过滤                                         | `RUST_LOG` 语法不必复刻；「默认隐藏终端输入与文件正文」这条规则不变                                                                                                                                                                                                                                                                                                              |
| 测试               | `cargo test` 1,363 个 + `go test` 709 个       | `vitest`（已是全仓标准 4.1.11）                                       | 纯逻辑直译；需真 tmux/ssh/git/node 子进程的走 `*.integration.test.ts`，CI 按可用性 skip                                                                                                                                                                                                                                                                                          |

**没有直接 npm 等价物、必须自写的四项**：`portable-pty` 的 `CommandBuilder` 环境块语义（node-pty 的 `env` 是整块替换，现状有继承白名单，见契约 §25）、`sqlx` 的迁移账本（§6）、`notify` 的 `Replaced` 判定、`sysinfo` 的跨平台进程树累加。

## 4. 吸收而非移植

### 4.1 Host 每个职责的去处

| Host 包（非测试行数）                                                             | 职责                                                             | 去处                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ | ---- | -------------------------------------------- |
| `server/`（5,033，22 文件，12 个 RPC 前缀共 119 个方法）                          | HTTP 分发、来源判定、scopes、代理、托管前端                      | `core/http`：路由表 + 来源分档（§2）+ 权限位；`proxy.go`（348）**整段删除**（同进程不用代理）；`webroot.go`（203）→ `apps/server`                         |
| `storage/`（6,005，21 文件）                                                      | Host 自己的 SQLite：实体、revision、收据、事件                   | 表并进统一库（§6）；`entities.go` 的通用实体投影改为各域自己的表，不再有「通用实体」间接层                                                                |
| `agenthost/`（4,380，15 文件）                                                    | Agent 状态/审批/信箱/交接/上下文链接的 Host 半边                 | 与 Runtime 的 `hook/` `collab/` **合并为一份** `core/hook` + `core/collab`（现在是两份实现对着一套语义）                                                  |
| `worker/`（3,105，20 文件，含 `wire.go` 341、`channel.go` 326、`process.go` 442） | 拉起 Rust Worker、stdio 帧、`serve_commands`、containment        | **整段删除**                                                                                                                                              |
| `sessionhost/`（2,969）                                                           | 会话意图与 generation 的 Host 半边                               | 并进 `core/terminal`（现在是 Host 记意图、Runtime 记 PTY，合并后一份记录）                                                                                |
| `canvashost/`（2,778）                                                            | 画布实体的 Host 半边                                             | 并进 `core/canvas`（同上）                                                                                                                                |
| `githost/`（2,765）                                                               | Git 操作身份与队列的 Host 半边                                   | 并进 `core/git`                                                                                                                                           |
| `settingshost/`（2,173）                                                          | 偏好文档的 Host 半边                                             | 并进 `core/settings`                                                                                                                                      |
| `githubapi/`（2,113）+ `githubhost/`（1,815）+ `githubcred/`（701）               | GitHub 客户端、缓存、凭据、Issue/PR 映射                         | `core/github`（Runtime 侧没有对应实现，这是**纯新增**的 4,629 行）                                                                                        |
| `automation/`（1,976）+ `automationhost/`（1,023）                                | 计划、cron、激活、运行记录、收据                                 | `core/schedule`（Runtime 的 `automation.rs` 775 行只是端点，真逻辑在这里）                                                                                |
| `servicedef/`（1,769）                                                            | launchd / systemd / `sc.exe` 定义生成                            | `apps/server` 的 `install                                                                                                                                 | uninstall | status | logs | upgrade`（「只生成定义、不托管」的规则不变） |
| `fshost/`（1,347）                                                                | 工作区根注册与权限判定的 Host 半边                               | 并进 `core/files`                                                                                                                                         |
| `updates/`（1,344）                                                               | 发布清单、下载、校验、版本比对                                   | `core/updates`；桌面壳的 electron-updater 改从 core 取清单，不再各算一遍                                                                                  |
| `eventstream/`（1,162：hub 529、frame 319、priority 213、catchup 101）            | durable sequence、优先级队列、慢订阅者、快照续订                 | `core/bus`：**进程内事件总线 + WS 广播**。durable sequence 与 outbox 表保留（断线续订仍需要），但 outbox 与业务写入本来就同事务，现在连事务都不用跨进程了 |
| `migration/`（952）+ `ownership/`（850）                                          | staging 导入、投影、核验、所有权切换                             | **整段删除**                                                                                                                                              |
| `identity/`（822）+ `server/auth.go`（289）+ `localipc/`（461）                   | owner、设备、配对码、票据、会话轮转、私有控制通道                | `core/identity`。桌面壳路径简化（D6）；服务器壳保留全套                                                                                                   |
| `daemon/`（514）+ `hoststate/`（499）+ `endpoints/`（147）                        | 单实例、数据目录锁、launcher 记录、端点公告                      | 并进 `core/main` 与已有的 `endpoints.json`（两段合一段）                                                                                                  |
| `commanddispatch/`（275）+ `runtimelink/`（292）+ `externalservice/`（324）       | 命令派发、Runtime 链接、外部服务判定                             | 前两个删除（同进程直接调用）；`externalservice` 并进 `core/http` 的来源分档                                                                               |
| `cmd/armadra-host/`（3,635，含 `ownership.go` 356）                               | CLI：serve / install / status / logs / upgrade / ownership / git | `apps/server` 的 CLI；`ownership.go` 删除                                                                                                                 |

### 4.2 整段删除清单

| 删除项                                                                                                                                                                                     |                    行数 | 理由                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------: | ------------------------------------------------------------------- |
| `proto/armadra/v1/` 22 个 `.proto` + `proto/fixtures/` 191 个                                                                                                                              |         6,925 + fixture | 只剩一端，类型就是类型                                              |
| `apps/host/gen/`（Go 生成码 + 63 个契约测试）                                                                                                                                              |                  59,746 | 同上                                                                |
| `packages/protocol/`（TS 生成码 23 个 `*_pb.ts`）                                                                                                                                          |                  27,310 | 同上                                                                |
| `crates/protocol/`（`src` 19 + 91 个契约测试 + `build.rs`）                                                                                                                                |                   5,393 | 同上                                                                |
| `packages/host-client/`                                                                                                                                                                    |                   8,033 | 前端只剩一套 `/api/`；`apps/web/src/host/` 的 64 个引用改打 `/api/` |
| `pnpm protocol:{generate,check,test,fixtures}` 与 `tools/protocol.mjs`                                                                                                                     |                     150 | 无 proto 可生成                                                     |
| `repo.rules.json` 的 `proto` 段（fixture 与三端契约测试的对应校验）                                                                                                                        |                       — | 同上                                                                |
| Host↔Worker：`worker/`（Go）+ `apps/runtime/src/worker/`（Rust）                                                                                                                          |           3,105 + 7,675 | 同进程                                                              |
| 写入所有权：`ownership/` + `migration/`（Go）+ `apps/runtime/src/ownership/`（Rust）+ `cmd/.../ownership.go` + `write_ownership` / `host_imports` 表 + `migration/legacy` 的 14 份迁移副本 | 850 + 952 + 6,440 + 356 | 没有第二个写者                                                      |
| `server/proxy.go` + `runtimelink/` + `commanddispatch/`                                                                                                                                    |         348 + 292 + 275 | 同进程                                                              |
| `pnpm canvas:e2e` / `ownership:e2e`                                                                                                                                                        |                       — | 验证的是所有权切换；其中画布导出/导入的断言并入 R4 的导入导出测试   |
| `migrations.lock` 的三处校验 → 一处                                                                                                                                                        |                       — | 只剩一个迁移目录                                                    |
| Rust 工具链：`Cargo.toml` / `Cargo.lock` / `pnpm rust:fmt` / `check:rust` / CI Rust 矩阵                                                                                                   |                       — | R7                                                                  |
| Go 工具链：`go.mod` / `go.sum` / `go vet` / CI Go 矩阵                                                                                                                                     |                       — | R7                                                                  |

直接删除的代码约 **111,000 行**（Go 生成码 59,746 + TS 生成码 27,310 + Rust protocol 5,393 + host-client 8,033 + worker 两侧 10,780），另有所有权与迁移机制约 8,600 行。

### 4.3 因为分进程才存在、合一后简化的机制

- **票据链**：私有控制通道签两分钟票 → 换 Bearer 会话。理由是 Cookie 按 host 不按 port 隔离，`127.0.0.1:A` 的 Cookie 会发往同 profile 的任何 `127.0.0.1:B`。桌面壳里 core 在壳的进程树内，凭据经 preload 一次性注入，**票据链在桌面路径上删除**；服务器壳面对真正的浏览器，配对与会话语义**原样保留**。
- **`--allow-origin`**：Host 要显式列出页面来源。桌面壳的静态服务端口每次启动都不同，于是这一行每次都不同。合一后桌面路径上 core 只接受壳注入的凭据，来源判定退化为「有没有那份凭据」；服务器壳仍做 Origin 校验。
- **`--launcher desktop|service|cli`** 与 `hoststate/launcher.json`：记录是谁拉起的 Host，用于 `status` 报告与升级时重启。桌面路径上退化为「壳自己知道」；服务器壳保留。
- **`lsof` 上的三个回环端口**（静态服务、Runtime、Host 43121）变成两个（静态服务、core）。
- **`endpoints.json`** 的 `runtime` 与 `host` 两段合为一段。

## 5. 不可变的外部契约

R1–R5 期间这六件事一个字节都不能变；每条配一个现在就能跑的守卫。R7 之后可以在单独的提案里收拢（例如把 `/api/` 与前端对齐得更紧），本文不动它。

1. **Runtime HTTP/WS 面**：163 条路由（`lib.rs` 148 + `hook/mod.rs` 15）、184 个方法处理器、3 条入站 WS（`/api/terminals/{id}/ws`、`/api/workspaces/{id}/events`、`/api/workspaces/{id}/language/sessions/{id}/stream`）、1 条出站 WS（core 作为客户端拨壳的 `ARMADRA_SHELL_DRIVE_WS`）。JSON 一律 camelCase，错误一律 `{ code, message }`。守卫：`tools/route-parity.mjs` 从 Rust 源与 TS 路由表各抽一张 `(method, path)` 集合逐条比对，进 `pnpm check`。
2. **SQLite 迁移账本语义**：见 §6。守卫：R0 的双向数据库测试 + `pnpm repo:check`。
3. **`armadra-hook` 命令面**：`<agentId>`（hook 模式，stdin 收 payload，**永远 exit 0**）、`context-usage`、`context <list|summary|transcript|terminal>`、`canvas <verb>`、`browser <17 个动词>`、`doctor`；flag 规则（`--flag value` / `--flag=value` / 裸 flag 为 true / 重复 flag 成数组 / `--flag=value` 是唯一能传 `-` 开头值的形式）与退出码不变。
4. **`hook-endpoint.env` 与 `endpoints.json`**：前者是 POSIX 可 source 的 `KEY='VALUE'`（单引号内 `'` 转义为 `'\''`），键为 `ARMADRA_HOOK_VERSION`（协议版本 1）、`ARMADRA_HOOK_PORT`（不监听 TCP 时省略）、`ARMADRA_HOOK_SOCK`、`ARMADRA_HOOK_TOKEN`、`ARMADRA_NODE_TOKEN_DIR`；后者是 `{ version: 1, runtime?, host? }`，每段 `{ instanceId, writtenAt, processId, http?, websocket?, socket?, pipe? }`，语义是**发现提示而非真相**（读失败/解析失败/未来版本一律当空文档，不阻塞启动，读者仍必须探测）。
5. **Agent 环境注入表**：只有 6 个变量（`terminal/mod.rs:484`）——`ARMADRA_NODE_ID`、`ARMADRA_AGENT_ID`、`ARMADRA_ENDPOINT_FILE`、`ARMADRA_CANVAS_CONTROL`、`ARMADRA_SESSION_ID`、`ARMADRA_SESSION_GENERATION`。**per-node token 绝不进环境变量**，只在 `<数据目录>/node-tokens/<nodeId>`（同用户的任意进程都能读 environ）。
6. **0600 / 0700 文件语义**：唯一原语是 `create_dir_all` → 目录 0700 → 写临时文件 `.{name}.tmp-{pid}` → **open 时即 0600** → 写 + `fsync` → `rename` → 再 chmod 一次。TS 的坑：`fs.writeFile(..., { mode })` **受 umask 影响**且不保证 open 时即 0600，必须 `fs.open(path, 'wx', 0o600)` + 写后 `chmod` 双保险；`O_NOFOLLOW` 要显式传 `fs.constants.O_NOFOLLOW`。覆盖 15 个点（`endpoints.json`、`hook-endpoint.env`、`hook-secret`、`node-tokens/`、`pending/`、unix socket、`models-catalog.json`、SQLite 快照、Armadra 自己的 `known_hosts`、`tmux.conf`、keychain 降级文件、outbox、worktree/rebase 临时文件、迁移导出、context-usage 缓存）。

另外：`docs/contracts/v3-agent-terminal-plan.md` 的 §N 被代码注释引用（§15.3 tmux 后端、§18 终端兼容、§19 用量胶囊、§25 环境与启动路径等），TS 文件继承对应注释与编号，**不重编号**。21 个 `WorkspaceEvent` 的 `type` 字符串逐字不变。

## 6. 数据库合一

两份库的表**基本不重叠**，合并是并集而不是对账：

| 来源                              | 表数 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas.db`（Runtime，14 个迁移） |   21 | `workspaces` `boards` `nodes` `edges` `terminal_sessions` `terminal_logs` `agent_status` `agent_approvals` `agent_mailbox` `agent_deliveries` `agent_prompt_deliveries` `agent_handoffs` `agent_handoff_outbox` `context_links` `hook_installs` `conversations` `browser_sessions` `host_imports` `write_ownership` + 2 张 legacy 归档                                                                                                                               |
| `host.db`（Host，schemaV1–V10）   |   36 | `store_meta` `identity_owner` `identity_devices` `identity_sessions` `identity_bootstrap_tickets` `maintenance_tokens` `command_roots` `command_sessions` `github_config` `github_references` `github_status_mappings` `automation_grants` `automation_payloads` `entities` `operations` `operation_changes` `events` `workspace_roots` `sessions` `session_runs` `session_claims` `agent_*`（7 张）`staging` `staging_ids` `write_ownership` `schema_migrations` 等 |

真正重名的只有五组：`agent_status` / `agent_approvals` / `agent_mailbox` / `agent_handoffs` / `agent_deliveries`（Host 侧是同一语义的第二份实现，合并时**只留一份**，取 Runtime 侧的列定义，Host 独有的列以新迁移加上）、`write_ownership`（删）、以及 `sessions` 与 `terminal_sessions`（Host 记意图、Runtime 记 PTY，合并为一张，Host 的 `session_runs` / `session_claims` 并入）。`entities` / `operations` / `operation_changes` 是 Host 的「通用实体 + 收据」间接层，只服务于跨进程的幂等与 revision——**合一后删除**，幂等键改由各域自己的表承担。

`apps/host/internal/migration/legacy/` 的 14 份 `.sql` 是 Runtime 迁移的**副本**，用于把旧 `canvas.db` 导入 staging；随所有权机制一起删，`migrations.lock` 从三处校验收敛为一处（`apps/runtime/migrations` → 迁移目录移到 `apps/desktop/src/core/db/migrations/`，`repo.rules.json` 的 `migrations.sources` 只剩一条）。

**账本语义保留**，由 TS 自己实现：`_sqlx_migrations` 表六列（`version` INTEGER 主键 / `description` / `installed_on` / `success` / `checksum` BLOB / `execution_time`），checksum 是该迁移 SQL 的 **SHA-384**（现状算法），列类型用 `typeof()` 自检。八条拒绝启动规则一条不少：无账本但 schema 非空、账本不是 table、账本列形状不对、有非账本对象却没有任何已记录迁移、某条 `success != 1`、版本本构建不认识、校验和不符、历史不是已知迁移的完整前缀。失败一律**回滚并关闭连接池**，不改名、不删除、不重建。preflight + migrate + 启动恢复（把非 `tmux`/`sessionHost` 的 `running` 会话标记为 `failed`/`exited`）在同一个 `BEGIN IMMEDIATE` 事务里。已发布迁移的字节永不改动；合并用的新迁移从 `0015` 起编号。

已装机器的升级路径：R1 的新迁移把 `host.db` 的内容读进统一库（一次性，带行数与引用核对，失败即中止且不动原库），之后 `host.db` 只保留为只读备份。

## 7. 分阶段

每阶段独立合入、独立回滚。并存期开关 `ARMADRA_CORE=rust|ts`（默认 `rust`，R6 改默认）：

- `rust` —— 壳拉 `armadra-runtime` 二进制 + 拉 `armadra-host`，与今天一致。
- `ts` —— 壳拉 `utilityProcess(out/core/main.js)`，**不拉 Host**；未实现的路由返回 501 并写明功能名，前端据此退化（画布与终端在 R2 之后就都在）。

回滚 = 开关切回，数据库不动（统一库对 Rust Runtime 而言是「多了几张不认识的表」——**这会触发它的拒绝启动规则**，所以 R1 的新迁移一旦应用就不能再回 Rust；R0 之前的阶段可以任意来回。这条写进 R1 的验收：切换前必须先做一次数据库备份，`设置 → 数据` 的一致性快照就是它）。

| 阶段   | 范围                                                                                                                                                                                    |  源行数（Rust/Go） | 移植测试 | 规模 | Agent |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------: | -------: | ---- | ----- |
| **R0** | core 进程骨架：`main`/`http`/`db`/`bus`/`platform`；`--listen` 三种 spec；`/health` + `/api/health`；`endpoints.json`；SQLite + 账本 preflight；0600 原语；路径收窄；`no-electron` 扫描 |  R 5,600 / G 1,700 |     ~120 | M    | 1     |
| **R1** | 画布 / 工作空间 / 设置 + **身份 / 设备 / 会话**；统一库迁移（吸收 `host.db`）；`core/bus` 的事件 WS                                                                                     | R 14,500 / G 8,300 |     ~300 | XL   | 3     |
| **R2** | 终端域：tmux / direct / sessionHost / ssh、重附着、输入序号、环境注入、GC                                                                                                               | R 10,500 / G 3,000 |     ~140 | XL   | 3     |
| **R3** | Hook 服务与 Agent 域 + `armadra-hook` TS 版                                                                                                                                             | R 23,000 / G 4,400 |     ~390 | XL   | 3     |
| **R4** | Git / 文件系统 / 导入导出 + **定时与事件**                                                                                                                                              | R 22,500 / G 7,100 |     ~250 | XL   | 4     |
| **R5** | 语言服务 / 资源 / 浏览器授权 / 用量 / **GitHub**                                                                                                                                        | R 28,500 / G 6,400 |     ~330 | XL   | 4     |
| **R6** | 服务器壳（浏览器 / 手机）+ Windows session-host                                                                                                                                         |  G 5,400 / R 4,221 |      ~90 | L    | 3     |
| **R7** | 删 Rust、删 Go、删 proto 与两份生成码、删 host-client；CI / 发布 / 文档收尾                                                                                                             |                  — |        — | M    | 2     |

移植测试合计约 1,620（Rust 1,222 可移植 + Go 709 中约 400 可移植；其余是协议契约测试与夹具，随删除项一起消失）。预估 TS core 产出 **65,000–85,000 行**（源 186,000 行里有 111,000 行是生成码与跨进程胶水）。

### R0 骨架

core 起得来；`--listen` 可重复，三种 spec（`tcp:IP:PORT` 端口 0 由内核分配、`unix:绝对路径` 0600、`pipe:名字`），指定 TCP 端口被占用直接报错不换端口；`/health` 与 `/api/health` 都在，`instanceId` 同时打到 stdout；`endpoints.json` 的 publish/withdraw；SQLite 打开 + §6 的账本校验；路径收窄（所有路径参数限制在工作区根内）；0600 原语；进程内事件总线与 WS 升级骨架；`CorePlatform` 两份实现；`no-electron` 扫描。其余路由 501。

**验收**：`ARMADRA_CORE=ts pnpm --filter @armadra/desktop dev` 壳能拉起它并通过 `/health` 的 `instanceId` 对账；`pnpm repo:check` 通过且 `migrations.lock` 不变；双向数据库测试（Rust 建的库 TS 能开、TS 建的库 Rust 能开，`_sqlx_migrations` 14 行逐字节相同）；八条拒绝启动规则各一个用例，且失败后原库字节不变。
**风险**：账本校验和算错（是 SHA-384 不是 SHA-256）；`node:sqlite` 的 BLOB 绑定与 `typeof()` 语义差异。第一条验收就会抓住。

### R1 画布 / 工作空间 / 设置 + 身份

**这一批删得最多**：Host 的 `identity`、`server/auth.go`、`localipc`、`canvashost`、`settingshost`、`storage/entities|operations`、`eventstream` 共约 8,300 行被吸收或删除；票据链在桌面路径上消失（§4.3）。

做：`PUT …/boards/{id}/document` 的整份文档 upsert + `expectedUpdatedAt` CAS（冲突 409）+ 8 MiB 白板快照上限 + **不解析** `whiteboard_json`（只看长度与摘要）+ 不认识的 `engine` / 更高 `version` 保留原文；`board.changed` 广播；资产内容寻址落 `.armadra/assets/<sha256 前 16 位>.<ext>`；`settings.json` 与 `worker-settings.json` 的合成/拆分（`GET /api/settings` 仍是一个对象，`GET /api/settings/local` 说哪些键属本机）；models.dev 目录缓存（24 小时 + 每天一次，联网只在 core 侧）；owner / 设备 / 配对 / 会话 / 撤销；事件总线的 durable sequence 与断线续订（游标低于保留下限 → `SNAPSHOT_REQUIRED`，高于水位 → `CURSOR_AHEAD`）；统一库迁移（0015 起）。

**验收**：`pnpm --filter @armadra/web test` 全绿（`apps/web/src/api/` 一行不改；`apps/web/src/host/` 的 64 个文件改打 `/api/`，这批改动在本阶段内完成）；文档保存 P95 < 20 ms（8 MiB 快照）；旧 `host.db` + 旧 `canvas.db` 的真实数据跑一次合并迁移，行数与引用逐项核对；切换前的数据库备份可用（`设置 → 数据` 的一致性快照，含已提交 WAL）。
**风险**：CAS 时间戳精度（RFC3339 的毫秒位数必须与现状一致，否则 `expectedUpdatedAt` 永不匹配）；同步 SQLite 在 8 MiB 保存上阻塞事件循环；合并迁移是单向门（见 §7 开头）。

### R2 终端域

四后端统一 `TerminalBackend` 契约（Create、List、Attach、Detach、Input、Paste、Resize、Capture、Signal、Terminate、GetForeground、GetCapabilities）；私有 tmux server（`<数据目录>/tmux.sock` + `tmux.conf`，0700 目录）、`armadra-<ws>-<key>-<gen>` 命名、generation 栅栏、`paste-buffer -p`、10 分钟回收扫描；输入序号与写入门；重附着（暖走 tmux 自己重绘，冷走回放日志）；环境注入（§5 的 6 个变量 + PATH 补齐：Homebrew、mise shims、mise Node 安装目录，契约 §25）；`input_idle` 弱提示——现有实现的 idle 判据用错时钟，本阶段一并修正并在契约里注明；GC 与启动恢复。

必须带进 TS 的硬约束：**spawn 预检**（调 node-pty 之前就拒绝，失败的 spawn 会泄 pty 设备）；tmux 控制模式的 **codec 与 I/O 分离** 且必须用 **latin1** 解码喂 decoder（tmux 只转义 `< 0x20` 和反斜杠，`>= 0x80` 原样过通道，utf8 解码会把跨 chunk 切开的字节变成不可恢复的 U+FFFD）；控制模式用 `-C` 而非 `-CC`（`-CC` 对 fifo 会 `tcgetattr failed`）；co-attach 下 pty 跑所有订阅者的最小 cols × rows；PTY 释放顺序 `resume()` → `destroy()` → `kill()`；粘贴时 bracketed-paste 包裹与 Enter 必须同一次写。

**验收**：87 个 Rust 终端用例逐条对应 vitest；新增真 tmux 集成测试覆盖建/附/断/重附/重启存活；`pnpm agent:smoke <core> <hook> claude` 断言 `working → done` 与 `stateSource`；30 个终端的画布性能不低于[画布性能基线](../status/canvas-performance-baseline.md)；**字节吞吐**基准：200 MB 连续输出的耗时与 Rust 版差 < 20%。
**风险**：两个 node-pty 原生补丁必须同时到位；node-pty 引入 `electron-rebuild` + `asarUnpack` + 公证下的原生模块签名（`electron-builder.yml` 现在的 `asarUnpack: []` 就是为这一天留的那行）——本阶段合入时就跑一次 `dist`，不留到 R7；吞吐（Rust 是零拷贝转发，Node 每帧多两次 Buffer 拷贝）。

### R3 Hook 服务与 Agent 域

回环 HTTP hook 服务（独立鉴权、独立 body 上限、优先 unix socket）；`hook-secret` 与 per-node token（`valid_node_id` 拒绝空 / `..` / 含分隔符 / 含空格 / >80 字符）；六家 CLI 的归一化与 reduce（`working` / `waiting` / `blocked` / `done` + `stateSource` 三档 `hook` / `extension` / `observed`）；审批（写 `<数据目录>/pending/`，hook 客户端阻塞读）；mailbox（`post` / `inbox` / `ack`，幂等发送、确认、过期）；handoff 与 outbox；`context-link` 四动词与 `control` 十二动词；安装单元（Hook + 技能一次装/卸/修，`INTEGRATION_REVISION`）与旧残留修复（识别旧产品名的 hook 条目、旧技能目录、Codex `hooks.json` 顶层 `version`、全局 AGENTS.md/CLAUDE.md 里的标记块；备份为 `<file>.armadra-backup-<时间戳>`）。Host 的 `agenthost/`（4,380 行）与 Runtime 的 `hook/` + `collab/` 在这里**合并为一份实现**。

**`armadra-hook` 的 TS 版形态**：不是 node 脚本、不是 SEA 可执行，而是**安装时生成的 POSIX sh + curl shim**。四选一的实测比较：

| 方案                                        | 每个 hook 事件的启动延迟 | 依赖                               | Windows                                                        | 体积      | 结论     |
| ------------------------------------------- | ------------------------ | ---------------------------------- | -------------------------------------------------------------- | --------- | -------- |
| 现状 Rust 小二进制                          | ~3 ms                    | 无                                 | 原生                                                           | ~1.5 MB   | 基准     |
| 单文件 node 脚本 + 系统 node                | ~35–60 ms                | 目标机必须有 node；远端 SSH 不保证 | 有 node 就行                                                   | 几十 KB   | 否决     |
| `node --experimental-sea` / `bun --compile` | ~30 ms                   | 无                                 | 原生                                                           | 50–110 MB | 否决     |
| **生成式 sh + curl shim**                   | **~5–8 ms**              | sh + curl（macOS/Linux 自带）      | Git Bash 的 sh + 自带 `curl.exe`；无 Git Bash 时用 `.cmd` 变体 | ~6 KB     | **采用** |

shim 的三条硬约束：**凭据不上 argv**（header 经 `curl --config -` 从 stdin 喂，因为 `ps` 与 `/proc/<pid>/cmdline` 全局可读）；**payload 不上 argv**（`--data-urlencode "payload@<file>"`，避开 `execve` 的 E2BIG）；**退出前排空 stdin**（非 Armadra 会话直接退出会让 CLI 写 payload 时 EPIPE）。现状已有而必须保留的两条：每次调用重读端点文件（tmux 会话活得比 core 久，下一个 core 可能换端口）；端点文件里不放 node 身份。`HOOK_CLIENT_REVISION` 与 `INTEGRATION_REVISION` 各加一版，修复器多认一种旧形态（旧的二进制路径）。

**验收**：`pnpm agent:smoke` 六家各跑一遍；`pnpm handoff:read-smoke`；hook 事件端到端延迟 P95 < 15 ms；安装只增自己的文件、卸载只删自己的文件、其余字节不变。
**风险**：sh shim 在 Git Bash / MSYS 下的路径转换（sh 是 POSIX 而 curl 是原生 Windows 二进制）；Codex 0.153+ 的 `trusted_hash` 本就未解决（[Agent 接入统一管理](./agent-integration.md) §8.3），重写不引入也不解决，原样带过去。

### R4 Git / 文件系统 / 导入导出 + 定时与事件

Git 读的两级（逐检出带 `path` 的 13 条 + 工作空间级不带 `path` 的 3 条：合并提交图 `POST …/git/log`、全检出分支树 `GET …/git/refs`、署名 `GET …/git/identity`）；写全部经仓库队列串行；hunks、stash、rebase、worktree、clone 任务；AI 提交信息（读本机凭据）。文件读写 / 版本 / 搜索 / 索引 / 监听 / 回收站 / 上传下载 / 导入导出。定时与自动化（once / interval / cron / loop 四种、时区、错过窗口策略、激活条件、运行记录与收据）吸收 Host 的 `automation` + `automationhost`。事件总线在 R1 已建，本阶段把 `resource.sample` 之外的所有业务事件接上。

**验收**：82 个 Rust git 用例 + `apps/runtime/tests/git_repository_merge/`（cherry_pick 345 行、revert 275 行）对应的集成测试；Go 的 automation 用例（43 个）对应 vitest；`pnpm --filter @armadra/web test` 的 Git 工具窗口与自动化面板用例；导入导出对真实数据跑一次往返核验（原 `canvas:e2e` 里被保留的那部分断言）。
**风险**：`git` 子进程输出解析的 locale 与换行差异；`Replaced` 判定在远端（轮询）仍只能报 `modified`，与现状一致；cron 的时区语义与 Go 实现逐条对照。

### R5 语言服务 / 资源 / 浏览器 / 用量 / GitHub

LSP 发现与 mux（多客户端复用一个 server）、会话流 WS；主机与会话资源采样、电源租约（未知就显示未知）；浏览器授权与租约（`browser:drive` 的 core 侧：出站 WS 拨壳、17 个动词、`LEASE_HELD_BY_HUMAN` / `LEASE_REVOKED` / `STALE_TARGET` / `DIALOG_PENDING` 四个稳定错误码）；用量（供应商额度窗口、成本扫描、定价三级回退、Copilot 登录）；GitHub（客户端、缓存、凭据、Issue/PR 与节点映射、检查与评审）；远端 SSH 执行（`ssh -o BatchMode=yes … `，握手要求版本完全一致、3 次重连 250ms/1s/4s 后停 30 秒、单连接互斥兼作该主机的 Git 队列、已写出后失联返回 `UNKNOWN_OUTCOME`、只有只读操作在重建连接后重放）。

**验收**：前端语言 / 资源 / 浏览器 / GitHub 面板用例；`POST /api/ssh/hosts/{id}/worker/test` 对真远端回报平台、架构与版本；GitHub 的 Go 用例（`githubapi` 17 + `githubhost` 19 + `githubcred` 11）对应 vitest。
**风险**：`vscode-jsonrpc` 的 cancel/progress 语义与自写 mux 的差异；资源采样数字与现状不一致（逐平台对照一次，差异写进文档而不是悄悄改）；远端执行的 TS 版本需要目标机有 Node——**这是相对 Rust 版的能力退化**，本阶段的决定是：远端 core 以打包的单文件 JS + 目标机的 node 运行，探测不到 node 时明确报 `UNSUPPORTED` 并说明，不静默降级。

### R6 服务器壳 + Windows session-host

`apps/server`：`node:http(s)` + `ws` + 托管 `apps/web` 产物（整棵树经 `os.Root` 式的根限定打开，符号链接无法指向包外）+ 单 owner 认证（配对码一次性短期有效、绑定 Host 指纹、确认设备名后颁发可撤销凭据；会话轮转、CSRF、Origin 校验；设备 token 不放 URL；二维码只含短期配对材料）+ `install | uninstall | status | logs | upgrade | version`（「只生成 launchd / systemd / `sc.exe` 定义，绝不调用 launchctl / systemctl / sc.exe」「必须显式 `--service-dir` 与 `--run-as`，拒绝特权账号」「定义不含凭据，`--env` 拒绝 TOKEN/SECRET/PASSWORD/CREDENTIAL 一类名字」「升级先校验候选、`--confirm` 前只打印计划、旁写改名替换、失败回滚」四条规则不变）。

`crates/session-host` → `apps/desktop/src/session-host/`：node-pty 的 conpty 后端 + 独立守护进程，**只接受一个 argv（`userDataDir`），其余全部派生**（命令行不出现敏感信息）；esbuild 打成 `out/session-host/host.cjs`，`--external:node-pty`；以 `ELECTRON_RUN_AS_NODE=1` 拉起同一个 Electron 二进制（打包机器不保证有系统 node）。管道名派生（`\\.\pipe\armadra-session-<sid>-<hash>-v<major>`）、受保护 DACL、每条连接核对客户端 SID、`first_pipe_instance` 兼作并发闸、Job Object 的 `KILL_ON_JOB_CLOSE`、generation 栅栏、有界回放（最近 200 KiB，截断点避开 UTF-8 与转义序列中间）全部保留。ConPTY 的关闭必须拿到「确实关掉了这一个 HPCON」的阳性证明，拿不到就显式报错而不是假设成功。

**远程浏览器节点（2026-09-20 追加，用户决定）**：服务器壳上没有 `<webview>`，浏览器节点按壳分两套后端——桌面壳 `<webview>`（已做）；服务器壳 `core/browser/headless/`：headless Chromium（系统 Chromium 或按需下载）+ CDP `Page.startScreencast`（WebP/JPEG，单观看者、无扇出）+ `Input.*` 回传，租约/授权/17 个动词面复用 `core/browser` 已有的裁决，前端 `WebviewSurface` 之外恢复一个只服务远程的 `StreamSurface`（画到 `<canvas>`，输入映射）。体验预期是远程桌面级（100–200 ms、无原生选字与输入法精细行为），只在服务器壳启用。规模 +L、+1 Agent。

**账号与共享的预留**：本阶段的认证按 [服务器账号、中转与共享](server-accounts-and-sharing.md) 的模型实现（多 principal、口令 + passkey、邀请、组与授予编译成 scope）；其中 §4 的五处预留在 R6 之前落地。

**验收**：手机浏览器完成一次配对 → 看同一块画布 → 输入终端 → 答一次审批；撤销设备后流立即终止；真 Windows 机上跑通建 / 附 / 断 / 重附 / 重启（这是首次真机验证——现有 Rust 实现的 Windows 行为至今一次真机都没跑过）。
**风险**：服务器壳的认证是**从零实现**（见 §9）；Windows 全链路首次真机。

### R7 收尾

默认 `ARMADRA_CORE=ts`；删 4 个 crate、`Cargo.toml` / `Cargo.lock`、`apps/host`、`go.mod` / `go.sum`、`proto/`、`packages/protocol`、`packages/host-client`、`tools/protocol.mjs`；`repo.rules.json` 去掉 `crates` 根白名单与命名规则、`fileSize.extensions` 去 `.rs` / `.go`、删 `proto` 段、`migrations.sources` 收敛为一条；`package.json` 删 `protocol:*` / `rust:fmt` / `check:rust`；CI 删 Rust 与 Go 矩阵；`stage-binaries.mjs` 不再拷 Rust / Go 产物；`armadra.sh` 删对应分支；文档收尾（架构、开发指南、CI 与发布、Host 相关设计文档移入 `history/`）。

**验收**：`pnpm check`、`pnpm test`、`pnpm repo:check` 全绿；三平台 `dist` 出包且原生模块签名 / 公证通过；仓库里不再有 `.rs` / `.go` / `.proto`。

## 8. 并行策略

| 可并行                              | 条件                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| R0 之后：R1 / R2 两条线             | R1 拿 `/api/workspaces` 的 board / asset / settings 14 条与身份面，R2 拿 terminals 10 条 + sessions 1 条；DB 表不重叠 |
| R1 之后：R3 / R4 / R5 三条线        | R3 依赖 R1（节点表）与 R2（会话绑定）；R4 拿 git 35 条 + file\* 12 条；R5 的五个子域彼此独立，可再拆                  |
| R6 的服务器壳与 session-host 可并行 | 前者只依赖 `core/http` 与 `core/identity`（R1 已定稿），后者只依赖 R2 的 `TerminalBackend` 契约                       |

**需要预分配**：路由前缀（按上表写进每个阶段的交接）；DB 表所有权（统一库的表按域分配，跨域读走对方模块的导出函数，不直接写别人的表）；迁移编号（`0015` 起，每条线开工前先认领一个号，避免撞号）。**`worker.proto` 字段号不需要预分配**——它要被删掉。

**worktree 约定**：每条线一个 worktree，基线统一为上一阶段的合入点；并存期各自设 `CARGO_TARGET_DIR`。

## 9. 风险

| 风险                                           | 影响                                                                                                                                                                                                                                                                                                                                                                      | 应对                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **放弃 Host 迁移已做的一半**                   | 已交付并验证的画布所有权切换（Host 侧画布存储、revision 实体、操作收据、事件 outbox、`OwnershipService`、`armadra-host ownership switch\|rollback\|status`、维护窗口令牌、反向导出与重新导入、`canvas:e2e` / `ownership:e2e`）整体作废；`canvashost` 2,778 + `ownership` 850 + `migration` 952 + `cmd/.../ownership.go` 356 + Rust `ownership/` 6,440 ≈ 11,400 行直接删除 | 这是本次方向变更的**已知成本**，不是可缓解项。留下的资产是设计上的：五步切换里的「逐项核验」清单（ID、位置尺寸、Frame 嵌套、上下文链接、白板摘要、标注、资产哈希）在 R1 的合并迁移里原样复用；`host.db` → 统一库的迁移是同一类工作的第二次，第一次的核验代码可以直译                                                                         |
| **服务器壳的认证从零实现**                     | 配对、会话轮转、CSRF、Origin、撤销任何一条写错就是远程未授权访问                                                                                                                                                                                                                                                                                                          | R6 之前服务器壳不发布；认证逻辑放 `core/identity` 且**与桌面路径共用同一套会话校验**（桌面只是多一条「壳注入的凭据」入口），不写第二套；配对与撤销各配一组端到端用例（含「撤销后流立即终止」「配对码不可复用」「token 不出现在 URL」）；默认不监听非回环地址，开启对外服务是显式动作                                                         |
| **单进程里终端字节流与 HTTP 调度共用事件循环** | 高流量 TUI 期间画布保存与 Hook 事件延迟                                                                                                                                                                                                                                                                                                                                   | 终端字节走独立路径：node-pty 的 `onData` → `ws.send(Buffer, {binary:true})`，**不经 JSON、不经 SQLite**；回放日志是追加写文件。R2 的验收同时量两件事：200 MB 输出期间的吞吐差 < 20%，**以及**同期 `/health` 与文档保存的 P95 不劣化 50%。超标就把终端后端整体搬进 `worker_threads`（`TerminalBackend` 契约本来就是消息式的，搬迁不改调用方） |
| 终端字节吞吐（Rust → Node）                    | TUI 掉帧                                                                                                                                                                                                                                                                                                                                                                  | 同上；帧用 Buffer 直传不转字符串；`ws` 关掉 `perMessageDeflate`                                                                                                                                                                                                                                                                              |
| 同步 SQLite 阻塞事件循环                       | 8 MiB 文档保存期间 HTTP 全停                                                                                                                                                                                                                                                                                                                                              | R1 验收量 P95；超阈值把 `documents` 搬 `worker_threads`；WAL 保持开                                                                                                                                                                                                                                                                          |
| node-pty 的两个原生补丁                        | 不打补丁 macOS 数小时后 spawn 全挂、Windows conhost 泄漏                                                                                                                                                                                                                                                                                                                  | 补丁脚本进 `postinstall`，幂等、anchor 缺失即非零退出；配守卫测试只断言 marker 在（不测 fd 数，环境相关）                                                                                                                                                                                                                                    |
| 原生模块与签名 / 公证                          | 打包后 PTY 起不来或公证被拒                                                                                                                                                                                                                                                                                                                                               | `electron-rebuild -f -w node-pty` + `asarUnpack: ["node_modules/node-pty/**"]`；R2 合入时就跑一次 `dist`                                                                                                                                                                                                                                     |
| 迁移账本与合并迁移                             | 打不开已装机的库，或合并后回不去                                                                                                                                                                                                                                                                                                                                          | R0 的双向测试是第一条验收；R1 的合并迁移是单向门，切换前强制一次一致性备份，并在设置页显式提示                                                                                                                                                                                                                                               |
| 双实现漂移                                     | 并存期两边行为不一致                                                                                                                                                                                                                                                                                                                                                      | `tools/route-parity.mjs` 进 `pnpm check`；每阶段合入前跑对方实现的同一套 smoke                                                                                                                                                                                                                                                               |
| 远端执行需要目标机有 Node                      | 相对 Rust 版的能力退化                                                                                                                                                                                                                                                                                                                                                    | 明确报 `UNSUPPORTED` 并说明，不静默降级；远端 core 打成单文件 JS                                                                                                                                                                                                                                                                             |
| sh shim 在 Windows                             | 没有 Git Bash 的机器 hook 全哑                                                                                                                                                                                                                                                                                                                                            | `.cmd` + `curl.exe` 变体；`doctor` 明确报告走的是哪条路径                                                                                                                                                                                                                                                                                    |
| 测试总量                                       | 约 1,620 个用例的直译是最大体力活                                                                                                                                                                                                                                                                                                                                         | 纯逻辑（约 950）直译 vitest；需真子进程的（约 430）走 `*.integration.test.ts`，CI 按可用性 skip；其余随删除项消失                                                                                                                                                                                                                            |

## 10. 建议的起手

**R0 之后先做 R2 的一个纵切**，不要按编号顺序把最容易的先做完：用一个「只有 tmux 后端、只有建 / 附 / 输入 / 断」的最小终端打通 node-pty + 两个补丁 + `electron-rebuild` + `asarUnpack` + 一次真 `dist`，并同时量字节吞吐与同期 HTTP 延迟。理由是整个方案里唯一**可能被证伪**的三件事都在这里——吞吐、单事件循环的相互干扰、原生模块打包——而 R1 的 CRUD 与身份无论如何都写得出来。纵切通过后再按 §8 的三线并行。

## 附录 A：盘点

全部实测于 `359058afd`。

### A.1 Rust Runtime

```sh
find apps/runtime -name '*.rs' | xargs wc -l | tail -1       # 135530
find apps/runtime/src -name '*.rs' | xargs wc -l | tail -1   # 120154
find apps/runtime/tests -name '*.rs' | xargs wc -l | tail -1 # 15272
find crates -name '*.rs' | xargs wc -l | tail -1             # 12855
```

| 模块                                                                     |   行数 | 文件 | 职责                                                                                   | 测试 |
| ------------------------------------------------------------------------ | -----: | ---: | -------------------------------------------------------------------------------------- | ---: |
| `git/`                                                                   | 16,957 |   50 | 发现、命令、仓库操作队列、hunks、提交信息                                              |   82 |
| `hook/`                                                                  | 12,099 |   31 | 端点、鉴权、归一化、reduce、安装与修复                                                 |  172 |
| `terminal/`                                                              |  9,933 |   29 | tmux / direct / sessionHost / ssh、GC                                                  |   87 |
| `api/`                                                                   |  8,099 |   39 | handler（路由注册全在 `lib.rs`）                                                       |   53 |
| `worker/`                                                                |  7,675 |   23 | Host↔Worker 帧、serve_commands、远端投影                                              |   33 |
| `language/`                                                              |  7,122 |   24 | LSP 发现、mux、会话流                                                                  |   62 |
| `collab/`                                                                |  6,631 |   24 | context-link / control 动词、mailbox                                                   |   53 |
| `ownership/`                                                             |  6,440 |   21 | 所有权记录、导出导入、epoch 下发                                                       |   34 |
| `remote/`                                                                |  5,670 |   25 | 远端 Worker 客户端与服务端                                                             |   38 |
| `db/`                                                                    |  4,705 |   23 | 连接、账本 preflight、每表一模块                                                       |   37 |
| `usage/`                                                                 |  4,469 |    9 | 额度窗口、成本扫描、定价                                                               |   68 |
| `browser/`                                                               |  4,327 |   18 | 会话、策略、租约、驱动                                                                 |   44 |
| `resources/`                                                             |  4,298 |   15 | 主机 / 会话采样、电源租约                                                              |   24 |
| `command/` `handoff/` `settings/` `migration_export/` `models/` `index/` |  9,650 |   44 | 命令会话、交接、偏好、导出、模型目录、索引                                             |   76 |
| 顶层 26 个 `.rs`                                                         | 12,079 |   26 | `main` `lib` `automation` `files` `file_*` `context_*` `agent*` `security` `listen` 等 | ~141 |

外部进程依赖：`tmux`、`ssh`、`git`、各家 CLI、LSP server（按语言探测）。Chrome / CDP 已随 Electron 迁移删除。无直接 npm 等价物的 Cargo 依赖只有四个：`portable-pty`、`sqlx`、`notify`、`sysinfo`（应对见 §3）。`tree-sitter` **不在依赖里**。

### A.2 Go Host

```sh
find apps/host -name '*.go' | xargs wc -l | tail -1                                      # 143754
find apps/host/gen -name '*.go' | xargs wc -l | tail -1                                  # 59746
find apps/host -name '*.go' -not -path '*/gen/*' -not -name '*_test.go' | xargs wc -l | tail -1  # 51304
find apps/host -name '*_test.go' -not -path '*/gen/*' | xargs wc -l | tail -1            # 32704
grep -rn '^func Test' apps/host --include='*_test.go' | grep -v /gen/ | wc -l            # 709
```

非生成非测试 51,304 行 / 28 个 `internal` 包 + `cmd` 3,635 行；测试 32,704 行 / 709 个 `func Test`；生成码 59,746 行（含 63 个契约测试）。

按包的行数、职责与去处见 §4.1。HTTP 面不是 `HandleFunc` 注册，而是 12 个 `/rpc/armadra.v1.<Service>/` 前缀 + 前缀内的方法名分发，共 **119 个方法**：GithubService 25、AgentService 19、CanvasService 11、GitService 11、AutomationService 10、SessionService 10、IdentityService 10、SettingsService 9、FilesystemService 6、OwnershipService 4、UpdateService 4；另有 `HostService/Hello`、`/health`、`RuntimePrefix = "/api/"` 的代理、托管前端与 WSS 事件流。PresenceService 与 AccountService 是预留前缀，一律 501。

### A.3 数据库

Runtime：14 个迁移（`0001_initial` … `0014_retire_gemini`，575 行 SQL）、21 次 `CREATE TABLE`。Host：`internal/storage/schema.go` 813 行、`schemaV1`–`schemaV10`、36 次 `CREATE TABLE`。`apps/host/internal/migration/legacy/` 是 Runtime 那 14 份迁移的**逐字节副本**（导入旧库用）。`migrations.lock` 当前校验三处（两个目录 + `schema.go` 的 `schemaVN` 常量）。表清单与合并方案见 §6。

### A.4 协议

`proto/armadra/v1/` 22 个 `.proto` 共 6,925 行（`worker.proto` 426、`worker_channel.proto` 206）；`proto/fixtures/` 191 个夹具；三端生成码：Go 59,746 行（在仓库里）、TS 27,310 行（在仓库里）、Rust 由 `build.rs` + `prost-build` 在 `OUT_DIR` 生成（`crates/protocol/src` 只有 19 行，其余 5,374 行是 91 个契约测试与 `build.rs`）。契约测试：Rust 91、TS（`packages/protocol/test`）、Go 63。全部随 §4.2 删除。

### A.5 `crates/hook`（3,241 行）与 `crates/session-host`（4,221 行）

hook：`hook.rs` 549、`endpoint.rs` 542、`http.rs` 506（手写 HTTP/1.1 客户端）、`control.rs` 421、`context_usage.rs` 255、`lib.rs` 200（USAGE 文本）、`doctor.rs` 125、`main.rs` 40；65 个测试。`BROWSER_VERBS` 17 个（navigate / read / click / type / wait / capture / select / press / scroll / upload / download / back / forward / close / tabs / dialog / lease）、`CONTEXT_VERBS` 4 个、canvas 动词 12 个。

session-host：`protocol.rs` 689、`session.rs` 614、`host/requests.rs` 471、`link.rs` 425、`replay.rs` 386、`conpty.rs` 297、`host/mod.rs` 289、`winsec.rs` 287、`client.rs` 227、`pipe.rs` 200、`host/connections.rs` 194、`main.rs` 88、`lib.rs` 54；43 个测试（平台无关部分在任何平台可跑）。

### A.6 测试资产

```sh
grep -rn '#\[tokio::test\]\|#\[test\]' apps/runtime/src apps/runtime/tests | wc -l  # 1164
```

Rust 1,363（runtime 1,164 + hook 65 + protocol 91 + session-host 43），Go 709（非生成）+ 63（生成）。按性质：纯逻辑约 950（直译 vitest）、需真子进程约 430（tmux / ssh / git / node，走 `*.integration.test.ts`，CI 按可用性 skip）、协议契约 154（随 proto 删除）、纯夹具 141（`ARMADRA_TEST_*` 驱动，不移植）、跨进程对账约 400（Host↔Worker、所有权切换，随机制删除）。

### A.7 前端契约面

```sh
grep -rn '\.route(' apps/runtime/src --include='*.rs' | grep -v tests | wc -l  # 163
```

163 条路由：`/api/workspaces` 84（git 35、language 6、resources 5、handoffs 4、file-entries 4、boards 3、assets 3、imports 2、根 5、其余单条 17）、`/automation` 10、`/api/terminals` 10、`/api/usage` 9、`/api/ssh` 8、`/api/agents` 6、`/api/execution-hosts` 5、`/api/data` 5、`/api/power` 4、`/api/agent-status` 3、`/api/settings` 2、`/api/ownership` 2、`/api/models` 2、`/api/git` 2、`/api/conversations` 2、健康检查 2、其余单条 8（`/api/control/confirm/*`、`/api/approvals/*`、`/hook/{agentId}`、`/control/{verb}`、`/context-link/{verb}`、`/browser/{verb}`、`/verify`）。方法处理器 184 个。

前端：`apps/web/src/api/` 20 个非测试文件、155 处路由字面量（最大 `git-repository.ts` 23、`settings.ts` 16、`git.ts` 16、`agents.ts` 16、`files.ts` 14）；`apps/web/src/host/` + `canvas-ownership/` 4,735 行、64 个文件引用 `@armadra/host-client`、21 个引用 `@armadra/protocol`——这批在 R1 改打 `/api/`。`packages/shared/src` 43 个非测试文件 6,264 行、347 个 `*Schema` 导出、290 次 `z.object(`——合一后这批 zod schema **双向**可用（core 的入站校验也用它），手工同步成本归零。

21 个 `WorkspaceEvent`：`agent.{context,status,subagent,approval,delivery}`、`browser.{session,download,lease,tabs,dialog,fileChooser,activity}`、`language.{session,server}`、`terminal.exit`、`board.changed`、`ssh.prompt`、`workspace.updated`、`control.confirm`、`resource.sample`、`file.changed`。

### A.8 运行时环境

```sh
ELECTRON_RUN_AS_NODE=1 <electron> -e "console.log(process.versions.node, typeof require('node:sqlite'))"
# Electron 43.4.0 → 24.18.1 object
```

仓库钉 `electron 42.11.6`（`apps/desktop/package.json`），本机只装到 43.4.0，实测其 Node 为 24.18.1 且 `node:sqlite` 可用；Electron 42 的 Node 同为 24.x，**确切小版本在 R0 的第一件事里复核**。根 `package.json` 的 `engines.node >= 22`，`packageManager` 为 pnpm 11.18.0。

### A.9 规模对照

| 项                               |    现状行数 | 去向                                                             |
| -------------------------------- | ----------: | ---------------------------------------------------------------- |
| Rust（runtime + 3 个 crate）     |     148,385 | 重写为 TS，其中 protocol 5,393 直接删                            |
| Go（非生成，含测试）             |      84,008 | 重写为 TS，其中 worker/ownership/migration/proxy 约 6,000 直接删 |
| Go 生成码                        |      59,746 | 删                                                               |
| TS 生成码（`packages/protocol`） |      27,310 | 删                                                               |
| `packages/host-client`           |       8,033 | 删                                                               |
| **合计源码**                     | **327,482** | 预估 TS core 产出 65,000–85,000 行                               |
