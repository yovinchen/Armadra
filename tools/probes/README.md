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

真机渲染 [Git 工具窗口](../../docs/design/git-tool-window.md) §2 的两个页签：临时数据目录里的 Rust Runtime、含三个检出的临时工作空间（根仓库有已暂存 / 未暂存 / 未跟踪的改动与一条 stash，嵌套仓库停在一次 merge 冲突上，另有一个链接 worktree）、Vite 开发服务器，以及新 profile 的无头 Chrome。

```sh
CARGO_TARGET_DIR=$PWD/target cargo build -p armadra-runtime
node tools/probes/git-tool-window.mjs [输出目录]
```

产物默认在 `target/git-tool-window/`：桌面 1440×900 的 `log-desktop.png`（三栏）、`log-maximized.png`、`commit-desktop.png`、`commit-maximized.png`，手机 390×844 的 `mobile-commits.png` / `mobile-branches.png` / `mobile-details.png` / `mobile-diff.png`（日志页的四级导航）与 `mobile-commit.png`，加一份 `result.json`。手机那几张按应用自己的行为开成最大化（`shell/MobileBottomNav.tsx`），桌面停在底部。端口随机（不用 1420 / 1421 / 43120 / 43121），数据目录与浏览器 profile 都是 `mktemp` 出来的，跑完删除；不读写操作员自己的数据目录、凭据或任何远端。页面入口（`apps/web/git-window-probe.html` 与 `src/git-window-probe.tsx`）由脚本临时写入、结束时删除——应用首页要先选工作空间，而这次要看的是窗口本身。

## 连线拖拽成功率

复现并守住[用户实测反馈](../../docs/status/platform-implementation-status.md) F6「Agent 圆点之间拖拽有时拉不出箭头」。用 CDP 的真实鼠标事件从一个终端节点的右把手拖到另一个节点身上，重复 N 次（默认 20），每次成功后点 Dock 的「撤销」把边收回来再拖下一次。

```sh
CARGO_TARGET_DIR=$PWD/target cargo build -p armadra-runtime
node tools/probes/connection-drag.mjs [输出目录] [次数]
```

跑的是应用自己的首页（`?workspace=…&board=…` 深链，见 `apps/web/src/app/use-board-sync.ts`），底下是临时数据目录里的 Rust Runtime、临时工作空间与新 profile 的无头 Chrome；端口随机（不用 1420 / 1421 / 43120 / 43121），跑完全部删除，不读写操作员自己的数据目录或凭据。

产物默认在 `target/connection-drag/`：`result.json` 记成功次数、把手实测尺寸与每次失败时指针底下的元素，第一次失败时另存一张 `failure.png`。把手量到小于 12px 直接失败——那说明 React Flow 自己的样式表又盖过了 `apps/web/src/styles/nodes.css`，圆点和它的 34px 命中区会一起被推到节点外面，正是 F6 的根因。

只覆盖鼠标：触屏的 pointer 事件、缩放后的坐标换算与多显示器缩放都没有验证。

## 画布压力（30 个终端 + 真实会话）

既有基线（[React Flow 画布](../../docs/design/canvas-react-flow.md) §6.5）的 30 个终端节点**没有会话**，量不到用户报的卡顿。这个脚本把那一列补上：每个终端节点都真的连着一个 Runtime PTY。

```sh
pnpm libs:build
CARGO_TARGET_DIR=$PWD/target cargo build -p armadra-runtime
node tools/probes/canvas-stress.mjs [输出目录] [终端数]
```

`pnpm libs:build` 不能省：Vite 从 `packages/*/dist` 解析 `@armadra/shared` 与 `@armadra/protocol`，没构建过的工作区只会得到一块 Vite 错误遮罩，而画布一个节点都不挂——脚本会在「挂载情况」那一步报 0 个 RF 节点。

量四段（空闲 3 s / 手形平移 10 s / 拖一个节点 6 s / 便签连续输入 100 字符），每段记平均 fps、p50、p95 帧时、最慢一帧、超过 33.4 ms 的帧数与 JS 堆；另外单独量一次「销毁一个会话」引发多少个组件重渲。重渲计数注入 React DevTools 的 hook 垫片（React 只在 hook 先于它就位时才给 fiber 打开 ProfileMode），判据抄 DevTools 自己的 `didFiberRender`，并且只走这次 commit 真正碰过的子树——React 在高层 bail out 时不克隆子节点，不设这道门会把没渲染的子树全部数进来。

视口写死在 `zoom 0.35`，30 个终端全部在视口里、React Flow 不裁剪，与既有基线同一个最坏情况。产物默认在 `target/canvas-stress/`：`result.json` 与 `canvas.png` / `mounted.png`。

无头 Chrome 的 rAF 上限是 60 Hz（既有基线在有屏幕的 120 Hz 窗口里跑，所以那张表的 fps 不能和这张直接比）。fps 在这里很快撞顶，**真正有判别力的是重渲组件数与最慢帧**。撤销栈深度放在最后数——数法是一直点到按钮灰掉，那会真的把改动撤回去。

## Windows ConPTY 编译探针

独立 Cargo workspace，锁定 windows-sys 0.61.2 及 Cargo.lock。仅引用 CreatePipe / CreatePseudoConsole / ResizePseudoConsole / ClosePseudoConsole API，没有创建 CLI 子进程、命名管道服务或持久会话。

先确保目标已安装；安装属于开发工具准备，不由探针自动执行：

```sh
rustup target list --installed
cargo check --locked --offline --manifest-path tools/probes/conpty-smoke/Cargo.toml --target x86_64-pc-windows-msvc --target-dir target/m0-probes/conpty
```

`--offline` 要求依赖已缓存。新环境可先运行 `cargo fetch --locked --manifest-path tools/probes/conpty-smoke/Cargo.toml`。

有 MSVC 链接器与 Windows SDK 的环境才可继续链接：

```sh
cargo build --locked --manifest-path tools/probes/conpty-smoke/Cargo.toml --target x86_64-pc-windows-msvc --target-dir target/m0-probes/conpty
```

**cargo check 成功不等于链接成功，更不等于 Windows 实机验收。** 此源码是 API 编译探针，不能拿来验证并发 I/O、CLI 行为或句柄生命周期；实机阶段应增加独立输入/输出线程和持续输出排空后再扩展运行测试。

实测记录与待办见 [M0 执行器核验](../../docs/research/m0-executor-probes.md)。

## TypeScript Core 的终端域（R2）

三个脚本，三个不同的问题。结果与结论记在 [TypeScript Core 进度](../../docs/status/typescript-core-status.md)。

```sh
pnpm --filter @armadra/desktop build                      # 产出 out/core/main.js

node tools/probes/core-terminal-smoke.mjs                 # 建 / 附 / 打字 / 断 / 重附 / 销毁
node tools/probes/core-terminal-bench.mjs                 # 吞吐与同期 HTTP 延迟，Rust 与 TS 对跑
node tools/probes/core-terminal-bench.mjs --packaging     # 只看 release/ 里 node-pty 的位置
node tools/probes/core-terminal-packaged.mjs              # 打包版 + ARMADRA_CORE=ts，从页面开一个终端
```

- **smoke**：起一个 core，开终端，打字看回显，关掉 WS 再开一次确认看得见刚才那屏（`sawEarlierOutput`），最后销毁会话；顺带验证不存在的会话在升级前就被 404 拒掉。
- **bench**：`--megabytes`（默认 200）与 `--requests`（默认 200）。要对跑得先 `cargo build -p armadra-runtime`；只跑一侧用 `--only ts|rust`。延迟走 `node:http` 而不是 `fetch`——同一条路由 `fetch` 稳定多报约 490 ms。
- **packaged**：需要先 `pnpm --filter @armadra/desktop dist`。调试端口是运行时选的空闲端口，不是固定值：机器上另一个 Electron 占着固定端口时，探针会连上别人的渲染进程，失败起来和打包出错一模一样。

三个脚本都用 `mktemp` 的数据目录与各自私有的 tmux socket，跑完 `kill-server` 并删掉目录；不碰操作者自己的数据目录或 tmux server。工作空间那一行由脚本直接写库——`POST /api/workspaces` 是 R1 的，本阶段还没有。
