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
cargo run -p armadra-runtime        # 127.0.0.1:43120
pnpm --filter @armadra/web dev      # 127.0.0.1:1420
# 或用桌面壳替代 Web 命令（仍需上面的外部 Runtime）
pnpm --filter @armadra/desktop dev
```

桌面包与 `./armadra.sh run desktop` 会持有自己的 Runtime；直接执行桌面 `dev` 默认连接外部 Runtime。
Command W / 关闭窗口隐藏前台；Command Q / 托盘退出停止配置的 Host、桌面持有的 Runtime 及受管会话。
独立启动的 Runtime 由启动它的终端管理。详见[桌面说明](../apps/desktop/README.md)。

## 检查与打包

从仓库根执行，按改动涉及的模块选择：

| 范围                | 命令                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| 前端                | `pnpm --filter @armadra/web test`、`pnpm --filter @armadra/web typecheck` |
| 共享模型            | `pnpm --filter @armadra/shared test`                                      |
| Runtime             | `cargo test -p armadra-runtime`                                           |
| Go Host             | `go -C apps/host test ./...`、`go -C apps/host vet ./...`                 |
| 桌面脚本            | `pnpm --filter @armadra/desktop test`                                     |
| 协议                | `pnpm protocol:check`、`pnpm protocol:test`                               |
| 全部 JS 包 / Rust   | `pnpm test`、`cargo test --workspace`                                     |
| 格式 / 类型         | `pnpm format:check`、`pnpm typecheck`                                     |
| Rust workspace 检查 | `pnpm check:rust`（先准备 sidecar）                                       |
| 桌面打包            | `pnpm --filter @armadra/desktop build`                                    |

`armadra.sh check` 执行 shared 构建、TS 检查、Rust fmt / clippy；`test` 执行 shared、web 与 Rust workspace 测试。
它们不替代独立的 Go、协议与桌面脚本检查。`all` 执行 doctor → install → check → build → run。

打包会构建 Runtime、Hook 和 Go Host，再按 target triple 暂存 sidecar。
目标、缓存与交叉构建规则见[桌面构建说明](../apps/desktop/README.md)。

## Host 连接

桌面启动时异步启动/发现 Host；纯 Web 模式手工启动，并允许实际页面的精确来源：

```sh
go -C apps/host run ./cmd/armadra-host --allow-origin http://127.0.0.1:1420
```

在「设置 → 连接 → 后台服务」检查 `http://127.0.0.1:43121`。
检查只读服务身份，不切换 Runtime 或触发启动；通过后仅在本设备保存地址。
编辑、取消或离开检查页会使旧检查失效。已有服务配置不兼容时报告失败，不自动重配。

Origin 不含路径或末尾 `/`，可多次传入。桌面按平台使用 `tauri://localhost`、
`http://tauri.localhost` 或 `https://tauri.localhost`；CSP 目前允许默认本地 Host。
CORS 只允许读取元数据，设备登录与远程执行另属未完成能力。详见[Host 说明](../apps/host/README.md)。

## 环境变量与数据

| 变量                                            | 作用                                        |
| ----------------------------------------------- | ------------------------------------------- |
| `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` | Runtime 监听地址，默认 `127.0.0.1:43120`    |
| `ARMADRA_WEB_PORT`                              | `armadra.sh run web` 的前端端口             |
| `VITE_RUNTIME_URL`                              | 前端连接地址，默认 `http://127.0.0.1:43120` |
| `ARMADRA_DATA_DIR`                              | Runtime 数据目录                            |
| `ARMADRA_DATABASE_URL`                          | SQLite 连接，例如 `sqlite://…?mode=rwc`     |
| `RUST_LOG`                                      | 日志过滤，默认 `info,tower_http=info`       |
| `ARMADRA_HOOK_DEBUG`                            | Hook 调试                                   |

脚本发现 Runtime 端口占用时直接报错。节点身份、Hook token、端点与权限等待变量由 Runtime 注入 Agent 终端，无需手工配置。

默认数据目录：macOS `~/Library/Application Support/Armadra`，Windows `%LOCALAPPDATA%\Armadra`，
Linux `$XDG_DATA_HOME/armadra`。包含 `canvas.db`、设置、Hook 端点、节点 token、审批文件和 tmux socket。
工作区 `.armadra/` 保存图片、导出与板日志，已加入 `.gitignore`。

「设置 → 数据」使用当前连接的 SQLite 一致性快照备份，包含已提交 WAL 数据；完整性检查通过后写入数据库旁的唯一文件。
内存数据库不提供旁路文件备份。数据库只允许空库初始化或完整已知迁移前缀升级，异常时拒绝启动，保留原数据。
开发约定见[AGENTS.md](../AGENTS.md)。
