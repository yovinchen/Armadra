# apps/runtime

当前业务执行服务，负责终端、文件、Git、Hook 与协作；独立 Go Host 的迁移进度见[实施记录](../../docs/status/platform-implementation-status.md)。

技术栈：Rust、Axum、Tokio、WebSocket、portable-pty、tmux、SQLx + SQLite、Git CLI wrapper。

```bash
cargo run -p armadra-runtime
curl http://127.0.0.1:43120/health
cargo test -p armadra-runtime
```

默认只监听 `127.0.0.1:43120`（`ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` 可覆盖）。
CORS 只放行回环 HTTP 来源：`http://127.0.0.1:*`、`http://localhost:*`，以及
无端口的 `http://127.0.0.1`、`http://localhost`（Unix socket / 命名管道上的调用者
没有端口可写）。

## 模块

| 目录                                  | 职责                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `terminal/`                           | 三种后端：`tmux`（默认，会话跨重启存活）、`direct`（portable-pty）、`ssh`；快照重连、背压、回收        |
| `hook/`                               | hook 端点（回环 TCP + Unix socket）、per-node token 鉴权、各 CLI 的 hook 安装与载荷归一化、状态 reduce |
| `collab/`                             | 上下文链接、控制动词、消息投递、审批、技能安装、板日志                                                 |
| `index/`                              | 扫描 Claude / Codex 的本地转录 ，建 `(provider, sessionId) → 标题` 索引                                |
| `usage/`                              | Claude / Codex / Copilot 配额快照，按 Runtime 自己的节奏拉取并缓存                                     |
| `files.rs` / `git.rs` / `security.rs` | 文件读写（原子替换）、Git 包装、路径限制在工作区根内                                                   |

## 接口

约定：JSON 字段一律 camelCase；错误统一 `{ "code": string, "message": string }`，
`code` 取 `bad_request` (400) / `forbidden` (403) / `not_found` (404) /
`conflict` (409) / `io_error` / `database_error` / `internal_error` (500)。
完整契约见 `docs/contracts/v3-agent-terminal-plan.md` §13。

路由注册见 `src/lib.rs`，覆盖工作空间/画板、文件/Git、终端、会话、Agent、设置、数据和用量。
画板文档使用 CAS 写入，`expectedUpdatedAt` 冲突返回 409；`/api/gateway` 仍为未实现占位，不开监听。

Hook 在 `src/hook/mod.rs` 使用独立鉴权与 body 上限，提供 `/verify`、`/hook/{agentId}`、
`/context-link/{verb}`、`/control/{verb}`；同一 router 也经 Unix socket 提供。
上下文与消息箱协议见[Agent 协作](../../docs/guides/agent-collaboration.md)。

## 数据库

`migrations/` 是 schema 的唯一来源。启动只接受空库或完整已知迁移前缀；未知版本、
校验和不符、脏迁移、损坏账本和无账本的非空库均拒绝启动，不改名、清库或重建。
新增 schema 使用编号迁移，禁止修改已发布文件。备份与数据位置见[开发指南](../../docs/guides/development.md)。

## PATH

从 Finder 启动的 GUI 进程拿到的是裸系统 PATH，没有 tmux、mise、Homebrew。
Runtime 启动时先把 PATH 换成补齐过的版本（`agent::agent_path()`），并把同一份
PATH 交给所有终端子进程，所以在终端里能用的 CLI 不会仅因为从 `.app` 启动就被
判成未安装。
