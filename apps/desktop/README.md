# apps/desktop

Tauri 2 薄桌面壳。

只负责启动 Runtime、健康检查、打开同一套 Web 页面，以及托盘、通知、更新和系统权限入口。业务逻辑不写入 Tauri command。

开发模式连接外部 Runtime；生产构建从同目录 sidecar 启动 `ai-coding-canvas-runtime`，退出应用时清理该子进程。

## 插件与能力

按 `docs/redesign-plan.md` §0，桌面壳只启用两个插件：

| 插件                  | 用途                                          | 前端入口（`apps/web/src/platform/index.ts`） |
| --------------------- | --------------------------------------------- | -------------------------------------------- |
| `tauri-plugin-dialog` | 系统目录选择器（新建工作空间 / 打开项目位置） | `pickDirectory()`                            |
| `tauri-plugin-opener` | 用系统浏览器打开外部链接                      | `openExternal(url)`                          |

`capabilities/default.json` 只放行 `dialog:allow-open` 与 `opener:allow-open-url`，
后者的 scope 限制为 `http://*` / `https://*`（不允许 `file:` 等协议）。

窗口 `dragDropEnabled: true`，`platform.onFileDrop()` 通过
`getCurrentWebview().onDragDropEvent` 拿到真实的文件系统路径与落点（已由
`devicePixelRatio` 归一为 CSS 像素）。浏览器里没有等价能力，`onFileDrop` 返回空
订阅，启动页会提示改用「打开项目位置…」。

CSP（`tauri.conf.json`）：`connect-src` 保留本机 Runtime 的 http/ws；
`frame-src http: https:` 供 Browser 节点的 iframe 使用；`img-src` 保留
`data:`/`blob:` 供 Image 节点与截图使用。

## 本地检查

```bash
pnpm --filter @ai-coding-canvas/desktop prepare:sidecar   # 准备 sidecar 二进制
cargo check -p ai-coding-canvas-desktop
```
