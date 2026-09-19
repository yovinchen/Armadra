# 桌面壳

Electron 薄壳，产品、窗口、托盘和主可执行文件统一为 **Armadra**（Windows 为 `Armadra.exe`）。
负责 Runtime / Go Host 生命周期、Web 页面、窗口、托盘、通知与系统权限；业务不写进主进程。

三个构建目标（`electron.vite.config.ts`）：`src/main`（主进程）、`src/preload`（桥）、
渲染进程即 `apps/web`。`src/shell-core/` 是主进程与测试共用的纯逻辑，不 import `electron`，
由 `no-electron.test.ts` 扫描守住这条边界。

## 开发与生命周期

```sh
pnpm --filter @armadra/desktop dev            # 开窗口，连外部 Runtime
pnpm --filter @armadra/desktop dist           # electron-builder 出包
pnpm --filter @armadra/desktop prepare:host --native
pnpm --filter @armadra/desktop stage:binaries
pnpm --filter @armadra/desktop test
```

发布包和 `./armadra.sh run desktop` 持有自己的 Runtime；直接 `dev` 需先运行 `cargo run -p armadra-runtime`。
开发可用 `ARMADRA_DESKTOP_OWNS_RUNTIME=1` 开启持有模式，通过私有控制管道关停，不按 PID 猜测终止外部 Runtime。

Command W / 关闭窗口隐藏到托盘，保留隐藏页面的草稿；菜单、托盘或 Dock 可恢复。
Command Q /「退出并停止后台」停止配置目录的 Host，再结束桌面持有的 Runtime 及受管会话。
未确认完成的关停报告失败。业务迁移与后台计划进度见[实施记录](../../docs/status/platform-implementation-status.md)。

## 页面来源与传输

打包后页面由主进程的回环 HTTP 静态服务提供（端口由内核分配），Runtime 以
`--listen tcp:127.0.0.1:0` 启动并在 stdout 公告实例与端口，页面经 preload 的
`transport:endpoints` 一次性取得 `{ httpBase, wsBase, hostBase, dataDir }`，
`fetch` / `WebSocket` 直连（[迁移设计](../../docs/design/electron-migration.md) §2.1）。
没有自定义协议，也没有 WebSocket 回环转发端口。

## Host 启动

启动器从开发构建目录或 `process.resourcesPath` 定位 `armadra-host`，调用 `start --output protobuf`，
验证服务身份、`http://127.0.0.1:43121` 和实际页面 Origin。管理操作不暴露给页面；唯一的例外是只读通道
`identity:ticket`：它在同一把启停锁下运行 `pair --origin <页面来源> --device-name 本机桌面`，
把绑定本次 Host 实例的一次性票据交给页面换取 Bearer 会话（[设计](../../docs/history/host-native-session.md)），
失败只返回稳定的 `{ ok: false, error: { code } }`，不带路径、退出码或子进程输出。
已有服务地址/来源不兼容时报告错误，不自动重配；失败不阻断 Runtime/UI。启动与退出串行协调。

| 变量                              | 用途                                        |
| --------------------------------- | ------------------------------------------- |
| `ARMADRA_HOST_BINARY`             | 开发用绝对二进制路径；发布忽略              |
| `ARMADRA_HOST_DATA_DIR`           | 独立 Host 数据目录，绝对路径                |
| `ARMADRA_HOST_LISTEN`             | 开发改 Host 监听地址，避开已装 Armadra 占用 |
| `ARMADRA_RUNTIME_BINARY`          | 开发用 Runtime 绝对路径                     |
| `ARMADRA_DESKTOP_OWNS_RUNTIME`    | 开发也由壳持有 Runtime                      |
| `ARMADRA_DESKTOP_PACKAGED`        | 按打包布局解析路径，不必真打包              |
| `ARMADRA_DESKTOP_LIFECYCLE_TRACE` | 打印启动 / 退出编排的事件                   |
| `ARMADRA_UPDATES_DEV`             | 未打包构建也接更新器，指向本地发布服务      |
| `ARMADRA_UPDATER_ENDPOINTS`       | 逗号分隔的更新清单地址；仓库里从不写死      |
| `ARMADRA_GO_BINARY`               | 已安装的 Go 可执行文件                      |
| `CARGO_TARGET_DIR`                | 构建来源目录；相对路径从仓库根解析          |

探测实际执行 OPTIONS / Hello，禁用代理与重定向。CLI 限时 15 秒，父进程清理另限 2 秒；
限制 stdout/stderr/HTTP 大小，stderr 不回显为 UI 错误，也不终止已经独立运行的 Host。

## 受管二进制

`prepare-host.mjs` 用 `CGO_ENABLED=0` 构建 Go Host 到 `<target-dir>/…/armadra-host[.exe]`，
`predev` 先跑一次本机的。Runtime 与 hook 由 `cargo build --release` 自己产出。

`stage-binaries.mjs` 只复制、不构建：把当前目标需要的四个二进制按原名拷进 `apps/desktop/resources/`，
electron-builder 的 `extraResources` 原样放进 `process.resourcesPath`。缺哪个就一次报齐，
`--placeholders` 只给不打包的类型检查用。

`--native` 忽略交叉目标；显式交叉构建例如：

```sh
pnpm --filter @armadra/desktop prepare:host --release --target x86_64-pc-windows-msvc
```

目标优先级：`--target`（仅 prepare:host）→ `CARGO_BUILD_TARGET` → Rust host triple。
支持 macOS arm64/amd64、Linux GNU/musl arm64/amd64、Windows MSVC arm64/amd64 与 GNU amd64，其他目标报错。
本机构建到 `<target-dir>/debug`；显式目标到 `<target-dir>/<triple>/debug|release`。
Go 使用 `-mod=readonly -trimpath`、`GOTOOLCHAIN=local`，缓存位于 `target/protocol-go/`，release 去除调试符号。
脚本不自动安装工具或启动 Host，参数通过 argv 传递以支持含空格路径。

## 窗口与权限

- Overlay 标题栏、隐藏系统标题、`vibrancy: "sidebar"`，最小 960×600；前端 `src/shell` 绘制标题区域，
  拖拽区走 `-webkit-app-region`（`data-app-region`）。
- `dialog:pick-directory` / `dialog:pick-files` 返回绝对路径而非字节；`shell:open-external` 只允许 `http` / `https`。
- 文件拖放是普通的 DOM `drop`，绝对路径由 `webUtils.getPathForFile` 取，坐标已经是 CSS 像素。
- CSP 的连接范围为本地 Runtime http/ws 和默认 Host HTTP；`<webview>` 与图片保留各自所需的来源。
- 更新走 electron-updater；未签名阶段更新器关闭，`dist` 会给本地包打上 `armadraUpdates: "disabled"` 标记，
  避免轮询生产 feed。

## 打包

`dist.mjs` 三步：先定签名计划（`signing-electron.mjs`，`sign` / `skip` / `refuse`），
再 `electron-vite build`，最后暂存二进制并调用 electron-builder。
签名与公证由 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 驱动，
`ARMADRA_REQUIRE_SIGNED_BUNDLE=1` 让「未签名」变成失败。产物目标矩阵与
`tools/release/artifacts.mjs` 一一对应，由 `scripts/artifact-targets.test.mjs` 钉住。

macOS 窗口与退出证据见实施记录；Windows 交叉构建仅验证产物，安装包、签名、窗口与进程行为仍需实机验收。
