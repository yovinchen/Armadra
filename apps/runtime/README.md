# apps/runtime

唯一执行服务。所有进程、文件、Git、权限判定都在这里。

技术栈：Rust、Axum、Tokio、WebSocket、portable-pty、tmux、SQLx + SQLite、Git CLI wrapper。

```bash
cargo run -p armadra-runtime
curl http://127.0.0.1:43120/health
cargo test -p armadra-runtime
```

默认只监听 `127.0.0.1:43120`（`ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` 可覆盖）。
CORS 只放行 `http://127.0.0.1:*`、`http://localhost:*`、`tauri://localhost`、
`https://tauri.localhost`。

## 模块

| 目录                                  | 职责                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `terminal/`                           | 三种后端：`tmux`（默认，会话跨重启存活）、`direct`（portable-pty）、`ssh`；快照重连、背压、回收        |
| `hook/`                               | hook 端点（回环 TCP + Unix socket）、per-node token 鉴权、各 CLI 的 hook 安装与载荷归一化、状态 reduce |
| `collab/`                             | 上下文链接、控制动词、消息投递、审批、技能安装、板日志                                                 |
| `index/`                              | 扫描 Claude / Codex / Gemini 的本地转录，建 `(provider, sessionId) → 标题` 索引                        |
| `usage/`                              | Claude / Codex 配额快照，按 Runtime 自己的节奏拉取并缓存                                               |
| `files.rs` / `git.rs` / `security.rs` | 文件读写（原子替换）、Git 包装、路径限制在工作区根内                                                   |

## 接口

约定：JSON 字段一律 camelCase；错误统一 `{ "code": string, "message": string }`，
`code` 取 `bad_request` (400) / `forbidden` (403) / `not_found` (404) /
`conflict` (409) / `io_error` / `database_error` / `internal_error` (500)。
完整契约见 `docs/v3-agent-terminal-plan.md` §13。

主表面（`src/lib.rs` 的 router，按顺序）：

| 前缀                                                                    | 内容                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `/health`、`/api/health`                                                | 健康检查，含 hook 表面状态                                                           |
| `/api/workspaces`                                                       | 工作空间增删改、打开                                                                 |
| `/api/workspaces/{id}/boards`                                           | 看板增删改；`/document` 是 CAS 读写（`expectedUpdatedAt` 冲突返回 409）              |
| `/api/workspaces/{id}/files`、`/file`                                   | 文件树与单文件读写                                                                   |
| `/api/workspaces/{id}/git/*`                                            | `status` / `diff` / `stage` / `unstage` / `revert` / `commit`                        |
| `/api/git/clone`、`/api/git/clone/{jobId}`                              | 克隆仓库（发生在工作空间存在之前，所以不带 workspace）                               |
| `/api/workspaces/{id}/sessions`、`/deliveries`                          | 会话列表、消息投递记录                                                               |
| `/api/workspaces/{id}/events`                                           | WebSocket：节点状态、审批、投递等事件                                                |
| `/api/workspaces/{id}/context-links/{nodeId}`                           | 写入某节点的上下文链接                                                               |
| `/api/workspaces/{id}/assets`、`/assets/import`、`/assets/{id}`         | 白板图片资产，内容寻址落在 `.armadra/assets/`                                        |
| `/api/workspaces/{id}/exports/{exportId}/png`                           | 画布导出 PNG，落在 `.armadra/exports/`                                               |
| `/api/terminals`                                                        | 创建 / 查询 / capture / paste / scroll / terminate / recycle；`/ws` 是终端 WebSocket |
| `/api/terminals/backend`                                                | 当前生效的终端后端                                                                   |
| `/api/ssh/hosts/{hostId}/test`                                          | 探测一个 SSH 主机是否可达                                                            |
| `/api/conversations`、`/refresh`                                        | 会话索引查询与重扫                                                                   |
| `/api/agents`、`/api/agents/{id}/hooks/install`、`/uninstall`           | Agent 探测与 hook / 技能安装                                                         |
| `/api/agent-status/{nodeId}/read`、`/suggest-title`                     | 标记已读、生成节点标题                                                               |
| `/api/settings`                                                         | Runtime 偏好读写                                                                     |
| `/api/data/info`、`/api/data/backup`                                    | 数据目录信息与一键备份                                                               |
| `/api/usage`、`/api/usage/refresh`                                      | 用量快照                                                                             |
| `/api/approvals/{pendingId}/answer`、`/api/control/confirm/{requestId}` | 权限回答、控制动词确认                                                               |
| `/api/gateway`                                                          | 预留：返回配置与 `implemented: false`，**不开任何监听端口**                          |

Hook 表面（`src/hook/mod.rs`，独立鉴权与 body 上限，同一份 router 也由 Unix socket 提供）：

| 路径                   | 内容                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/verify`              | 校验 token                                                                                                               |
| `/hook/{agentId}`      | CLI 的 hook 回报                                                                                                         |
| `/context-link/{verb}` | 读取相连节点的转录 / 摘要 / 终端画面                                                                                     |
| `/control/{verb}`      | `list` / `open-terminal` / `open-agent` / `sticky` / `link` / `rename` / `color` / `send` / `reply` / `notify` / `close` |

## 数据库

`migrations/0001_initial.sql` 是唯一的 schema，没有任何升级路径。旧版本写下的数据库
不做迁移也不做兼容：`db::connect` 检查 `_sqlx_migrations`，只要有一条记录不在本二进制
自带的迁移里（版本不认识，或校验和对不上），就把 `canvas.db`（连同 `-wal` / `-shm`）
改名为 `canvas.db.legacy-<时间戳>`，记一条 warn 日志，然后按当前 schema 建一个新库。

## PATH

从 Finder 启动的 GUI 进程拿到的是裸系统 PATH，没有 tmux、mise、Homebrew。
Runtime 启动时先把 PATH 换成补齐过的版本（`agent::agent_path()`），并把同一份
PATH 交给所有终端子进程，所以在终端里能用的 CLI 不会仅因为从 `.app` 启动就被
判成未安装。
