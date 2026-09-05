# 开发

## 前置

| 依赖    | 版本                 | 说明                                               |
| ------- | -------------------- | -------------------------------------------------- |
| Node.js | ≥ 22                 | `package.json` 的 `engines`                        |
| pnpm    | 11.18.0              | `packageManager` 已锁定，用 `corepack enable` 即可 |
| Rust    | stable，edition 2024 | Runtime、hook 客户端、Tauri 壳                     |
| tmux    | 任意近版             | 默认终端后端；缺失时自动退回直连 PTY               |
| macOS   | ≥ 13.3               | 桌面端打包目标；Web 端不限                         |

## 一键脚本

根目录的 `armadra.sh` 把下面各节串成子命令，任何一步失败即停止：

| 命令                              | 做什么                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| `./armadra.sh doctor`             | 检查 node / pnpm / rust / tmux / Xcode CLT                                  |
| `./armadra.sh install`            | `pnpm install` + `cargo fetch`                                              |
| `./armadra.sh check`              | shared 构建、TypeScript 类型检查、`cargo fmt --check`、clippy（警告即失败） |
| `./armadra.sh test`               | shared / web / Rust workspace 全部测试                                      |
| `./armadra.sh build [--bundle]`   | release 二进制 + sidecar + 前端产物；`--bundle` 再打 .app / .dmg            |
| `./armadra.sh run [desktop\|web]` | 桌面端 `tauri dev`，或 Runtime + 浏览器前端（⌃C 一起退出）                  |
| `./armadra.sh all`                | install → check → build → run                                               |

端口可用 `ARMADRA_RUNTIME_PORT` / `ARMADRA_WEB_PORT` 覆盖；43120 被占用（例如 Armadra.app 正在运行）时脚本会直接报错而不是抢端口。

## 安装

```bash
pnpm install
```

## 运行

Runtime 与前端是两个进程；生产桌面包自动启动 Runtime，开发模式由脚本统一启动。

```bash
# 1. Runtime（监听 127.0.0.1:43120）
cargo run -p armadra-runtime   # 开发模式下桌面壳不会自己拉起 Runtime，必须单独跑

# 2a. 浏览器里跑前端（127.0.0.1:1420）
pnpm --filter @armadra/web dev

# 2b. 或者跑桌面壳（会自动执行上面的 web dev）
pnpm --filter @armadra/desktop dev
```

桌面开发模式连接外部 Runtime，所以第 1 步不能省。

## 测试与检查

```bash
pnpm --filter @armadra/web test        # vitest
pnpm --filter @armadra/shared test     # vitest
pnpm test                              # 上面两个
pnpm typecheck
pnpm format:check
cargo test -p armadra-runtime
cargo test --workspace
pnpm check:rust                        # 准备 sidecar 后 cargo check --workspace
```

## 打包

```bash
pnpm --filter @armadra/desktop build
```

`build` 先跑 `scripts/prepare-sidecar.mjs`：用 `cargo build --release` 编出
`armadra-runtime` 与 `armadra-hook`，按 Rust host target triple 重命名复制到
`target/release/`，`tauri.conf.json` 的 `bundle.externalBin` 再把它们打进包里。
交叉编译时设 `CARGO_BUILD_TARGET` 或让 Tauri 传 `TAURI_ENV_TARGET_TRIPLE`。

## 目录

```text
apps/
  web/        React 19 + Vite 前端，唯一页面
    src/canvas/     tldraw 画布：自定义 shape、binding、同步、菜单、覆盖层
    src/nodes/      七种节点的节点体
    src/terminal/   xterm.js 终端
    src/panels/     设置、命令面板、资源管理器、源代码管理
    src/shell/      标签栏、Dock、侧栏、用量球
    src/store/      canvas-store（画布动作的唯一入口）
    src/api/        Runtime HTTP / WebSocket 客户端
    src/i18n/       zh-CN / en 文案
  runtime/    Rust 执行服务
    src/terminal/   tmux / 直连 PTY / SSH 三种后端
    src/hook/       hook 端点、鉴权、各 CLI 的安装与归一化、状态 reduce
    src/collab/     上下文链接、控制动词、消息投递、技能安装
    src/index/      各 CLI 转录的会话索引
    src/usage/      用量快照
    migrations/     唯一 schema
  desktop/    Tauri 2 薄壳 + sidecar 准备脚本
crates/
  armadra-hook/   注入 Agent 终端的 hook 客户端二进制
packages/
  shared/     领域模型、Agent 注册表、API 与 hook 事件的 zod schema
docs/         文档（见 docs/README.md）
```

## 环境变量

### 独立 Host 连接检查

设置 → 连接 → 后台服务可以检查独立 Go Host，显示连接结果与可展开的服务身份。检查按钮不会改变当前终端、文件或 Git 使用的 Runtime，也不会触发启动。桌面应用启动时会另行异步启动/发现 Host；纯 Web 模式仍需手工启动 Host。

纯 Web 模式可在另一个终端从仓库根启动 Host，显式允许开发页面来源：

```sh
go -C apps/host run ./cmd/armadra-host --allow-origin http://127.0.0.1:1420
```

然后在设置中检查默认地址 `http://127.0.0.1:43121`。开发页面改端口后，`--allow-origin` 也需要对应修改；来源不包含路径和末尾斜线。多次传入可允许多个明确来源。

打包桌面端的来源按平台选择 `tauri://localhost`、`http://tauri.localhost` 或 `https://tauri.localhost`。桌面 CSP 当前只额外允许默认本地 Host 地址，未开放任意远程地址；浏览器也需满足服务端的来源许可。CORS 许可不代表已经实现设备登录或远程执行权限。

地址仅在显式检查且校验通过时保存在本设备，不保存凭据；取消、编辑或离开页面会使旧检查失效。Host 未运行或来源不匹配时显示失败，不保留旧成功状态。服务命令及后端边界见 [Host 说明](../apps/host/README.md)。

桌面开发的 predev 会准备 Go Host 二进制；发布使用包内 sidecar。已有服务端点或来源不兼容时不会自动重配/重启，错误不阻断原有 Runtime 界面。Command W/窗口关闭只隐藏前台；Command Q/托盘退出停止配置的 Go Host 和桌面持有的 Runtime 及受管会话。`./armadra.sh run desktop` 也使用桌面持有模式；独立启动的开发 Runtime 不会被误关。业务迁移和后台执行器尚未完成。路径覆盖、协议和实际验证限制见 [桌面说明](../apps/desktop/README.md)。

### Runtime 配置

| 变量                                            | 作用                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` | Runtime 监听地址，默认 `127.0.0.1:43120`               |
| `ARMADRA_DATA_DIR`                              | 覆盖数据目录                                           |
| `ARMADRA_DATABASE_URL`                          | 覆盖数据库位置，形如 `sqlite://…?mode=rwc`             |
| `VITE_RUNTIME_URL`                              | 前端连接的 Runtime 地址，默认 `http://127.0.0.1:43120` |
| `RUST_LOG`                                      | 日志过滤，默认 `info,tower_http=info`                  |

以下由 Runtime 注入 Agent 终端，不需要手工设置：`ARMADRA_NODE_ID`、
`ARMADRA_AGENT_ID`、`ARMADRA_ENDPOINT_FILE`、`ARMADRA_HOOK_TOKEN`、
`ARMADRA_HOOK_PORT`、`ARMADRA_HOOK_SOCK`、`ARMADRA_PERM_WAIT_SECS` 等。
调试 hook 时可设 `ARMADRA_HOOK_DEBUG`。

## 数据位置

| 位置                                             | 内容                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `~/Library/Application Support/Armadra`（macOS） | `canvas.db`、`settings.json`、`hook-endpoint.env`、`node-tokens/`、`pending/`、`tmux.sock` |
| `%LOCALAPPDATA%\Armadra`（Windows）              | 同上                                                                                       |
| `$XDG_DATA_HOME/armadra`（Linux）                | 同上                                                                                       |
| `<工作区>/.armadra/`                             | 画布图片资产、导出的 PNG、板日志；已在 `.gitignore` 里                                     |

设置里的「数据」页提供数据库备份。备份从 Runtime 当前连接读取 SQLite 一致性快照，包含已提交但尚未 checkpoint 的 WAL 数据；完成完整性检查后发布为原数据库旁带时间及唯一后缀的文件，不覆盖已有备份。备份路径遵循实际数据库连接，内存数据库不提供旁路文件备份。

## 约定

- JSON 字段一律 camelCase；错误统一 `{ "code": string, "message": string }`。
- 数据库只接受空库初始化或完整已知迁移前缀的升级；未知版本、校验和不符、脏迁移、损坏账本或无账本的非空库均拒绝启动，不改名、清库或重建。schema 变更新增编号迁移，禁止修改已发布迁移文件（包括注释）；异常库需先备份并制定显式恢复方案。
- 界面文案走 `apps/web/src/i18n/`，组件只用 shadcn CLI 装的组件。
- 改架构先改 [architecture.md](./architecture.md)，再动代码。
