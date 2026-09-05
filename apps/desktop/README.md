# apps/desktop

Tauri 2 薄桌面壳。

只负责启动 Runtime、健康检查、加载同一套 Web 页面，以及标题栏覆盖、托盘、通知和
系统权限入口。业务逻辑不写进 Tauri command，避免形成第二套后端。

开发模式连接外部 Runtime；生产构建从包内 sidecar 启动 `armadra-runtime`，
退出应用时清理该子进程。

```bash
pnpm --filter @armadra/desktop dev     # 需要 cargo run -p armadra-runtime 已在跑
pnpm --filter @armadra/desktop build
pnpm --filter @armadra/desktop prepare:sidecar   # 准备 Runtime、Hook 和 Go Host
pnpm --filter @armadra/desktop prepare:host --native   # 仅准备本机 Go Host
pnpm --filter @armadra/desktop test
cargo check -p armadra-desktop
```

## Sidecar

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

`tauri.conf.json` 里：`connect-src` 只留本机 Runtime 的 http/ws；
`frame-src http: https:` 供 Browser 节点的 iframe 使用；`img-src` 保留
`data:` / `blob:` 供图片与截图使用。

## 更新器

`plugins.updater` 是关闭的骨架（`active: false`，无 endpoints、无 pubkey），
没有任何代码读它。启用步骤写在 `tauri.conf.json` 该段的注释里。
