# 服务器端账号、数据中转与共享（预留设计）

> 状态：目标设计。**§2 的数据模型、§3 的接口形状与 §4 的五处预留已经落地**（R6b，迁移 `0019_accounts.sql`，实测与偏差见 [TypeScript Core 实施进度](../status/typescript-core-status.md) §10）；§3 里 passkey、OAuth 绑定、开放注册按设计要求返回 501。剩下的是服务器壳的传输与认证（R6a）与真正把共享用起来（R8）。本文回答一个前置问题：当核心以服务器壳（[TypeScript Core](typescript-core.md) R6）跑在无图形界面的 Linux 上、多台设备从外部访问时，账号登录、数据中转、设备绑定，以及将来「开一个组、组内共享某人的看板并可操作」这类能力，需要**现在**在数据模型、鉴权与接口上预留什么，才能按设置逐步施工而不返工。本文只定模型与接口边界，不排实施批次；实施挂在 R6 之后的 R8。
> 范围：`core/identity`（已有：单 owner、设备、会话、票据、scope）、`core/canvas`、`core/events`、服务器壳的传输与认证。不涉及计费、组织层级、SSO。
> 输入：R1c 已落地的 `identity_*` 表与 `scope(permission, workspaceId?, executionHostId?)` 授权模型；R1b 的按工作空间扇出的事件流；R1a 的画布 CAS 保存。

## 1. 结论

| #   | 决定                                                                                                                      | 理由                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **服务器就是中转站**：所有状态（画布、终端会话、Agent、设置）只在服务器核心里，客户端（桌面壳、浏览器、手机）是无状态视图 | 现有架构已如此（前端经 HTTP/WS 读写核心）；多设备一致性靠核心的 CAS + 事件流，不引入客户端本地库                                                                            |
| S2  | **从「单 owner」演进为「principal 多个、owner 是其中一种角色」**，而不是推倒重来                                          | `identity_devices.principal_id` 已引用 `identity_owner`，把 owner 表泛化为 `identity_principals`（含 `kind: owner \| member \| service`）即可，会话/票据/scope 全部原样复用 |
| S3  | **授权只有一种表达：scope**（`permission@workspace[/executionHost]`），组与共享都编译成 scope 的授予记录                  | `permits(grants, required)` 已是唯一判定点，所有路由已按它裁决；新增「组」不需要新的判定路径                                                                                |
| S4  | **共享的最小单位是工作空间（一块画布 = 一个工作空间）**，不做节点级 ACL                                                   | 终端/Agent/资产都挂在工作空间下，节点级权限会让 Agent 的连线读取与终端所有权变成不可判定的矩阵                                                                              |
| S5  | **可操作 ≠ 可驱动他人的终端**：`operate` 允许改画布与开自己的终端，`drive` 才允许向他人创建的终端/Agent 写入              | 终端写入会替 Agent 回答权限提示（契约 §25 的安全门），必须是显式授予                                                                                                        |
| S6  | **事件流按 principal 过滤**：订阅者只收到自己有 `read` 的工作空间的帧                                                     | R1b 的扇出已按 `workspaceId`，只需在订阅时校验 scope                                                                                                                        |
| S7  | **登录方式可插拔，账号模型不依赖任何一家**                                                                                | 首版：本地口令 + passkey（WebAuthn）；OAuth（GitHub 等）作为「绑定」而非账号来源，避免账号被第三方决定                                                                      |

## 2. 数据模型（在 `identity_*` 上增量，编号迁移）

> 已落地：迁移 `0019_accounts.sql`。实际表名比下面多一个前缀（`groups` → `identity_groups`、`group_members` → `identity_group_members`、`grants` → `identity_grants`），因为统一库里所有身份域的表都带这个前缀；列按下表，凭据那张多了 KDF 参数的四列（`kdf_cost` / `kdf_block` / `kdf_parallel` / `kdf_length`）与盐，参数存行里才能在升参数之后仍然校验得了旧哈希。`identity_grants.workspace_id` 没有外键（理由写在迁移里）。

```
identity_principals   principal_id PK, kind('owner'|'member'|'service'), display_name, created_at_ms, disabled_at_ms
identity_credentials  credential_id PK, principal_id FK, kind('password'|'passkey'|'oauth'), provider?, subject?, secret_hash?, public_key?, created_at_ms, revoked_at_ms
identity_devices      （已有）principal_id 改引用 identity_principals；role 放开为 'owner'|'member'
identity_sessions     （已有，不变）
identity_bootstrap_tickets （已有，不变）
identity_invitations  invitation_id PK, issued_by FK principal, target_group_id?, target_workspace_id?, role, token_hash, expires_at_ms, consumed_by?, consumed_at_ms
groups                group_id PK, name, owner_principal_id FK, created_at_ms
group_members         group_id FK, principal_id FK, role('admin'|'member'), joined_at_ms, PK(group_id, principal_id)
grants                grant_id PK, subject_kind('principal'|'group'), subject_id, workspace_id FK, role('viewer'|'editor'|'operator'|'driver'), granted_by FK, created_at_ms, revoked_at_ms
audit_log             id PK, at_ms, principal_id, device_id?, action, target, detail_json
```

角色到 scope 的编译（唯一来源，纯函数 `roleScopes(role, workspaceId)`）：

| 角色          | 得到的 scope                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------ |
| viewer        | `canvas:read`、`events:read`、`terminal:read`（只看画面）、`assets:read`                         |
| editor        | viewer + `canvas:write`、`assets:write`、`mermaid:import`                                        |
| operator      | editor + `terminal:create`（自己开的终端）、`agent:launch`、`git:read/write`、`files:read/write` |
| driver        | operator + `terminal:drive`（向他人的终端/Agent 写入）、`approval:answer`                        |
| owner（隐含） | 全部 + `identity:manage`、`workspace:share`                                                      |

会话的 `scopes` 列是**登录时的快照**并带 `rotation`；撤销授予时把受影响会话的 `rotation` 推进，下一次请求重新编译（`IdentityService.authenticate` 每次读库，不缓存——R1c 已如此）。

## 3. 接口预留（现在就按这些形状写，未实现的返回 501）

> 已落地，**路径有一处偏差**：组、共享、审计挂在 `/api/identity/` 下（`identity/groups`、`identity/grants?workspaceId=`、`identity/audit`），不是 `/api/groups`、`/api/workspaces/{id}/grants`、`/api/audit`——`/api/workspaces/*` 属于那张与旧 Runtime 逐条对账的路由表，写这份文档时对账对象还是 Rust Runtime，现在是 core（契约到 R7）。做实的是 principal、口令凭据与登录、邀请、组、授予、审计只读；passkey、OAuth 绑定、开放注册是 501。

| 面   | 路由                                                                                                                                                       | 备注                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 账号 | `POST /api/identity/register`（仅当 `allow_registration` 设置开启或持邀请）、`POST /api/identity/login`（password / passkey）、`POST /api/identity/logout` | 与现有 `session/*` 同一张 `identity_sessions`                    |
| 凭据 | `GET/POST/DELETE /api/identity/credentials`、`POST /api/identity/credentials/oauth/{provider}/start\|callback`                                             | OAuth 只做「绑定到已有 principal」                               |
| 设备 | （已有）`devices`、`devices/revoke`                                                                                                                        | 设备属于 principal，不再隐含 owner                               |
| 邀请 | `POST /api/identity/invitations`、`POST /api/identity/invitations/{id}/accept`                                                                             | 邀请可指向组或单个工作空间                                       |
| 组   | `GET/POST /api/groups`、`PATCH/DELETE /api/groups/{id}`、`PUT/DELETE /api/groups/{id}/members/{principalId}`                                               | 组只是「一批 principal 的授予快捷方式」                          |
| 共享 | `GET/PUT/DELETE /api/workspaces/{id}/grants`                                                                                                               | 主体是 principal 或 group；返回编译后的有效 scope 供界面显示     |
| 审计 | `GET /api/audit?workspaceId=&principalId=`                                                                                                                 | 只读                                                             |
| 事件 | `WS /api/workspaces/{id}/events`                                                                                                                           | 升级前 guard 校验 `events:read@workspace`（R1b 的 guard 已能做） |

所有响应 camelCase、错误 `{ code, message }`；权限不足统一 `403 { code: "forbidden" }`，不泄露是否存在。

## 4. 现有代码里现在就要做的预留（R6 之前，零功能改动）

> 五条都已落地，落点逐条列在 [实施进度](../status/typescript-core-status.md) §10.2。判定入口是 `core/identity/authorize.ts` 与 `core/identity/gate.ts`，今天对 owner 恒真。

1. `core/identity/scopes.ts` 的 `PERMISSIONS` 列表补齐 §2 的权限名（`canvas:read/write`、`events:read`、`terminal:read/create/drive`、`agent:launch`、`approval:answer`、`assets:read/write`、`workspace:share`、`identity:manage`），并让每条已实现路由声明自己要求的 scope（现在桌面壳是 owner 全量，判定恒真，但路由上的声明是后面组权限的落点）。
2. `identity_owner` 改为 `identity_principals`（一次编号迁移，owner 行 `kind='owner'`），`identity_devices.role` 放开 CHECK。
3. `core/events` 的订阅 guard 加 scope 校验入口（当前所有人都是 owner，恒通过）。
4. 终端写入路径（R2a 的输入安全门）加 `terminal:drive` 判定入口：写入者 ≠ 会话创建者时要求该 scope。
5. 审计表与 `audit(principal, action, target)` 写入点：登录、设备撤销、授予变更、审批答复、终端接管。

## 5. 不做与风险

- 不做节点级/资产级 ACL（S4）；不做组织多级；不做计费。
- 多人同时编辑同一画布仍走 CAS + `replayLocalEdits` 变基（R1a 保住的语义），不引入 CRDT——组共享的第一版接受「后写者按对方最新状态变基」。
- 共享终端的安全边界是 `terminal:drive`；即便有 `read`，终端画面里可能出现的密钥仍由使用者自负——审计日志是唯一补偿手段。
- 服务器壳的认证从零实现（typescript-core §9），本文的账号模型就是它的规格；实现顺序：本地口令 → passkey → 邀请 → 组/授予 → OAuth 绑定。
