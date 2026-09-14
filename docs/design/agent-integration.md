# Agent 接入统一管理：Hook 报事件，技能给动词

> 状态：**已实施（2026-09-13）**，偏离与未竟之处见 §8。保留
> [agent-collaboration-channels.md](./agent-collaboration-channels.md) 的两条通道（Hook / 进程内扩展报事件，技能教 CLI 用 `armadra-hook canvas …` 动词），只改**安装、注入与管理**的方式。不引入 MCP（用户决定）。
>
> 落点：`apps/runtime/src/hook/install/{mod,integration,repair,claude}.rs`、`collab/skills.rs`、
> `api/agents.rs`、`worker/agent_host.rs`；`proto/armadra/v1/agent.proto`（worker 动作 109–112，107/108 已 reserved）；
> `apps/host/internal/{agenthost,server,worker}`；`packages/shared/src/api/agents.ts`、`packages/host-client/src/agent.ts`、
> `apps/web/src/api/agents.ts`。现状文档见 [Agent 适配与低干扰协作](../guides/agent-collaboration.md)。

## 1. 现状与问题

一个 CLI 要和画布打交道，要装两样东西、管三处状态：

| 层       | 机制                                                        | 落点                                                  | 问题                                                                                                     |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 事件上报 | Hook（`armadra-hook <agent>`）或进程内扩展                  | 各 CLI 的全局配置文件（`~/.claude/settings.json` 等） | 写进用户全局配置；旧产品名时期的条目（`aicc-hook`、`nodeterm`）没人清；Codex `hooks.json` 的 schema 变了 |
| 操作画布 | 技能 `armadra/SKILL.md` 教 CLI 去跑 `armadra-hook canvas …` | 各 CLI 的技能目录                                     | 与 Hook 分开安装、分开显示状态；旧技能（`aicc-canvas`）与新技能并存                                      |
| 协作     | 同上的 `post` / `inbox` / `link` / `handoff-read` 动词      | 同上                                                  | 与操作画布是同一套问题                                                                                   |

用户实测：安装失败（实际是旧 Runtime 没有新路由）、CLI 找不到 `aicc-hook`、Codex 拒绝 `hooks.json`、连线后上下文不通。

## 2. 结论

- **Hook 与技能是一个安装单元。** 每种 CLI 只有一个「已集成 / 未集成」状态，一次安装同时写 Hook 与技能，一次卸载同时清掉；两者的修订号合成一个 `INTEGRATION_REVISION`，任一变了就提示重新安装。
- **注入尽量只在启动那一次。** 能用启动参数或会话级配置的 CLI（Claude 的 `--settings`，Copilot、OpenCode 的会话配置）不再改用户的全局配置，Hook 在拉起会话时注入、会话结束即消失；做不到的（Codex `hooks.json`、Gemini `settings.json`）继续写文件，但写法幂等、带 Armadra 标记、可修复。技能目录本来就是按 CLI 的固定位置，保持文件安装（技能是模型读的说明书，没有启动参数可注入）。
- **旧残留必须清。** 安装器增加「修复」：识别旧产品名的 Hook 条目、技能目录、过期 schema，备份后清理并按现行写法重写。
- **一处管理。** 设置页「Hook 与 Skills」改为「集成」：每种 CLI 一行——注入方式、Hook 状态、技能状态、旧残留、安装 / 卸载 / 修复。
- 动词、`hook.sock`、`HOOK_CLIENT_REVISION`、信箱与引用契约不变。

## 3. 各 CLI 的注入方式

| CLI           | Hook                                                                  | 技能                                           | 是否改全局配置 |
| ------------- | --------------------------------------------------------------------- | ---------------------------------------------- | -------------- |
| Claude Code   | 启动时 `--settings <会话临时文件>`（hooks 段）                        | `~/.claude/skills/armadra/SKILL.md`            | 只技能         |
| Codex         | `~/.codex/hooks.json`（无启动参数），顶层只写 `description` / `hooks` | `~/.codex/skills/armadra/SKILL.md`（核实目录） | 是，幂等       |
| Gemini CLI    | `GEMINI_CLI_HOME/.gemini/settings.json` 的 hooks                      | `.gemini/skills/armadra/SKILL.md`（核实目录）  | 是，幂等       |
| OpenCode      | 进程内扩展（已有，会话配置注入）                                      | `~/.config/opencode/skills/armadra/SKILL.md`   | 只技能         |
| Copilot       | 命令 Hook（已有，核实是否可走会话配置）                               | Copilot 的技能目录（核实）                     | 视核实结果     |
| Pi / Oh My Pi | 进程内扩展（已有）                                                    | 各自技能目录（已有）                           | 只技能         |

每种 CLI 的方式、参数与核实出处写在 `hook/install/<cli>.rs` 顶部注释；会话临时文件放 `<data_dir>/sessions/<id>/`，会话结束删除。

## 4. 旧残留的清理（修复）

`hook/install/repair.rs`，设置页按钮 + Runtime 启动时自动检测（只报不改）：

- 识别：各 CLI 配置里指向 `aicc-hook`、`nodeterm`、`.nodeterm`、`target/debug/…` 的 hook 条目；技能目录 `aicc-canvas`、`aicc-linked-context`、`get-linked-context`、`manage-nodeterm-canvas`、旧版 `armadra`（内容修订号落后）；Codex `hooks.json` 顶层的 `version`；全局 `AGENTS.md` / `GEMINI.md` / `CLAUDE.md` 里 `<!-- nodeterm:…:start/end -->`（或 `aicc:`）围起来的指令块（2026-09-15 补）。
- 动作：列出 → 备份为 `<file>.armadra-backup-<时间戳>` → 删条目 / 目录 → 按现行写法重写；只动我们认得的条目，其余原样。
- 报告：每种 CLI 一份 `{found, removed, kept, backup}`。

## 5. 接口

- `GET /api/agents/{id}/integration` → `{ mode: "launch" | "file" | "extension", hook: {installed, path?, revision}, skill: {installed, path?, revision}, legacy: {found: [{kind, path, detail}]}, revision }`。
- `POST /api/agents/{id}/integration/install` / `uninstall`（Hook + 技能一起）；`POST …/integration/repair`。旧的 `/hooks/*`、`/skills/*` 路由删除。
- Host 模式：agent 域转发（worker.proto 编号 +1）。

## 6. 不做

- 不引入 MCP；不改动词集合与 `armadra-hook canvas` 的参数。
- 不改 Hook 事件契约。

## 7. 验收

- 七种 CLI：`pnpm agent:smoke` 覆盖「安装一次 → Hook 事件到达 + 技能文件在位 + `armadra-hook canvas` 动词可用 → 卸载后两者都不在」。
- 用户机器的旧残留样本（`aicc-hook`、`aicc-canvas`、Codex `version`）作为测试夹具，`repair` 后各 CLI 正常启动。
- 设置页「集成」在打包版可用。

## 8. 实施记录：偏离与未竟

### 8.1 Claude 的会话文件是**每台机器一份**，不是每会话一份

设计写的是「会话临时文件放 `<data_dir>/sessions/<id>/`，会话结束删除」。实际落在
`<data_dir>/integration/claude/settings.json`——装一次写一份，卸载删掉。

原因是启动行不在 Runtime 手里：`assembleLaunchArgv` 在 Web 侧拼好，由前端敲进 shell（`apps/web/src/agent/launch.ts`），
Runtime 只负责建 PTY。要让路径随会话变，就得把会话 id 从建终端的响应一路穿回敲启动行的地方，还要同时改
Host 模式的 `session.proto` 投影——为了一份内容永远相同的文件。所以改成：Runtime 在 `GET /api/agents` 的
`launchArgs` 里现答这份 argv，前端原样附加。

设计真正要的那条性质**保住了**：`~/.claude/settings.json` 一个字节都不写，用户自己在别处开的 `claude` 完全不受影响，
卸载就是删我们自己数据目录里的一个文件。放弃的是「会话结束即消失」——那份文件在两次会话之间仍然存在，
但它只在启动行点名时才被读到，所以对不经 Armadra 起的会话没有任何作用。

### 8.2 Copilot 与 OpenCode 仍是文件安装

Copilot 1.0.8x 的 `--plugin-dir <目录>` 确实能给一次会话挂一个插件，`plugin.json` 里带 `hooks` 也被接受
（`copilot --plugin-dir … plugin list` 能列出来）。但同一个插件目录里的 `skills/<name>/SKILL.md` 在
`copilot skill list` 和 `copilot plugins list` 里都**没有出现**，插件根目录下的 `SKILL.md` 同样没有。
一个只能带走一半的会话通道不如现有的文件安装，所以 Copilot 保持 `~/.copilot/hooks/armadra.json` + `~/.copilot/skills/`。

OpenCode 本机入口跑不起来（npm postinstall 未执行，`opencode --help` 直接报错），没法核实它的会话级配置，
因此沿用已有的插件文件安装。两者都记在 `hook/install/<cli>.rs` 顶部。

Pi / Oh My Pi 另有 `-e <扩展>` 与 `--skill <路径>` 两个启动参数，可以做到完全的会话级注入。没有改：它们现在的
扩展文件安装是可用的，而这一轮的目标是把用户**全局配置**里的写入减到最少，Pi 家族本来就不写全局配置。

### 8.3 Codex 0.153 的 hook 信任：本轮未解决

`hook/install/codex.rs` 复现的 `trusted_hash`（对着 Codex 0.149.1 逐字节核过）在 **0.153.4 上不再匹配**：
装完之后 TUI 弹「Hooks need review — 8 hooks are new or changed」，在用户按 `t` 之前一条事件都不会到。
另外 **`codex exec` 根本不跑 hook**（0.153.4 上一个已信任的 `session_start` 条目在 `exec` 下也不触发），
所以 `pnpm agent:smoke codex` 改成了交互式 + 粘贴，与 Copilot 同路。

这不是本轮改动引入的：`codex.rs` 的哈希算法这一轮没有动，`HOOK_CLIENT_REVISION` 也没有动。要修需要把
0.153+ 的 `NormalizedHookIdentity` 重新读一遍——一个线索是 0.153.4 里 `chrome@openai-bundled` 与
`browser@openai-bundled` 两个不同插件的 `stop` 条目共用同一个 `trusted_hash`，说明身份里已经不含命令或路径。
在此之前 Codex 的状态通道需要用户在 TUI 里确认一次。

### 8.4 接口形状的两处补充

§5 的字段一个没少，另外加了三个读得更直白的：`installedRevision`（磁盘上那份是哪一版）、`stale`（装了但不是这一版）、
`launchArgs`（这台机器上这个 CLI 的启动 argv）。`revision` 按 §5 的字面意思是「一次全新安装会写的那一版」。

旧的 `/hooks/*`、`/skills/*` 路由已删除。`apps/web/src/api/agents.ts` 暂时保留同名薄包装并标 `@deprecated`，
它们打的都是同一个安装单元，只把答案折回旧形状，好让还没换成「集成」的设置页继续编译。
