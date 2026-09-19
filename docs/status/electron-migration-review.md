# Electron 迁移后的产品复查

> 状态：2026-09-19 只读复查，基线 `d8c1a10ea`（`feature/host-protocol-foundation`）。
> 目的：对照[功能预期总表](feature-roadmap.md) §3 逐行核查换壳后功能是否仍成立，并登记 UI 死角、
> 文档漂移、设计缺口与测试盲区。本文不改任何代码，结论一律给文件:行号。
> 换壳本身的批次与证据见[平台实施记录](platform-implementation-status.md)「Electron 壳迁移」一节，
> 设计见[桌面壳迁移到 Electron](../design/electron-migration.md)。

## 1. 方法与本轮验证

| 范围    | 命令                                               | 结果                                                   |
| ------- | -------------------------------------------------- | ------------------------------------------------------ |
| Web     | `pnpm --filter @armadra/web test`                  | 239 文件 / 2355 项全绿                                 |
| Runtime | `cargo test -p armadra-runtime -p armadra-hook`    | 全绿（单独 `-p armadra-runtime` 会挂，见 §6.3）        |
| Go Host | `go -C apps/host test ./...`                       | 30 包全绿（与 cargo 并跑时偶发一次失败，单独重跑通过） |
| 桌面壳  | 未在本轮重跑，沿用记录中的 vitest 43 文件 / 580 项 | —                                                      |

四档定义：**仍成立**＝代码与测试支持该行描述；**回退**＝能力仍在但范围收窄；
**断裂**＝界面或接口还在但不再工作；**未验证**＝实现在位但无自动化也无手工记录。

## 2. §3 功能总表逐行核查

§3 共 82 条已交付或部分交付的行（✅ 69、🔶 13）。统计：

| 结论   | 行数 |
| ------ | ---- |
| 仍成立 | 64   |
| 回退   | 4    |
| 断裂   | 5    |
| 未验证 | 9    |

未在下表列出的 64 行判为**仍成立**：它们与壳、浏览器节点、页面来源三条迁移面均无耦合
（画布与白板、Agent 终端与协作、Git、编辑器、自动化、GitHub、用量看板、资源监控、
Host 与协议、设置页），由 Web 2355 项、Runtime 与 Go Host 的全绿套件覆盖。

### 2.1 断裂（5）

| §    | 行                                                                      | 结论 | 依据                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.6  | iframe 兼容预览 ✅                                                      | 断裂 | 兼容模式整条路已删。`apps/web/src/nodes/browser/BrowserNode.tsx:19-20` 在非壳环境一律渲染 `UnavailableNode`，不再回退 iframe                                                                                                                                                                                                                                                                           |
| 3.6  | 导航、尺寸、截图、**Console/Network 摘要**、**下载队列**、登录持久化 ✅ | 断裂 | Console/Network 摘要随 `session/console.rs` 删除后未重建，`Network.*` 被结构性测试主动禁止（`apps/desktop/src/main/browser/sole-call-site.test.ts:92-99`）；下载被 `apps/desktop/src/main/browser/transfers.ts:60-99` 全部拦进暂存目录，而唯一出口是 Agent 的 `download --accept`（`main/browser/verbs.ts:515-522`），**人自己点的下载没有任何界面能接受它**，且暂存目录不过期（`transfers.ts:26-28`） |
| 3.11 | 手机焦点页、底部导航、软键盘工具条 🔶                                   | 断裂 | 浏览器节点仍在手机可聚焦集合里（`apps/web/src/shell/mobile-focus.ts:13`），入口仍出现在节点菜单（`apps/web/src/nodes/NodeShell.tsx:440-449`）与焦点页切换器（`apps/web/src/shell/MobileFocusPage.tsx:41-44,89-94`），点进去只有一句「只在桌面应用里可用」。新建入口也无门禁（`apps/web/src/canvas/menus/add-menu.ts:238-247`）                                                                         |
| 3.12 | 服务内嵌：默认不占用固定系统端口，Unix socket / 命名管道优先 🔶         | 断裂 | 验收标准「`lsof -i` 看不到监听端口」（`docs/status/feature-roadmap.md:283`）现在反向成立：壳的回环静态服务、Runtime 的 `tcp:127.0.0.1:0`（`apps/desktop/src/main/runtime-process.ts:121-134`）、Host 的 43121 三个回环端口都在，`docs/guides/development.md:52-54` 已如实写明                                                                                                                          |
| 3.13 | 通用 / 数据页 ✅（数据目录「显示」按钮）                                | 断裂 | `apps/web/src/panels/settings/pages/DataPage.tsx:78` 调 `openExternal("file://…")`，而壳的白名单只允许 `http`/`https`（`apps/desktop/src/shell-core/external-url.ts:20`），必被 `scheme_not_allowed` 拒；`apps/web/src/platform/index.ts:82-86` 只 `console.error`，界面无任何反馈                                                                                                                     |

### 2.2 回退（4）

| §    | 行                                                            | 结论 | 依据                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.6  | Rust Browser Worker + CDP，持久 BrowserSession ✅             | 回退 | Runtime 侧只剩授权三规则、租约状态机、URL 策略与 `active_tab_url`（`apps/runtime/src/browser/` 现只有 `agent/`、`model.rs`、`policy.rs`、`session/{lease,mod}.rs`、`shell/`、`store.rs`、`tests/`）；执行搬到 `apps/desktop/src/main/browser/`。人与 Agent 共用同一会话仍成立，受管 Chromium 不再存在 |
| 3.6  | 画面流跨桌面 / 浏览器 / 手机查看 🔶                           | 回退 | 按设计 D6 移除，`<webview>` 是本机进程内 OOPIF，画面不经 Host 转发。记录已在 `docs/status/platform-implementation-status.md` 的「能力回退」段                                                                                                                                                         |
| 3.3  | Command W 隐藏到托盘；Command Q 停止 Host/Runtime/受管会话 ✅ | 回退 | ⌘W 与 ⌘Q 两半都在（`apps/desktop/src/shell-core/keydown-intercept.ts:52-59`、`apps/desktop/src/main/lifecycle.ts:70-80`）；「受管会话」一项随受管 Chromium 消失。另：`window:key-intent` 事件主进程已发（`apps/desktop/src/main/menu.ts:46`），但页面**从不订阅**，「⌘W 先关一个节点」这半从未生效    |
| 3.10 | 平台自身组件占用：Session Host、Browser 未有 🔶               | 回退 | 浏览器现在是壳自己的 guest 进程，不再是 Runtime 拉起的子进程，Runtime 的进程树采样更没有触达路径；该行的缺口比迁移前更大                                                                                                                                                                              |

### 2.3 未验证（9）

| §    | 行                                                  | 依据                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | 文件拖入终端 / 拖到画布开预览 ✅                    | 页面半边有测试（`apps/web/src/platform/os-file-drop.test.ts`），但 `apps/desktop/src/preload/index.ts:192` 的 `webUtils.getPathForFile` 与它要求的「preload 不 sandbox」（`apps/desktop/src/main/window.ts:121-123`）无任何断言 |
| 3.3  | Windows ConPTY 独立 Session Host 🔶                 | 与换壳无关，仍无实机                                                                                                                                                                                                            |
| 3.5  | 文件下载 ✅                                         | 桌面分支把 Runtime 的下载 URL 交给系统浏览器（`apps/web/src/nodes/EditorNode.tsx:509-513`），外部浏览器是否带得上 Runtime 鉴权未验证                                                                                            |
| 3.6  | Agent 接口 Navigate/Read/Click/Type/Wait/Capture ✅ | 17 动词对录制桩全绿（`apps/desktop/src/main/browser/verbs.test.ts`），真站点手工跑与徽标翻转的真窗口确认未做（记录已自述）                                                                                                      |
| 3.9  | 桌面托盘迷你条 ✅                                   | `apps/desktop/src/main/tray.ts` 零测试；`shell-core/usage.ts` 的解析有测试，`new Tray` 那一层没有                                                                                                                               |
| 3.11 | HTTPS 设备配对、`__Host-` 会话、票据 ✅             | `identity:ticket` 只对伪 CLI 测（`apps/desktop/src/main/host/ticket.test.ts:252-305`）；Go 侧与 `packages/host-client` 各自 mock，三段从未联测                                                                                  |
| 3.12 | 自动更新契约、签名与兼容检查 🔶                     | `electron` 与 `electron-updater` 全 `vi.mock`（`apps/desktop/src/main/updates/updater.test.ts:79-105`）；`quitAndInstall` 的真实行为与 `main/updates/{index,environment}.ts` 无测试                                             |
| 3.12 | Runtime / Host 二进制构建与跨平台暂存 ✅            | 换打包器后的产物矩阵未在真 runner 上跑过（见 `docs/guides/ci-release.md` §4 待验清单）                                                                                                                                          |
| 3.13 | 系统集成面（通知、对话框、外链、全局热键、菜单）    | 规则层有纯函数测试，Electron 接线层零测试：`main/{shortcuts,tray,notifications,dialogs,external,menu,window,index}.ts` 均无伴随 `.test`                                                                                         |

## 3. UI 死角

### 3.1 i18n 死键（`apps/web/src/i18n/browser.ts`）

`browser.*` 共 68 键，**47 键零引用**。`apps/web/src/i18n/i18n.test.ts` 只校验 zh/en 键集一致与不撞键，
不校验是否被引用，因此这批死键不会被测试抓到。

| 行（zh / en）                | 键组                                                                     | 为什么已无意义                  |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| `:92-96` / `:177-184`        | `browser.managed.install/installing/installed/installFailed/unsupported` | 受管 Chromium 下载安装路径已删  |
| `:82` / `:170`               | `browser.stream.reconnecting`                                            | 已无帧流可重连                  |
| `:31-34` / `:121-126`        | `browser.unavailable.chrome_not_found/launch_failed/cdp_closed/unknown`  | 只剩 `desktopOnly` 一个分支被用 |
| `:37-38` / `:129-130`        | `browser.searched` / `searchedNone`                                      | 本机 Chrome 可执行文件探测已删  |
| `:23-26` / `:113-116`        | `browser.state.starting/ready/disconnected/terminated`                   | 只剩 `state.unsupported` 被用   |
| `:28` / `:118`               | `browser.sessionFailed`                                                  | 已无「启动受控浏览器」这一步    |
| `:17,29,30` / `:107,119,120` | `browser.screenshot` / `captureSaved` / `captureFailed`                  | 工具栏截图按钮已不存在          |
| `:18-20` / `:108-110`        | `browser.mode` / `modeControlled` / `modeCompatibility`                  | 受控 / 兼容模式切换已删         |
| `:21-22` / `:111-112`        | `browser.surface` / `browser.keyboard`                                   | 旧截屏画布与合成键盘层已删      |
| `:59-68` / `:148-157`        | `browser.dialog.*`（10 键）                                              | 页面接管的对话框 UI 已删        |
| `:71-79` / `:159-168`        | `browser.chooser.*`（9 键）                                              | 页面接管的文件选择器 UI 已删    |
| `:47,56` / `:138,146`        | `browser.lease.failed` / `browser.tabs.failed`                           | 没有失败反馈路径（见 3.2）      |
| `:48-49` / `:139-140`        | `browser.activity.refused` / `unknown`                                   | 唯一引用者是死组件（见 3.2）    |

### 3.2 仍在界面上但点了没用 / 从不渲染

| 位置                                                    | 现象                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/web/src/shell/mobile-focus.ts:13`                 | `FOCUSABLE` 仍含 `"browser"`，手机焦点页对浏览器节点只有一张空卡片                          |
| `apps/web/src/canvas/menus/add-menu.ts:238-247`         | 「添加浏览器节点」无 `isDesktop()` 门禁，纯浏览器 / 手机上能建一个永远不可用的节点          |
| `apps/web/src/nodes/browser/Lease.tsx:86-114`           | `ActivityLine`（Agent 操作流水）只在 `nodes/browser/index.ts:13` 被 re-export，**从未渲染** |
| `apps/web/src/nodes/browser/WebviewSurface.tsx:146-153` | `handControl` 只 try/finally 不 catch，租约接管失败界面静默无反馈                           |
| `apps/web/src/panels/settings/pages/DataPage.tsx:78`    | 「显示数据目录」按钮必被壳拒（§2.1）                                                        |
| `apps/web/src/platform/index.ts:58-72`                  | `pickFiles` 是孤儿：唯一预期调用者（受控浏览器的文件选择器 UI）已删                         |
| `apps/web/src/nodes/browser/desktop.ts:12-17`           | `isDesktopShell()` 与 `isDesktop()` 是同一判定的两份实现；其注释自陈的理由随旧路径消失      |
| `apps/web/src/nodes/browser/desktop.ts:35`              | Agent 专用 partition 定义了但无调用点；`WebviewSurface.tsx:42-50` 的 `driver` 恒为 `"user"` |
| `apps/runtime/src/browser/model.rs:49-89`               | `Viewport` / `MIN_VIEWPORT` / `MAX_VIEWPORT` 已无引用，属设计要求删而未删的残留             |

设置页干净：`apps/web/src/panels/settings/**` 与 `apps/web/src/settings/**` 里没有任何受管浏览器安装、
画面流、帧率或截屏预算控件。代码侧旧壳残留也已清零——全 `apps/web` grep `isTauri` / `tauri://` /
`__TAURI` / `@tauri-apps` / `__armadra/transport` / `screencast` 只命中
`apps/web/src/nodes/browser/desktop.ts:8` 的一句历史注释。

### 3.3 `platform/index.ts` 能力表

| 能力                  | 壳分支                             | 浏览器回退            | 判断                            |
| --------------------- | ---------------------------------- | --------------------- | ------------------------------- |
| `isDesktop()` :21-23  | 探测 `window.armadra`              | —                     | 仍成立                          |
| `pickDirectory()` :34 | `dialog.pickDirectory`             | 恒 `null`             | 仍成立                          |
| `pickFiles()` :58     | `dialog.pickFiles`                 | 恒 `[]`               | 孤儿，无调用点                  |
| `openExternal()` :75  | `shell.openExternal`（http/https） | `window.open`         | 对 `file://` 两端都失败（§2.1） |
| `onFileDrop()` :105   | DOM drop + `pathForFile`           | no-op                 | 仍成立                          |
| `notify()` :178       | 无壳分支（有意合并）               | 同一条 `Notification` | 仍成立                          |

反向问题未发现：`desktop-bridge-browser.d.ts:68-78` 声明的 `register/unregister/view/control/onDrive`
都有真实调用点。

## 4. 文档漂移

### 4.1 与现状不符的句子

| 位置                                             | 原文要点                                                                                 | 为什么不符                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/status/feature-roadmap.md:16`              | 桌面壳「Tauri 2（tray、dialog、notification、opener）」「sidecar 生命周期」              | 壳已是 Electron；「sidecar」是旧打包器术语，现在是 `extraResources`                                                                                                           |
| `docs/status/feature-roadmap.md:109`             | 「iframe 兼容预览 ✅」                                                                   | 兼容 iframe 已删                                                                                                                                                              |
| `docs/status/feature-roadmap.md:110`             | 「Rust Browser Worker + CDP，持久 BrowserSession ✅」                                    | Runtime 侧已无 `launch/`、`cdp.rs`、`session/stream.rs`；CDP 在壳 main                                                                                                        |
| `docs/status/feature-roadmap.md:113`             | 「画面流跨桌面 / 浏览器 / 手机查看 🔶」                                                  | 已按 D6 移除                                                                                                                                                                  |
| `docs/status/feature-roadmap.md:177`             | 「Runtime / Host sidecar 构建与跨平台暂存」                                              | 术语遗留                                                                                                                                                                      |
| `docs/status/feature-roadmap.md:178,279,283`     | 「默认不占用固定系统端口」「Tauri 通过自定义协议或本地转发」「`lsof -i` 看不到监听端口」 | 三点都与现状冲突（§2.1）                                                                                                                                                      |
| `docs/status/feature-roadmap.md:184`             | 「桌面 `armadra://` 转发…已实现」                                                        | 自定义协议转发已整体删除；CSP 那半句仍成立                                                                                                                                    |
| `docs/status/feature-roadmap.md:190`             | 「WebSocket 只能经壳的回环随机端口转发」                                                 | 限制已消失，`fetch`/`WebSocket` 直连                                                                                                                                          |
| `docs/status/feature-roadmap.md:275`             | §4.4「Runtime 监听 `127.0.0.1:43120`…固定 TCP 端口」                                     | 壳内端口由内核分配并经 stdout 公告                                                                                                                                            |
| `docs/status/feature-roadmap.md:292`             | 目标结构「`apps/desktop` Tauri 壳」                                                      | 同 `:16`；`src-tauri/` 已删                                                                                                                                                   |
| `docs/guides/architecture.md:36`                 | 浏览器节点「驱动接通中」                                                                 | W3.3–W3.5 与 W5 均已合入                                                                                                                                                      |
| `docs/guides/architecture.md:92`                 | 「终端、编辑器、**iframe** 直接渲染在节点里」                                            | 节点体里已没有 iframe                                                                                                                                                         |
| `docs/guides/client-platforms.md:16`             | 手机焦点页「浏览器节点可整屏打开…渲染同一个节点组件」                                    | 正是这句导致 §2.1 的断裂；D6 的能力回退未写入                                                                                                                                 |
| `docs/guides/agent-collaboration.md:168,170`     | 「`armadra-hook` 是 sidecar（`Contents/MacOS/`）」                                       | 路径已变为 `Contents/Resources/`（`apps/desktop/src/shell-core/host/config.ts:172-175`）                                                                                      |
| `docs/guides/ui-refinement.md:27`                | 「⌘Q 之后重新打开是新 **WebView**」                                                      | 现在是新的 `BrowserWindow` / 渲染进程；行为仍成立，措辞过期                                                                                                                   |
| `docs/guides/ci-release.md:341`                  | 偶发表里的「旧 screencast 的 WebP 帧还在路上」                                           | 该批 Rust 浏览器集成测试已随路径删除                                                                                                                                          |
| `docs/design/remote-and-browser-completion.md:4` | 「§2.1、§2.9、§2.10 已被取代…其余小节仍是现状」                                          | 不成立：§2.2–§2.4、§2.7 写的是 Runtime 侧 CDP；§4.1 代码布局表（:333-360）列出的文件在 `apps/runtime/src/browser/` 下**全部不存在**；§5 的批次 0–3 实施状态（:423-467）已作废 |

`docs/guides/development.md`、`docs/guides/host-device-auth.md` 与 `architecture.md` 的端口表、
安全边界经核对与现状一致。一处需要留意：`development.md:167` 说壳持有的 Runtime 在私有 socket
之外**额外**监听一个端口，这是对的（`runtime-process.ts:56` + `:121-134` 两者都听），而
`architecture.md:220` 只写了 TCP 那一半。

### 4.2 文档与探针清洗

已完成清洗。

## 5. 设计完整性

### 5.1 IPC 表（设计 §2.2 对 `apps/desktop/src/shared/ipc.ts`）

**没有任何 `not_implemented` 占位残留**：`ALL_CHANNELS` 里全部 15 条 invoke 通道都在
`IMPLEMENTED_CHANNELS`（`apps/desktop/src/shared/ipc.ts:167-186`），其余 6 条是 event 方向，不走 handle。

但有三条通道是**单向接通**——主进程发、页面不收：

| 通道                        | 主进程发送点                                      | 页面订阅 | 后果                                 |
| --------------------------- | ------------------------------------------------- | -------- | ------------------------------------ |
| `window:key-intent`         | `apps/desktop/src/main/menu.ts:46`                | 无       | ⌘W「先关一个节点」这半从未生效       |
| `window:notification-click` | `apps/desktop/src/main/notifications.ts:42`       | 无       | 主进程通知点击后跳节点无人处理       |
| `window:is-focused`         | `apps/desktop/src/main/index.ts:95`（handler 在） | 无调用者 | 页面改用 `document.hidden`，通道多余 |

### 5.2 浏览器节点分工表（设计 §4.1）

已接通：guest registry 与 `getType() === 'webview'` 校验（`apps/desktop/src/main/browser/registry.ts:42-64`）、
先撤租约再删表项（`registry.ts:81-87`）、懒 attach（`main/browser/cdp.ts:90-113`）、
22 条 CDP 白名单与参数校验器（`shell-core/browser/allowlist.ts:115-240`）、唯一调用点结构测试
（`main/browser/sole-call-site.test.ts`）、11 条冻结脚本与逐字节恒等校验
（`shell-core/browser/scripts.ts:43-109`）、refs 导航代失效（`shell-core/browser/refs.ts:51-128`）、
截图三段囚禁（`shell-core/browser/workspace-path.ts:51-91`）、`browser:drive` WS 与一次性 token
（`main/browser/drive-server.ts:75-234`、`shell-core/browser/drive.ts:32-33,175-181`）、
壳不在时的 `browser_unavailable`（`apps/runtime/src/browser/shell/client.rs:39,260`，三个返回点在
`shell/mod.rs:95-97`、`client.rs:205,222,227`）、17 动词全部有实现且无占位。

未接通 / 与设计不符：

| 项                                                    | 状态     | 依据                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置页的隐藏回收开关                                  | 未接通   | `apps/web/src/nodes/browser/WebviewGuest.tsx:298-300` 硬编码 `enabled: true`，注释自陈「接上设置面板时改的是这一行」；设置页无 Browser 页，`packages/shared/src/api/settings.ts` 无相关键；`discard.ts:17-18` 的「定时器触发时重读」形同虚设                                |
| 对话框 / 文件选择器的 Electron 分支 UI                | 半接通   | CDP 事件已订阅（`main/browser/domain-events.ts:12-55`）且只在 attach 期间存在（人自己弹的走 Chromium 原生模态，设计上正确）；但 Runtime 发出的 `BrowserDialog` / `BrowserFileChooser` 事件在 `apps/web/src` 零消费者，Agent 驱动期间页面弹 `confirm` 时人在画布上看不到提示 |
| 下载队列 UI                                           | 未接通   | 见 §2.1                                                                                                                                                                                                                                                                     |
| Agent 专用 partition                                  | 未接通   | `apps/web/src/nodes/browser/desktop.ts:35` 定义了但无调用点                                                                                                                                                                                                                 |
| `driven` 抑制                                         | 已接通   | `apps/web/src/nodes/browser/discard.ts:45`（`driven` 不回收）+ `main/browser/index.ts:206-211`（人的输入反夺租约）                                                                                                                                                          |
| `BACKGROUND_WEBVIEW_MAX = 8` LRU                      | 已接通   | `apps/web/src/nodes/browser/pool.ts:44,164-175`                                                                                                                                                                                                                             |
| 5 分钟隐藏回收、租约抑制                              | 已接通   | `apps/web/src/nodes/browser/discard.ts:11-47`、`WebviewGuest.tsx:291-334`                                                                                                                                                                                                   |
| 设计写「保留 `session/dialogs.rs` 与 `downloads.rs`」 | 文档不符 | 两文件已整体删除，决策搬到 `main/browser/transfers.ts` 与 `main/browser/verbs.ts:570-596`                                                                                                                                                                                   |
| 设计 §4.2 画「Runtime POST /browser/{verb}」          | 文档不符 | HTTP 浏览器面已删（`apps/runtime/src/lib.rs:466-470`），动词走 hook 动词面进 `agent/mod.rs`                                                                                                                                                                                 |
| Console / Network 摘要的删除                          | 文档不符 | 设计 §4.1「删除」栏没列它，实际已删且被结构性测试禁止                                                                                                                                                                                                                       |

## 6. 测试盲区

### 6.1 关键路径

| 路径                                   | 覆盖                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser:drive` 端到端                 | **无**。三段各自测：壳 WS 真 socket 但 verb runner 是桩（`main/browser/drive-server.test.ts:121-263`）、verb→CDP 真白名单但 guest 是录制桩（`main/browser/verbs.test.ts:13-26`）、Runtime 只到构造请求为止（`apps/runtime/src/browser/tests/shell.rs`）。`apps/runtime/src/browser/shell/client.rs` 无 `#[cfg(test)]`；token 注入路径无测试 |
| CDP 白名单唯一调用点、冻结脚本表       | **有**，源码扫描式（`main/browser/sole-call-site.test.ts`、`shell-core/browser/scripts.source.test.ts`）                                                                                                                                                                                                                                    |
| `identity:ticket` 在真 Host 上         | **无**。壳侧只对 `/bin/true` 与伪 CLI 测；Go 侧与 `packages/host-client` 各自 mock，三段从未联测                                                                                                                                                                                                                                            |
| 更新 check → download → install        | **部分**。`electron` / `electron-updater` 全 mock（`main/updates/updater.test.ts:79-105`）；真下载与签名校验在 `apps/desktop/scripts/updates-release.test.mjs`，但不含 `quitAndInstall`                                                                                                                                                     |
| 子进程监管                             | **有**，真 spawn 真 SIGTERM（`main/runtime-process.test.ts`、`main/host/launch.test.ts`、`main/lifecycle.test.ts`）；编排层 `main/host/index.ts` 与 `main/index.ts` 无测试                                                                                                                                                                  |
| `<webview>` 生命周期                   | **覆盖最全**（`apps/web/src/nodes/browser/{pool,webview,drive,lease}.test.ts`、`WebviewSurface.test.tsx`）                                                                                                                                                                                                                                  |
| 拖放 `webUtils.getPathForFile`         | **部分**，见 §2.3                                                                                                                                                                                                                                                                                                                           |
| 托盘 / 菜单 / 热键 / 通知 / 对话框接线 | **无**。`main/{tray,menu,shortcuts,notifications,dialogs,external,window,index}.ts` 无伴随测试                                                                                                                                                                                                                                              |

`apps/desktop` 完全没有伴随测试的源文件：上表最后一行的 8 个，加上 `main/host/index.ts`、
`main/updates/{index,environment}.ts`、`main/browser/{index,bus,cdp,registry,renderer,transfers,domain-events}.ts`、
`preload/index.ts`、`renderer/**`。

CI 确实跑了桌面壳的 vitest 与 `node --test`（`.github/workflows/ci.yml:109` 的 `pnpm -r --if-present test`，
三平台各一遍；`release.yml:137` 同）。但**没有任何 Electron 运行时冒烟**：不启 app、不开窗口、
无 Playwright 类测试，所以上面所有「无」项只能靠人工验收。

### 6.2 被标为跳过 / 偶发的测试

- `apps/desktop`：一条都没有（无 `skip`/`only`/`todo`，无 retry）。
- `apps/web/src/terminal/file-drop.test.ts:267`：`it.skipIf(process.platform === "win32")`。
- Rust `#[ignore]`：`apps/runtime/tests/language_real.rs:60,206,248`（需要 `ruff` / 特定工具链）。
- Go `t.Skip`：两类——需要真二进制的环境变量门控（`apps/host/internal/worker/*_real_test.go`、
  `cmd/armadra-host/{proxy,automation}_test.go`、`internal/{canvashost,commanddispatch,automationhost}/*`），
  与平台/权限门控（Windows、符号链接、root）。
- 只在文档里记为负载敏感的：`docs/guides/ci-release.md:305,331,341`、
  `docs/status/platform-implementation-status.md:11,212,319`。本轮复现了一次：cargo 与 go 并跑时
  Go 出现一次 `FAIL`，单独重跑全绿。

### 6.3 命令本身的坑

- `AGENTS.md` 写「Runtime 用 `cargo test -p armadra-runtime`」，但该命令在干净 target 目录下必失败：
  `apps/runtime/tests/hook_endpoint_failover.rs:120,132` 需要 `armadra-hook` 与 Runtime 并排构建，
  错误信息自己提示要 `cargo test -p armadra-runtime -p armadra-hook`。
- 不先 `pnpm libs:build` 直接跑 `pnpm --filter @armadra/desktop test`，6 个文件会以
  `Failed to resolve entry for package "@armadra/protocol"` 整文件失败。同样的解析问题在
  `pnpm --filter @armadra/web test` 首次运行时出现过一次（174 文件失败），直接 `npx vitest run` 全绿。

## 7. 优先级清单（Top 15）

按「用户可感知 × 修复成本」排序。规模：S ≤ 半天，M ≤ 两天，L 更多。

| #   | 现象                                                                      | 位置                                                                        | 建议做法                                                                                       | 规模 |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| 1   | 用户自己点的下载被拦进暂存目录，没有界面能接受                            | `apps/desktop/src/main/browser/transfers.ts:60-99`                          | 人发起的下载直接放行到系统下载目录；Agent 发起的才进暂存并加过期                               | M    |
| 2   | 设置→数据「显示数据目录」按钮必失败且无反馈                               | `apps/web/src/panels/settings/pages/DataPage.tsx:78`                        | 新增一条 `shell:show-item-in-folder`（`shell.showItemInFolder`），不放宽 `openExternal` 白名单 | S    |
| 3   | 手机上能打开 / 新建永远不可用的浏览器节点                                 | `apps/web/src/shell/mobile-focus.ts:13`、`canvas/menus/add-menu.ts:238-247` | 从可聚焦集合移除 `browser`，新建入口加 `isDesktop()` 门禁                                      | S    |
| 4   | 隐藏回收开关硬编码为开，设置页没有 Browser 页                             | `apps/web/src/nodes/browser/WebviewGuest.tsx:298-300`                       | 加一页设置（回收开关 + 分钟数 + 后台上限），接到 `discard.ts` 已留好的读取点                   | M    |
| 5   | Agent 驱动期间页面弹对话框 / 选文件，人看不到提示                         | `apps/runtime/src/browser/shell/mod.rs:166-207` 无页面消费者                | 在租约徽标旁显示一行，或恢复一个精简的接管卡片                                                 | M    |
| 6   | 租约接管 / 标签操作失败静默                                               | `apps/web/src/nodes/browser/WebviewSurface.tsx:146-153`                     | 加 catch，用已有的 `browser.lease.failed` / `browser.tabs.failed`                              | S    |
| 7   | 47 个 i18n 死键                                                           | `apps/web/src/i18n/browser.ts`（见 §3.1）                                   | 删键；顺带给 `i18n.test.ts` 加一条「键必须被引用」的扫描守卫                                   | S    |
| 8   | `ActivityLine` 从不渲染，Agent 操作对人不可见                             | `apps/web/src/nodes/browser/Lease.tsx:86-114`                               | 接进 `WebviewSurface` 的头部，或连同两个键一起删                                               | S    |
| 9   | 文档仍写 Tauri / 固定端口 / iframe 回退                                   | 见 §4.1 十八处                                                              | 按清单逐条改；`remote-and-browser-completion.md:4` 的取代范围扩到 §4.1 与 §5                   | S    |
| 10  | 文档与探针需统一为 Armadra 表述                                           | 见 §4.2                                                                     | 文档与探针已完成清洗；代码中的旧安装匹配字面量保留                                             | M    |
| 11  | 托盘 / 菜单 / 热键 / 通知 / 对话框接线零测试                              | `apps/desktop/src/main/*.ts`                                                | 对 `electron` 做 mock 的接线测试（tray 刷新周期、热键 `taken`、对话框参数）                    | M    |
| 12  | `browser:drive` 没有端到端                                                | §6.1                                                                        | 起真 Runtime + 真 drive server + 一个 fixture guest，跑通三五个动词                            | L    |
| 13  | `window:key-intent` / `window:notification-click` 单向接通                | `apps/desktop/src/main/{menu,notifications}.ts`                             | 页面订阅并实现「先关节点」「跳到节点」，或从 IPC 表删掉两条                                    | S    |
| 14  | 孤儿代码：`pickFiles`、`isDesktopShell`、Agent partition、`Viewport` 常量 | §3.2                                                                        | 一并清理；`isDesktopShell` 合并进 `isDesktop`                                                  | S    |
| 15  | `cargo test -p armadra-runtime` 按 AGENTS.md 写法必失败                   | `apps/runtime/tests/hook_endpoint_failover.rs:120,132`                      | 改 AGENTS.md 的命令，或让该测试自行 `cargo build -p armadra-hook`                              | S    |
