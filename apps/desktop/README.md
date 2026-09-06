# apps/desktop

Tauri 2 薄桌面壳。

只负责启动 Runtime、健康检查、加载同一套 Web 页面，以及标题栏覆盖、托盘、通知和
系统权限入口。业务逻辑不写进 Tauri command，避免形成第二套后端。

开发模式连接外部 Runtime；生产构建从包内 sidecar 启动 `armadra-runtime`，
退出应用时清理该子进程。

```bash
pnpm --filter @armadra/desktop dev     # 需要 cargo run -p armadra-runtime 已在跑
pnpm --filter @armadra/desktop build
pnpm --filter @armadra/desktop prepare:sidecar   # 只准备 sidecar 二进制
cargo check -p armadra-desktop
```

## Sidecar

`scripts/prepare-sidecar.mjs` 用 `cargo build --release` 编出 `armadra-runtime` 与
`armadra-hook`，按 Rust host target triple 重命名复制到 `target/release/`，
再由 `tauri.conf.json` 的 `bundle.externalBin` 打进包里。交叉编译时设
`CARGO_BUILD_TARGET`，或让 Tauri 传 `TAURI_ENV_TARGET_TRIPLE`。

`armadra-hook` 也随包分发：它是注入每个 Agent 终端的 hook 客户端。

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
