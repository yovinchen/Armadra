# 画布内注入：Hook、技能与画布说明只在从画布启动时生效

> 状态：**已实施（2026-09-26）**。取代 [Agent 接入统一管理](./agent-integration.md) 里「装进各 CLI 全局配置」的那一半；Hook 事件契约、技能正文的归属、旧残留修复保持不变。

## 1. 目标

用户拍板的两条：

1. Armadra 注入到各 CLI 的 Hook、技能与画布说明，**只在从画布启动时生效**；用户在画布外自己启动 CLI，零影响。
2. 升级后自动清掉现有的全局安装，清之前先备份。

此前只有 Claude 的 Hook 是逐次注入（`--settings`）：Codex 写 `~/.codex/hooks.json`，Copilot 写 `~/.copilot/hooks/armadra.json`，OpenCode / Pi / OMP 往各自扫描的目录里放状态模块，六个 CLI 的 `SKILL.md` 全在全局 skills 目录。画布外启动的 CLI 同样读到技能、同样触发 Hook。

## 2. 一个出口

注入产物固定生成在应用数据目录 `integration/<cli>/`，由启动行（argv）与节点终端的环境变量交给 CLI：

- `core/hook/install/inject.ts`：`canvasInjection({ dataDir, agentId, nodeId, resume })` 答 `{ args, env }`；`prepareInjection` 把产物写成当前修订（字节不变就不写），Codex 另写信任记录；`removeInjection` 全部收回。
- `core/agent/canvas-launch.ts`：core 里唯一拼启动行的地方（`canvasLaunch` / `canvasLaunchLine`），权限模式与模型的旗标来自 `planLaunch`，后面接注入的 argv；`canvasEnvironment` 给节点终端的环境半边，也是「就要起这个 CLI 了」时确保产物最新的时刻。
- 页面自己拼的启动行（新节点、`open-agent` / `team` 建的节点、从历史对话恢复）全部经 `apps/web/src/agent/launch.ts`，把 `GET /api/agents` 那一行的 `launchWords` 接在后面（旧 core 只给 `launchArgs` 时逐个引用）；两者都是 `canvasInjection` 的答案。

`canvasInjection` 答三样：`args`（字面 argv，给自己 exec CLI 的调用方，例如探针）、`words`（敲进节点 shell 的词，还没引用）、`env`（并进节点终端环境）。除 Codex 外 `words` 就是 `args`；Codex 见 §3 末尾。

启动行是敲进节点终端的，按那个 shell 的方言引用：`packages/shared/src/shell.ts`（core 里逐字节同一份 `core/terminal/shell.ts`，用例比对两份）分 `posix`（sh/bash/zsh/dash）、`fish`、`cmd`、`powershell`（`pwsh` 7）、`windows-powershell`（`powershell.exe` 5.1）五种，管参数引用与环境变量引用（`"${VAR}"` / `"$VAR"` / `"%VAR%"` / `"${env:VAR}"`）。5.1 把参数交给原生程序时不转义，含 `"`、空串、带空格又以 `\` 结尾的词与环境变量引用写在停止解析符 `--%` 之后（C 运行库引用、`%VAR%`，带不了 `%` 与 `|`）。Windows 上 npm / pnpm 装的 CLI 是 `.cmd` 包装，批处理会让 `cmd.exe` 把参数再读一遍，所以启动行绕过包装：`core/agent/windows-shim.ts` 读出背后的 `node <脚本>` 或原生程序，`GET /api/agents` 以 `launchTarget` 答给页面；读不出来的包装留作程序，只放行两遍都读不坏的词（`shell.ts::batchSafeWord`），此时 Codex 的环境变量一律按 `cmd.exe` 的形状写。方言取节点终端实际跑的 shell：会话记录里的 `shell`，没有会话时是节点指定的，再没有是 core 的缺省 shell（Windows 上是 `COMSPEC`，页面从 `/api/health` 的 `defaultShell` 得知）；SSH 节点一律 POSIX。Codex 那两个由行展开的环境变量在 `cmd.exe` 下另有写法（`inject.ts::codexTomlString`），所以 `canvasEnvironment` 也按方言答。

启动路径与各自的出口：

| 路径                            | 谁拼启动行                                                                    | 环境变量                                      |
| ------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| 页面启动、`open-agent` / `team` | `web/agent/launch.ts::buildAgentLaunch`（`launchArgs`）                       | `POST /api/terminals` → `ownedEnvironment`    |
| 从历史对话恢复                  | `web/agent/launch.ts::buildResumeLaunch`                                      | 同上                                          |
| 依赖编排                        | `dependencies/launch.ts::launchLine` → `canvasLaunchLine`                     | `spawnForNode` → `ownedEnvironment`           |
| 节能唤醒                        | `terminal/hibernator.ts::resumeLine` → `canvasLaunchLine`（带 resume）        | `Hibernator.environment` → `ownedEnvironment` |
| 计划任务冷启动                  | `schedule/cold-start.ts::launchLine` → `canvasLaunchLine`（冻结 argv + 注入） | 冷启动器 → `ownedEnvironment`                 |

SSH 节点的启动行不带注入的词，也不带本机解析到的程序路径：那些路径都在控制端，注入由执行主机上的垫片补上，见[远端画布注入](./remote-canvas-injection.md)。

冷启动此前漏带 `launchArgs`（Claude 缺 `--settings`）；现在冻结的计划仍只存 agent id 与 argv，注入的路径在执行时由 core 现取，不进计划。

`core/agent/canvas-launch.test.ts` 的结构性用例守住出口：core 里调用 `planLaunch(` 的只有 `canvas-launch.ts`，调用 `canvasInjection(` 的只有它与集成状态；`launchCommand(` 只剩 `open-agent` 回报里显示用；页面里调用 `assembleLaunchCommand(` / `assembleLaunchArgv(` 的只有 `web/agent/launch.ts`，且它读 `launchArgs`。新加一条启动路径而绕过出口，这些用例会先红。

## 3. 实测矩阵

2026-09-26，本机真 CLI，全局配置前后哈希一致。「恢复」一列：恢复会话时是否要把同样的参数再传一遍。

| CLI                 | Hook                                                                                                                                                                          | 技能                                                                                                       | 画布说明                                                                                                                                           | 恢复                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude Code 2.1.260 | `--settings <integration/claude/settings.json>`；与用户自己 `settings.json` 里的 Hook **叠加**而非替换                                                                        | `--plugin-dir <integration/claude/plugin>`，内含 `.claude-plugin/plugin.json` 与 `skills/armadra/SKILL.md` | `--append-system-prompt-file <integration/claude/instructions.md>`                                                                                 | 三样都要重传                                                                                |
| Codex 0.155.1       | 每个事件一个 `-c 'hooks.<Event>=[{hooks=[{type="command",command="<数据目录>/bin/armadra-hook codex"}]}]'`；信任见 §4                                                         | 没有逐次加载技能的办法：要点并进 developer instructions，并给出完整 `SKILL.md` 的绝对路径                  | `-c developer_instructions="…"`（追加一条 developer 消息；`model_instructions_file` 会替换基础提示，不用）                                         | Hook 的 `-c` 要重传；developer instructions 首次写进会话记录，恢复时保留，重传不更新        |
| OpenCode 1.18.28    | `OPENCODE_CONFIG_DIR=<integration/opencode/config>`，模块在其 `plugins/`                                                                                                      | 同目录 `skills/armadra/SKILL.md`                                                                           | `OPENCODE_CONFIG_CONTENT='{"instructions":["<instructions.md>"]}'`                                                                                 | 环境变量每次启动都带。OpenCode 会往这个目录装 `package.json` / `node_modules`，所以目录固定 |
| Pi 0.84.4           | `--extension <armadra-status.ts>`                                                                                                                                             | `--skill <skills/armadra>`                                                                                 | `--append-system-prompt <instructions.md>`                                                                                                         | 要重传                                                                                      |
| Oh My Pi 18.1.8     | `--extension=<armadra-status.ts>`                                                                                                                                             | `--config=<overlay.yml>`，内容 `skills.customDirectories: [<skills>]`（`--plugin-dir` 不行）               | `--append-system-prompt=<instructions.md>`                                                                                                         | 要重传                                                                                      |
| Copilot 1.0.8x      | `--plugin-dir <integration/copilot/plugin>`，`plugin.json` 写 `"hooks": "hooks.json"`，`hooks.json` 为 `{"version":1,"hooks":{"sessionStart":[{"type":"command","bash":…}]}}` | 同一插件目录，`plugin.json` 写 `"skills": "skills/"`                                                       | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<integration/copilot/instructions>`，文件在 `.github/instructions/armadra.instructions.md`，头部 `applyTo: "**"` | 要重传                                                                                      |

**Codex 的启动行要短**：八张 Hook 表各自写全客户端路径，再加上画布说明，一行有好几 KB；这样一行敲进刚起的 shell 会被截断——行编辑器还在回显时，PTY 的输入队列只装得下约 1 KB（2026-09-26 画布里实测：Codex 节点停在半行上）。所以长值放进节点终端的环境变量：`ARMADRA_CODEX_HOOK` 是那一张 Hook 表（各事件相同），`ARMADRA_CODEX_INSTRUCTIONS` 是 TOML 字符串形式的说明；启动行只写 `-c "hooks.SessionStart=$ARMADRA_CODEX_HOOK"`、`-c "developer_instructions=$ARMADRA_CODEX_INSTRUCTIONS"`，由 shell 展开成一个词，整行约 450 字节。环境早于本版本的旧 shell 展开成空值，Codex 当场报配置错误，而不是悄悄不带 Hook 启动。

节点 id 不上启动行：`ARMADRA_NODE_ID` 等地址变量早已由 `agentEnvironment` 放进节点终端的环境，Hook 客户端与进程内模块都从那里读。Codex 的命令字符串因此对所有节点相同，信任记录只要写一次。

**Codex 启动升级检查**：`Update now?` 提示会把第一条任务当成回答（回车 = 升级，端到端里真把全局 codex 升级过一次）。画布启动 Codex 时逐次加 `-c check_for_update_on_startup=false`。键名从 Codex 0.155.1 的配置结构里读出，并在临时 `CODEX_HOME` 里用一份指向更新版本的 `version.json` 实测：不加时 TUI 停在 `Update available! 0.155.1 -> 0.157.0`，加上后直接进入目录信任提示。

## 4. Codex 的信任记录（方案 A）

Codex 只执行它信任的 Hook，而且**静默**：没有正确的 `trusted_hash`，Hook 就不跑。信任只从用户层 `config.toml` 读——用 `-c hooks.state…` 在命令行传信任无效。所以这是整个集成**唯一一处全局写入**，集成页上写明写在哪。

- 键：`hooks.state."/<session-flags>/config.toml:<事件蛇形名>:0:0"`。前缀是字面量，从 `codex app-server` 的 `hooks/list` 原样读出；我们的组总是该事件在命令行上唯一的一组，所以两个序号都是 0。
- 哈希：沿用 `codex.ts::hookHash`（规范化身份 `{ event_name, matcher?, hooks: [{ async, command, timeout, type }] }` 的键排序紧凑 JSON 的 SHA-256；`SessionEnd` 超时 1 秒，其余 600 秒）。在临时 `CODEX_HOME` 里用 `hooks/list` 对照：带 matcher 的 `pre_tool_use`、不带的 `session_start`、1 秒的 `session_end` 三种形状的 `currentHash` 与 `hookHash` 逐字节相同（用例 `codex.test.ts` 锁住这三个值）；把这些哈希写进临时 `config.toml` 后 `hooks/list` 报 `trusted`，`codex exec` 下 `SessionStart` / `UserPromptSubmit` / `Stop` / `SessionEnd` 都真的调用了 Hook，且带着 `ARMADRA_NODE_ID`。
- 用户自己 `config.toml` 里的 `[hooks.SessionStart]` 与我们的会话级 Hook 并存：前者的键是 `<CODEX_HOME>/config.toml:session_start:0:0`，互不覆盖。
- 什么时候写：core 启动时（只在这台机器有 Codex 配置目录时，不替没用过 Codex 的机器建 `~/.codex`）、每次节点终端要起 Codex 时、集成页「重新生成」时。幂等，内容不变不写；认不出的 `config.toml`（括号不配平）拒绝改写。
- 被信任的是固定命令 `<数据目录>/bin/armadra-hook codex`；有人在画布外用同样的 `-c` 手敲这条命令，它也会跑——那条命令在没有 `ARMADRA_NODE_ID` 时什么都不做。
- 一个已知的边：若用户自己也在命令行上用 `-c hooks.<Event>=…`，它占同一个 `…:0:0` 键，而哈希是我们的，它会被判为未信任（与没有我们时一样）；若用户自己恰好为这个键写过信任，我们会覆盖它。

## 5. 升级迁移与集成页

`core/hook/install/migrate.ts`，core 启动时（技能正文注册之后）跑一次：

- 识别旧的全局安装：Claude `settings.json` 里我们的 Hook 与旧状态行；Codex `hooks.json` 里的条目与它们在 `config.toml` 的信任记录；Copilot `hooks/armadra.json`；OpenCode / Pi / OMP 扫描目录里的 `armadra-status` 模块；六个 CLI 的 `skills/armadra`（只认带修订号尾注的那份）与更早的技能目录名。
- 先备份：用户也会编辑的文件复制成旁边的 `<文件>.armadra-backup-<时间戳>`（沿用修复按钮的约定），字节没变的备份随即删掉；只有我们写过的文件（模块、`SKILL.md`）备份进 `<数据目录>/integration/global-backup-<时间戳>/<cli>/`——放在原处会被 CLI 当成又一个扩展或技能扫到。
- 只删我们写的：Hook 条目按 `armadra-hook` 识别，模块与技能按内容识别，其余原样写回。
- 只一次：结果写进 `<数据目录>/integration/global-migration.json`，存在即视为已做，失败也记下来，不会每次启动都去改用户的文件。

集成页每种 CLI 一行：「画布内注入」、Hook 与技能是否为当前修订、Codex 行上的「信任记录写在 ~/.codex/config.toml」、迁移清掉过东西时的「已清理全局安装」（悬停看备份路径）、旧残留与修复。原来的「安装 / 卸载」换成一个「重新生成」，平时不用点——每次从画布启动都会先确保产物最新。

测试套件起的 core 用的是开发者真实的 `HOME`，所以 `ARMADRA_NO_GLOBAL_WRITES=1`（vitest 的 setup 里设）让迁移与 Codex 信任记录都不发生；用例要测它们就显式传临时目录。

## 6. 画布说明

技能正文与画布说明在 `core/collab/skill.ts`（`SKILLS_REVISION` 12），三种形式开头是同一段「画布规则」：

1. 这个终端是画布上的一个节点，协作只走 `armadra-hook canvas …`（含 `post` / `send`）。
2. 用户要求创建其他 Agent、分工或并行时，一律用 `canvas open-agent` / `canvas team` 在画布上建并连线；不用 CLI 自带的子代理或后台任务冒充。
3. 需要浏览器时用画布里的浏览器节点：`armadra-hook browser <动词>`；没有连着的就先 `canvas open-browser --url <网址>`（新增的画布动词，建好后自动从调用者连一条对等边并写两份链接文档）；不用 CLI 自带的浏览器、computer-use 或无头浏览器。

浏览器动词表由 `core/browser/args.ts` 的 `VERBS` 生成，不手抄；`skill.test.ts` 断言每个动词都在、示例里的动词都存在。技能正文开头「本终端跑在 Armadra 画布的一个节点里」在逐次注入之后才真正成立，保留。

## 7. 验证

- 单元：`inject.test.ts`（六个 CLI 的 argv / env 形状、恢复时同样带上、产物幂等、修订变化时重写、Codex 信任写入与收回、关掉全局写入时不写、坏 `config.toml` 拒绝）；`migrate.test.ts`（备份、只删自己的、只一次、不是我们的同名技能不动）；`integration.test.ts`（状态、重新生成、启动准备、没有 Codex 时不建目录）；`canvas-launch.test.ts`（各路径带注入、冷启动带注入、结构性出口）。
- 端到端：`tools/probes/agent-e2e.mjs` 的场景 5，真 Claude 与真 Codex——画布外直接启动看不到 armadra 技能、不触发 Hook，画布内启动两样都生效。Codex 用临时 `CODEX_HOME` 并关掉升级检查；Claude 只能用真实配置目录，而我们对 Claude 只做逐次注入，不写它的全局文件。
