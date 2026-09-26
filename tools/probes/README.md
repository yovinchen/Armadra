# M0 执行器探针

这些入口只核验底层可行性，不启动应用服务，不构成完整浏览器或 Windows 持久终端实现。全部命令从仓库根目录运行；无需修改根 manifest。

## 受控 Chromium

需要 Node.js 22+（内置 WebSocket/fetch）和已安装的 Chrome/Chromium；脚本不下载浏览器。默认探测系统常见安装路径，也可显式选择可执行文件：

```sh
node tools/probes/browser-cdp.mjs
CHROME_PATH='/path/to/chrome' node tools/probes/browser-cdp.mjs /path/to/output-directory
```

Windows PowerShell：

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tools/probes/browser-cdp.mjs
```

每次创建独立输出子目录，默认位于已忽略的 `target/m0-probes/`。产物包括 `result.json`、`browser.png`（截图步骤通过后）和 `chrome-stderr.log`。结果包含实际浏览器版本、系统和能力；失败返回非零退出码。

浏览器 profile 在系统临时目录中新建，正常结束或已捕获的失败均执行退出和 profile 清理；不使用已有 profile。测试 HTTP 服务和 CDP 仅绑定本机随机端口。脚本只向自身生成的表单页面注入固定测试代码，不接入真实账号。进程被强制杀死、系统崩溃等无法执行 finally 的情况需手动清理残留临时 profile。

探测导航、表单输入和点击、英文/中文/emoji 文本插入、Canvas/表单 PNG、滚动和 screencast ACK。中文文本插入不等于操作系统 IME composition 验证；没有验证画布节点裁剪/缩放、移动端、完整 Browser Worker 或性能预算。跨平台分支需在各自平台运行后才算验证。

## Git 工具窗口截图

真机渲染 [Git 工具窗口](../../docs/design/git-tool-window.md) §2 的两个页签：临时数据目录里的 core（`apps/desktop/out/core/main.js`）、含三个检出的临时工作空间（根仓库有已暂存 / 未暂存 / 未跟踪的改动与一条 stash，嵌套仓库停在一次 merge 冲突上，另有一个链接 worktree）、Vite 开发服务器，以及新 profile 的无头 Chrome。

```sh
pnpm --filter @armadra/desktop build
node tools/probes/git-tool-window.mjs [输出目录]
```

产物默认在 `target/git-tool-window/`：桌面 1440×900 的 `log-desktop.png`（三栏）、`log-maximized.png`、`commit-desktop.png`、`commit-maximized.png`，手机 390×844 的 `mobile-commits.png` / `mobile-branches.png` / `mobile-details.png` / `mobile-diff.png`（日志页的四级导航）与 `mobile-commit.png`，加一份 `result.json`。手机那几张按应用自己的行为开成最大化（`shell/MobileBottomNav.tsx`），桌面停在底部。端口随机（不用 1420 / 1421 / 43120 / 43121），数据目录与浏览器 profile 都是 `mktemp` 出来的，跑完删除；不读写操作员自己的数据目录、凭据或任何远端。页面入口（`apps/web/git-window-probe.html` 与 `src/git-window-probe.tsx`）由脚本临时写入、结束时删除——应用首页要先选工作空间，而这次要看的是窗口本身。

## 连线拖拽成功率

复现并守住[用户实测反馈](../../docs/status/platform-implementation-status.md) F6「Agent 圆点之间拖拽有时拉不出箭头」。用 CDP 的真实鼠标事件从一个终端节点的右把手拖到另一个节点身上，重复 N 次（默认 20），每次成功后点 Dock 的「撤销」把边收回来再拖下一次。

```sh
pnpm --filter @armadra/desktop build
node tools/probes/connection-drag.mjs [输出目录] [次数]
```

跑的是应用自己的首页（`?workspace=…&board=…` 深链，见 `apps/web/src/app/use-board-sync.ts`），底下是临时数据目录里的 core、临时工作空间与新 profile 的无头 Chrome；端口随机（不用 1420 / 1421 / 43120 / 43121），跑完全部删除，不读写操作员自己的数据目录或凭据。

产物默认在 `target/connection-drag/`：`result.json` 记成功次数、把手实测尺寸与每次失败时指针底下的元素，第一次失败时另存一张 `failure.png`。把手量到小于 12px 直接失败——那说明 React Flow 自己的样式表又盖过了 `apps/web/src/styles/nodes.css`，圆点和它的 34px 命中区会一起被推到节点外面，正是 F6 的根因。

两个节点在种子里就带着名字（`data.handle`）：两端缺名字时，连线一建立就会弹起名对话框（[Agent 投递](../../docs/design/agent-delivery.md) §2.2 的 `requestNodeNames`），它的遮罩会吃掉紧接着的「撤销」点击。点撤销前若看到对话框遮罩，脚本直接报「连线后弹出了对话框」，不会把它误记成撤销失败。起名对话框本身不在这里验证。

只覆盖鼠标：触屏的 pointer 事件、缩放后的坐标换算与多显示器缩放都没有验证。

## 画布压力（30 个终端 + 真实会话）

既有基线（[React Flow 画布](../../docs/design/canvas-react-flow.md) §6.5）的 30 个终端节点**没有会话**，量不到用户报的卡顿。这个脚本把那一列补上：每个终端节点都真的连着一个 core 的 PTY。

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
node tools/probes/canvas-stress.mjs [输出目录] [终端数]
```

`pnpm libs:build` 不能省：Vite 从 `packages/shared/dist` 解析 `@armadra/shared`，没构建过的工作区只会得到一块 Vite 错误遮罩，而画布一个节点都不挂——脚本会在「挂载情况」那一步报 0 个 RF 节点。

量四段（空闲 3 s / 手形平移 10 s / 拖一个节点 6 s / 便签连续输入 100 字符），每段记平均 fps、p50、p95 帧时、最慢一帧、超过 33.4 ms 的帧数与 JS 堆；另外单独量一次「销毁一个会话」引发多少个组件重渲。重渲计数注入 React DevTools 的 hook 垫片（React 只在 hook 先于它就位时才给 fiber 打开 ProfileMode），判据抄 DevTools 自己的 `didFiberRender`，并且只走这次 commit 真正碰过的子树——React 在高层 bail out 时不克隆子节点，不设这道门会把没渲染的子树全部数进来。

视口写死在 `zoom 0.35`，30 个终端全部在视口里、React Flow 不裁剪，与既有基线同一个最坏情况。产物默认在 `target/canvas-stress/`：`result.json` 与 `canvas.png` / `mounted.png`。

便签那一段点的是便签正文，找 textarea 也限在 `[data-slot="sticky-node"]` 里：每个终端的 xterm 都挂着一个隐藏的 helper textarea，排在便签前面。2026-09-26 之前的脚本用的是不限范围的 `querySelector("textarea")`，字符其实打进了第一个终端的 PTY——那之前记下的「输入 100 字符」各项数字量的都不是便签。

无头 Chrome 的 rAF 上限是 60 Hz（既有基线在有屏幕的 120 Hz 窗口里跑，所以那张表的 fps 不能和这张直接比）。fps 在这里很快撞顶，**真正有判别力的是重渲组件数与最慢帧**。撤销栈深度放在最后数——数法是一直点到按钮灰掉，那会真的把改动撤回去。

## core 的终端域

三个脚本，三个不同的问题。结果与结论记在 [TypeScript Core 进度](../../docs/status/typescript-core-status.md)。

```sh
pnpm --filter @armadra/desktop build                      # 产出 out/core/main.js

node tools/probes/core-terminal-smoke.mjs                 # 建 / 附 / 打字 / 断 / 重附 / 销毁
node tools/probes/core-terminal-lifecycle.mjs             # 会话的生命周期：退出、回收、重启后的对账
node tools/probes/core-terminal-packaged.mjs              # 打包版，从页面开一个终端
```

- **smoke**：起一个 core，开终端，打字看回显，关掉 WS 再开一次确认看得见刚才那屏（`sawEarlierOutput`），最后销毁会话；顺带验证不存在的会话在升级前就被 404 拒掉。
- **packaged**：需要先 `pnpm --filter @armadra/desktop dist`（本机没有 `CSC_LINK` 时 `dist.mjs` 自动跳过签名与公证）。按访达的方式启动：`PATH` 只给 launchd 那条（`/usr/bin:/bin:/usr/sbin:/sbin`），数据目录用 `ARMADRA_DATA_DIR`、Chromium profile 用 `--user-data-dir` 都指到临时目录，不碰操作员的 `~/Library/Application Support/Armadra`。本机装了 tmux（Homebrew 等常见位置）时，会话必须是 `tmux` 后端，资源采样（`GET …/resources`）也必须给出这个会话的 pid——两处各自找 tmux，都得用补过的 PATH。调试端口是运行时选的空闲端口，不是固定值：机器上另一个 Electron 占着固定端口时，探针会连上别人的渲染进程，失败起来和打包出错一模一样。

三个脚本都用 `mktemp` 的数据目录与各自私有的 tmux socket，跑完 `kill-server` 并删掉目录；不碰操作者自己的数据目录或 tmux server。

## 本轮界面功能的端到端验证

真 core（`apps/desktop/out/core/main.js`）、真 Vite 页面、新 profile 的无头 Chrome，经浏览器级 CDP 连接驱动；多设备场景用两个独立的 browser context 当两台设备。场景拆在 `ui-features/` 里，共用一套临时环境（`harness.mjs`），媒体夹具与截图像素统计在 `fixtures.mjs`。

## Agent 协作端到端（真 Claude Code + 真 Codex CLI）

用真 CLI 把投递、依赖编排、组队与节能休眠走一遍。页面必须真的挂着这些终端节点：CLI 起来时的终端查询由 xterm 经页面写回 PTY，[状态文档](../../docs/status/typescript-core-status.md) §31.7 那个「Codex 首条任务投不出去」只在页面挂着时出现。每个 Agent 节点都由页面挂载、由页面敲启动行。

## 服务器壳端到端（账号、共享与 headless 浏览器）

真进程走一遍多人使用服务器壳的主线（[TypeScript Core 进度](../../docs/status/typescript-core-status.md) §42、§39，结果记在 §50）。

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
node tools/probes/ui-features-e2e.mjs [输出目录] [--only=presence,editor,fileTree,search,keybindings,integration,resources]
```

产物默认在 `target/ui-features-e2e/`：`result.json`（每个场景的检查项、实测数字、截图路径与控制台错误）与截图；窄屏 390×844 的截图以 `mobile-` 开头，场景失败时每个截过图的页面补一张 `failure-<场景>-N.png`。每个场景都收集 `Runtime.consoleAPICalled` 的 error 与 `Runtime.exceptionThrown`，有未预期的就算失败。

验证什么：

- **presence**（多设备画布）：单页面不出设备条且自动拿租约；第二台只读、显示「X 正在编辑」、拖不动；第一台一笔保存被 CDP 拦下的改动在第二台二次确认接管后被丢掉并按远端重载；关掉持有者页面后租约释放。
- **editor**：PNG（透明、棋盘格像素统计、滚轮缩放）、PDF（截图里查看器区域不是空白）、MP4 / MP3（原生控件、元数据）；草稿刷新后恢复；草稿期间磁盘改同一文件出现三方合并；Git 行边的修改标记；快速打开的最近文件与 `文件:行:列`。MP4 由同一个 Chrome 的 MediaRecorder 录 canvas 得到，MP3 是合法的静音帧，PDF 手写对象表，都不依赖外部工具。
- **fileTree**：右键「复制路径 / 复制相对路径」写进剪贴板的内容（授予 context 剪贴板权限后读回），浏览器里没有「在访达中显示」。
- **search**：先直接问 core 量一次整轮扫描（约 3.6 万个文件），再在页面上中途换关键词、点「停止」；core 的 debug 日志「文件搜索随连接断开中止」带着 `visited`，断言它明显小于整轮文件数。
- **keybindings**：设为无、追加第二组键、`when` 的语法错与未知键提示且不能保存；回到画布用真实键盘事件确认改动生效，最后全部重置。
- **integration**：临时 HOME 的 `.claude/settings.json` 里 11 条相同的旧 Hook；行布局、「旧残留 11」弹层在设置对话框之上、同一命令合并为 ×11；「修复」只清残留、保留用户自己的命令并留备份。
- **resources**：`ARMADRA_REMOTE_WORKER_LAUNCHER` 指向探针写的替身 ssh，远端命令是本仓库的 `main.js worker --stdio`，所以「构建机」的总览是 Worker 真读出来的；主机筛选（全部 / 本机 / 构建机）；休眠会话在节点与面板上的显示；`ARMADRA_STATUS_PAGE_BASE` 指向本机 fixture 时用量卡的状态徽标。

没验证什么：休眠的**判据与接回**（休眠状态是经 API 结束会话后在数据库里把结束原因置成 `hibernate`，与 `Manager.hibernate` 写的同形；真正走到休眠要一个空闲 5 分钟以上的 Agent CLI）；真实 SSH 与另一台机器；打包应用里的 PDF 查看器与视频解码（这里是无头 Chrome）；触屏手势（窄屏只按视口宽度截图）。

一切都是临时的、回环的：随机端口（不用 1420 / 1421 / 43120-43125）、`mktemp` 的数据目录、HOME、`CLAUDE_CONFIG_DIR` / `CODEX_HOME`、替身脚本与浏览器 profile，结束时全部删除并停掉自己起的 tmux 服务器；不读写操作员自己的数据目录与 CLI 配置，不联网。

node tools/probes/agent-e2e.mjs [输出目录] [--only 1,2,3,4]

```

入口只装配与收尾；各场景在 `agent-e2e/scenario-*.mjs`，共用的临时环境、core / Vite / Chrome 装配与断言工具在 `agent-e2e/lib.mjs`。

四个场景：

1. **Codex 首投**：普通终端节点当发送方（探针以它的节点身份跑 `armadra-hook canvas`，令牌经 `POST /api/terminals/{id}/node-token/refresh` 签发），`send` 投给两个互相连线的 Codex，再 `open-agent --task` 建第三个；断言投递 `delivered` + `targetState = observed-quiet`，且 hook 随后报了一轮。
2. **Claude 投递**：hook 状态通道那条路（`targetState = idle`）；半截输入门——经页面在 Claude 输入框里打半行不回车，等人的租约过期后 `send` 排队 `TARGET_INPUT_PENDING`，回车后投出去。
3. **依赖编排与组队**：`open-agent --after <上游> --after-turn next`、`team --member … --chain`；再关掉页面触发一次，断言由 core 自己起进程并投出任务。
4. **节能休眠**：`ARMADRA_TEST_ECO_IDLE_SECONDS=20`（`core/terminal/hibernate.ts::ecoTestOverride`，只有启动 core 的进程能给，设置的 5 分钟下限不变），关掉页面让 Claude 与 Codex 都睡着、确认 CLI 进程退出；重开页面点节点唤醒，断言同一会话 id 起下一代、恢复行带同一个 provider 会话 id、还记得之前让它记的数。

隔离：数据目录、工作空间、浏览器 profile 与 CODEX_HOME 全部 `mktemp`，结束删除并停掉自己的 tmux 服务器。Codex 用临时 CODEX_HOME（只复制 `~/.codex/auth.json`，关掉启动时的升级检查，预先信任工作目录；token 超过 7 天没刷新就拒跑）。Claude 的登录在钥匙串里，临时 `CLAUDE_CONFIG_DIR` 认证不上，所以 Claude 进程用真实配置目录——前提是 Armadra 对 Claude 走启动时注入（`--settings` 指向数据目录里的文件），探针启动前就检查这一点；core 自己的 `CLAUDE_CONFIG_DIR` 指向临时目录，技能文件只写在那里。终端子进程的环境按白名单建，于是 `SHELL` 换成一个临时包装脚本（导出临时 CODEX_HOME、去掉 CLAUDE_CONFIG_DIR、`exec zsh -f`）。跑前跑后比对 `~/.claude/settings.json`、`~/.codex` 的 `config.toml` / `hooks.json` / `auth.json` 与两个 CLI 的版本；Claude 仍会像平常一样在 `~/.claude.json` 与 `~/.claude/projects/` 里记下这个临时目录的会话。

产物默认在 `target/agent-e2e/`：`result.json`（逐条断言、时间线、投递记录、控制台错误、配置比对）、每个场景的截图与 `core.log`。一次全量约 4–5 分钟（实测 245 秒），花费是十几轮「回复 OK」量级的 token。

没验证的：direct / 会话宿主后端（macOS 缺省是 tmux）；Claude 的权限提示与审批路径；休眠后经 `send` 唤醒（只验了点击唤醒）；打包版。
```

pnpm --filter @armadra/server build
pnpm --filter @armadra/web build
node tools/probes/server-e2e.mjs [输出目录]

````

`apps/server/out/main.js serve` 用临时数据目录启动并托管 `apps/web/dist`（自签名 HTTPS，Chrome 带 `--ignore-certificate-errors`）。无头 Chrome 开两个互不共享 Cookie 的浏览器上下文：管理员打开启动日志里的配对链接完成配对，在「账号与共享」生成只读邀请；成员在另一个上下文打开 `#invite=` 链接注册。之后依次验证：成员打开共享画布时全局路由的 403 逐条记下（`memberForbidden`、`memberSettings`），界面没有报错横幅与控制台错误；只读时右上角写「只读」、便签拖不动、不发被拒的保存，直接写接口是 403；管理员改成「编辑」后下一拍心跳解除只读、拖动落盘；撤销共享后成员的事件流以 4403 关闭、下一个请求 403、页面离开那块工作空间；最后管理员在服务器壳上新建浏览器节点，起始页是探针自己的回环页面，取画面流上的像素确认第一帧到了。

产物默认在 `target/server-e2e/`：`result.json` 与 `01-admin-paired.png` … `11-admin-browser-stream.png`。端口随机，数据目录、项目目录与浏览器 profile 都是 `mktemp`，服务器壳先 SIGTERM（让它收掉自己起的 headless Chromium）再删目录、停 tmux。没有验证：`--public-origin` 与真证书、passkey / OAuth、多于一个成员、手机布局。

## 远端执行主机端到端（假 ssh）

在界面上把远端工作空间用一遍（§34、§44，结果记在 §50），不需要 sshd，也不改任何 SSH 或系统配置。

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
node tools/probes/remote-e2e.mjs [输出目录]
````

「远端」就是这台机器：core 本来就读 `ARMADRA_REMOTE_WORKER_LAUNCHER` 替换每条 `ssh` 启动行的 argv[0]（`core/remote/index.ts`），探针把它指到临时目录里的一个假 ssh——按 `ssh(1)` 的规则吃掉选项与目的主机，把剩下的远端命令交给本机 `/bin/sh -c`；Worker 就是 `apps/desktop/out/core/main.js worker --stdio`。执行主机登记与 mock-lsp 的语言服务器设置走接口，其余全在界面上：设置 → SSH 打开远程项目；资源管理器打开文件、编辑、⌘S 落盘；Git 窗口的状态、勾选暂存、提交；日志页右键「获取远端更新」看进行中的提示与百分比，再对一次 upload-pack 睡 30 秒的 fetch 点「取消」；打开 `notes.md` 看 mock-lsp 的诊断（并按进程树确认它跑在 `worker --stdio --language-link` 下面）；在远端磁盘上改开着的文件看编辑器跟上（登记答 `mode: events`）；资源面板按主机筛选；设置 → 执行主机把一个本机工作空间切到假远端再切回来。

产物默认在 `target/remote-e2e/`：`result.json` 与每一步的截图（`01-remote-workspace.png` … `07c-switched-local.png`）。上游是临时目录里的裸仓库，`remote.origin.uploadpack` 指向一个先睡几秒的包装，本机传输才看得到进行中与取消。没有验证：真实的 ssh 传输、主机密钥与 askpass、跨机器的路径与平台差异、远端终端节点（它走真 `ssh`，不经这个替换）。
