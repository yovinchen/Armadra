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

## Git 提交页截图

真机渲染 [Git 工具窗口](../../docs/design/git-tool-window.md) §2.3 的提交页：临时数据目录里的 Rust Runtime、含两个仓库的临时工作空间（根仓库有已暂存 / 未暂存 / 未跟踪的改动，嵌套仓库停在一次 merge 冲突上）、Vite 开发服务器，以及新 profile 的无头 Chrome。

```sh
CARGO_TARGET_DIR=$PWD/target cargo build -p armadra-runtime
node tools/probes/git-commit-page.mjs [输出目录]
```

产物默认在 `target/git-commit-page/`：`desktop.png`（1440×900）、`mobile.png` 与 `mobile-diff.png`（390×844 的两级导航），加一份 `result.json`。端口随机（不用 1420 / 1421 / 43120 / 43121），数据目录与浏览器 profile 都是 `mktemp` 出来的，跑完删除；不读写操作员自己的数据目录、凭据或任何远端。页面入口（`apps/web/git-commit-probe.html` 与 `src/git-commit-probe.tsx`）由脚本临时写入、结束时删除——提交页还没被窗口壳挂上去，这两个文件只为这一次渲染存在。

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
