# 远端画布注入：SSH 终端里的 Hook、技能与画布说明

> 状态：**已实施（2026-09-26）**。补 [画布内注入](./canvas-only-integration.md) 没覆盖的一块：SSH 终端里起的 CLI。远端执行主机的其余部分见状态文档 §34、§44、§55。

## 1. 问题

画布内注入的产物（插件目录、扩展、`SKILL.md`、说明文件、`armadra-hook` 启动器）都在控制端的 `<数据目录>/integration/<cli>/`，启动行与节点终端的环境变量里写的是这些本机路径。SSH 终端里敲的启动行由执行主机上的 shell 读：

- 路径在那边不存在，CLI 要么报错（`--settings` 指向不存在的文件），要么什么都没加载；
- 节点终端的环境变量（`ARMADRA_NODE_ID`、`ARMADRA_ENDPOINT_FILE` 等）设在本机的 `ssh` 客户端进程上，`ssh` 不转发它们，远端 shell 里一个都没有；
- 就算有 Hook 客户端，远端也没有一条回到控制端 core 的路：桌面版的 Hook 服务只听本机的 unix socket。

页面拼的启动行还带着本机探测到的程序绝对路径（`/opt/homebrew/bin/claude`），在执行主机上同样不存在。

## 2. 方案

四件事，都挂在已有的 Worker 连接上（`worker --stdio`，能力 `remote.integration.v1`）：

1. **产物同步**：控制端按执行主机上的根目录生成同一套产物（`hook/install/remote.ts`，复用 `artifactFiles`，路径用 `path.posix`），经 Worker 写到 `<Worker 状态目录>/integration/<版本>/`。状态目录是 `--state-dir`，缺省 `~/.armadra-worker`。控制端先只报路径与 SHA-256，Worker 答缺了或不一样的那些，控制端只发这些的内容；Worker 不重写相同的文件，并拒绝落在注入目录之外的路径。同一台主机指纹没变就不再同步，连接断开后重新确认一次。
2. **Hook 客户端**：`armadra-hook.js` 这份包本身同步过去，旁边写一个启动器 `bin/armadra-hook`，用 Worker 自己那个 node（`process.execPath`）跑它。远端一定有 node：Worker 就是用它跑的（`remote/node-probe.ts` 在连接前已经确认过版本）。
3. **垫片**：每个 CLI 一个同名垫片 `shims/<cli>`（POSIX sh）。它把自己的目录从 `PATH` 里摘掉，设好注入要的环境变量（OpenCode 的配置目录、Copilot 的说明目录），然后 `exec <cli> "$@" <注入的 argv>`。启动行因此不带任何注入的词，也不带本机的程序路径：页面、依赖编排、节能唤醒拼的都是 `claude --model …`（`agent/canvas-launch.ts` 的 `ssh` 分支、`web/agent/launch.ts` 的 `remote` 参数）。Codex 那几 KB 的 `-c` 值写在垫片里，不经 PTY，也就没有 §3 的截断问题。
4. **远端 shell 的环境**：画布 Agent 的 SSH 终端不再只是 `ssh -t host`，而是 `ssh -t host 'env ARMADRA_NODE_ID=… … ARMADRA_SHIMS=… /bin/sh -c '\''PATH="$ARMADRA_SHIMS:$PATH"; export PATH; exec "${SHELL:-/bin/sh}" -l'\'''`（`terminal/ssh/argv.ts::remoteShellCommand`）。转过去的是节点身份、会话代次与权限等待这些 `ARMADRA_*` 值；`ARMADRA_ENDPOINT_FILE` 换成远端这个控制端的端点文件，另加 `ARMADRA_HOOK_TIMEOUT_MS=4000`（多一趟中继往返）。远端登录 shell 可能是 sh、fish 或 csh，所以 shell 相关的都放进 `/bin/sh -c`，值一律单引号，含 `'`、`\`、`!` 或控制字符的值不转（目前只可能是节点名，它只是显示用的）。

一个终端要起的时候（`terminal/ssh/backend.ts` 的 `decorate`，新建与回收都走这里）由 `remote/integration.ts` 依次：定位（`integration.locate`）→ 同步产物 → 同步这个节点的令牌文件（与本机同一个派生值，0600）→ 确保中继开着 → 答远端环境。最多等 30 秒；任何一步失败都只让这个终端不带注入：没有远端命令、没有垫片，CLI 照常启动。不是 Agent 的 SSH 终端、主机没配 Worker、Worker 太旧（不带 `remote.integration.v1`）同理。

Codex 只跑它信任的 Hook，信任只从用户层 `config.toml` 读，所以同步时顺带在执行主机上写信任记录（命令是远端启动器的路径）——规则与本机相同：那台机器有 `~/.codex` 才写，`ARMADRA_NO_GLOBAL_WRITES=1` 时不写，认不出的 `config.toml` 不改写。

## 3. Hook 上报的回传通道：Worker 中继

选的是「Worker 在远端开 unix socket 当 Hook 端点，经 Worker 连接把请求转给 core」，Hook 客户端本身照样同步过去用远端 node 跑——两件事并不互斥：客户端总要在远端跑，差别只在它连到哪。

- Worker 在控制连接的会话里开 `<状态目录>/run/<控制端 id>.sock`（路径超过 100 字节时改在系统临时目录下），0600，目录 0700。控制端 id 是控制端主机名与数据目录的哈希，两个控制端连同一台主机时各有各的 socket 与端点文件。
- Hook 客户端照原样发 HTTP/1.1。Worker 收齐请求体（上限与控制端 Hook 服务相同，1 MiB）后推一帧 `hook.request`（方法、路径、原始头、base64 请求体），控制端把它原样发给本机 Hook 服务，只把 `X-Armadra-Hook-Token` 换成真的应用令牌，再用 `hook.reply` 把状态、头与体送回；Worker 写回给等着的客户端。一条请求最多等 15 分钟（权限请求会等人回答）。
- 执行主机上的端点文件里令牌是占位值 `relay`：应用令牌不离开控制端。能连上中继 socket 的只有 Worker 所属的用户，与本机「同一用户」的信任边界一样；节点令牌照本机的规矩按节点一份。
- socket 随 Worker 会话生死。控制连接每次握手成功都重开中继；这台主机上开过画布 SSH 终端时，连接断开后控制端隔几秒自己把连接拉起来，而不是等下一个文件请求。中继不在时客户端连不上，按原来的规矩静默退出，不挡住 CLI。

没选的两条：

| 方案                                                  | 为什么不选                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 终端的 `ssh` 加 `-R <远端 socket>:<本机 Hook socket>` | 要 sshd 开 `AllowStreamLocalForwarding`，残留 socket 文件要 `StreamLocalBindUnlink`；每个终端一条转发，终端断线就没了；应用令牌要写到远端 |
| 远端开一个完整的 core 做 Hook 服务                    | 多一个要鉴权、要回收的监听方，状态（节点、画布）又不在那边——Hook 的去处本来就是控制端                                                     |

## 4. 已知的边

- 远端登录 shell 的 profile 若整条重设 `PATH`（不是在前面追加），垫片目录就丢了，CLI 照常启动但不带注入。macOS 的 `path_helper` 会把已有条目挪到系统路径之后：真 CLI 若装在 `/usr/local/bin` 这类系统路径里，同样绕过垫片。Linux 执行主机的常见配置不受影响。
- 只有六个内置 CLI 有垫片。`custom:` 条目若改了程序名（`launchCmd`），远端不注入。
- 核心重启后，SSH 终端（tmux 窗格）还活着，但中继要等这台主机的控制连接下次建立时才重开（远端工作空间一打开就会建立；只有 SSH 终端的主机要等下一次开终端）。
- 端到端用的是假 ssh（`tools/probes/remote-e2e.mjs` 场景 8）：同一台机器上的 `/bin/sh -c`，没有验证真实 sshd 对远端命令的处理。

## 5. 验证

- `remote/integration.test.ts`：本机子进程跑真 Worker（`--state-dir` 指向临时目录），Hook 客户端打成包由 Worker 的 node 跑；按哈希只同步一次、令牌文件权限、端点文件里没有应用令牌；把 `remoteShellCommand` 交给 `/bin/sh -c`（sshd 做的事），远端登录 shell 换成只敲 `claude --model m` 的脚本，假 CLI 经垫片拿到 `--settings` / `--plugin-dir` / `--append-system-prompt-file`、读到说明与技能、`PATH` 里已没有垫片目录，并照 `settings.json` 的 Hook 命令报一次 SessionStart——这次上报经中继到达控制端的 Hook 服务，令牌已换成控制端的；Worker 断线后中继自己恢复。
- `agent/canvas-launch.test.ts`：SSH 节点的启动行与恢复行只有程序名与 CLI 自己的旗标。
- `tools/probes/remote-e2e.mjs` 场景 8：见状态文档 §55。
