# 桌面壳迁移到 Electron

> 状态：已实施（2026-09-19，W0–W5 全部合入，主线 `9b989dbd3`）；未完成的只有真机手工验收（见 status）。本文把桌面壳从 Tauri 换成 Electron，并借此把浏览器节点从「CDP 截屏流」换成进程内 `<webview>`。写这份文档时业务仍由 Rust Runtime 执行、Go Host 迁移方向不变；终端（tmux 已是主后端）、Agent、持久化三个域**原地不动**——这几点后来随 [TypeScript Core](./typescript-core.md) 一并改变：Runtime 与 Host 已合并重写为一个 TS core，下文出现的 `apps/runtime`、`crates/`、`apps/host`、`cargo test`、`go test` 等都是当时的落点，仅作实施批次的历史记录，不代表现状；本文关于 Electron 壳结构、`<webview>` 与画布性能的决策本身仍然成立。
> 范围：`apps/desktop`（整体重写）、`apps/web` 的壳耦合面（9 个文件 + 14 处 `isTauri()`）、`apps/runtime/src/browser/` 的瘦身、Go Host 的原生来源判定、发布与更新管线、以及一组与换壳无关但必须先做的画布性能修正。
> 基线：2026-09-19 的 Armadra `34cd50497`，覆盖现状盘点、进程模型、终端与 tmux、浏览器节点、画布与状态、Agent 集成六个方面。本文行数与测试数均以该基线为准；Electron 42 + React Flow 的浏览器路径由 W3.0 探针验证。

## 1. 结论与决策

| #   | 决策                                                                                                | 依据                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **壳换 Electron，路径仍是 `apps/desktop`，包名仍是 `@armadra/desktop`**                             | 壳只占全仓 1.6%（9,127 行）；`repo.rules.json` 根目录白名单与 `apps/` 命名规则不用改                                                                                                                                                             |
| D2  | **终端域留在 Rust Runtime**                                                                         | tmux 已是主后端（契约 §15.3），环境注入、SSH、`session-host` 全在 Runtime，壳从不参与；迁入 Electron 会增加原生 PTY 补丁维护、macOS PTY 资源限流、SSH 重写或跨进程拆分、Hook 凭据转发、Windows 独立 crate 隔离丢失，以及 Host 调度渲染壳六项代价 |
| D3  | **Agent 域留在 Rust Runtime**                                                                       | Hook 客户端是独立进程、汇合点是端点文件，tmux 会话活得比壳久；Armadra 采用 CLI 动词面，协作协议不依赖桌面壳                                                                                                                                      |
| D4  | **持久化继续走 Runtime SQLite**                                                                     | AGENTS.md 的迁移规则正是 SQLite 的强项；本次迁移没有 git 共享画布 / SSH 项目文件存储 / 服务器版文件存储这三个需求，无需改为文件方案；文件方案并发语义比现有 CAS + `replayLocalEdits` 更弱                                                        |
| D5  | **浏览器节点改为 Electron `<webview>`；授权留 Runtime、执行搬 Electron main；删除 screencast 路径** | `<webview>` 是 OOPIF，缩放与命中测试在 Chromium surface 层完成，Armadra 探针已验证无需坐标补偿代码；Runtime 的 `launch/`（1,373 行）、`cdp.rs`、`stream.rs` 与前端帧流整体作废                                                                   |
| D6  | **明确放弃「手机经 Host 远端看同一页面」**                                                          | 这是唯一实打实的能力损失；今天也只验证到 macOS 本机（status §23）；降级为「截图 + 元素快照 + 看见并撤销租约」控制面，不保留两套渲染路径                                                                                                          |
| D7  | **画布性能修正 P0–P3 与换壳并行，P0 基线必须在 Tauri 壳与 Chrome 各记一次**                         | 卡顿最可能来源是 `useFlowNodes` 订阅整份 `document` 且 `updateNodeData` 必换 document 对象，与壳无关。用户决定全部并行（2026-09-19）；P0 在换壳前留下的两份基线是事后二分定位的唯一依据                                                          |
| D8  | **删除 `armadra://` 协议转发、WS 回环转发、诊断桥；原生会话票据链保留、来源判定放宽**               | 前三者因 `tauri://localhost` 不是 HTTP 来源而存在。票据链不能删：回环 HTTP 的 Cookie 无端口隔离（§2.1 已验证）。渲染页由壳的回环 HTTP 静态服务提供，来源是真实的 `http://127.0.0.1:<port>`                                                       |
| D9  | **更新状态机整段移植成 TS，验签安装换 electron-updater**                                            | `updates/machine.rs` 是纯函数十一态，`HostStopFailed`（先停 Host 再装）是 Armadra 的必要约束，不能以简化更新器为由省略                                                                                                                           |
| D10 | **未发版，不做 UI/数据兼容；但 Host 的 `--launcher desktop` 值沿用**                                | 同一台开发机会并存 Tauri 壳与 Electron 壳启动的 Host，沿用同一 launcher 值让「无端口 Host 替换」逻辑（`host/mod.rs:196-219`）继续生效                                                                                                            |

不做的事（本轮明确排除）：Server Edition / 多壳共享 core（Armadra 的 Runtime 已是那个 core）、Windows 实机验收（无 Windows 机器，`crates/session-host` 与 NSIS 打包按离线检查交付）、`send`/`reply` 推送管线、账户级配置目录隔离（独立于换壳）。

## 2. 目标结构

```
apps/desktop/
  electron.vite.config.ts        三 target：main / preload / renderer(=apps/web dist 或 dev server)
  electron-builder.yml           mac dmg+zip（arm64/x64，hardenedRuntime + notarize）、win nsis、linux AppImage/deb/rpm
  package.json                   @armadra/desktop；dev / build / dist / test
  src/shared/ipc.ts              通道名唯一真相（≤ 15 条），三边 import
  src/shell-core/                纯逻辑，禁止 import electron（源码扫描测试守住）
    updates/machine.ts           machine.rs 逐行翻译，十一态 + reason token 不变
    updates/offer.ts coordinate.ts
    usage.ts                     托盘两行文案解析
    host/verify.ts               Host 应答校验规则（packages/protocol 解码）
    runtime/identity.ts          instance 公告行解析、/health 对账判定
    paths.ts                     数据目录解析（与 Runtime paths::data_dir 逐字一致）
  src/main/
    index.ts                     app 生命周期装配；platform 单例最先初始化
    window.ts                    BrowserWindow（hiddenInset、vibrancy sidebar、发送时解析绝不捕获）
    static-server.ts             回环 HTTP 静态服务（内核分配端口），origin 由此确定
    runtime-process.ts           spawn + 公告行 + /health + 孤儿清理 + RELEASE_TIMEOUT
    host/{launch,verify,mod}.ts  三分法与 HostLaunchError 联合类型照搬
    lifecycle.ts                 RUNNING/STOPPING/STOPPED；before-quit 先停 Host 再停 Runtime；失败不退出
    tray.ts menu.ts              托盘 + 用量两行；应用菜单；keydown-intercept 封闭清单
    shortcuts.ts                 globalShortcut；默认零注册；被占用如实报 taken
    dialogs.ts external.ts       showOpenDialog；openExternal + scheme 白名单
    notifications.ts             retainUntilDismissed
    updates/updater.ts           electron-updater 接线；只在 isPackaged 且已签名时启用
    browser/                     §4：guest registry、CDP 白名单、冻结脚本表、refs、驱动通道
  src/preload/index.ts           contextBridge.exposeInMainWorld('armadra', api)；事件订阅 fan-out 去重
  scripts/                       signing 三态判定（保留思路）、info-plist 允许清单测试、stage 二进制
  resources/                     armadra-runtime / armadra-host / armadra-hook / armadra-session-host（extraResources）
```

`src-tauri/` 在收尾批删除，同时从根 `Cargo.toml` workspace 成员里移除。单文件 ≤ 1,500 行（`repo.rules.json:63-74`），`out/`、`release/` 加进 blacklist。

### 2.1 进程与来源

```
Electron main ──spawn──▶ armadra-runtime --listen tcp:127.0.0.1:0   （stdout 公告 instance id + 端口）
             ──spawn──▶ armadra-host start --launcher desktop --listen 127.0.0.1:43121
                                            --allow-origin http://127.0.0.1:<static-port>
             ──serve───▶ http://127.0.0.1:<static-port>/  （apps/web 产物，内核分配端口）
BrowserWindow ──load──▶ 上面的 URL；页面从 preload 读一次 { httpBase, wsBase, hostBase }
```

- 页面来源是真实 HTTP 来源，`fetch`/`WebSocket` 直连 Runtime 与 Host，**不再需要**协议转发与 WS 回环转发（两条转发路径整体删除）。
- Host 侧（**已验证并实施，`403902701`**）：回环 HTTP 来源**不能**走 cookie 会话——理由不是明文，而是 Cookie 按 host 不按 port 作用域（RFC 6265 §8.5），`127.0.0.1:A` 的 Cookie 会发往同一 profile 的任何 `127.0.0.1:B`，`Secure`/`__Host-` 都不提供端口隔离（`auth.go:28-29` 的既有不变量正确）。因此**保留 `pair` 票据 Bearer 路径**（`identity.native-session.v1`），原生来源判定从三个硬编码 `tauri://` 值放宽为「Tauri 拼写 ∪ `--allow-origin` 里的回环 HTTP 来源」（`native.go` 的 `loopbackHTTPOrigin()`）；信任根不变，浏览器即便合法持有该来源也拿不到票据。Tauri 拼写在 W5 删除。`docs/design/host-native-session.md` 改状态而非归档；`packages/host-client` 的 `NATIVE_PAGE_ORIGINS`（`native.ts:8-12`、`identity.ts:95-99`）在 W1.2 壳/前端半边同步放宽。
- Runtime 在壳模式下监听 TCP 回环而非 Unix socket：任何本机进程都能连到它，这一点与今天的 WS 回环转发端口等价，不引入新的暴露面；Hook 服务仍走 Unix socket + app bearer 不变。
- Windows 不再有 `http(s)://tauri.localhost` 特例，与 macOS/Linux 同一条路。

### 2.2 IPC 表面（`src/shared/ipc.ts`）

| 域        | 通道                                                                                   | 方向                               | 备注                                                                          |
| --------- | -------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| transport | `transport:endpoints`                                                                  | invoke                             | 返回 `{ httpBase, wsBase, hostBase, dataDir }`，替代 `__armadra/transport`    |
| dialog    | `dialog:pick-directory`、`dialog:pick-files`                                           | invoke                             | 保留「返回路径而非字节」与 `canCreateDirectories`                             |
| shell     | `shell:open-external`                                                                  | invoke                             | scheme 白名单 `http`/`https`，其余拒绝                                        |
| updates   | `updates:state/check/dismiss/cancel/download/install/restart-report`                   | invoke                             | 7 条与今天的 Tauri command 一一对应；`updates:progress` 事件                  |
| shortcuts | `shortcuts:apply`                                                                      | invoke；`shortcuts:triggered` 事件 | 只认 `global.toggleWindow` / `global.newTerminal`                             |
| window    | `window:is-focused`                                                                    | invoke                             | 决定要不要弹系统通知                                                          |
| window    | `window:key-intent`、`window:notification-click`（事件，W2.1 追加）                    | event                              | 主进程拦截的和弦（封闭清单，本批只有 ⌘W）与主进程通知的点击必须有地方报给页面 |
| identity  | `identity:ticket`（W1.2 追加，`reach: window`）                                        | invoke                             | main 执行 `armadra-host pair` 取票交给页面；pair 能力本身不暴露               |
| app       | `app:locale`                                                                           | invoke                             | 托盘/菜单文案从 `apps/web/src/i18n/` 取，主进程只拿 locale                    |
| browser   | `browser:register/unregister`（renderer→main）、`browser:drive`（Runtime→main，见 §4） |                                    |                                                                               |

规则：JSON camelCase、错误 `{ code, message }`（AGENTS.md）；从第一天区分「只对本窗口」与「可被远端调用」，即便暂无远端 peer。preload 的 `window.armadra` 只暴露这张表，`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: true`。

### 2.3 前端改动面

- `platform/index.ts`：`isTauri()` → `isDesktop()`（探测 `window.armadra`），六个能力的壳分支换实现；浏览器回退分支不动。
- `api/runtime-url.ts`：删除 `tauri://` 映射表，改为从 `transport:endpoints` 取基址；`isShellTransport()` 语义保留。
- `host/native-session.ts`（204 行）与测试：按 §2.1 验证结果删除或改来源判定。
- `updates/shell-updater.ts`、`keybindings/global-shortcuts.ts`：`invoke`/`listen` 换成 `window.armadra.*`，页面侧状态机不动（`updates/state.test.ts` 不改仍过）。
- `shell/window-region.ts`、`WindowDragLayer.tsx`：改 CSS `-webkit-app-region: drag`。
- 拖放：`webUtils.getPathForFile(file)` 取绝对路径，`file-drop.test.ts` 的坐标换算删掉物理像素分支。
- `nodes/browser/`：见 §4。
- 壳内硬编码文案（`usage.rs`、`native_session.rs:18-23`、`updates/notify.rs`）搬进 `apps/web/src/i18n/`，主进程经 `app:locale` 选词。

## 3. 画布性能（先于换壳）

Armadra 的画布性能分析结论：现有基线（`canvas-react-flow.md:706`）的 30 个终端节点**没有活会话**，测不出用户报的卡顿。

| 批  | 内容                                                                                                                                    | 验收                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P0  | 补「30 个终端节点 + 真实会话」压力场景；Profiler 记录一次 agent 状态跳动的重渲组件数                                                    | 脚本可复跑，基线表落 `docs/status/`                                    |
| P1  | 会话状态、连接状态、`pendingLaunch`、agent 忙闲移出 `document`，另起薄 store；投影层只订阅原始签名，条目用 `getState()` 读              | 同一次状态跳动重渲组件数下降一个数量级；web 测试全绿；P0 平移 fps 不退 |
| P2  | `useFlowNodes` 只在 nodes/edges 数组引用变化时重算；`selected` 移出投影输入；`CanvasOverlays.boxes` 按需算                              | 拖拽一个节点时 `projectNodes` 调用次数与节点数解耦                     |
| P3  | 便签/改名等文本输入改本地 state + 防抖提交；审计所有 `updateNodeData` 调用点频率                                                        | 连续输入 100 字符 `commit()` ≤ 5 次；撤销栈 1 条                       |
| P4  | Monaco/Browser/Diff 节点体 `React.lazy`；终端 park（5 分钟窗口 + LRU + `live-work` 式守卫：`DirectBackend` 会话不得被任何释放杠杆触碰） | 首屏 chunk 下降；切画布 5 分钟内终端瞬时恢复且 pane pid 不变           |
| P5  | 保存失败退避 + Retry + 明确文案（核对 `save/autosave.ts` 的失败恢复：失败后 `dirty` 能否重新武装防抖）                                  | 注入一次 Runtime 拒绝，后续编辑仍能触发保存                            |

P0–P3 是收益主体，不依赖 Electron，**换壳批次 1 之前完成**。P4–P5 可与换壳并行。

## 4. 浏览器节点

Armadra 浏览器设计的三条不变量：所有权只在内存、绝不从磁盘恢复；Stop 必须 detach + 撤所有权，只隐藏徽标是 Critical 级 bug；CDP 白名单默认拒绝且连参数一起校验，唯一调用点由结构性测试守住。

### 4.1 分工

| 层             | 归属                         | 内容                                                                                                                                                                                                                                                                                                                   |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 显示           | `apps/web`                   | `<webview partition=... src=...>` + 工具栏（后退/前进/刷新/地址栏）+ 租约徽标 + 标签条。`nodrag nowheel`，无 hover-guard。导航由 `src` 驱动不用 `loadURL`；`did-navigate` 只更新地址栏                                                                                                                                 |
| guest 生命周期 | `apps/web`                   | 所有 webview 宿主节点渲染在 React Flow nodes 尾部的 **pool region**，只追加/删除、存活期间相对顺序不变（DOM 移动即杀 guest）；后台标签与非活动项目用 `display:none` 不卸载；`BACKGROUND_WEBVIEW_MAX = 8` LRU；5 分钟隐藏回收，持有租约时抑制，回收后的提示说「为省内存释放了」                                         |
| 授权与租约     | Runtime `browser/`           | 保留 `policy.rs`（URL 策略）、`session/lease.rs`（状态机，纯函数）、`agent/mod.rs` 授权三规则与动词分发、`agent/render.rs` prose、`session/dialogs.rs` 与 `downloads.rs` 的决策、`store.rs` 瘦身到 `active_tab_url` + `lease_generation`                                                                               |
| 执行           | Electron `src/main/browser/` | guest registry（`dom-ready` 注册 `webContentsId → nodeId`，校验 `getType() === 'webview'`）；`webContents.debugger` 懒 attach；CDP 白名单 `(method, 参数校验器)`；冻结脚本表（无插值单引号字面量，源码测试守住）+ `Runtime.callFunctionOn` 恒等身份校验；refs 按导航代失效、过期一律拒绝；截图写文件并囚禁在工作空间内 |
| 删除           | Runtime + web                | `launch/*`、`cdp.rs`、`session/stream.rs`、`routes/stream.rs`、`session/input.rs`、`session/favicon.rs`、`model.rs` 预算/订阅/编码常量；前端 `stream.ts`、`Frame.tsx`、`geometry.ts`、`input.ts`、兼容模式 iframe；`browser.proto` 的 `BrowserStreamFrame`/`BrowserStreamClient` 按协议流程删除                        |

### 4.2 动词路由

```
armadra-hook browser <verb> ──▶ Runtime POST /browser/{verb}
                                  授权三规则 + 租约裁决（不变）
                                ──▶ browser:drive（Runtime → Electron main，窄 WS 通道，载荷是动词不是 CDP 方法名）
                                      ──▶ CDP 白名单 ──▶ guest
                                ◀── 结果（重测值：滚动回实测位移，read 只报「填没填」不报值）
```

17 个 Hook 动词面 100% 保留，`LEASE_REVOKED` 语义保住。`browser:drive` 是 Runtime 主动连壳的一条 WS（壳启动 Runtime 时把地址写进环境），Runtime 在壳不在时对动词回 `{ code: "browser_unavailable" }`。

### 4.3 契约编号

`docs/design/remote-and-browser-completion.md` 的 §2.1–§2.12 被代码引用数百次，**编号不动**：§2.1 受管二进制、§2.9 跨端画面、§2.10 进程组清理在文首状态行标为「已由 electron-migration §4 取代」，正文保留供回溯；被删代码里的 `设计 §8` 引用随代码消失。`browser_sessions` 表不改列（迁移不可修改），`pid`/`cdp_port` 列留空。

## 5. 实施批次

六条工作流，`W0` 与 `W1` 可立即并行；`W3.0` 是 go/no-go 实验，独立小工程，不依赖 `W1`。

### W0 · 前置修正（不依赖换壳）

| 批   | 内容                                                                                                                                                                        | 验收                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| W0.1 | 画布 P0–P3（§3）                                                                                                                                                            | 见 §3                                                                                        |
| W0.2 | `tmux/mod.rs:450` idle 判据改 `#{window_activity}`（`session_activity` 每次 attach 被顶到 now）；`paste-buffer` 加 `-r`，copy-mode 退出改同一次 tmux 调用内 `if-shell` 门控 | `cargo test -p armadra-runtime` + 两个新单测；本机私有 socket 手工验证 attach 后 idle 不归零 |
| W0.3 | `crates/hook/src/endpoint.rs` 端点候选遍历：本地端点文件优先，采纳新端点后重读 node token，只有传输层失败才转移；Runtime `listen()` 失败解开单例、`stop()` 删端点文件       | 集成测试：起 A 写端点 → 杀 → 起 B，`armadra-hook context list` 自愈                          |

### W1 · Electron 壳核心

| 批   | 内容                                                                                                                                                                                                                                                                 | 验收                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1.0 | 壳骨架：electron-vite 三 target（CJS main、`electron` 与原生模块外置）、`BrowserWindow`、preload 空 `window.armadra`、`src/shared/ipc.ts`、`shell-core` 边界扫描测试（含 5 正 5 反样本证明正则）。`src-tauri/` 暂留                                                  | `pnpm --filter @armadra/desktop dev` 打开窗口并渲染现有画布（连外部 Runtime）；`pnpm repo:check` 通过                                                                            |
| W1.1 | 子进程监管：`runtime-process.ts`（公告行、`/health` 对账、孤儿识别与 SIGTERM、`RELEASE_TIMEOUT`）、`host/` 三件套、`lifecycle.ts` 三态与退出编排、`ARMADRA_DESKTOP_LIFECYCLE_TRACE`                                                                                  | `runtime_process_tests.rs`（306 行）与 `host/tests.rs`（754 行）的断言移植成 vitest 全绿；手工：冷启动、孤儿 Runtime、⌘Q、Host 停不下来时不退出并弹窗                            |
| W1.2 | 删 transport 层：回环 HTTP 静态服务、Runtime 改 `tcp:127.0.0.1:0`、页面从 `transport:endpoints` 取基址、Host `--allow-origin` 改为真实来源、**验证 Host 对回环 HTTP 来源的会话规则**（§2.1）、按结果删除或改写票据链路（Rust 壳侧、Go Host 侧、`native-session.ts`） | 终端节点开/打字/重连；工作空间事件 WS 实时；设置 → 连接 → 后台服务通过；`go -C apps/host test ./...` 绿；`pnpm host:native-session-smoke` 按新来源改写后通过或随票据链路一并删除 |

### W2 · 系统集成、更新、打包

| 批   | 内容                                                                                                                                                                                                                                                                                                                                                         | 验收                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W2.1 | 对话框、外链白名单、通知 retain、托盘 + 用量、应用菜单 + keydown-intercept 封闭清单、全局热键、毛玻璃、关闭即隐藏（全屏先退出）、拖放路径、`-webkit-app-region`、`isTauri()` → `isDesktop()` 全部调用点、文案进 i18n                                                                                                                                         | `pnpm --filter @armadra/web test` 全绿（`global-shortcuts.ts` 页面半边不改）；手工过一遍拖入文件、外链、通知点击回前台、托盘刷新、热键 `taken`、全屏关窗无黑屏 Space                                           |
| W2.2 | 更新：`machine.rs` → `shell-core/updates/machine.ts` 只写测试；接 electron-updater；保留 `coordinate` 先停 Host、`hostStopFailed` / `installFailed` 区分、「无 pubkey = notConfigured 绝不报 upToDate」、本地包标记避免轮询生产 feed                                                                                                                         | `tests/updates_*.rs`（1,408 行）转换表全部条目；`apps/web/src/updates/state.test.ts` 不改仍过；本地 release server 走 check → download → install → restart；人为让 Host 停不下来确认 `hostStopFailed` 且未安装 |
| W2.3 | 打包：electron-builder（`asarUnpack`、`extraResources` 四个二进制、mac hardenedRuntime + entitlements + notarize、win NSIS、linux 三格式）；`info-plist` 允许清单测试含 `NSLocalNetworkUsageDescription`（缺失会静默拒绝并表现为网络故障）；signing 三态判定；`tools/release/artifacts.mjs` 目标矩阵对齐；`ci.yml`/`release.yml` 把 desktop 的 vitest 跑起来 | 本地 `dist` 未签名包冷启动 25 秒内画布稳定无错误；info-plist 测试通过；`pnpm release:check` 绿；未签名阶段更新器关闭                                                                                           |

### W3 · 浏览器节点

| 批   | 内容                                                                                                                                                                 | 验收                                                                                                                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W3.0 | **go/no-go 实验**：独立最小 Electron 工程（`webviewTag: true` + React Flow），两个节点各一个 `<webview>` 指向本地 fixture，fixture 把 `clientX/Y` 与命中元素画到页面 | zoom 0.25/0.5/1/2 四角与中心命中一致；平移后重复；zoom=2 与 0.5 文字是否重新栅格化（截图）；页内滚动、`<select>`、右键、选区、IME 各一次；悬停时 Cmd+滚轮画布不缩放（记录）；拖节点/缩放过程 guest 不重载。**第 3、6 条失败则整个 §4 重估**。结论按探针体例记入 `tools/probes/electron-webview/README.md`，原始测量由探针输出至 `out/result.json` |
| W3.1 | 只读浏览器节点：`BrowserNode` 换 `<webview>` + 工具栏，沿用尺寸与 i18n；`partition` 创建时定一次永不变更                                                             | 登录真实站点刷新仍登录；关闭重开回到 `active_tab_url`；web 测试 + typecheck 绿                                                                                                                                                                                                                                                                    |
| W3.2 | 生命周期不变量：pool region、顺序稳定、`display:none` 不卸载、后台上限、隐藏回收（租约抑制）                                                                         | 切工作空间、折叠分组、进出视口，`webContentsId` 不变、计数器 fixture 不重载                                                                                                                                                                                                                                                                       |
| W3.3 | 驱动搬 main：guest registry、CDP 白名单 + 唯一调用点结构测试、冻结脚本表 + 恒等校验、refs 导航代；Runtime 保留授权与租约，新增 `browser:drive` 通道                  | Armadra 版验收闸门：能力关闭时 attach 次数为零；无权节点与不存在节点拒绝文本逐字节相同；全程 CDP 监听零条 `Runtime.evaluate`/`Debugger.*`/带 `expression`                                                                                                                                                                                         |
| W3.4 | 17 个动词逐个接通 + 租约 UI；`apps/runtime/src/browser/tests/` 与渲染无关的用例原样复用                                                                              | `--read` 不含 password 值 / `hidden` / `aria-hidden` / `display:none`（六元素 fixture）；`capture` 囚禁在工作空间；人接管时徽标立刻翻转、在途动作记 `unknown`                                                                                                                                                                                     |
| W3.5 | 删旧路径（§4.1 删除行），更新 `remote-and-browser-completion.md` 状态行、`architecture.md`、`docs/status/` 记录能力回退                                              | `pnpm check` + `pnpm protocol:check` 绿；`proto/` 改动不手改生成文件                                                                                                                                                                                                                                                                              |

W3.5 之前不删任何东西：webview 生命周期陷阱只在真机上暴露，旧 screencast 是唯一回退。

### W4 · 终端渲染侧

| 批   | 内容                                                                                                                                                                                                           | 验收                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| W4.1 | 壳加 `--max-active-webgl-contexts=32`；`render-budget.ts` 默认按平台 16（mac）/ 24；补 acquire 去抖、context loss 单次延迟重授（连败上限）、回退 DOM 时字距重算门（测量为 0 放弃）、内存压力释放所有隐藏持有者 | 快速平移穿过 20 个终端无 "lost context" 占位；休眠唤醒 1 秒内恢复 GPU 渲染  |
| W4.2 | tmux 测试隔离守卫：断言 socket 落在测试目录、剥 `TMUX`/`TMUX_PANE`                                                                                                                                             | 在 Armadra 自己的终端里跑 `cargo test -p armadra-runtime`，既有会话不受影响 |

### W5 · 收尾

删除 `apps/desktop/src-tauri/`、根 `Cargo.toml` 成员、capability/CSP 配置、`sidecar-targets.mjs` 等四个脚本；`docs/guides/architecture.md` §2 三层图 / §6 端口表 / §7 安全边界，`development.md` 桌面壳三段与环境变量表；`host-native-session.md` 按 W1.2 结果归档进 `history/` 或改状态；`host-device-auth.md:48-53` 同步；`docs/status/` 记录换壳与浏览器能力回退。验收：`pnpm check` 全绿；写这份文档时还要求 `cargo test --workspace` 与 `go -C apps/host test ./...` 不受影响，这两条命令随 Runtime/Host 合并成 TS core 已不存在，对应验收现在是 `pnpm --filter @armadra/desktop test`；文档不再出现 `tauri://localhost`、`armadra://`、`__armadra/transport` 的现状描述。

### 5.1 依赖与并行

```
W0.1 (P0–P3) ──────────────┐
W0.2 W0.3 ─────────────────┼─▶ 可立即并行，互不相关
W1.0 → W1.1 → W1.2 ────────┤
W3.0 ──────────────────────┘（独立小工程）
W1.2 完成后：W2.1 ∥ W2.2 ∥ W3.1（需 W3.0 通过）∥ W4.1
W3.1 → W3.2 → W3.3 → W3.4 → W3.5
W2.1 + W2.2 → W2.3
全部完成 → W5
```

每批一个 Agent、一个 worktree、独立提交；合并顺序按依赖图；跨批共享的编号（`browser.proto` 字段删除、新迁移若需要则预分配 `0015_*`）在启动前指定。

## 6. 风险

| 风险                                                                                       | 处置                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `<webview>` 是 Electron 标记为不推荐的 API；`WebContentsView` 是覆盖层不参与合成，不能替代 | W3.0 在 Electron 42 上验证；Armadra 采用该版本的 `<webview>` 路径，升级时复跑探针         |
| Host 回环 HTTP 来源的会话规则未验证                                                        | W1.2 第一件事；两种结果都有明确落点（§2.1）                                               |
| Electron 下 WebGL 上下文预算与 WKWebView 不同                                              | W4.1 实测重定 `DEFAULT_RENDER_BUDGET`                                                     |
| 换壳后若仍卡顿无法定位                                                                     | D7：P0–P3 先做并留基线，Electron 壳里复跑 P0 脚本与 Chrome 并列记录                       |
| 更新签名密钥体系整体更换                                                                   | 未签名阶段更新器关闭；先签名再接自动更新                                                  |
| 包体 ~80 MB → ~250 MB、常驻内存上升                                                        | 接受；Chromium 自带即浏览器，抵掉受管 Chrome 下载（`launch/` 1,373 行）与其 152 MB 二进制 |
| 同机并存 Tauri 壳与 Electron 壳启动的 Host                                                 | D10 沿用 `--launcher desktop`；开发期两壳不同时运行                                       |
| Windows 无实机                                                                             | `crates/session-host` 与 NSIS 按离线检查交付，实机验收留待                                |
