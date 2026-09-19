# nodeterm 浏览器节点分析，以及对 Armadra 的映射

只读分析，参照仓库 `/Users/yovinchen/Projects/Rust/Tauri/nodeterm`（Electron 42.10.1 + React + React Flow）。
本文引用的行号取自该仓库当前 `main`（`d76b4996`）与 Armadra `feature/host-protocol-foundation`（`c29cf841f`）。

## 结论

nodeterm 的浏览器节点把「显示」和「驱动」彻底拆开，两边各自用平台已经做对的机制，**自己不写任何坐标换算、帧编码或背压**：

- 显示 = 一个裸 `<webview>` 直接放在 React Flow 的 CSS transform 里。全仓库找不到任何针对画布缩放的补偿代码（对比 xterm 需要 `scale-fix.ts`），因为 webview guest 是 OOPIF，缩放与命中测试由 Chromium 的 surface 层处理，宿主渲染进程根本不参与坐标计算。难点因此不在缩放，而在 **guest 的生命周期**：DOM 移动即杀进程，于是整套 keep-alive/pool region/memory-saver 机制都是围绕「元素永不卸载、永不重排」长出来的。
- 驱动 = `webContents.debugger` 的 **CDP 白名单**（默认拒绝）+ 冻结的页面脚本表，**完全没有 `executeJavaScript`、没有 `Runtime.evaluate`**。人和 Agent 看的是同一个页面、同一个 jar；冲突靠一个 60 秒空闲的内存租约 + 一个永远在的 “X is driving / Stop” 徽标解决。
- 安全姿态是「能力表而非策略」：不存在的动词（cookie 写、全 DOM 读、任意 eval）比被禁止的动词更可靠。

对 Armadra 的判断：**租约语义、17 个 Hook 动词、对话框/文件选择器、策略门（policy.rs）、下载纳管全部保留**，它们与渲染方式无关；**`apps/runtime/src/browser/` 里的 launch/、cdp.rs、session/stream.rs、routes/stream.rs、前端 stream.ts/Frame.tsx/geometry.ts/input.ts 整体作废**（由 Electron 进程内的 `<webview>` + CDP 取代）；**会丢的能力只有一项：手机远端看同一个页面**（Host `proxyStream` 扇出）。建议第一版直接丢，把 screencast 备路降级为「远端设备看截图 + 只读元素快照」，只有当远端观看被验证为真实需求时，再在 Electron 主进程上用 `webContents.beginFrameSubscription` 重新长出来——而不是保留两套渲染路径。

---

## 1. CLAUDE.md 与四份原始实验记录

### 1.1 节点种类与两个 webview 节点

`nodeterm/CLAUDE.md:923-927` 区分两类：

- `web`（`WebNode.tsx`）——锁死的 `<webview>`，无 `nodeintegration`，只加载 `data.url` 或经 `nt-media://` 的本地 html；
- `browser`（`BrowserNode.tsx`）——可导航的 Chromium，包一层共享的 `BrowserSurface`（webview + 工具栏），最后一个顶层 URL 落到 `data.url`；**同一个 surface 也被看板卡片弹窗复用**，所以一个节点可能同时挂两个 guest。

### 1.2 keep-alive：整套设计都是被 guest 的死法逼出来的

`CLAUDE.md:1073-1123`（issue #301）与 `src/renderer/lib/webviewKeepAlive.ts:1-33` 记录的 Electron 42.x 实测：

- guest **活下来**：兄弟节点增删、`display:none`（自身或祖先）——状态不变、viewport 尺寸和滚动位置保留、显示时逐像素重绘一致、定时器按后台标签节流；
- guest **死掉**：任何 DOM *移动*（`insertBefore`/`appendChild` 一个已挂载元素会先 detach），代价是整页重载。

推论即不变量：webview 宿主节点全部渲染在 `<ReactFlow>` nodes prop 尾部一个 **pool region**，条目只追加/删除、存活期间相对顺序永不变（React 只有在保留子节点的相对顺序变化时才调 `insertBefore`）。切项目时旧项目的页面变成 **ghost**（同 node id、`display:none`、不可交互、停在原点、`data.ghost` 让事实回写到 pool 而不是 `updateNodeData`）。
显式代价写在 `CLAUDE.md:1099-1100`：未选中的 browser/web 节点会盖在与它重叠的其他未选中节点之上（选中态 z=1000 仍然赢）。
内存边界：`BACKGROUND_WEBVIEW_MAX = 8`（`webviewKeepAlive.ts:47`），逐出最久退休者；`activateProject` 必须排在 `retireProject` 之前，否则回来的页面会被自己的后台时钟逐出。
Xvfb + CDP 已端到端验证：Alpha→Beta→Alpha 同一 webContents、表单文本与计数器连续、零重载。

### 1.3 探针 A：debugger attach 与用户 DevTools 是否互斥（`docs/superpowers/probes/2026-08-browser-debugger.md`）

设计里标记为 `[UNVERIFIED] 2` 的担心：用户开着 DevTools 时 `debugger.attach()` 会失败，或反过来 attach 会挡住用户开 DevTools。
**实测（Electron 42.8.1，Linux headless + xvfb，真 `BrowserWindow(webviewTag:true)` + 真 guest，重复两次）：两者并存。** 先开 DevTools 再 attach 成功；先 attach 再开 DevTools，两者同时有效，整个 DevTools 窗口期间没有 `detach` 事件。
结论的处理方式值得抄：这条分支没有被删，而是**降级为不可达路径**——`browserDevToolsOpenMessage` 仍在 `browser-lease.ts:44-45`，只是热路径永远走不到；一旦未来 Electron 回退到单客户端，重跑探针、重新启用这句措辞即可。通用的 attach 失败路径始终给**具名结果**，绝不说「不可驱动」。

### 1.4 探针 B：partition / session 身份与 discard-restore（`2026-08-browser-partition.md`）

三条全部支持原设计：

- **A**：没有 `partition` 的 `<webview>` 真的就在 `session.defaultSession` 上，和 app 窗口双向共享 cookie。**这正是 Agent 打开的节点必须有自己的命名 partition 的原因**——否则它直接读到用户已登录的一切。
- **B**：`persist:` 命名 partition 的 webview 被卸载（内存回收器正是这么干的）再重新挂载，**回到同一个 jar**（`jar=B` 仍在）。所以 discard 抑制器是为了*状态*（避免重载闪烁与租约抖动），不是为了正确性。
- **C**：attach 之后再改 `partition` 属性**被静默忽略**（不抛错，仍在原 jar）。这是「partition 在创建时设定一次、永不变更」的实测依据：平台只在 attach 时读它。

原始测量：`probeA {"appwinVisibleInPartitionless":true,"guestCookieInDefault":true}` / `probeB {"rejoinsSameJar":true}` / `probeC {"stillOnOriginalJar":true}`。

### 1.5 探针 C：滚动（`2026-08-browser-scroll.md`）——本仓库唯一一条「没测成」

`Input.synthesizeScrollGesture` **被排除在 CDP 白名单之外**，滚动唯一的门是已有的、受 viewport 边界约束的 `Input.dispatchMouseEvent{type:'mouseWheel'}`。
关键设计选择：**delta 直接按 DOM wheel 约定书写**（正 `deltaY` 向下），而不是把「手势距离」翻译成「wheel delta」——后者符号相反，翻车时看起来像坐标 bug。`down → +0.9·viewport`，`top/bottom` 走到边。
**回复由重新测量得出，不是由请求值得出**：滚动后重读 `Page.getLayoutMetrics`，回 `scrolled browser-3 down 600px (at 1200/4400)`。于是「成功但什么也没发生」这种失败形状无法隐藏——Agent 会看到 `0px` 或反向位移。
这条探针**在实现者机器上跑不了**（无显示器），按 Global Constraint 8「跑不了就停下来报告，不许静默跳过」如实记为未验证，并把「若方向反了就改 `scrollDeltaY` 一行符号」写进待办。

### 1.6 验收闸门（`docs/superpowers/plans/2026-08-19-browser-control-acceptance-gate.md`）

「`browser` 动词不打勾就不算 verified」。其中对 Armadra 直接有用的几条：

- **1.1 开关关着时，debugger attach 次数必须为零**——拒绝发生在任何 attach 之前，闸门顺序本身就是需求。
- **1.4 另一个 Agent 的拒绝文本，必须和「这个 id 根本不存在」逐字节相同**（`no drivable browser node "<id>"`），不给枚举 oracle。
- **1.5 用户打开的节点、以及从 `project.json` 恢复的节点，任何 Agent 都不可驱动**——所有权只在内存 ledger，绝不从共享文件读。
- **1.7 有活租约时不做内存回收**；回收后的调用必须说「为省内存释放了」，**绝不说成权限问题**。
- **1.9 cookie 先写审计再读，审计写不进去就不读**（fail-closed）。
- **1.10 全程 CDP 监听：零条带 `expression` 字段、零条 `Runtime.evaluate`、零条 `Debugger.*`。**
- 2.1/2.3：`--read` 必须排除 password 值、`hidden`、`aria-hidden`、`display:none`；截图必须真的写出图片且**囚禁在项目目录内**。
- 明确划出范围外：**手机端的「看见并撤销」（design §10.3）没有任何管线，手机既不能发起驱动也看不见驱动**；删项目会留下 `persist:nt-agent-browser-<id>` 这个 jar（分区回收器是已命名的后续项）。

---

## 2. 渲染侧：`<webview>` 与缩放画布

### 2.1 最关键的问题：缩放怎么处理？——什么都没做

`BrowserSurface` 渲染的就是一个裸元素（`src/renderer/nodes/BrowserSurface.tsx:293-301`）：

```tsx
{!discarded && (
  <webview
    ref={ref as unknown as React.Ref<HTMLElement>}
    src={src || undefined}
    partition={partition || undefined}
    allowpopups={true}
    style={{ width: '100%', height: '100%' }}
  />
)}
```

画布缩放范围是 `CANVAS_MIN_ZOOM = 0.01` / `CANVAS_MAX_ZOOM = 2`（`src/renderer/canvas/zoom-limits.ts:9-10`，作为 `<ReactFlow minZoom/maxZoom>` 传入，`canvas/Canvas.tsx:13000-13001`），webview 就随 React Flow 的 CSS transform 一起被缩放，**没有任何 scale 补偿、没有 `zoomFactor` 调用、没有逆变换**。git 历史里也没有任何一条与 webview 缩放/命中测试相关的提交。

为什么可以不做：xterm 需要 `scale-fix.ts` 补丁（`CLAUDE.md:810-812`），是因为 xterm **在宿主渲染进程里用 JS 把鼠标 clientX/Y 换算成行列**，CSS transform 不改 `clientWidth`，于是算错。`<webview>` 的 guest 是独立进程里的 OOPIF，宿主从不做这种换算：合成、缩放与命中测试都在 Chromium 的 surface 层完成，带上祖先的 transform。**所以缩放画布上的 webview 点击不偏，是平台属性，不是 nodeterm 的功劳**——但这也意味着换任何一个「自己画帧」的方案（例如 Armadra 今天的 screencast）都要自己把这件事重做一遍。

需要在 Armadra 第一批实验里亲自验证的两个推论（nodeterm 没有文档化，属于我的推断）：
1. 极端缩放下 guest 是位图放缩还是按新的 device scale 重新栅格化（文字是否糊）；
2. **guest 内的 wheel 事件不会冒泡到宿主**（跨进程），所以 Canvas 的捕获阶段 wheel 处理器（`canvas/Canvas.tsx:3483-3500`，靠 `target.closest('.nowheel')` 判断是否让路）对 webview 根本收不到事件——即「鼠标悬停在网页上时 Cmd+滚轮缩放画布」这个手势在 webview 上应当是失效的。nodeterm 没有为此做任何补救，可见它接受这个代价。

### 2.2 拖拽与事件抢夺：靠 class，不靠遮罩

`BrowserSurface.tsx:289` 的容器是 `<div className="browser-node__view nodrag nowheel">`，工具栏是 `nodrag`（:265）。配合 React Flow 的配置（`canvas/Canvas.tsx:13008-13021`）：默认 select 模式下 `panOnDrag={[1]}`（只有中键平移）、`zoomOnScroll/zoomOnPinch/zoomOnDoubleClick` 全关（缩放由自建的捕获式 wheel 处理器统一负责）。结果是：页面内左键拖拽既不移动节点也不平移画布，节点靠 header 拖。

**和终端节点的关键差别：browser 节点没有 hover-guard 遮罩层。** 终端体上盖着一层透明 `.term-hover-guard`（`TerminalNode.tsx:5291`），要悬停 `settings.panHoverDelay`（默认 600 ms）后才把输入交给 xterm，这样快拖=移动节点、滚轮=平移画布（`CLAUDE.md:807-809`）。浏览器节点直接放弃了这个保护：网页需要立刻拿到指针，代价是无法从浏览器节点上起手做框选/平移。这是一个**有意识的取舍**，Armadra 可以照抄，也可以只在 `zoom < 某阈值` 时盖遮罩（缩小时页面本来也没法用）。

### 2.3 partition / cookie 隔离

`partition` 由 `BrowserNode.tsx:61` 从 `data.partition` 透传，语义写在 `BrowserSurface.tsx:29-37`：Agent 打开的节点是 `persist:nt-agent-browser-<projectId>`，用户打开的节点没有 partition（= 默认 session，和 app 窗口共享 jar）。因为 Electron 只在 attach 时读这个属性（探针 C），**discard/restore 重新挂载时必须原样再给一次**，`browser-partition-parity.test.tsx` 保证画布与看板弹窗两处挂载用同一个值——不一致在用户眼里就是「我的登录没了」。

### 2.4 导航栏、新窗口、右键与 DevTools

- 工具栏（`BrowserSurface.tsx:265-288`）：后退/前进（`canGoBack/canGoForward` 在 `did-stop-loading` 时刷新）、Reload/Stop 合一（Shift 绕过缓存）、地址栏（`searchOrUrl` 把非 URL 当搜索）。导航由 `src` 属性驱动，**不用命令式 `loadURL`**（无 src 的 webview 不发 `dom-ready`，早于它的 `loadURL` 是空操作）；`did-navigate` 只更新地址栏，所以页内跳转不会自激循环。
- 导航门控：`src/main/webview-nav.ts` 的 `allowGuestNavigation`——http(s) 与 `nt-media://` 放行；`file://` 只在当前页已是 file:// 或 guest 全新时放行（「远程页面绝不能把 guest 导航到本地文件」），其余 `will-navigate` 一律 `preventDefault`（接线在 `src/main/index.ts:1176-1178`）。
- 新窗口：guest 的 `setWindowOpenHandler` **永远 deny**（`index.ts:1182-1188`），只在来源是已注册 guest、目标是 http(s) 时发 `IPC.browserNewWindow`——**弹窗变成画布上的另一个 browser 节点**，并用一条 rope 连到母节点（`BrowserNode.tsx:34-41` 的隐藏 source handle 就是为此存在）。
- 右键菜单：`src/main/webview-context-menu.ts` 是纯模板函数（不 import Electron，便于单测），顺序为拼写建议（≤5）→ Open Link in New Browser Node / Copy Link Address → Copy Image(Address) → 编辑块（用 Electron **role** 拿 OS 本地化标签）→ Back/Forward/Reload → Inspect Element。文件头记了一个非显然的事实：macOS 的 AutoFill / Writing Tools / Services 子菜单由 AppKit 贡献，**必须把调用帧传给 `menu.popup({ frame })`** 才会出现。
- **DevTools 只有一条路**：右键 Inspect Element → `contents.inspectElement(x, y)`（`index.ts:1220`）。全仓库没有 `openDevTools` 调用；租约侧只**读** `isDevToolsOpened()` 用来挑措辞（而探针 A 已证明这条措辞不可达）。

### 2.5 内存回收器

`src/renderer/nodes/browser-discard-policy.ts:33-51`：`BROWSER_DISCARD_MS = 5min`，`shouldDiscard = enabled && !loading && !audible && !driven && hiddenMs > 5min`。三条豁免各有理由：不能在加载中回收（会丢 POST 结果/中间页）、不能回收出声的页面（Chrome 同理）、**不能回收 Agent 正在驱动的页面**（否则五分钟后目标被销毁，表单、滚动、登录后的 SPA 状态全丢，上一次 read 的所有 ref 静默失效）。设置在**定时器触发时重读**而不是设定时读，且关掉即刻生效、打开则等下一个隐藏周期——保守方向永远倒向用户。
回收的实现是**卸载元素**（`BrowserSurface.tsx:290-291` 注释：把 `src` 清空没用，Electron 忽略 src 置空），恢复时重放 `locationRef` 里记的 URL，并用 `restoringNavRef` 把这次 `did-navigate` 识别为回声——否则「仅仅看一眼节点」就会把项目弄脏（`updateNodeData` → dirty + rev bump + SSH 镜像写）并把未变的页面顶到 Recent 最前。前进/后退栈**不保留**（Electron 无法序列化），和 Chrome 的取舍相同。

---

## 3. 主进程侧：Agent 怎么驱动用户正在看的那个 webview

### 3.1 guest 注册表：node id ↔ webContentsId

渲染侧在 `dom-ready` 时注册（`BrowserSurface.tsx:189-202`）：

```ts
const onReady = (): void => {
  wcId = wv.getWebContentsId()
  window.nodeTerminal.browser.register(wcId, nodeId)
}
wv.addEventListener('dom-ready', onReady)
return () => { ...; if (wcId) window.nodeTerminal.browser.unregister(wcId) }
```

主进程 `browserGuests: Map<number, BrowserGuest>`（`index.ts:647`），值是 `{ nodeId, surface? }`。校验在 `browser-guest-registry.ts:63-81`：整数、`isSafeNodeId`、`surface ∈ {canvas, modal}`，且 **`contents.getType() === 'webview'`**——理由（同文件 :41-46）是这个 id 随后会选中一个要 attach debugger 的 webContents，未校验就是提权。反查 `canvasGuestWcId()`（`index.ts:3043-3053`）**只返回 canvas 表面，绝不驱动看板弹窗里的那一个**。注销时先撤租约（`index.ts:1337-1344`），并用 `browserDiscardedMessage()` 把生命周期事件说成生命周期，不说成权限失败。

### 3.2 只有 CDP，没有 `executeJavaScript`

`src/main` 与 `src/renderer` 里 **零处 `executeJavaScript`**。驱动一律 `webContents.debugger`（`index.ts:3067-3087` 构造 `BrowserSession`），且 attach 是**懒的**——首次发命令时才 `this.dbg.attach('1.3')`（`browser-lease.ts:252-263`），这正是「开关关着时 attach 次数为零」能成立的原因。
页面侧 JS 不走 `Runtime.evaluate`，而是 `Runtime.callFunctionOn` 调用一张**冻结的脚本表**；读取链是 `DOM.getDocument(depth:0) → DOM.resolveNode → Runtime.callFunctionOn(returnByValue) → Runtime.releaseObject`（`browser-actions.ts:136-155`）。点击/输入/滚动/按键完全走 `Input.*` 合成事件，不经脚本（`browser-actions.ts:317-323`）。

### 3.3 CDP 白名单：为什么存在

`browser-cdp-allowlist.ts` 默认拒绝，表是 `(method, params 校验器)` 对而不是方法名集合——**参数也要过校验**：`Page.navigate` 的 url 必须过 `normalizeAddress`（仅 http(s)）；`Input.dispatchMouseEvent` 坐标必须落在已测量的 viewport 内；`Input.dispatchKeyEvent` 的 key 必须属于 `BROWSER_KEYS`，`commands` 只能是 `selectAll`/`deleteBackward`，**`text` 字段一律禁止**；`DOM.getDocument` 要 `0<=depth<=1` 且 `pierce !== true`；`Runtime.callFunctionOn` 要 `isNtScript()` 身份相等 + `returnByValue === true` + 参数只能是单个标量。唯一调用点是 `browser-cdp-send.ts:40-43`，并有结构性测试禁止别处出现 `sendCommand(`。

排除项的理由原文（`browser-cdp-allowlist.ts:16-23`，摘）：

```
 * arbitrary page-side evaluation (Runtime.evaluate/compileScript/runScript/addBinding) and the whole
 * Debugger domain (a second route to it), Fetch (request interception is a proxy for the user's
 * session), Security (can disable certificate errors), Storage / IndexedDB / DOMStorage (the token
 * stores this whole design exists to keep out), DOM.getOuterHTML / getAttributes (the full-DOM read
 * arriving by another door), Page.bringToFront (a page that can raise itself can steal a click the
 * user aimed elsewhere) and Network.getAllCookies (one call empties the jar for every site ...)
```

拒绝消息刻意不解释原因（`browser-cdp-send.ts:25-26`：`browser: the command ${method} is not permitted for agent control`）——「会自我解释的白名单是探测辅助工具」。

`browser-nt-scripts.ts` 是那张冻结脚本表：`readTitle / readMap / readLinks / readText / resolveRef / resolveSelector / describeElement / isVisible / waitProbe / activeField`，每条必须是**无插值、无拼接的单引号字符串字面量**，全是纯读取器（不点、不导航、不提交、不赋值）；`browser-nt-scripts.source.test.ts` 在文件出现反引号、`${}`、HTML 写入 sink 或表不再冻结时让 build 红；`isNtScript()` 是逐字节的恒等成员检查——多一个尾空格就成陌生人。

### 3.4 租约模型

`browser-lease.ts` + `browser-control-ledger.ts` + `browser-revocation.ts`：

- **谁能持有**：只有本次进程生命周期内、经 verified `open-browser` 建立 ledger 条目的那个 Agent 节点。ledger **只在内存、只在 main、绝不持久化、绝不从 `project.json` 读**（`browser-control-ledger.ts:1-27`）——因为 `Project.ropes` 会落盘，一个被改过的 `project.json` 可以预先声明一条 `claude-1 → browser-1` 的归属。代价写在明面上：控制关系不跨重启存活。`claim()` 拒绝重复认领，**没有 handoff / transfer**。
- **时长**：`LEASE_IDLE_MS = 60_000`，每个动词续期；`index.ts:3099` 每 30 s 扫描空闲并 detach，session 留在表里，下一个动词重新 attach。徽标绑 ledger 的 `leaseActiveUntil` 而不是 attach 状态。
- **人类抢占**：`browser-revocation.ts:1-14` 规定每次撤销必须同时做两件事——丢 ledger 条目 **且** `leases.release()`（detach + 用具名结果拒掉在途命令）。原话：「A Stop that only hides the chip is a Critical-class bug」。用户发起的 Stop（节点徽标、节点菜单、Settings 里的 kill row、项目开关关闭）额外留 **tombstone**；生命周期性撤销（关节点、关项目、owner 消失、退出）不留。
- **闸门顺序即需求**（`browser-drive.ts:131-158`）：identity(verified) → canControlCanvas → 每项目能力开关（实时读，关了则拒绝**并**撤销）→ ledger 所有权（tombstone 优先）→ discard 检查。全过才 attach。
- **给 Agent 的文本**：`browser-3: the user stopped agent control of this node`；`no drivable browser node "<id>"`（与不存在同文本）；`Browser control is off for this project. The user can turn it on in the project's Agents settings; you cannot.`
- **UI**：`BrowserDrivingChip.tsx:1-40` —— 「<owner> is driving」+ Stop，**永远开启、没有关闭它的设置、也不打算加**（「用户不能凭偏好变成驱动盲」），且不受能力开关约束：开关决定「能不能驱动」，一旦正在驱动，徽标无条件出现。owner 标题从 ledger 的 `ownerNodeId` 解析，绝不用调用方自报的 label。

### 3.5 refs、截图、cookie

- **refs**（`browser-refs.ts`）：`@7` 是双重作用域的句柄——属于一个 node，且属于**一代导航**。`--read map` 时按序铸造并盖上当前 gen；失效的唯一路径是 `bumpGeneration()`，由 `Page.frameNavigated`（仅主帧）与 `Runtime.executionContextsCleared` 汇入。过期 ref 一律**拒绝，绝不静默重解析**，理由原文：「A ref that silently re-resolves after a navigation is how an agent clicks 'Delete account' while meaning 'Next page'」。
- **截图**（`browser-screenshot.ts`）：**写文件，不回 base64**（base64 只在主进程内短暂存在）。路径是最大风险（文件头：未囚禁就是「攻击者选定内容的任意文件写」原语），`resolveScreenshotPath` 解析到项目 cwd、`realpath` 父目录后做**带分隔符的前缀比较**（`/proj-evil` 不能混进 `/proj`），再用 `lstat` 挡最后一段符号链接。`--full` 的 clip 用**我们自己测的** contentWidth/Height，绝不来自 Agent 输入。回复：`wrote <abs> (w×h, N KB) — show it with: show-image <abs>`。
- **cookie**：只读、单域、**先审计后读且 fail-closed**（`browser-cookies.ts:71-111`，审计写不进去就拒绝，常量 `COOKIES_NOT_RECORDED`），永不 `getAllCookies`，成功回复只报条数不报值。写侧：`COOKIE_WRITE_METHODS` 六个方法单列，`Network.setCookie` 被**允许但无动词可达**，由可达性测试永久钉死；理由是「若能写，什么拦得住它给 accounts.google.com 种一个攻击者控制的 session cookie，让之后人类的一次访问变成攻击者的登录」。文件头还诚实列了三条局限：board-log 非防篡改、不是唯一路径（有 shell 的 Agent 可以直接读 Chromium 的 cookie DB）、审计文件可能被 commit 进 git。

---

## 4. Agent 看到的命令面

`src/core/browser-verb.ts` 是纯参数表，`src/core/canvas-control-core.ts:63-97` 从同一批常量**渲染**出 Agent 文档（parity 测试保证不漂移）：

- 形态：`browser --node <id> <one action> [modifiers]`，**每次恰好一个动作**。
- 动作（9 个）：`--nav <http(s)>`、`--read text|map|links|title`、`--click <@ref|css>`、`--type <text>`、`--press <key>`、`--scroll up|down|top|bottom|<±px>`、`--wait <@ref|css>`、`--screenshot <path>`、`--cookies <domain|current>`。
- 修饰符：`--node`（必填，永不推断）、`--timeout`（默认 15 s，上限 60 s）、`--clear true`、`--full true`、`--into`、`--selector`、`--max`、`--times`。
- **每个 flag 都带值，没有裸开关**（所以是 `--clear true` 而不是 `--clear`）——老的 shim 解析循环会吞掉裸 flag 后面的 token。
- **没有 html / 全 DOM 读模式**（隐藏 input 与内联脚本正是站点放 token 的地方）；`--read map` 的输出形如 `@1 button "Sign in"` / `@3 input#email (email, empty)`——**只报填没填，绝不报值**。
- 回复形状统一是一行：`clicked @7 (button "Sign in") on browser-3`（不报坐标）、`typed 24 chars into ... `（只报字符数）、`scrolled browser-3 down 600px (at 1200/4400)`（实测位移）。
- `src/core/browser-outcomes.ts` 是**重试分类表**（真正的拒绝字符串不在这里）：可重试 `canvasSlow / pageDiscarded / staleRef / offScreen / didNotAppear`；终局 `notVerified / switchOff / notDrivable / userStopped / unsupportedEdition`。文档里的重试指引由这张表渲染。

---

## 5. 对 Armadra 的映射

Armadra 现状（`apps/web/src/nodes/browser/`、`apps/runtime/src/browser/`、`crates/hook/src/control.rs:106-109`）：一个节点 = 一个 Chromium 进程 + `<data_dir>/browser-profiles/<sessionId>` 私有 0700 profile + 一个 `BrowserSession`（`apps/runtime/src/browser/mod.rs:4-21`）；人和 Agent 驱动**同一个** session；画面经 `Page.startScreencast` → 逐订阅者预算 → 专用 WS → 前端 canvas。

| 能力 | 现状（文件） | 换成 Electron `<webview>` 后 |
|---|---|---|
| 会话 = 节点 | `session/startup.rs:18-39`（`node_id` 主键）、`store.rs`（迁移 0010 存 pid/port/generation/activeTabUrl） | **保留概念，实现替换**：会话变成「guest webContents + `persist:armadra-browser-<nodeId或workspaceId>`」，pid/cdp_port 字段作废；`active_tab_url` 仍要存（重启后重导航） |
| 租约状态机 | `session/lease.rs:29-52,249-305`（人 10 s / Agent 30 s 空闲，Agent 排队 5 s，人可直接抢占 Agent，`HumanTakeover` 对 Agent 直接 `LEASE_REVOKED`，generation 单调递增） | **原样保留**，是纯函数、`now` 是参数、与渲染无关。只需把「人的活动」来源从「帧流上行 input」换成「guest 的 `input-event`/`before-input-event` 或 webview 焦点事件」 |
| 租约 UI | `Lease.tsx:15-81`、`session.ts:157-198` | 保留。可以借 nodeterm 的姿态：徽标**无条件显示**，Stop 必须同时 detach + 丢所有权（不能只是隐藏徽标） |
| 多标签 | `session/targets.rs`、`tabs.rs`（`MAX_TABS=16`，最后一个不可关）、`TabStrip.tsx` | 保留，但实现改为「一个节点持有多个 guest，或一个 guest + 自建标签」。**Electron `<webview>` 没有标签概念**，最省事的做法是每个标签一个 `<webview>`，只挂载活动的那个——但注意 nodeterm 的实测：卸载即杀 guest，所以后台标签要用 `display:none` 而不是卸载 |
| 对话框 / 文件选择器 | `session/dialogs.rs`、`Prompts.tsx:28-276`（120 s / 60 s 超时，20 文件上限，越界整批拒） | **保留语义，换事件源**：从 CDP `Page.javascriptDialogOpening`/`Page.fileChooserOpened` 换成 webContents 的 `-dialog`/`select-bluetooth-device` 一类事件或继续用 CDP（Electron 里两条路都在）。`relativeToRoot` 的越界校验照旧 |
| 17 个 Hook 动词 | `crates/hook/src/control.rs:106-109`、`agent/mod.rs:42-46,469-486` | **动词面 100% 保留**，只换路由（见下）。可以吸收 nodeterm 的三条硬规矩：refs 过期必须**拒绝**而不是重解析；`read` 输出只报「填没填」不报值；回复用**重测值**而非请求值 |
| 策略门 | `policy.rs`（URL + 解析地址 → Admit/Refuse，重定向每跳复检；已承认 DNS rebinding 未解） | **保留且更重要**：webview 里可以用 `will-navigate` + `webRequest.onBeforeRequest` 落地，比现在只在 CDP 侧拦更贴近 nodeterm 的 `allowGuestNavigation` |
| 下载纳管 | `session/downloads.rs`、动词 `download --accept/--reject` | 保留，改用 `session.on('will-download')` |
| 帧流 | `session/stream.rs`（699 行）、`routes/stream.rs`（288 行）、`stream.ts`、`Frame.tsx`、`geometry.ts`、`input.ts`、`model.rs:661-722` 的预算/背压表 | **整体删除**。原生渲染后没有编码、没有预算、没有 ack、没有 `MAX_UNACKED_FRAMES`、没有 WebP 探测，`p95 70 ms` 这类指标变成 0 |
| 坐标换算 / 输入回传 | `geometry.ts:61-73` `surfacePoint()`、`Frame.tsx:46-157`（原生 wheel 监听、透明 textarea 吃 IME、修饰位、`navigationEpoch` 409 冲突处理） | **整体删除**。人的输入直接进 guest；IME、复制粘贴、拖放、右键菜单、`<select>` 下拉、PDF 查看器全部免费拿到（这些正是「基本不能用」的来源） |
| 多观看者扇出 | `session/stream.rs:518-527` `widen()`、`MAX_SUBSCRIPTIONS=16` | **丢失**。一个 guest 只在一个窗口里渲染 |
| 手机远端观看同一页面 | `routes/stream.rs:8-9`（Host `proxyStream` 原样转发） | **丢失**，这是唯一实打实的能力损失。nodeterm 在验收闸门里把同一件事（design §10.3 mobile see-and-revoke）明确划为「没有管线的欠账」，即它也没有 |
| 兼容模式 iframe | `BrowserNode.tsx:44-54` | 删除。Electron 壳里永远有 Chromium，沙箱 iframe 的存在理由消失 |
| 受管 Chromium 下载 | `launch/`（`mod.rs`/`process.rs`/`managed.rs` 共 1373 行，含 Job Object、sha256 清单、TOFU 缺口） | **整体删除**——这是最大的一块净收益：Electron 自带的 Chromium 就是浏览器，不再需要找/下/校验/管进程组 |

### 关于是否保留一条 screencast 备路

**建议不保留**。理由有三：(1) 它的唯一用户是「手机看同一个页面」，而这条路今天在 Armadra 里也只验证到 macOS 本机（`docs/status/platform-implementation-status.md:23`「真实远端回写与跨端画面未验收」）；(2) 两套渲染路径意味着输入、租约、标签、对话框每一处都要写两遍，nodeterm 的经验反复指向「一个事实只能有一个来源」；(3) 真要做远端观看，Electron 主进程侧有更便宜的替代：`webContents.capturePage()` 做**按需截图**（配合已有的 `capture` 动词），或在明确需求出现后用 `beginFrameSubscription` 单独长一条**只读**流——只读流不需要输入回传、不需要 epoch 冲突处理，复杂度只有现在的一小半。
过渡期建议：手机端保留「看截图 + 读元素快照 + 看见并撤销租约」，即把 §10.3 那件事做成**控制面**而不是**画面**。

### 推荐架构

1. **webview 归 Electron main 管，节点只持有一个 id。** 渲染侧只做 `<webview partition=... src=...>` + 工具栏 + 徽标；所有权、租约、CDP 驱动全在 main。照抄 nodeterm 的 guest registry：`dom-ready` 注册 `webContentsId → nodeId`，注册时校验 `getType() === 'webview'`。
2. **Runtime 的 `browser` 模块保留：** `policy.rs`（导航策略，仍是唯一策略来源）、`session/lease.rs`（状态机，纯函数）、`store.rs`（瘦身到 `active_tab_url` + `lease_generation`）、`agent/mod.rs` 的授权三规则与动词分发、`agent/render.rs` 的 prose、`session/downloads.rs` 的工作空间纳管决策、`model.rs` 里与动词/租约/对话框相关的类型。
   **删除：** `launch/*`、`cdp.rs`、`session/stream.rs`、`routes/stream.rs`、`session/input.rs`、`session/favicon.rs`（改由 webview 的 `page-favicon-updated`）、`model.rs` 里的预算/订阅/编码常量。
   **迁移：** `session/targets.rs`（tab/frame/ref 注册表）与 `dom.rs`（冻结脚本表）——这两块是纯 CDP 逻辑，可以整体搬到 Electron main（TypeScript 重写），也可以让 Runtime 继续持有 CDP 会话、由 main 把 guest 的调试端口/`debugger` 通道转交。**推荐前者**：一个 CDP 客户端比两个好，而 nodeterm 已经证明 main 侧的白名单 + 冻结脚本表足够表达这些读取。
3. **Hook 动词路由：** `armadra-hook browser <verb>` → Runtime 的 `POST /browser/{verb}`（授权三规则 + 租约仍在 Runtime 裁决）→ Runtime 通过一条**新的、窄的** IPC/WS 把「已授权的动作」下发给 Electron main → main 过 CDP 白名单 → guest。换句话说：**授权留在 Runtime，执行搬到 main**，两者之间的接口是动词而不是 CDP 方法名（这正是 nodeterm 的 `browser-drive.ts` 与 `browser-cdp-send.ts` 的分界）。
4. **照抄的三条不变量：** (a) 所有权只在内存、绝不从磁盘文件恢复；(b) Stop 必须 detach + 撤所有权，只隐藏徽标是 Critical 级 bug；(c) 默认拒绝的 CDP 表要连**参数**一起校验，且唯一调用点由结构性测试守住。

---

## 6. 建议的实施批次

**批次 0（半天，必须最先做）——缩放画布上的 webview 最小实验。**
目标：在不动 Armadra 任何现有代码的前提下，验证「`<webview>` 在 React Flow 的 transform 里渲染正确且点击坐标不偏」。
做法：一个独立的最小 Electron 工程（`webviewTag: true` + React Flow），画布上两个节点，每个节点一个 `<webview>` 指向一个本地 fixture 页面；fixture 在 `click` 时把 `event.clientX/Y` 与目标元素名画到页面上。
验收（逐条记录，照 nodeterm 的探针体例写进 `docs/research/nodeterm/`）：
1. zoom = 0.25 / 0.5 / 1 / 2 各点击四角与中心的按钮，**命中的元素与肉眼所指一致**，页面自报坐标与按钮几何一致；
2. 平移画布后重复一次（transform 的平移分量不引入偏移）；
3. 文本在 zoom=2 与 zoom=0.5 下是位图放缩还是重新栅格化（截图对比）；
4. 页面内滚动、`<select>` 下拉、右键菜单、文本选区、IME 输入各试一次——**这四项是 screencast 方案最难做对的**；
5. 悬停在页面上滚轮/Cmd+滚轮：确认画布**不**缩放（预期失效，见 §2.1 推论 2），记录实际行为并决定是否需要一层「缩放时的遮罩」；
6. 拖拽节点 header 平移/缩放过程中，guest 是否重载（预期不会，但 React Flow 的节点重排可能触发 DOM move——**这是 nodeterm 整套 keep-alive 的起因，必须在批次 0 就撞一次**）。
不通过就停：若 3 或 6 失败，整个 Electron `<webview>` 方案的前提需要重估。

**批次 1（1–2 天）——Electron 壳 + 只读浏览器节点。**
把 Armadra 的 `BrowserNode` 换成 `<webview>` + 工具栏（前进/后退/刷新/地址栏），沿用现有节点尺寸与 i18n 文案；`partition` 在创建时定一次、永不变更（探针 C）。
验收：人可以正常上网（登录一个真实站点，刷新后仍登录）；关闭并重开节点回到 `active_tab_url`；`pnpm --filter @armadra/web test` + `typecheck` 绿。

**批次 2（1–2 天）——生命周期不变量。**
实现 pool region / 顺序稳定 / `display:none` 而非卸载 / 后台 guest 上限 / 隐藏超时回收（回收时若持有租约则抑制）。
验收：切换工作空间、折叠分组、节点进出视口各走一遍，**guest 的 webContentsId 不变、页面不重载**（用一个带计数器的 fixture 页面证明）；超时回收后再访问，提示说的是「为省内存释放了」，不是权限错误。

**批次 3（2–3 天）——把驱动从 Runtime CDP 搬到 main。**
在 main 落地：guest registry（带 `getType()` 校验）、CDP 白名单（连参数校验）+ 唯一调用点的结构性测试、冻结脚本表 + `isNtScript` 恒等校验、ref 表与导航代失效。Runtime 侧保留授权与租约，改为通过窄接口下发动词。
验收：写一份 Armadra 版的「验收闸门」，至少覆盖 nodeterm 1.1/1.4/1.10 三条——能力关闭时 **attach 次数为零**；无权节点与不存在节点的拒绝文本逐字节相同；全程 CDP 监听里零条 `Runtime.evaluate`、零条 `Debugger.*`、零条带 `expression`。`cargo test -p armadra-runtime` 与新的 main 侧单测绿。

**批次 4（1–2 天）——17 个动词逐个接通 + 租约 UI。**
按 `navigate/read/click/type/wait` → `select/press/scroll` → `capture/upload/download` → `tabs/close/dialog/lease/back/forward` 的顺序接，每接一个就跑对应的 `apps/runtime/src/browser/tests/` 用例（`verbs.rs`、`tabs.rs`、`dialogs.rs`、`lease.rs`、`transfers.rs` 大多与渲染无关，应当能原样复用）。
验收：`--read` 的输出里不含 password 值、`hidden`、`aria-hidden`、`display:none` 元素（照 nodeterm 2.1 造一个六元素 fixture）；`capture` 写出的文件囚禁在工作空间内；租约徽标在人接管时立刻翻转且在途动作记为 `unknown`。

**批次 5（半天）——删除旧路径。**
删 `session/stream.rs`、`routes/stream.rs`、`session/input.rs`、`launch/*`、`cdp.rs`、前端 `stream.ts`/`Frame.tsx`/`geometry.ts`/`input.ts` 与兼容模式 iframe；同步更新 `docs/design/remote-and-browser-completion.md`、`docs/guides/architecture.md`、`docs/contracts/` 里 browser 的行，并在 `docs/status/` 记录「手机远端观看能力已移除」这一**明确的能力回退**。
验收：`pnpm check`（含 `repo:check`）与 `pnpm protocol:check` 绿；`proto/` 里 `BrowserStreamFrame`/`BrowserStreamClient` 的删除按协议流程走（不手改生成文件）。

> 一句提醒：批次 5 之前不要删任何东西。nodeterm 的 keep-alive 一节证明，webview 的生命周期陷阱只会在真机上暴露；在批次 0 和 2 的结论落地前，旧的 screencast 路径是唯一能用的回退。
