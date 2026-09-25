# 开发指南

## 环境

Node.js ≥ 22 与 pnpm（版本锁定于根 `package.json`）——没有别的工具链。
tmux 是推荐终端后端，缺失时退回直连 PTY。
macOS 桌面目标 ≥ 13.3，并需 Xcode Command Line Tools。

```sh
pnpm install
./armadra.sh doctor
./armadra.sh run web       # core + Web，退出时一起关闭
./armadra.sh run desktop   # 桌面壳持有 core
```

`doctor` 检查 Node / pnpm / tmux / Xcode CLT。

## 分步启动

以下各进程在独立终端运行：

```sh
pnpm --filter @armadra/desktop build                       # 产出 out/core/main.js 等
node apps/desktop/out/core/main.js                         # 127.0.0.1:43120（兼容默认）
node apps/desktop/out/core/main.js --listen tcp:127.0.0.1:0   # 端口由内核分配
pnpm --filter @armadra/web dev      # 127.0.0.1:1420
# 或用桌面壳替代 Web 命令（仍需上面的外部 core）
pnpm --filter @armadra/desktop dev
```

## 监听方式与地址发现

core 的 `--listen` 可重复，每次一个：`tcp:IP:PORT`（端口 `0` 由内核分配）、
`unix:绝对路径`（0600）、`pipe:名字`（Windows 命名管道）。不给 `--listen` 时按
`ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT`，再退回 `127.0.0.1:43120`。
指定的 TCP 端口被占用直接报错，不换端口。

绑定成功后地址写入 `<数据目录>/endpoints.json`（0600）的 `runtime` 段，
含地址、instance id、pid 与写入时间；正常退出时撤回自己那段。
`./armadra.sh run web` 与 Vite 开发代理都从这个文件读地址，`VITE_RUNTIME_URL` 显式覆盖时不装代理。

桌面壳自己提供页面：主进程在 `127.0.0.1` 的一个内核分配端口上跑一个静态服务，
`BrowserWindow` 加载的就是这个地址。core 以 `--listen tcp:127.0.0.1:0` 启动并在 stdout
公告实例与端口，页面经 preload 的 `transport:endpoints` 一次性取得
`{ httpBase, wsBase, dataDir }`，`fetch` 与 `WebSocket` 直连
（[迁移设计](../design/electron-migration.md) §2.1）。没有自定义协议，也没有 WebSocket
回环转发端口。因此 `lsof -i -P | grep -i Armadra` 在「对外服务未开启」时只看到静态服务与
core 两个回环端口。

桌面包与 `./armadra.sh run desktop` 会持有自己的 core；后者额外用 `ARMADRA_RUNTIME_LISTEN`
钉一个回环端口，因为开发页面在 Vite 的 `http://127.0.0.1:1420`，不是壳的静态服务，拿不到
壳注入的基址。直接执行桌面 `dev` 默认连接外部 core。
Command W / 关闭窗口隐藏前台；Command Q / 托盘退出停止桌面持有的 core 及受管会话。
独立启动的 core 由启动它的终端管理。详见[桌面说明](../../apps/desktop/README.md)。

## 无窗口服务器壳

`apps/server`（`@armadra/server`）把同一套 core 装在同一个进程里，对外只有 TLS 一个面，
浏览器与手机加载的是同一份 `apps/web` 产物。它要求数据目录**已经过统一库迁移 0015**
（单向门，见 [实施进度](../status/typescript-core-status.md) §6），否则拒绝启动。

```sh
pnpm --filter @armadra/web build                     # 页面产物，serve 默认往上找 apps/web/dist
pnpm --filter @armadra/server build                  # esbuild → apps/server/out/main.js
node apps/server/out/main.js serve --data-dir ~/.armadra-server
node apps/server/out/main.js serve --listen 0.0.0.0:8443 \
  --public-origin https://armadra.example \
  --tls-cert /etc/armadra/tls.crt --tls-key /etc/armadra/tls.key
```

`--listen` 默认 `127.0.0.1:0`；**监听非回环地址必须同时给 `--public-origin`**，否则直接拒绝。
不给 `--tls-cert/--tls-key` 就在 `<数据目录>/tls/` 生成一张自签名证书（私钥 0600），
`status` 会把它标成「自签名」。启动时打印一行
`armadra-server pairing https://…/#pair=<两分钟一次性票>`——用它在新设备上完成配对，
之后是 `__Host-` 前缀的会话 Cookie；POSIX 上 `kill -USR2 <pid>` 再铸一张。

运维相关的四条命令只写文件，**绝不调用 launchctl / systemctl / sc.exe**：

```sh
node apps/server/out/main.js install --service-dir /etc/systemd/system \
  --run-as armadra --web-root /opt/armadra/web   # 只生成定义，自己审阅后再注册
node apps/server/out/main.js status --output json
node apps/server/out/main.js logs --lines 200
node apps/server/out/main.js upgrade --binary /tmp/armadra-server.next   # 没有 --confirm 只打印计划
```

`install` 必须显式给 `--service-dir` 与 `--run-as`，拒绝 root/SYSTEM 一类账号，`--env` 里名字带
TOKEN / SECRET / PASSWORD / CREDENTIAL 字样一律拒绝。

## 检查与打包

从仓库根执行，按改动涉及的模块选择：

| 范围               | 命令                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| 仓库规则           | `pnpm repo:check`（秒级）、`pnpm repo:test`                                                    |
| 一次过静态检查     | `pnpm check`＝libs 构建 + format:check + typecheck + repo:check + ci:workflows + release:check |
| 前端               | `pnpm --filter @armadra/web test`、`pnpm --filter @armadra/web typecheck`                      |
| 共享模型           | `pnpm --filter @armadra/shared test`                                                           |
| core 与桌面壳      | `pnpm --filter @armadra/desktop test`（vitest + `node --test scripts/*.test.mjs`）             |
| 服务器壳           | `pnpm --filter @armadra/server test`、`pnpm --filter @armadra/server typecheck`                |
| 全部包             | `pnpm test`                                                                                    |
| 格式 / 类型        | `pnpm format:check`、`pnpm typecheck`                                                          |
| 发布与 CI 脚本     | `pnpm release:test`、`pnpm ci:workflows`、`pnpm release:check`                                 |
| 桌面构建（不打包） | `pnpm --filter @armadra/desktop build`                                                         |
| 桌面打包           | `pnpm --filter @armadra/desktop dist`                                                          |

身份域的端到端在 `apps/desktop/src/core/identity/accounts.integration.test.ts`：真起 core，走完取票、配对、重放被拒、撤销。
`tools/probes/` 下的探针跑的也是真的 core（`apps/desktop/out/core/main.js`）：终端的冒烟、
生命周期与打包后验证，以及三个用无头 Chrome 驱动真实页面的 UI 探针（连线拖拽、Git 工具窗口、
画布压力）。运行入口见 [探针说明](../../tools/probes/README.md)。

R7d 删掉了一批只对分进程时代有意义的脚本：写入所有权的 e2e 与 harness、Host 的几支烟囱测试、
Rust↔Go 的归档互通，以及需要受管二进制路径的 `agent:smoke` / `handoff:read-smoke`。它们验证
的事实现在由 core 各域的用例覆盖；真 CLI 的端到端版本要重写成对着 core 的形式，还没有。

`armadra.sh check` 就是 `pnpm check`；`test` 是 shared 构建加 `pnpm -r test`。
`all` 执行 doctor → install → check → build → run。

`pnpm repo:check` 读 `repo.rules.json` 校验仓库结构：文档登记与相对链接、黑名单文件、包名与目录名、
根目录白名单、源码行数上限（超限文件登记在豁免表）、迁移编号与 `migrations.lock` 里的 sha256。
规则说明见[仓库结构与校验](../design/repository-structure.md)。
仓库级脚本都在 `tools/`，各 app 自己的脚本仍在各自的 `scripts/`。

打包只有一步：`pnpm --filter @armadra/desktop dist`（细节在[桌面说明](../../apps/desktop/README.md)）。
它先定签名计划、再 `electron-vite build`、最后调用 electron-builder；包里要带的东西由
`scripts/after-pack.mjs` 从 `out/` 与 `src/core/db/migrations` 放进 `Resources/`。没有受管二进制
要先构建。产物落在 `apps/desktop/release/`。

### 更新签名

桌面包的信任分两层，各自有自己的密钥：

- **平台代码签名**（macOS Developer ID + 公证、Windows Authenticode）由 electron-builder 做，
  也是 electron-updater 安装前校验的东西。密钥经 `CSC_LINK` / `CSC_KEY_PASSWORD` 与
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 传入。
- **发布清单签名**：`latest.json` 里每个平台条目带一份 minisign 分离签名，由
  `tools/release/assemble.mjs` 用 `ARMADRA_RELEASE_SIGNING_KEY` 在写清单之前签出
  （[发布、更新与服务安装 §2.5](../design/updates-and-service-install.md#25-引入步骤一次性)）。

仓库里**没有**真实密钥。`pnpm --filter @armadra/desktop dist` 在开工前就决定这次要不要签名
（`scripts/signing-electron.mjs`），而不是把失败留到打包最后一步：

| `CSC_LINK` | 其余条件                          | 结果                                                          |
| ---------- | --------------------------------- | ------------------------------------------------------------- |
| 有         | 有 `CSC_KEY_PASSWORD`             | 正常签名；公证凭据齐全时一并公证，缺了就只签不公证            |
| 有         | 没有 `CSC_KEY_PASSWORD`           | **立即报错**：electron-builder 会在签名那一步以钥匙串错误收场 |
| 无         | `ARMADRA_REQUIRE_SIGNED_BUNDLE=1` | **立即报错**：发布不能是无签名的                              |
| 无         | 其余                              | 跳过签名，命令行明确告警                                      |

本机 `dist` 还会经 `extraMetadata` 往打进包里的 `package.json` 写一个
`armadraUpdates: "disabled"` 标记：`app.isPackaged` 对本机包和发布包都是 true，没有这个
标记它就会去轮询一个从未发布过这个版本的生产 feed。发布脚本不写这个标记，所以正式包不受影响
（`apps/desktop/src/shell-core/updates/availability.ts` 是读的那一半）。

本机想演练完整的清单 + 签名 + 校验用 `pnpm release:dry-run`，它自带一次性密钥，不碰任何真实密钥。

## 来源与凭据

core 的 CORS 只放行回环 HTTP 来源：桌面壳放行的是自己静态服务的那个来源（端口由内核分配，
所以每次启动都不同），开发时再加上 Vite 的 `http://127.0.0.1:1420`。自定义 scheme 一律拒绝。
CSP（`apps/desktop/src/shell-core/csp.ts`）只允许本机 core 的 http/ws。桌面壳里凭据经
preload 注入页面，没有票据链；服务器壳的设备配对与可撤销会话见上面的「无窗口服务器壳」。
分进程时代的票据链见 [桌面壳原生 Host 会话](../history/host-native-session.md) 与
[设备认证](../history/host-device-auth.md)，两份都是历史文档。

## 环境变量与数据

| 变量                                            | 作用                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` | 没有 `--listen` 时的监听地址，默认 `127.0.0.1:43120`；设置后 `armadra.sh run web` 用固定端口而非随机端口                        |
| `ARMADRA_RUNTIME_LISTEN`                        | 桌面壳持有的 core 在私有 socket 之外额外监听的一个 `--listen` spec（开发用）                                                    |
| `ARMADRA_WEB_PORT`                              | `armadra.sh run web` 的前端端口                                                                                                 |
| `VITE_RUNTIME_URL`                              | 前端连接地址；设置后 Vite 不装代理。不设时浏览器开发走 Vite 代理（地址取自 endpoints.json），桌面壳里取 preload 给的 `httpBase` |
| `ARMADRA_DATA_DIR`                              | core 的数据目录，`endpoints.json` 与 core 的 socket 都在这里                                                                    |
| `ARMADRA_DATABASE_URL`                          | SQLite 连接，例如 `sqlite://…?mode=rwc`                                                                                         |
| `ARMADRA_CORE_MIGRATIONS_DIR`                   | 迁移目录，覆盖「包内 `resources/migrations` → 往上找检出」这条查找顺序（测试与夹具用）                                          |
| `ARMADRA_LOG`                                   | 日志级别，默认 `info`                                                                                                           |
| `ARMADRA_HOOK_DEBUG`                            | Hook 调试                                                                                                                       |
| `ARMADRA_DESKTOP_OWNS_RUNTIME`                  | 开发也由壳持有 core（默认连外部 core）                                                                                          |
| `ARMADRA_DESKTOP_PACKAGED`                      | 按打包布局解析随包资源的位置，不必真打包                                                                                        |
| `ARMADRA_DESKTOP_LIFECYCLE_TRACE`               | 打印启动 / 退出编排的事件                                                                                                       |
| `ARMADRA_UPDATES_DEV`                           | `=1` 让未打包的构建也接更新器，用来对着本地发布服务走一遍流程；它不放松安装校验，未签名的包照样会被拒                           |
| `ARMADRA_UPDATER_ENDPOINTS`                     | 逗号分隔的更新清单地址，覆盖 `electron-builder.yml` 里的占位 `publish.url`；仓库里从不写死真实地址                              |
| `ARMADRA_HOOK_TIMEOUT_MS`                       | Agent 扩展模块上报的超时（默认 1500 ms，上限 60000）。只有测试驱动会调大它：进程级回退路径要在同一预算里起一个子进程            |
| `ARMADRA_REMOTE_WORKER_LAUNCHER`                | 替换远端 Worker 启动行的 argv[0]（默认 `ssh`）。必须是绝对路径、不含空白；SSH 选项与远端命令原样保留。测试与自建隧道用          |
| `ARMADRA_STATUS_PAGE_BASE`                      | 用量页的 Provider 状态页改读 `<地址>/<anthropic\|openai\|github>/api/v2/status.json`（探针用本机 fixture，不碰真网络）          |

脚本发现 core 端口占用时直接报错。节点身份、Hook token、端点与权限等待变量由 core 注入 Agent 终端，无需手工配置。
core 不监听 TCP 时 `hook-endpoint.env` 不写 `ARMADRA_HOOK_PORT`，Hook 客户端只走 `hook.sock`。

默认数据目录：macOS `~/Library/Application Support/Armadra`，Windows `%LOCALAPPDATA%\Armadra`，
Linux `$XDG_DATA_HOME/armadra`。包含 `canvas.db`、设置、`endpoints.json`、core 的 socket、Hook 端点、节点 token、审批文件和 tmux socket。
工作区 `.armadra/` 保存图片、导出与板日志，已加入 `.gitignore`。

「设置 → 数据」使用当前连接的 SQLite 一致性快照备份，包含已提交 WAL 数据；完整性检查通过后写入数据库旁的唯一文件。
内存数据库不提供旁路文件备份。数据库只允许空库初始化或完整已知迁移前缀升级，异常时拒绝启动，保留原数据。
开发约定见[AGENTS.md](../../AGENTS.md)。
