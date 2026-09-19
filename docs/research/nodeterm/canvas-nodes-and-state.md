# nodeterm 的画布、节点体系、渲染状态与持久化

> 只读调研。对象：`/Users/yovinchen/Projects/Rust/Tauri/nodeterm`（Electron + React + React Flow，
> `CLAUDE.md` 3332 行是最权威的设计说明）。目的：为 Armadra 迁移 Electron 与解决画布卡顿找答案。
> 行号读取于 nodeterm `HEAD = d76b4996`、Armadra `feature/host-protocol-foundation @ c29cf841f`。

## 结论

nodeterm 的画布本身并不比 Armadra「更聪明」：两边都用 React Flow 12、都关掉视口裁剪、都是
`nodeTypes` 模块级常量 + `React.memo`。真正的差距在**两处**。第一，nodeterm 把 React Flow 自身当作
节点的唯一活真相（`CLAUDE.md:173`），Canvas 组件只订阅「不会高频变」的切片，每一个会高频跳动的
信号（agent 状态、光标、终端输出、拖拽帧）都被刻意挡在 Canvas 的订阅之外，用模块级 store / ref /
CSS 变量绕过 React；Armadra 反过来——`canvas-store.document` 是唯一真相（`store/canvas-store.ts:42`），
**任何一次 `updateNodeData` 都换掉整个 document 对象**，于是投影、diff、React Flow 的
`adoptUserNodes` 全部按画布规模重跑一遍。第二，nodeterm 为终端建了四层内存/渲染闸门（park、
WebGL 名额、离屏释放、Eco 休眠），每层都有「这个 lever 会不会杀掉正在跑的活」的纯函数守卫；
Armadra 已有其中两层（`terminal/render-budget.ts`、`terminal/render-state.ts`），缺 park 与订阅纪律。

最高收益项（排序见 §7.3）：**把高频信号移出 `document`**、**`useFlowNodes` 不订阅整份 document**、
**拖拽/缩放期间不重投影全量**——三项都不依赖 Electron，现在就能做。持久化建议：**迁 Electron 后
仍走 Runtime SQLite，不要改成文件**（理由见 §7.4）。

## 1. CLAUDE.md 的七个章节：机制、不变量、数据、坑

### 1.1 State & persistence model（`CLAUDE.md:171-329`）

**机制。** React Flow 是节点的唯一活真相，没有第二份 store 镜像——`CLAUDE.md:173-174` 明写
「earlier dual-source designs caused sync bugs」。`src/renderer/state/workspace.ts` 只放纯函数：调色板、
节点工厂、分组变换、以及 `nodeStatesToFlow` / `flowToNodeStates` 两个序列化器。持久化分两层：
**布局+配置**（schema v3）与**活会话**（tmux）。v3 的关键是 `workspace.json` 退化为一张**索引**，
每个条目都是 ref，三种来源一种形状（`CLAUDE.md:220-224`）：

| kind | 内容真相 | 索引条目带什么 |
|---|---|---|
| folder-ref | `<cwd>/.nodeterm/project.json`（git 共享） | `cwd` + 机器本地半边 |
| ssh-ref | 服务器上同名文件 | `ssh` + 离线 `cache`，按 `rev` 对账 |
| local-data-ref | `userData/inline-projects/<id>.json` | `dataFile` + `project` 缓存 |

**不变量。** **内容与身份分离**（`CLAUDE.md:295-302`）：共享文件里没有 project `id`、`viewport`、
`defaultAccountId`、`breadcrumbs`、`closedSessions`——这些是「一个人一台机器的事实」，只能骑在索引
条目 `IndexEntryV3` 上；两个 worktree 拿到同一份提交的画布 = 两个独立项目。**低 `rev` 不得覆盖高
`rev`**、空候选不得覆盖已填充文件，且**刻意不做合并**——保证是「两个实例不会互相抹掉」，不是
「两个实例保持同步」（`CLAUDE.md:252-254`）。**绑定文件夹是一次写，所以先探测再绑定**：把临时画布
指向一个队友已提交画布的仓库，曾经直接 rev 40 → rev 1 覆盖掉（`CLAUDE.md:264-274`）。
**读失败永远不是「不存在」的证据**（全仓反复出现的第一原则）：`projectFileState` 只把确定的
ENOENT 当 absent。

**坑。** 内联画布曾经只存在于索引里一份，第二个实例共享同一 `userData` 时直接抹掉；
`.corrupt-<ts>` 旁路的文案曾经撒谎说「每个项目的画布还在各自文件夹里」。SSH 镜像曾经「自己把
.nodeterm 重置了」——一次现场报告 12 个新项目 id + 45 个孤儿 tmux 会话（`CLAUDE.md:303-314`）；
修法是原子写 + 先读比后写 + 按内容（不是只按 rev）裁决跨血缘冲突 + `recentMirrorHashes` 认出自己
刚写的字节。

### 1.2 Projects / 标签页（`CLAUDE.md:330-417`）

一个 project = 一块画布。`renderer/state/projects.ts`（zustand）存元数据 + **所有项目的序列化节点**，
React Flow 只做**当前项目**的活真相。契约：切项目前先 `commitActiveToStore()` 把活的 React Flow
节点序列化回 store 再写盘；**就地重载**（外部文件变化 / SSH 对账）置 `preserveViewportRef`，
**保留用户当前相机**——来文件里的 viewport 是别的机器最后保存的位置，恢复它会把镜头瞬移
（`CLAUDE.md:340-344`）；切走会卸载旧项目的 `TerminalNode`，tmux client 分离但会话继续
（会话名按 node id，全局唯一）。**关闭项目是非破坏性的**（`project.closed = true`，tmux 继续跑），
但「关闭」读起来像清理，所以现在会明说它停放了什么，带一个默认关闭的「顺便结束会话」勾选框
（`CLAUDE.md:374-383`）。关闭一个**节点**会留下 transcript **指针而非副本**（`CLAUDE.md:396-413`）
——`.jsonl` 归 CLI 所有，第二份文本会过期、漂移、还要自己的保留策略。

### 1.3 Node kinds（`CLAUDE.md:814-1067`）

`NodeKind`（`src/shared/types.ts`）：`terminal | sticky | group | editor | diff | video | web |
browser | files | subagent | loop | dino | trigger`。`subagent`/`loop` 是**只渲染、永不持久化**的
hook 驱动可视化；`trigger` 是一等持久化类型。逐类见 §3。三条跨类型规则值得抄：
(1) **`nodeStatesToFlow` 兼容旧数据**——缺 `kind` 默认 `terminal`，`tags:['claude']` 迁到
`data.agentId`，被删掉的 `chat` 节点就地迁成一张**墓碑便签**印着 `claude --resume <id>`。
(2) **每种类型必须在 `lib/reopenNode.ts` 里恰好落在 `UNRESTORABLE` 或某个 `buildBase` case 之一**
（`CLAUDE.md:1017-1024`）：`files` 两者都没进过，于是 ⇧⌘T 记录了一个永远恢复不出来的快照——
能编译、能过类型、能过全部测试的死条目。「已经有两种类型掉进这个坑了，把注册当成清单项。」
(3) **看板刻意不是每种都有卡**：`toKanbanSession.ts` 只映射 `browser`/`sticky`/`terminal`。

### 1.4 Canvas interaction & panels（`CLAUDE.md:2630-3054`）

`Canvas.tsx` 是 hub（13658 行）。四个要点：

- **边只有一种类型 `floating`**（`canvas/FloatingEdge.tsx` + 纯 `lib/floatingEdge.ts`）：所有家族
  （rope、上下文桥、便签链接、子代理卡片边、trigger 边）都在两节点**相对侧的中点**之间画，
  于是连到左上方的节点会走近路而不是绕过整块画布（`CLAUDE.md:2657-2667`）。
- **撤销/重做**：settle 时对 nodes 数组做**防抖快照**（整数组，不是按实体补丁），两个 ref 栈，
  按项目重置，输入框/终端内不参与（`CLAUDE.md:2671-2673`）。
- **goToNode 只在 React Flow 已经量过这个节点时才 fitView**（`CLAUDE.md:2690-2703`）：
  `getFitViewNodes` 会把未 measured 的节点滤掉，集合空 ⇒ 包围盒塌成 `{0,0,0,0}` ⇒ 相机飞到原点
  最大缩放。跨项目跳转正好总是撞上这一帧，**画布越重越容易输掉这个竞态**。修法是从**持久化尺寸**
  算同样的取景（`lib/nodeFocus.ts`），并且 measured 要读 React Flow 的 **store**（`getInternalNode`）
  ——我们自己的节点对象要晚一帧才拿到 `measured`。尺寸不可知 ⇒ **相机原地不动**，绝不退回裸 `fitView`。
- **看板打开时画布保持挂载**在不透明遮罩下——`display:none` 会把每个终端 resize 成 0×0，触发 tmux
  SIGWINCH。这条与 Armadra 关掉 `onlyRenderVisibleElements` 的理由同源。

### 1.5 Keybindings 与 Node icons

**Keybindings**（`CLAUDE.md:2526-2628`）。整个引擎**一个模块**：`src/shared/keybindings.ts`（注册表、
按命令校验、生效绑定解析、冲突检测、覆盖清洗、纯事件→命令解析器）。main / renderer / Server
Edition 都 import 它，「不要拆开——第二份副本就是三者开始各说各话的方式」。渲染进程只有**一个**
window `keydown` 监听器（在 Canvas.tsx，**冒泡相位**：改成捕获会让正在录制的快捷键先触发它要绑定
的那个命令）；主进程那份是 `main/keydown-intercept.ts` 的封闭白名单。`ShortcutsPanel` **由注册表
派生**，不是手写清单——旧面板手列 24 个 id 对着 45 条命令的注册表，⌘⇧T / ⌘⇧↵ 从没被提过。

**Node icons**（`CLAUDE.md:2435-2525`）。`data.icon` = `{type:'emoji'|'image', …}`，缺省 = 与该特性
上线前一模一样（所有失败路径的降级）。一个 `NodeIconView` 画四个列出节点的界面——「一个会话在四个
地方被看到，不能看起来像四个会话」，并按 `(projectId, absPath)` 缓存读取。三条守卫：
**两个序列化缝上都校验**（单边校验能过所有往返测试却把另一个方向敞开）；emoji 必须是**一个字素**
（`Intl.Segmenter`）、图片路径必须**看起来像图片**（这是拦住手改文件把 `fs.readBinary` 指向
`~/.ssh/id_rsa` 的门）；`isSafeRelIconPath` 在所有平台按 `[\\/]` 切分——只切 `/` 时
`./a\..\..\secret.png` 是**一个** segment，守卫全通过。图片写入前下采样到 256px 长边
（画出来只有 13–16px，而 `.nodeterm/images/` 是 git 共享的）。

### 1.6 Session memory（`CLAUDE.md:2283-2432`）——最有价值的一组测量

在一台 64 GB、95 个活 `claude` 进程的生产主机上实测：单个 `claude` 进程平均 **335 MB**、峰值
**1159 MB**，95 个占 **31.1 GB**；MCP 子进程每会话再加 30–200 MB（playwright-mcp + Chrome 单独约
200 MB），所以一棵「Claude 终端」进程树是 **440 MB – 1.2 GB**。`RssAnon` 几乎就是全部 RSS
（最大那个进程 1187 MB 里 1165 MB）；仓库不设 `NODE_OPTIONS`，V8 按系统内存定堆上限（那台机器
`heap_size_limit` 4144 MB）。**与进程年龄无关**：0–24h 平均 340 MB vs 7 天以上 326 MB——每个进程
取一个基线就再也不还。

结论同样重要：**这块内存是 agent CLI 自己的 V8 堆，nodeterm 没分配它，也不是泄漏**；产品缺的不是
分配而是**盲区**。回收器（`core/session-budget.ts`）只回收**已分离**且过宽限期的会话，所以那台机器
上它的击杀名单是**空的**（60 个会话、50 个已附着、0 个可回收，而 31 GB 就那么放着）——这个特性只
增加**视力**，不改策略。配套两条纪律：`ok:false` 不等于 `ok:true` 但没有行（面板要说「量不出来」
而不是「0 B / 0 会话」）；本地读 `/proc/<pid>/status` 而不是 `statm`（后者按**页**报 RSS，硬编码
4096 在 16 KiB 页 arm64 上少报 **4 倍**、64 KiB 页上少报 **16 倍**）。

## 2. 画布性能：nodeterm 怎么让几十个终端不卡（重点节）

### 2.1 组织方式与 nodeTypes / edgeTypes 的 memo

`src/renderer/canvas/Canvas.tsx`（13658 行）是唯一装配点，`<ReactFlow>` 在 `Canvas.tsx:12963-13064`；
周边是一堆带 `.test.ts` 的**纯决策模块**（`wheel-zoom.ts` / `wheel-gesture.ts` / `zoom-limits.ts` /
`fit-view.ts` / `collab-sync.ts` / `toKanbanSession.ts`）。这与 Armadra 的 `canvas/flow/*` +
`canvas/interaction/*` 布局几乎一一对应，**不是差距所在**。

```tsx
// Canvas.tsx:1550 / :764
const nodeTypes = useMemo(() => ({ terminal: withNodeBoundary(TerminalNode), … ,
  editor: withNodeBoundary(LazyEditorNode), diff: withNodeBoundary(LazyDiffNode) }), [])
const edgeTypes = { floating: FloatingEdge }   // 模块级常量
```

`edgeTypes` 干脆是模块级常量；`nodeTypes` 是空依赖 `useMemo`（放在组件内只因为 `withNodeBoundary`
要闭包）。Monaco 两种节点是 `LazyEditorNode`/`LazyDiffNode`（`nodes/lazyMonacoNodes.tsx`）——
**Armadra 这里没有任何 `lazy()`**，`EditorNode`/`DiffNode`/`BrowserNode` 全在首屏 chunk 里。
Armadra 对应处已经做对：`canvas/flow/nodes/node-types.ts:25` 是模块级常量，注释还写明「每渲染
一次就换一个新对象会让 React Flow 把所有节点全部卸载重建」。

### 2.2 避免整树重渲染：真正的秘诀是「Canvas 不订阅高频量」

这是 nodeterm 最值得抄的一段。`Canvas.tsx` 里反复出现同一个模式——**把任何高频信号挡在 Canvas
的订阅之外**，让代价局限在一个小组件、一个 ref 或一个 CSS 变量里。

```tsx
// Canvas.tsx:1575-1579
// Deliberately NOT `useAgentStatus((s) => s.byId)`: that map's identity changes on every
// working/waiting flip of any agent node, which re-rendered the whole canvas per hook event.
// Canvas only needs the /loop entries … so subscribe to a primitive signature that changes
// only when a loop's visible fields do; the memo below reads the actual entries via getState().
```

同一纪律的其它落点：

- **小地图自己订阅状态**（`Canvas.tsx:796-800`）：它在自己的小组件里订阅 agent status，不在 Canvas
  里——「重渲染代价被限制在这个组件内」。
- **presence 是 PERF CONTRACT**（`Canvas.tsx:1348`、`1459`）：「一个 peer 的 20 Hz 光标永远不会让
  Canvas 重渲染」，光标住在 `<ViewportPortal>` 里的 `PresenceLayer`。
- **最近关闭项目用 `useShallow`**（`Canvas.tsx:1469-1471`）：选择器每次派生新数组，没有它时「每一次
  `useProjects` 写入（每次看板提交、每次防抖保存）都会重渲整个 Canvas」。
- **确认框标志位存 ref 不存 state**（`Canvas.tsx:1491-1547`）；**分组标签反向缩放写 CSS 变量**
  （`Canvas.tsx:667-681`：「CSS does the scaling, no per-node re-render」）；**稳定空数组常量**
  （`NO_EPHEMERAL` / `NO_KANBAN_SESSIONS`）；脚本输出、快捷键、pendingLaunch 都用闭包/ref 而非
  state（`Canvas.tsx:1622`、`4652`）。

### 2.3 终端在画布缩放下怎么处理

**不切静态快照。xterm 就在 CSS transform 底下真的渲染。** 依据 `CLAUDE.md:810-812`：「A
`ResizeObserver` drives `FitAddon.fit()` + `transport.resize`. Canvas zoom is a CSS transform, so it
does *not* change `clientWidth` — cols/rows stay stable across zoom. `scale-fix.ts` patches xterm's
mouse coords so text selection stays aligned when zoomed.」即缩放**不触发任何 reflow/refit**，只是
GPU 合成，唯一要补的是鼠标坐标（`renderer/terminal/scale-fix.ts`）。仓库根目录的 `stale-frame.png`
是一张**截图证据**、不是代码机制（全仓没有 `stale-frame` 标识符）；「快照」只出现在 scrollback
冷恢复（`core/scrollback-store.ts`，按字节封顶 256 KB）与 undo 两处。真正在缩放时被节流的是
**WebGL 上下文**（下一节）与**分组标签**（§2.2 的 CSS 变量，`boost >= 2` 时切
`group-labels-compact` 类只留名字）。

### 2.4 视口外节点：不卸载，**就地降级**

RAM 计划的 Global Constraints（`2026-08-10-ram-optimization.md:23`）明令：「Do NOT touch …
`onlyRenderVisibleElements` (React Flow virtualization is explicitly out of scope — it would unmount
→ park-storm; Phase 2 achieves the same goal without unmounting).」四层闸门，触发与代价各不同：

| 层 | 触发 | 做什么 | 保留什么 |
|---|---|---|---|
| **park**（`CLAUDE.md:508-513`） | 节点卸载（切项目） | xterm 实例 + PTY 活着，`.xterm` 元素脱离 DOM；`TERM_PARK_MS` 5 分钟内重挂载直接**再收养** | tmux client 从不分离，所以鼠标跟踪/备用屏模式与 scrollback 完整带过去 |
| **WebGL 名额**（`CLAUDE.md:514-543`） | `IntersectionObserver` 只**上报**可见性给模块级协调器 `terminal/webgl-budget.ts` | 授予有 acquire 防抖；超预算时按 `hiddenAt` LRU 从**隐藏**持有者回收；全都可见时新来者**不给**，留在 DOM 渲染器 | 隐藏持有者**无限期**保留上下文，只按需回收 |
| **离屏释放**（`CLAUDE.md:482-487`、`790-804`） | 完全离屏超过 `offscreenTerminalMinutes`（默认 10） | **不卸载节点**，就地 dispose xterm + 断开 PTY client，显示占位板 | tmux 继续跑；靠近视口时热重连重绘，实测 <500 ms |
| **Eco 休眠**（`CLAUDE.md:609-629`，默认关） | hook idle=`done` + 完全离屏 + 空闲 ≥30 min + 本地 + 无活子代理 | 给 CLI 发 `/exit`，每轮最多 2 个 | tmux + shell 存活；节点显示可点的 SLEEPING 标签 |

**预算常量**（`src/shared/webgl.ts`）：`WEBGL_BUDGET` 12（浏览器版）；桌面端 main 自己把 Chromium
上限抬到 `--max-active-webgl-contexts=32`、预算抬到 24；macOS 用更低的 16 压住合成器压力。
**两个最贵的坑。** (1) **快速平移/缩小时闪 Chromium 的「lost context」白框 + 哭脸**——旧实现是每个
节点自己的 observer 各自 acquire，瞬间越过上限触发浏览器**强制驱逐**（`CLAUDE.md:520-525`）；
决策权必须收到**一个**模块级协调器手里。(2) **「切项目后字母散开一瞬」**（`CLAUDE.md:544-553`）：
`WebglAddon.dispose()` 同时也是回退 DOM 渲染器的路径，它跑在生命周期 effect 的 **cleanup** 里——
那时 React 已把元素摘掉，新的 DOM 渲染器从 `offsetWidth === 0` 的宽度缓存里推 `letter-spacing`，
每个字符烤进一整格多余宽度；`applyFit` 调 `resyncDomRendererSpacing(term)`，测量仍为 0 时**放弃**
而不是重烤一个错数。

**每一个内存 lever 都必须问「这次击杀会不会终结正在进行的工作」**（`CLAUDE.md:488-507`，纯函数
`terminal/live-work.ts`）。四个回收点当初都按「丢掉 PTY client 是免费的，tmux 还在，重连会重绘」写
——**这句话只在下面真有 tmux 时成立**。纯 shell 回退路径上（没装 tmux / 设置里关了 / `findTmux`
漏了安装路径）pty 就是 shell，同一个调用会杀掉它和它下面的一切，包括一个正在回合中的 agent CLI
（issue #126）。第五个 lever（`--after` 武装节点的离屏释放）补了同样的门。

### 2.5 拖拽时的性能策略

拖拽中**不做任何持久化**：`onNodeDragStart` 只置 `draggingRef.current = true`（`Canvas.tsx:12973`），
`onNodeDragStop` 才 flush + `markDirty()`。协作广播在拖拽中**节流到 ~20 Hz**
（`Canvas.tsx:2963-2979`：`pub.publish(states, { throttle: draggingRef.current })`），松手时立刻 flush
尾帧而不是等 trailing timer。序列化被刻意认定为「发布里贵的那一半」（`Canvas.tsx:2512`），所以按
`nodes` 的 effect 先比对再序列化，节点 id 在入口去重——「一块四十个终端的画布加载时会发布四十次」
（`Canvas.tsx:1655`）。约 120 Hz 那个 handler 的祖先链遍历单独 memo（`Canvas.tsx:3486`）。
`markDirty` 本身不 setState：「`setDirty(true)` 在已经 dirty 时是免费的」（`Canvas.tsx:2454`）。

### 2.6 RAM 优化计划里的数据（`docs/superpowers/plans/2026-08-10-ram-optimization.md`）

五个可独立发布的阶段，一个阶段一个 PR：Phase 1 隐形上限（subagent tail 每 tick 读 1 MB 封顶、
park LRU 上限）；Phase 2 离屏终端 dispose；Phase 3 core 里的内存压力响应链；Phase 4 browser/web
节点的 Memory Saver；Phase 5（opt-in）agent 休眠。阈值（`:462`、`:525-553`）：warning = 可用内存
< 总量 10% **或**自身 RSS > 4096 MB；critical = < 5% **或** RSS > 8192 MB；**读不到内存永远不算
压力**（「读失败不是证据」的同一条规则）；边沿触发，每严重级 60 s 重发下限。parked 终端的缓冲
「满了大约 16 MB，纯成本」（`:312`）。最后一条诚实记录：RTK/Headroom 之类的集成在真实语料上只省
**3.7%**，所以只写文档不做注入（`:868`）。

## 3. 节点体系（`src/renderer/nodes/`）

| 类型 | 文件 | 职责与要点 |
|---|---|---|
| terminal | `TerminalNode.tsx` | xterm + tmux。头部：折叠 / 颜色 / 点击改名 / ✦ AI 命名 / ×。body 有 **hover guard** 覆盖层，悬停 `panHoverDelay`（默认 600 ms）才把焦点交给终端——之前拖 = 移动节点，滚 = 平移画布 |
| agent | `createAgentNode(agentId,…)` | 是 terminal 的**预设**而非独立类型：`initialCommand` 跑 CLI，`data.agentId` 标记，额外行为**按 agent 能力门控** |
| sticky / group | `StickyNode.tsx` / `GroupNode.tsx` | 便签带 link handle（连到终端即作为上下文）；group 是真正的 RF 父子 frame，**可嵌套任意深度** |
| editor / diff | `EditorNode.tsx` / `DiffNode.tsx` | Monaco；editor 有 Preview/Edit 切换，图片文件跳过 Monaco 走 `<img>` |
| video / web / browser | `VideoNode.tsx` / `WebNode.tsx` / `BrowserNode.tsx` | `nt-media://` 协议 / `<webview>` / 可导航 Chromium（共享 `BrowserSurface`） |
| files | `FilesNode.tsx` | 一个目录列表钉在用它的终端旁边。**不新增任何 IPC**，全跑在既有 `FsApi` 上 |
| dino / trigger | `DinoNode.tsx` / `TriggerNode.tsx` | 小游戏 / 画布自有的定时器（cron/interval/once） |
| subagent / loop | `SubagentNode.tsx` / `LoopNode.tsx` | **只渲染、永不持久化**，hook 驱动 |

**共享外壳。** 没有一个 `NodeShell` 组件——每种节点自己画头部，共享的只有 `NodeIconView`、
`MaximizeButton.tsx`、`NodeTags` 和 `withNodeBoundary`（error boundary，`Canvas.tsx:1552`）。
Armadra 的 `nodes/NodeShell.tsx`（593 行，统一外壳 + `NODE_SHELL_SELF` 例外集合）**在这点上更好**。

**尺寸/折叠/最小化。** `settings.defaultNodeWidth/Height` 只作用于新建的 terminal/agent 节点并在
`terminalNodeSize()` 里 clamp；折叠是 `data.collapsed` + `expandedHeight`；frame 获得一个比自己大的
子节点时会**连同祖先一起重新适配**（`fitGroupToChildren` 往上走），否则 `extent:'parent'` 会把
frame 夹到一个倒置区间里（`CLAUDE.md:900-904`）。

**右键菜单**（`components/ContextMenu.tsx`，portal）。pane 右键 = 加节点 / 全选 / 适应 / Tidy canvas /
批量重启空闲 agent；节点右键 = 分组 / 颜色 / 复制 / 对齐网格 / 折叠 / markdown / 刷新终端 /
重启 agent / 删除。**非破坏性的行可被用户隐藏**（存 HIDDEN 列表），而 `lib/ui-visibility.ts` 的
`isHidden` **只回答它认识的 id**——删除、重启 agent、终端搜索和关闭**永远隐藏不掉**，不管
settings.json 写了什么。隐藏行留下的分隔线由 `tidySeparators` 清理。

**节点身份是两件不同的事。** **画布身份**：node id 就是 tmux 会话名 `nt-<nodeId>`，**永远不要改 id，
否则终端会重生**（`CLAUDE.md:787-789`）；它只保证「每次启动唯一」，而共享文件里的 node id 是跨机器
共享的——这也是两个 worktree 仍会附着同一批 tmux 会话的残留问题。**`docs/node-identity.md` 讲的不是
画布身份**，而是 **agent hook 的每节点凭证**：一台机器上所有 agent 会话共用一个 hook bearer，
它只能证明「本机的某个会话」，证明不了是**哪个**。于是加一层按节点的 capability：
`kid = base64url(HMAC(secret,"nt-node-auth-kid-v1"))[0..8]`、`mac = HMAC(secret,"nt-node-auth-v1|"+nodeId)`，
**派生而非铸造并存储**（tmux 会话比 app 活得久，重启后按 spawn 建的表对每个已在跑的会话都是空的，
且重建不出来）。三种判决不是两种：`verified` / `legacy`（「我们判断不了」，不是失败）/ `forged`
（**我们的** kid 配上不属于该节点的 mac——任何正当流程都产生不了它，一律 403，且不给解释性文案）。

## 4. 状态：renderer / main 的划分与收敛

### 4.1 renderer 侧（`src/renderer/state/`，约 60 个 zustand store）

一个信号一个 store，粒度极细，这正是 §2.2 那条纪律的前提：`agentStatus.ts`、`agentNodes.ts`、
`presence.ts`、`projects.ts`、`sessionMemory.ts`、`scmCache.ts`、`worktrees.ts`、`webviewKeepAlive.ts`、
`boardLog.ts`…（`workspace.ts` 例外——它**不是 store**，只是纯 helper 与序列化器）。**renderer 侧**：
RF 的活节点、相机、选区、拖拽草稿、park 表、WebGL 名额。**main 侧**：`core/workspace-store.ts`、
`core/settings-store.ts`、PTY/tmux、trigger service、board log、GitHub 缓存。`src/core` **不准 import
electron 或 `../main/*`**（`no-electron.test.ts` 强制），这样 Server Edition 复用同一份 core。

### 4.2 多窗口/多客户端的收敛：`src/core/canvas-sync.ts`

125 行，是**反射器**，不是 store，唯一的状态就是一个单调 `seq`（`canvas-sync.ts:9-13`：
「没有总序，两个客户端在对方 mutation 在途时编辑同一节点，会以**相反顺序**应用并永久分叉」；
`seq` 由服务端权威盖章，客户端填的值在 ingest 时被覆盖，无法伪造插队）。四条不变量：(1) **回声也发给发送者**（`reflectTargets` 把 sender 留在列表里，`canvas-sync.ts:59`）
——发送者的回声就是它的 ACK，是它唯一能知道自己这次编辑落在总序哪个位置的途径；客户端**丢弃**
回声而不是重放它（客户端那半在 `src/shared/canvas-order.ts`）。(2) **不限速**，与 presence 刻意相反
（`canvas-sync.ts:26-35`）：presence 是**采样**信号，丢一帧下一帧自愈；mutation 是**边沿**，丢一条
就是状态丢失——一个永远不出现在对端画布上的节点，或一个没落地的删除（然后被对端下一次整文件保存
写回磁盘）。合法流量本身就比任何桶都突发（拖拽 20 Hz、批量删除一个 tick N 条）。被限的是**载荷**
（`MUTATION_MAX_BYTES`）；要加预算的话**必须排队，绝不丢弃**。(3) **可执行字段在这里就剥掉**
（`shell`、`ssh.extraArgs`），每个接收者落地时再剥一次。(4) 一个进程一个计数器（不按项目）：
`seq` 只在**同一节点**的 mutation 之间比较，而 node id 全局唯一。
收敛测试在 `src/core/canvas-sync.convergence.test.ts`。

### 4.3 撤销/重做

见 §1.4：nodes 数组的防抖快照 + 两个 ref 栈，按项目重置。**刻意简单**——远端 mutation 会进快照，
所以 ⌘Z 能撤掉别人的编辑，这是 nodeterm 接受的代价。Armadra 的 `store/canvas/history.ts` 用的是
**按实体反向补丁**且远端灌入走 `history:"ignore"`（`canvas-store.ts:46-48`），**明显更好，不要往回抄。**

## 5. 持久化格式

- **workspace 索引**：`userData/workspace.json`，schema v3，全是 ref（§1.1 的表）。损坏的项目文件挪到
  `project.json.corrupt-<ts>`（**不删**）；不可读的 ref 渲染成灰色 **unavailable** 标签页，**永不丢弃**。
- **项目内容**：`<cwd>/.nodeterm/project.json`——git 共享、跨机器可移植、node cwd 写成可移植的 `./`、
  单调 `rev`。外部编辑由 `core/workspace-watcher.ts` 检测 → 静默重载，或在本地脏时弹冲突条。
- **board-log**（`src/core/board-log.ts`）：`<cwd>/.nodeterm/board-log.jsonl`，**追加写**，一行一条
  JSON，作者 = presence 身份。两个上限：`BOARD_LOG_TEXT_MAX` 16 KB（SSH 追加是**一个 printf 参数**，
  ARG_MAX 会静默吞掉它）；`MAX_BOARD_LOG_BYTES = 4 MiB` 后轮转保留一代。注释点破一个长期误解：
  `DEFAULT_CAP = 500` **从来不是淘汰**，`parseLines` 是 `reverse()` 后 `slice(0,cap)`，那是**读取上限**
  ——什么都没被删，文件在用户仓库里无界增长（`board-log.ts:22-34`）。SSH 项目的 log 至今仍无界。
- **closed-history**：`IndexEntryV3.closedSessions`，**机器本地**（session id 是 `$HOME` 锚定的事实），
  `projectToFile` 绝不写出；读回时**按字符串重新校验**——workspace.json 可手改而这个值直送解析器。
- **图片/资产**（`src/core/canvas-images.ts`）：有本地 cwd 的项目写 `<cwd>/.nodeterm/images/`，其余落
  `<userData>/canvas-images/`。刻意**不用** `core/uploads.ts`——那是终端粘贴暂存区、7 天 TTL 会扫掉，
  而画布图片节点持久化在 `project.json` 里：「拿着文件的东西，必须至少和记住它的东西一样耐久」。
- **保存失败怎么提示**（PR #657 / commit `c1aa59e5`）。两个独立的洞、一个后果：(1) `writeDisk` 里
  `await api.workspace.save(...)` 没有 catch，又被 `void persist()` 调用，拒绝（错误帧、或 ws bridge
  合成的 `E_DISCONNECTED`）被直接丢掉。(2) **更糟的是那个 rejection 杀死了重试**——防抖由 deps 为
  `[dirty, conflict, persist, resaveTick]` 的 effect 武装，失败后 `dirty` 仍为 **true**，之后每次编辑
  的 `setDirty(true)` 都是 no-op，`persist` 稳定，两个 tick 不变，effect 再也不重跑，800 ms 计时器
  再也不被安排。**一次被拒绝的保存终结了这个标签页余生的持久化。** 修法：决策移进纯函数
  `renderer/lib/savePersistence.ts`，失败后返回**退避**延迟（五次约 46 s）再进 `failed` + Retry——
  **绝不无人值守地反复捶一个已知会拒绝的目标**；`SaveFailureBar` 只说后果（画布没在磁盘上）不猜
  原因，并说明什么仍成立：**卡片不是它的 tmux 会话，终端还在跑**。

## 6. Kanban 与 GitHub Issues

**看板与画布节点的关系**（`CLAUDE.md:2867-2992`、`docs/github-issues-kanban.md`）：每项目一块整页
看板**盖在画布之上**，画布保持挂载（§1.4）。**双源**（PR #90）：SESSION 卡从画布节点**实时派生**
（`toKanbanSession.ts` 只映射 `browser`/`sticky`/`terminal`），GITHUB 卡是仓库 issue。**分配只是看板
元数据**——拖拽**从不**移动画布节点、不改分组，死节点的分配惰性清理。虚拟 **Ungrouped** 列永不
持久化、不可删改、永远第一，装下所有无分配/悬空分配的会话，所以看板永远不会开成空的。数据在
`project.kanban` 里跟着 git 共享的 `project.json` 走；唯一的形状门 `validKanban` **在每一条加载路径上**
都要跑（`fileToProject` **和** `loadV3` 的内联分支）——视图选择存在 localStorage，一次渲染抛异常会
变成启动死循环。**卡片来源是一张注册表**（`renderer/lib/kanbanSources.ts`）：声明顺序 = 过滤按钮
顺序，`lane` = 列内堆叠顺序，两者确实不同，钉住两者才能防止任一被在别处重新拼写。

**与 GitHub Issues 的同步**（`2026-08-09-github-issues-kanban-sync.md` 落地后的现状文档）：GitHub
永远是真相，issue **从不**被拷进共享的看板 assignments。每列映射**恰好一个** issue label；移到
完成列 = 关闭 issue，把已关闭的移出完成列 = 重开，两者都先确认。轮询 60 s / 请求刷新下限 30 s /
全量对账下限 2 分钟；上限 10000 issue + 64 MiB 缓存。**PR 卡是从 issue 轮询里「顺手收割」的，不是
另取**（`CLAUDE.md:2879-2890`）：`/repos/{repo}/issues` 本来就返回 PR，保留它们**零额外请求**，继承
`since` 水位、ETag 与缓存快照；替代方案实测被否（`/repos/{repo}/pulls` **忽略 `since`**，单条约
25 KB vs 约 7 KB）。溢出时**先驱逐 PR、按 updated 最旧优先**。

## 7. 对 Armadra 的映射

### 7.1 结构对照
| 关注点 | nodeterm | Armadra |
|---|---|---|
| 内存真相 | **React Flow 本身**（`CLAUDE.md:173`） | **`canvas-store.document`**，RF 是受控视图（`store/canvas-store.ts:42`） |
| 节点注册 | `nodeTypes` 每种一个 RF 类型（`Canvas.tsx:1550`） | **一种 `armadra` 类型装七种节点体**（`canvas/flow/nodes/node-types.ts:25` + `nodes/registry.ts`） |
| 共享外壳 | 无，各画各的头 | `nodes/NodeShell.tsx`（593 行）+ `NODE_SHELL_SELF` 例外 |
| 状态切片 | 约 60 个细粒度 zustand store | 一个大 store 拆 6 个 slice（`store/canvas/*.ts`），**同一个 `document` 对象** |
| 投影 | 不存在（RF 直接持有） | `canvas/sync/project.ts:73-107` 的按对象身份缓存 `reuse()` |
| 拖拽草稿 | `draggingRef` + 20 Hz 节流广播 | `canvas/flow/drafts.ts` 模块级 Map + `useSyncExternalStore`（**比 nodeterm 干净**） |
| 撤销 | nodes 数组防抖快照 | 按实体反向补丁 + 远端灌入 `history:"ignore"`（**比 nodeterm 好**） |
| 多端收敛 | `core/canvas-sync.ts` 的 `seq` 总序反射器 | 保存时 409 → `replayLocalEdits` 变基（`save/canvas-save-queue.ts:49`） |
| 持久化 | 文件：`workspace.json` 索引 + `.nodeterm/project.json` | Runtime SQLite，整份 `PUT …/document` 带 CAS |
| 视口裁剪 | 关（RAM 计划明令禁止开） | 关（`FlowWorkspace.tsx:418`，理由相同：xterm fit 会量到 0×0） |
| WebGL 预算 | `terminal/webgl-budget.ts`，桌面 24 / mac 16 | `terminal/render-budget.ts`，上限 24（**已有**） |
| 离屏降级 | 离屏 dispose + park + Eco 休眠 | `terminal/render-state.ts` 五态 + 500 ms 批量写 + 60 s 后台 detach（**已有，缺 park**） |
| Monaco/重组件懒加载 | `nodes/lazyMonacoNodes.tsx` | **无 `lazy()`**，全在首屏 chunk |

### 7.2 Armadra 卡顿最可能的来源（依据代码，不是猜测）

1. **`useFlowNodes` 订阅整个 `document`**（`canvas/flow/use-flow-nodes.ts:107`
   `useCanvasStore((state) => state.document)`，`:127-134` 的 `projectNodes` memo 以它为依赖），
   而 `updateNodeData` 一定返回 `{ ...document, nodes }`（`store/canvas/nodes.ts:106-122`）。
   于是**任何一个节点的任何一次数据更新**都会：换 document → 重跑 `projectNodes` 遍历全部节点 →
   产生新数组 → React Flow `adoptUserNodes` 重建 lookup → `CanvasOverlays` 的 `boxes` memo
   （`overlays/CanvasOverlays.tsx:46-60`）重算全部包围盒。身份缓存救了**节点体**的重渲，
   救不了这三段 O(n)。
2. **高频信号走的就是这条路**：`nodes/StickyNode.tsx:31` 每次输入都 `updateNodeData`；
   `terminal/surface/use-session.ts:73`、`use-transport.ts:137`、`agent/pending-launch.ts:129`
   都在会话状态跳动时写 document。每次还额外付一次 `diffSnapshots`（`store/canvas/internal.ts:69-90`：
   `commit()` 对四张表建 `Map` 索引——**索引本身是 O(n)**，哪怕差分只有一条）。
3. **没有一个「Canvas 不订阅高频量」的纪律**：这条规则在 nodeterm 里出现至少 8 次（§2.2），
   而 Armadra 的 `FlowWorkspace.tsx:186` 直接 `useCanvasStore((state) => state.document)`。
4. **实测基线的局限**（`docs/design/canvas-react-flow.md:706-720`）：30 节点 + 300 墨迹在 Chrome 152
   下空闲 120 fps、平移 112 fps、拖节点 108 fps，看起来很好——但文档自己注明**「这一轮的 30 个终端
   节点没有会话」**。用户报的卡顿正是活会话场景，也就是上面 1–3 条发威的场景。

### 7.3 可以直接借鉴的性能手段（按收益排序）

1. **把高频信号移出 `document`，另起薄 store。** 会话状态、连接状态、pendingLaunch、agent 忙闲
   都不该进 `commit()`；照抄 `Canvas.tsx:1575-1579`：投影层只订阅一个**原始签名**，真正的条目用
   `getState()` 读。收益最大，改动集中在 §7.2 列出的那几个 `updateNodeData` 调用点。
2. **`useFlowNodes` 改成不订阅整份 document**：让 `projectNodes` 只在 nodes/edges 数组**引用**变化时
   重算，并把 `selected` 移出投影输入（RF 有自己的 `selected` 通道）——现在一次点选就要重投影全部。
3. **便签输入改成本地 state + 失焦/防抖提交**：一次击键换一份 document 是最便宜可摘的果子。
4. **给 Monaco / Browser / Diff 节点体加 `React.lazy`**，对齐 `nodes/lazyMonacoNodes.tsx`。省的是
   首屏解析与内存而非帧率，但成本几乎为零。
5. **加一层 park**：Armadra 已有 render-state 五态与 render-budget，缺的是「节点真的卸载时 xterm
   实例 + 连接活着等待重收养」，迁 Electron 后多窗口切换会放大这个缺口。照抄 `TERM_PARK_MS`
   5 分钟 + LRU 上限 + `live-work.ts` 那道「这次回收会不会杀掉正在跑的活」的门。
6. **分组标签/徽章的反向缩放改 CSS 变量**（`Canvas.tsx:667-681`），不要每节点重渲。
7. **`CanvasOverlays.boxes` 按需算**：现在随 `document.nodes` 全量重建 Map，而派生边通常个位数。
8. **协作广播节流 20 Hz + 松手 flush 尾帧**（`Canvas.tsx:2963-2979`），若后续加多窗口实时同步。

**不要抄的**：nodeterm 的「React Flow 即真相」（Armadra 的单向投影更可控，AGENTS.md 也要求画布
修改经 canvas-store 动作）、nodes 数组防抖快照式撤销、`Canvas.tsx` 13658 行的单文件装配。

### 7.4 迁 Electron 后持久化要不要改成文件？

**建议：不改，继续走 Runtime SQLite。** 四条理由：

1. **AGENTS.md 的两条硬性约束正好指向 SQLite 的优势**——「数据库新增编号迁移；已发布迁移不得修改」
   「未知或损坏的数据库拒绝启动，禁止自动清库或重建」。`apps/runtime/migrations/` 已有 14 个编号迁移；
   换成文件等于把这套已验证的 schema 演进与拒绝启动语义整个扔掉，然后在 JSON 层重新发明 nodeterm
   用三次大重构才稳住的东西（v3 索引、rev 规则、`.corrupt-<ts>` 旁路、SSH 镜像对账）。
2. **nodeterm 选文件是被部署形态逼的**，不是因为文件更好：它要 git 共享画布给队友、要让 SSH 项目把
   同一份文件放在远端主机、要让 Server Edition 与桌面共用一个 store。Armadra 目前都没有这三个需求。
3. **Armadra 已经有 SQLite 才好做的东西**：整份 `PUT …/document` 带 CAS（`board.updatedAt`），409 →
   `replayLocalEdits` 自动变基（`save/canvas-save-queue.ts:16-45`）。文件方案的等价物是 nodeterm 那条
   「低 rev 不得覆盖高 rev，且**刻意不合并**」，比 Armadra 现在的能力**更弱**。
4. **Electron 迁移不改变这一层**：两种壳对 Runtime 都只是宿主进程，持久化路径（前端 → Runtime
   HTTP/WS → SQLite）一行不用动。把两件高风险的事捆一起做，出问题时无法二分定位。

**但要从 nodeterm 抄两件事**（都不需要换存储）：**(a) 保存失败必须说话并退避重试**（§5 的 PR #657）
——Armadra `save/autosave.ts` 有 `saveState`/`saveError` 与 409 变基，需逐条核对是否存在同型缺陷：
**失败后 `saveState` 停在非 `dirty` 的终态时，后续编辑的 `dirty` 置位能否重新武装防抖**；nodeterm
的教训是这个 bug 能让一个标签页余生都不再落盘且屏幕上什么都不显示。**(b) 资产耐久性规则**
（`canvas-images.ts:1-16`）：拿着字节的地方必须至少和记住它的地方一样耐久，`.armadra/assets/` 同理。

## 8. 建议的实施批次

每批独立可发布、独立可回退；验收沿用 `docs/design/canvas-react-flow.md:706` 的压力脚本，但**必须
补上「30 个活会话」这一列**——现有基线没有会话，测不出用户报的卡顿。

| 批次 | 内容 | 验收 |
|---|---|---|
| **P0 基线** | 补一个带活会话的压力场景：30 个终端节点 + 真实会话，记录空闲/平移/拖拽三段的 fps、p95、最慢帧、JS 堆；用 React DevTools Profiler 记录一次 agent 状态跳动引发的重渲组件数 | 有可复跑脚本与基线表落在 `docs/status/`；能指出一次状态跳动当前重渲多少组件 |
| **P1 高频信号出 document** | §7.3-1：会话状态、连接状态、pendingLaunch、agent 忙闲移到独立薄 store，Canvas/投影只订阅原始签名 | 同一次状态跳动的重渲组件数下降一个数量级；`pnpm --filter @armadra/web test` 全绿；P0 场景平移 fps 不退 |
| **P2 投影订阅收窄** | §7.3-2/7：`useFlowNodes` 不订阅整份 document；`selected` 移出投影输入；`CanvasOverlays.boxes` 按需算 | 拖拽一个节点时 `projectNodes` 的调用次数与节点数解耦（加临时计数器验证）；拖拽段 p95 改善；`canvas/sync/project.test.ts` 与 `use-flow-nodes` 相关测试补覆盖 |
| **P3 输入路径** | §7.3-3：便签/改名等文本输入改本地 state + 防抖提交；顺带审一遍所有 `updateNodeData` 调用点的频率 | 连续输入 100 字符期间 `commit()` 调用次数 ≤ 5；撤销栈里是一条而不是 100 条 |
| **P4 懒加载与 park** | §7.3-4/5：Monaco/Browser/Diff 节点体 `React.lazy`；终端 park（5 分钟窗口 + LRU 上限 + `live-work` 式守卫） | 首屏 chunk 体积下降（记录前后数值）；切画布往返 5 分钟内终端**瞬时恢复**且 pane pid 不变；纯 shell 回退路径下 park 到期**不杀**正在跑的进程（单测钉死） |
| **P5 保存健壮性** | §7.4 的两件事：保存失败的退避 + Retry + 明确文案；资产耐久性审查 | 注入一次 Runtime 拒绝，验证：屏幕上有提示、退避后自动重试、成功后指示灯回到「已保存」、**且后续编辑仍能触发保存**（这是 PR #657 的核心回归） |
| **P6 Electron 壳** | 换壳，持久化路径不动 | 打包产物里画布可用；P0 脚本在 Electron 壳里复跑，与 Chrome 的数字并列记录（对照 `docs/design/canvas-react-flow.md:698` 的打包验证口径） |

P1–P3 是收益主体且不依赖换壳，**建议先做完再动 Electron**：否则换壳后若仍卡，无法区分是壳的问题
还是画布的问题。
