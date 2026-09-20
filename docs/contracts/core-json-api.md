# core 的 JSON 面

> 状态：实施契约。章节 §N 被代码注释引用，编号只增不改。
> 范围：`/api/github/*`、`/api/automations/*`、`GET /api/identity/hello`，以及自动化域**存进库里**的那份 JSON。它们由 R7a 落地（[实施进度](../status/typescript-core-status.md) §15）；R7 收尾删掉 `proto/`、`packages/protocol`、`packages/host-client` 与 `/rpc/*` 之后，这份文档是这三块的唯一说法。
> 不在范围：`/api/workspaces/*` 那 163 条路由（[TypeScript Core](../design/typescript-core.md) §5.1）。R7 之前它们与当时并存的 Rust Runtime 逐条对账、一个字节都不变；R7 收尾后 core 已是唯一实现，这张对账表本身随之拆除，但这 163 条路由不属于本文档的编码范围。

## 1. 为什么有这份文档

R7a 之前 GitHub 与自动化两块面板走的是 `/rpc/armadra.v1.*`：二进制 protobuf 帧，形状由当时 `proto/` 里的 `.proto` 说了算。R7 把 `proto/` 与两份生成码一起删掉了，所以这两块在删除之前必须先有一份**不依赖那些文件也读得懂**的说法——否则删除那一步会同时删掉「这条记录长什么样」的唯一定义。

这份文档就是那个说法。它描述线上的字节，不描述任何一端的类型。

## 2. 编码规则

形状是 **protobuf 的 JSON 映射**。选它不是因为还想留着 protobuf，而是因为它是一份已经写死的规范：R7 手写编解码时有一份逐字段的参照，而不是一个「当初大概是这么转的」。

| 类型               | 线上                           | 例                                       |
| ------------------ | ------------------------------ | ---------------------------------------- |
| 字段名             | camelCase                      | `updatedAtUnixMs`                        |
| `string` / `bool`  | 原样                           | `"octocat"` / `true`                     |
| `int32` / `uint32` | `number`                       | `42`                                     |
| `int64` / `uint64` | **十进制字符串**               | `"1788557900000"`                        |
| `bytes`            | **base64**（标准表，带 `=`）   | `"3q2+7w=="`                             |
| 枚举               | **枚举值名**                   | `"GITHUB_ISSUE_STATE_OPEN"`              |
| `repeated`         | 数组                           | `[]`                                     |
| 消息               | 对象；**未设置时整个字段缺席** | `"author": { … }` 或没有 `author` 这个键 |
| `oneof`            | 摊平成那**一个**被设置的字段   | `"schedule": { "cron": { … } }`          |

三条额外的规矩：

1. **零值照写**。`""`、`0`、`"0"`、`false`、`[]` 都出现在响应里。一份缺字段的 JSON 和一份字段为零的 JSON 对读者是两句话，而同一条记录只该有一句。**例外**是消息字段与 `optional` 标量：它们有显式的「在不在」，缺席就是缺席。
2. **`int64` 不用 `number`**。Issue 编号、id 与时间戳都是 64 位，`number` 在 2^53 之上会悄悄改值——一条被改了 id 的评论会被贴到别人的行上。
3. **不认识的字段不是拒绝的理由**。一个更新过的 core 写的记录要读得回来；页面侧的 zod 把认不出来的枚举名落回 `*_UNSPECIFIED`，而不是让整页消失。

错误一律 `{ code, message }`。`message` 是给人看的一句话，`code` 是可以分支的机器码——**两张面的 `code` 必须一致**，见 §3.3 与 §4.4。

## 3. 身份

### 3.1 `GET /api/identity/hello`

不要求凭据：它回答的是「这台 core 是谁、支持什么」，而那正是一次配对**之前**就要知道的事。要求一个 `Origin`。

```json
{
  "protocol": { "major": 1, "minor": 0 },
  "hostInstanceId": "0123456789abcdef0123456789abcdef",
  "hostId": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "capabilities": ["identity.native-session.v1", "automation.plans.v1"],
  "maxFrameBytes": 4194304
}
```

`capabilities` 与 `HostService/Hello` 报的是**同一张表**：页面靠 `automation.plans.v1`、`github.issues.v1` 这类名字决定开不开一块面板。改一个名字等于让所有已装机器的那块面板一起熄灭。

### 3.2 两张 JSON 面的认证

`/api/github/*` 与 `/api/automations/*` 都要求：

- 恰好一个 `Origin` 头；
- 写操作要 `X-Armadra-CSRF`（至多一个）；
- 一份会话凭据——原生传输（明文 + 回环来源）读 `Authorization: Bearer`，浏览器会话读 Cookie。

**明文回环上没带凭据的一次调用按本机主人处理**（`core/identity/service.ts` 的 `localOwner`）。桌面壳的会话是原生的，密钥在壳里，既不发 Cookie 也到不了 `apps/web/src/api/request.ts` 的那个 `fetch`；而那台壳就在同一台机器上。TLS 的服务器壳上这条路不存在，凭据仍然是必须的。主人必须是一台**没被撤销的真设备**——自动化的授权记录要拿它的 epoch 复核，一个编出来的设备标识会让计划在第一次投递时被自己的复核拒掉。

### 3.3 稳定的 `code`

GitHub 那一面的 `code` 是 UPPER_SNAKE 拼法——这是延续自历史上 `/rpc/` 兼容面（R7 已删除）的拼法，不是新起的一套：

| HTTP | `code`               | 意思                                         |
| ---- | -------------------- | -------------------------------------------- |
| 400  | `INVALID_ARGUMENT`   | 请求本身不合法                               |
| 401  | `UNAUTHENTICATED`    | 设备会话无效或过期                           |
| 403  | `PERMISSION_DENIED`  | 授权位不够，或 CSRF 没过                     |
| 404  | `NOT_FOUND`          | 仓库 / Issue / PR / 连接不存在，或动词不存在 |
| 409  | `CONFLICT`           | 远端或存下来的修订号变了，重新读             |
| 429  | `RESOURCE_EXHAUSTED` | 触到 GitHub 的限流，等它重置                 |
| 501  | `UNSUPPORTED`        | 这台 core 没有可用的 GitHub 凭据             |
| 504  | `UNKNOWN_OUTCOME`    | 写出去了而结果没读到——**重新读，不要重试**   |

自动化那一面的 `code` 是 snake_case，和其余 `/api/` 一致：`bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`unsupported`、`internal_error`。**两面不同拼法是已知的、历史遗留的**：GitHub 那一面延续了 R7 之前 `/rpc/` 兼容面的拼法（该面已在 R7 删除，拼法留了下来），自动化那一面从一开始就是 `/api/` 的拼法。

## 4. 自动化：`/api/automations/*`

工作空间跟着查询串走：`?workspaceId=<id>`。一次调用可以说它想操作哪个工作空间，不能说它有什么权限。

### 4.1 路由

| 方法   | 路径                                       | 请求体                                              | 响应                                 |
| ------ | ------------------------------------------ | --------------------------------------------------- | ------------------------------------ |
| `GET`  | `/api/automations/plans`                   | —（`?after=&limit=`）                               | `{ plans, nextId, hasMore }`         |
| `POST` | `/api/automations/plans`                   | `{ planId, config, payload, expectedRevision }`     | `PlanSnapshot`                       |
| `GET`  | `/api/automations/plans/{planId}/payload`  | —                                                   | `{ planId, payload, payloadSha256 }` |
| `POST` | `/api/automations/plans/{planId}/activate` | `{ expectedRevision, configVersion, configSha256 }` | `PlanSnapshot`                       |
| `POST` | `/api/automations/plans/{planId}/pause`    | `{ expectedRevision }`                              | `PlanSnapshot`                       |
| `POST` | `/api/automations/plans/{planId}/run`      | `{ expectedRevision }`                              | `RunSnapshot`                        |
| `GET`  | `/api/automations/plans/{planId}/runs`     | —（`?after=&limit=`）                               | `{ runs, nextId, hasMore }`          |
| `GET`  | `/api/automations/command-sessions`        | —（`?after=&limit=`）                               | `{ sessions, nextId, hasMore }`      |
| `POST` | `/api/automations/command-sessions`        | `{ sessionId, rootPath, launch }`                   | `CommandSession`                     |

`PlanSnapshot` 是 `{ plan, revision, configSha256 }`，`RunSnapshot` 是 `{ run, revision }`。`revision` 在这一面是 `number`（修订号是小整数，不是 64 位的时间戳）。

**写入侧收的是普通 JSON**：`config` 是一份 `AutomationPlanConfig`，`launch` 是一份 `CommandLaunchSpec`。0020 之前它们是 base64 的 protobuf（`configBase64` / `launchBase64` / `payloadBase64`），因为那时候库里存的就是字节；现在不是了。

### 4.2 `configSha256`：规范 JSON 的 SHA-256

激活一个计划要带上它的配置摘要，core 拿它确认「你批准的和我存的是同一份」。

摘要 = SHA-256(**规范 JSON** 的 UTF-8 字节)，其中规范 JSON 是：

- 按 §2 编码的那份 JSON；
- 对象的键按名字（UTF-16 码元序）**升序**排列；
- 没有任何空白。

JSON 本身不定义键的顺序，所以一份「原样 stringify」的文本在两个只是插入顺序不同的进程里会算出两个数；排序让「同一份配置」这句话可判定。实现是 `core/schedule/json.ts` 的 `canonicalJson`，唯一的调用点是 `core/schedule/plan.ts` 的 `configHash`。

> **摘要换过一次数。** 0020 之前它是 `toBinary(AutomationPlanConfig)` 的 SHA-256。换掉是因为一个只有 protobuf 序列化器才算得出来的数不能是「这份配置」的身份。直接后果：**升级之后已经激活的计划要重新授权一次**。产品未发布，这是可接受的代价。`command_sessions.launch_sha256` 同理。

### 4.3 载荷是文本

计划的私有载荷（命令的 stdin / Agent 的 prompt）在线上是 **UTF-8 原文**，不是 base64：它本来就是用户自己敲进去的东西，base64 只会让人读不懂自己的计划。

```json
{ "planId": "plan-1", "payload": "跑一次检查", "payloadSha256": "3q2+7w==" }
```

`payloadSha256` 是**那些字节**的 SHA-256 的 base64，计划的配置里 `payloadRef` 指的就是它。库里这一张表（`automation_payloads`）**仍然存字节**：它按内容寻址，换一种表示就会改掉所有已冻结计划指向的那个引用。这是迁移 0020 与本节之间唯一一处「线上和库里不同形状」的地方。

### 4.4 库里存的就是线上发的

迁移 `0020_automation_json.sql` 给 `automation_plans`、`automation_activations`、`automation_runs`、`automation_receipts` 与 `command_sessions` 各加了一个 JSON 列（`payload_json` / `launch_json`），并把原来的 protobuf BLOB 列改成可空。写入只写 JSON 列，读优先读 JSON 列。

存的是 §4.2 的**规范文本**，所以同一条记录在库里只有一种字节。

已经装过的机器在应用完 0020 之后行还是只有 BLOB——SQL 里没有 protobuf 解码器——所以转换由 core 启动时的 `core/schedule/convert-legacy.ts` 做一遍：只碰 `payload_json IS NULL AND payload IS NOT NULL` 的行、一个事务、解不开就整体回滚并拒绝启动。**R7 删掉那个文件与那两个 BLOB 列。**

## 5. GitHub：`/api/github/*`

工作空间同样跟着 `?workspaceId=` 走。

### 5.1 动词

24 个动词各一条 `POST /api/github/<verb>`，`<verb>` 是 RPC 方法名的 kebab-case：

`get-credential`、`configure-credential`、`revoke-credential`、`resolve-repository`、`list-issues`、`get-issue`、`create-issue`、`update-issue`、`set-issue-state`、`comment-issue`、`get-status-mapping`、`put-status-mapping`、`move-issue`、`list-pulls`、`get-pull`、`create-pull`、`submit-review`、`get-checks`、`rerun-checks`、`merge-pull`、`delete-branch`、`link-reference`、`unlink-reference`、`list-references`。

请求体是那个动词自己的参数（不含 `meta`：工作空间在查询串上，身份只来自会话），响应是它的返回消息，两者都按 §2 编码。

> **为什么全是 POST 而不是 REST 的 GET/PUT/DELETE。** 这 24 个动词里有 11 个是读，但它们的参数是一份结构化的过滤器（`GithubIssueFilter` 有六个字段，其中一个是自由文本查询），塞进查询串要么被截断要么要一层自定义编码。统一成「一个动词一条 POST，参数在身体里」让这一面只有一种读法。这是一处与 R7a 任务措辞的偏离，记在[实施进度](../status/typescript-core-status.md) §15.4。

### 5.2 两条不随动词变的规矩

- **列表不带正文。** `list-issues` / `list-pulls` 的每条记录 `body` 都是 `""`：一百条正文装不进一次合理的响应，而一个被截断的正文比一个缺席的更糟——详情请求会把整份拿回来。
- **令牌从不外传。** `configure-credential` 的 `token` 是这一面上唯一会外发的值，而且只是入站；`get-credential` 答的是一份状态（哪种来源、能不能用、账号名），永远不是一次回声。

### 5.3 枚举名

页面按名字分支，所以这些字符串是契约：

- `GithubIssueState`：`GITHUB_ISSUE_STATE_{UNSPECIFIED,OPEN,CLOSED}`
- `GithubPullState`：`GITHUB_PULL_STATE_{UNSPECIFIED,OPEN,CLOSED,MERGED}`
- `GithubStatusSource`：`GITHUB_STATUS_SOURCE_{UNSPECIFIED,NONE,LABEL,PROJECT_FIELD}`
- `GithubWriteState`：`GITHUB_WRITE_STATE_{UNSPECIFIED,APPLIED,PENDING,FAILED,CONFLICTED,SKIPPED}`
- `GithubCheckConclusion`：`GITHUB_CHECK_CONCLUSION_{UNSPECIFIED,PENDING,SUCCESS,FAILURE,NEUTRAL,CANCELLED,SKIPPED,TIMED_OUT,ACTION_REQUIRED,STALE}`
- 其余（`GithubCredentialSource`、`GithubSecretStore`、`GithubIssueStateReason`、`GithubMergeMethod`、`GithubMergeableState`、`GithubReviewState`、`GithubReferenceKind`、`GithubReferenceTargetKind`）同样是 `<ENUM_NAME>_<VALUE>` 的全大写拼法，逐条列在 `apps/web/src/api/github.ts`。

## 6. 历史背景：曾经有两张面说同一句话

`/rpc/armadra.v1.GithubService/*` 与 `/rpc/armadra.v1.AutomationService/*` 是 R7 之前与本文档并存的 protobuf 兼容面。在删除之前，两张面对同一条记录必须说同一句话，各有一条用例逐字段比对：

- `apps/desktop/src/core/github/http.test.ts`「两张面对同一条记录说同一句话」；
- `apps/desktop/src/core/schedule/api.test.ts`「两张面对同一个计划说同一句话」（连 `configSha256` 一起比）;
- `apps/desktop/src/core/identity/http.test.ts`「答一份与 HostService/Hello 逐字段相同的能力表」。

R7 删掉 `/rpc/*` 之后，这三条用例与它们比对的那一半一起消失；现在这三个文件只测本文档描述的 JSON 面本身。

## 7. 节点的上下文读取记录：`GET /api/nodes/{nodeId}/context-reads`

谁读过这个节点的上下文。节点头的「被读取 N 次」读它；写者是跨连线的四个读取动词（`context list|summary|transcript|terminal`），每读一次落一行（设计 `design/agent-delivery.md` §13）。

不挂在 `/api/workspaces/{id}/` 下，因为它问的是一个节点的历史，而节点标识全局唯一。权限与画布同一档（`canvas:read`）。

| 参数    | 位置   | 默认 | 说明                       |
| ------- | ------ | ---- | -------------------------- |
| `limit` | 查询串 | 20   | 最近多少条，上限 200       |

回：

```json
{
  "total": 7,
  "bytes": 91234,
  "reads": [
    {
      "id": "0192…",
      "readerNodeId": "node-1",
      "readerHandle": "planner",
      "readerTitle": "规划",
      "verb": "summary",
      "bytes": 1804,
      "atMs": 1789000000000
    }
  ]
}
```

- `verb` 是四个值之一：`summary` / `transcript` / `terminal` / `content`（内容类节点）。
- `readerHandle` 与 `readerTitle` 在读者节点已被删除时缺席；`readerNodeId` 永远在。
- 从没被读过的节点回 `{"total":0,"bytes":0,"reads":[]}`，不是 404：「没有人读过」是一个答案。
