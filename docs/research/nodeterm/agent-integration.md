# nodeterm 的 Agent 集成与多 Agent 协作

> 只读分析。参考项目在 `/Users/yovinchen/Projects/Rust/Tauri/nodeterm`（Electron + React + React Flow，
> `CLAUDE.md` 3332 行，其中 `## Agent support` 占 1125–2282 行）；Armadra 侧引用
> `feature/host-protocol-foundation`。行号对应各自克隆时的工作树。
> 姊妹文档：[nodeterm 的进程模型与平台抽象层](./process-model-and-platform.md)。

## 结论

nodeterm 的 Agent 域**没有中间协议**：每个 Agent 就是一个 CLI 跑在 tmux pane 里，应用只做四件事
——注入环境变量、往 CLI 自己的配置目录装 hook、起一个回环 HTTP 服务收 hook 事件、生成一份 POSIX sh
shim 让 CLI 反过来调应用。这条路线和 Armadra 完全一致（`armadra-hook` 就是 `nodeterm.sh` + `context.sh`
合成一个 Rust 二进制），所以 **nodeterm 的经验可以近乎逐条搬运**。四个判断：

1. **Agent 域应当继续留在 Rust Runtime，不要搬进 Electron main。** nodeterm 把这一层放在 `src/core/`
   并用一条禁止 `import electron` 的扫描测试守住，正是因为它有三个壳。Armadra 的 Runtime 已经是那个
   "core"，且是**进程级**隔离而不只是目录级——搬到 main 只会重新引入 nodeterm 花大力气拆掉的
   "Electron-as-Node CLI"（`docs/ssh-agent-skills.md:14-22`）。
2. **值得借的能力，按价值排序**：`--after` 依赖边（把画布变成 DAG）、hook-reply 审批的桌面端
   Approve/Deny 按钮、dry-run、subagent 卡片与实时 transcript、trigger 的"内容绑定授权"、`verify`
   评审面板、account 级配置目录隔离。
3. **明确不需要的**：远端 shim 的机器中立性约束、shared Codex app-server 的身份恢复前导、
   mirror 文件（Armadra 有真的事件 WebSocket）。
4. **一个必须警惕的方向差**：nodeterm 的协作是**推**（往对方 pane 粘贴，带队列和回执），Armadra 是
   **拉**（mailbox，永不写对方 PTY，`apps/runtime/src/handoff/mod.rs:4-7`）。nodeterm 为"推"付出的代价
   ——flow control、deliver-on-idle 队列、pane 探测、创建者账本——Armadra 一条都不用还。

## 1. 各 Agent 的启动、状态、命名、账户与凭据

### 1.1 注册表 + 能力清单（不是 flag）

`src/shared/agents/config.ts` 持有 `AGENT_CONFIG`（六个内置：id、label、spawn 命令、颜色、
`promptInjectionMode`），key 是**开放的** `AgentId` 类型，所以 `custom:<uuid>` 也能进。能力不是布尔字段
而是**成员清单**：`AGENT_HOOK_TARGETS`、`RESUMABLE_AGENTS`、`SUBAGENT_CAPABLE`、`CONTEXT_LINK_CAPABLE`、
`USAGE_CAPABLE`、`CANVAS_CONTROL_CAPABLE`、`PERMISSION_MODE_CAPABLE`、`MODEL_SWITCH_CAPABLE`、
`TITLE_READ_CAPABLE` ⊇ `RENAME_CAPABLE`（`CLAUDE.md:1136-1168`）。加一个 Agent = 把 id 加进清单 + 写清单
所 gate 的那**一个**叶子，所有消费方自动点亮；禁令是"call site 里不准写 `=== 'claude'`"。

两条被教训钉住的规则（`CLAUDE.md:2169-2181`）：
- **加入清单前先 grep 这个清单还 gate 了什么**。`USAGE_CAPABLE` 同时 gate 了上下文表、`context.ensure`
  和查找栏索引，后两者都走 claude 的 `resolveTranscript`——它的 cwd 回退会把**同目录下最新的 claude
  转录**发给一个 codex 节点当自己的上下文。
- **读腿和写腿是两个事实**。gemini 会自己命名会话但**没有 rename 命令**，两条腿不分开就会出现
  rename UI 亮着而写入静默失败。

### 1.2 启动：`agent-launch.ts` / `custom-agent-env.ts` / `exec-path.ts`

- `src/core/agent-launch.ts`（620 行）把"启动行"分四种方言：`posix | pwsh | windows-powershell | cmd`
  （`:18-19`）。权限模式经 `src/shared/agents/approval-mode.ts` 的 `approvalFlags` 翻译成各家 flag，再由
  **合成层**（`createAgentNode`）决定 flag 落在哪里：无 `argvPromptSeparator`（claude）放最后；grok 的
  `--` 是 end-of-options，flag 必须放在它**之前**，否则被当成 positional 吞进 prompt
  （`CLAUDE.md:1291-1300`、`:2192-2195`）。
- `src/core/custom-agent-env.ts:1-12`：自定义 Agent 的 `env` **最后合并、无条件胜出**。存在的理由是代理
  场景——一个 claude 兼容 CLI 用 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 改道推理，它必须盖过账户路径
  写的值。正因为它最后合并，前面账户路径的 `AUTH_ENV_STRIP` + `CLAUDE_CONFIG_DIR` 才敢先跑。
  对照：Armadra 在 `settings/agents.rs:10-13` 反向加了一条——自定义 env key **不得以 `ARMADRA_` 开头**，
  否则能改写 hook 上报去向。nodeterm 没有这条护栏（靠 per-node token 兜底），Armadra 这条更强，保留。
- `src/core/exec-path.ts:1-14`：GUI 进程从 Dock 启动只继承极小的 PATH。历史做法是每次查找同步
  `execFileSync($SHELL, ['-lc','command -v <bin>'])`——nvm/conda 的 profile 要 100–800 ms，卡在主线程上
  冻结所有窗口和 PTY。改成**开机异步解析一次登录 shell 的 PATH**，之后每次查找只走缓存字符串。

### 1.3 状态识别：hook 事件，不是输出解析

`CLAUDE.md:1340-1362`。检测**一律用 CLI 自己的 hook**。`shared/agents/normalize.ts` 里每家一个 normalizer，
映射到共享的 `AgentState = working | waiting | blocked | done`，外加 subagent/recurring/session 三种 kind。
`agents/hook-server.ts` 是回环 HTTP 服务（每会话 bearer，fail-open）；因为 **tmux 会话活得比应用久**，
它还把端点写进 `<userData>/hook-endpoint.env`，重启后重新广告。

两个值得抄的细节：
- **封闭集合优于子串匹配**（`CLAUDE.md:2213-2217`）。grok 用 `type.includes('permission')` 判断权限等待，
  结果每次工具调用都命中，一个正常工作的节点疯狂闪 "NEEDS YOU"（未读点 + 提示音 + 系统通知 + 手机卡片）。
  gemini 改成 `=== 'ToolPermission'` 精确匹配。**"保险起见放宽"是不安全的方向**——卡住的徽标没有后续
  hook 来清除。
- `agent-status-mirror.ts`（1969 行）把状态镜像成 JSON 文件给**外部读者**（iOS 伴侣）用，只读
  side-channel、永不回灌。Armadra 有事件 WebSocket，**不需要镜像文件**。

`grok-signals.ts:1-11` 是"命名陷阱"标本：`signals.json` 是**单会话上下文窗口**，`usage/grok-usage.ts` 是
**账户计费额度**，两个数字名字相近，合并就会把配额百分比画到节点上下文表上。Armadra 在
`docs/guides/architecture.md:272`（§10）同样把两者分开。

### 1.4 会话命名

一条路由规则，三个消费方，所以单独成模块（`src/core/agent-session-name.ts:1-19`）：claude 读
`~/.claude/projects` 下的转录 `.jsonl`（或托管账户根）；grok 读 hook 告知的会话目录里的 `summary.json`；
gemini 读自己的转录 `.jsonl` 里 `update_topic` 工具调用的 `args.title`；codex 读 `Thread.name`——走共享
app-server 的 socket，**没有文件可读**（`core/codex-session-name.ts:1-15`）。
**没有哪个 reader 可以搜另一家的树**。路由不是美观问题：claude 的 resolver 缓存未命中时会**扫**
`~/.claude/projects`，一个没路由的 grok 节点每 60 s 付一次全扫描换一个必然的 null（`CLAUDE.md:1549-1550`）。
`session-name-sweep.ts:19-22`：sweep 的 gate **默认值写在 core 里**，两个壳都不传参——这条规则之前在两个
壳里各有一份，双双改回 `canRename` 后**整个测试套件依然全绿**，而每个 gemini 节点被静默跳过。
claude 的读法还有一条硬事实（`CLAUDE.md:1555-1564`）：权威名字在转录 `.jsonl` 里，**不在 OSC 终端标题**
里——`/rename` 不更新 OSC，所以 resume 之后只有读文件才对；解析**严格按 sessionId**，没有 cwd 回退
（有的话同一目录下所有 claude 节点会互相采用对方的名字）。

### 1.5 账户切换与配置目录隔离

**隔离手段是配置目录，不是凭据存储**（`CLAUDE.md:1921-1933`）。每个 Claude 身份一个目录，
**claude CLI 自己负责登录、凭据存储和 token 刷新**，应用**从不写凭据**。macOS 上能成立是因为
Claude Code ≥ 2.1 把 Keychain service 按配置目录加了 scope；< 2.1 共享一个 service，所以添加账户时**警告**。

- `claude-config-dir.ts:1-22`：链接账户（用户自己早就在用的 `~/.claude-2`）需要账户**列表**，而 core 不
  拥有设置。解法是每个壳开机 `registerClaudeAccountsSource` **注册一个 getter**，所有 reader 继续调同一个
  resolver，而不是把列表穿过 pty-manager、usage service、转录 reader 和两个 jail。
- `data.accountId` 在**节点创建时解析一次**，之后不可变、持久化；`undefined` = 系统默认 = 逐字节等同旧行为。
- **env 注入的 tmux 陷阱**（`CLAUDE.md:1976-1994`）：共享 tmux server 继承**启动它的那个 client** 的 env，
  所以一个托管账户节点启动的 server 会把 `CLAUDE_CONFIG_DIR` 泄漏给之后所有没带 `-e` 覆盖的会话。
  修法是把这些名字列进**本地** conf 的 `update-environment`，让 tmux 逐个从创建 client 的 env 复制、
  **client 没有时就 strip**。远端 conf **绝不能**加（远端 attach client 的 env 是登录 shell 的）。
  同时 `AUTH_ENV_STRIP`（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`）
  从子进程 env 删掉，免得游离的 env key 盖过账户。
- **Observed account**（`CLAUDE.md:2083-2104`）：会话**实际**在哪个账户上，由 hook server 从 payload 的
  `transcript_path` 推出来。它是个**标签**，纯字符串匹配、**绝不读文件系统**（伪造的 POST 报
  `~/.ssh/projects/x` 只得到 `known:false`）。读者用 `data.accountId ?? observed.accountId`，
  **spawn/env 永远只用创建时的身份**。

### 1.6 模型网关凭据

`model-gateway-credentials.ts:11-15`。设置里只存一个网关根和一个**非密引用**：`${env:VAR}` 或
`${secret:...}`。字面 key 走 safeStorage 加密 / 0600 回退；**明文旧设置只有在密文写成功之后才迁移**。
展开只在 core 里做，引用不存在就 **fail closed**，绝不发半截凭据。发现走 `/v1/models`，**在 core 里
请求**，这样浏览器 CORS 挡不住无头版，key 也不会进终端命令行。切模型时（`CLAUDE.md:2277-2281`）：
**SIGTERM pane 的前台非 shell 进程组**（不要敲 `/exit`——它会落进 composer 变成 prompt 文本），
**回收 tmux 会话**再冷 resume：已经活着的 shell 不会继承后来的 `tmux set-environment`，而在 resume 行
前面加 `KEY=secret` 会把密钥漏进 pane 和历史。

## 2. 上下文连线与交接

### 2.1 读的是 transcript 文件，不是终端 scrollback（但 scrollback 是一个显式动词）

`src/core/context-link.ts:1-16`。语义：**连线 = "这两个可以读对方"，不流动消息**（pull，不是 push）。
动词四个——`list | summary | transcript | terminal`（`context-link-render.ts:15`）。
`summary`/`transcript` 读**转录文件**并在桌面侧解析（四种格式的 parser 都在 `context-link-render.ts`：
claude JSONL / codex rollout / gemini 事件溯源 chat / opencode export）；`terminal` 读 **PTY 画面**。
**读和解析都发生在桌面**，CLI 侧的 `context.sh` 只是 sh+curl 薄壳——这正是 SSH 项目能用这个功能的原因：
远端转录在主机上，桌面经 ControlMaster 读。
**授权规则一句话就是全部**：链接文档按**请求方的 node id** 选中，所以持 token 的调用者只能读到自己
（有向）链接图里的节点（`context-link.ts:1-8` 对应 Armadra `collab/context_link.rs:3-7`，两边同源）。

### 2.2 怎么定位 transcript

`src/core/handoff/locate.ts` 每家一个定位器，**core 里放一份**，handoff（`src/main`）和 context-link
（`src/core`）共用：
- `locateClaude(sessionId, accountId)`（`:13`）→ 按 sessionId 精确扫 `projects/`；
  `locateCodex`（`:20`）→ 走 `~/.codex/sessions` 树匹配文件名；`locateGemini` → 比对首行 header 的 sessionId。
- `locateGrok`（`:41-58`）→ **从 hook 喂来的会话目录派生，故意没有扫描回退**。两条注释值得整段抄：
  文件是 `chat_history.jsonl` 而**不是** grok 自己 hook payload 广告的 `updates.jsonl`（那个文件真实存在、
  能打开、一行都解析不出来，于是把**空转录**交给对方 agent，**没有任何诊断**）；而"比 session id 更弱的
  任何扫描键，都是一个节点读到另一个节点对话的路径"。

远端（SSH）节点另有一条（`CLAUDE.md:1579-1591`）：hook 喂的 ref 重启后就没了，本地 resolver 会去搜
**错误的机器**。`remote-transcript-locate.ts` 是**纯函数生成一行 sh**（每个 root 先试精确路径再 glob，
账户 root 在系统 root 之前，**干净未命中时 exit 0**——"没有转录"是一个答案，不是 ssh 失败），跑在
ControlMaster 上，回来的路径过 jail 才读；测试用**真 `/bin/sh`** 对着假目录树跑。

### 2.3 边（edge）的语义：四种边，各自不同

**context bridge**（`project.bridges`）= 可读上下文；**rope**（`project.ropes`）= 血缘 / 依赖，
**"Display-only — never context links"**；**dep edge** = `--after` 的等待关系（rope 的一种，外观从状态
派生：等待虚线 + ⏳，发射后实线）；**note link** = sticky → terminal 单向，连上时一次性推便签文本
（单行、2000 字截断），纯终端不推（sendText 会附加回车，文本会被执行）。

2026-07 的 fan-in 修复（`CLAUDE.md:1749-1762`）：agent 扇出的节点以前只有 rope，于是**编排者读不回自己
团队的产物**，技能里只好写"让用户来转述结果"。现在 `open-agent`/`spawn-team` 同时画一条真正的 context
bridge，并新增 `link --to <id,id> [--from <id>]`。这一步**故意静默**——手动 `onConnect` 会往两端推一条
发现提示，但对刚扇出的每个成员都推一次就是往每个会话注入 prompt。**链接是拉取式的，静默不丢任何东西。**

### 2.4 交接（handoff）协议

`src/main/handoff/index.ts:1-13`：定位源 agent 的**原生转录** → 渲染成完整 Markdown → 写进
`<cwd>/.nodeterm/` 的可移植文件。四个 renderer 配四个 locator（`:27-40`）。SSH 项目写到**远端主机**上，
因为被交接到的节点也跑在那里。**主文件有上下文预算**（`handoff/budget.ts`）：长会话以前会 dump 好几
MB，目标 agent 听话地"读完整个文件"，然后**撞上自己的上下文上限、压缩、忘了任务**——现场报告是 codex
打完招呼问 "What would you like to work on?"。超预算的会话保留近段逐字 + 其余摘要，**完整渲染写在旁边
的 `…-full.md`** 供按范围取读。

### 2.5 失效转移（`context-link-shim.failover.test.ts`）

`context-link-shim.failover.test.ts:1-4`：会话**终身绑定**在 tmux 创建时拿到的端点**路径**上，所以应用
重启（或项目 id 退役）之后它还在往一个死端口 POST，而一个活的端点文件就在旁边。hook 脚本早就有 bounded
候选遍历（本地优先于隧道，上限 3，**token 从被采纳的端点目录重读**），但两个 shim 都没有——于是 hook
事件自愈，而**每一个 canvas-control 动词都死在 "control endpoint unreachable"**，现场表现是一次 reviewer
启动静默丢失（#445）。现在三个 sh 客户端共用一份定义。服务端两个配套半边：`listen()` 失败要**解开单例**
（以前留着 `this.server`，之后每次重试都是端口 0 上的静默 no-op），`stop()` 和失败启动路径都**删掉端点
文件**——发布必须反映监听存活。**任何 HTTP 应答码都是权威的**：只有传输层死掉才转移。

> Armadra 对照：`crates/hook/src/endpoint.rs:27-29` 每次调用重读端点文件，理由写的是同一件事
> （"终端常比 runtime 活得久"）。**但目前没有候选遍历**——只有一个 `ARMADRA_ENDPOINT_FILE`。
> 这是 §7 里排序靠前的一条待补。

## 3. Agent 调用画布的命令面

### 3.1 shim 是什么形态

一个**生成的 POSIX sh 脚本**（`CONTROL_SHIM_SCRIPT`，`canvas-control-core.ts:503`），用 `curl` POST
**form-urlencoded**（`nodeId` + `arg.<flag>` 字段）到 `/control/<verb>`，请求头带 `Accept: text/plain`
让**服务端渲染**回复（sh 没有 JSON parser）。`curl --data-urlencode` **是 sh 唯一可信的转义方式**
（`CLAUDE.md:1684-1686`）。早期版本是 "Electron-as-Node CLI"（`exec "<桌面的 Electron 二进制>" cli.mjs`）
——那条路径只在一台机器上存在，SSH 场景整个不成立，已**退役**（`docs/ssh-agent-skills.md:14-22`）。
门禁是 `NODETERM_CANVAS_CONTROL` 环境变量（按 `canControlCanvas` 注入），脚本头三行就是这个检查。
发现方式按 Agent 分：claude 装 `skills/manage-nodeterm-canvas/SKILL.md`（系统目录 + 每个托管账户目录）；
codex/gemini/opencode/copilot 往各自全局指令文件合并一个带标记的块（`:273-279`）；**grok 不需要安装器**
——它默认扫 `~/.claude/skills` 做 Claude 兼容。

### 3.2 动词表（30 个）

`src/core/canvas-control-core.ts:137-173`：

```
list  open-terminal  open-claude  open-agent  show-image  show-video  show-web  open-browser
group ungroup move arrange align  link  verify  spawn-team  open-worktree  close-worktree
branch rename color write close  board assign  send reply notify  sticky  browser  open-project
```

`help` **由 shim 自己回答**，不走服务端（`:534-549`）——裸调用默认是 `list`，所以动词集从 CLI 本身
无法发现；本地、免费，应用挂了也能答。动词列表从注册表**派生**（`helpVerbList()`，`:497`），不是手抄。
参数校验是一张扁平的存在性表（`:211-267`）。flag 语法三种：`--flag value`、`--flag=value`、任意位置的
无值 flag。**`--flag=value` 是唯一能传以 `--` 开头的值的形式**——shim 以前无条件吃掉 `--flag` 后面的下一个
token，于是 `--read --node b1` 变成 `arg.read=--node` 且 `b1` 被静默丢弃，服务端在回答**另一个 flag** 的
问题（`:569-590` 现在先 peek）。两个 parser 都有测试：sh 循环用**真 sh + 假 curl 记录 argv**，
`parseControlBody` 则读它构造出来的东西。

**一条部署纪律**（`:483-488`）：shim 本地每次开机重写，但装到 SSH 主机上**只在连接时**发生，所以已连接
项目继续用旧循环且**线上没有任何信号**。因此**新动词不得依赖 parser 的修复**——给每个 flag 都带值，
新旧两个循环的解析结果就一致。

### 3.3 鉴权

三层叠加：
1. **`NODETERM_CANVAS_CONTROL`**（env 门）——但它明确**不是安全边界**：能跑 shim 的人也能手动 `export`
   （`CLAUDE.md:1473-1477`）。
2. **per-node 能力凭据**（`node-auth-*.ts`、`node-token-*.ts`）：共享 bearer 只证明"这台机器上的某个
   会话"，不证明**哪个**会话。每个节点另发一份从重启稳定 secret 派生的 `kid.mac`（按 node id 做域分隔
   HMAC），以 0600 文件交给客户端，服务端三档裁决 `verified/legacy/forged`。**`legacy` 的含义是"我们
   无法判断"，不是失败**——手机、跨实例转移、所有 token 之前的会话都合法地没有 token。严格模式有
   **日期开关**（`NODE_IDENTITY_STRICT_AFTER`，经 `isStrictInstant` 读，防止时钟超前提前进严格模式）。
3. **动词分级**：`STRICT_CONTROL_VERBS`（`hook-server.ts:625`）要求 `verified`；
   `DESTRUCTIVE_VERBS = {write, close, open-project}`（`src/shared/control-verbs.ts:42`）触发人工确认。

`src/shared/control-verbs.ts:1-40` 的文件头是优秀的反面教材：这个集合曾经**只被它自己的单元测试读过**，
而三处注释都称它为"确认门"。**它描述 dispatch，不决定 dispatch**；每个 case 仍然手写自己的 `setConfirm`。
现在两侧共读一份，买到的是**漂移报警**，不是门。另一条 2026-08 硬化（`CLAUDE.md:1696-1706`）：
Server Edition 的控制面**只接受已验证身份**，且 `HeadlessNodeFactory` 记一本**进程内**账本——哪个源节点
开了哪个新节点；改写/关闭类动词在动手前要校验**整个目标集合都是本轮运行的创建物**。账本**故意在重启后
为空**：project JSON、标题、hook 历史和 tmux 名字**都不是创建者证明**。

### 3.4 argv 铁律

`CLAUDE.md:1411-1418`，2026-08-13 实测：`buildPtyEnv` 把 hook bearer 放进 tmux `-e` argv，它会落进长活
tmux client 的 `/proc/<pid>/cmdline`，在没有 `hidepid` 的标准 Linux 上是 **444**；叠加 `open-terminal
--cmd` 不在确认集合里，等于**这台机器上任意账号都能以受害者身份任意执行命令**。远端命令行两端都是
argv，所以这条规则约束我们生成的每一条 `ssh`/`curl`。**凭据只走 0600 文件或 stdin；永远不要为了
"兼容老 curl"加 argv 回退。**

### 3.5 hooks 与触发器

- **hook-reply 审批**（`docs/hook-reply-approvals.md`）见 §4。
- **trigger 节点**（`src/core/trigger-*.ts`，issue #493）：`trigger-service.ts:1-11` 把 arm store +
  scheduler + delivery + idle 信号**一次组装**，两个壳一行 `startTriggerService(...)`。
  `trigger-scheduler.ts:11-20`：host-alive v1，`nextAt` 永远从**现在**算（睡过三个周期的主机**只 fire
  一次**）；**arm 门在 fire 时问**，不缓存计划期的答案。`trigger-delivery.ts:8-20`：agent 目标只在
  **已验证的 idle 回合边界**投递；`working` 在回合中，`blocked`/`waiting` 正坐在权限提示上——**粘贴会
  去回答那个提示**；`UNKNOWN`（重启后常见）也不是空闲的证据。三者全部进队列。
- **`trigger-arm-store.ts:1-19` 是整篇最值得抄的一条设计**：trigger 的**定义**跟着 git 共享的
  `project.json` 走，但**这台机器同意它开火**绝不能跟着走。arm 记录**绑定内容**（存 arm 时 spec 的
  规范化串），当前 spec 不一致就读作**未武装**。没有这条，"武装一次" + 之后一个 `git pull` 改写 payload
  = **用旧的同意跑新的内容**。
- `board-log-handlers.ts:6-20` / `ui-sink-registry.ts:1-6`：都是"**注册一次给所有壳**"的样板，差异部分
  （日志在哪、sink 是谁）走注入，不走每壳一份的组装代码。

## 4. 权限审批与信任模型

### 4.1 hook-reply 审批（确定性 Approve/Deny）

`docs/hook-reply-approvals.md`。灵感来自 claude-island 的 EventServer：**权限 hook 把 HTTP 请求挂住，
UI 上的 Allow/Deny 就是 hook 的回复**——不敲键、不和提示框布局耦合。nodeterm 的改编点在于答题者可能是
**一台经 SSH 够到主机的手机**（到不了桌面的回环服务），所以回复通道是**agent 所在主机上的一个文件**。
机制：hook 脚本的 `PermissionRequest` 分支（仅当 `NODETERM_PERM_WAIT_SECS > 0`）铸
`pendingId = <nodeId>-<epoch-ms>-$$`，把 payload 写进 `~/.nodeterm/pending/<pendingId>.json`（umask 077），
照常 POST 给 hook server（**这是 mirror/inbox 学到 `pendingId` 的路径**），然后每 0.5 s 轮询
`<pendingId>.answer`。拿到 `allow|deny` 就打印决定 JSON、exit 0；**超时什么都不打印、exit 0 → Claude 回到
自己的交互提示（fail-open，逐字节等同旧行为）**。替掉 send-keys 的理由：手机端的快速批准是往 tmux 里敲
`1`/Escape，它**依赖提示框在屏幕上、有焦点、且编号如我们所料**。
v1 明确不做：`AskUserQuestion`（hook 无法注入答案值）、`updatedPermissions`、codex/gemini 的权限 hook。

> Armadra 已经把这套**完整实现**了（`apps/runtime/src/collab/approvals.rs:1-9`，`crates/hook/src/hook.rs:23-33`），
> 并且**超出了 nodeterm**：Armadra 有按键兜底覆盖所有 CLI（`approvals.rs:136`）、审计表 `agent_approvals`、
> 以及**跨设备只答一次**（`apps/web/src/agent/gateway.ts:17-21`：先带 revision CAS 记录、再让机器写
> pending 文件，第二台设备在任何字节落到终端之前就被拒）。nodeterm 这里**没有**跨设备互斥。

### 4.2 项目信任：位置，不是 id

`project-trust-store.ts:15-31` 的 `localTrustKey(cwd)` 返回 ``local\0${path.resolve(cwd)}``，注释写着
"Location identity, **NEVER a project id** (ids are attacker-controlled — hostile-project-json)"。
SSH 的 key 里**端口是位置的一部分，不是装饰**：一个 `user@host` 经常是好几台不同机器（容器、VM、同一
DNS 名后的跳板），只靠端口区分——给 :2222 的批准绝不能授权 :22；省略端口**就是** 22。
`project-trust-verdict.ts:10-27`：**一个裁决，所有消费方共用**，"hash 规则不可分叉"——一个报 trusted
而另一个静默丢掉同一个值就是"报一套、执行另一套"的门。规则三条：hash **只覆盖共享文档**（覆盖合并后
的文档等于让本地覆盖洗白共享改动）；共享侧**没有可执行内容**的 family **无提示信任**；信任按**位置**、
绝不按 project id。

### 4.3 能力同意与授权账本

- `project-capability-consent.ts`：克隆提示判定器，实现放在 `@shared/` 因为**渲染进程要弹窗而它不能
  import `src/core`**；core 侧只再导出，测试钉住"两条路径是同一个函数对象"。
- `project-grants.ts:1-21`：`--project` 的定向门。调用者只能把 `open-*` 瞄准自己的项目，或
  **本轮运行中 `open-project` 返回给同一个调用者**的项目 id；任意跨项目定向故意不做 v1（confused-deputy
  邻域）。**内存中、core 进程里、永不持久化**：grant 是给一个**运行中会话**的同意记录。上限
  `GRANT_CAP = 64`，超了**拒绝**而不是静默淘汰——被淘汰的 grant 等于在无人知晓的情况下撤销了人类给过
  的权利。模块**刻意纯**（由测试结构性断言无 electron/fs/child_process）。
- `push-grants.ts:1-13`：SSH 占有即授权。手机用普通 SSH 够到的主机**没有 relay 身份**，推不了通知；
  于是手机在 `~/.nodeterm/push-grants/<deviceId>.grant` 放一个签名的设备域 token，**持有该 grant 的
  主机只能推给那一台手机**。主机被攻陷不带来新权力，最多骚扰它自己的运维者。

### 4.4 Agent 互发消息的门（Armadra 不需要，但门的理由通用）

- `agent-message-scope.ts:4-20`：目标解析**必须走序列化后的 store，不能走活的画布**——React Flow 只持有
  **当前项目**的节点，而其他项目的 tmux 会话照样在跑；**修法也不是去切换到目标项目**：这个 resolver 只
  接受 projects store，这才让"切过去"在结构上不可能。
- `agent-message-flow.ts:4-14`：控制面的**第一个节流器**（原有的只有超时和确认序列化器——**超时不是
  节流，模态框不是预算**）。两个限额都是 **pre-probe**（查 `Map` 回答），所以一次拒绝**不花 tmux 往返**，
  在 ControlMaster 已死的 SSH 项目上也**不产生真登录**（`-o ControlMaster=auto` 曾把这个形状变成
  72k 次/天的登录）。`delivery-queue.ts:5-21`：拒绝忙目标然后让模型"待会重试"，等于把它推进一个
  **前面挂着限流器的忙等循环，烧 token**；`queued` **不是** `delivered`，队列满和 TTL 过期都**大声**失败。

## 5. 用量与会话记忆

**"session memory" 在 nodeterm 里指 RAM，不是 LLM 记忆**（`docs/session-memory.md:1-5`）：左下角一个
**RAM 胶囊**和它打开的面板，显示**活动项目所在那台机器**的内存占用，以及每个 `nt-*` tmux 会话的整棵
进程树占了多少，每行可跳转、可 kill。**用量**（`src/core/usage/`，`usage-service.ts:1-7`）：凭据解析 +
OAuth 拉取 + 每账户缓存 + RPC 面，**放在 core 所以两个壳都能服务**；**只读不写**——在这里轮换 refresh
token 会把持有它的那个 CLI 会话踢下线。**范围规则**（`CLAUDE.md:2106-2121`）：指示器**限定到活动项目
所在的那台机器**，SSH 项目**只显示那台主机的账户**；没有这条时面板同时显示所有来源——每次新增单看都
合理，**加起来无法阅读**。

**远端用量**（`remote-claude-usage.ts`，`CLAUDE.md:2123-2155`）三条承重细节：
① **token 管进 `curl --config -`，绝不上 `-H` 命令行**（共享主机上 argv 可经 `ps` 读到）；
② `.credentials.json` 里**不止一个 `accessToken`**——每个被授权的 MCP server 在 `mcpOAuth` 下都有自己的，
抓第一个匹配等于把 MCP token 发出去、拿 401、把登录着的主机报成未登录；
③ **跑不起来的读取是 `error`，绝不是 `unavailable`**。**按需读，从不轮询**：每一行都是别人机器上的一次
ssh exec 加一次 HTTPS。手机端的用量/收件箱（`docs/mobile-usage-inbox.md`）全部搭在**已有的 mirror
文件**上，不新增文件也不新增传输。

> Armadra 对照：上下文占用与账户额度的分离已经做到（`docs/guides/architecture.md:272-281`），并且比
> nodeterm 更严谨——三档来源标签 `provider_hook/reported`、`structured_transcript/estimated`，以及
> "没有可信分母就留空"（`context_models.rs` 认不出的模型返回 `None`）。nodeterm 的同一条规则在
> `CLAUDE.md:2202-2212`，措辞是"拿不到可信分母就**不要出表**"。

## 6. 各 Agent 的专项处理（为什么需要那些特殊装置）

- **claude** —— 基准。`--settings` 注入、合并 hook、写 `"tui":"fullscreen"`（**write-if-absent** + 版本门
  ≥ 2.1.89，让 tmux 里的拖拽不落进 copy-mode，`CLAUDE.md:1509-1518`）。
- **grok** —— hook 配置是**目录**（全部合并），所以 nodeterm **独占一个文件**
  `$GROK_HOME/hooks/nodeterm-status.json`，里面没有用户的东西——这也是**损坏副本被治愈而不是保留**的
  原因。工具事件 matcher **必须是正则 `.*`**：裸 `*` 非法且**静默停止**工具事件。dialect 是 camelCase
  key + snake_case 事件值；**没有 `transcript_path`**，会话目录由 `cwd`+`sessionId` 派生（`:1194-1219`）。
  它还读 `~/.claude/settings.json`，所以每个 grok 事件**也触发 claude 的 hook**——这是**惰性**交叉
  （`normalizeClaude` 既找不到 camelCase key 也匹配不上小写事件值），由测试钉住；**把 claude 的事件名
  比较改成大小写无关就会让它变成有害的**。
- **gemini** —— 信封**就是 claude 形状**；11 个事件只订阅 7 个，`AfterModel` 排除是因为它**每个流式
  chunk 触发一次**（= 每 chunk 一个 hook 进程）。`Notification` → `blocked` 用**封闭集合**匹配：
  `NotificationType` 枚举**只有一个成员**，且只在真出对话框时触发（`:1220-1235`）。`/quit` 必须**裸用**
  ——`/quit --delete` 会退出**并永久删除会话历史**，正是 restart 要 resume 的那个。
- **codex** —— Windows 上 hook 命令**不是 POSIX 单行**：codex 把它构造成 `cmd.exe /C <string>`，于是
  `if [ -x … ]` 每个事件 exit 1、**节点终身如此**（#567），解法是 `codex-hook.cmd` 批处理入口去找一个
  POSIX shell 跑同一个脚本（`:1377-1392`）。用量字段 `total_token_usage` 是**累计值**（把 13% 的会话
  画成 79%），正确字段是 `last_token_usage`。
- **codex 的 shared app-server** —— 一机一个 `codex app-server`，每节点拥有一个 **thread**（以前十二个
  节点付十二棵进程树）。工具 shell 带 `CODEX_THREAD_ID` 但**丢掉 `NODETERM_*`**（实测：
  `probes/2026-08-codex-tool-shell-env.md`），所以本地 sh 客户端都要在 env 门**之前**跑一段"共享身份
  恢复前导"；**前导只导出记录里说的，自己不做判断**，`agentId` 和 `canvasControl` 进 6 元组 HMAC
  （`CLAUDE.md:1457-1477`）。
- **copilot / opencode** —— copilot 的 hook 从 `$COPILOT_HOME/hooks/*.json` 合并，BYOK 经五个
  `COPILOT_PROVIDER_*` 环境变量（`docs/copilot-agent.md:9-24`）；opencode 的 hook 产物是一个 **JS 插件
  文件**且**必须 env-gated**（它在**每条 CLI 命令**上都加载插件），转录经 **`opencode export`** 读、
  **绝不解析磁盘**（≥1.18 存储是 SQLite）。
- **SSH 上的所有 Agent** —— shim + skill + 指令块在**连接时**装到远端主机，门槛是**已验证的反向 hook
  隧道**；远端侧是**薄客户端**，不带解析、不带状态、不带应用知识（`docs/ssh-agent-skills.md:33-44`）。
  远端 shim **绝不能**携带本机的记录根路径——失败是**静默且单向的**：带了前导的远端 shim**照样工作**，
  唯一症状是这台机器的 userData 布局躺在别人的服务器上。

## 7. 对 Armadra 的映射

### 7.1 命令面：`armadra-hook` 动词 vs nodeterm shim

| 维度 | nodeterm | Armadra |
|---|---|---|
| 形态 | 生成的 POSIX sh + curl（`canvas-control-core.ts:503`、`context-link-core.ts`） | 一个 Rust 二进制 `armadra-hook`，手写 match 分发（`crates/hook/src/main.rs:23-35`），无 clap |
| 读上下文 | `context.sh list|summary|transcript|terminal`（`context-link-render.ts:15`） | `armadra-hook context list|summary|transcript|terminal`（`crates/hook/src/control.rs:16`）——**动词完全相同** |
| 改画布 | 30 个动词（`canvas-control-core.ts:137-173`） | 13 个：`list` `open-terminal` `open-agent` `sticky` `link` `rename` `color` `interrupt` `close` `post` `inbox` `ack` `handoff-read` `help`（`apps/runtime/src/collab/control/mod.rs:142-177`） |
| 传输 / 帮助 | form-urlencoded + `Accept: text/plain` 服务端渲染；`help` 由 shim 本地答、列表从注册表派生 | JSON + 客户端 `control::render`；`canvas help` 走 runtime |
| 鉴权 | app bearer（每会话）+ per-node `kid.mac` 三档裁决 + `NODETERM_CANVAS_CONTROL` env 门 | **同构**：`X-Armadra-Hook-Token` + `X-Armadra-Node-Token` + `X-Armadra-Hook-Client` 修订号（`crates/hook/src/lib.rs:129-140`），三档 `Verified/Legacy/Forged`（`hook/auth.rs:43-62`），读类收 `legacy`、控制类要 `verified`（`collab/mod.rs:406-411`） |
| 端点发现 | 端点文件 + **bounded 候选遍历 + 采纳后重读 token** | 端点文件，每次重读（`hook/endpoint.rs:27-29`），**无候选遍历** |

**结论：Armadra 的命令面在鉴权上等价甚至更清晰（一个二进制而不是三份生成 sh，不存在"两个 parser 漂移"
和"SSH 主机上的旧 shim"这两类问题），在覆盖面上更窄且方向不同（pull-only）。** 不要为了对齐动词数量而
把 `send`/`reply`/`notify` 加回来——Armadra 已经有意识地移除了它们（`docs/guides/architecture.md:145-146`）。

### 7.2 迁到 Electron 后，Agent 域放哪

**留在 Rust Runtime。** 论据不是"Rust 更好"，而是四条结构事实：
1. **hook 客户端是独立进程，汇合点是端点文件**——这套东西对"壳"完全不可知。nodeterm 把它放在 core 里
   正是为了让三个壳共享；Armadra 的 Runtime 就是这个 core，且是进程边界，比目录边界更硬。
2. **tmux 会话活得比壳久**（`CLAUDE.md:1350-1353`、`:1404-1408`）。Agent 状态、pending 审批文件、
   node token 目录都必须在壳重启后还在。Runtime 是长活进程，Electron main 跟着窗口走。
3. **Go Host 的迁移还在路上**。把 Agent 域搬进 Electron main 等于把它钉死在桌面壳上，与 Host 接管
   执行层的方向相反。
4. **nodeterm 花了最多注释篇幅的两类 bug，Armadra 本来就没有**：两个壳的 raw listener 漂移和"规则写了
   两遍"（`CLAUDE.md:2237-2246`）。搬进 main 会把第一类重新造出来。

Electron main 只该拿到**真正属于壳**的那几件：窗口聚焦判断（决定要不要弹系统通知）、系统通知本身、
以及点通知回到节点的路由（`CLAUDE.md:1519-1526`）。

### 7.3 值得借鉴的能力（按价值排序）
1. **`--after` 依赖边 / `pendingLaunch`**（`CLAUDE.md:1763-1835`，纯逻辑在 `renderer/lib/pendingLaunch.ts`）
   ——**把画布从扇出变成 DAG** 的那一步，价值最高。Armadra 技能里已有 `open-agent --after`，需要补齐
   承重规则：未知状态**不算满足**（扇出后上游还没发过 hook，把"没消息"读成"完成"会让下游全部开火）；
   **已删除的依赖算满足**；**`done` 但带 `lastTurnError` 的不算满足**（issue #521：API 报错的回合**立刻**
   到达 idle，整条链在上游什么都没产出时发射）；只有有 hook 的 agent 能被等待，纯终端**拒绝**而不是永久
   挂起；创建时已满足的节点**不武装**；投递**恰好一次**、被拒要退避重试；投递要等**节点 PTY 就绪**，
   且放弃状态必须**可见**（`stalled` vs `failed`）——"等到天荒地老"正是它要替掉的失败模式。
2. **桌面端 Approve/Deny 按钮**。Armadra 的 hook-reply 机制已完整，只差把它接到 NEEDS-YOU 徽标上。
   最小改动、最高感知度。
3. **`--dry-run`**（`canvas-control-core.ts:197-208`）：对 spawn 类动词跑**与真调用完全相同的校验**，
   然后报告**会发生什么**或确切拒绝理由。"这些动词调用便宜、撤销昂贵，dry run 把错误挪到便宜的一侧。"
4. **subagent 卡片 + 实时转录**（`CLAUDE.md:1607-1662`）。两个陷阱一起抄：claude 的 PostToolUse
   **只是启动 ack**（`async_launched`），真正的结束是父转录里的 `<task-notification>`；**新回合只清
   `done` 的卡片**——"等 N 个后台 agent 完成"正是下一条 prompt 被敲进去的状态，全清会让有活跃后台
   agent 的父节点读起来是 idle。未完成的卡片**欠一次衰减**（同一个 tick、同一个共享常量）。
5. **trigger 的"arm 绑定内容"**（`trigger-arm-store.ts:1-19`）——"共享文档中的任何内容都不能自行导致
   执行"应成为 Armadra `.armadra/` 下所有 git 共享物的通用原则。
6. **`verify` 评审面板**（`CLAUDE.md:1864-1878`）：**组合，不是新机制**——`--after` + `link` 就是全部
   实现。两处措辞承重、不许"优化掉"：评审者被告知**不要编辑**（一个面板是 N 个 agent 指着**同一个**
   checkout），以及**明确许可他们什么都找不到**（有产出压力的评审者会编造发现，而编造的发现要花别人
   的时间去证伪）。
7. **账户级配置目录隔离**。Armadra 的 `accountId` 目前是**预留字段**（`apps/web/src/agent/launch.ts:101-111`
   自陈"Runtime 没有凭据接口"）。nodeterm 的做法可整段照搬，因为核心主张正是"**我们不做凭据**"；配套
   必抄 `AUTH_ENV_STRIP`、tmux `update-environment` 泄漏修复、"env 只用创建时身份、读者才用 observed"。

### 7.4 Armadra 不需要做的（nodeterm 因为没有独立 Runtime 才被迫做的）

- **agent-status mirror 文件**（1969 行）——它存在是因为外部读者（iOS）进不了渲染进程的 IPC；Armadra
  有 HTTP + 事件 WebSocket，客户端直接订阅即可。**"两个壳的 raw listener 必须保持一致"**及其源码级测试
  同理——Armadra 只有一个 Runtime。
- **远端 shim 的机器中立性守卫**（`remote-shim-neutrality.guard.test.ts`）、**Electron-as-Node CLI →
  sh shim 的整条迁移**及两个 sh parser 的漂移测试。Armadra 分发的是编译好的二进制。
- **shared Codex app-server 的身份恢复前导**——除非 Armadra 也去做"一机一个 app-server"的优化。
  在那之前每个 Codex 节点跑自己的进程，`CODEX_THREAD_ID` 问题不存在。
- **`send`/`reply` 的投递管线**：flow control、deliver-on-idle 队列、pane 探测、8 s 回执、创建者账本。
  Armadra 是 pull-only（`apps/runtime/src/handoff/mod.rs:4-7`），这些**全部不欠**。唯一要保留的是
  `trigger-delivery.ts:8-20` 那条判断——**`blocked`/`waiting` 的节点绝不能被写入，因为粘贴会去回答
  那个权限提示**——Armadra 的 `interrupt` 和权限按键兜底这两条写 PTY 的路径要遵守它。
- **MCP**。Armadra 已在两处写死理由（`docs/design/agent-integration.md:4,59`；
  `agent-collaboration-channels.md:129`："工具调用由模型发起，不能作为授权依据"）。nodeterm 走到同一个
  结论——`CLAUDE.md:1913` 一句话："(Replaced the earlier MCP-based bridge.)"
  **两个项目独立地从 MCP 退回到 CLI 动词面，这是本次调研最强的一条交叉验证。**

## 8. 建议的实施批次

每批可独立合并、独立验收。验收命令按 AGENTS.md：前端 `pnpm --filter @armadra/web test` / `typecheck`，
Runtime `cargo test -p armadra-runtime`，结构改动 `pnpm check`。

**批 0 — 端点失效转移**（先做，因为它是静默失败）。`crates/hook/src/endpoint.rs` 加 bounded 候选遍历：
本地端点文件优先，采纳新端点后**重读该端点目录下的 node token**；只有传输层失败才转移；区分"哪里都
没有端点"和"广告了一个不在监听的端点"。Runtime 侧：`listen()` 失败解开单例，`stop()` 与失败启动路径都
**删掉端点文件**。验收：集成测试——起 runtime A 写端点、杀掉、起 B 写新端点，用真
`armadra-hook context list` 证明自愈；`cargo test -p armadra-runtime`。

**批 1 — `--after` 依赖边补齐**。把 §7.3 第 1 条的规则实现为**纯函数**，放在已有的
`apps/web/src/agent/pending-launch.ts`。重点是 `lastTurnError`：**注解不是第五个状态**，**瞬态**
（重启后没有什么能发射，恢复的裁决描述的是上一轮运行），由**下一个真正的新回合**清除。验收：
`pnpm --filter @armadra/web test` 覆盖拒绝矩阵全表；手动跑三节点链，中间节点故意用错误 prompt。

**批 2 — 审批 UI 落到节点头**。把已有的 `POST /api/approvals/{pending_id}/answer` 接到 NEEDS-YOU 徽标
上的 Approve/Deny，只对带 `pendingId` 的事件显示；跨设备互斥已在 `gateway.ts:17-21`，不改。
验收：真跑一个 Claude 节点触发权限请求，两个标签页同时点，确认第二个被 revision CAS 拒绝。

**批 3 — dry-run 扩面 + help 派生**。`--dry-run` 覆盖全部 spawn 类动词；`canvas help` 的动词列表从
`collab/control/mod.rs` 的注册表**派生**，并像 nodeterm 那样**由客户端本地回答**（runtime 挂了也能答）；
技能正文的动词表同样改成派生。nodeterm 的规则是"**改动词 / 改 flag / 改结果含义，必须在同一个 PR 里改
agent 面向的文本**"，且要有测试对着陈旧陈述失败（`CLAUDE.md:1714-1725`，反面案例 #269）。
验收：一条测试遍历生成的 SKILL.md 与 help 输出，断言与注册表一致。

**批 4 — subagent 卡片**。先只做 Claude：按 `tool_use_id` 关联 `Agent`/`Task` 的 Pre/PostToolUse；
`async_launched` 不是结束；`<task-notification>` 是真结束；新回合只清 `done`；未完成卡片有衰减、标 done
而不是删除。卡片是**临时节点**，不进持久化、不进撤销。验收：用 fixture 回放真实 claude 转录断言卡片
生命周期。

**批 5 — 账户/配置目录隔离**（最大的一批，可再拆）。5a 账户列表进设置 + 每账户一个配置目录 + 登录节点
（跑 `claude /login`，轮询目录里的 `.claude.json` 取 email）；**登录节点必须带当前项目的 cwd**——若从
`$HOME` 起，Claude 的信任检查会要求用户信任整个 home 目录（含 SSH key 和云凭据），而那次 OAuth 根本
不碰文件（nodeterm issue #553）。5b env 注入 + `AUTH_ENV_STRIP` + tmux `update-environment` 泄漏修复
（**只在本地 conf**）。5c observed account 标签（纯字符串推导、**绝不读文件系统**）+ 读者用
`data.accountId ?? observed.accountId`。验收：5b 需要**对着真 tmux** 的测试（含"server 已被种下"的
情形）；其余跑两侧测试。

**批 6 — `verify` 评审面板**。纯组合，等批 1 落地后再做。逻辑放纯函数并单测；两处承重措辞（不要编辑、
明确许可零发现）写进 prompt 模板并由测试钉住。验收：手动开一次三 lens 面板，确认 judge 在所有 reviewer
完成前不发射。

> 文档登记：`repo.rules.json` 对 `docs/research/` 是 `directoryOnly`，本文件无需单独登记进 `docs/README.md`。
