# 开发指南

## 环境

Node.js ≥ 22、pnpm（版本锁定于根 `package.json`）、Rust stable / edition 2024。
Go Host 与桌面构建需要 Go ≥ 1.24。tmux 是推荐终端后端，缺失时退回直连 PTY。
macOS 桌面目标 ≥ 13.3，并需 Xcode Command Line Tools。

```sh
pnpm install
./armadra.sh doctor
./armadra.sh run web       # Runtime + Web，退出时一起关闭
./armadra.sh run desktop   # 桌面持有 Runtime，另行准备 Go Host
```

`doctor` 检查 Node / pnpm / Rust / tmux / Xcode CLT；Go 由 Host 构建脚本检查。

## 分步启动

以下各进程在独立终端运行：

```sh
cargo run -p armadra-runtime                          # 127.0.0.1:43120（兼容默认）
cargo run -p armadra-runtime -- --listen tcp:127.0.0.1:0   # 端口由内核分配
pnpm --filter @armadra/web dev      # 127.0.0.1:1420
# 或用桌面壳替代 Web 命令（仍需上面的外部 Runtime）
pnpm --filter @armadra/desktop dev
```

## 监听方式与地址发现

Runtime 的 `--listen` 可重复，每次一个：`tcp:IP:PORT`（端口 `0` 由内核分配）、
`unix:绝对路径`（0600）、`pipe:名字`（Windows 命名管道）。不给 `--listen` 时按
`ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT`，再退回 `127.0.0.1:43120`。
指定的 TCP 端口被占用直接报错，不换端口。

绑定成功后地址写入 `<数据目录>/endpoints.json`（0600），`runtime` 与 `host` 各一段，
含地址、instance id、pid 与写入时间；正常退出时撤回自己那段。
`./armadra.sh run web` 与 Vite 开发代理都从这个文件读地址，`VITE_RUNTIME_URL` 显式覆盖时不装代理。

打包后的桌面壳自己不监听端口：它以 `--listen unix:<数据目录>/runtime.sock`（Windows 为命名管道）
启动 Runtime。WebView 的 HTTP 走 `armadra://` 自定义协议转发到该 socket；
WebSocket 无法经自定义协议传输，由壳在 `127.0.0.1` 的随机端口上做回环转发，端口登记在 `endpoints.json`，
页面通过 `armadra://localhost/__armadra/transport` 取得。Go Host 则以 `--listen 127.0.0.1:43121`
加原生来源的 `--allow-origin` 启动：页面经壳的私有控制通道取票、再向这个回环端口换取 Bearer 会话
（[桌面壳原生 Host 会话](../design/host-native-session.md)）。因此 `lsof -i -P | grep -i Armadra` 在
「对外服务未开启」时会看到回环转发端口与 Host 的 43121。

桌面包与 `./armadra.sh run desktop` 会持有自己的 Runtime；后者额外用 `ARMADRA_RUNTIME_LISTEN`
加一个回环端口，因为开发页面在 `http://127.0.0.1:1420`，那里用不了自定义协议。直接执行桌面 `dev` 默认连接外部 Runtime。
Command W / 关闭窗口隐藏前台；Command Q / 托盘退出停止配置的 Host、桌面持有的 Runtime 及受管会话。
独立启动的 Runtime 由启动它的终端管理。详见[桌面说明](../../apps/desktop/README.md)。

## 检查与打包

从仓库根执行，按改动涉及的模块选择：

| 范围                | 命令                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| 仓库规则            | `pnpm repo:check`（秒级）、`pnpm repo:test`                                                 |
| 一次过静态检查      | `pnpm check`＝libs 构建 + format:check + rust:fmt + typecheck + protocol:check + repo:check |
| 前端                | `pnpm --filter @armadra/web test`、`pnpm --filter @armadra/web typecheck`                   |
| 共享模型            | `pnpm --filter @armadra/shared test`                                                        |
| Runtime             | `cargo test -p armadra-runtime`                                                             |
| Go Host             | `go -C apps/host test ./...`、`go -C apps/host vet ./...`                                   |
| 桌面脚本            | `pnpm --filter @armadra/desktop test`                                                       |
| 协议                | `pnpm protocol:check`、`pnpm protocol:test`                                                 |
| 全部 JS 包 / Rust   | `pnpm test`、`cargo test --workspace`                                                       |
| 格式 / 类型         | `pnpm format:check`、`pnpm typecheck`                                                       |
| Rust workspace 检查 | `pnpm check:rust`（先准备 sidecar）                                                         |
| 桌面打包            | `pnpm --filter @armadra/desktop build`                                                      |

`pnpm canvas:e2e` 端到端验证画布写入所有权：在临时目录里跑真实 Runtime 与 Host，写入嵌套 Frame、终端与便签、
标注、上下文连线和白板快照，再走导出 → 导入 → `ownership switch`，逐项断言迁移前后的 sha256、Runtime 的
`ownership_moved` 拒绝与只读回退、Host 侧的 revision 与事件，最后回滚：Host 写出格式 2 的反向导出包，
Runtime 把它导入自己的 `canvas.db` 并回读逐项核验，再断言 Host 持有期间的那次写入出现在 Runtime 的行里。
之后再用同一套状态机走一遍 HTTPS：Host 在跑，操作者用 `armadra-host ownership window --domain canvas`
在本机控制通道上取一次性维护窗口令牌，客户端经 `OwnershipService` 切换与回滚，并断言令牌不能复用。
它构建 Host、Runtime、工作区包与 Web 产物，并用无头 Chrome 驱动 `@armadra/host-client`；没有 Chrome 时设
`CANVAS_E2E_SKIP_APP=1` 跳过浏览器部分（改从 Node 走同一 TLS 代理），或用 `CHROME_PATH` 指定浏览器，脚本不下载任何东西。
构建缓存命中时整轮约 20 秒，跳过浏览器部分约 15 秒；首次构建 Runtime 与 Web 产物另计。

`pnpm agent:smoke <runtime 绝对路径> <hook 绝对路径> <pi|omp|copilot|opencode>` 用真实 CLI 验证状态通道：
临时数据目录起 Runtime（端口由内核分配），装适配、建 Agent 节点、跑一个回合，经工作空间事件 socket 断言节点依次出现
`working → done`、`stateSource` 与该适配的通道一致（命令 Hook 为 `hook`，进程内扩展为 `extension`）且会话列表带同一个值，
Pi / OMP 另外断言 `context-usage` 返回 `provider_hook / reported`，安装只增自己的文件、卸载只删自己的文件，其余字节不变。
两个路径参数要给绝对路径：它们会写进 CLI 的配置文件，而 CLI 从自己的工作目录解析。
CLI 不在 PATH 或起不来时打印原因并以 0 退出。真实凭据不动用户配置：脚本给 Runtime 一个临时 `HOME`
（`COPILOT_HOME` 等变量不在终端子进程的继承白名单里，只有 `HOME` 两边一致），把该 CLI 的凭据与模型设置
**复制**进去，macOS 另把 `~/Library/Keychains` 软链过去供 `security` 读取；失败时保留临时目录并打印路径。
`pnpm handoff:read-smoke <runtime> <hook> [source] [target]` 走交接的读取与确认，默认 `claude`→`codex`，
可换成任意两个声明了 `hooks` 的 Agent。

`armadra.sh check` 执行 shared 构建、TS 检查、Rust fmt / clippy；`test` 执行 shared、web 与 Rust workspace 测试。
它们不替代独立的 Go、协议与桌面脚本检查。`all` 执行 doctor → install → check → build → run。

`pnpm repo:check` 读 `repo.rules.json` 校验仓库结构：文档登记与相对链接、黑名单文件、包名与目录名、
根目录白名单、源码行数上限（超限文件登记在豁免表）、迁移编号与 `migrations.lock` 里的 sha256、
每个 `.proto` 的 fixture 与三端契约测试引用。规则说明见[仓库结构与校验](../design/repository-structure.md)。
仓库级脚本都在 `tools/`，各 app 自己的脚本仍在各自的 `scripts/`。

打包会构建 Runtime、Hook 和 Go Host，再按 target triple 暂存 sidecar。
目标、缓存与交叉构建规则见[桌面构建说明](../../apps/desktop/README.md)。

### 更新签名

桌面包的更新验签用一对 minisign 密钥：私钥签 updater 包，公钥内嵌进壳，
壳只接受由内嵌公钥签出的清单（[发布、更新与服务安装 §2.5](../design/updates-and-service-install.md#25-引入步骤一次性)）。
仓库里**没有**真实密钥，`plugins.updater.pubkey` 是空串。

生成与注入：

```sh
pnpm --filter @armadra/desktop exec tauri signer generate -w "$TMPDIR/armadra.key"
# 公钥（.key.pub 的内容）填进 apps/desktop/src-tauri/tauri.conf.json 的 plugins.updater.pubkey，可入库
# 私钥与口令只进 GitHub secret：TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TMPDIR/armadra.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=…   # 生成时设了口令才需要
```

`pnpm --filter @armadra/desktop build` 在开工前就决定这次要不要签名（`scripts/signing.mjs`），
而不是把失败留到打包最后一步：

| `TAURI_SIGNING_PRIVATE_KEY` | 配置里的 `pubkey` | 结果                                                                  |
| --------------------------- | ----------------- | --------------------------------------------------------------------- |
| 有                          | 有                | 正常签名                                                              |
| 有                          | 空                | **立即报错**：签出的包这个壳自己会拒绝，先补上公钥                    |
| 无                          | 任意              | 跳过签名，并关掉 `createUpdaterArtifacts`：只出安装包，命令行明确告警 |

CI 发布作业设 `ARMADRA_REQUIRE_SIGNED_BUNDLE=1`，把「跳过」变成失败——发布不能是无签名的。
本机想演练完整的清单 + 签名 + 校验用 `pnpm release:dry-run`，它自带一次性密钥，不碰任何真实密钥。

## Host 连接

桌面启动时异步启动/发现 Host；纯 Web 模式手工启动，并允许实际页面的精确来源：

```sh
go -C apps/host run ./cmd/armadra-host --allow-origin http://127.0.0.1:1420
```

在「设置 → 连接 → 后台服务」检查 `http://127.0.0.1:43121`。
检查只读服务身份，不切换 Runtime 或触发启动；通过后仅在本设备保存地址。
编辑、取消或离开检查页会使旧检查失效。已有服务配置不兼容时报告失败，不自动重配。

Origin 不含路径或末尾 `/`，可多次传入。桌面按平台使用 `tauri://localhost`、
`http://tauri.localhost` 或 `https://tauri.localhost`，打包与开发都把 Host 起在 `127.0.0.1:43121` 并放行这些来源；
打包 CSP 只允许 `armadra:` 自定义协议、回环 WebSocket 与 `http://127.0.0.1:43121`，
不再默认放开 `http://127.0.0.1:43120`，开发模式的放行写在 `devCsp`。
浏览器来源的 CORS 只允许读取元数据；壳内的原生来源经票据换取 Bearer 会话（[设备认证](./host-device-auth.md)），
远程执行另属未完成能力。详见[Host 说明](../../apps/host/README.md)。

## 环境变量与数据

| 变量                                            | 作用                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` | 没有 `--listen` 时的监听地址，默认 `127.0.0.1:43120`；设置后 `armadra.sh run web` 用固定端口而非随机端口                                                                                                                                                                                                                            |
| `ARMADRA_RUNTIME_LISTEN`                        | 桌面壳持有的 Runtime 在私有 socket 之外额外监听的一个 `--listen` spec（开发用）                                                                                                                                                                                                                                                     |
| `ARMADRA_WEB_PORT`                              | `armadra.sh run web` 的前端端口                                                                                                                                                                                                                                                                                                     |
| `VITE_RUNTIME_URL`                              | 前端连接地址；设置后 Vite 不装代理。不设时浏览器开发走 Vite 代理（地址取自 endpoints.json），打包桌面走 `armadra://`                                                                                                                                                                                                                |
| `ARMADRA_DATA_DIR`                              | Runtime 数据目录，`endpoints.json` 与 Runtime socket 都在这里                                                                                                                                                                                                                                                                       |
| `ARMADRA_DATABASE_URL`                          | SQLite 连接，例如 `sqlite://…?mode=rwc`                                                                                                                                                                                                                                                                                             |
| `RUST_LOG`                                      | 日志过滤，默认 `info,tower_http=info`                                                                                                                                                                                                                                                                                               |
| `ARMADRA_HOOK_DEBUG`                            | Hook 调试                                                                                                                                                                                                                                                                                                                           |
| `ARMADRA_DESKTOP_DIAGNOSTIC_WS`                 | debug 构建（或 `tauri build --features diagnostic-bridge` 的 release 二进制）的桌面壳：`ws://127.0.0.1:<port>`，页面的 console.error/warn、未捕获异常、fetch 结果、WebSocket 生命周期与 DOM 探针逐条发到这个回环 WebSocket（打包后的 WKWebView 没有开发者工具）；`ARMADRA_DESKTOP_DIAGNOSTIC_PRELUDE` 是在页面脚本之前执行的一段 JS |
| `ARMADRA_REMOTE_WORKER_LAUNCHER`                | 替换远端 Worker 启动行的 argv[0]（默认 `ssh`）。必须是绝对路径、不含空白；SSH 选项与远端命令原样保留。测试与自建隧道用                                                                                                                                                                                                              |

脚本发现 Runtime 端口占用时直接报错。节点身份、Hook token、端点与权限等待变量由 Runtime 注入 Agent 终端，无需手工配置。
Runtime 不监听 TCP 时 `hook-endpoint.env` 不写 `ARMADRA_HOOK_PORT`，Hook 客户端只走 `hook.sock`。

默认数据目录：macOS `~/Library/Application Support/Armadra`，Windows `%LOCALAPPDATA%\Armadra`，
Linux `$XDG_DATA_HOME/armadra`。包含 `canvas.db`、设置、`endpoints.json`、Runtime socket、Hook 端点、节点 token、审批文件和 tmux socket。
工作区 `.armadra/` 保存图片、导出与板日志，已加入 `.gitignore`。

「设置 → 数据」使用当前连接的 SQLite 一致性快照备份，包含已提交 WAL 数据；完整性检查通过后写入数据库旁的唯一文件。
内存数据库不提供旁路文件备份。数据库只允许空库初始化或完整已知迁移前缀升级，异常时拒绝启动，保留原数据。
开发约定见[AGENTS.md](../../AGENTS.md)。
