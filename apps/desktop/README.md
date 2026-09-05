# apps/desktop

Tauri 2 薄桌面壳。

负责启动/发现 Go Host、启动 Runtime、健康检查、加载同一套 Web 页面，以及标题栏覆盖、托盘、通知和
系统权限入口。业务逻辑不写进 Tauri command，避免形成第二套后端。

生产构建从包内 sidecar 启动 `armadra-runtime`。`./armadra.sh run desktop` 也由桌面持有 debug Runtime；独立 `pnpm --filter @armadra/desktop dev` 默认仍连接外部 Runtime。桌面只通过自己持有的子进程管道进行明确关停。

Go Host 在启动时异步准备，使用独立后台进程。Command W/窗口叉号关闭到托盘，保留后台及隐藏 WebView 中的编辑草稿；菜单、托盘或 macOS Dock 可恢复前台。Command Q/“退出并停止后台”停止配置目录的 Go Host，再请求桌面持有的 Runtime 结束受管会话并退出；任何未确认完成的关停都会显示失败，不能当作全部停止。当前 Runtime 业务仍未迁移到 Host，后台计划尚未实现。

```bash
pnpm --filter @armadra/desktop dev     # 需要 cargo run -p armadra-runtime 已在跑
pnpm --filter @armadra/desktop build
pnpm --filter @armadra/desktop prepare:sidecar   # 准备 Runtime、Hook 和 Go Host
pnpm --filter @armadra/desktop prepare:host --native   # 仅准备本机 Go Host
pnpm --filter @armadra/desktop test
cargo check -p armadra-desktop
```

## Host 启动与发现

Rust 启动器从开发构建目录或发布应用可执行文件同目录定位 `armadra-host`，以固定参数调用 `start --output protobuf`，有界读取结果并校验服务身份、默认地址及页面来源许可。命令参数、路径和管理动作不暴露为网页 invoke 接口。

生产地址固定为 `http://127.0.0.1:43121`，与桌面 CSP 一致。已有服务的端点或来源许可不匹配时只报告错误，不替用户重启或重配服务。Host 失败不阻止现有 Runtime/UI 启动。Host 启动与明确退出串行协调，防止退出后迟到的启动任务重新创建服务。

- `ARMADRA_DESKTOP_OWNS_RUNTIME=1` 让开发壳启动同目录 debug Runtime 并持有私有控制管道；脚本桌面启动默认设置此值。外部单独启动的 Runtime 不会被按 PID 猜测终止。
- 开发可用 `ARMADRA_HOST_BINARY` 指定绝对路径；发布版本忽略该二进制覆盖，使用包内 sidecar。
- `ARMADRA_HOST_DATA_DIR` 可指定绝对的独立 Host 数据目录，用于本机测试或用户部署。
- 开发来源取实际 `devUrl`；发布按平台配置使用相应 Tauri origin。会实际验证 OPTIONS 与 Hello，固定回环探针禁用代理和重定向。
- CLI 最长运行 15 秒，失败/超时后的父进程清理另有 2 秒上限；不会终止已独立运行的 Host。stdout/stderr/HTTP 响应均有限额，不把子进程 stderr 回显为界面错误。

`pnpm host:bootstrap-smoke` 使用同一 Rust 启动器，验证真实 Go 启动、发现、来源不兼容拒绝及启动器退出后的保活。首次运行需要本机 Rust sidecar 已准备好，可先执行 `pnpm --filter @armadra/desktop prepare:sidecar`；探针不伪造二进制来绕过 Tauri 构建检查。

Host 启动器已有真实进程保活验证；本次窗口按键与整体退出的验证结果见[实施记录](../../docs/platform-implementation-status.md)。Windows 原生窗口、安装包和正常退出仍待实机验收，不能用交叉编译替代。

## Sidecar 构建

`scripts/prepare-sidecar.mjs` 保留 `cargo build --release` 构建 `armadra-runtime` 与
`armadra-hook`，再以 `CGO_ENABLED=0` 构建 Go `armadra-host`。三个真实二进制均按 Rust
target triple 暂存到 `target/release/<binary>-<triple>[.exe]`，由
`tauri.conf.json` 的 `bundle.externalBin` 打包。Hook 客户端用于注入 Agent 终端。

`pnpm --filter @armadra/desktop dev` 的 `predev` 会先准备本机 Go Host。独立运行：

```sh
pnpm --filter @armadra/desktop prepare:host --native
pnpm --filter @armadra/desktop prepare:host --release --target x86_64-pc-windows-msvc
```

开发产物默认是仓库 `target/debug/armadra-host`，Windows 为 `armadra-host.exe`。
`--native` 忽略交叉目标环境变量，确保本机开发不会误用 Windows/Linux 二进制。
若指定 `CARGO_TARGET_DIR`，绝对路径直接使用，相对路径始终按仓库根目录解析；本机
开发产物在该目录的 `debug/` 下。显式 `--target` 的产物放到该目录的
`<triple>/debug/` 或 `<triple>/release/` 下。

Tauri 的构建脚本在开发阶段也会检查 externalBin，因此本机开发准备会同时暂存真实
Host 到固定的 `target/release/armadra-host-<triple>[.exe]`。生产
`prepare:sidecar` 会重新构建 release Host，再覆盖该暂存文件；不能将开发暂存解释为
生产安装包已经通过验证。`CARGO_TARGET_DIR` 只改变构建来源目录，Tauri 暂存目录保持
与配置一致。脚本只构建与复制文件，不启动后台 Host 或安装系统工具。

目标选择顺序为显式 `--target`（仅 prepare:host）→ `TAURI_ENV_TARGET_TRIPLE` →
`CARGO_BUILD_TARGET` → Rust host triple。Rust Runtime/Hook 继续遵守原有 Cargo
`--target` 与自定义 target-dir 行为。Go Host 仅接受以下明确映射，其他 triple 在构建前失败：

| Rust target                                                | GOOS / GOARCH          |
| ---------------------------------------------------------- | ---------------------- |
| `aarch64-apple-darwin` / `x86_64-apple-darwin`             | darwin / arm64、amd64  |
| `aarch64-unknown-linux-gnu` / `x86_64-unknown-linux-gnu`   | linux / arm64、amd64   |
| `aarch64-unknown-linux-musl` / `x86_64-unknown-linux-musl` | linux / arm64、amd64   |
| `aarch64-pc-windows-msvc` / `x86_64-pc-windows-msvc`       | windows / arm64、amd64 |
| `x86_64-pc-windows-gnu`                                    | windows / amd64        |

Go 构建使用项目锁定依赖、`-mod=readonly`、`-trimpath` 和本地工具链
`GOTOOLCHAIN=local`；release 额外去掉调试符号。Go 缓存统一在仓库
`target/protocol-go/`，默认使用 PATH 中的 `go`，也可通过 `ARMADRA_GO_BINARY` 指定
已安装的可执行文件路径。缺失 Go/Rust 或不满足项目工具链版本会报错，不自动安装。
路径和参数通过进程 argv 传递，支持包含空格的仓库与构建输出目录。

2026-09-05 在 macOS arm64 实际构建本机 Host，并执行 `--help` 验证可运行；Windows
x64/arm64 交叉构建只验证产生对应 PE 工件，不代表 Windows 安装包、签名或实机启动
通过。纯目标/路径测试可通过 `pnpm --filter @armadra/desktop test` 重复运行，导入脚本
不会触发编译或子进程。

## 插件与能力

| 插件                        | 用途                                          | 前端入口（`apps/web/src/platform/`） |
| --------------------------- | --------------------------------------------- | ------------------------------------ |
| `tauri-plugin-dialog`       | 系统目录选择器（新建工作空间 / 打开项目位置） | `pickDirectory()`                    |
| `tauri-plugin-opener`       | 用系统浏览器打开外部链接                      | `openExternal(url)`                  |
| `tauri-plugin-notification` | Agent 状态变化的系统通知                      | `notify()`                           |

`capabilities/default.json` 放行 `core:default`、`core:window:allow-start-dragging`、
`dialog:allow-open`、`notification:default` 与 `opener:allow-open-url`，
最后一项的 scope 限制为 `http://*` / `https://*`（不允许 `file:` 等协议）。

## 窗口

`titleBarStyle: "Overlay"` + `hiddenTitle`，红绿灯按钮固定在 (14, 14)，
标题栏区域由前端自己画（`apps/web/src/shell/`）。窗口透明，最小 960×600。

`dragDropEnabled: true`，`platform.onFileDrop()` 通过
`getCurrentWebview().onDragDropEvent` 拿到真实的文件系统路径与落点（已由
`devicePixelRatio` 归一为 CSS 像素）。浏览器里没有等价能力，`onFileDrop` 返回空
订阅，启动页会提示改用「打开项目位置…」。

## CSP

`tauri.conf.json` 里：`connect-src` 保留本机 Runtime 的 http/ws 与默认 Go Host 的 HTTP；
`frame-src http: https:` 供 Browser 节点的 iframe 使用；`img-src` 保留
`data:` / `blob:` 供图片与截图使用。

## 更新器

`plugins.updater` 是关闭的骨架（`active: false`，无 endpoints、无 pubkey），
没有任何代码读它。启用步骤写在 `tauri.conf.json` 该段的注释里。
