# 桌面壳

Tauri 2 薄壳，产品、窗口、托盘和主可执行文件统一为 **Armadra**（Windows 为 `Armadra.exe`）。
负责 Runtime / Go Host 生命周期、Web 页面、窗口、托盘、通知与系统权限；业务不写入 Tauri command。

## 开发与生命周期

```sh
pnpm --filter @armadra/desktop dev           # 连接外部 Runtime
pnpm --filter @armadra/desktop build         # 准备 sidecar 后打包
pnpm --filter @armadra/desktop prepare:sidecar
pnpm --filter @armadra/desktop prepare:host --native
pnpm --filter @armadra/desktop test
```

发布包和 `./armadra.sh run desktop` 持有自己的 Runtime；直接 `dev` 需先运行 `cargo run -p armadra-runtime`。
开发可用 `ARMADRA_DESKTOP_OWNS_RUNTIME=1` 开启持有模式，通过私有控制管道关停，不按 PID 猜测终止外部 Runtime。

Command W / 关闭窗口隐藏到托盘，保留隐藏 WebView 的草稿；菜单、托盘或 Dock 可恢复。
Command Q /「退出并停止后台」停止配置目录的 Host，再结束桌面持有的 Runtime 及受管会话。
未确认完成的关停报告失败。业务迁移与后台计划进度见[实施记录](../../docs/status/platform-implementation-status.md)。

## Host 启动

启动器从开发构建目录或包内定位 `armadra-host`，调用 `start --output protobuf`，验证服务身份、
`http://127.0.0.1:43121` 和实际页面 Origin。管理操作不暴露为网页 invoke 接口。
已有服务地址/来源不兼容时报告错误，不自动重配；失败不阻断 Runtime/UI。启动与退出串行协调。

| 变量                    | 用途                               |
| ----------------------- | ---------------------------------- |
| `ARMADRA_HOST_BINARY`   | 开发用绝对二进制路径；发布忽略     |
| `ARMADRA_HOST_DATA_DIR` | 独立 Host 数据目录，绝对路径       |
| `ARMADRA_GO_BINARY`     | 已安装的 Go 可执行文件             |
| `CARGO_TARGET_DIR`      | 构建来源目录；相对路径从仓库根解析 |

探测实际执行 OPTIONS / Hello，禁用代理与重定向。CLI 限时 15 秒，父进程清理另限 2 秒；
限制 stdout/stderr/HTTP 大小，stderr 不回显为 UI 错误，也不终止已经独立运行的 Host。

## Sidecar 构建

`prepare-sidecar.mjs` 构建 release Runtime、Hook 与 `CGO_ENABLED=0` 的 Go Host，
按 Rust target triple 暂存到固定的 `target/release/<binary>-<triple>[.exe]`，供 `bundle.externalBin` 打包。

`predev` 先构建本机 Host。`--native` 忽略交叉目标；显式交叉构建例如：

```sh
pnpm --filter @armadra/desktop prepare:host --release --target x86_64-pc-windows-msvc
```

目标优先级：`--target`（仅 prepare:host）→ `TAURI_ENV_TARGET_TRIPLE` → `CARGO_BUILD_TARGET` → Rust host triple。
支持 macOS arm64/amd64、Linux GNU/musl arm64/amd64、Windows MSVC arm64/amd64 与 GNU amd64，其他目标报错。

本机构建到 `<target-dir>/debug`；显式目标到 `<target-dir>/<triple>/debug|release`。
开发也暂存真实 Host 到 Tauri 固定目录，发布时重新构建覆盖；开发暂存不代表 release 已验收。
Go 使用 `-mod=readonly -trimpath`、`GOTOOLCHAIN=local`，缓存位于 `target/protocol-go/`，release 去除调试符号。
脚本不自动安装工具或启动 Host，参数通过 argv 传递以支持含空格路径。

## 窗口与权限

- Overlay 标题栏、隐藏系统标题、透明窗口，最小 960×600；前端 `src/shell` 绘制标题区域。
- dialog 提供目录选择；opener 只允许 `http` / `https`；notification 提供 Agent 状态通知。
- 文件拖放经 `onDragDropEvent` 提供真实路径，坐标转为 CSS 像素；浏览器使用目录选择入口。
- CSP 的连接范围为本地 Runtime http/ws 和默认 Host HTTP；iframe 允许 http/https，图片保留 data/blob。
- updater 是未启用骨架；启用说明见 `tauri.conf.json`。

`pnpm host:bootstrap-smoke` 验证真实 Host 启动、发现、来源拒绝及启动器退出后保活，需先准备 sidecar。
macOS 窗口与退出证据见实施记录；Windows 交叉构建仅验证产物，安装包、签名、窗口与进程行为仍需实机验收。
