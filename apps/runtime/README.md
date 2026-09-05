# apps/runtime

唯一执行服务，提供 Workspace / Board、文件、PTY、Agent（ACP）、Git 与 SQLite API。

技术栈：Rust、Axum、Tokio、WebSocket、portable-pty、SQLx、SQLite 与 Git CLI wrapper。

默认只监听 `127.0.0.1:43120`，负责 PTY、进程、文件访问、Git、Agent CLI、权限策略和日志脱敏。

```bash
cargo run -p armadra-runtime
curl http://127.0.0.1:43120/health
cargo test -p armadra-runtime
```

## 路由（API v2，契约见 `docs/redesign-plan.md` §3）

所有 JSON 字段一律 camelCase。错误统一为 `{ "code": string, "message": string }`，
`code` 取值 `bad_request` (400) / `forbidden` (403) / `not_found` (404) /
`conflict` (409) / `io_error` / `database_error` / `internal_error` (500)。

| 方法   | 路径                                             | 请求                                                               | 响应                                                                               |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| GET    | `/health`                                        | —                                                                  | `{status, version}`                                                                |
| GET    | `/api/workspaces`                                | —                                                                  | `WorkspaceSummary[]`，按 `lastOpenedAt` 倒序                                       |
| POST   | `/api/workspaces`                                | `{name, rootPath, color?, permissions?, gatewayEnabled?}`          | `Workspace`（同 rootPath 幂等返回，自动建 `Default` 看板）                         |
| PATCH  | `/api/workspaces/{id}`                           | `{name?, color?, permissions?, gatewayEnabled?}`                   | `Workspace`                                                                        |
| POST   | `/api/workspaces/{id}/open`                      | —                                                                  | `Workspace`（刷新 `lastOpenedAt`）                                                 |
| GET    | `/api/workspaces/{id}/boards`                    | —                                                                  | `Board[]`（按 `sortOrder`）                                                        |
| POST   | `/api/workspaces/{id}/boards`                    | `{name}`                                                           | `Board`                                                                            |
| PATCH  | `/api/workspaces/{id}/boards/{boardId}`          | `{name?, sortOrder?}`                                              | `Board`                                                                            |
| DELETE | `/api/workspaces/{id}/boards/{boardId}`          | —                                                                  | `204`；删除最后一个看板返回 `409 conflict`                                         |
| GET    | `/api/workspaces/{id}/boards/{boardId}/document` | —                                                                  | `BoardDocument`                                                                    |
| PUT    | `/api/workspaces/{id}/boards/{boardId}/document` | `{expectedUpdatedAt, nodes, edges, viewport, kanban?, whiteboard?}` | `BoardDocument`；CAS 失败返回 `409 conflict`                                       |
| GET    | `/api/workspaces/{id}/files?path=`               | —                                                                  | `{path, entries[], truncated}`                                                     |
| GET    | `/api/workspaces/{id}/file?path=`                | —                                                                  | `{path, mimeType, content, size}`                                                  |
| GET    | `/api/workspaces/{id}/git/status`                | —                                                                  | `{repository, branch, changedCount, ahead, behind}`                                |
| GET    | `/api/workspaces/{id}/git/diff?path=`            | —                                                                  | `{repository, clean, files[]}`，`files[].status ∈ M/A/D/R/?`                       |
| POST   | `/api/workspaces/{id}/git/stage`                 | `{paths: string[]}`                                                | `{staged: string[]}`                                                               |
| POST   | `/api/workspaces/{id}/git/revert`                | `{paths: string[]}`                                                | `{reverted: string[]}`                                                             |
| GET    | `/api/gateway?workspaceId=`                      | —                                                                  | `{enabled, port: 7420, addresses: ["127.0.0.1"], devices: [], implemented: false}` |
| POST   | `/api/terminals`                                 | `{workspaceId, cwd, shell?, command?, args?}`                      | `TerminalSession`                                                                  |
| GET    | `/api/terminals/{sessionId}`                     | —                                                                  | `TerminalSession`（含 `pid: number \| null`）                                      |
| POST   | `/api/terminals/{sessionId}/terminate`           | —                                                                  | `TerminalSession`                                                                  |
| GET    | `/api/terminals/{sessionId}/ws`                  | WebSocket                                                          | `output` / `status` / `warning` 事件                                               |
| GET    | `/api/agents`                                    | —                                                                  | `AdapterInfo[]`（含 `resolvedPath: string \| null`）                               |
| POST   | `/api/agents/context-preview`                    | `{agentNodeId, items}`                                             | `{prompt}`                                                                         |
| POST   | `/api/agents/run`                                | `{workspaceId, agentNodeId, adapter, command?, args?, cwd, items}` | `{session, prompt}`                                                                |
| GET    | `/api/agents/{sessionId}/ws`                     | WebSocket                                                          | `status` / `update` / `permission` / `permission_resolved` 事件                    |

`items[].kind` 接受 `task | file | context | log | note | browser | text`。

ACP `update` 事件已归一化为结构化载荷：

```json
{ "kind": "message",  "text": "..." }
{ "kind": "user",     "text": "..." }
{ "kind": "thinking", "text": "..." }
{ "kind": "tool", "toolCallId": "...", "title": "...", "status": "pending|in_progress|completed|failed", "toolKind": "read|edit|execute|null", "detail": "... | null" }
{ "kind": "plan", "entries": [{ "content": "...", "status": "..." }] }
{ "kind": "usage", "inputTokens": 0, "outputTokens": 0 }
```

`permission` 事件的 `request` 原样透传 Agent 的 `toolCall.title` / `.kind` / `.rawInput`。

## 数据库

`migrations/0001_initial.sql` 是唯一的 schema，没有任何升级路径。
旧版本写下的数据库不做迁移也不做兼容：`db::connect` 检查 `_sqlx_migrations`，
只要有一条记录不在本二进制自带的迁移里（版本不认识，或校验和对不上），
就把 `canvas.db`（连同 `-wal` / `-shm`）改名为 `canvas.db.legacy-<时间戳>`，
记一条 warn 日志，然后按当前 schema 建一个新库。

## 网关

本期只做预留：`GET /api/gateway` 返回配置与 `implemented: false`，**不会**开启任何监听端口，
也不会返回伪造的外部端设备。
