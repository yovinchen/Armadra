# Agent 接入统一管理：Hook 报事件，技能给动词

> 状态：目标设计（2026-09-08）。保留 [agent-collaboration-channels.md](./agent-collaboration-channels.md) 的两条通道（Hook / 进程内扩展报事件，技能教 CLI 用 `armadra-hook canvas …` 动词），只改**安装、注入与管理**的方式。不引入 MCP（用户决定）。

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

- 识别：各 CLI 配置里指向 `aicc-hook`、`nodeterm`、`.nodeterm`、`target/debug/…` 的 hook 条目；技能目录 `aicc-canvas`、`aicc-linked-context`、`get-linked-context`、`manage-nodeterm-canvas`、旧版 `armadra`（内容修订号落后）；Codex `hooks.json` 顶层的 `version`。
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
