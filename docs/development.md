# 开发

## 前置

| 依赖    | 版本                 | 说明                                               |
| ------- | -------------------- | -------------------------------------------------- |
| Node.js | ≥ 22                 | `package.json` 的 `engines`                        |
| pnpm    | 11.18.0              | `packageManager` 已锁定，用 `corepack enable` 即可 |
| Rust    | stable，edition 2024 | Runtime、hook 客户端、Tauri 壳                     |
| tmux    | 任意近版             | 默认终端后端；缺失时自动退回直连 PTY               |
| macOS   | ≥ 13.3               | 桌面端打包目标；Web 端不限                         |

## 安装

```bash
pnpm install
```

## 运行

Runtime 与前端是两个进程，桌面壳会自己拉起 Runtime。

```bash
# 1. Runtime（监听 127.0.0.1:43120）
cargo run -p armadra-runtime

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

设置里的「数据」页显示数据目录、数据库大小，并可在原地复制一份数据库做备份。

## 约定

- JSON 字段一律 camelCase；错误统一 `{ "code": string, "message": string }`。
- 数据库没有升级路径：版本不认识就把 `canvas.db` 改名为
  `canvas.db.legacy-<时间戳>` 并新建。开发中换 schema 直接删库。
- 界面文案走 `apps/web/src/i18n/`，组件只用 shadcn CLI 装的组件。
- 改架构先改 [architecture.md](./architecture.md)，再动代码。
