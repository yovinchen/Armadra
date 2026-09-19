# Armadra 现状盘点（Electron 迁移用）

研究材料，不是实施要求。统计于 2026-09-19，分支 `feature/host-protocol-foundation`（`c29cf841f`）。行数用 `scc` / `wc -l` 实测，测试数按 `#[test]` / `#[tokio::test]` / `func Test` / `it(` / `test(` 声明计数。

## 结论

**壳很薄，耦合面很小。** `apps/desktop` 一共 9,127 行（Rust 源码 6,405 + Rust 集成测试 1,503 + Node 脚本 1,219），占全仓约 581,000 行的 **1.6%**；前端 96,046 行非测试代码里只有 **9 个文件**直接 `import("@tauri-apps/*")`，全部集中在 `platform/index.ts`、`updates/shell-updater.ts`、`keybindings/global-shortcuts.ts`、`host/native-session.ts` 四处，并且每一处都写成了 `isTauri() ? 壳分支 : 浏览器分支`——浏览器分支已经存在且被测试覆盖（`armadra.sh run web` 是一等模式）。

真正的麻烦不在行数，而在**三条不能直译的系统边界**：

1. `armadra://` 自定义协议 + 回环 WebSocket 转发（`transport.rs`，636 行）——Electron 要换成 `protocol.handle()` + 仍需转发 WS；
2. Host 的原生来源授权链（`--allow-origin tauri://localhost` → `armadra-host pair` → `identity.native-session.v1`）——**Go Host 侧硬编码了三个 Tauri 来源**，换壳必须同时改 Go 代码与 Rust 壳；
3. Tauri updater 的 minisign 签名 / 发布矩阵（updates 模块 1,850 行 + 7 个集成测试文件 + release.yml）——Electron 要整体重设计为 electron-updater 或自建。

终端与浏览器域**几乎不受影响**：PTY/tmux/SSH 全在 Rust Runtime（`apps/runtime/src/terminal/` 9,654 行），浏览器是 Runtime 驱动的 CDP 会话 + 前端位图 canvas（`apps/runtime/src/browser/` 14,909 行），两者都通过 HTTP/WS 与前端通信，壳只是一根线。

---

## 1. 仓库规模与结构

### 1.1 workspace 成员

| 体系 | 定义文件 | 成员 |
| --- | --- | --- |
| pnpm | `pnpm-workspace.yaml` | `apps/web`、`apps/desktop`、`packages/*`（`host-client`、`protocol`、`protocol-ts`、`shared`） |
| cargo | `Cargo.toml:3-10` | `apps/runtime`、`apps/desktop/src-tauri`、`crates/hook`、`crates/protocol`、`crates/session-host` |
| go | `apps/host/go.mod` | 单模块 `apps/host` |

注：`packages/protocol-ts` 目录存在但无源码文件（0 行），实际 TS 协议在 `packages/protocol`。

### 1.2 行数（排除 `node_modules` / `target` / `dist`）

| 区域 | 文件 | 总行 | 非测试行 | 备注 |
| --- | --- | --- | --- | --- |
| `apps/web/src` | 823 | 141,996 | 96,046 | 测试 45,949 行 / 233 个 `.test.ts(x)` |
| `apps/runtime/src` | 415 | 130,449 | 105,093 | 排除 `*/tests/*` 与 `tests.rs` |
| `apps/host` | 416 | 145,464 | 51,298 | 另有 `apps/host/gen/**` 生成码 60,590 行 |
| **`apps/desktop`** | **31** | **9,127** | **~5,345** | src 6,405（含 `diagnostic_bridge.js` 168）+ `tests/` 1,503 + `scripts/` 1,219（其中 `.test.mjs` 681） |
| `crates/hook` | 10 | 2,721 | — | |
| `crates/protocol` | 29 | 5,519 | — | 含 prost 生成码 |
| `crates/session-host` | 14 | 4,271 | — | Windows ConPTY 会话宿主 |
| `packages/shared` | 179 | 30,994 | — | |
| `packages/host-client` | 91 | 20,956 | — | |
| `packages/protocol` | 102 | 63,038 | — | 39,135 行是注释/生成 |
| `tools` | 73 | 19,991 | — | 仓库级脚本与 smoke |
| `proto` | 221 | 7,302 | — | `proto/armadra/v1` + fixtures |

### 1.3 测试数（声明计数，未跑全量）

| 套件 | 数量 | 入口 |
| --- | --- | --- |
| web vitest | **2,165** 个用例 / 233 文件 | `pnpm --filter @armadra/web test` |
| packages vitest | **482** 个用例 / 63 文件 | `pnpm -r test` |
| runtime cargo | **1,005** 个 `#[test]`/`#[tokio::test]` | `cargo test -p armadra-runtime` |
| desktop cargo | **99** 个（含 `tests/*.rs` 7 个文件） | `cargo test -p armadra-desktop`（CI 不跑，见 §7） |
| hook / protocol / session-host | 56 / 91 / 43 | |
| host go | **769** 个 `func Test` / 160 文件 | `go -C apps/host test ./...` |
| node:test（tools + desktop scripts） | 95 | `pnpm repo:test`、`pnpm release:test`、`pnpm --filter @armadra/desktop test` |

---

## 2. 桌面壳（apps/desktop）职责清单

每行：职责 → 依赖的 Tauri API/插件 → 测试 → 迁移难度。

| # | 职责 | 文件:行 | 依赖 | 测试 | Electron 难度 |
| --- | --- | --- | --- | --- | --- |
| 1 | 主窗口（1440×920，`transparent`、`titleBarStyle: Overlay`、`hiddenTitle`、红绿灯位移 14/24，启动时 `visible:false`） | `tauri.conf.json:14-27` | Tauri window config | 无 | **直译**（BrowserWindow + `titleBarStyle:'hiddenInset'`） |
| 2 | macOS 侧栏毛玻璃（`NSVisualEffectMaterial::Sidebar`，半径 12） | `main.rs:32-40` | `window-vibrancy` crate + `macOSPrivateApi` | 无 | **重设计**（Electron `vibrancy:'sidebar'` 有，但圆角/半径行为不同） |
| 3 | 注入 `data-tauri` 到 `<html>`（CSP 禁内联脚本，故走 `webview.eval`） | `main.rs:53-55`、`on_page_load` `main.rs:412-415` | `tauri::Webview::eval` | 前端侧 `styles/tokens.css:343-360` | **直译**（preload 脚本；顺便可改名 `data-electron`） |
| 4 | 诊断桥：`ARMADRA_DESKTOP_DIAGNOSTIC_WS` 把页面 console/异常/fetch 发到回环 WS | `main.rs:66-85` + `src/diagnostic_bridge.js`（168 行） | `webview.eval`，debug/feature gate | 无 | **删掉**（Electron 有 DevTools，打包版可 `openDevTools`） |
| 5 | 托盘图标 + 菜单（显示窗口 / 退出 / 用量两行 / 「重启完成更新」按需插拔） | `main.rs:177-248`、`251-305` | `tray-icon` feature、`muda` | 无 | **直译**（`Tray` + `Menu`；「菜单项不能隐藏只能插拔」的 muda 限制在 Electron 不存在，可简化） |
| 6 | 应用菜单（macOS 用 `Menu::default`；其他平台手写文件/编辑/窗口三菜单，Ctrl+Q 故意不设加速键） | `main.rs:122-169`、`386-399` | `tauri::menu` | 无 | **直译** |
| 7 | 用量轮询：`GET /api/usage/mini` + `/api/settings`，改写托盘两行文案，失败保留旧值 | `main.rs:307-332`、`usage.rs`（290 行） | 走壳自己的 socket 通道 | `usage.rs` 内联 `#[test]` | **直译**（逻辑纯粹，Node 里重写约 150 行） |
| 8 | 窗口关闭 ≠ 退出：`prevent_close` + hide，保护未保存编辑器状态 | `main.rs:400-411`、`lifecycle.rs:37-47` | `WindowEvent::CloseRequested` | `lifecycle` 内联 | **直译**（`'close'` + `event.preventDefault()`） |
| 9 | 退出编排：`begin_quit` → 停 Host → 停 Runtime → 失败弹窗并取消退出 | `main.rs:89-120`、`lifecycle.rs:53-110` | `RunEvent::ExitRequested` + `dialog` | `lifecycle.rs` 内联 | **直译**（`before-quit`） |
| 10 | macOS Dock 重开窗口 | `main.rs:525-531` | `RunEvent::Reopen` | 无 | **直译**（`app.on('activate')`） |
| 11 | 启动并持有 Runtime 子进程（sidecar），stdout 上读 instance id，与 `/health` 比对身份 | `runtime_process.rs`（689 行，`start` :82，`is_our_runtime` :337，`wait_for_runtime` :354） | `externalBin` sidecar + `std::process::Command` | `runtime_process_tests.rs`（306 行） | **直译**（`child_process.spawn`；sidecar 打包方式要换成 `extraResources`） |
| 12 | 清理上一代残留 Runtime：读 `endpoints.json` + `/bin/ps` 命令行核对，再 kill | `runtime_process.rs:496-593` | 纯 std | 同上 | **直译** |
| 13 | `armadra://` 自定义协议：把 WebView 请求原样重放到 Unix socket / 命名管道，原样返回 Runtime 的响应 | `transport.rs:135-305`，注册在 `main.rs:372-384`，`SCHEME` `transport.rs:36` | `register_asynchronous_uri_scheme_protocol` + `hyper` 客户端 | 内联 `#[test]` | **重设计**（Electron `protocol.handle()` 语义不同：必须 `registerSchemesAsPrivileged`，且响应是 `Response` 对象；16MB body 上限、60s 超时要重写） |
| 14 | WebSocket 回环转发器（内核分配端口，字节双向拷贝到 socket），地址经 `armadra://localhost/__armadra/transport` 告诉页面 | `transport.rs:307-350`、`TRANSPORT_PATH` :34，启动在 `main.rs:422-441` | 纯 tokio | 内联 | **直译**（Node `net` 模块；WS 走不了自定义协议这一约束 Electron 完全相同） |
| 15 | 启动 Go Host：`armadra-host start --output protobuf --launcher desktop --listen 127.0.0.1:43121 --allow-origin <3 个原生来源> --endpoints-dir … --data-dir …` | `host/mod.rs:148-193`、`launch.rs`（161 行） | sidecar 子进程 | `host/tests.rs`（754 行） | **重设计**（命令行可直译，但 `--allow-origin` 的值必须换，见 §8） |
| 16 | Host 应答校验：protobuf 解码、endpoint 比对、origin 复检、协议/身份版本比对，并可替换自己留下的无端口 Host | `host/verify.rs`（191 行）、`host/mod.rs:196-241` | `armadra-protocol` + `reqwest` | `host/tests.rs` | **直译** |
| 17 | 原生会话票据：唯一暴露给页面的 Host 命令，跑 `armadra-host pair --origin <页面来源> --device-name 本机桌面`，校验 hostId/instanceId/origin/expiry/票据形状 | `native_session.rs:25-29`、`host/native.rs:87-170` | `#[tauri::command]` | `native_session.rs:31-55` + `host/tests.rs` | **重设计**（IPC 直译，但 origin 语义整体改变） |
| 18 | 全局快捷键：只认 `global.toggleWindow` / `global.newTerminal`，默认零注册，被系统占用要如实报错，应用即「全量替换」 | `shortcuts.rs:31/34/98`（173 行） | `tauri-plugin-global-shortcut` | `tests/shortcuts.rs`（95 行） | **直译**（`globalShortcut.register` 返回 boolean，报错语义等价） |
| 19 | 自动更新状态机：`updates_state/check/dismiss/cancel/download/install/restart_report` 7 个命令 + `updates://progress` 事件 | `updates/mod.rs`（594 行）+ `machine.rs` 453 + `offer.rs` 366 + `coordinate.rs` 259 + `notify.rs` 94 + `cancel.rs` 84 | `tauri-plugin-updater`（minisign） | `tests/updates_*.rs` 6 个文件共 1,408 行 | **重设计**（状态机/offer/coordinate 是纯逻辑可移植；验签与安装必须换成 electron-updater 或自建） |
| 20 | 更新摘要复核：Tauri 验签之外，壳再按 Host 给的 sha256 算一遍 | `updates/mod.rs`（`sha2` 依赖，`Cargo.toml` 注释） | `sha2` | `tests/updates_offer.rs` | **直译** |
| 21 | 文件夹/文件选择器 | 前端 `platform/index.ts:27-74` 调用 | `tauri-plugin-dialog`，capability `dialog:allow-open` | `platform/folder-import.test.ts` | **直译**（`dialog.showOpenDialog`） |
| 22 | 打开外链（限 `http://*` / `https://*`） | `capabilities/default.json:12-15` | `tauri-plugin-opener` | 无 | **直译**（`shell.openExternal`，白名单要自己写） |
| 23 | 系统通知 | 前端 `platform/index.ts:166-196` | `tauri-plugin-notification` | 无 | **删掉**（Electron 渲染进程可直接用 Web `Notification`，浏览器分支已存在） |
| 24 | OS 级文件拖放（物理像素 → CSS 像素换算） | 前端 `platform/index.ts:105-136` | `@tauri-apps/api/webview` `onDragDropEvent`，`dragDropEnabled: true` | `terminal/file-drop.test.ts`（681 行） | **重设计**（Electron 里 `DataTransfer.files[i].path` 直接给绝对路径，反而更简单，但坐标来源不同） |
| 25 | 窗口拖拽区：`data-tauri-drag-region` 属性 + 一个铺满的空 drag layer | 前端 `shell/window-region.ts`、`shell/WindowDragLayer.tsx` | Tauri 注入脚本 + `core:window:allow-start-dragging` | `window-region.test.tsx` | **直译**（改成 CSS `-webkit-app-region: drag`，更简单） |
| 26 | CSP：`default-src 'self'`，放行 `armadra:`、`http(s)://armadra.localhost`、`http://127.0.0.1:43121`、`ws://127.0.0.1:*`、`frame-src http: https:` | `tauri.conf.json:29-32` | Tauri security | 无 | **重设计**（Electron 用 `session.webRequest` / meta CSP；`<webview>` 引入后 `frame-src` 规则要重写） |
| 27 | 打包三平台：`app/dmg`、`msi/nsis`、`appimage/deb/rpm`；sidecar 三/四个二进制 | `tauri.{macos,windows,linux}.conf.json`、`tauri.conf.json:52-66` | tauri bundler | `scripts/*.test.mjs` | **重设计**（electron-builder，target 列表要与 `tools/release/artifacts.mjs` 一一对应） |
| 28 | 签名决策前置：`signing.mjs` 在编译前判定 sign/skip/refuse，避免二十分钟后才失败 | `scripts/signing.mjs`（139 行）、`build.mjs`（80 行） | `TAURI_SIGNING_PRIVATE_KEY` 等 3 个环境变量 | `signing.test.mjs` 155 行、`updates-release.test.mjs` 229 行 | **重设计**（思路保留，密钥体系换） |
| 29 | sidecar 目标三元组解析与占位符 | `scripts/sidecar-targets.mjs` 130、`prepare-sidecar.mjs` 42、`stage-sidecar-placeholders.mjs` 66、`prepare-host.mjs` 81 | Tauri sidecar 命名约定（`<name>-<triple>`） | `sidecar-targets.test.mjs` 232、`stage-sidecar-placeholders.test.mjs` 65 | **删掉**（Electron 不要求三元组后缀，改为 `extraResources`） |
| 30 | `ARMADRA_DESKTOP_LIFECYCLE_TRACE=1` 生命周期 trace | `lib.rs:20-24` | 无 | 无 | **直译** |
| 31 | 数据目录解析（与 Runtime 的 `paths::data_dir` 必须一致，不通信就得约定好） | `lib.rs:29-46` | 无 | 内联 | **直译**（`app.getPath('appData')` 不等于这里的路径，要写死同样的规则） |

**Cargo 依赖里与 Tauri 强绑定的**：`tauri`（tray-icon/image-png/macos-private-api）、`tauri-plugin-{dialog,global-shortcut,notification,opener,updater}`、`tauri-build`、`window-vibrancy`。可复用的：`armadra-protocol`、`hyper`/`hyper-util`、`reqwest`、`sha2`、`base64`、`url`（这些的等价物在 Node 里都有）。

---

## 3. 前端对壳的耦合面

`apps/web/src/platform/index.ts`（201 行）是唯一的能力接口，注释明写「Every function below is written as `isTauri() ? <desktop branch> : <web fallback>`」（:4-6）：

| 能力 | 接口 | 壳分支 | 浏览器回退 |
| --- | --- | --- | --- |
| 判定是否在壳里 | `isTauri()` `:13-16` | 探测 `window.__TAURI_INTERNALS__` | `false` |
| 目录选择 | `pickDirectory()` `:27-44` | `plugin-dialog.open({directory:true})` | `null`（回退到手输路径） |
| 文件选择（返回绝对路径，不是字节） | `pickFiles()` `:57-74` | `plugin-dialog.open` | `[]`（回退 `<input type=file>`） |
| 打开外链 | `openExternal()` `:77-88` | `plugin-opener.openUrl` | `window.open(..., 'noopener')` |
| OS 文件拖放 | `onFileDrop()` `:105-136` | `getCurrentWebview().onDragDropEvent` | no-op |
| 系统通知 | `notify()` `:166-196` | `plugin-notification` | Web `Notification` |

接口之外还有 4 个直接 `import("@tauri-apps/*")` 的点：

- `updates/shell-updater.ts:116`（`invoke` 7 个 updates 命令）、`:217`（`listen` `updates://progress`）；
- `keybindings/global-shortcuts.ts:54`（`invoke global_shortcuts_apply`）、`:83`（`listen shortcut://triggered`）；
- `host/native-session.ts:177-179`（`invoke host_native_ticket`）；
- `platform/index.ts:112`（webview 拖放）。

**基于「壳/非壳」分叉的 UI**（`isTauri()` 调用点，共 14 个非测试文件）：`sidebar/WorkspaceTree.tsx:234/314/316`（「打开文件夹」vs「上传复制」）、`app/use-project-folder-import.ts:110`、`app/workspace-actions.ts:97-99`、`panels/CloneRepoDialog.tsx:180`、`panels/NewFolderDialog.tsx:75`、`nodes/EditorNode.tsx:509`、`nodes/browser/Prompts.tsx:162`（原生文件选择器）、`panels/settings/pages/KeybindingsPage.tsx:256/378`（`global` 作用域只在壳里可见）、`shell/window-region.ts`、`shell/WindowDragLayer.tsx:20`、`files/use-workspace-file-drag.ts:24`（Windows 专用分支）。

**来源/传输推导**（`api/runtime-url.ts`，150 行，纯函数、有测试）：

```
tauri://localhost        → armadra://localhost
http://tauri.localhost   → http://armadra.localhost      (Windows)
https://tauri.localhost  → https://armadra.localhost     (Windows)
```

映射表在 `:13-17`，判定在 `nativeShellRuntimeUrl()` `:53-64`、`isShellTransport()` `:102-106`；WS 端口问壳在 `resolveSocketBase()` `:122-149`。`host/native-session.ts:15-16/77` 与 `nodes/browser/geometry.ts:97`、`nodes/browser/lease.test.ts:73` 也硬编码了 `tauri.localhost`。

**纯浏览器模式：存在且是一等公民。** `./armadra.sh run web` 只跑 Runtime + 浏览器前端（`armadra.sh:11`），开发页面在 `http://127.0.0.1:1420`（`docs/guides/development.md:25`，Vite 代理地址取自 `endpoints.json`，`:39`）。第三种形态是「Host 托管」：Go Host 用 HTTPS 提供页面并代理 `/api`，判据是页面协议为 `https:`（`runtime-url.ts:75-99`）。**这意味着 Electron 迁移不需要新造回退路径，只需把「壳分支」的实现换掉。**

---

## 4. 终端域现状

### 4.1 Runtime（`apps/runtime/src/terminal/`，9,654 行 / 29 文件）

| 文件 | 行 | 职责 |
| --- | --- | --- |
| `backend.rs` | 783 | 后端 trait（契约 §15.4），三实现共用 |
| `tmux/`（`mod.rs` 497、`control.rs` 331、`config.rs` 185） | 1,102 | **主后端**：私有 tmux server，会话活过 Runtime 进程（契约 §15.3） |
| `direct.rs` | 482 | 兜底后端：`portable-pty`，会话随 Runtime 死 |
| `session_host.rs` | 624 | Windows 后端，会话归 `armadra-session-host` 进程（`crates/session-host`，4,271 行） |
| `ssh/`（`mod.rs` 463、`known_hosts.rs` 366、`argv.rs` 326、`askpass.rs` 292、`prompts.rs` 260） | 1,707 | SSH 终端、host key 确认、askpass |
| `session.rs` / `mod.rs` | 1,082 | 会话模型与环境构造 |
| `attachments.rs` | 283 | 附着、租约与休眠预算（**重附着**） |
| `input.rs` | 330 | 写入/粘贴/resize + 输入安全门 |
| `reconcile.rs` / `gc.rs` / `records.rs` / `observation.rs` / `batch.rs` | 1,168 | 对账、回收、记录、观测、批处理 |
| `bridge.rs` | 484 | Host Worker 的私有执行门（走 hook socket + app bearer） |

**注：tmux 已经是当前的主后端，不是待引入方案。**「终端改用 tmux」在 Unix 上已完成；真正待定的是 Windows（现为 `session-host` + ConPTY）。

### 4.2 前端（`apps/web/src/terminal/` + `nodes/TerminalNode.tsx`，6,776 行）

- xterm `@xterm/xterm 6.0.0`，addon：`fit 0.11.0`、`webgl ^0.19.0`、`search ^0.16.0`、`clipboard ^0.2.0`、`unicode11 ^0.9.0`、`web-links ^0.12.0`（`apps/web/package.json:41-47`）。
- `TerminalSurface.tsx`（365 行）已拆分为 `surface/` 14 个 hook/模块：`use-xterm.ts` 250、`use-transport.ts` 198、`use-file-drop.ts` 156、`use-render-budget.ts` 117、`use-session.ts` 97、`use-launch.ts` 95、`scaled-pointer.ts` 94（缩放画布上的指针换算）、`use-handle.ts` 82、`appearance.ts` 75、`types.ts` 68、`clipboard.ts` 51、`use-refit.ts` 34、`title.ts` 26、`search.ts` 18、`refs.ts` 98、`constants.ts` 24。
- **渲染预算**：`render-budget.ts:20` `DEFAULT_RENDER_BUDGET = 4`，WebGL context 是设备级稀缺资源，回收只释放渲染资源不动 `Terminal` 实例，焦点实例永远有名额（设计 §7.1）。
- 其余：`transport.ts` 254（WS 协议）、`compat.ts` 274、`input-log.ts` 81（**输入序号**）、`scrollback.ts` 106、`render-state.ts` 143、`file-drop.ts` 206、`ime.ts` 35、`platform.ts` 52。

### 4.3 环境变量注入（关键）

**注入点：`apps/runtime/src/terminal/mod.rs`**——壳完全不参与。

`agent_environment(node_id, agent_id)` `mod.rs:484-494` 注入四个：

| 变量 | 值 |
| --- | --- |
| `ARMADRA_NODE_ID` | 节点 id |
| `ARMADRA_AGENT_ID` | agent id |
| `ARMADRA_ENDPOINT_FILE` | `paths::hook_endpoint_file()` 路径 |
| `ARMADRA_CANVAS_CONTROL` | `"1"` |

`context_session_environment()` `mod.rs:496-513` 再加 `ARMADRA_SESSION_ID`、`ARMADRA_SESSION_GENERATION`（先清旧值；没有 `ARMADRA_NODE_ID` 就直接返回，即用户自己开的终端不注入）。

`with_utf8_locale()` `mod.rs:452-468`：继承环境没有 UTF-8 locale 时补 `LANG=en_US.UTF-8` / `LC_CTYPE`。

**Hook token 不进环境**（`mod.rs:482-483` 注释：「the per-node token lives in a 0600 file, never in the environment, because any process of the same user can read another process' environment」）。`ARMADRA_HOOK_TOKEN`、`ARMADRA_HOOK_SOCK`、`ARMADRA_HOOK_VERSION`、`ARMADRA_NODE_TOKEN_DIR` 写在 `hook-endpoint.env` 里（`apps/runtime/src/hook/endpoint.rs:60`），由各 CLI 的扩展脚本读（`hook/install/extension_template.rs:188-243`）。tmux 控制进程用 `child_environment()`（`tmux/control.rs:93/244/286`）。

### 4.4 契约与 Host

- `docs/contracts/v3-agent-terminal-plan.md` 与终端相关的**不可改编号**章节：**§15**（tmux 为主 / 直连兜底，含 §15.1 选择树、§15.2 会话模型、§15.3 隔离配置、§15.4 后端 trait、§15.5 WS 协议 `/api/terminals/{id}/ws`、§15.6 回收与安全、§15.7 前端影响、§15.8 实施位置）、**§18**（终端完整兼容性，§18.2 布局稳定、§18.3 语义兼容矩阵、§18.5 选择与点击修订）、**§25**（终端子进程环境与 Agent 启动路径）、**§5.2**（Hook 服务）、**§7.1**（渲染预算，在 `design/terminal-host-design.md`）。
- Host 侧终端授权：Runtime 的 `terminal/bridge.rs` 挂在 hook socket 上，用同一个 app bearer，「A browser cannot reach it at all」（`bridge.rs:13-14`）。

---

## 5. 浏览器域现状

### 5.1 Runtime（`apps/runtime/src/browser/`，14,909 行 / 40+ 文件）

`session/`（tabs 782、stream 699、targets 642、dialogs 527、actions 517、startup 510、lease 477、events 301、read 300、downloads 260、input 198、navigate 190、lifecycle 184）、`launch/`（managed 649、process 469、mod 255）、`routes/`（mod 510、stream 288）、`agent/mod.rs` 737、`model.rs` 738、`policy.rs` 330、`cdp.rs` 289、`dom.rs` 277、`store.rs` 246。

**实现方式：Runtime 启动一个受管 Chrome 进程，用 CDP 驱动，把截屏流推给前端。** 前端不是 iframe。

### 5.2 前端（`apps/web/src/nodes/browser/`，3,165 行）

`BrowserNode.tsx` 494、`session.ts` 435、`stream.ts` 332、`Prompts.tsx` 276、`TabStrip.tsx` 220、`Frame.tsx` 160、`geometry.ts` 141、`Managed.tsx` 119、`Lease.tsx` 114、`input.ts` 26。

`Frame.tsx:14-18`：「位图画面加输入映射（设计 §8）。canvas 的位图尺寸就是页面 viewport，显示尺寸交给 CSS——画布缩放不参与」。**即一块 `<canvas>` + 人工事件映射，不是原生浏览器视图。** 这正是「改用 Electron `<webview>`」要替换的东西。

### 5.3 Hook 动词

`crates/hook/src/control.rs:102-132`：`armadra-hook browser <verb>`，走 `/browser/<verb>`；用法在 `lib.rs:45/67/86/98`（含 `LEASE_REVOKED` 语义：人接管浏览器后 agent 立即收到，不得重试）。

### 5.4 迁移建的表

| 迁移 | 内容 |
| --- | --- |
| `0005_browser_sessions.sql` | `CREATE TABLE browser_sessions` + `idx_browser_sessions_workspace(workspace_id, created_at)` |
| `0010_host_imports.sql` | `CREATE TABLE host_imports` + `idx_host_imports_domain(domain, applied_at)`（与浏览器无关，是 Host 导入账本） |
| `0012_browser_process.sql` | `ALTER TABLE browser_sessions` 加 5 列：`pid`、`pid_started_at`、`cdp_port`、`lease_generation`、`active_tab_url` |

### 5.5 浏览器契约章节（编号被代码引用）

主要在 `docs/design/remote-and-browser-completion.md`：**§2.1** 受管二进制、**§2.2** 多标签与 iframe 目标寻址、**§2.3** 下载与上传、**§2.4** JS 对话框、**§2.5** URL 策略与重定向复检、**§2.6** 人机控制租约、**§2.7** Agent 动词、**§2.8** 活动徽标、**§2.9** 跨端画面、**§2.10** 进程组清理与 profile 锁、**§2.11** `browser.proto` 字段号、**§2.12** 存储增量、**§4.1/§4.3** 代码布局。代码里 `设计 §8`（40 次）、`设计 §2.2`（29 次）、`design §8`（24 次）、`设计 §2.3`（22 次）是出现频次最高的引用，**改这些编号会让上百处注释指向错误位置**。

---

## 6. 数据库与迁移

- 目录：`apps/runtime/migrations/`，**最高编号 `0014_retire_gemini.sql`**，共 14 个。
- `migrations.lock`（仓库根）记录三处源的 SHA256：`apps/runtime/migrations`、`apps/host/internal/migration/legacy`（同样 14 个、校验和逐一相同）、`apps/host/internal/storage/schema.go` 的 `const schemaVN`。规则在 `repo.rules.json:75-92`，由 `tools/repo-check.mjs` 校验。
- **表归属**：
  - 画布：`boards`、`nodes`、`edges`、`workspaces`、`context_links`
  - 终端：`terminal_sessions`、`terminal_logs`
  - 浏览器：`browser_sessions`
  - Agent：`conversations`、`agent_mailbox`、`agent_handoffs`、`agent_handoff_outbox`、`agent_handoff` 尝试表、`agent_deliveries`、`agent_prompt_deliveries`、`agent_approvals`、`agent_status`、`hook_installs`
  - 所有权/Host：`write_ownership`、`host_imports`
  - 归档：`legacy_kanban_archives`、`legacy_node_label_archives`
- **「未知或损坏的数据库拒绝启动」实现在 `apps/runtime/src/db/mod.rs:136-220`**，八种拒绝：无迁移账本（:136）、账本不是表（:137）、账本结构不认识（:168）、没有记录任何迁移（:180）、账本值非法（:194）、某次迁移 dirty（:201）、某次迁移本 build 不认识（:207）、校验和不匹配（:212）、历史不是完整已知前缀（:220）。每条都写明 "startup refused without changing its data"。

---

## 7. 构建、签名、更新、CI

- `pnpm check` = `libs:build` → `format:check` → `rust:fmt` → `typecheck` → `protocol:check` → `repo:check` → `ci:workflows` → `release:check`（`package.json:38`）。
- `apps/desktop/package.json` 脚本：`dev`（`tauri dev`，`predev` 跑 `prepare:host --native`）、`build`（`scripts/build.mjs`）、`prepare:sidecar`、`prepare:sidecar-placeholders`、`prepare:host`、`test`（`node --test scripts/*.test.mjs`）。
- **更新签名**：`tauri.conf.json` 的 `plugins.updater` 里 `active:false`、`pubkey:""`、`endpoints:[]`（全部是有意留空，`$comment` 详述）。`scripts/signing.mjs` 三态判定（sign/skip/refuse），`ARMADRA_REQUIRE_SIGNED_BUNDLE=1` 把 skip 变失败（CI 发布作业设置）。发布地址由 `ARMADRA_UPDATER_ENDPOINTS` 注入（`signing.mjs:109-140`）。
- **CI（`.github/workflows/ci.yml`）**：`cargo clippy --workspace --exclude armadra-desktop`（:125）、`cargo test --workspace --exclude armadra-desktop`（:130）——**桌面壳在 CI 里只做 `cargo check -p armadra-desktop --all-targets`（:146），且需先 `prepare:sidecar-placeholders`（:145）**；Linux 上要装 WebKitGTK 头文件（:89）。`release.yml:144` 同样排除 desktop。
- **release.yml**：macOS 自建钥匙串导入证书（:249-286）、公证三变量交给 tauri bundler（:311）、空 secret 不进环境（:318）、`pnpm --filter @armadra/desktop build`（:349）、AppImage 补签（:364-375）、`tools/release/stage-desktop.mjs`（:385）。
- **`repo:check` 在迁移时会拦什么**（`repo.rules.json`）：
  1. **根目录白名单**（`root`，:3-28）——新增根目录（比如 `electron/`）会直接失败；`apps`、`crates`、`packages`、`tools` 已在名单内。
  2. **黑名单**：`output/`、`dist/`、`target/`、`*.db`（:29-38）——Electron 产物目录（`release/`、`out/`）不在黑名单，会被当成未登记内容。
  3. **单文件 1,500 行上限**，作用于 `apps`/`crates`/`packages`/`tools` 下的 `.rs/.ts/.tsx/.go/.mjs/.js`，只豁免 `/gen/` 与 `/node_modules/`（:63-74）。
  4. **命名前缀**：`packages/*` 必须 `@armadra/`，`crates/*` 必须 `armadra-`（:52-62）。
  5. **文档登记**：`docs/README.md` 是唯一入口，但 `history` / `research` 只按目录登记（`docs.directoryOnly`，:47-51）——**本文件因此不需要单独登记**。
  6. **迁移锁**与**协议覆盖**（:75-102）。
  7. `apps/desktop` 本身没有专门规则；删掉它不会触发 repo-check，新增 `apps/desktop`（Electron 版）只要保持在 `apps/` 下、包名 `@armadra/desktop` 就合规。

---

## 8. Host（Go）与壳的关系

**启动链**：`main.rs:450-492` 决定 `browser_origin`（开发取 `devUrl` 的 origin；Windows 打包取 `http(s)://tauri.localhost`；其他打包取 `tauri://localhost`）→ `HostLaunchConfig::from_environment`（`host/mod.rs:92-123`）→ `lifecycle.configure_host` → `start_host` → `host/launch.rs::run_start`。

**命令行**（`host/mod.rs:148-193`）：
```
armadra-host start --output protobuf --launcher desktop
  --listen 127.0.0.1:43121
  --allow-origin tauri://localhost
  --allow-origin http://tauri.localhost
  --allow-origin https://tauri.localhost
  [--allow-origin <dev origin>]
  --endpoints-dir <Runtime 数据目录> [--data-dir ...]
```
`NATIVE_ORIGINS` 常量在 `host/mod.rs:29-33`；`--launcher desktop` 是「谁启动的谁才能停」的记录（:159-163）。

**取票**（`host/native.rs:87-98`）：`armadra-host pair --output protobuf --origin <browser_origin> --device-name 本机桌面`，走 OS 私有控制通道；票据校验 `decode_ticket` :118-141（hostId / hostInstanceId / origin / 形状 32 hex + '.' + 43 字符 / 未过期）。`issue_native_ticket` :152-170 先检查 `browser_origin ∈ NATIVE_ORIGINS`，否则 `OriginUnsupported`。

**Go Host 侧**：`internal/server/handler.go:390-393` 仅对该来源在 Hello 里报告 `identity.native-session.v1`；`internal/server/native.go`、`auth.go:40` 是原生 bearer 门；`cmd/armadra-host/serve.go:468` 是 listener 判定。`docs/guides/host-device-auth.md:48-53`：「打包桌面壳的页面来源是 `tauri://localhost`（Windows 为 `http(s)://tauri.localhost`），永远满足不了浏览器规则，但它与 Host 同属一个系统账号」。

**迁到 Electron 后的来源**：Electron 装包页面默认是 `file://`（origin 为 `"null"`），要有稳定 origin 必须自己注册自定义协议（推荐 `app://armadra` 或沿用 `armadra://`，用 `registerSchemesAsPrivileged({standard:true, secure:true})`）。由此**要改的地方**：

| 位置 | 改什么 |
| --- | --- |
| `apps/desktop/src-tauri/src/host/mod.rs:29-33` | `NATIVE_ORIGINS` 三个值 → 新来源（Electron 侧重写） |
| `apps/host/internal/server/{handler.go:390,native.go,auth.go:40}` + `serve.go:468` | Go 侧原生来源判定 |
| `apps/web/src/api/runtime-url.ts:13-17` | 来源 → Runtime 基址映射表 |
| `apps/web/src/host/native-session.ts:15-16,77` | `isNativePageOrigin()` |
| `apps/web/src/nodes/browser/geometry.ts:97`、`lease.test.ts:73` | `tauri.localhost` 带宽分级 |
| `apps/desktop/src-tauri/src/transport.rs:187` | `is_native_origin()`（CORS 授予） |
| `tauri.conf.json:29-32` CSP | 新 scheme |
| `docs/guides/host-device-auth.md:48-53`、`docs/design/host-native-session.md` | 文档同步 |

**不必改的**：票据表、两分钟有效期、一次性消费、撤销/轮转/revision 核对全部复用现有会话表（`host-device-auth.md:50-52`）；`pnpm host:native-session-smoke` 用真实 Host + CLI 验证，迁移后仍可用。

---

## 9. 风险与硬约束

**AGENTS.md 硬性规则（迁移不能破）**：

1. **已发布迁移不得修改**——`migrations.lock` 三处校验和；新增只能是 `0015_*`。「未知或损坏的数据库拒绝启动，禁止自动清库或重建」（`db/mod.rs:136-220`）。
2. **Runtime JSON camelCase，错误 `{code, message}`**——Electron 主进程如果新增 IPC，回传形状要照此。
3. **`proto/` 是跨端 Protobuf 唯一来源，生成文件不手改**——`packages/protocol`、`crates/protocol`、`apps/host/gen` 都是产物。壳如果继续解 `HostStatus`/`BootstrapTicketResponse`，Node 侧要接 `packages/protocol`（已有 TS 实现，不用新写）。
4. **界面文案放 `apps/web/src/i18n/`**——`usage.rs`、`native_session.rs:18-23`、`updates/notify.rs` 里现在有**硬编码中英文案**（`"本机桌面"`、托盘 `显示窗口`/`退出`、退出失败弹窗）。迁移是把这些搬进 i18n 的机会，但托盘/菜单在主进程，需要一条 locale 通道。
5. **复用现有 shadcn 组件**、**画布改动经 `canvas-store` 动作**——与壳无关。
6. **`docs/contracts/` 的 §N 只增不改**——`v3-agent-terminal-plan.md` 全部章节；代码里高频引用 `设计 §8`(40)、`设计 §2.2`(29)、`design §8`(24)、`设计 §2.3`(22)、`roadmap §4.1/4.2/4.4`、`plan §19/§20/§21/§24.1`。
7. **单文件 ≤ 1,500 行**（`repo.rules.json:63-74`）——Electron 主进程文件要拆。

**「未发版，不做兼容迁移」仍然成立，但有例外**：git tag 只有 3 个（`v0.1.0`、两个 milestone）；`docs/status/platform-implementation-status.md:214` 记载 `v0.1.0` 是「draft Release 37 个文件……未配置任何 secret，所以 macOS 仅 ad-hoc 签名、不公证，`latest.json` 为空；**draft 未发布，由人审阅**」。同文档 :141 明写「旧数据不迁移（用户决定，未发版）」。**结论：对外没有安装用户，不做 UI/数据兼容成立；但 `armadra-host` 的 `--launcher desktop` 记录与「无端口 Host 替换」逻辑（`host/mod.rs:196-219`）是为跨版本升级写的，换壳后同一台开发机上会同时存在 Tauri 壳启动的 Host 和 Electron 壳启动的 Host，这条需要明确一次。**

**额外风险**：

- CI 从未跑过 desktop 的单元测试（只 `cargo check`），其 99 个测试是本地资产。换壳会连带丢掉 `tests/updates_*.rs` 1,408 行验证，而那些是纯状态机逻辑——**应优先移植而不是重写**。
- `frame-src http: https:` 的 CSP 是给现在的浏览器节点留的；`<webview>` 引入后 Electron 的 `webviewTag` 默认关闭且是已弃用 API，需要评估 `WebContentsView` 替代。
- Windows 形态最复杂：`http(s)://tauri.localhost` 来源、命名管道、`armadra-session-host` sidecar（多打一个二进制，见 `tauri.windows.conf.json`）。

---

## 10. 迁移影响矩阵

| # | 职责 / 耦合点 | 现在在哪 | Electron 里去哪 | 动作 | 风险 |
| --- | --- | --- | --- | --- | --- |
| 1 | 主窗口配置 | `tauri.conf.json:14-27` | `BrowserWindow` options | 直译 | 低 |
| 2 | macOS 毛玻璃 | `main.rs:32-40` | `vibrancy:'sidebar'` | 重设计 | 中（圆角/半径行为差异） |
| 3 | `data-tauri` 标记 | `main.rs:53-55` + `tokens.css:343-360` | preload `setAttribute` | 直译 | 低 |
| 4 | 诊断桥 | `main.rs:66-85` + `diagnostic_bridge.js` | DevTools | 删除 | 低 |
| 5 | 托盘 + 用量两行 | `main.rs:177-332`、`usage.rs` | `Tray`/`Menu` + Node 轮询 | 直译 | 低 |
| 6 | 应用菜单 | `main.rs:122-169` | `Menu.buildFromTemplate` | 直译 | 低 |
| 7 | 关闭≠退出 / 退出编排 | `main.rs:89-120,400-411`、`lifecycle.rs` | `'close'`/`'before-quit'` | 直译 | 中（两个子进程的停止顺序不能乱） |
| 8 | Runtime 子进程 + 身份核对 + 残留清理 | `runtime_process.rs`（689） | `child_process.spawn` | 直译 | 中（stdout instance id 协议要照搬） |
| 9 | **`armadra://` HTTP 转发** | `transport.rs:135-305` | `protocol.handle()` + Node HTTP over socket | **重设计** | **高**（Electron 协议 API 语义不同；CORS/流式/16MB 上限都要重写） |
| 10 | **WS 回环转发器** | `transport.rs:307-350` | Node `net` | 直译 | 中（WS 走不了自定义协议这一约束不变） |
| 11 | `__armadra/transport` 自答路由 | `transport.rs:34,151-166`、前端 `runtime-url.ts:122-149` | 同左 | 直译 | 低 |
| 12 | **Host 启动行 + `--allow-origin`** | `host/mod.rs:148-193` | Node spawn | **重设计** | **高**（来源值变化牵动 Go Host） |
| 13 | Host 应答校验 | `host/verify.rs`、`mod.rs:196-241` | `packages/protocol` 解码 | 直译 | 中 |
| 14 | **原生会话票据 `pair`** | `native_session.rs`、`host/native.rs` | `ipcMain.handle` | **重设计** | **高**（origin 语义 + Go 侧 `identity.native-session.v1` 同改） |
| 15 | 全局快捷键 | `shortcuts.rs`、前端 `global-shortcuts.ts` | `globalShortcut` | 直译 | 低 |
| 16 | **自动更新（7 命令 + 状态机 + 验签）** | `updates/`（1,850 行）+ `tests/updates_*.rs`（1,408 行） | electron-updater 或自建 | **重设计**（纯逻辑部分移植） | **高**（签名体系、发布矩阵、摘要复核全变） |
| 17 | 文件/目录选择器 | `platform/index.ts:27-74` | `dialog.showOpenDialog` | 直译 | 低 |
| 18 | 打开外链 | `platform/index.ts:77-88` + capability 白名单 | `shell.openExternal` + 自写白名单 | 直译 | 中（白名单不再由框架强制） |
| 19 | 系统通知 | `platform/index.ts:166-196` | Web `Notification` | 删除（用浏览器分支） | 低 |
| 20 | OS 文件拖放 | `platform/index.ts:105-136` | `File.path` / `webUtils.getPathForFile` | 重设计 | 中（坐标与路径来源都变） |
| 21 | 窗口拖拽区 | `shell/window-region.ts`、`WindowDragLayer.tsx` | CSS `-webkit-app-region` | 直译（更简单） | 低 |
| 22 | `isTauri()` 探测 | `platform/index.ts:13-16`（14 个调用点） | 改名 `isDesktop()` + preload 暴露标志 | 直译 | 低（一次性改名） |
| 23 | **来源→基址映射表** | `runtime-url.ts:13-17` + 4 处硬编码 | 新 scheme 映射 | 重设计 | 中（有测试，`runtime-url.test.ts`） |
| 24 | CSP | `tauri.conf.json:29-32` | meta CSP / `webRequest` | 重设计 | 中（`<webview>` 后要重写 `frame-src`） |
| 25 | sidecar 三元组命名 | `scripts/sidecar-targets.mjs` 等 4 个脚本 | `extraResources` | 删除 | 低 |
| 26 | 签名前置决策 | `scripts/signing.mjs` + 2 个测试 | 思路保留，密钥换 | 重设计 | 中 |
| 27 | 打包目标矩阵 | `tauri.{macos,windows,linux}.conf.json` | electron-builder targets | 重设计 | 中（必须与 `tools/release/artifacts.mjs` 对齐） |
| 28 | CI 排除 desktop | `ci.yml:125,130,146`、`release.yml:144` | 新增 Node 测试步骤 | 重设计 | 低（顺便把 desktop 测试跑起来） |
| 29 | repo-check 根白名单 / 1500 行上限 | `repo.rules.json:3-28,63-74` | 保持 `apps/desktop` 路径 | 不动 | 低（新产物目录要进 blacklist） |
| 30 | **终端域（PTY/tmux/SSH/重附着/输入序号）** | `apps/runtime/src/terminal/`（9,654 行） | 原地不动 | **不动** | 低（tmux 已是主后端，非待办） |
| 31 | Agent 终端环境注入 | `terminal/mod.rs:484-513` | 原地不动 | **不动** | 低（壳从不参与） |
| 32 | xterm 前端与渲染预算 | `apps/web/src/terminal/`（6,776 行） | 原地不动 | 不动 | 低（Electron 的 WebGL 预算可能不同，`DEFAULT_RENDER_BUDGET=4` 需实测） |
| 33 | **浏览器域 Runtime（CDP 受管 Chrome）** | `apps/runtime/src/browser/`（14,909 行） | 若改 `<webview>` 则大部分废弃 | **重设计（战略决策）** | **高**（14,909 行 Rust + `browser.proto` + 3 个迁移 + §2.x 契约编号） |
| 34 | 浏览器前端位图 canvas | `nodes/browser/Frame.tsx:14-18`、`stream.ts` | `<webview>`/`WebContentsView` | 重设计 | 高（租约、输入映射、下载/对话框语义全变） |
| 35 | Hook `browser` 动词 | `crates/hook/src/control.rs:102-132` | 保留 HTTP 形状 | 不动（后端换实现） | 中（`LEASE_REVOKED` 语义要在新实现里保住） |
| 36 | 数据库与迁移 | `apps/runtime/migrations/`（≤0014）、`db/mod.rs:136-220` | 原地不动 | **不动** | 低（新增只能 `0015_*`） |
| 37 | 纯浏览器 / Host 托管模式 | `armadra.sh run web`、`runtime-url.ts:75-99` | 原地不动 | 不动 | 低（换壳期间是可用的回退） |
| 38 | 壳内硬编码中英文案 | `usage.rs`、`native_session.rs:18-23`、`updates/notify.rs` | 主进程 i18n | 重设计 | 中（AGENTS.md 要求文案在 `apps/web/src/i18n/`） |
