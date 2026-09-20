# Agent 之间的推式投递与终端驱动

> 状态：目标设计，未实施。本文只定语义、接口形状、表结构与错误码，不写实现代码。
> 范围：`apps/desktop/src/core/{collab,agent,terminal,hook,schedule,browser,identity}`、`apps/web/src/{canvas,store,nodes,terminal}`、`apps/desktop/src/cli/armadra-hook`、`packages/shared/src/api`。
> 前置：[Agent 协作](../guides/agent-collaboration.md)（现状）、[Agent 自动化](agent-automation-design.md) §4–§5（投递与目标闸门）、[Agent 协作通道](agent-collaboration-channels.md) §3（事件映射与 PTY 观测的边界）、[服务器账号、中转与共享](server-accounts-and-sharing.md) S5 / §4.4（`terminal:drive`）、[v3 Agent 终端](../contracts/v3-agent-terminal-plan.md) §3.3 / §3.4 / §5.4 / §5.7 / §5.8。

## §0 结论

| #   | 决定                                                                                                                 | 理由                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 新增动词 `send`：把一段正文写进已连线目标的终端**并回车**。`post` 不变，仍是异步收件箱                               | 今天三件事（`post` / `context-link` / `interrupt`）都要求目标**主动**做点什么；一个停在空闲提示符上的 CLI 永远不会主动做任何事（§1.3）         |
| D2  | `send` 的授权来自连线：源→目标存在链接即编译出 `terminal:drive@<workspace>`；无连线只能 `post`                       | 连线已经是 `post` / `context-link` / `interrupt` 的唯一授权依据，再造第二套授权就会出现「能读不能写」以外的第三种答案                          |
| D3  | 目标状态机五态 `starting / idle / busy / awaiting-approval / exited`，由已归一的 hook 事件驱动，不新增 provider 分支 | `core/hook/normalize/*` 已把六种 CLI 归一成 `working/waiting/blocked/done`；五态是它的投影加上终端域已知的两个事实（会话在不在、刚起来没有）   |
| D4  | 忙碌不是失败：`send` 默认**排队到下一次 idle**，不默认拒绝，也不默认打断                                             | 计划域已经这么做（`schedule/dispatch.ts` 对 `busy` 答「等下一拍」）；两条投递路径对「忙」给不同答案就是两个语义                                |
| D5  | 人优先：人在目标终端敲键或点「接管」即撤销驱动权，在途 `send` 收 `LEASE_HELD_BY_HUMAN` / `LEASE_REVOKED`，队列挂起   | 浏览器节点已有这条完整语义（`browser/lease.ts`），终端节点没有对应物，这是本轮补的对称性                                                       |
| D6  | **租约状态机的代码共用，实例与常数不共用**：`LeaseMachine` 提取到中立模块，终端与浏览器各持一份实例                  | 语义相同（抢占、接管、代次），时间尺度与排队策略不同；共用一个**实例**会让「接管浏览器」顺手撤销「驱动终端」，那不是人点接管时想说的事（§6.2） |
| D7  | 每条边有速率上限、消息带来源链（跳数）、单条长度上限；`send` / `interrupt` 都回结构化回执                            | 两个 Agent 互相 `send` 是一个天然的环；没有跳数与速率，环第一次出现就是一次无人看管的 token 燃烧                                               |
| D8  | Agent 新建的节点不再靠 `--prompt` 走启动行，改为 core 在目标首次进入 idle 之后投第一条                               | `--prompt` 这条路今天**整段丢失**（§8.2 E3）：写进 `initialCommand` 的启动行没有任何代码会去敲它                                               |
| D9  | Agent 有一个稳定的**名字**（`handle`），唯一性在一块画布内，连线时起、节点头展示、投递署名与注入都用它               | 标题是人看的、会被自动命名改写；Agent 之间需要一个不会变的称呼，否则「把这个交给 codex-2」在第二次自动命名之后就指向了别人（§2）               |
| D10 | 节点默认尺寸与新建后的聚焦，两条路径（人手动新建 / Agent 新建）各归一到**一个**来源                                  | 今天是两张表、两条路径，差一倍尺寸且 Agent 建的节点不聚焦（§9）                                                                                |

## §1 问题陈述与现状对照

### §1.1 实测场景（2026-09-20，用户）

画布上一个 Claude Code 终端节点连着若干 Codex 节点。Claude 用 `armadra-hook canvas post` 把任务投进对方收件箱，又用 `canvas open-agent --prompt` 新建了两个 Codex 节点。结果：四个 Codex 全停在空闲提示符「Ask Codex to do anything」，收件箱没人读，新建的两个也没有开工。

三件事各自的失效方式不同，下面逐条拆开。

### §1.2 今天的三样东西，各自的触发条件

| 能力           | 入口                                                            | 写入方向                     | 触发条件                             | 目标空闲时会发生什么                       |
| -------------- | --------------------------------------------------------------- | ---------------------------- | ------------------------------------ | ------------------------------------------ |
| 收件箱         | `canvas post` / `inbox` / `ack`（`collab/mailbox.ts`）          | 只写 `agent_mailbox` 表      | **目标自己**调用 `inbox`             | 什么都不发生：没人调用 `inbox`             |
| 按连线读上下文 | `context list/summary/transcript/terminal`（`context-link.ts`） | 只读                         | **调用者自己**想读时                 | 什么都不发生                               |
| 打断           | `canvas interrupt`（`collab/control/interrupt.ts`）             | 向目标 PTY 写一个 `ESC`      | 发起者调用；无空闲门，有前台进程门   | 空操作：空闲提示符上的 Escape 什么也不做   |
| 计划投递       | `schedule/dispatch.ts`（自动化域）                              | 向目标 PTY 写括号粘贴 + `\r` | **到期的计划**，且目标探测为 `ready` | 会真的投进去——但只有用户自己定义的计划能用 |

结论：**今天唯一能把一段文字送进另一个终端并提交的代码路径是计划域的 `TerminalDispatcher.dispatch`**（`schedule/dispatch.ts:195-199`），它写 `PASTE_START + sanitizePaste(text) + PASTE_END + "\r"`，且明确要求包裹与回车是同一次写。协作域没有任何动词能走到这一步：`interrupt` 里的 `ESCAPE` 是文件内常量，注释写明「这个动词一旦接受调用者的文字就不再是打断」。

### §1.3 为什么空闲的 Codex 永远不会拉

`post` 的成功回执写得很清楚：「Stored message …; recipient reads it with canvas inbox. No terminal input was sent.」（`mailbox.ts:246`）。收件箱是一张表，读它需要目标发起一次 `armadra-hook canvas inbox`。而一个停在空闲提示符上的 CLI 处在「等待用户输入」状态：它不会自发执行工具调用，技能文件里还明说「别轮询信箱」（`collab/skill.ts`）。于是拉取式协作对**正在进行一轮**的 Agent 有效（它在某个工具间隙可以去读），对**空闲的** Agent 结构性无效。

这不是实现缺陷，是拉取模型的定义域：拉取需要一个还在运行的拉取者。

### §1.4 `--prompt` 为什么不回车（两层原因）

**第一层（今天的真实行为）：直投路径上 `--prompt` 的文字根本没有被敲进去。**

`canvas open-agent` 在没有 `--after` 时写的是 `agent.initialCommand = command`（`collab/control/nodes.ts:135`）。而全仓库没有任何代码把 `initialCommand` 当作**要执行的东西**读出来：

| 位置                                             | 对 `initialCommand` 做什么                                |
| ------------------------------------------------ | --------------------------------------------------------- |
| `apps/web/src/terminal/surface/use-launch.ts:61` | 忽略它，用 `buildAgentLaunch(agent)` **重新拼**一条启动行 |
| `apps/web/src/terminal/surface/use-launch.ts:68` | 用自己拼出来的那条**覆盖**它                              |
| `apps/web/src/agent/pending-launch.ts:132`       | 同样是事后记账                                            |
| `apps/desktop/src/core/canvas/validation.ts:326` | 只校验长度                                                |

`buildAgentLaunch(agent)`（`apps/web/src/agent/launch.ts:131`）的 `prompt` 形参在这条路径上是 `undefined`，所以拼出来的是一条**不带提示词**的裸启动行。`initialCommand` 在这个系统里是「这次连接敲了什么」的**记账**，不是指令。人手动新建带命令的终端走的是另一条路：`CommandPalette.tsx:82-85` 与 `SidebarSearch.tsx:128-129` 同时写 `initialCommand` **和** `pendingLaunch {command, after: []}`，真正被敲的是 `pendingLaunch.command`。

也就是说：`canvas open-agent --agent codex --prompt "…"` 今天等价于 `canvas open-agent --agent codex`；只有额外带了 `--after` 才会走 `pendingLaunch` 分支（`nodes.ts:137`），那条分支的命令是逐字敲进去的。

**第二层（即使敲进去了）：位置参数对 Codex 是预填而不是提交。**

`launchCommand`（`core/agent/launch.ts:287-300`）对 `promptMode: "argv"` 的 CLI 生成 `codex '正文'`。Codex 把命令行上的位置参数放进 composer 等用户回车——这正是用户看到的「文字填进输入框不回车」。Claude 的同形状参数会直接开一轮。**同一个 `promptMode: "argv"` 覆盖了两种不同的行为**，注册表里没有区分它们的位。

结论：启动行不是投递通道。启动行的职责是「把 CLI 起起来」，第一条任务应该由一次真正的投递完成（D8、§8）。

### §1.5 浏览器节点与终端节点：谁在驱动

| 维度             | 浏览器节点（已有）                                                                   | 终端节点（没有）                                     |
| ---------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Agent 的写入动词 | 17 个（`browser/verbs.ts`，`armadra-hook browser …`）                                | 只有 `interrupt`，且不带正文                         |
| 谁在驱动         | `LeaseMachine`，四态 `free / human / agent / humanTakeover`                          | 无；`DriveBook` 只回答「写入者是不是创建者」         |
| 人抢占           | 人的任意输入立刻夺走租约（`lease.ts:261-263`）                                       | 无                                                   |
| 人接管           | 显式接管后 Agent 一律被拒，直到交还（`lease.ts:286-293`）                            | 无                                                   |
| Agent 等人的上限 | `AGENT_QUEUE_MS = 5s`，超时拒绝而不是无限排队                                        | 无                                                   |
| 稳定错误码       | `LEASE_HELD_BY_HUMAN` / `LEASE_REVOKED` / `LEASE_HELD_BY_AGENT` / `LEASE_GENERATION` | 无（协作域的 `Refused.code` 是按状态码推的泛码）     |
| 界面可见         | 节点头租约徽标、活动条（`browser.lease` / `browser.activity` 事件）                  | 无                                                   |
| 代次             | `leaseGeneration`，客户端可带 `expected` 做乐观并发                                  | 终端有 `generation`，但它是 PTY 代次，不是驱动权代次 |

差距一句话：**浏览器节点已经回答了「现在谁在驱动这块屏幕」，终端节点还没有这个问题的答案。** 本文把这个答案补上，并让两边共用同一套词汇（§6）。

## §2 Agent 的名字

### §2.1 名字与节点标题的关系

| 项       | 标题 `node.title`                                   | 名字 `handle`                                         |
| -------- | --------------------------------------------------- | ----------------------------------------------------- |
| 给谁看   | 人                                                  | Agent 之间互相称呼                                    |
| 稳定性   | 不稳定：首个 Hook 回合后会自动命名一次（自动化 §8） | 稳定：只有显式改名会变                                |
| 形状     | 自由散文，≤160 字符                                 | `^[a-z0-9][a-z0-9_-]*$`，≤24 字符，大小写折叠         |
| 例子     | 「复查 src/api 的错误返回」                         | `codex-1`、`reviewer`                                 |
| 唯一性   | 无                                                  | 一块画布（board）内唯一                               |
| 改名审计 | 不写                                                | 写（`audit(principal, "canvas.handle.set", nodeId)`） |

`handle` 不是新概念：`collab/addressing.ts` 已经定义了它的规范化（`normalizeHandle`，`MAX_HANDLE_CHARS = 24`）、解析优先级（id → handle → 标题精确 → 标题子串）与「歧义一律拒绝」。本节要做的是把它从一个**只有 `canvas rename --handle` 能写、界面上看不见、没人知道它存在**的隐藏字段，抬成产品里正式的「Agent 的名字」。

自动命名与名字互不干涉：自动命名只改标题；标题改了名字不动；名字改了标题不动。这一条要写进自动命名那段的实现注释里，否则第一次自动命名就会有人顺手把 handle 也刷了。

### §2.2 起名的入口

| 入口                     | 落点                                                                                       | 默认值                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 拉出连线落到目标时弹命名 | `apps/web/src/canvas/connection.ts` 完成一条 `link` 边之后                                 | 两端各自缺名字的才弹；默认 `<agentId>-<序号>`，序号是该画布内该 agent 已占用名字的最小空位 |
| 节点头「更多 → 名字」    | `apps/web/src/nodes/NodeShell.tsx` 的节点菜单                                              | 现有名字，或同上的建议值                                                                   |
| `canvas link --name`     | `collab/control/edits.ts::link`，新增 `--name-from` / `--name-to`（`--name` 是后者的别名） | 不给就不起名，不自动编一个                                                                 |
| `canvas rename --handle` | 已存在，不变                                                                               | —                                                                                          |

命名弹窗的规矩：**可以跳过**。名字是给协作用的，一块只有一个 Agent 的画布不需要它；跳过之后连线照样建立，`send` 照样可用（`--to` 仍接受 id 与标题）。冲突时当场报「这个名字属于「X」」并把建议值换成下一个空位，不静默改写。

默认序号只看**本画布**：`codex-1` 在另一块画布上可以再出现一次。

### §2.3 展示

| 位置                     | 展示形式                                          | 落点                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 节点头                   | Agent chip 之后一个 `@codex-1` 小徽标，点击即改名 | `apps/web/src/nodes/NodeShell.tsx` 头部插槽（契约 §3.4 的头部顺序里插在 Agent chip 与上下文胶囊之间）                                                                           |
| 终端内状态行（Claude）   | 已装的 `statusLine` 追加 `@<handle>`              | `core/hook/install/claude.ts` 的托管 `settings.json`；**只在我们自己写那条状态行时**追加，用户自己的状态行一个字节不动（该文件的模块注释已写明这条规矩）                        |
| 终端内状态行（其余五种） | 不做                                              | Codex / Copilot / OpenCode / Pi / OMP 没有可写的状态行；名字改由 §2.4 的注入与节点头承担。**不发明**一种往 PTY 里写装饰行的机制——那会污染转录，也会被 `context terminal` 读回去 |
| `context list`           | 每行加 `名字=<handle>`                            | `collab/context-link.ts:175` 的 `renderList`                                                                                                                                    |
| `canvas inbox`           | 每条消息加 `fromHandle`                           | `collab/mailbox.ts:295-305` 的行映射（已有 `from` / `fromTitle`，补第三个字段）                                                                                                 |
| `canvas list`            | 每行加 `名字`                                     | `collab/control/nodes.ts:37-51`                                                                                                                                                 |
| 连线                     | 边上小标签显示两端的名字（仅在两端都有名字时）    | `apps/web/src/canvas/derived-edges.ts`                                                                                                                                          |

### §2.4 注入给 Agent

Agent 要知道两件事：**我叫什么**，以及**我连着谁**。三条通道，按可靠性排列：

| 通道               | 内容                                                                                            | 落点                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 环境变量           | `ARMADRA_NODE_NAME=<handle>`，与已有四个地址变量同一批注入                                      | `core/terminal/environment.ts:228-231`（`ARMADRA_NODE_ID` 那张表加一行），并同步 `cli/armadra-hook/usage.ts` 的 ENVIRONMENT 段 |
| 技能文本           | 「你在画布上的名字由 `ARMADRA_NODE_NAME` 给出；`context list` 会列出连着谁、各自叫什么」        | `core/collab/skill.ts::skillBody`，同时 `SKILLS_REVISION` +1                                                                   |
| session-start 回执 | hook 的 `SessionStart` 事件回执里带 `{nodeName, peers:[{handle,title,kind}]}`，供扩展型适配展示 | `core/hook/ingest.ts` 的响应体；命令 Hook 是 fire-and-forget，**不能**指望它读回执，所以这条只是加分项，不是依赖               |

不往 CLI 的系统提示词里塞名字：AGENTS.md 的边界是「不把一个 Agent 的系统提示词复制给另一个」，同理也不该由我们去改它的系统提示词。名字通过环境变量 + 技能说明到达，模型要用的时候自己读。

署名：`send` 与 `post` 的正文头部署名一律用**名字**，没有名字才退回标题：

```
from: reviewer (7f3a…)          # 有名字
from: 「复查 src/api」 (7f3a…)   # 没有名字
```

这行是应用生成的信封头（契约 §5.7 的五行信封形状），发起者不能注入，换行按 `collapseNewlines` 折叠。

### §2.5 存哪张表（迁移 `0021`）

名字今天存在 `node.data.handle` 里，用一次全画布扫描保证唯一（`collab/control/edits.ts:137-144`）。那是一次读-判-写，不是一次原子约束：两个 Agent 同时改名会双双通过。抬成产品概念之后要有真约束。

```sql
-- 0021_agent_names.sql（预分配编号；0020 是当前最后一条）
CREATE TABLE node_handles (
  board_id   TEXT NOT NULL,
  handle     TEXT NOT NULL,
  node_id    TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board_id, handle)
);
CREATE INDEX node_handles_node ON node_handles(node_id);
```

规则：

1. **这张表是唯一来源。** `loadHandles`（`collab/addressing.ts:69`）改读这张表而不是 `data_json`；`node.data.handle` 保留为**渲染副本**，在同一个事务里写，页面据此画徽标而不必再查一次。副本与表不一致时以表为准，由一个用例守（`repo:check` 管不到这条）。
2. 名字随节点删除而释放（删节点时同事务删这一行）。
3. 跨画布移动节点 = 换 `board_id`：冲突时拒绝移动并说明是哪个名字冲突，不静默改名。
4. 改名写审计：`audit({ action: "canvas.handle.set", target: nodeId, workspaceId, detail: { from, to } })`，走 `core/identity/audit.ts` 已有的模块级 sink，不新建审计表。
5. 迁移里把现存 `node.data.handle` 回填进表；回填时撞名的保留 `updated_at` 较早的那个，另一个的副本字段清掉并在日志里报出来——不猜一个新名字。

### §2.6 连线的角色：对等与主从（2026-09-21 追加）

连线不只是「谁能读谁」，还要说得出**谁是主、谁是从**：主 Agent 用 `open-agent` 开出来的从属节点，与人在画布上拉出的对等连线，是两种关系。

| 项           | 对等 `peer`                                          | 主从 `supervises`                                                                                                                                    |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 怎么来       | 人拉线、`canvas link`（默认）                        | `open-agent` 自动建（`from` 是主、`to` 是从）、`link --role supervises`                                                                              |
| `send`       | 按 §3 的规则双向                                     | 主 → 从：可 `send` / `interrupt` / `cancel`；从 → 主：只能 `post`，`send` 回 `UPWARD_SEND_REFUSED`，除非主在节点设置里开「允许从向我投递」（默认关） |
| 读取         | 双向 `context`                                       | 双向 `context`                                                                                                                                       |
| 展示         | 现有实线                                             | 带箭头的定向边（箭头指向从），品牌色；主节点头「主 · N 从」，从节点头「从 @主」                                                                      |
| 命名         | 拉线落到目标时的命名对话框多一个角色单选（默认对等） | 不弹框，从的默认名 `<agent>-<n>`                                                                                                                     |
| Agent 看到的 | `context list` 角色列「对等」                        | 角色列「主 / 从」；技能文本「你是 @a 的从」「你的从有 @b、@c」；`ARMADRA_NODE_ROLE=main                                                              | sub` |
| 主离开       | —                                                    | 从继续跑，边删掉，从节点头「主已离开」                                                                                                               |

存储：连线记录加 `role` 列（迁移 `0024`），投影进画布文档的边数据（字段名 `role`）。不做多级树的显式维护：主的主仍是主从边，层级由边自然表达；跳数与环检测（§7）不区分角色。

## §3 投递语义：`post` 与 `send`

### §3.1 两个动词，一句话的差别

| 动词   | 落点                      | 目标要做什么      | 目标空闲时的效果 | 需要连线 | 需要目标有会话 |
| ------ | ------------------------- | ----------------- | ---------------- | -------- | -------------- |
| `post` | `agent_mailbox` 表        | 自己 `inbox` 来读 | 无（§1.3）       | 是       | 否             |
| `send` | 目标 PTY：括号粘贴 + `\r` | 什么都不用做      | **开一轮**       | 是       | 是             |

`post` 不被 `send` 取代。两者的分工是明确的：

- 有明确的「请你现在做这件事」→ `send`；
- 「我这边完了，材料在这里，你方便时看」→ `post`；
- 目标没有会话、没有 hook、或发起者不确定该不该打扰 → `post`。

`send` 成功只表示**写进去了**，不表示对方做了、做对了、做完了。这与计划域的规矩一致（`schedule/dispatch.ts:41-42`：「送到不是做完」），回执里的 `outcome` 永远不会出现 `succeeded`。

### §3.2 授权：连线编译出 `terminal:drive`

判定链，按顺序，任一不过即拒绝：

1. **节点令牌**：调用者持有本 core 签发的节点令牌（`caller.verdict === "verified"`，`collab/control/index.ts:147`）。
2. **连线**：目标在调用者**自己的**链接文档里（`getContextLinks(database, caller.node.id)`）。不在 → `NOT_LINKED`（403）。链接文档是 core 的表，不是界面上的那张图。
3. **同工作空间**：连线残留不能跨工作空间生效（与 `interrupt` 同条，`control/interrupt.ts:71-77`）。
4. **能力位**：双方 `contextLink` 能力都开着（自定义 Agent 可以关掉）。
5. **scope**：`allows([scope("terminal:drive", workspaceId)])`。今天本机只有 owner，判定恒真；**判定入口现在就要放在 `send` 的路径上**，理由与 `server-accounts-and-sharing.md` §4.4 相同——等到有第二个 principal 再找一遍，找漏一条就是一个人替另一个人点了「允许」。
6. **前台进程门**：目标 PTY 的前台仍是它声称的那个 Agent（`agent/launch.ts::paneRunsAgent`）。不是 → `TARGET_NOT_AGENT_PANE`。
7. **租约**：见 §6。

第 2 步与第 5 步的关系写清楚：**连线是 scope 的编译来源**。一条 `link` 边落库时，源节点对目标节点获得 `terminal:drive@<workspaceId>` 的**隐式**授予；删掉连线即收回。这与 `server-accounts-and-sharing.md` 的角色编译表（`roleScopes`）不冲突：那张表编译的是**人**的角色，这里编译的是**节点之间**的一条边，两者最终落在同一个 `permits` 判定上（`identity/authorize.ts` / `gate.ts`）。

没有连线时 `send` 一律拒绝，且拒绝文案要给出可执行的下一步：「先在画布上连一条线，或者用 `canvas post` 留一条收件箱消息」。

### §3.3 命令行形状

```sh
# 投进去并回车
armadra-hook canvas send --to <名字|id|标题> --body '正文' [--key <幂等键>]

# 目标忙时不排队，直接拒绝（给不想等的调用者）
armadra-hook canvas send --to reviewer --body '…' --no-queue

# 先打断当前这一轮再投（显式，绝不是默认）
armadra-hook canvas send --to reviewer --body '…' --interrupt

# 排队里那些还没投出去的
armadra-hook canvas outbox [--to <名字|id>] [--limit 20]
armadra-hook canvas cancel --id <queued-id>

# 演练
armadra-hook canvas send --to reviewer --body '…' --dry-run
```

`--body` 的约束与 `post` 一致并更严：`stripControl` 去掉 C0 控制字符（`collab/refusals.ts:190`），长度上限见 §7。`--key` 可选；给了就幂等（同源、同目标、同 key、同正文重发返回原 id，同 key 不同正文 409），不给就每次都是一条新投递。

`VERBS`（`collab/control/index.ts:35`）从 14 个变成 17 个：`send`、`outbox`、`cancel`。`LEGACY_VERBS`（无令牌可用的只读动词）不变。技能文本（`collab/skill.ts`）与 `USAGE`（`cli/armadra-hook/usage.ts:80-88`）同批更新——后者被 `wire.test.ts` 逐字节比对，是夹具不是文档。

### §3.4 HTTP 路由

复用已有的 hook 面家族（`hook/server.ts:74` 的 `control` 家族），不新开监听、不新造凭据：

| 路由                   | 请求体                                                         | 200 响应                                                                                               |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /control/send`   | `{nodeId, args:{to, body, key?, queue?, interrupt?, dryRun?}}` | `{ok:true, protocol:"armadra.delivery.v1", outcome, id, queuePosition?, traceId, targetState, traced}` |
| `POST /control/outbox` | `{nodeId, args:{to?, limit?}}`                                 | `{ok:true, items:[{id, to, toHandle, queuedAt, expiresAt, position, bodyChars}]}`                      |
| `POST /control/cancel` | `{nodeId, args:{id}}`                                          | `{ok:true, cancelled:boolean}`                                                                         |

`outcome` 是一个闭集：

| `outcome`   | 含义                                   | 可重试    |
| ----------- | -------------------------------------- | --------- |
| `delivered` | 括号粘贴与回车已经写进 PTY             | 否        |
| `queued`    | 目标忙，已排队；`queuePosition` 给序号 | 否        |
| `unknown`   | 写到一半失败，不知道对面收到了多少     | **否**    |
| `refused`   | 被拒，`code` 给原因                    | 视 `code` |

`unknown` 不可重试这一条与 `schedule/dispatch.ts:200-208` 同义：写了一半再写一遍是把「不知道」当成「安全」。

页面侧的只读面用已有的常规路由：`GET /api/workspaces/{id}/deliveries`（`collab/deliveries.ts`）今天没有写者；本设计让 `send` 成为它的写者，把 `agent_deliveries` 表（迁移 0006，已发布）重新用起来，不新增表。

### §3.5 稳定错误码表

码是机器码，原样显示不翻译（与 `status §20.4`「页面按 `code` 取，`message` 只兜底」一致）。`LEASE_*` 四个与浏览器域**同名同义**，从共用模块导出（§6.2）。

| code                       | HTTP | 含义                                                       | 调用者该做什么                             |
| -------------------------- | ---: | ---------------------------------------------------------- | ------------------------------------------ |
| `NOT_LINKED`               |  403 | 目标不在调用者的链接文档里                                 | 连一条线，或改用 `post`                    |
| `TARGET_NOT_TERMINAL`      |  400 | 目标不是终端节点                                           | 换目标                                     |
| `TARGET_GONE`              |  404 | 目标没有在运行的会话                                       | 改用 `post`；节点起来后会有人读            |
| `TARGET_NOT_AGENT_PANE`    |  409 | 前台跑的不是它声称的那个 Agent                             | 不重试，告诉用户                           |
| `TARGET_STARTING`          |  409 | 会话刚起来，还没报过第一条状态                             | 排队（默认）或稍后再来                     |
| `TARGET_BUSY`              |  409 | 目标正在一轮里（`--no-queue` 时才会看到）                  | 排队，或 `--interrupt`                     |
| `TARGET_AWAITING_APPROVAL` |  409 | 目标停在权限提示或提问上                                   | **绝不重试**：写进去就是替人回答了那个问题 |
| `TARGET_STATE_UNVERIFIED`  |  409 | 目标没有状态适配，只有 PTY 观测（§4.3）                    | 改用 `post`，或显式 `--unverified`         |
| `LEASE_HELD_BY_HUMAN`      |  409 | 人正在这个终端里打字                                       | 等；不要循环重试                           |
| `LEASE_REVOKED`            |  409 | 人按了「接管」                                             | 停手，读 `outbox` 并告诉用户               |
| `LEASE_HELD_BY_AGENT`      |  409 | 另一个 Agent 正在驱动它                                    | 等它的空闲窗口过期                         |
| `LEASE_GENERATION`         |  409 | 调用者手里的代次已经不是当前的                             | 重新读状态再决定                           |
| `RATE_LIMITED`             |  429 | 这条边的速率上限                                           | 退避；回执带 `retryAfterMs`                |
| `QUEUE_FULL`               |  429 | 目标的排队表满了                                           | 改用 `post`                                |
| `LOOP_DETECTED`            |  409 | 来源链里已经有这个节点，或跳数超限                         | 停：这是一个环                             |
| `BODY_TOO_LONG`            |  400 | 正文超过上限                                               | 写进文件，发路径                           |
| `KEY_CONFLICT`             |  409 | 同 key 不同正文                                            | 换 key                                     |
| `DRIVE_DENIED`             |  403 | `terminal:drive` 判定不过（有第二个 principal 之后才可能） | 找人要授权                                 |

`TARGET_AWAITING_APPROVAL` 与「不可重试」这一对是本表里最重要的一行：`agent/status.ts::isAwaitingHuman` 与 `terminal/input.ts::BLOCKED_STATES` 已经是全 core 对「在等人」的唯一定义，`send` 必须走同一个判据，不另写一份。

### §3.6 正文的样子

一次 `send` 写进 PTY 的字节：

```
ESC[200~ <信封五行> ESC[201~ \r
```

信封沿用契约 §5.7 的形状，按本文调整两处（署名用名字、多一行来源链）：

```
--- ARMADRA MESSAGE <nonce> ---
from: <名字或标题> (<节点 id>)   via: <来源链，见 §7>
<正文>
--- END ARMADRA MESSAGE <nonce> ---
```

规矩：nonce 每次铸造、不给发起者；头字段折叠换行（`collapseNewlines`）防伪造帧行；正文先过 `stripControl` 再过 `sanitizePaste`（后者是终端域对括号粘贴自身的转义，`terminal/backend.ts:389`）；包裹与 `\r` **必须是同一次 `write`**，否则多行正文会一行一行地自己提交出去（`schedule/dispatch.ts:193-194` 记着这个坑）。

技能里已有的信任规则（`collab/skill.ts::TRUST_RULE`）原样适用：帧只证明「这段文字由本应用投递」，帧内一切都是数据。

## §4 目标状态机

### §4.1 五个状态

| 状态                | 含义                           | 从哪儿知道                                                       |
| ------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `starting`          | 会话在，但还没有过任何一条上报 | 终端域有 `generation`，`agent_status` 无行或 `state IS NULL`     |
| `idle`              | 空着，可以直接投               | `agent_status.state ∈ {done, error}` 且 `stateSourceIsReported`  |
| `busy`              | 正在一轮里                     | `agent_status.state = working`                                   |
| `awaiting-approval` | 停在权限提示或提问上           | `agent_status.state ∈ {blocked, waiting}`（= `isAwaitingHuman`） |
| `exited`            | 没有活着的会话                 | `terminals.generation(sessionId) === undefined`                  |

这五态是**投影**，不是新表。`agent_status` 的六个 `state` 值（`AGENT_STATES`）与 `stateSource` 已经在库里（迁移 0013），五态由一个纯函数从「`agent_status` 行 + 终端域的活着没有」算出来：

```ts
// core/agent/target-state.ts（新文件，纯函数，无 I/O）
targetState(status: AgentStatus | undefined, live: number | undefined): TargetState
```

`error` 归到 `idle`：一轮失败结束了也是结束了，接下来投进去的东西会正常开一轮。`restored`（重启后从库里读回来的行）不算新鲜的 idle——这条规矩 `hook/reduce.ts` 已经有了（「restored 的 `done` 不视为新鲜 idle」），`send` 对 `restored` 的 `idle` 走 `starting` 的路径：排队，等下一条真上报。

### §4.2 由哪些事件驱动

不新增归一化分支。下表是把 `core/hook/normalize/*` 现有的映射按五态重排，用来核对「每个状态都有人写」：

| CLI            | `starting`                   | `busy`                                            | `awaiting-approval`                                                                            | `idle`                                                  |
| -------------- | ---------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Claude Code    | `SessionStart`               | `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | `PermissionRequest`；`PreToolUse` 的 `AskUserQuestion` / `ExitPlanMode`；权限型 `Notification` | `Stop` / `StopFailure`；空闲型 `Notification`（仅救援） |
| Codex          | `SessionStart`               | `UserPromptSubmit` / `Pre`/`PostToolUse`          | `PermissionRequest`；`request_user_input`（工具名或通知类型两种形态）                          | `Stop` / `Interrupt`                                    |
| GitHub Copilot | `sessionStart`（按形状识别） | `userPromptSubmitted` / `postToolUse`             | `notification` 且 `notification_type = permission_prompt`                                      | `agentStop`                                             |
| Pi / Oh My Pi  | `session_start`              | `before_agent_start` / `tool_call`                | 无（扩展不替 CLI 造权限对话）                                                                  | `agent_end`；`agent_settled`（权威空闲）                |
| OpenCode       | 插件的 session 事件          | 插件的回合事件                                    | 无                                                                                             | 插件的 idle 事件                                        |

三条已有的归约规则对 `send` 直接有效，不要再写一份：**done 保持 3s**（迟到的 `working` 不复活刚结束的回合）、**idle 救援只能把 `working` 变 `done`**、**awaitingInput 保持**（未回答的问题把它那一轮的 `done` 改写成 `waiting`）。没有它们，一次 `send` 会在 `Stop` 与迟到的 `PostToolUse` 之间的缝里投进一个正在收尾的回合。

### §4.3 没有 hook 的 CLI：提示符就绪启发式

自定义 CLI、或用户拒绝安装适配的节点，`stateSource` 是 `observed` 或空。协作通道 §3.4 已经定死：**`observed` 不得满足空闲门**。本设计不推翻它，而是把「那该怎么办」写清楚。

启发式（只有一条，且只用于**降级**，不用于放行）：

> 终端域知道最近一次输入围栏的状态（`InputSafety.pending`，`terminal/input.ts:98`）与之后有没有新输出。输入后 `OBSERVED_QUIET_MS = 2000` 内没有新输出，且 `InputSafety.pending === false`（没有半截的行），叫 `observed-quiet`。

对 `send` 的作用：

| 目标的 `stateSource`        | 默认行为                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `hook` / `extension`        | 按 §4.5 的表                                                                               |
| `observed` 或空             | **拒绝**，`code = TARGET_STATE_UNVERIFIED`，除非调用者显式带 `--unverified`                |
| `observed` + `--unverified` | 要求 `observed-quiet`，回执里标 `targetState:"observed-quiet"`，`outcome` 仍是 `delivered` |

误判面，逐条写明，因为选择这条路的人应该知道自己在赌什么：

1. **半截的行**：`InputSafety` 只解析到「有没有未提交的行」这个深度；一个 CLI 用自己的行编辑器吃掉了 `\r` 又没回显，`pending` 会是 `false` 而行还在——投进去就是拼接。
2. **安静的忙碌**：一个跑 30 秒无输出编译的 CLI，与一个空闲提示符，在这条启发式下完全一样。
3. **权限提示**：`observed` 节点上 `isAwaitingHuman` 永远是 `false`（`agent/status.ts:158-165`：「没人报过 ≠ 被阻塞」），所以这条路**不能**保证不替人回答权限问题。这是「拒绝成为默认行为」的唯一理由。
4. **前台不是它**：前台进程门（§3.2 第 6 条）仍然跑，挡住了「用户在那个 pane 里开了别的东西」这一类。

界面上 `--unverified` 投出去的每一条都在连线上标一个不同的图标，并在节点头写「未经证实的投递」。

### §4.4 状态存哪

| 东西               | 存哪                                          | 为什么                                         |
| ------------------ | --------------------------------------------- | ---------------------------------------------- |
| 归约后的状态       | `agent_status` 表（已有）                     | 唯一来源，重启后 `restored`                    |
| 五态投影           | 不存，每次算                                  | 它是两个已有事实的函数，存下来就会有第三个答案 |
| 归约器的进程内记忆 | `hook/reduce.ts` 的 `Memory`（已有，不落盘）  | `doneAt` / `awaitingInput` 是时序，不是状态    |
| 驱动租约           | 进程内（§6），代次落 `terminal_sessions` 一列 | 与浏览器一致：重启后没人持有，代次不回头       |
| 排队               | 新表 `agent_send_queue`（§4.6）               | 排队要活过页面刷新与 core 重启                 |

### §4.5 `send` 在每个状态下做什么

| 目标状态            | 默认（`queue = true`） | `--no-queue`                    | `--interrupt`                                                                                                   |
| ------------------- | ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `idle`              | 直接投 → `delivered`   | 直接投                          | 退化为普通投递（不发 `ESC`：对空闲提示符它是空操作，发了只是多一次写）                                          |
| `busy`              | 排队 → `queued`        | 拒绝 `TARGET_BUSY`              | 发 `ESC`，等一条 `idle` 或 `interrupted` 上报（上限 `INTERRUPT_SETTLE_MS = 5000`），到了就投；没等到 → `queued` |
| `awaiting-approval` | **排队**，不投         | 拒绝 `TARGET_AWAITING_APPROVAL` | **拒绝**，`TARGET_AWAITING_APPROVAL`：`ESC` 落在一个权限提示上的语义是「拒绝这次工具调用」，那是替人做决定      |
| `starting`          | 排队 → `queued`        | 拒绝 `TARGET_STARTING`          | 同默认（没有「当前这一轮」可打断）                                                                              |
| `exited`            | 拒绝 `TARGET_GONE`     | 同左                            | 同左                                                                                                            |

一条硬规矩，与 `schedule/dispatch.ts:34-39` 同源：**`awaiting-approval` 的节点在任何参数组合下都不会被写入正文。**

排队项出队时**重跑整条门链**（授权、连线、工作空间、前台进程、租约、状态），而不是只看状态——这是契约 §5.7 第 9 条已经定过的规矩。

### §4.6 排队表

```sql
-- 与 0021 同一批，或紧随其后
CREATE TABLE agent_send_queue (
  id             TEXT PRIMARY KEY,           -- uuidv7，也是 outbox / cancel 的句柄
  workspace_id   TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  origin         TEXT NOT NULL,              -- 'send' | 'mailbox-wake' | 'first-task'
  message_key    TEXT,                       -- 幂等键，可空
  body           TEXT NOT NULL,
  hops           INTEGER NOT NULL DEFAULT 0, -- 来源链长度，§7
  trail          TEXT NOT NULL,              -- JSON 数组：来源节点 id 链
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL,              -- 'queued' | 'delivering' | 'done' | 'cancelled' | 'expired'
  last_reason    TEXT                        -- 上一次没投出去的 code
);
CREATE INDEX agent_send_queue_target ON agent_send_queue(target_node_id, state, created_at);
CREATE UNIQUE INDEX agent_send_queue_key
  ON agent_send_queue(source_node_id, target_node_id, message_key)
  WHERE message_key IS NOT NULL AND state IN ('queued','delivering');
```

| 项         | 值                                                                    | 理由                                                       |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| TTL        | 5 分钟（`SEND_QUEUE_TTL_SECONDS = 300`）                              | 契约 §5.7 第 9 条的数字；五分钟前的指令投进去多半已经过时  |
| 每目标上限 | 16（`SEND_QUEUE_MAX_PER_TARGET`）                                     | 同上；满了回 `QUEUE_FULL`                                  |
| 容量检查   | 与插入同一条 SQL（`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < ?`） | 与 `mailbox.ts:200-220` 同一手法，并发发送不能突破上限     |
| 出队       | 目标进入 `idle` 的那条 `agent.status` 事件驱动；**不轮询**            | 与收件箱一样不留后台常驻轮询；另有每 60 秒一次的过期清扫   |
| 串行       | 同一目标同时只有一条 `delivering`（按 `target_node_id` 的进程内互斥） | 「多条计划不交错粘贴」是自动化 §5 已有的要求，沿用同一道门 |
| 可见性     | 发起者 `canvas outbox`；目标节点头「排队 N」徽标；收件箱面板一个页签  | 排在别人终端前面的东西，被排队的那个人要能看见             |
| 取消       | 发起者 `canvas cancel --id`；目标侧的人在面板上也能删（等于拒收）     | 人对自己的终端有最终决定权                                 |

## §5 收件箱唤醒

目标从任意状态进入 `idle`、且它有未 ack 的收件箱消息时，core 往队列里塞一条 `origin = 'mailbox-wake'`：

| 节点设置（`data.agent.inboxWake`） | 行为                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `off`（默认）                      | 不做任何事，和今天一样                                                          |
| `notify`                           | 投一句短提示：「你有 N 条未读的画布消息，`armadra-hook canvas inbox` 可以读」   |
| `deliver`                          | 直接把最早那条未读的正文按 §3.6 的信封投进去，投递成功后**不** `ack`（读≠确认） |

三条边界：

1. **同一条队列，两种来源。** `mailbox-wake` 与 `send` 共用 `agent_send_queue`、共用串行门、共用速率上限。不给唤醒开一条单独的快车道——两条路径同时命中一个刚空闲的终端，那就是两次粘贴挤在一起。
2. **唤醒不是投递保证。** 队列项的 TTL 一样是 5 分钟；过期就过期，收件箱那条消息仍在表里，24 小时后自己过期。
3. `deliver` 模式下**不自动 `ack`**：ack 的语义是「我接下了」（交接那一段已经把这条写死了），应用替人 ack 会让交接状态变成谎话。

节点设置的入口在节点头「更多 → Agent 协作 → 允许连线的 Agent 投递」，与 §10 的那一项是同一个开关的两档。

## §6 人优先

### §6.1 撤销与恢复

| 触发                             | 效果                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| 人在目标终端敲了一个键           | 人立刻拿到租约（抢占）；在途 `send` 收 `LEASE_HELD_BY_HUMAN`；队列挂起   |
| 人点节点头的「接管」             | `humanTakeover`：Agent 一律被拒（`LEASE_REVOKED`），队列挂起，不自动恢复 |
| 人停手 `HUMAN_IDLE_SECONDS = 10` | 普通抢占的租约自然过期，队列恢复出队                                     |
| 人点「交还」                     | `humanTakeover` 解除，队列恢复                                           |
| Agent 投完一条                   | 它的租约保留 `AGENT_IDLE_SECONDS`，之后自然过期                          |

「敲了一个键」的判据用终端域已有的输入路径：`TerminalManager.input` 的 `noteInput`（`terminal/manager.ts:775-781`）本来就在每次人按键时更新 `lastActivity`，租约的抢占挂在同一处，不新增一条观测。

队列**挂起**而不是清空：人按几个键不该让排在后面的五条任务消失。挂起期间 `outbox` 显示 `blocked-by-human` 与持有者名字。

### §6.2 与浏览器共用一个租约状态机吗

**结论：共用代码，不共用实例；常数与排队策略各自一份。**

`browser/lease.ts` 的 `LeaseMachine` 已经是一个没有页面、没有数据库、没有自己时钟的纯状态机（该文件的模块注释写明了这一点），四个状态、四个错误码、代次与「持有者续期不换代次」的规矩，逐条都正是终端要的。重写一份等于把这四个错误码写两遍，而这四个码是**给模型看的**——同一件事在浏览器叫 `LEASE_HELD_BY_HUMAN`、在终端叫别的，模型就得学两遍。

所以：把 `LeaseMachine`、`Actor`、`Grant`、四个码与 `leaseRefusal` 提到中立模块（建议 `core/drive/lease.ts`），`core/browser` 与 `core/terminal` 各自 import 并 re-export，以保持现有导入路径不动。

不共用**实例**的三个理由：

1. **时间尺度差一个量级。** 浏览器一次动作按秒算（`AGENT_IDLE_SECONDS = 30`、`AGENT_QUEUE_MS = 5s`，等不到就拒绝）；终端一轮按分钟算，等不到就拒绝会把「人在打字」变成「Agent 挂了」。终端侧改成排队到下一次 idle（§4.5），这是策略差异，不是状态机差异。
2. **一个节点可以既有终端又连着浏览器。** 共用实例意味着「我接管这个浏览器」顺手撤销了「那个 Agent 驱动自己终端的权利」，而人点接管时说的只是前者。
3. **撤销的粒度不同。** 浏览器租约的撤销对象是一个 `browser_sessions` 行；终端租约的撤销对象是一个 PTY 会话，它有自己的 `generation`，退出即消失。两者的生命周期各挂各的。

具体参数：

| 常数                 | 浏览器 |               终端 | 说明                                             |
| -------------------- | -----: | -----------------: | ------------------------------------------------ |
| `HUMAN_IDLE_SECONDS` |     10 |                 10 | 一样，人的手速不因为面板不同而变                 |
| `AGENT_IDLE_SECONDS` |     30 |                120 | 一轮结束前不该被另一个 Agent 插进来              |
| Agent 等人的上限     |   5 秒 | 不等，排队（§4.5） | 终端的等待代价是一条排队记录，不是一个挂起的请求 |

代次落在 `terminal_sessions` 的一列（随 `0021` 加 `drive_generation INTEGER NOT NULL DEFAULT 0`），理由与浏览器一致：重启后没人持有，但代次从存下来的数继续，旧客户端手里的号不会绕回来变成当前的。

### §6.3 审计写入点

`terminal/manager.ts:678-690` 已经有一处：写入者 ≠ 会话创建者时写 `terminal.drive`。本设计新增三处，都走同一个 `audit()` 模块级 sink（`identity/audit.ts`，永不抛）：

| 动作                     | `action`            | `target`    | `detail`                             |
| ------------------------ | ------------------- | ----------- | ------------------------------------ |
| 一次 `send` 真的写进 PTY | `agent.send`        | 目标 nodeId | `{source, hops, bodyChars, queueId}` |
| 人接管终端               | `terminal.takeover` | sessionId   | `{revoked: <被撤销的持有者>}`        |
| 名字改动                 | `canvas.handle.set` | nodeId      | `{from, to}`                         |

另外每一次投递与每一次拒绝都照旧写 `board-log.jsonl`（`collab/board-log.ts`，不记正文，只记 `bodyChars`），与 `interrupt` 现在的做法一致。

## §7 防失控

| 闸           | 值                                              | 落点                                                            |
| ------------ | ----------------------------------------------- | --------------------------------------------------------------- |
| 每条边速率   | 同一 `source → target` 对两次投递至少间隔 `10s` | 契约 §5.7 第 4 条的数字；超了回 `RATE_LIMITED` + `retryAfterMs` |
| 单回合目标数 | 一轮里最多 `4` 个不同目标                       | 同上                                                            |
| 跳数         | `hops > 3` 拒绝 `LOOP_DETECTED`                 | 信封 `via:` 行与队列 `trail` 列                                 |
| 环           | `trail` 里已经出现过本节点 → `LOOP_DETECTED`    | 同上；这比跳数更早生效                                          |
| 单条长度     | `2000` 个字符（与 `MAX_BODY_CHARS` 同值）       | 超了 `BODY_TOO_LONG`：大产物写文件发路径                        |
| 队列         | 每目标 16 条、TTL 5 分钟（§4.6）                |                                                                 |
| 串行         | 同一目标同时只有一条在投                        |                                                                 |
| 读取（分钟） | 同一「读者 → 目标」每分钟最多读走 `64 KB`       | `context_reads` 的和；超了回 `RATE_LIMITED` + `retryAfterMs`（§13.4） |
| 读取（小时） | 同上，每小时最多 `1 MB`                         | 同上                                                            |

来源链的形状：`trail = ["<发起者 id>", "<它的上游 id>", …]`，投递时把目标 id 追加进去带给下一跳。`via:` 行在信封里用**名字**渲染（§2.4），一个人看到 `via: planner → reviewer → codex-1` 就知道这条指令从哪里来的。

`interrupt` 的回执同步结构化（今天它回的是一句中文 + `{id,title,traced}`）：

```json
{
  "ok": true,
  "outcome": "interrupted",
  "targetState": "busy",
  "traceId": "…",
  "traced": "file"
}
```

`send` 的回执三种形状，界面与模型都按 `outcome` 分支，不解析文案：

```json
{ "ok": true, "outcome": "delivered", "id": "…", "targetState": "idle", "traceId": "…" }
{ "ok": true, "outcome": "queued", "id": "…", "queuePosition": 2, "expiresAt": 1789000000 }
{ "ok": false, "code": "TARGET_AWAITING_APPROVAL", "message": "…", "retryable": false }
```

## §8 带任务启动

### §8.1 新的形状

```sh
armadra-hook canvas open-agent --agent codex --title "复查错误返回" --task '复查 src/api 的错误返回，结论写进便签'
```

`--prompt` 删除，改名 `--task`，语义完全不同：

1. `open-agent` 建节点，**不带任何提示词**，只带 agent id（以及 `--after` 的依赖）。
2. `--task` 的正文进 `agent_send_queue`，`origin = 'first-task'`，`target_node_id` 就是新建的那个节点。
3. 页面挂载节点 → 起 PTY → CLI 起来 → 第一条 hook 上报到达 → 节点进入 `idle` → 队列出队 → 一次普通的 `send`。

好处不是绕路，是**同一条路**：第一条任务与后续任何一条任务走同样的门链、同样的租约、同样的回执、同样的失败码。启动行只负责把 CLI 起起来。

新节点的 `--task` 不需要事先连线：`open-agent` 在创建的同一次保存里建一条 `link` 边（今天 `open-agent` 不建边，画布上那条线是 rope 派生边，只是渲染，见 `apps/web/src/canvas/derived-edges.ts:86`）。建边让「谁能给它投递」与「谁能读它」在画布上是同一条可见的线。

### §8.2 启动参数表核对

逐条核对 `core/agent/launch.ts::PROFILES`、`core/agent/registry.ts::AGENT_REGISTRY` 与 `packages/shared/src/agents.ts` 三份表对**第一条提示词**的说法：

| CLI      | 指南表（guides）     | `shared` 的 `promptMode` / `promptFlag` | core `PROFILES.promptFlag` | 一致？                        |
| -------- | -------------------- | --------------------------------------- | -------------------------- | ----------------------------- |
| Claude   | 位置参数             | `argv`                                  | 无（= 位置参数）           | 一致                          |
| Codex    | 位置参数             | `argv`                                  | 无                         | 形状一致，**语义有别**，见 E4 |
| OpenCode | `--prompt TEXT`      | `flag-prompt` / `--prompt`              | `--prompt`                 | 一致                          |
| Pi       | 位置参数             | `argv`                                  | 无                         | 一致                          |
| Oh My Pi | 位置参数             | `argv`                                  | 无                         | 一致                          |
| Copilot  | `--interactive TEXT` | `flag-prompt` / `--interactive`         | `--interactive`            | 一致                          |

六个内置项本身对得上。**错在别处**，四条：

**E1 — `launchCommand` 不解析 `custom:` 的 base，自定义 Agent 的提示词一律变成位置参数。**
`core/agent/launch.ts:296`：

```ts
const flag = PROFILES[agentId]?.promptFlag;
```

`agentId` 是原样的 `custom:foo`，`PROFILES` 里没有这个键，于是 `flag === undefined`，走位置参数分支。一个 base 是 `copilot` 或 `opencode` 的自定义 Agent，本该拿到 `--interactive` / `--prompt`，实际拿到裸位置参数——对 Copilot 那意味着 `-p` 语义的**非交互模式并在跑完后退出**，正是指南里写明「这里使用 `--interactive`」要避开的那件事。同一文件里 `planLaunch` 是正确的（`launch.ts:215` 用 `baseAgent(settings, …)` 解析），`launchCommand` 是那条没解析的。修法：给 `launchCommand` 传 `settings`，走 `baseAgent`，与 `planLaunch` 同一条解析。

**E2 — core 的 `CustomAgent` 接口丢了 `promptMode`，`stdin-after-start` 在 core 侧不存在。**
`shared` 的 `customAgentSchema` 有 `promptMode: z.enum(PROMPT_MODES).optional()`（`packages/shared/src/agents.ts:348`），三种模式里第三种是 `stdin-after-start`——「进 TUI 之后再敲，永远不上命令行」。core 的 `CustomAgent`（`registry.ts:245-254`）没有这个字段，`launchCommand` 也没有这个分支。结果：一个声明了 `stdin-after-start` 的自定义 Agent，被 `open-agent` 创建时会把提示词拼到**启动行上**，正是它声明自己不能接受的那种形式。`shared` 那边处理得对（`agents.ts:513`：`custom?.promptMode ?? base.promptMode`）。

**E3 — `open-agent` 写的 `initialCommand` 没有任何消费者（§1.4 第一层）。**
这是四条里影响最大的一条：`--prompt` 在不带 `--after` 时**整段丢失**。同时丢失的还有权限模式与模型——因为页面会用 `buildAgentLaunch(agent)` 从 `agent` 字段重新拼，而 `open-agent` 只往 `agent` 里写了 `{id, initialCommand}`，`permissionMode` / `model` 一个都没写。（`programOverride` 与 Claude 的 `--settings <托管文件>` 不受影响：它们由页面在重拼时从 `GET /api/agents` 现答里补上。）

**E4 — `promptMode: "argv"` 把两种行为写成了一个值。**
Claude 的位置参数开一轮，Codex 的位置参数只预填 composer。这不是 bug，是词汇不够：注册表今天没有一个位表达「这个 CLI 的第一条提示词需要一次额外的提交」。§8.3 的结论让这件事不再重要（谁都不再从命令行带提示词），所以**不**为它新增能力位——新增一个只有一个消费者、而那个消费者马上要被删掉的位，是给下一个人留一个谜。

### §8.3 为什么删掉 `--prompt` 这条路

1. 它今天是坏的（E3），而修好它要同时修 E1、E2、E4 与页面那条「重拼并覆盖」的路径——四处改动只为保住一条本来就绕远的路。
2. 即使全修好，命令行提示词仍然受制于每个 CLI 自己对位置参数的理解（E4），六种里至少两种的行为与我们想要的不一样，而这不是我们能控制的。
3. 投递路径已经存在且更强：它有租约、有状态门、有回执、有审计、有速率与跳数。启动行一样都没有。
4. 删掉之后「第一条任务」与「第二条任务」是同一件事，少一个只在节点生命周期第一秒存在的特例。

兼容：`--prompt` 在过渡期接受并**等价于** `--task`，回执里带一行 `warning: "--prompt 已更名为 --task"`；技能与 `USAGE` 只写 `--task`。没有第二版的兼容窗口——这是给模型看的命令行，不是给脚本看的 API。

## §9 两处已确认的可用性缺陷

### §9.1 Agent 建的节点尺寸不对

两张表，差一倍：

| 节点类型 | 人手动新建（`apps/web/src/nodes/registry.ts:105-175`） | Agent 新建（`apps/desktop/src/core/collab/control/board.ts:45-68`） |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| terminal | 960 × 600                                              | 640 × 440                                                           |
| browser  | 1280 × 800                                             | 800 × 560                                                           |
| editor   | 960 × 640                                              | 660 × 460                                                           |
| diff     | 1200 × 700                                             | 860 × 500                                                           |
| files    | 360 × 640                                              | 340 × 460                                                           |
| group    | 800 × 560                                              | 520 × 360                                                           |
| sticky   | 280 × 220                                              | 240 × 200                                                           |

根因：2026-09-19 那次「按内容自己的标准尺寸重定」只改了页面那张表（`registry.ts:95-100` 的注释记着这次修订），core 里的 `defaultSize` 是**修订前**那张表的拷贝，没人知道它在那儿。契约 §3.4 的尺寸表是权威（它自己也写明「2026-09-19 修订，章节编号不变」）。

**唯一来源的选择：`packages/shared`。** 两个消费者分属 web 与 core，而 core 不 import web、web 不 import core 的内部模块；唯一两边都能引的是 `@armadra/shared`。把表放 `packages/shared/src/domain/node-sizes.ts`：

```ts
export const NODE_DEFAULT_SIZE: Record<CanvasNodeType, Size>;
export const NODE_MIN_SIZE: Record<CanvasNodeType, Size>;
```

`apps/web/src/nodes/registry.ts` 的 `NODE_META.defaultSize` / `minSize` 与 `core/collab/control/board.ts::defaultSize` 都改成读它。core 有把 `shared` 的表**镜像**过来的先例（`registry.ts:8-13`、`launch.ts:62-67` 说明「core 不依赖 `@armadra/shared`」）——那条规矩针对的是 core 的运行时依赖；尺寸表是纯数据，本设计选择**真的 import**，并留一个用例断言三处（契约表、shared 表、页面渲染）一致。若装配上确实不许 core 依赖 `shared`，退路是保留镜像但加一个跨包对账用例，与 `launch.test.ts` 断言「两份表对每个 id 都一致」是同一手法。

`placement()`（`board.ts:161-188`）读的也是这张表，改完顺带正确：它按锚点宽度算右侧落点，锚点宽度取小了，新节点就会压在老节点身上。

### §9.2 Agent 建的节点不聚焦

两条路径的差别，逐段对照：

| 步骤       | 人手动新建                                                                  | Agent 新建                                                                                                            |
| ---------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 写文档     | `store/canvas/nodes.ts:33` `addNode`                                        | `collab/control/board.ts:87` `save` → `saveBoard`（CAS）                                                              |
| 选中       | `addNode` 自己做：`set({ selectedNodeIds: [id] })`（`nodes.ts:87-88`）      | **无**                                                                                                                |
| 抬相机     | `canvas/menus/add-menu.ts:93-94` `create()` → `revealNewNode(id)`           | **无**                                                                                                                |
| 居中       | `revealNewNode` → `centreOnMeasured`（`flow/use-flow-viewport.ts:155-168`） | **无**                                                                                                                |
| 焦点给终端 | 节点挂载后 `TerminalSurface` 自己聚焦                                       | 同左（节点确实会挂载），但相机不在那儿，用户看不见                                                                    |
| 通知页面   | 本地 store 直接变                                                           | `publish({type:"board.changed", boardId, updatedAt})`（`board.ts:113-117`）                                           |
| 页面怎么收 | —                                                                           | `app/use-board-sync.ts:115-121`：`updatedAt` 不同 → 让 board 查询失效，重取整份文档。**没有任何东西说哪个节点是新的** |

根因一句话：**`board.changed` 是一个「这块板变了」的信号，它不携带「新建了哪个节点」，所以页面无从知道该对准谁。** 手动路径不需要这个信息，因为是它自己建的。

方案：新增一个工作空间事件 `node.created`。

```ts
// core/bus.ts 的 WorkspaceEventPayloads 增一条
"node.created": {
  readonly boardId: string;
  readonly nodeId: string;
  readonly nodeType: string;
  /** 谁建的：发起这次控制动词的节点 id；人建的不发这条事件 */
  readonly bySourceNodeId: string;
};
```

契约 §5.4 那句「21 个 `WorkspaceEvent` 的 `type` 字符串逐字不变」约束的是**已有那 21 个的名字**，不禁止第 22 个；`WORKSPACE_EVENT_TYPES`（`bus.ts:150` 起）与 `packages/shared` 的 `workspaceEventSchema` 同批加一项，守着这份清单的那个用例跟着更新。

页面侧：`use-board-sync.ts` 订阅 `node.created`，在 board 查询重取**完成之后**（节点真的进了 store 才有包围盒）调用 `gotoNode(boardId, nodeId)`（`apps/web/src/sidebar/goto-node.ts:30`）。`gotoNode` 已经把这件事做对了：选中 + 按 `CENTER_RETRY_DELAYS = [0,120,320,640]` 重发几次居中请求，因为居中读的是 shape 的包围盒，shape 还没落地时它什么都不做。终端节点再额外把键盘焦点交给它的 `TerminalSurface`（`apps/web/src/nodes/terminal-registry.ts` 已经有按 nodeId 拿 surface handle 的登记表）。

两条注意：

1. **只对发起这次创建的那台客户端聚焦吗？** 不。节点是 Agent 建的，没有「发起的客户端」；所有打开这块板的窗口都会跳过去。这是对的：Agent 在你的画布上开了一个终端，那是一件值得被看到的事。若之后觉得吵，开关放偏好设置「Agent 新建节点时跟随」，默认开。
2. **不要在 `board.changed` 上猜。** 比较新旧节点集合找出新增的那个，在两条并发保存之间会指错节点。事件里带 id 是唯一可靠的做法。

## §10 界面

| 位置       | 元素                                                                                                          | 落点                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 节点头     | `@<名字>` 徽标（§2.3）                                                                                        | `nodes/NodeShell.tsx` 头部插槽                                                                     |
| 节点头     | 「正被 <名字> 驱动」徽标 + 「接管」按钮；人持有时显示「你在驱动」+「交还」                                    | 同上；数据来自新事件 `terminal.lease`（形状抄 `browser.lease`）                                    |
| 节点头     | 「排队 N」小胶囊，点开是该节点的待投列表（可逐条删）                                                          | 同上                                                                                               |
| 连线       | 最近一次投递的方向箭头闪一下 + 悬停显示 `outcome` / 时间 / `bodyChars`（不显示正文）                          | `canvas/derived-edges.ts`；数据来自已有的 `agent.delivery` 事件（`bus.ts:60`，今天只有交接域在发） |
| 节点设置   | 「允许连线的 Agent 投递」三档：关 / 只排队要我确认 / 允许；以及「收件箱唤醒」三档（§5）                       | 节点「更多」菜单 → 设置                                                                            |
| 收件箱面板 | 两个页签：**未读**（`agent_mailbox`）与 **待投**（`agent_send_queue`），后者可逐条取消                        | 复用已有的交接历史面板位置                                                                         |
| 命令面板   | 「向节点投递…」：选目标 → 写正文 → 回车，等价于人手动执行一次 `send`（人不受连线限制，走自己的授权）          | `panels/CommandPalette.tsx`                                                                        |
| 顶部通知条 | 一条被 `LOOP_DETECTED` 或连续 `RATE_LIMITED` 拦下的投递，提示哪两个节点在互相喂                               | `app/notifications.ts`                                                                             |
| 节点设置   | 「允许相连 Agent 读取转录」开关：开 = 全文（默认），关 = 对方只拿得到 ≤2 KB 摘要（`data.agent.contextShare`） | 同一处；`nodes/AgentSettingsDialog.tsx`                                                            |
| 节点头     | 「被读取 N 次」小胶囊，只在 N > 0 时出现，悬停是最近五条（谁、什么动词、多少字节、多久以前）                  | `nodes/ContextReadsBadge.tsx`；数据来自 `GET /api/nodes/{id}/context-reads`                        |

文案规矩沿用：徽标里放机器码的本地化文案，不放整句拒绝原文；「已投递」与「已完成」在任何界面上都不合并（自动化 §5 的老规矩）。

## §11 分阶段实施

### 阶段 A：名字（§2）

| 项   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文件 | `0021_agent_names.sql`；`core/collab/addressing.ts`（`loadHandles` 改读表）；`core/collab/control/edits.ts`（`rename` 写表、`link --name-*`）；`core/collab/context-link.ts:175`、`core/collab/mailbox.ts` 的 inbox 行、`core/collab/control/nodes.ts` 的 list 行；`core/terminal/environment.ts`（`ARMADRA_NODE_NAME`）；`core/collab/skill.ts` + `SKILLS_REVISION`；`core/hook/install/claude.ts`（状态行追加，仅限我们写的那条）；`apps/web`：`canvas/connection.ts` 命名弹窗、`nodes/NodeShell.tsx` 徽标、i18n |
| 测试 | 唯一约束在并发改名下成立；跨画布移动冲突被拒；名字随节点删除；迁移回填后 `loadHandles` 读表与原 `data_json` 一致；`rename` 写审计；重装技能字节幂等                                                                                                                                                                                                                                                                                                                                                                |
| 验收 | 两个 Agent 节点连线时各自起名 → 节点头显示 → `context list` 里看得见对方的名字 → `canvas post --to <名字>` 命中                                                                                                                                                                                                                                                                                                                                                                                                    |
| 风险 | `data.handle` 与表的双写漂移；缓解：表是唯一来源，副本每次从表写，一个用例守                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 阶段 B：状态机与租约（§4、§6）

| 项   | 内容                                                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件 | `core/drive/lease.ts`（从 `core/browser/lease.ts` 提取）；`core/browser/lease.ts` 改 re-export；`core/agent/target-state.ts`（新，纯函数）；`core/terminal/manager.ts`（租约挂在 `noteInput` 旁、`terminal.takeover` 审计）；`terminal_sessions.drive_generation` 列；`core/bus.ts` + `packages/shared` 增 `terminal.lease` 事件 |
| 测试 | 提取后浏览器租约的现有用例**一行不改**仍过（这是提取正确的判据）；五态投影对 `restored` / 无 hook / 会话已死各答什么；抢占 → 10 秒后自动恢复；接管 → 不自动恢复                                                                                                                                                                  |
| 验收 | 人在一个 Agent 终端里打字，节点头徽标立刻翻成「你在驱动」；停手十秒后翻回去                                                                                                                                                                                                                                                      |
| 风险 | 提取时把两边的常数弄混；缓解：常数不进共用模块，由各域传进构造函数                                                                                                                                                                                                                                                               |

### 阶段 C：`send` 与队列（§3、§4.6、§7）

| 项   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文件 | `core/collab/control/send.ts`（新）、`outbox.ts`、`cancel.ts`；`control/index.ts` 的 `VERBS`；`agent_send_queue` 表；`core/collab/deliveries.ts` 重新有写者；`cli/armadra-hook/usage.ts`（`USAGE` 是逐字节夹具）；`core/collab/skill.ts`                                                                                                                                                                                                                                                                                                                                                                                                   |
| 测试 | 门链逐条拒绝各给正确的 code；`awaiting-approval` 在三种参数组合下都不被写入；排队容量与插入的原子性（并发发送不能突破 16）；出队重跑门链；TTL 过期；`--interrupt` 等不到 idle 时退回排队；速率、跳数与环检测                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 验收 | **脚本化**：画布上起一个 Claude、两个 Codex，Claude ↔ 各 Codex 连线并起名 `codex-1` / `codex-2`。① Claude 执行 `canvas send --to codex-1 --body '在 /tmp 建一个 a.txt 写 hello'` → 肉眼看到 Codex 开一轮并建出文件；② 趁 `codex-1` 忙，Claude 再 `send` 一条 → 回执 `queued`，节点头「排队 1」，`codex-1` 这一轮结束后自动开第二轮；③ 在 `codex-2` 的终端里手动敲半行不回车，Claude `send` 过去 → 回执 `LEASE_HELD_BY_HUMAN`，停手十秒后自动投进去；④ 让 `codex-2` 触发一个权限提示，Claude `send` → `TARGET_AWAITING_APPROVAL`，终端里那个提示**没有被回答**；⑤ 让两个 Codex 互相 `send` → 第四跳被 `LOOP_DETECTED` 拦下，顶部出现通知条 |
| 风险 | 括号粘贴与回车分两次写（多行正文逐行自提交）；缓解：一次 `write`，并在用例里断言写出的字符串形状                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 阶段 D：唤醒与带任务启动（§5、§8）

| 项   | 内容                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文件 | `core/collab/control/nodes.ts`（`open-agent`：删 `--prompt`、加 `--task`、建 link 边）；`core/agent/launch.ts`（`launchCommand` 传 `settings` 走 `baseAgent`，E1/E2）；`core/agent/registry.ts`（`CustomAgent` 补 `promptMode`）；唤醒的订阅挂在 `agent.status` 的发布点 |
| 测试 | 自定义 Agent 按 base 拿到正确的提示词形状（E1）；`stdin-after-start` 不上启动行（E2）；`--task` 在节点第一次 idle 之后才投；`--prompt` 过渡期等价并带 warning                                                                                                            |
| 验收 | Claude 执行 `canvas open-agent --agent codex --task '…'` → 新节点出现、相机跟过去、Codex 起来之后**自己开了一轮**做那件事                                                                                                                                                |
| 风险 | 第一条任务投得太早（CLI 起来了但还没 ready）；缓解：靠的是第一条 hook 上报而不是定时器，没有 hook 的 CLI 走 §4.3 的拒绝路径                                                                                                                                              |

### 阶段 E：可用性与界面（§9、§10）

| 项   | 内容                                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件 | `packages/shared/src/domain/node-sizes.ts`（新）；`apps/web/src/nodes/registry.ts`；`core/collab/control/board.ts`；`core/bus.ts` + `packages/shared` 的 `node.created`；`apps/web/src/app/use-board-sync.ts`；`nodes/NodeShell.tsx`、`canvas/derived-edges.ts`、`panels/CommandPalette.tsx`、i18n |
| 测试 | 三处尺寸表一致（契约 §3.4 / shared / 页面）；`WORKSPACE_EVENT_TYPES` 清单用例更新；`node.created` 之后选中 + 居中被调用（`goto-node` 的现有测试手法）                                                                                                                                              |
| 验收 | Agent 建的终端节点与手动建的**肉眼同尺寸**；建完相机跟过去、节点选中、键盘焦点在那个终端里                                                                                                                                                                                                         |
| 风险 | core 依赖 `@armadra/shared` 的装配约束；缓解见 §9.1 的退路                                                                                                                                                                                                                                         |

### 阶段 C+：上下文读取预算（§13）

| 项   | 内容                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件 | 见 §13.9                                                                                                                                                                       |
| 测试 | 见 §13.9                                                                                                                                                                       |
| 验收 | 同一个 Agent 连着三个节点各读一次，进它上下文的是三份 ≤2 KB 的摘要而不是十几万 token；第二次 `--since` 只拿到新的那几条；对方 `.env` 里的密钥读过来是 `[已脱敏]`；节点头数得出被读了几次 |
| 风险 | 摘要太薄，读者只好接着读原文（等于没省）；缓解：摘要固定六项，其中「碰过的文件」与「最后一条助手回复」是实测里最常被追问的两样                                                    |

阶段之间的依赖：A 独立（可并行）；C 依赖 B；D 依赖 C；E 独立。

## §12 不做的与开放问题

不做：

1. **不做节点级 ACL。** 授权的粒度是「连线」与「工作空间」，与 `server-accounts-and-sharing.md` S4 一致。
2. **不做自动回复。** `send` 不产生「对方做完了自动回你一条」；要知道结果就去读对方的转录（`context summary`），或者让对方 `post` 回来。自动回复是环的起点。
3. **不解析提示符、不识别 OSC。** §4.3 的启发式只用已有的输入围栏与输出计数，不新增读取（协作通道 §3.4 的第 3 条）。
4. **不替 CLI 造权限对话。** `send` 在 `awaiting-approval` 上永远拒绝；权限直答是另一条路（契约 §5.5），有它自己的 `approval:answer` scope。
5. **不给 `observed` 开默认放行。** `--unverified` 是显式的、会被标记的、会被记录的。
6. **不为 Codex 的「位置参数只预填」新增能力位**（§8.2 E4）。

开放问题：

| #   | 问题                                                                                             | 现在的倾向                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | `send` 要不要回执「对方真的开了一轮」？契约 §5.7 第 8 条曾定义 8 秒内 `newTurn` 视为 `delivered` | 倾向**不做**：那会让回执变成一个要等的东西。改为投递后把 `traceId` 与随后的第一条 `newTurn` 关联，事后在连线上显示，不阻塞回执 |
| Q2  | 两个 Agent 之间要不要有「会话」的概念（同一个 `--key` 的多轮往返）                               | 先不做。`--key` 目前只管幂等                                                                                                   |
| Q3  | `terminal:drive` 由连线编译，那么**人**从另一台设备驱动别人的终端时，连线是不是也参与判定        | 不参与：人的授权走 `roleScopes`，连线只编译节点之间的边。两条链路在 `permits` 汇合                                             |
| Q4  | 队列在 core 重启后恢复吗                                                                         | 表在库里所以行还在；但恢复出队要等目标报一条新的 `idle`，`restored` 的 `idle` 不算（§4.1）                                     |
| Q5  | 名字要不要跟着节点跨工作空间移动                                                                 | 跟着走，冲突就拒绝移动（§2.5 第 3 条）。是否改为「自动加后缀」留待实测                                                         |
| Q6  | `send` 的正文上限 2000 字符够不够传一份任务说明                                                  | 够；不够就写文件发路径，这是 `post` 已经验证过的用法                                                                           |

## §13 上下文读取预算（阶段 C+）

`send` 解决的是「怎么让对方现在开一轮」。这一节解决的是另一半：**一个 Agent 去读别人，代价由谁付**。

### §13.0 问题

到 0024 为止，跨连线的读取是无记名、无上限、无记忆的：

- `context summary` 名不副实——它给的是对方转录最近 40 条**原文**，上限 200 KB；
- `context transcript` 给整份（尾 5 MB，渲染后 200 KB），而且 `tool_result` 是全文；
- 没有增量：同一个节点读第二次，拿到的是同一段话再来一遍；
- 没有节流：一个 Agent 连着三个节点各读一次，十几万 token 就进了它的上下文；
- 没有脱敏：对方的 `.env`、`Authorization` 头、`export OPENAI_API_KEY=…` 原样过来；
- 没有痕迹：用户在界面上看不出自己的节点被谁读过。

七条改动，全部落在 `apps/desktop/src/core/collab/`，通道设计一个字不动。

### §13.1 `summary` 变成真正的摘要

新模块 `collab/transcript-summary.ts`，纯函数，目标 ≤ **2 KB**。内容固定六项：

| 项           | 从哪来                                                            |
| ------------ | ----------------------------------------------------------------- |
| 名字与状态   | `node_handles` + `agent/target-state.ts` 的五态                   |
| 最后人类提示 | 转录里最后一条 `user`，截 500 字                                  |
| 最后助手回复 | 转录里最后一条 `assistant`，截 500 字                             |
| 碰过的文件   | `tool_use` 参数的 `file_path` / `path`，去重保序，最多 20 条      |
| 工具调用次数 | 认出来的 `tool_use` / `function_call` 计数                        |
| 有没有待审批 | `agent/approvals.ts::hasOpenApproval`                             |

`summary` **不再接受 `-n`**：条数是原文读取的参数，一个还能调大的「摘要」只是原文换了个名字。

### §13.2 原文读取三重收口

| 旋钮         | 值                                                         |
| ------------ | ---------------------------------------------------------- |
| 条数         | 默认 **20** 条（`-n` 可改）                                |
| 每条         | 用户/助手各截 **2 KB**                                     |
| `tool_result` | 只留工具名、字节数与首行（工具名由前文 `tool_use` 的 id 对上） |
| 单次总量     | **32 KB**                                                  |
| 抬高         | 显式 `--full --max-kb <n>`，上限 **128**                   |

回复头部写明「本次约 N KB ≈ M token」，按 **3.5 字符/token** 估——一个故意粗的量级，给一个假装精确的数会被当成预算来用。

### §13.3 增量游标 `--since`

`transcript --since` 只回上次读过之后的新条目。游标按 **(读者节点 id, 目标节点 id)** 记，内容是**转录文件路径 + 已读字节偏移**：路径是判据的一半，对方换了 session 就换了文件，那时候偏移指向的是另一段话，只能从头。

游标只走到**真的交出去了的**那一条，不是文件尾：没给出去的条目下次还要给。

### §13.4 每条连线的读取预算

| 闸     | 值             | 落点                                          |
| ------ | -------------- | --------------------------------------------- |
| 每分钟 | **64 KB**      | `context_reads` 的和；超了 `RATE_LIMITED`(429) |
| 每小时 | **1 MB**       | 同上，回执带 `retryAfterMs`                    |

按「读者 → 目标」这一对算，不按目标算：三个 Agent 各读同一个节点一次是正常协作，一个 Agent 读三十次不是。落库而不是落内存（与 `send-limits.ts` 的取舍相反），因为一次读取的代价是读者上下文里的 token，而那个上下文活过重启。

拒绝的那句话必须指出出路（`summary` 是常数大小、`--since` 只给新的），否则模型只会退避后原样重试同样大的读取。

### §13.5 脱敏与审计

跨 Agent 读到的每一段（摘要 / 原文 / 终端画面 / 文件内容）出门前过 `collab/redact.ts`：`sk-…`、`ghp_/gho_/github_pat_`、`Bearer <token>`、`AKIA…`、`xox[abp]-…`、`-----BEGIN … PRIVATE KEY-----` 块，以及 `*_TOKEN|*_SECRET|*_KEY|PASSWORD` 且值长于 16 的 `.env` 风格赋值，一律换成 `[已脱敏]`。表驱动，宁可漏也不错杀：熵检测会把哈希与 base64 全判成密钥，把转录切得读不成句子。

每次读取写一行 `context_reads`。`GET /api/nodes/{id}/context-reads` 回最近 N 条与总次数，供节点头显示「被读取 N 次」。

### §13.6 节点级开关

`data.agent.contextShare`：`"full"`（缺省）或 `"summary"`。为 `summary` 时 `transcript` / `terminal` 与内容节点的文件读取一律 `FORBIDDEN`(403)，只剩 `summary`——一个在做敏感事情的节点应该能在不下线的前提下只交出「我在干什么」。

### §13.7 终端画面

默认仍是 40 行，上限 **400 → 200**；去掉 CSI 与 OSC 转义序列（`capture(…, false)` 只关了 SGR，光标定位与窗口标题照旧写在里面），并过同一道脱敏。

### §13.8 表结构（迁移 `0025_context_reads.sql`）

```sql
CREATE TABLE context_read_cursors (
  reader_node_id  TEXT NOT NULL,
  target_node_id  TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  byte_offset     INTEGER NOT NULL DEFAULT 0,
  updated_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (reader_node_id, target_node_id)
);

CREATE TABLE context_reads (
  id             TEXT PRIMARY KEY,
  reader_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  verb           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  at_ms          INTEGER NOT NULL
);

CREATE INDEX context_reads_target_at ON context_reads(target_node_id, at_ms);
```

### §13.9 落点

| 项   | 内容                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件 | `collab/transcript-summary.ts`、`collab/redact.ts`、`collab/read-budget.ts`、`collab/context-reads.ts`（均新增）；`collab/context-link.ts`、`collab/transcript.ts`、`collab/skill.ts`；`agent/routes.ts`、`http/routes.ts`、`http/route-scopes.ts`；`cli/armadra-hook/{control,usage}.ts`；`packages/shared/src/domain/node-data.ts` |
| 测试 | 脱敏表驱动逐条；摘要在超长转录上仍 ≤ 2 KB；20 条 / 32 KB / `--full` 上限；`--since` 的三种情形（有新的、没有新的、换了文件）；预算的分钟与小时两个窗口、按连线隔离；`contextShare` 的四个出口；终端画面去转义                     |
| 界面 | 节点头「被读取 N 次」与 `contextShare` 开关是页面那一半，core 只备好路由与字段                                                                                                                                                     |
