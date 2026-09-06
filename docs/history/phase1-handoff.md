# Phase 1 交接记录（tldraw 计划 §8 Phase 1）

> 四个并行 agent 的跨归属请求都写在这里，收尾时由主会话统一处理。
> 规则：**只在自己归属的文件里改**；需要别人的文件改动时，在自己的小节下写一条
> 「需要 <owner> 在 <文件> 做 <改动>」，然后在自己这边用最小的绕过方案继续。

## canvas-core（canvas/ + store/ + save/）

已完成（2026-09-04）。`CanvasWorkspace` / `FloatingEdge` / `RopeEdge` /
`shared/canvas-adapter.ts` 已删除；`apps/web/src` 全树 `@xyflow/react` = 0。

### 1. 投影与派生（`canvas/sync/`）

四个纯函数模块 + 一个 hook。**tldraw store 是内存真相**，`canvas-store.document`
由它派生。

| 文件                | 内容                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `project.ts`        | `nodeToShape` / `edgeToArrow` / `toBindingId` / `edgeArrowheads` / `toTldrawColor` / `DEFAULT_PAGE_ID` |
| `derive.ts`         | `shapeToNode` / `arrowToEdge` / `deriveNodes` / `deriveEdges`                                          |
| `snapshot.ts`       | `stripDocumentRecords` / `serializeWhiteboard` / `parseWhiteboard`                                     |
| `pushed.ts`         | 「这份文档已经在 editor 里了」的标记，见第 2 节                                                        |
| `use-store-sync.ts` | `useStoreSync(editor, { onCameraChange, onBoardLoaded })` + `captureWhiteboard(editor)`                |

约定（反向映射逐条对上）：

- 节点 `<uuid>` ↔ shape `shape:<uuid>`，边同理；不查表。
- 分组 = 原生 `frame`。`TLFrameShapeProps` 只有 `w/h/name/color`，装不下标签 /
  批注 / 折叠 / `createdAt`，所以这些放 **`frame.meta.armadra`**；`color` 是有损映射
  （十六进制 → tldraw 颜色名），原值同时写在 meta 里，派生时优先读 meta。
- 组员的 `x/y` 相对父 frame，与文档一致，`parentId` = `shape:<组 uuid>`。
- 边的时间戳与 `kind` 放在 **`arrow.meta.armadra`**（arrow 的 props 里没地方放）。
- `arrowToEdge` 只在两端 binding 都指向 **uuid 形状的 shape id** 时才产出 edge，
  否则回 null（白板箭头）。
- **退役类型 `draw` / `image`**（§4.5，Phase 3 才迁移）：`ArmadraProps.nodeType` 不接受
  它们，所以投影成一个 `nodeType: "sticky"` 的占位壳，**原节点整份 JSON 塞进
  `shape.meta.legacy`**，派生时原样取回，只让位置 / 尺寸 / 父级 / 标题 / 颜色 /
  折叠这几项覆盖回去。一个字节都不丢，也不会写脏 `data`。

`deriveNodes` / `deriveEdges` 会**复用没变的那份对象**（比较时忽略 `updatedAt`），
所以相机移动、选中变化、拖拽中的空改动都不会把看板置脏。

### 2. 双向同步的防抖环（`use-store-sync.ts`）

- **editor → 文档**：`store.listen({ scope: "document" })` → 微任务合并 → 重新派生。
  `entry.source === "user"` 才置 dirty，`mergeRemoteChanges` 里的改动不置（§10）。
- **文档 → editor**：只在 `state.document` **不是**上一次由同步层写出去的那个对象时
  才投影。换看板（`board.id` 变）走 `load()`：`loadSnapshot(白板)` →
  `mergeRemoteChanges(push)` → `clearHistory()`；同一块板走增量 `push()`。
- `store` 的每个动作都**写两处**：先照旧改 `document`（45 个消费方要求「调完就能
  读到」），再把同一件事做到 editor 上，然后 `markPushed(document)` 登记一下。
  漏登记只会多做一次幂等投影，不会出错。
- 选中态：`react()` 订阅 `getSelectedShapeIds()` → `selectNodes()`；反向的
  `selectNodes` 只在内容真的不同时才 `editor.select`，避免 React Flow 时代那个
  「慢一拍互相触发」的死循环。
- 相机：`react()` 订阅 → `TldrawWorkspace` 节流 300ms → `setViewport`。
  tldraw 的相机是**页面坐标的平移量**，文档存的是**屏幕像素**，差一个 `z`：
  `viewport.x = camera.x * camera.z`。

### 3. `store/canvas-store.ts`

`CanvasActions` 全部签名不变，新增 `setWhiteboard(snapshot)`。

- **`history` 字段与 `HISTORY_LIMIT` 已删除**，`undo/redo` 转调 `editor.undo()/redo()`；
  `useCanUndo/useCanRedo` 改成订阅 `editor.store.listen` 读 `getCanUndo/getCanRedo`
  （用 `useSyncExternalStore` 而不是 tldraw 的 `useValue`：Dock / 命令面板在
  `<Tldraw>` 子树外，那里没有 editor 上下文）。
- 所有动作都包在 `editor.run()` 里 —— 一次动作 = 一条撤销记录。
- `removeNodes` 删 frame 前先把子级 `reparentShapes` 到页面（「删组不删组员」）。
- `duplicateNodes` 自己生成 uuid 建 shape，**不用** `editor.duplicateShapes`：
  后者给的是随机 id，派生出来的节点 id 过不了 zod 的 uuid 校验。
- editor 为 null（启动页、单测）时动作只改 `document`，行为与 v3 一致。

### 4. `TldrawWorkspace.tsx`

装配 + 命令表 + 右键菜单 + 删除确认 + 锁定 + 视口。要点：

- `components` 里 **`NavigationPanel` / `Minimap` / `StylePanel` 没有置空**（按 shell
  的要求），`OnTheCanvas: CanvasOverlays`。`Background` / `Grid` 也没接管。
- 右键：tldraw 的 `ContextMenu` 槽已置空，改由容器上的 Radix `ContextMenuTrigger`
  接；命中哪个节点用 `editor.getShapeAtPoint(page, { hitInside, hitFrameInside })`
  自己问（React Flow 的 `onNodeContextMenu` 没有对应物）。
- 「锁定视图」只锁相机（`setCameraOptions({ isLocked })`）。**不要**用
  `updateInstanceState({ isReadonly })`：5.4 的 `isReadonly` 是从编辑器 `mode`
  派生的，外面写会被下一次派生覆盖。
- `canvas.fitView` 与「整理后 fitView」都走 `zoomToBounds(bounds, { targetZoom: 1 })`
  ——与 Dock 的「适应」同一套算法（§20「只缩小不放大」）。`zoomToFit` 的 TS 签名
  里没有 `targetZoom`，所以自己算包围盒。
- `canvas.zoomIn/zoomOut/zoom100` = `editor.zoomIn/zoomOut/resetZoom`。
- `canvas.delete` / `closeNode` 先看选中项里有没有活着的会话：有就弹
  `delete.session.title` 确认框，确认后 `terminateTerminal` 再删。
- `CENTER_NODE_EVENT` → `getShapePageBounds` + `centerOnPoint`，缩放不低于 60%。

### 5. 自动保存与白板（`save/autosave.ts`）

白板快照**只在保存那一刻**序列化（`captureWhiteboard(getEditor())`）：一次拖拽会
产生几十条 store 事件，每条都全量 `JSON.stringify` 整个 store 太贵。派生层只负责
记「白板记录动过了」并置 dirty。

超过 `MAX_WHITEBOARD_BYTES` → `saveState: "error"` + `saveError: t("canvas.whiteboardTooLarge")`，
这一轮不发 PUT。序列化结果**就地写回 store**（不换新对象再交给队列）——保存队列
按文档对象身份判断「保存途中有没有又改过」，换对象会让保存永不收敛。

### 6. 覆盖层（`canvas/overlays/CanvasOverlays.tsx`）

rope 与子代理卡片迁到 `components.OnTheCanvas`（`.tl-html-layer` 里，坐标**就是
页面坐标**）。`derived-edges.ts` 与 `SubagentLayer.tsx` 去掉了 React Flow 的
`Edge` / `Node` 类型，改成纯数据（`DerivedEdge` / `SubagentPlacement`）；贝塞尔路径
改用 `geometry.bezierPath()`（替代 `getBezierPath`）。位置取自 `document`（它本身
就是 shape 的派生），不是每帧问 `getShapePageBounds`。
**遗留 TODO(Phase 2)**：等待中的 `⏳` 标签没搬过来，先只有虚线流动。

### 7. 其它

- `canvas/dnd/os-drop.ts` 改用 `editor-context.screenToPage`，Phase 1 行为不变
  （图片 → `image` 节点）。
- `canvas/context-links.ts` **一个字没改**：它本来就只做节点部分，`kind:"shape"`
  是 Phase 4。
- `canvas/connection.ts`（`isValidLink`）暂时没有调用点：`addEdge` 自己做了自连 /
  重复校验。留着给 Phase 2 的 `LinkArrow` 绑定守卫用。
- `geometry.ts` / `viewport.ts` / `zoom.ts` 仍是纯函数；`geometry.ts` 新增
  `bezierPath()`。`zoom.ts` 的 `MIN_ZOOM/MAX_ZOOM` 现在喂给 `TLCameraOptions.zoomSteps`。

### 我改过的非归属文件（都很小，请核对）

1. **`src/i18n/canvas.ts`**：新增一个键 `canvas.whiteboardTooLarge`（zh + en），
   白板超限时的保存失败提示。
2. **`packages/shared/src/index.ts`**：删掉 `export * from "./canvas-adapter.js"`。
3. **`packages/shared/test/domain.test.ts`**：删掉 `describe("react flow projection")`
   整块与两个 import（`projectNode` / `projectEdge` 随 `canvas-adapter.ts` 一起没了）。
   `pnpm --filter @armadra/shared build && test` 已重跑，63 个用例全绿。
4. **`src/canvas/tidy.test.ts` / `src/canvas/geometry.test.ts` / `src/save/autosave.test.ts`**
   （这三个本来就归我）的 `vi.mock("../nodes/registry")` 补了 `nodeMeta` 导出 ——
   nodes agent 把 `NODE_META[type]` 换成访问器之后必须的。

### 需要别人做的

1. **nodes**：`ArmadraProps.nodeType` 不接受 `draw` / `image`，所以旧看板里这两种节点
   现在渲染成**只有标题的便签壳**（数据完整保存在 `meta.legacy`）。如果 Phase 3
   之前想让它们还能看，需要 `ArmadraShapeUtil` 支持从 `meta.legacy` 读原 `data` 渲染；
   不想做也行，Phase 3 会把它们迁成原生 shape。
2. **shell**：Dock 的「适应」现在可以直接 `runCanvasCommand("canvas.fitView")` ——
   我这边已经改成和你一样的 `zoomToBounds(..., { targetZoom: 1 })`，两处行为一致。
3. **Phase 2 / edges**：`sync/snapshot.ts` 的 `stripDocumentRecords` 目前会把
   **所有指向节点 shape 的 binding** 都剔掉。Phase 1 没有白板工具所以不会出现
   「一端绑节点、一端绑白板 shape」的箭头；Phase 4 做 §6.3 的内容链接时要重新想：
   那条 binding 留在快照里会在 `loadSnapshot` 时指向还不存在的节点 shape。
   建议的做法是加载顺序反过来（先投影节点、再合并白板快照）。
4. **收尾**：`canvas/poc/` 整个目录还在（`App.tsx` 已经不引用了），按 §8 删掉。
   `apps/web/package.json` 的 `@xyflow/react` 与 `vite.config.ts` 的 `xyflow` 分组同上。

### 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：**整仓零错误**。
- `pnpm --filter @armadra/web test`：**54 个文件 550 个用例全绿**
  （新增 `sync/project.test.ts` 10 个、`sync/snapshot.test.ts` 7 个；
  `canvas-store.test.ts` 47 个用例保留，撤销那一组改成断言「转调 editor」与
  「画布没挂载时是安全空操作」）。
- `pnpm --filter @armadra/shared test`：63 个用例全绿。
- 浏览器 `http://localhost:1422`（自己的 tab；Browser 面板大半时间是隐藏的，
  所以用 DOM + `await import('/src/canvas/editor-context.ts')` 拿到真 editor 来验）：
  1. 右键空白 → 添加菜单 → 新建便签：`armadra` shape 出现在右键落点，`NodeShell` 正常渲染。
  2. 自动保存：PUT 200，Runtime 侧 `nodes` 多一行，`board.whiteboard` = 1137 B，
     里面**只有** `document:document` / `page:page` / `user:*`，**没有任何 shape / binding**。
  3. 刷新页面：5 个节点（含一个跑着 opencode 的真实终端，`.xterm` 挂载正常）全部回来，
     Dock 显示 76% —— 视口按库里存的 `{x:44, y:47.9, zoom:0.757}` 精确恢复，
     且回写后数值一模一样（相机 ↔ 视口的 `×z` 换算没有漂移）。
  4. 会话侧栏点一行 → 相机居中到那个终端节点、缩放提到 60%（`CENTER_NODE_EVENT` 通路）。
  5. `⌘1` 适应视图、Dock 的 100% 都生效。
  6. `editor.updateShapes` 把一个节点挪到 `(4321, 1234)` → 1.5 s 后 Runtime 侧的
     `nodes` 行就是 `(4321, 1234)`（editor → 派生 → store → autosave → PUT 全链路）。
  7. `edgeToArrow` 造一条两端绑定的 arrow → Runtime 侧 `edges` 多一行
     `source → target`，且**白板快照里没有这条 arrow 和它的两个 binding**。
  8. Dock 撤销 → arrow 消失，Runtime 侧 `edges` 回到 0（`editor.undo()` → 派生 → 保存）。
  9. 删除三个测试节点 → Runtime 侧同步删除，另一个 agent 的两个节点原样保留。
- **没验到的**：拖头部移动 / resize / 折叠 / 最大化的**真实鼠标**路径。Browser 面板
  隐藏时 `computer` 的 `left_click_drag` 需要截图基准、`requestAnimationFrame` 不回调，
  合成 pointer 事件在 `setPointerCapture` 上会抛 `NotFoundError`。但
  `editor.updateShapes` 那条链路（第 6 项）已经证明「shape 变 → 文档变 → 落库」是通的，
  而「指针能不能进 tldraw」nodes agent 在 §nodes 的验证记录里单独验过。
  面板能显示之后请补这三项手工检查。

## nodes（canvas/shapes/ + nodes/）

已完成（2026-09-04）。`nodes/` 与 `canvas/shapes/` 里再没有一行 `@xyflow/react`。

### 1. `ArmadraShapeUtil`（`canvas/shapes/ArmadraShapeUtil.tsx`）

`component()` 现在渲染真节点：`NODE_SHELL_SELF` 里的类型（终端 / 编辑器 / 变更 /
文件 / 浏览器）自己渲染 `NodeShell`，其余（便签）由 `ArmadraShapeUtil` 包壳。

- `props` 校验器与 `armadra-shape.ts` 的签名一个字没动。
- 新增导出 `shapeToCanvasNode(shape, stored?)`：**以 shape 为准**组装
  `CanvasNode`，只有 `boardId` / `parentId` / `updatedAt` 从画布 store 的那份取
  （shape 里没有这三样）。canvas-core 的 `derive.ts` 要自己那份就照旧，两边不共用。
- 选中态从 editor 读（`useValue` + `getSelectedShapeIds`），不读 store——store 是
  投影，慢一拍。`focusNodeId` 仍读 store。
- `canCull=false`、`canEdit=false`、`hideRotateHandle=true`、
  `hideSelectionBoundsFg=true`、**`hideResizeHandles=false`**。
  5.4 的 `SelectionForegroundOverlayUtil` 里 `showResizeHandles` 与
  `shouldDisplayBox` 是两个独立开关，所以「藏掉选择框、留下把手」成立：
  选中环由 `NodeShell` 自己画。
- `onResize` 按 `NODE_META[nodeType].minSize` 夹住；折叠时 `h` 钉死
  `COLLAPSED_HEIGHT` 且 `y` 回写成原值 —— 纵向 resize 被禁掉。

### 2. `NodeShell`（`nodes/NodeShell.tsx`）

- 删掉 `NodeResizer` / `Handle` / `Position` / `useStore`，以及 React Flow 的两个
  入口 `CanvasNodeRenderer` / `GroupNodeRenderer`。
- 最大化矩形改成导出的纯函数 `maximizeRect()`：`getEditor()` →
  `getViewportPageBounds()`，24px 屏幕边距除以 `getZoomLevel()` 再内缩。
  画布没挂载时回 1×1（单测、启动瞬间不抛）。
- 节点体守卫按 Phase 0 结论 2 落在 `[data-slot="node-body"]` 上：指针用 React
  合成事件 `stopPropagation`，滚轮用原生监听分两相。**只有这一处**，
  `NODE_SHELL_SELF` 的类型也走它。
- 头部 `onPointerDown` 只在 `button/input/textarea/select/[role=textbox]/
[contenteditable]/[data-no-drag=true]` 上停止冒泡，其余放行给 select 工具拖动。
  这是 `nodrag` 类的替代品：**`nodrag` / `nowheel` 已从 `nodes/` 全部删除**，
  它们现在只是残留在 `terminal/TerminalSurface.tsx` 与 `meta/NodeMeta.tsx` 里的
  惰性类名（没有任何规则命中，删不删随意）。

### 3. `ConnectionHandles`（`canvas/shapes/ConnectionHandles.tsx`，新增）

左右两个 10px 圆点。按下 → `editor.setCurrentTool("arrow")` 并**放行**这次
pointerdown：5.4 的 `useCanvasEvents` 把所有指针事件都挂在 `.tl-canvas` 上且一律
`target: "canvas"`，冒泡到那里时当前工具已经是箭头，箭头就在指针位置起笔——
不需要自己合成 `editor.dispatch`，也不用猜它的坐标系。`pointerup` / `pointercancel`
回 select。样式从 `canvas.css` 的 `.react-flow__handle` 搬到 `styles/nodes.css` 的
`.node-connection-handle`。绑定合法性是 Phase 2 `LinkArrow` 的事，把手只管起笔。

### 4. `registry.ts`

- 新增 `ActiveNodeType = Exclude<CanvasNodeType, "draw"|"image">` 与
  `ACTIVE_NODE_TYPES`；`NODE_META` / `NODE_BODY` 的键类型改成它。
- `nodeMeta(type: CanvasNodeType)` / `defaultNodeSize` / `minNodeSize` 对
  `draw` / `image` 返回一份只读的兜底元数据（旧尺寸与图标原样保留），
  新增 `isActiveNodeType(type)`。
- 删除 `DrawNode.tsx(+test)` / `ImageNode.tsx` / `GroupNode.tsx`；
  `NODE_BODY.group` 现在是 registry 里的一个 `() => null`（分组是原生 frame，
  留这个键只为让「漏登记新类型」仍然是编译错误）。
- `nodes/index.ts` 同步：不再导出 `CanvasNodeRenderer` / `GroupNodeRenderer` /
  `DrawNode` 那一组，新增 `maximizeRect` / `ActiveNodeType` / `nodeMeta` 等。
- `styles/nodes.css` 删掉 `.draw-surface`。

### 需要别人做的

1. **canvas-core / `src/store/defaults.ts`（4 处，唯一由我引起的 typecheck 失败）**：
   `NODE_META[type]` 改成 `nodeMeta(type)`（第 24 / 28 / 32 / 42 行）。
   `NODE_META` 现在只覆盖在用的 7 种类型，退役类型走访问器。
   我这边的绕过方案就是把访问器准备好，没法在不改你文件的前提下修掉。
2. **canvas-core / `src/canvas/CanvasWorkspace.tsx` 与 `CanvasWorkspace.test.tsx`**：
   `CanvasNodeRenderer` 没了（React Flow 的 `nodeTypes` 入口不再存在）。
   `App.tsx` 已经切到 `TldrawWorkspace`，这两个文件按 §7 直接删掉即可。
3. **canvas-core / 投影**：`TldrawWorkspace` 还没把 `nodes/edges` 投影成 shape，
   所以画布上目前一个节点都没有。`ArmadraShapeUtil` 已经能吃 `ArmadraProps`——
   `sync/project.ts` 的 `nodeToShape` 按 `armadra-shape.ts` 的 `ArmadraProps` 填就行
   （`expandedHeight` 用 `0` 表示「没记过」，不要 undefined）。
4. **canvas-core / `store/canvas-store.ts`**：`setCollapsed` / `maximizeNode` /
   `resizeNode` 还没驱动 editor，所以头部的折叠 / 最大化按钮点了没反应
   （store 变了，shape 没变）。我这边的按钮调用签名一个没改。
5. **shell / `src/app/test-harness.tsx`**：`installDomPolyfills` 里建议补一条
   `window.matchMedia` 的 stub —— `tldraw` 在模块加载时就读它，任何 import 到
   tldraw 的单测都会炸。我在 `ArmadraShapeUtil.test.ts` 里用 `vi.hoisted` 自己补了
   一份，补进 harness 之后可以删掉。

### 验证记录（2026-09-04）

`pnpm --filter @armadra/web test`：`nodes/` + `canvas/shapes/` 共 **50 个
用例全绿**（registry 9、NodeShell 16、ArmadraShapeUtil 10、ConnectionHandles 3、
FilesNode 8、StickyNode 4；DrawNode 的 3 个随文件删除）。typecheck 在我的文件里
零错误。

浏览器（`http://localhost:1422`，Browser 面板隐藏，所以和 Phase 0 一样用 DOM +
`editor.dispatch` 代替截图）：

- 便签 / 编辑器 / 浏览器 / 变更 / 文件五种 armadra shape 都渲染出
  `node-header + node-body` 两行、头部 32px 一行、左右各一个把手，控制台无报错。
- shape 尺寸与 `props.w/h` 一致；`editor.dispatch` 的 pointer_down 能命中几何、
  正确选中。
- 体内 pointerdown **不**冒出节点（document 收不到），头部空白处冒得出去，
  头部按钮又挡住 —— 三种情况分别是 0 / 1 / 0。
- 滚轮两相：从终端体内层元素发普通滚轮，深层监听（tmux 桥的替身）收到、
  `.tl-canvas` 收不到；⌘+滚轮反过来 —— 深层监听收不到、`.tl-canvas` 收到一份
  `metaKey=true` 的转发。与 Phase 0 结论 2 一致。
- `editor.resizeShape` 缩到 5%：便签夹到 160×120（`NODE_META.sticky.minSize`）；
  放大到 2 倍：480×400；折叠态拉 5 倍高：`h` 仍是 40、`y` 不变、宽度照常跟随。
- 把手 pointerdown → 当前工具 `select → arrow`，`pointerup` → 回 `select`；
  把手 10×10、静默 opacity 0.4。

**没能在浏览器里验的两项**（面板隐藏时 `requestAnimationFrame` 不回调，tldraw 的
wheel / pointer_move 分发与选择框叠加层都挂在 tick 上）：
① 拖头部真的把 shape 拖走 —— 只验到 pointerdown 确实进了 tldraw 的 canvas 处理器
（合成事件在 `setPointerCapture` 上抛 `NotFoundError`，是测试手法的限制不是产品问题）；
② resize 把手 / 旋转把手的**视觉**，5.4 把它们画在叠加层画布上。
单测已经钉住 `hideResizeHandles()===false`、`hideRotateHandle()===true`。
面板能显示之后请补这两项手工检查，连同 §18.4 的终端清单（我没在真实终端节点上跑，
避免在用户工作区留下一个没人管的 tmux 会话）。

## runtime（apps/runtime + packages/shared + api/client.ts 新端点）

已完成（2026-09-04）。开发 Runtime 已用新二进制重启，`127.0.0.1:43120` 在听，
迁移 0009 已对现有库生效。

### 1. 迁移 `0009_whiteboard.sql`

`ALTER TABLE boards ADD COLUMN whiteboard_json TEXT NOT NULL DEFAULT ''`。
`strokes_json` 保持不动。

- `GET /api/workspaces/{id}/boards`、`GET|PUT .../boards/{boardId}/document`
  的 `board` 对象都多一个 `whiteboard: string`（无内容时是 `""`，绝不是 null）。
- `PUT .../document` 请求体新增可选的 `whiteboard?: string`：
  **不传 = 保留库里已有的快照**（与 `kanban` 同规则），传 `""` = 清空，
  超过 8 MiB（`MAX_WHITEBOARD_BYTES`）→ 400 `Whiteboard snapshot is too large`。
- Runtime 完全不解析这个字符串，原样存原样取。

### 2. 资产 `POST /api/workspaces/{id}/assets`

两种请求体（**没有** multipart）：

| Content-Type                      | body                                       |
| --------------------------------- | ------------------------------------------ |
| 图片自身的 MIME（`image/png` 等） | 原始字节，直接 POST `File` / `Blob`        |
| `application/json`                | `{ "dataUrl": "data:image/png;base64,…" }` |

- MIME 白名单：`image/png` `image/jpeg` `image/jpg` `image/gif` `image/webp`
  `image/svg+xml` `image/avif` `image/bmp`；其它一律 400。
- 上限 8 MiB（`MAX_ASSET_BYTES`）；路由自带 12 MiB 的 body limit（axum 默认 2 MiB
  不够用，`export-png` 之前其实也被这条卡着，一并修了）。
- 落盘 `<workspace>/.armadra/assets/<sha256 前 16 位 hex>.<ext>`，内容寻址，
  同一张图重复上传只写一份。
- 响应：
  ```json
  {
    "id": "0a1b…f7.png",
    "path": ".armadra/assets/0a1b…f7.png",
    "url": "/api/workspaces/{id}/assets/0a1b…f7.png",
    "mimeType": "image/png",
    "bytes": 12345
  }
  ```
  `url` 是 **Runtime 相对路径**（Runtime 不知道自己被绑到哪个端口），
  前端用 `runtimeApi.assetUrl()` 拼 `RUNTIME_URL`。

`GET /api/workspaces/{id}/assets/{assetId}` 回文件本身：正确的 `Content-Type`、
`Cache-Control: public, max-age=31536000, immutable`（名字是内容哈希，永不变）、
`X-Content-Type-Options: nosniff`。`assetId` 只按 `^[0-9a-f]{16}\.<白名单扩展名>$`
匹配，**不做路径解析**，所以穿越是 400 而不是读文件。

### 3. 导出泛化

新：`POST /api/workspaces/{id}/exports/{exportId}/png`，body `{ dataUrl }`
（只收 `data:image/png;base64,`）。`exportId` 只需是 uuid，**不要求存在节点、
也不要求是 draw 类型**。落盘 `<workspace>/.armadra/exports/<exportId>.png`。

响应新增 `relativePath`：

```json
{
  "path": "/abs/path/.armadra/exports/<uuid>.png",
  "relativePath": ".armadra/exports/<uuid>.png",
  "bytes": 123
}
```

`relativePath` 就是 `ContextLink.content.pngPath` 该填的值。

旧路由 `POST /api/workspaces/{id}/nodes/{nodeId}/export-png` 保留，内部走同一实现，
**也写 `.armadra/exports/`**；`.armadra/drawings/` 不再新写，只在读旧看板时作为回退查找。

### 4. `ContextLink.content` 与 `kind: "shape"`

`contextLinkSchema` 多了可选的 `content { text?, pngPath? }`（Rust 侧
`model::ContextLinkContent`），随 `links_json` 整体存取，`PUT .../context-links/{nodeId}`
不变。校验：`text` ≤ 20 000 字节、`pngPath` ≤ 4 096 字节，超了 400。

`kind === "shape"` 的链接在 `collab/context_link.rs` 里**不查节点表**（白板图形没有
节点行），`summary` / `transcript` / `terminal` 三个动词渲染同一段文字：

- 有 `text` → 直接回文字（截到 200 KB）；
- 有 `pngPath` → 在工作区内解析并确认文件存在后回绝对路径；解析失败或文件还没写出来
  且没有文字时回「导出还没写到工作区里，稍后再读一次」；
- 两者都没有 → 「该白板内容暂无可读导出」。

`context list` 里 `shape` 的说明是「白板内容（文字或导出的 PNG 路径）」，
`draw` / `image` 的文案原样保留。`armadra-linked-context` skill 的表格加了 shape 一行。

### 5. 节点类型白名单

`db.rs` 的 `NODE_TYPES` **仍然允许写入 `draw` 与 `image`**，只加了注释说明
Phase 3 迁移旧看板之后再收紧——现在拒绝会让所有老看板保存失败。

### 6. packages/shared 新增（已 build）

`exportPngRequestSchema` / `exportPngResponseSchema`（`exportNodePng*` 变成它们的
别名，旧引用不会断）、`uploadAssetRequestSchema` / `uploadAssetResponseSchema`、
`MAX_ASSET_BYTES`、`ASSET_MIME_TYPES`。

### 7. `apps/web/src/api/client.ts` 新增（只增不改）

```ts
runtimeApi.uploadAsset(workspaceId, file: Blob | dataUrl: string) // → UploadAssetResponse
runtimeApi.assetUrl(workspaceId, assetId)                          // → 绝对 URL，给 TLAssetStore.resolve
runtimeApi.exportPng(workspaceId, exportUuid, dataUrl)             // → ExportPngResponse
```

`exportNodePng` 原样保留。

### 需要别人做的

- **canvas-core**：`saveBoard` 现在可以带 `whiteboard`；不带就等于「别动白板」。
  `TLAssetStore` 用上面两个方法，`upload` 直接把 `File` 交给 `uploadAsset`。
- **canvas-core**：`context-links.ts` 生成 `shape` 链接时，`content.pngPath`
  请用 `exportPng` 返回的 `relativePath`，不要自己拼。

## shell（app/ + shell/ + panels/ + sessions/ + styles/）

已完成（2026-09-04）。`apps/web/src` 全树 `grep -c "@xyflow/react"` = **0**。

### 1. 去 React Flow

| 文件                        | 改动                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/App.tsx`               | 删 `ReactFlowProvider`、删 `?poc=tldraw` 分支（`usePocCanvas` + `TldrawPoc` 的 lazy import），`CanvasWorkspace` → `TldrawWorkspace`；新增 `useTldrawTheme()` |
| `app/commands.ts`           | `useReactFlow().screenToFlowPosition` → `editor-context` 的 `screenToPage`                                                                                   |
| `app/notifications.ts`      | 自己那份 `armadra:center-node` 删掉，改调 `requestCenterOnNode`                                                                                              |
| `app/test-harness.tsx`      | 去掉 `ReactFlowProvider`                                                                                                                                     |
| `main.tsx`                  | 去掉 `@xyflow/react/dist/style.css`；新增「首次运行把 tldraw 的 `localStorage["minimap"]` 置成 `false`」（tldraw 默认收起缩略图，我们一直是展开的）          |
| `shell/Dock.tsx`            | `useViewport`/`useReactFlow` → `useEditorHandle` + tldraw 的 `useValue`；`history.past/future` → `useCanUndo()/useCanRedo()`                                 |
| `panels/CommandPalette.tsx` | 「跳转」组不再自己 `flow.setCenter`，改发 `requestCenterOnNode`（居中的算术归画布）                                                                          |
| `panels/viewport.ts`        | `currentViewportCenter()` 优先问 `screenToPage`，画布没挂载时退回看板存的视口                                                                                |
| `sessions/SessionRow.tsx`   | `CENTER_NODE_EVENT` / `centerNode` 改成 `editor-context` 的转出，事件名全应用只剩 `armadra:canvas:center-node` 一个                                          |
| `canvas/StatusMiniMap.tsx`  | **已删除**（改用 tldraw 的 Minimap）                                                                                                                         |

Dock 的缩放：

- 百分比 `useValue("canvas zoom", () => editor?.getZoomLevel() ?? 1, [editor])`，editor 为 null 时显示 100%。
- 50/100/150 走本文件里的 `zoomToLevel()`，锚点 `getViewportScreenCenter()`，
  相机换算照抄 `Editor.zoomIn` 的 `c' = c + p/z' - p/z`（5.4 没有「缩放到任意倍率」的 API）。
- 「适应」= `editor.zoomToBounds(Box.Common(所有 shape 的 pageBounds), { targetZoom: 1 })`，
  `targetZoom` 就是 §20「只缩小不放大」的现成实现（`zoomToFit` 的 TS 签名里没有这个字段，
  所以自己算了包围盒再调 `zoomToBounds`）。

### 2. 换肤（§5 / §12 第 2 条）

全部集中在 `styles/canvas.css`，`.react-flow__*` 一条不剩。做法是**整体重定向变量**
而不是逐条覆盖规则：`.canvas-stage .tl-container`（特异性 0,2,0，高于 tldraw 自己的
`.tl-theme__dark`）里把 `--tl-color-* / --tl-radius-* / --tl-shadow-*` 映射到 `tokens.css`。
深浅色不在这里分叉——`tokens.css` 已经切好语义 token，这里只引用。

已验证映射生效（`getComputedStyle` 实测）：

| tldraw                       | 深色                     | 浅色                  |
| ---------------------------- | ------------------------ | --------------------- |
| `--tl-color-panel`           | `#262626`                | `#faf8f5`             |
| `--tl-color-low`（缩略图底） | `#202020`                | `#efebe4`             |
| `--tl-color-background`      | `#000000`                | `#f6f2ea`             |
| `--tl-color-grid`            | `#4a4a4a`                | `#cfc8bc`             |
| `--tl-color-selected`        | `#0a84ff`                | `#007aff`             |
| `--tl-color-text`            | `rgb(255 255 255 / 85%)` | `rgb(58 48 38 / 90%)` |
| `--tl-radius-3`              | `10px`（`--r-card`）     | 同                    |

要点：

- **`MinimapManager` 用 `getComputedStyle().getPropertyValue()` 把 4 个变量直接当
  canvas `fillStyle`**（`--tl-color-text-3` / `-selected` / `-muted-1` / `-low`）。
  所以这四个只能映射到能被 canvas 解析的值——`rgb(… / 55%)` 可以，
  **`color-mix()` 不行**（`getPropertyValue` 不会把它算成颜色）。改这四个时注意。
- 主题联动在 `app/use-tldraw-theme.ts`：`editor.user.updateUserPreferences({ colorScheme })`
  跟着 `useResolvedTheme()` 走，tldraw 自己会给容器换 `tl-theme__dark|light`。
  实测重载后两套主题 `data-theme` / `tl-theme__*` / `colorScheme` 三者一致。
- 背景点阵 24px：同一个 hook 里 `updateDocumentSettings({ gridSize: 6 })` +
  `updateInstanceState({ isGridMode: true })`。tldraw 的 `gridSteps` 默认 64/16/4/1，
  6×4 = 24 就是可见的那一档；最细的 6px 那层由 `.tl-grid > rect:last-child{display:none}`
  关掉。实测 `<pattern>` 宽度是 384 / 96 / 24 / 6，最后一个 `display: none`。
- 字号：`.tl-container` 从 12px 提到 13px，分组标题 11px。实测 `.tl-container` 子树里
  **font-size < 11px 的元素 0 个**。
- 样式面板：`margin: 54px 62px 0 0`，贴在 `ControlsCluster`（`right:14`，宽 36）左侧
  12px、顶部与它对齐。实测 x∈[1070,1218]，与工具簇不重叠。
- 缩略图：tldraw 把它挂在 `NavigationPanel` 里（置空 `NavigationPanel` 缩略图就没了），
  CSS 把面板挪到右下 `right:12 / bottom:44`、宽 200、缩略图高 150，
  并 `display:none` 掉面板里那排缩放钮（缩放归 Dock）。
- **水印**：5.4 的元素类名是 `.tl-watermark_SEE-LICENSE`（96×32，`bottom/right: 4px`），
  §12 第 1 条决定带着上线，所以是**给它让位**而不是遮住它：缩略图底边留 44px
  （4 + 32 + 8），`UsageOrb` 跟着从 `bottom-[178px]` 提到 `bottom-[210px]`。
  实测缩略图 / 水印 / 用量球 / Dock 四者两两不重叠。

### 3. 其它

- `store/canvas-store` 的 `useCanUndo` / `useCanRedo` 保持原名被 Dock 使用，
  `Dock.test.tsx` 里对 `history` 的 `setState` 已删（不再依赖它的形状）。
- i18n **没有新增键**：`canvas.minimap` / `canvas.lock` 早就在 `i18n/canvas.ts` 里，
  Dock 的文案一个字没动。工具组（笔 / 高亮 / 形状…）是 Phase 3 的事。

### 需要别人做的

1. ~~canvas-core 删掉 `CanvasWorkspace.tsx` / `.test.tsx`~~ —— 已由 canvas-core 完成。
2. **canvas-core / `canvas/TldrawWorkspace.tsx`**：
   - `components` 里请**不要**把 `NavigationPanel` 或 `Minimap` 置空 —— 缩略图靠它俩。
   - `use-tldraw-theme.ts` 在 App 层设了 `isGridMode` 与 `gridSize: 6`；
     如果你打算自己接管 `Background` / `Grid` 槽位，先说一声，两边只留一处。
   - Dock 的「适应」目前是本地实现，没走 `runCanvasCommand("canvas.fitView")`。
     等你的 `canvas.fitView` 稳定之后可以合并成一处，行为要一致（`targetZoom: 1`）。
3. **Phase 2 / overlays**：Agent 状态描边（working 陶土 / needs-you 红 / 未读 强调色）
   还没在 tldraw 的 Minimap 上复现——`MinimapManager` 只认那 4 个全局颜色变量，
   要按 shape 上色得自己实现 `Minimap` 槽位或给 `MinimapManager` 打补丁。
   原 `StatusMiniMap` 的 `strokeOf()` 逻辑在 git 历史里（`canvas/StatusMiniMap.tsx`）。
4. **收尾 agent**：`apps/web/package.json` 的 `@xyflow/react` 依赖与
   `vite.config.ts` 的 `xyflow` 分组还在（代码里已经没有引用了）。
5. **nodes**：`window.matchMedia` 的 stub 我放进了新的
   `apps/web/src/app/test-setup.ts`（`vitest.config.ts` 的 `setupFiles`）——
   放在 `installDomPolyfills` 里来不及，import 会被提升到 tldraw 求值之前。
   你在 `ArmadraShapeUtil.test.ts` 里那份 `vi.hoisted` 现在可以删了。
   （`vitest.config.ts` 是我唯一改过的非归属文件，只加了 `setupFiles` 一行。）

### 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：**整仓零错误**（收尾时复跑）。
- `pnpm --filter @armadra/web test`：**52 个文件 533 个用例全绿**；
  其中我的目录 17 个文件 138 个用例（Dock 4、SessionsSection 4、CommandPalette 3、
  LeftSidebar 4、SettingsDialog 9、tokens 51、keybindings 28、use-app-keybindings 5 …）。
- 浏览器 `http://localhost:1422`（自己的 tab，深浅色各截一张）：
  Dock 显示 76%（canvas-core 恢复的视口，说明 `useValue` 订阅相机是活的）；
  样式面板在右上、缩略图在右下、用量球在缩略图上方、水印在缩略图下方，四者不重叠；
  深浅色两张截图里画布、面板、缩略图、Dock、侧栏是同一套灰度与圆角。
- **没验到的两项**（Browser 面板隐藏时 `requestAnimationFrame` 不回调、
  合成点击不总能到达 Radix）：
  ① Dock 缩放菜单的**点击**路径 —— 直接调 `setCamera` 验证了数学与 Dock 百分比的
  联动（0.5 → Dock 立刻显示 50%），带 `animation` 的那条在隐藏面板下不动，是 rAF 的
  环境问题不是代码问题；
  ② 主题的**即时**切换 —— 两套主题各自重载后都正确（`data-theme` / `tl-theme__*` /
  `colorScheme` 一致），实时切换走的是 `syncDocumentPreferences` 同一个 store 订阅，
  面板能显示后点一下设置里的主题开关即可确认。
  ⌘K 定位节点与侧栏点会话居中：看板上现在没有节点（canvas-core 的投影还没接），
  所以只跑了单测（`SessionsSection.test.tsx` 断言点一行会发出 `CENTER_NODE_EVENT`）
  加静态核对（`TldrawWorkspace` 第 420 行确实在监听同一个事件名）。

## Phase 2 · overlays（canvas/overlays/ + derived-edges + SubagentLayer + 缩略图）

已完成（2026-09-04）。归属文件：`canvas/overlays/*`、`canvas/derived-edges.ts`、
`canvas/SubagentLayer.tsx`；`TldrawWorkspace.tsx` 只加了 `components.Minimap`
一行 + 一条 import（其余没动，edges agent 的文件一个字没碰）。

### 1. 状态缩略图（计划 §3.2，shell 的「需要别人做的 3」）

`canvas/overlays/StatusMinimap.tsx` + `canvas/overlays/minimap.ts`（纯函数），
挂在 `components.Minimap` 上，宿主仍是 tldraw 的 `NavigationPanel`。

**整块自己画，不叠层。** `MinimapManager` 把整页 shape 合成两条 `Path2D`
（选中 / 未选中）再各刷一次颜色，颜色只认容器上的 4 个全局变量——「按 shape
上色」在它的渲染模型里没有入口。叠一层就得把它的 `getCanvasPageBounds`
换算原样抄一遍，抄出来的代码量和自己画一样，还多一份不同步的风险。

- 描边：working `--agent-working`、needs-you `--danger`、未读 `--brand`，
  其余用节点自己的 `color`；有状态时 2px，无状态 1px。映射就是
  `agentHeaderState(status).glow`，和节点光晕、状态胶囊同一个判决，
  三者永远不会各说各话。白板 shape / frame / 箭头一律画成 `--muted-foreground`
  的低对比底，不参与状态描边。
- 视口框 `--active` 填充 + `--muted-foreground` 描边，最后画，永远在最上面。
- 点击：命中节点矩形就 `centerOnPoint(节点中心)`（§3.2「点缩略图定位到节点」），
  点空白处就把相机搬到那个点；按住拖动 = 连续平移。
- 渲染不走 React：`react()` 订阅 editor 信号 + `useAgentStatusStore.subscribe`
  - `ResizeObserver`，相机每帧变化只重画 canvas。主题切换由
    `MutationObserver`（`<html data-theme>`）触发重读颜色——canvas 的
    `fillStyle` 拿的是解析后的字符串，主题变了必须重读。
- **`tokens.css` 的这 6 个变量必须保持 canvas 能解析**（`--agent-working` /
  `--danger` / `--brand` / `--muted-foreground` / `--active` / `--surface-deep`）：
  `rgb(… / 55%)` 可以，`color-mix()` 不行。和 shell 小节记的
  `MinimapManager` 那 4 个变量是同一个坑，只是名单不同。
- 位置与尺寸沿用 `styles/canvas.css` 里 shell 调好的那套（右下 200×150、
  `bottom: 44px` 给水印让位），CSS 一行没改。

### 2. rope 的 `⏳`（canvas-core 遗留 TODO，已销）

`derived-edges.ts` 新增纯函数 `ropeLabel(edge)` / 常量 `ROPE_WAITING_LABEL`，
`CanvasOverlays` 在贝塞尔中点（`bezierPath().labelX/Y`）画一个 `--card` 底衬的
圆点 + `⏳`。**只有 `variant: "rope"` 且 `waiting` 才挂**：子代理卡片自己有
RUNNING 胶囊和计时，绳子上再挂一个沙漏是重复信息。启动后 `waiting` 变 false，
虚线变实线、沙漏消失，是同一个开关。

### 3. 子代理卡片

`SubagentLayer` 的摆位在 tldraw 上原样成立（`OnTheCanvas` 就是页面坐标）：
父节点底边下方 `CARD_OFFSET`，跟随拖动与缩放，不可选中、不进撤销、不落盘。
新增 `SubagentLayer.test.ts` 5 个用例把布局钉死（含组员的绝对坐标换算、
折叠父节点、宽度夹取、父节点消失时跳过）。

### 4. 节点状态光晕（不需要改 CSS）

浏览器实测：`.node-glow::after`（inset -4、`box-shadow` 2px + 18px 模糊）
在 `.tl-html-container` 里**没有被裁**。祖先链
`node-glow → tl-html-container → tl-shape → tl-html-layer` 的
`overflow` 全是 `visible`，`contain` 只有 `size layout`（不含 `paint`），
`clip-path: none`。`canvas.css` 一行没加。

### 需要别人做的

1. **edges**：`CanvasOverlays` 现在给每条 rope 包了一层 `<g>`；如果你在
   `OnTheCanvas` 里加东西，注意这一层整体 `pointer-events: none`，只有
   子代理卡片自己收回指针事件。
2. **收尾**：`components.Minimap` 已被占用，`NavigationPanel` 仍然**不能**置空
   （置空缩略图就没人渲染了）；tldraw 的 `DefaultMinimap` 现在没有调用点。
3. **两个 tab 同开一个看板会互相 409**：本次验证时（我的 tab + edges 的 tab）
   出现了「看板保存失败」的 toast，且一方的文档会缺另一方新建的节点。
   不是本阶段引入的问题（CAS 本来就这样），但收尾时值得决定：要么在 409 时
   自动重新加载再重放，要么明确「同一看板只开一个 tab」。

### 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：整仓零错误。
- `pnpm --filter @armadra/web test`：**56 个文件 570 个用例全绿**
  （新增 `overlays/minimap.test.ts` 13 个、`SubagentLayer.test.ts` 5 个，
  `derived-edges.test.ts` 6 → 8 个）。
- 浏览器 `http://localhost:1422`（自己的 tab，深浅色各截一张）：
  1. 三种状态经 `status-store.upsert` 注入后，缩略图 canvas 的像素直方图里
     深色：`222,136,107`（`#d97757` working）/ `255,92,82`（`#ff453a` needs-you）/
     `40,147,255`（`#0a84ff` 未读）；浅色：`184,83,47` / `215,0,21` / `0,122,255`。
     六个值分别等于两套主题下的 `--agent-working` / `--danger` / `--brand`，
     主题切换是**实时**生效的（没有重载）。
  2. 无状态的节点用自己的 `color` 描边（蓝 / 黄 / 绿 / 紫四种同时在图上）。
  3. 点缩略图定位：在缩略图里点便签所在的那一小块，相机中心精确落到
     `(2142, 525)` = 便签的页面中心（预测值与实测值一致）。
  4. rope：造了 `phase2-src` / `phase2-pending` 两个终端节点（后者带
     `pendingLaunch.after`），200% 下看到虚线流动 + 中点的 `⏳` 底衬圆点。
  5. 子代理卡片：用 `agent.subagent` 事件造 2 张卡（1 working / 1 done），
     位置在父节点底边下方、跟着相机缩放；45% 与 200% 两档都对。
  6. 光晕：`getComputedStyle(el, '::after')` 读到 `box-shadow` 与
     `animation: armadra-glow` 生效，祖先链无裁剪（见上）。
  7. 测试节点与它们起的两个终端会话已删除并 `terminate`；看板文档用
     read-modify-write 的 PUT 清掉了两行残留（edges agent 的 `edge-A/B/C`
     原样保留），我的 tab 已重新加载到服务端的当前文档。

## Phase 2 · edges（箭头 ↔ edge：身份 / 合法性 / 样式 / 级联）

已完成（2026-09-04）。入口是新增的 `apps/web/src/canvas/shapes/LinkArrow.ts`
（副作用注册，`TldrawWorkspace.onMount` 里调一次，返回清理函数）。

### 1. 修掉的缺口

Phase 1 之后，**用把手或箭头工具拉出来的线一松手就消失**：tldraw 给新 arrow 的是
随机 id（`shape:xxxx`），`arrowToEdge` 拿它当边 id 会得到一个过不了 zod 的字符串，
`use-store-sync.push()` 又把「两端绑节点但不在 `document.edges` 里」的 arrow 当
stale 删掉。另外完全没有绑定合法性守卫。

### 2. 身份：边 id 记在 `arrow.meta.armadra.id`

- `sync/derive.ts` 新增 `arrowEdgeId(arrow)`：**先读 `meta.armadra.id`**（uuid 才算），
  没有再看 arrow 自身的 shape id 是不是 `shape:<uuid>`；两个都没有 ⇒ 返回 `null`，
  这条 arrow 还不是边。同时新增 `arrowArmadraMeta` / `arrowEnds` 两个小工具。
- `sync/project.ts` 的 `edgeToArrow` 现在把 `id` 与 `styled: true` 也写进
  `meta.armadra`。所以**投影出来的箭头与用户现拉的箭头是同一种记录**，往返恒等：
  重新加载看板后，边 `<uuid>` → arrow `shape:<uuid>`（meta 里同一个 id）→ 边 `<uuid>`。
- `use-store-sync.push()` 的 stale 判定改成按 `arrowEdgeId` 比对，并且
  **没有边 id 的 arrow 一律不动**（它要么是白板箭头，要么是 `LinkArrow` 还没在
  微任务里认领的新线）——这就是「一松手线就没了」的直接原因。
- `store/canvas-store.removeEdges` 与 `TldrawWorkspace` 的 `canvas.delete` 也都改成
  按 `arrowEdgeId` 找箭头，否则随机 id 的箭头选中后按 Delete 删不掉。

### 3. 合法性：after-create binding + 交互结束再判

Phase 0 结论 3 说 before-create 不能否决，所以走 after-create/change/delete。但
**光「推迟到微任务」还不够**：箭头工具在拖动过程中每一帧都可能换 binding，从节点
A 的把手起笔时指针还在 A 身上，那一刻的「自连」只是中间态。所以：

- 判定推迟到**交互结束**：`editor.getPath()` 命中 `.pointing|.dragging|.translating|
.resizing|.rotating|.brushing` 就先挂起，`window` 的 `pointerup` / `pointercancel`
  再触发一次（微任务 + 宏任务各一遍，另有 60ms 的兜底重试）。
- 规则复用 `canvas/connection.ts` 的 `isValidLink`（自连、同一对无向重复），
  节点与已有边都**从 editor 现读**，不读 `canvas-store`（它慢一拍）。
- 命中 ⇒ `editor.bail()` 把整段拖动回滚（**不进撤销栈也不进重做栈**，满足
  「被守卫拒绝的线不进撤销栈」），bail 之后 shape 还在才补一次
  `run(deleteShape, { history: "ignore" })`。提示走 sonner，文案是新增的
  `edge.selfLink` / `edge.duplicate`（zh + en，见下）。
- `source === "remote"` 的改动一律不判（`mergeRemoteChanges` 里的投影不该被守卫拦）。

### 4. 样式与方向：只在「刚变成边」那一刻写一次

`sync/project.ts` 新增 `edgeStyle(source, target)` = `edgeArrowheads` + 颜色
（取**起点节点**的色，`toTldrawColor`）。`edgeToArrow` 与 `LinkArrow` 共用它，
两种来源的线看起来一模一样。写过之后 `meta.armadra.styled = true`，用户之后手改
颜色 / 箭头不再被覆盖。

### 5. 把手起笔与级联

- `ConnectionHandles.tsx`（nodes 的文件，只加了两行）：pointerdown 时调
  `beginHandleLink()`，`back()` 里调 `endHandleLink()`。`LinkArrow` 在 arrow 的
  after-create 里消费这个一次性标记。
- **从把手起笔、松手时末端没绑到节点 ⇒ 删掉**（把手只用来连节点，§4.3）；
  从箭头工具起笔的没绑定箭头**保留**为白板箭头（Phase 3 才开放那个工具）。
- 删节点 ⇒ tldraw 自动删 binding，但**箭头本身会留下**（`ArrowBindingUtil` 只把
  终点解绑）。所以 `meta.armadra.id` 有值、又掉了一端绑定的箭头也一起删掉，
  不留悬空的半绑定箭头。这一步是记进历史的，撤销删节点会把线一起带回来。

### 6. 我改过的非归属文件（都很小，请核对）

1. **`canvas/shapes/armadra-shape.ts`**（nodes）：抽出 `isUuid()`，`isDocumentShapeId`
   转调它。`arrowEdgeId` 要校验 meta 里的裸 uuid。
2. **`canvas/shapes/ConnectionHandles.tsx`**（nodes）：见上，两行标记。
3. **`canvas/sync/derive.ts` / `project.ts` / `use-store-sync.ts`**（canvas-core）：
   canvas-core 的交接项里写明由 Phase 2 接手，改动见第 2 / 4 节。
4. **`store/canvas-store.ts`**（store）：只有 `removeEdges` 里找箭头的方式变了。
5. **`canvas/TldrawWorkspace.tsx`**（canvas-core）：`onMount` 注册 `registerLinkArrow`；
   `canvas.delete` 改成按 `arrowEdgeId` 认边。
6. **`i18n/canvas.ts`**：新增 `edge.selfLink` / `edge.duplicate`（zh + en）。

### 7. 需要别人做的

1. **Phase 3 / tools**：`canvas.delete` 现在只删「节点」与「边」，选中一条纯白板
   shape（含没绑定的 arrow）按 Delete 是空操作。开放白板工具时要补一条
   「其余选中项直接 `editor.deleteShapes`」。
2. **Phase 4 / link-content**：canvas-core 留的那条仍然成立——`sync/snapshot.ts` 的
   `stripDocumentRecords` 会剔掉所有指向节点 shape 的 binding，「一端绑节点、一端
   绑白板 shape」的箭头要重新设计加载顺序。`LinkArrow` 目前把这种箭头当**非边**
   （`arrowEnds` 里绑到非 uuid shape 的一端算没绑），不会误删（除非它是从把手
   起笔的）。
3. **store**：`selectNodes` 会把选中项收敛成「已知节点」再 `editor.select(...)`，
   所以选中一条边 + 一个节点时，边会被挤掉。Phase 2 没碰它（单选边正常：
   `deduped` 与 `selectedNodeIds` 都是空数组时会提前返回，不会反向清空选中）。

### 8. 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：整仓零错误。
- `pnpm --filter @armadra/web test`：**57 个文件 581 个用例全绿**
  （新增 `shapes/LinkArrow.test.ts` 8 个：身份 / 方向 / 「手改样式不被覆盖」/
  自连 / 重复 / 「拖动中间态不判定」/ 把手空放删除 / 白板箭头保留 / 删节点级联；
  `sync/project.test.ts` +2；`canvas/context-links.test.ts` +1「随机 shape id 的
  箭头 → edges → 链接文档」全链路）。
- 浏览器 `http://localhost:1422`（自己的 tab，**真实鼠标** `left_click_drag`；
  临时造了 `edge-A/B/C` 三个便签，测完连同箭头一起删干净了）：
  1. 从 `edge-A` 右把手拖到 `edge-B` 体上松手 → **箭头留下**，`meta.armadra.id` 是
     一个 uuid，`styled: true`，颜色 = 起点节点色（`#0a84ff` → `blue`），
     两个 sticky 之间没有箭头头（`edgeArrowheads` 的「内容 ↔ 内容」）。
  2. 同样的拖法连 `edge-A → edge-C`：1.5 s 后 Runtime 侧 `edges` 多一行
     `4f9271fe-… A → C`，而 `board.whiteboard` 仍是 1272 B，**里面没有这条 arrow
     和它的两个 binding**（`stripDocumentRecords` 认「绑到谁」而不是 id）。
  3. 再从 `edge-A` 左把手拖到 `edge-C` → 被拒，toast「这两个节点已经连过了」，
     画布上仍然只有一条箭头，文档 `edges` 仍是 1。
  4. 自连（两端都绑 `edge-A`）→ 被拒，toast「不能连到自己」，箭头不留。
  5. 从把手拖到**空白处**松手（真实鼠标，起点是用户那张便签的右把手）→
     画布上一条 arrow 都没有，工具回到 `select`，文档 `edges` 仍是 0。
     不带把手标记的没绑定箭头则保留（走 `editor` 直接造，模拟 Phase 3 的箭头工具）。
  6. 刷新页面 → 那条边从库里投影回来：arrow id 是 `shape:4f9271fe-…`，
     `meta.armadra.id` 是同一个 uuid，两端 binding 都在（**往返恒等**）。
  7. 选中箭头按 `canvas.delete` → `document.edges` 1 → 0、画布上箭头消失；
     `editor.undo()` → 箭头连同两端 binding 一起回来（一次拖动 / 一次删除都只占
     一条撤销记录）。
- **环境干扰说明**：验证期间 overlays agent 的 tab 在同一块看板上做
  read-modify-write 的 PUT，我的 tab 吃到过几次 409 与随之而来的整页重载
  （重载会 `clearHistory`，所以中途有两次「撤销恢复不了」的假阳性）。
  上面每一条都是在重载之后重新跑过、状态干净时的结果。
- **没在浏览器里验的**：「边变化 → 400ms → 推送链接文档」这一段需要一个真实的
  终端节点当端点，看板上的终端是用户的、不能连。改用单测覆盖
  （`context-links.test.ts` 的全链路用例）；`usePublishContextLinks` 本身一个字没改，
  它只看 `document.edges`。

## Phase 3 · content（资产仓库 + 外部内容分流）

已完成（2026-09-04）。改动集中在三个新文件加一处装配，`sync/*`、Dock、
`keybindings.ts`、`node-menu`、`canvas.css`、`apps/runtime` 一个字没动。

### 1. `canvas/assets.ts`：`TLAssetStore`

```ts
createAssetStore(getWorkspaceId: () => string | null): TLAssetStore
class AssetTooLargeError extends Error      // 超限的哨兵，调用方靠它区分「已经提示过了」
assetPath(asset): string | null             // 读回 meta.armadra.path
MAX_UPLOAD_BYTES = MAX_ASSET_BYTES          // 8 MiB
```

- `upload` → `runtimeApi.uploadAsset(workspaceId, file)` → 返回
  `{ src: runtimeApi.assetUrl(workspaceId, id), meta: { armadra: { path } } }`。
  `path` 是**工作区相对路径**（`.armadra/assets/<hash>.<ext>`）；tldraw 默认的 file
  资产处理器会把 `result.meta` 合进资产记录，所以 **Phase 4 直接读
  `asset.meta.armadra.path` 就能把文件路径交给 Agent**，不用再导出 PNG。
- 超过 8 MiB：toast `canvas.assetTooLarge`，抛 `AssetTooLargeError`，**不发请求**。
- `resolve` 原样返回 `asset.props.src`（上传时存的已经是绝对地址）。
- **工作区 id 是 getter 不是值**：`<Tldraw>` 只在挂载时读一次 `assets`，
  换工作区不会拿新实例重建 store。捕获成常量就会把新工作区的图写进旧工作区。
  `TldrawWorkspace` 里的实例是模块级的，读 `useCanvasStore.getState().workspace?.id`。

### 2. `canvas/dnd/external-content.ts`：`registerExternalContentHandler`

`TldrawWorkspace.onMount` 里 `registerExternalContent(instance)`（在
`registerLinkArrow` 后面），返回注销函数。tldraw 的顺序是「默认处理器 →
`store.props.onMount` → 用户的 `onMount`」，所以在 `onMount` 里覆盖是安全的。

只覆盖两个：

| 类型    | 行为                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files` | 图片（MIME 在 `ASSET_MIME_TYPES` 内，或没有 MIME 但扩展名是那 8 种）→ **tldraw 原生 image shape**，走上面的资产仓库；其余文件读成文本 → 转交 `text` |
| `text`  | 丢掉 `html` 再交给 `defaultHandleExternalTextContent` → **一律纯文本 text shape**（Markdown 也是纯文本，§12.3）                                     |

`svg-text` / `url` / `embed` / `file-replace` **保持 tldraw 默认**：前者本来就走
资产仓库（`getAssetForExternalContent`），后者的 bookmark shape 还没停用（§4.5
说要停用，Phase 3 tools 或收尾做掉之后，这里改成转 `text` 即可，一行）。

尺寸：自然尺寸，最大边 > `MAX_IMAGE_DIMENSION`（800）时等比缩。多张图横排、
间距 `IMAGE_GAP`（16）、**整排居中在落点**。落点 = tldraw 给的 `point`
（拖放是指针位置，粘贴没有指针时是 `getViewportPageBounds().center`）。

纯函数都导出了，`dnd/external-content.test.ts` 覆盖：`routeFile` / `routePath` /
`baseName` / `extensionOf` / `isImagePath` / `imageShapeSize` / `layoutImages` /
`offsetBy`；`canvas/assets.test.ts` 覆盖资产仓库（meta 写入、8 MiB 拒绝、
无工作区、resolve）。web 全量 646 tests 绿。

### 3. `canvas/dnd/os-drop.ts`：瘦身

**tldraw 自己就监听画布的 `drop`（`useCanvasEvents`，且 `stopPropagation`）和
文档的 `paste`（`useNativeClipboardEvents`），两条路最后都进
`editor.putExternalContent`**，所以浏览器侧的拖放与粘贴不再需要我们自己实现。
`os-drop.ts` 现在只剩 tldraw 覆盖不到的三块：

1. **Tauri 的 `onFileDrop`**（webview 收不到 `DataTransfer`，只给真实路径）→
   `addNodesForPaths`：目录 → `files` 节点，其余 → `editor` 节点。
2. `useOsDrop().onDrop` 变成兜底，只会收到落在 tldraw 容器**外面**的拖放，
   原样 `putExternalContent`。`TldrawWorkspace` 上那两个 prop 因此没有改动。
3. `usePasteToCanvas()` 现在是**粘贴守卫**：tldraw 的 paste 监听器挂在
   `document` 上且**不认输入框**，所以在 `document.body` 的冒泡相位提前
   `stopPropagation`（目标元素这时已经收到事件，`document` 上那个再也看不到它）。
   判据仍是原来的 `isTextEntry`（input / textarea / contenteditable / `.xterm` / `.nodrag`）。
   **顺带修掉了一个既有 bug**：改之前粘贴一段文本会同时生成一张便签（我们的）
   和一个 text shape（tldraw 的）。

`image` 节点分支删干净了（`store.addNode("image")` 现在会被 §9.5 的白名单拒），
`sticky` 分支也删了（文本改成 text shape）。`MAX_TEXT_BYTES` / `stickyTitle` /
`clampText` 随之删除——全树没有别的引用。

### 4. `i18n/canvas.ts` 新增两个键

`canvas.assetTooLarge`（带 `{limit}`）、`canvas.assetFailed`（带 `{name}`），zh / en 都有。

### 5. `apps/desktop/src-tauri/tauri.conf.json`：CSP 的 `img-src`

加了 `http://127.0.0.1:43120`。图片 shape 的 `src` 是 Runtime 的绝对地址，
原来的 `img-src 'self' data: blob:` 会让桌面版**整块白**（浏览器版不受影响）。
`connect-src` 早就有这一条，只是 `img-src` 漏了。**桌面版要重新构建才生效。**

### 需要别人做的

1. **Phase 3 / tools 或收尾**：§4.5 说 `note` / `bookmark` / `embed` / `video`
   四种 tldraw shape 要停用，现在一个都没停（`shapeUtils` 是加在默认集合上的）。
   bookmark 停用之后，`external-content.ts` 里的 `url` 分支要显式注册成
   「转成 text shape」，注释里标了位置。
2. **Phase 4 / link-content**：白板图片的内容链接**不要导出 PNG**，直接
   `assetPath(editor.getAsset(shape.props.assetId))` 拿 `.armadra/assets/<hash>.png`
   填 `ContextLink.content.pngPath`（§6.3 原文就是「image shape 直接给资产文件路径」）。
3. **未解决 / 需要 Runtime 或桌面端配合**：**桌面端拖入一张图片文件**（真实路径）
   现在开的是 `editor` 节点，不是 image shape。要把磁盘上的图变成资产得先读到字节，
   而桌面端没装 `@tauri-apps/plugin-fs`、asset 协议也没在 capabilities 里开，
   Runtime 又只有「按内容上传」没有「按路径导入」。两条路二选一：
   - Runtime 加 `POST /api/workspaces/{id}/assets/import { path }`（在工作区内解析
     路径、走同一套哈希落盘），前端在 `routePath` 里给图片加一条分支；或
   - 桌面端加 `fs:allow-read-file` 并把路径读成 `File` 再走现有 `upload`。
     浏览器版不受影响（`File` 里有字节，走的是 image shape 那条路）。
     **已解决**（2026-09-04，走的第一条路）：见「Phase 3 · asset-import」，
     `addNodeForPath` 里图片路径改成 `importAsset` → image shape。

### 验证（浏览器 `http://localhost:1422`，自建看板 `phase3-content-test`，测完已 DELETE）

- 粘贴纯文本 → **一个** text shape，`x=540 w=203` 对视口中心 `x=640`（居中），
  内容正确；输入框里粘贴 → 画布 shape 数不变（守卫生效），同一段打在画布上 → +1。
- 合成 `DataTransfer` 拖入 1200×600 的 png → image shape `800×400`
  （最大边缩到 800）、位置 `(240,160)` 正好以落点 `(640,360)` 为中心；
  `.armadra/assets/` 多出一个 `<hash>.png`；`<img>` 的 `src` 是
  `http://127.0.0.1:43120/api/workspaces/…/assets/<hash>.png` 且 `complete=true`。
- 保存后的 `board.whiteboard`（2531 B）里有 2 条 `asset:image` + 2 条 `shape:image`，
  `src` 是 Runtime URL、**`data:image` 出现 0 次**，`meta` 是
  `{"armadra":{"path":".armadra/assets/<hash>.png"}}`。刷新后两张图仍然渲染出来。
- 拖入 `notes.md` → text shape，`# 标题` 原样是纯文本（没被当成 Markdown 标题）。
- 拖入 9.48 MiB 的 png → **不创建 shape、不写文件**，只有一条 toast
  「图片超过 8 MB，没有添加」。
- 文本 / 图片能选中、移动、`undo` 回到原位、删除、`undo` 恢复。
- 测完删掉了 `.armadra/assets/` 下的两个测试文件与整块测试看板。
- **没在浏览器里验的**：Tauri 的 `onFileDrop`（要跑桌面壳），以及上面第 3 条
  那个已知缺口。`typecheck` 剩的报错全在 `src/canvas/tools.test.ts`（tools agent 在改），
  与本节改动无关。

## Phase 3 · migrate（退役节点迁移 / 快照属性测试 / 8 MiB 上限）

已完成（2026-09-04）。入口是新增的
`apps/web/src/canvas/sync/migrate-legacy.ts`，由 `use-store-sync.load()` 之后
调一次。Runtime 的写入白名单同步收紧。

### 1. `canvas/sync/migrate-legacy.ts`（纯函数 + 一个执行器）

| 导出                              | 内容                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `parseCssColor` / `toStrokeColor` | 任意 CSS 颜色 → 最近的 tldraw 颜色名（RGB 欧氏距离，基准是 `DEFAULT_THEME` 浅色主题的 13 个 `solid`），认不出回 `black` |
| `toStrokeSize`                    | 像素笔宽 → `s/m/l/xl`（2 / 3.5 / 5 / 10 = `strokeWidth` 2 × `STROKE_SIZES`）                                            |
| `strokeToShape`                   | 一笔 → 一个 `draw` shape（`compressLegacySegments`）                                                                    |
| `drawNodeToShapes`                | 一个 `draw` 节点 → 若干 shape                                                                                           |
| `imagePlan`                       | `image` 节点 + 一次已完成的上传 → 资产记录 + `image` shape                                                              |
| `legacyNodes`                     | 文档里还剩几个退役节点（0 = 迁过了）                                                                                    |
| `migrateLegacyNodes`              | 执行器；`MigrateDeps` 注入上传 / 取 URL / 读文件 / 中止判定 / 告警                                                      |

要点：

- **一笔一个 shape**。tldraw 的 `draw` shape 只有一组 `color` / `size`，而旧的
  `strokes` 每笔各带颜色与粗细，合成一个就会丢颜色。
- **shape id 由「节点 id + 笔序」派生**（`createShapeId(\`${nodeId}-ink-${i}\`)`，
图片是 `${nodeId}-image`，资产是内容哈希），所以重跑迁移命中同一批 id，
  不会画出两份。
- **坐标**：`nodeBox()` 的页面绝对坐标 + `LEGACY_DRAW_BODY_OFFSET_Y = 40`
  （旧笔迹画在节点**正文**的 `<canvas>` 上，正文比节点顶部低一个标题栏，
  也就是 `COLLAPSED_HEIGHT`）。
- **父级一律是页面，不是 frame**，即使旧节点在某个分组里。`snapshot.ts` 的
  `stripDocumentRecords` 会剔掉「父级是节点 shape」的记录（加载时先灌快照、
  frame 还不存在，tldraw 会把孤儿扔掉），挂进 frame = 下次打开就没了。
  代价：迁出来的手绘不跟着分组移动。
- **不进撤销栈**：`editor.run(fn, { history: "ignore" })`。用的不是
  `mergeRemoteChanges`——那会把 source 变成 `remote`，派生层就不置脏，
  删除永远存不下去。验证过：迁完刷新，`getCanUndo() === false`。
- **一个字节都不丢**：图片上传失败、或者既没有 `src` 也读不到 `sourcePath`，
  就**保留原节点**（记 warning），下次打开这块板再试。
- 资产的 `props.src` 存的是 `runtimeApi.assetUrl()` 的**绝对 URL**，这样即使
  没有 `TLAssetStore.resolve` 覆盖，`<img>` 也直接能加载（已实测）。

### 2. 接进 `use-store-sync.ts`

- `load()` 之后调 `migrateLegacy(editor, document)`，每块板一次
  （`migratingBoardId`）。
- 迁完**直接把那几行从 `document.nodes` 摘掉**（`dropMigratedNodes`），
  而不是等派生层：tldraw 的 store 变更按帧刷，标签页不可见时
  `requestAnimationFrame` 整个停摆，派生可以几十秒都不来。editor 里的 shape
  已经删干净了，这一步写的是同一个结论。连着的边一并摘掉（Runtime 拒收悬空边）。
- 新增 `isLegacyMigrationPending()`。

### 3. `save/autosave.ts`：迁移在途时推迟保存（两条通道都推迟）

图片要先上传，这段时间文档里还留着 `draw` / `image`，而 Runtime 已经不收了。
`flushEdit` **和 `flushViewport`** 都先看 `isLegacyMigrationPending()`，命中就
重新排一轮定时器（保存态维持 dirty，不丢任何改动）。

> 视口那条一开始漏了，结果打开旧看板 2 秒时必然弹一次「看板保存失败」：
> 视口保存 PUT 的也是整份文档（服务端没有单独的视口路由）。

### 4. Runtime 收紧（`db.rs`）

- `NODE_TYPES` 去掉 `image` / `draw`，新增 `DEPRECATED_NODE_TYPES`。
  **读取不校验**（`load_board` 从来不 validate），所以还没打开过的旧看板照样
  读得出来；`collab/context_link.rs` 的两个分支一行没动。
- `validate_document` 对这两种类型给**专门的 400**：
  `Node type 'draw' was retired; open the board once so the client migrates it
into a whiteboard shape before saving`。
- 测试：新增 `retired_whiteboard_types_load_but_never_save`（拒写 + 直接 SQL
  插行后仍读得出来）；`accepts_every_v3_node_kind` 去掉两种；
  `migrates_a_real_v2_database_to_v3` 改成「先按迁移的做法滤掉两种，其余仍然
  往返」；`collab/tests.rs` 新增 `add_legacy_linked_node`（绕过 `save_board`
  直接 SQL 插行，正好就是「没人打开过的旧看板」那个真实场景）；
  `every_node_type_says_how_it_can_be_read` 连退役类型一起遍历。

### 5. 测试

- `canvas/sync/migrate-legacy.test.ts`（18 个）：颜色 / 笔宽映射、
  segments 坐标（用 `b64Vecs.decodePoints` 解回来比）、组里节点的绝对坐标、
  半截点与空笔画、上传失败回退、无数据回退、`sourcePath` 优先与读文件异常回退、
  幂等（同一份文档两次得到同一批 id）、中途切板不写。
- `canvas/sync/snapshot.test.ts` 新增**属性测试**（200 个固定种子随机快照，
  仓库里没有 fast-check，用 mulberry32 自己造）：留下 / 剔掉恰好符合预期、
  `serialize → parse` 等价且过滤幂等、schema 一致且不改动入参。
- `save/autosave.test.ts` 新增 3 个：8 MiB 超限（不发 PUT、停在 error、
  超限的快照绝不写进文档）、不超限时快照随编辑 PUT 出去、迁移在途时两条通道
  都推迟。

### 6. 我改过的非归属文件（都很小，请核对）

1. **`canvas/sync/use-store-sync.ts`**（canvas-core）：第 2 节。
2. **`save/autosave.ts`**（canvas-core）：第 3 节，只在 `flushEdit` /
   `flushViewport` 各加了一个 4 行的早退。

### 7. 需要别人做的

1. **Phase 3 / content**：`canvas/assets.ts` 的 `TLAssetStore.resolve` 请把
   **已经是绝对 http(s) URL 的 `asset.props.src` 原样放行**——迁移写进去的
   就是绝对 URL（`runtimeApi.assetUrl()`）。`upload` 那侧随你。
2. **谁都行（不急）**：`MigrateDeps.readSourceFile` 现在**没有实现**，所以
   `image` 节点的 `sourcePath` 优先级形同虚设，一律走内联 data URL。原因是
   web 端读不到工作区里的二进制文件：`@tauri-apps/plugin-fs` 不在依赖里、
   Tauri 的 `asset:` 协议没在 `tauri.conf.json` 里开、Runtime 的
   `GET .../file` 是纯文本接口（遇到 NUL 字节直接 400）。补上任一条之后
   把钩子接上即可，纯函数与单测都已经就位。**补法已经有了**：见
   「Phase 3 · asset-import」第 4 节，`runtimeApi.importAsset(workspaceId, sourcePath)`
   就够了，不用把字节读进前端。
3. **已知缺口**：一个既没有 `src`、`sourcePath` 又读不到的 `image` 节点会被
   永久保留，而 Runtime 从此拒收它 ⇒ **这块板再也存不进去**。目前只有 warning。
   要么补上第 2 条，要么把这种节点降级成一条带路径文本的便签。

### 8. 验证记录（2026-09-04）

- `pnpm --filter @armadra/web test`：**61 个文件 648 个用例全绿**。
  `typecheck` 剩的报错全在 `src/canvas/tools.test.ts`（tools agent 在改）。
- `cargo test -p armadra-runtime`：**314 全绿**；
  `cargo clippy --all-targets -- -D warnings` 零告警；`cargo fmt --check` 干净。
  开发 Runtime 已用新二进制重启（`127.0.0.1:43120`，`/api/health` ok）。
- 浏览器 `http://localhost:1422`（自己的 tab-9，**没有碰用户的 Default 看板**；
  临时开了 6 块 `phase3-migrate-test*`，测完全部 `DELETE`，
  `.armadra/assets/` 下的测试文件也删了）：
  1. 先用旧二进制 PUT 出一块带 `draw`（3 笔：红 2px / 绿 8px / 蓝 4px）+
     `image`（1×1 PNG 的 data URL）+ 便签的看板，再重启收紧后的 Runtime。
     `GET .../document` 照样读得出那两行；`PUT` 同一份 → **400**，
     错误信息就是那句迁移提示。
  2. 后续的测试看板改成**直接往 `canvas.db` 插行**（收紧后写不进去了），
     这正是「没人打开过的旧看板」的真实形态。
  3. 前端打开这块板 → 画布上 3 条 `draw` shape（可选中）+ 1 个 `image` shape，
     退役节点的占位壳消失；`POST .../assets` 一次 200，
     `.armadra/assets/b7a95783e8c945e9.png` 落盘 68 B。
  4. `GET .../document`：`nodes` 只剩 `sticky`，`board.whiteboard` 3469 B，
     里面是 `3×draw + 1×image + 1×asset + page/document/user`，
     **没有** `armadra` 记录。
  5. 坐标逐条对上：笔迹包围盒左上角 (20,20)/(40,150)/(260,60) + 节点位置
     (0,0) + 标题栏 40 ⇒ shape 落在 (20,60)/(40,190)/(260,100)；
     颜色 `red` / `light-green` / `blue`，粗细 `s` / `xl` / `m`；
     `image` 在 (600,0) 320×240，父级都是 `page:page`。
  6. 刷新 → 5 个 shape 原样回来，`getCanUndo() === false`（迁移不进撤销栈），
     `saveState: "saved"`、没有「看板保存失败」通知条；
     `resolveAssetUrl` 回绝对 URL，`<img class="tl-image">` 的 `src` 就是它，
     `GET .../assets/...` 200 `image/png`。截图里三条笔迹的颜色与形状与原
     `strokes` 一致（1×1 透明 PNG 本来就看不见）。
- **踩过的坑（供后来者）**：后台标签页里 Chrome 停掉 `requestAnimationFrame`，
  tldraw 的 store 变更**一次都不刷**，派生层几十秒都不动——第 2 节那个
  「自己摘掉节点行」就是为此加的。中途试过「订阅 store 等派生追上、
  15 秒兜底放行」的版本：可见标签页里没问题，隐藏标签页里一路等到兜底然后 400，
  所以换成了现在这版。

## Phase 3 · tools（Dock 工具组 / 工具键 / 样式面板 / shape 右键 / 锁定）

已完成（2026-09-04）。归属文件：`canvas/tools.ts`、`canvas/tools.test.ts`、
`canvas/canvas-lock.ts`、`canvas/escape-to-select.ts`、`canvas/StylePanel.tsx`、
`canvas/menus/shape-menu.tsx`、`shell/DockTools.tsx`。

### 1. 一份工具表（`canvas/tools.ts`）

`CANVAS_TOOLS` 的 `id` **就是 tldraw 自己的工具 id**（`select / hand / draw /
highlight / geo / line / arrow / text / frame`），所以 Dock 的高亮、
`editor.setCurrentTool` 与 `editor.getCurrentToolId()` 之间没有映射表。
每条工具带一个 `command`（`canvas.tool.<id>`）和一个 `labelKey`（`tool.<id>`），
命令表、Dock、i18n 三处靠这一份规格串起来，`tools.test.ts` 断言三者对得上。

`image` 单列在 `IMAGE_TOOL`：5.4 没有 image 工具，Dock 上那个按钮开一次
`<input type=file>`，把文件交给 `editor.putExternalContent({ type: "files" })`，
落点是视口中心 —— 之后的事全归 content agent 注册的外部内容处理器，
Dock 不认识资产上传。所以它**没有命令、没有键位**，也没进 `EXTRA_CANVAS_COMMANDS`。

### 2. 工具键（`keybindings.ts` +9 条）

`V / H / D / ⇧D / R / L / A / T / F`，照抄 tldraw 默认；两个平台同键；
`allowInTerminal = allowWhileTyping = false`（单字母键在终端里就是普通输入）。
命令面板与设置 → 快捷键页读的是同一张 `COMMANDS`，**不用改**，加完自动出现
（浏览器里确认过设置页里多了 9 行、可以录制新键位）。

`Esc` 回选择**故意不进这张表**：`Esc` 同时是所有对话框、命令面板、下拉菜单的
关闭键，`useKeybindings` 命中即 `preventDefault + stopPropagation`，全局截一次
就全弄坏了。改为 `canvas/escape-to-select.ts` 在 `window` 冒泡相位补一个监听器，
只在「焦点在画布容器里、或者干脆落在 `body` 上」时动手。原因是 tldraw 自带的
那条（`useDocumentEvents` 的容器 `keydown`，不受我们清空 `kbd` 影响）实测有两个洞：

1. **焦点不在容器里就收不到。** 点过 Dock 按钮、关掉一个 Radix 菜单之后
   `document.activeElement` 常常是 `body`，键盘事件根本不经过 `.tl-container`。
2. **`inputs.keys` 会永久卡住。** 容器的 Escape 分支手动往
   `editor.inputs.keys` 里塞了一个 `"Escape"`，指望 `keyup` 删掉；而 `keyup`
   的处理在 `areShortcutsDisabled()` 为真时直接 return —— **在文字 shape 里按
   Esc 退出编辑正是这种情况**（活动元素是 tiptap 的 contenteditable）。那一次的
   `"Escape"` 于是永远留在集合里，之后每次 Esc 都被它自己的
   `if (inputs.keys.has("Escape"))` 判成「按住不放」而空操作。
   实测：新开的看板第一次 Esc 正常，进过一次文字编辑之后 Esc 就再也不切工具，
   `editor.inputs.keys` 里赫然是 `["Escape"]`。我们在 `keyup` 里无条件删掉它，
   tldraw 自己的取消 / 取消选中行为也跟着恢复了。

### 3. 样式面板（`canvas/StylePanel.tsx`）

`components.StylePanel` 换成一层包装：`shouldShowStylePanel(toolId, 选中项类型)`
为真才渲染 `DefaultStylePanel`（换肤仍是 shell 在 `styles/canvas.css` 做的那份）。
规则两条：**当前工具不是 `select`** 或 **选中项里有非 `armadra` 的 shape**。
tldraw 默认只要选中了任何东西就把面板亮出来，而 `armadra` 一个 tldraw 样式都没有，
于是选中一个终端会得到一个只剩透明度滑块的空面板。判断是纯函数，有单测。

**注意**：tldraw 自己还有一道 `breakpoint >= TABLET_SM` 的闸（`TldrawUi.tsx`），
窗口窄于约 640px 时 `StylePanel` 槽根本不渲染。调试时窗口被缩到 493px，
排查了一会才发现不是我们的显隐逻辑 —— 后来者遇到「面板怎么按都不出来」先看窗口宽度。

### 4. 删除与选择（Phase 2 待办 1 / 3 已销）

- `canvas.delete` 现在把选中拆成三堆（`splitSelectionForDelete`，纯函数 + 单测）：
  节点 → `store.removeNodes`（照旧可能弹会话确认框）、边 → `store.removeEdges`、
  **其余一律 `editor.deleteShapes`**。认边看 `meta.armadra.id`，认节点看
  「非 arrow + uuid 形状的 shape id」；认不出的箭头（没绑定 / 只绑一端）算白板内容。
  文档里不存在的 `armadra` shape 一概不动。
- `store.selectNodes` 投影回 editor 时**保留选中的边与白板 shape**：
  `kept = 选中项里「type === "arrow" 或 id 不是 uuid」的那些`。
  （边的 arrow 也有 uuid 形状的 id，所以「是不是节点」要连类型一起看。）
  `selectedNodeIds` 仍然只装节点，签名没变。
- `canvas.selectAll` 改为 `editor.selectAll()`（原来只选节点）。全选之后
  `selectNodes` 那一侧把节点部分投影回去，白板 shape 留在选区里。

### 5. 右键菜单

- 白板 shape 上右键 → `menus/shape-menu.tsx`：置顶 / 置底 / 复制 / 删除，
  外加 **仅 text shape** 的「转成便签」（`renderPlaintextFromRichText` 取正文 →
  `store.addNode("sticky")` 落在原位 → 删掉原 shape；便签必须走 `nodes` 表，
  Agent 的 `sticky` 控制动词依赖它）。颜色 / 粗细 / 填充**不放这里**，归样式面板。
  命中的 shape 在选区里就作用于整个选区的白板部分，否则只作用于它自己。
- `TldrawWorkspace.onContextMenu` 的命中判定加了 `hit.type !== "arrow"`，
  否则边箭头（uuid id）会被误认成节点。三种情况：节点 → 节点菜单、
  其它 shape → shape 菜单、空白 → 添加菜单。
- 添加菜单（`menus/add-menu.ts`）新增「新建文字」「新建画框」，
  直接在落点造 tldraw 原生 `text` / `frame` shape（文字建完进编辑态）。
  它们和 Dock 的 `+` 共用同一份规格，所以 Dock 上也有。

### 6. 锁定（`canvas/canvas-lock.ts`）

锁定原本是 `TldrawWorkspace` 的局部 state，但工具组在 Dock 上、在画布组件树之外，
所以抽成一个和 `editor-context.ts` 同款的模块级 store（`useSyncExternalStore`，
不进 zustand —— 它是 UI 瞬时状态，不该跟着看板存盘）。锁定时：相机锁死（原有行为）、
Dock 上除「选择」外的工具按钮全部 `disabled`、正在用的工具退回 `select`、
`canvas.tool.*` 命令也不响应。画布卸载时自动解锁。

### 我改过的非归属文件（都很小，请核对）

1. **`keybindings.ts`**：新增 9 条 `canvas.tool.*`，只增不改。
2. **`i18n/commands.ts`**：`cmd.canvas.tool.*` ×9（zh + en）。
3. **`i18n/canvas.ts`**：`tool.*` ×10、`geo.*` ×6、`shape.*` ×5、
   `add.text` / `add.frame`（zh + en）。
4. **`shell/Dock.tsx`**（shell）：只加了一行 `<DockTools />`，并把原来
   SaveDot 前的那条分隔线让给工具组自己带（画布没挂载时整组连分隔线一起不渲染）。
5. **`store/canvas-store.ts`**（store）：只有 `selectNodes` 末尾投影那几行，见第 4 节。
6. **`canvas/commands.ts`**（canvas-core）：没有净改动（曾加过 `canvas.tool.image`
   又去掉了）。
7. **`canvas/TldrawWorkspace.tsx`**（canvas-core）：`components.StylePanel`、
   `onMount` 里 `registerEscapeToSelect`、锁定改用 `canvas-lock`、
   `canvas.delete` / `canvas.selectAll` 重写、`toolCommands` 批量注册、
   右键菜单三分支。**没碰** `assets` / `registerExternalContent` / `sync` 相关的段落。
8. **`canvas/menus/node-menu.tsx`**：见下「顺手修的崩溃」。
9. **`canvas/menus/add-menu.test.ts`**：跟着新增的两项更新断言。

### 顺手修的崩溃（不是我引入的，但会白屏）

`node-menu.tsx` 里
`useCanvasStore((state) => (state.document?.nodes ?? []).filter(...))`
每次都 `filter` 出一个**新数组**，zustand v5 的 `useSyncExternalStore` 按
`Object.is` 比 —— 于是**右键任何一个节点，整个应用立刻白屏**，控制台是
「The result of getSnapshot should be cached」+「Maximum update depth exceeded」。
加了 `useShallow` 就好了（仓库里其它 store 的数组选择器本来就都带）。
浏览器里复现过 3 次、修完不再复现。

### 需要别人做的

1. **canvas-core / migrate**：验证期间「只改白板、不动节点」的编辑**不触发保存**
   （拦 `fetch` 看到一次 PUT 都没发，刷新后手绘全丢；加一个节点才会连带把
   白板一起存上）。写这份交接时 `sync/use-store-sync.ts` 与 `save/autosave.ts`
   刚被改过、复测已经能存住了，但请确认这条是被正式修掉的而不是碰巧。
2. **收尾 agent**：`Esc` 那两条兜底（`escape-to-select.ts`）是绕 tldraw 5.4 的
   缺陷，升级 tldraw 时先跑一遍模块注释里的复现步骤，能删就删。
3. **nodes**：`shape-menu.tsx` 目前只对 `text` 提供「转成便签」。如果以后
   `geo` 也想带正文转过去，把 `canConvertToSticky` 放宽即可（它是导出的纯函数）。

### 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：整仓零错误。
- `pnpm --filter @armadra/web test`：22:11 那一轮 **61 个文件 648 个
  用例全绿**；其中新增 `canvas/tools.test.ts` 18 个（工具表 ↔ 命令表 ↔ i18n
  一致性、键位表、锁定、样式面板显隐 5 条、`splitSelectionForDelete` 6 条）
  与 `store/canvas-store.test.ts` +1（「投影回 editor 时保留边与白板 shape」）。
  收尾时（22:14）`shell/LeftSidebar.test.tsx` 与 `sidebar/WorkspaceTree.test.tsx`
  共 5 个用例红了（`setExpanded is not a function`），那是别的 agent 正在改
  `sidebar/*` 与 `app/preferences-store.ts` 的中间态，与本节改动无关；
  只跑 `src/canvas src/store src/shell/Dock.test.tsx src/keybindings.test.ts
src/panels/settings` 是 **26 个文件 304 个用例全绿**。
- 浏览器 `http://localhost:1422`（自己的 tab，自建看板 `phase3-tools-test`，
  测完 `DELETE` 掉了）：
  1. Dock 上 10 个工具按钮齐全（选择 / 手形 / 画笔 / 高亮 / 形状 / 直线 / 箭头 /
     文字 / 画框 / 图片），点每一个 `getCurrentToolId()` 都对得上；
     形状按钮点开是 6 项下拉，选「椭圆」后 `getStyleForNextShape(GeoShapeGeoStyle)`
     变成 `ellipse`、按钮图标跟着换、工具切到 `geo`。
  2. **真实鼠标**逐个画出来：`geo(ellipse) / draw / highlight / line / arrow /
frame / text` 七种 shape 都能画，画完自动回 `select`。
  3. **真实键盘** V/H/D/⇧D/R/L/A/T/F 九个键逐个命中对应工具；
     `Esc` 从 `draw` 回到 `select`（修好之前是空操作，见第 2 节）。
  4. 样式面板：`select` + 空选 → 隐藏；`select` + 选中几何 → 显示；
     `select` + 只选一个便签节点 → 隐藏；节点 + 几何混选 → 显示；
     切到画笔工具 → 显示。
  5. 混选：`editor.select(节点, 几何)` 之后选区**两个都在**（修之前几何会被挤掉），
     按 Delete 两个一起没了；单选一条纯白板 `geo` 按 Delete 也删得掉。
  6. 「全选」菜单项 → 4 个 shape（1 节点 + 3 白板）全部进选区。
  7. 右键：几何上 → 置顶 / 置底 / 复制 / 删除；文字上 → 多一项「转成便签」，
     点了之后文字 shape 消失、多出一个正文是 `convert me` 的便签节点；
     「复制」出的副本偏移 24/24、「置底」把它的 index 从 `a1qyKl` 压到 `a0UPY`；
     节点上 → 分组 / 颜色 / 复制 / 折叠 / 最大化 / 删除；空白 → 添加菜单，
     里面「新建文字」在落点建 text 并进编辑态、「新建画框」在落点建 frame。
  8. 锁定：点锁 → `cameraOptions.isLocked = true`、当前 `draw` 退回 `select`、
     Dock 上 9 个白板工具按钮 `disabled`（「选择」仍可用）、按 `D` 无效；
     解锁后全部恢复。
  9. 深浅色各一张截图：Dock 工具组、样式面板、缩略图、水印四者不重叠，
     两套主题下灰度与圆角同一套；`.tl-container` 与 Dock 子树里
     **font-size < 11px 的元素 0 个**，形状下拉的菜单项 14px。
- **环境干扰说明**：`localStorage` 的 `armadra.board` / `armadra.theme` 是**全应用共享**的，
  另外两个 agent 的 tab 会把它改到自己的看板上；中途还吃到过 Vite HMR 留下的
  **两个 editor 实例**（`getEditor()` 指向新的、fiber 里翻到的是旧的），
  以及别的 agent 改 `use-store-sync.ts` 时的整页白屏。上面每一条都是在
  「整页刷新 + 重新确认 `armadra.board` 是我自己的板」之后重跑过的结果。
  后来者验证时建议每验一段就整页刷新一次，别信 HMR 之后的状态。

## Phase 3 · asset-import（按路径导入资产）

已完成（2026-09-04）。开发 Runtime 已用新二进制重启（`127.0.0.1:43120`，
`/api/health` ok），端点已用真实图片实测。

### 1. `POST /api/workspaces/{id}/assets/import`

请求体 `application/json`：`{ "path": "<绝对路径或工作区相对路径>" }`。
**响应与 `POST .../assets` 完全同形**（`uploadAssetResponseSchema`）：

```json
{
  "id": "a1779d1283ca03a1.png",
  "path": ".armadra/assets/a1779d1283ca03a1.png",
  "url": "/api/workspaces/{id}/assets/a1779d1283ca03a1.png",
  "mimeType": "image/png",
  "bytes": 1767823
}
```

- 落盘与去重和上传**共用** `api::store_asset`：同一个 `.armadra/assets/`、同一套
  `sha256` 前 16 位命名，所以「导入一次 + 上传同一张图」只会有一个文件。
- 类型**按扩展名**判断（磁盘文件没有 MIME），白名单沿用 `ASSET_TYPES` 那 8 种；
  `.jpeg` 折成 `jpg`，扩展名大小写不敏感。
- 上限同样是 `MAX_ASSET_BYTES`（8 MiB），**先看 metadata 再读**，超限不进内存。
- 路径规则（`security::resolve_import_source`，是唯一允许指到工作区外的解析器
  ——Finder 拖进来的图多半在 `~/Downloads`，而且字节是**复制**进工作区的）：

| 输入                                             | 结果                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| 绝对路径，普通文件                               | 200（可以在工作区外）                                            |
| 相对路径                                         | 按工作区根解析，走 `workspace_relative_path` + `resolve_in_root` |
| 不存在                                           | 404 `Requested path does not exist`                              |
| 目录 / 设备 / FIFO（符号链接先解析再判）         | 400 `Only regular files can be imported`                         |
| 解析后落在 `/dev` `/proc` `/etc` `/usr` …        | 403 `That location is protected by the system`                   |
| 相对路径穿越（`../…`）、工作区内符号链接指向外面 | 400 / 403                                                        |
| 扩展名不在白名单                                 | 400 `Asset type is not an accepted image type`                   |
| 超过 8 MiB                                       | 400 `Asset is too large`                                         |

路由是静态段 `assets/import`，和 `GET assets/{assetId}` 不冲突（方法也不同）。

### 2. `packages/shared` 与 `api/client.ts`

- `importAssetRequestSchema`（`{ path: string }`，1–4096 字节）+ `ImportAssetRequest`。
  已 `pnpm --filter @armadra/shared build`。
- `runtimeApi.importAsset(workspaceId, path)` → `UploadAssetResponse`（与
  `uploadAsset` 同一个响应 schema）。

### 3. 前端接线

`canvas/dnd/external-content.ts` 的 `addNodeForPath`：**桌面端拖进来的图片路径
不再开 `editor` 节点**。`isImagePath(path)` 且画布已挂载时 → `importAsset` →
`fetch(assetUrl)` 取回字节包成 `File` → 交给原来的 `createImageShapes`。
借道 `File` 是为了和浏览器拖放**走完全同一条路**（尺寸、`meta.armadra.path`、
资产仓库都不用复制一遍）；那次重传只在 loopback 上，重新上传的哈希相同，
Runtime 认得出来不会再写盘。导入失败只 `toast(canvas.assetFailed)`，
不退回去开节点。`os-drop.ts` 只改了文档表格里那一行。

### 4. 还没做 / 留给收尾

- `canvas/sync/migrate-legacy.ts` 的 `MigrateDeps.readSourceFile` 现在可以补上了：
  `runtimeApi.importAsset(workspaceId, sourcePath)` 返回的 `id` / `path` 就是
  资产记录要的东西（`src` 用 `runtimeApi.assetUrl(workspaceId, id)`，
  `meta.armadra.path` 用返回的 `path`），不必真的把字节读进前端。**这个文件本次
  没有碰**（link-shape agent 在 `sync/` 里干活）。
- 桌面端的 Tauri `onFileDrop` 这条路**没有在桌面壳里实测**（要跑 Tauri），
  端点本身是用 curl 实测过的。

### 5. 验证（2026-09-04）

- `cargo test -p armadra-runtime`：**317 全绿**（新增
  `api::tests::assets_are_imported_from_a_path`、
  `security::tests::imports_files_from_anywhere_but_only_regular_files`、
  `security::tests::imports_follow_symlinks_only_to_regular_files`）；
  `cargo clippy -p armadra-runtime --all-targets -- -D warnings` 零告警；
  `cargo fmt -p armadra-runtime --check` 干净（`apps/desktop` 里原有的
  fmt 差异不是本次的）。
- `vitest run src/api src/canvas/dnd`：**72 全绿**（新增
  `canvas/dnd/asset-import.test.ts` 4 例 + `api/client.test.ts` 2 例）。
  `typecheck` 剩的报错全在 `canvas/shapes/LinkArrow.test.ts` 与
  `canvas/sync/project.test.ts`（link-shape agent 在改）。
- curl 实测（工作区 = 本仓库，测完把 `.armadra/assets/` 下两个文件删了）：
  `~/Desktop` 的 1.7 MB PNG → 200，落盘 `a1779d1283ca03a1.png`，
  `GET .../assets/<id>` 回 `image/png` 且字节与原文件 `cmp` 一致；
  仓库内相对路径 `apps/desktop/src-tauri/icons/32x32.png` → 200；
  不存在 → 404；目录 → 400；`../../../etc/hosts` → 400；
  `/dev/urandom` → 403；`README.md` → 400。

---

## Phase 3 · sidebar（左侧栏按 Codex 桌面版重做）

> 2026-09-04，用户第六轮反馈（附 Codex 桌面版侧边栏截图）。计划书 §22 的
> 「工作空间 / Agent 两栏」被这一节取代；下文的 §26 指的就是本节。

### 1. 结构（自上而下）

| 位置        | 内容                                                                                                                                                                                | 文件                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 标题栏 44px | 窗口拖拽区；**折叠钮画在侧栏外面**（`fixed`，`left = trafficLightInset() + 8`，`top 9`），侧栏收到 0 宽之后按钮留在原位；图标 `PanelLeft`，右上角蓝/红点 = 有未读 / 有 Agent 在等你 | `shell/LeftSidebar.tsx`                                     |
| 顶行 36px   | 当前工作空间名 + `⌄`（切换工作空间 / 打开文件夹 / 新建文件夹 / 克隆仓库 / 从列表移除）；右侧 🔍 打开命令面板、🔔 打开投递记录（铃铛右上角同一颗点）                                 | `sidebar/SidebarHeader.tsx`                                 |
| 新建看板    | `✎ 新建看板` + 行尾 `+`，两者同一个动作：在当前工作空间建一块板（名字 `看板 N`，避开同名）并切过去                                                                                  | `sidebar/WorkspaceTree.tsx` 的 `NewBoardRow`                |
| 「置顶」组  | 跨工作空间的置顶看板；组内为空时整组不渲染                                                                                                                                          | `WorkspaceTree` 的 `PinnedRow`                              |
| 「项目」组  | 已打开的工作空间一行（chevron + 📁 + 色点 + 名字，点行 = 展开/收起，双击改名，`⋯` = 新建看板 / 重命名 / 投递记录 / 关闭 / 从列表移除）；展开后缩进列出看板                          | `WorkspaceTree` 的 `WorkspaceRow`                           |
| 看板行      | 图标（置顶的画 `Pin`）+ 名字 + 节点数 + 信号点 + `⋯`；右键与 `⋯` 同一组动作（置顶/取消置顶、重命名、删除）；当前看板高亮                                                            | `sidebar/BoardRow.tsx`                                      |
| Agent 折叠  | 只在**当前看板**行下面出现一行「N 个 Agent」，默认收起；展开才渲染会话列表                                                                                                          | `BoardRow` 的 `AgentsFold` + `sessions/SessionsSection.tsx` |
| 底部        | `⚙ 设置`（Codex 那行的头像 / 语音 / 帮助不做）                                                                                                                                     | `LeftSidebar` 的 `SidebarFooter`                            |

宽度沿用 `--sidebar-w: 240px`，⌘⇧L（`app.sidebar`）不变。

### 2. 偏好（`app/preferences-store.ts`）

- `collapsedWorkspaceIds` ← `armadra.collapsedWorkspaces`，**取代**了旧的
  `expandedWorkspaceIds` / `armadra.expandedWorkspaces`。语义反过来了：项目组默认
  展开，存的是「收起来的那些」。旧键不迁移（一次展开状态而已）。
- `pinnedBoardIds` ← `armadra.pinnedBoards`，board id 数组，顺序即置顶顺序。
  `setBoardPinned(boardId, pinned)`。
- 读写走的还是同一套 `storedIds` / `writeStored`，与 `sidebarOpen` 一致。

### 3. 信号点

- 数据源是 `GET /api/workspaces/{id}/sessions`（`useSessions`）而不是
  `agent/status-store` 的 `statuses`：`AgentStatus` 里**没有 `boardId`**，
  `SessionSummary` 里有。所以按看板汇总只能走会话列表。
- `sidebar/board-tree.ts` 的 `boardSignals(rows, isAttention)` 把一块板上的
  会话合并成 `{attention, unread}`（板内任一命中即命中，已结束的会话不算）。
  红点 = `isAttention`，蓝点 = `unread`。
- 铃铛与折叠钮上那颗点用的是 `useStatusCounts(workspaceId)`（工作空间级）。
- **只有当前工作空间有会话数据**，别的工作空间的看板行不带点——会话接口是按
  工作空间取的，不值得为侧栏多发 N 个请求。

### 4. 纯逻辑与测试

`sidebar/board-tree.ts`（有 `board-tree.test.ts`）：
`boardSignals` / `visibleBoards`（超过 8 块折起来，但**当前那块板一定可见**）/
`pinnedEntries`（按偏好顺序，找不到的 id 跳过，不清理偏好）/ `nextBoardName`。

- `sidebar/WorkspaceTree.test.tsx` 11 例（默认展开、收起写偏好、切板、双击改名、
  置顶进置顶组、只剩一块不让删、删除确认、新建看板、从列表移除、展开显示）。
- `shell/LeftSidebar.test.tsx` 5 例（结构、折叠钮留在原位、搜索开面板、
  宽度收到 0、开合写偏好）。
- `sessions/SessionsSection.test.tsx`：组件改成 `<SessionsSection boardId>`，
  新增「只列当前看板的会话」「会话少时不放过滤框」（阈值 `FILTER_THRESHOLD = 6`）。

### 5. 别处受影响的地方

- `shell/ControlsCluster.tsx`：删掉了左上角那个 34px 的侧栏开关（整块左侧
  cluster 都没了），i18n 的 `cluster.sidebar` 随之删除，换成
  `sidebar.collapse` / `sidebar.expand`（按钮名会随状态变，无障碍名也跟着变）。
- `i18n/shell.ts`：删 `tree.title` / `tree.add` / `tree.expand` / `tree.collapse` /
  `tree.unread` / `sidebar.boards` / `sidebar.drag` / `sidebar.boardAdd`；
  新增 `sidebar.search` / `notifications` / `hasNotifications` / `collapse` /
  `expand` / `newBoard` / `boardDefaultName` / `pinned` / `projects` /
  `boardPin` / `boardUnpin` / `showMore` / `showLess` / `agentCount` /
  `needsYou` / `unread`（zh/en 两份）。
- 新文件：`sidebar/SidebarHeader.tsx`、`sidebar/BoardRow.tsx`、
  `sidebar/NameInput.tsx`、`sidebar/SignalDot.tsx`、`sidebar/board-tree.ts`、
  `sidebar/use-board-mutations.ts`（`useBoardMutations` / `useRenameWorkspace`，
  原来埋在 `WorkspaceTree` 里的四个 mutation 提出来，置顶组的行也要用）。

### 6. 验证（2026-09-04）

- `vitest run`：本次涉及的 `src/sidebar` / `src/shell/LeftSidebar.test.tsx` /
  `src/sessions` / `src/i18n` 共 35 例全绿；全量 661 例里 15 例失败，全部在
  `canvas/shapes/LinkArrow.test.ts` 与 `canvas/sync/project.test.ts`
  （link-shape agent 在改，与本次无关）。
- `typecheck`：本次改的文件零报错；剩余报错同上，在 `canvas/sync/` 与
  `store/canvas-store.ts`（`edgeToArrow` 还没导出）。
- 浏览器（localhost:1422，深/浅色各一遍）：顶行下拉、新建看板行、置顶组、
  项目组（两个工作空间，一个收起）、11 块板时的「展开显示」、看板行 `⋯` 与
  右键菜单（置顶/重命名/删除）、折叠钮在收起前后都停在 `(8, 9)`。
  测试用的工作空间与 11 块板是临时建的，测完 `DELETE` 了。
- **注意**：Browser pane 的合成鼠标点击在这个 tab 上不生效（点哪都不触发），
  上面的交互是用页面内派发的 pointer 事件驱动的；键鼠链路本身没验过。

### 7. 还没做

- 看板行的信号点只覆盖当前工作空间（见 §3）。要覆盖全部已打开的工作空间，
  得让 `GET /sessions` 支持多工作空间或按 board 汇总的轻量端点。
- 置顶组里的行不给「删除」（它不知道所在工作空间还剩几块板，`canDelete=false`），
  删除请到「项目」组里那一行做。
- Agent 折叠行只在**当前看板**上出现；别的看板即使有 Agent 也不展开列表。

## Phase 3 · link-shape（上下文链接改成自定义 shape：贴边贝塞尔）

已完成（2026-09-04）。起因是用户的反馈：「现在连线逻辑有点问题吧？为什么是直线？
按理来说应该在边框上进行往外连的。」

### 1. 病因与结论

Phase 1 把 `edges` 行投影成 tldraw 原生 `arrow`（`edgeToArrow`），两端 binding 的
`normalizedAnchor` 在节点**中心**、`bend: 0`，所以画出来是一条中心到中心、被两端
边框裁掉的直线，v3 那条「从相对边的中点出发的贝塞尔」没了。

结论：**上下文链接不再用 arrow，改成自定义 shape `link` + 自定义 binding `link`**。
拉线交互一个字没改（把手 → tldraw 箭头工具），只是在**交互结束、两端都绑到节点**
的那一刻把 arrow 换成 link。白板自己的箭头（没绑定 / 绑到白板 shape）仍然是 arrow。

### 2. 新文件

| 文件                               | 内容                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `canvas/shapes/link-shape.ts`      | `LinkProps` / `LinkBindingProps` 与全局类型注册、id 映射、`isLinkShape` / `linkEnds` |
| `canvas/shapes/link-path.ts`       | `linkCurve` / `pointOnCurve` / `sampleCurve`（纯函数，复用 `geometry.ts`）           |
| `canvas/shapes/LinkShapeUtil.tsx`  | 几何、命中、指示器、SVG 渲染（线 / 箭头 / 标签）                                     |
| `canvas/shapes/LinkBindingUtil.ts` | 只管生命周期：节点删了 / 被拆开就删线                                                |
| `canvas/shapes/link-path.test.ts`  | 相对边、锚点、水平切线、采样（10 例）                                                |

### 3. 三个必须记住的约定

1. **`link.x / link.y` 永远是 0，路径坐标就是页面坐标。** 两端节点一动，
   `getGeometry` / `component` 里读的 `getShapePageBounds` 被 tldraw 的响应式系统
   重新求值（`getShapeGeometry` 是 ComputedCache，shape 组件外层是 `useStateTracking`），
   所以移动 / resize / 折叠 / 最大化全自动跟随，**link 的记录一个字节都不用改**
   （不进历史、不置脏、不触发保存）。`LinkArrow.ts` 里有一条
   `registerBeforeChangeHandler("shape")` 把 `x/y` 钉回 0，免得用户把线拖离两端。
2. **id 是 `shape:link-<边 uuid>`，故意不是 `shape:<uuid>`。**
   `isDocumentShapeId` 是「这是不是一个节点 shape」的判据，选中投影
   （`use-store-sync` / `canvas-store.selectNodes`）、删除分流
   （`TldrawWorkspace.canvas.delete` → `tools.splitSelectionForDelete`）、右键菜单
   三处都按它认节点。用 uuid 形状的 id 会让这三处把线当成一个「文档里不存在的节点」，
   最直接的后果是**选中一条线按 Delete 什么也不会发生**。
3. **两端记在 `props.from` / `props.to`（shape id），binding 只管生命周期。**
   link 没有把手，两端建好之后不会再改，所以两者不会走岔；`linkToEdge` 只读 props，
   不用查 binding。`LinkShapeUtil.canBind` 必须对 `bindingType === "link"` 返回
   `true`——binding 的 `fromId` 就是这条线，`editor.createBinding` 会问它，
   返回 false 的话**两条 binding 会被静默丢弃**（不报错、不进 store，踩过一次）。

### 4. 改过的既有文件

- `canvas/sync/project.ts`：`edgeToArrow` / `edgeStyle` **删除**，换成
  `linkRecords`（不查节点表的底层构造，`LinkArrow` 换形时用）+ `edgeToLink`；
  新增 `edgeLabelKey`（§21 的标签表：终端↔终端 = `edge.context`，
  否则按内容那一端 sticky/editor/files/browser/diff → `edge.sticky/file/dir/web/diff`）。
  `edgeArrowheads` 原样保留。
- `canvas/sync/derive.ts`：`arrowToEdge` 删除，换成 `linkToEdge`；
  `deriveEdges(links, boardId, previous)` 少了一个 bindings 参数；
  新增 **`edgeIdOfShape(shape)`**——「什么算边」只有这一处定义（见第 6 节）。
  `arrowEdgeId` / `arrowArmadraMeta` / `arrowEnds` 保留（`LinkArrow` 与
  `TldrawWorkspace` 还在用）。
- `canvas/sync/use-store-sync.ts`：`documentArrows` → `documentLinks`；
  `isDocumentRecord` 认 `link`；`push()` 按 `props.edgeId` 建 / 删线，
  建完 `sendToBack`（线在节点下面）。
- `canvas/sync/snapshot.ts`：`stripDocumentRecords` 剔掉 `link` shape 与
  `link` binding（原来那条「两端绑节点的 arrow」的规则留着，兼容旧快照）。
- `canvas/shapes/LinkArrow.ts`：`claim`（给 arrow 补 meta + 写样式）换成
  `convert`（删 arrow、建 link + 两条 binding、`sendToBack`，同一个 `editor.run`，
  所以「拉一条线」仍然只占一条撤销记录）；`currentEdges` 从 link shape 读；
  合法性 / 把手兜底 / 交互结束再判这三件事一个字没改。
- `canvas/geometry.ts`：抽出 `bezierControls(geometry)`，`bezierPath` 转调它
  （link 的指示器要控制点，曲线只能有一处定义）。
- `store/canvas-store.ts`：`addEdge` 用 `edgeToLink` + `sendToBack`；
  `removeEdges` 用 `edgeIdOfShape` 找线。**`selectNodes` 一个字没动。**
- `canvas/TldrawWorkspace.tsx`：只加了 import 与
  `shapeUtils = [ArmadraShapeUtil, LinkShapeUtil]` / `bindingUtils = [LinkBindingUtil]`
  两行（外加 `<Tldraw bindingUtils={...}>`）。
- 测试：`sync/project.test.ts`、`canvas/context-links.test.ts`、
  `shapes/LinkArrow.test.ts`、`sync/snapshot.test.ts` 跟着改；
  i18n **没有新增键**（`edge.context/sticky/file/dir/web/diff` 早就有）。

### 5. 画法（与 v3 的 `FloatingEdge` 对齐）

- 两个矩形相对边的中点之间的三次贝塞尔，`anchor: "horizontal"`——**上下摆放也只走
  左右两侧**，不从头部上面绕过去挡标题。
- 线宽 2 / 选中 3.5；颜色取**起点节点**的色（frame 取 `meta.armadra.color`）。
- 箭头按 `edgeArrowheads`：内容 → 终端单向、终端 ↔ 终端双向、内容 ↔ 内容无箭头。
  箭头是沿切线画的两笔「V」，不用 SVG marker（marker id 会跨 shape 撞车）。
- 中点标签走 i18n 键，缩放 < 0.5 不画。**文字用线自己的颜色（`currentColor`，
  85% 不透明）而不是 `--foreground`**：画布纸张色是用户单独选的
  （`app/use-tldraw-preferences.ts` 直接往 `<html>` 上写 `--canvas-bg`），
  深色主题下也可能是一张浅色纸，主题文字色在那上面会糊掉。底衬是
  `paint-order: stroke` + `var(--canvas-bg)` 的描边，与纸张永远同色。
- 命中测试是沿曲线采样 24 段的 `Polyline2d`（`isFilled` 默认 false），
  指示器是同一条贝塞尔的 `Path2D`；`hideSelectionBounds*` 全开，
  所以选中一条线不会出现那个没意义的包围框。

### 6. 需要别人做的

1. **tools（`canvas/tools.ts` + `TldrawWorkspace` 的 `canvas.delete` 段落）**：
   把那段 `edgeId: shape.type === "arrow" ? arrowEdgeId(shape) : null` 换成
   **`edgeId: edgeIdOfShape(shape)`**（`canvas/sync/derive.ts` 新增，已导出，
   link 与旧 arrow 都认得），`nodeId` 那一行也顺手改成
   `shape.type !== "arrow" && shape.type !== "link" && isDocumentShapeId(shape.id)`
   更直白。**不改也能删**：link 的 id 不是 uuid 形状，现在会落进
   `split.shapes` 走 `editor.deleteShapes`，派生层照样把那条 `edges` 行摘掉
   （已在浏览器里验过）；改了之后才会走 `store.removeEdges` 这条正路。
2. **canvas-core**：`sync/snapshot.ts` 里「一端绑节点、一端绑白板 shape 的 arrow」
   那条 Phase 2 遗留仍然成立（Phase 4 · link-content 的事），与 link 无关。

### 7. 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：整仓零错误。
- `pnpm --filter @armadra/web test`：**65 个文件 687 例全绿**
  （新增 `shapes/link-path.test.ts` 10 例；`sync/project.test.ts` 的边一节重写成
  `edgeToLink / linkToEdge / edgeIdOfShape / edgeLabelKey`；`LinkArrow.test.ts`
  的「身份」一节重写成「换形」，级联那条改成直接验 `LinkBindingUtil`）。
- 浏览器 `http://localhost:1422`（**自己新建的工作空间 `link-shape-test`**，
  测完连同里面的终端会话一起删干净了；没碰任何人的看板）：
  1. 从便签 A 的右把手拖到便签 B 身上松手 → arrow 没了，画布上是一条 `link`
     shape（`x/y` = 0、`edgeId` 是 uuid、`props.from/to` 是两端 shape id）+
     两条 `link` binding，1.5 s 后 Runtime 的 `edges` 多一行。
  2. 几何逐条对上：A(0,0,240×160) / B(520,60,240×160) ⇒ 起点 (240,80)、
     终点 (520,140)，正好是两个矩形**相对边的中点**；把 B 拖到 y=300 ⇒
     终点 (520,380)；折叠 A（h=40）⇒ 起点 (240,20)；把 A resize 成 300×220 ⇒
     起点 (300,110)。全程 link 的记录没被改过。
  3. 上下摆放（B 在 A 正下方）仍然从左右两侧出线（`horizontal` 锚）。
  4. 真实鼠标点在曲线上 → 选中（stroke-width 2 → 3.5，指示器沿曲线），
     `selectedNodeIds` 仍是 0（没被 `selectNodes` 挤掉）；按 Delete →
     线消失、`document.edges` 1 → 0；`editor.undo()` → 线与 binding 一起回来。
  5. `store.removeEdges` / `store.removeNodes` / `editor.deleteShapes` 三条路径
     都能删掉线，撤销都能还原（含「删节点 → binding 级联 → 线消失 → 边消失」）。
  6. 刷新页面 → 边从库里投影回来，仍是 `link` shape + 两条 binding，
     排序在所有节点之下（`sendToBack`），**往返恒等**。
  7. 保存后的 `board.whiteboard` 里只有 `document/page/user` 三条记录，
     **没有** link shape 与 link binding（`stripDocumentRecords` 生效）。
  8. 便签 → 终端的线：终端那一端有箭头、便签那一端没有，标签「🗒 便签」；
     便签 ↔ 便签两端都没箭头。深色纸张与浅色纸张各截一张，线与标签都清晰。
  9. 重复连同一对 → 被拒，toast「这两个节点已经连过了」，画布上不留 arrow。
- **踩到的坑（供后来者）**：
  - Browser pane 的合成拖拽只有在 **pane 处于显示状态**（`innerWidth > 0`）
    且 **相机静止**（`editor.getCameraState() === "idle"`）时才有效：
    tldraw 在相机移动期间会插一层 `.tl-hit-test-blocker`（`pointer-events: all`,
    z-index 10000），`setCamera` 之后要等 ~1 s 再动手。
  - 坐标要用 **screenshot 帧**的坐标（`read_page` 给的 ref 坐标是 CSS 像素，
    两者差一个 `800 / innerWidth` 的比例）。
- **顺手发现、不属于本次改动的问题**（canvas-core 看一下）：测试途中
  **画布 HMR 重挂载了一次，看板被存成了空的**（`nodes` / `edges` 全没了，
  `whiteboard` 只剩 3 条元数据）。推测是 editor 重新挂载后 store 里还没有 shape，
  `use-store-sync` 的 `pull()` 先跑了一轮，把「零个 shape」当成用户的改动派生成
  空文档并置脏，自动保存随后把空文档写了回去。与 link 无关（节点也一起没了），
  但真机上 Agent 远端事件 / 换页也可能触发同一条路径，值得加一道
  「editor 里一个 shape 都没有、而文档里有节点 ⇒ 这一轮不派生」的保险。

---

## Phase 3 · whiteboard-settings（设置里的「白板」页 + tldraw 原生配置）

> 2026-09-04 用户反馈：「把 tldraw 原生的配置引入我们的设置：背景（不同颜色）、
> 网格开关、多语言、字体等作为基础配置；并要有『手绘风』。」

### 1. 偏好（`app/preferences-store.ts`）

新增一整块 `whiteboard: WhiteboardPreferences`（写法照 `terminal`：整块存、
一个 `setWhiteboardPreference(key, value)`、每项一个 `armadra.whiteboard.*` 键）：

| 字段           | 取值                                            | 默认     | 落到 tldraw 的哪里                                     |
| -------------- | ----------------------------------------------- | -------- | ------------------------------------------------------ |
| `background`   | `theme` / `black` / `white` / `paper` / `slate` | `theme`  | `--canvas-bg` + `--canvas-dot`（写 `<html>` 内联样式） |
| `grid`         | bool                                            | `true`   | `updateInstanceState({ isGridMode })`                  |
| `gridSize`     | `12` / `24` / `48`（**看到的**间距 px）         | `24`     | `updateDocumentSettings({ gridSize: 间距 / 4 })`       |
| `snap`         | bool                                            | `false`  | `isSnapMode`                                           |
| `dynamicSize`  | bool                                            | `false`  | `isDynamicSizeMode`                                    |
| `animation`    | bool                                            | `true`   | `animationSpeed` 1 / 0                                 |
| `style`        | `sketch` / `clean`                              | `sketch` | `DefaultDashStyle` + `DefaultFontStyle`                |
| `defaultColor` | tldraw 13 色名                                  | `black`  | `DefaultColorStyle`                                    |
| `defaultSize`  | `s` / `m` / `l` / `xl`                          | `m`      | `DefaultSizeStyle`                                     |

导出常量 `WHITEBOARD_BACKGROUNDS` / `WHITEBOARD_GRID_SIZES` /
`WHITEBOARD_STYLES` / `WHITEBOARD_COLORS` / `WHITEBOARD_SIZES` 与
`useWhiteboardPreferences()`。

### 2. `app/use-tldraw-theme.ts` → `app/use-tldraw-preferences.ts`（**重命名**）

主题同步原样保留，外面多了四个 effect。`App.tsx` 的调用改成
`useTldrawPreferences()`；`styles/canvas.css` 里两处提到旧文件名的注释也改了。
纯函数都从这个模块导出（有单测 `use-tldraw-preferences.test.ts`，12 例）：

- `canvasBackgroundVars(background)` → `{"--canvas-bg","--canvas-dot"} | null`；
  `theme` 那一档返回 `null`，`applyCanvasBackground(null)` 把两个变量从
  `<html>` 上摘掉，落回 `tokens.css`。**没有碰 `TldrawWorkspace.tsx`**：
  `.canvas-stage` 上的 `background: var(--canvas-bg)` 与 `canvas.css` 里
  `--tl-color-background` / `--tl-color-grid` 的映射本来就指向这两个变量。
- `canvasDotColor(hex)`：点阵色按背景明度自动取对比（亮底往黑压 20%，
  暗底往白提 30%）。
- `canvasColorScheme(background, theme)`：**选了固定底色时，tldraw 的形状色板
  跟底色明暗走，不跟应用主题走**。踩过的坑：深色应用里选「纸色」，tldraw 的
  「黑」其实是 `#f2f2f2`，画出来的线在米白底上完全看不见。面板不受影响——
  `canvas.css` 把 `--tl-color-*` 整体重定向到我们的 token，`tl-theme__*` 盖不过它。
- `tldrawGridSize(间距) = 间距 / 4`：`gridSteps` 是 64/16/4/1，最细那档被
  `canvas.css` 关掉，屏幕上看到的是 `4 × gridSize`。用户选 24 就真是 24px。
- `WHITEBOARD_STYLE_PRESETS`：`sketch = {dash:"draw", font:"draw"}`、
  `clean = {dash:"solid", font:"sans"}`；四个 `setStyleForNextShapes` 都带
  `{ history: "ignore" }`（改默认风格不该进撤销栈）。
- `tldrawLocale(locale)`：`zh-CN → "zh-cn"`、`en → "en"`。**静默跟随应用语言**，
  设置页上不出现这一行（§14 禁描述性文案）。

### 3. 页面与导航

- 新文件 `panels/settings/pages/WhiteboardPage.tsx`：三张 `SettingsGroup`
  （外观 / 行为 / 默认风格），行组件全用现成的 `SettingsRow` + `Select` /
  `Switch`，无脚注。13 色的色板是页面内的 `WhiteboardSwatches`
  （`role="radiogroup"` + `Button` + `ColorDot`）——**没有复用**
  `ui/color-picker` 的 `ColorSwatches`：那一个的白名单是节点调色板的 7 色
  （`NODE_COLORS`，画布控制 API 的契约），掺 tldraw 色名会把两套色板搅在一起。
- `panels/settings/nav.ts`：`whiteboard` 排在 `notifications` 之后，图标
  `Presentation`。**放在「通用」分组**——原话是「通用分组里终端之后」，但
  `terminal` 属于「连接」分组，白板是外观类配置，跟主题/语言同组更合适。
- `panels/SettingsDialog.tsx`：`SECTION_PAGES` 加一行。
- `i18n/modals.ts`：新增 `settings.section.whiteboard` 与 36 个
  `settings.whiteboard.*`（背景 5 档、间距 3 档、风格 2 档、粗细 4 档、
  颜色 13 个、开关 4 个），zh/en 各一份。

### 4. 我改过的非归属文件（都很小，请核对）

- `app/App.tsx`：import 与调用改名（1 行 + 1 行）。
- `app/preferences-store.ts`：见 §1（sidebar agent 也在这个文件里加东西）。
- `styles/canvas.css`：两处注释里的文件名 + 点阵那段注释改成「间距 ÷ 4」。
- `panels/settings/nav.ts`、`panels/SettingsDialog.tsx`、`i18n/modals.ts`：各加几行。

### 5. 验证（2026-09-04，localhost:1422，深/浅色各一张截图）

在临时看板 `wb-settings-test` 上做的，测完 `DELETE` 了；没动别人的 Default 板。

- 设置页出现「白板」，导航是 通用 / 通知 / **白板** / Agent / …。
- 5 档背景即时生效：`纸色` → `<html>` 上是 `--canvas-bg:#f6f2ea;
--canvas-dot:#c5c2bb`，`.canvas-stage` 背景与 `.tl-grid-dot` 的 fill 都跟着变；
  `跟随主题` → 两个变量被摘掉，回到 token 的 `#000000` / `#4a4a4a`。刷新后保留。
- 网格：关掉后 `.tl-grid` 整个不渲染、间距 Select 变灰；选 48 后
  pattern 宽度从 `384/96/24/6` 变成 `768/192/48/12`（可见档 = 48px）。
- 手绘 / 整洁：手绘画出来的矩形是两遍抖动路径（`M…Q…M…Q…`），文字是手写体；
  切成整洁后新画的矩形是单条直角实线、文字是无衬线。旧形状不受影响。
- 吸附 / 动态字号 / 动画：`TLDRAW_USER_DATA_v3` 里
  `isSnapMode` / `isDynamicSizeMode` / `animationSpeed` 跟着翻。
- 语言：切 English 后该文件里 `locale` 从 `zh-cn` 变 `en`；样式面板的
  「形状」在中文下是中文。
- `pnpm --filter @armadra/web typecheck` 干净；
  `vitest run src/app src/panels/settings src/i18n` 69 例全绿。

### 6. 已知问题 / 还没做

- 画布上偶尔弹「看板保存失败」：`PUT …/document` 409，两次保存撞版本号。
  和本次改动无关（`sync/snapshot.ts` 只持久化 shape / binding，`gridSize`
  与用户偏好都不进看板文档），但两个 agent 同时开着同一个 Runtime 时容易复现。
- 窗口很窄（< 700px）时「默认颜色」那一行的标签会被 13 个色点挤没
  （色点组是 `shrink-0`）。820px 的设计宽度下正常。
- 背景只有 5 个预设，没有自定义取色器；要加就在
  `WHITEBOARD_BACKGROUND_COLORS` 上扩，`canvasDotColor` 会自动给点阵配色。

## Phase 3 · launcher（首页按 impeccable 重做，2026-09-04）

用户要求：「首页也需要调整一下，变得美观一些」，用 `.claude/skills/impeccable`
这套设计 skill 走一遍（Operate 模式：这是工具的启动页，不是营销页）。

### 1. critique 发现的问题

先对旧首页做了一次 critique（深/浅色截图 + `scripts/detect.mjs`）。检测器
零告警，但眼睛和 DOM 量出来的问题有这些：

1. **路径根本不截断（功能性缺陷）**。Radix ScrollArea 会给 Viewport 里那层
   wrapper 打上内联 `display: table`，行宽跟着最长的路径撑开——实测 445px
   的可视区里行宽 837px。后果不只是难看：右侧的相对时间和 `⋯` 菜单被推出
   屏幕，**路径较长的工作空间在窄窗口下无法「从列表移除」**。
2. **相对时间与 `⋯` 抢同一个位置**：hover 时时间 `invisible`、`⋯` 顶上来，
   鼠标划过列表时右侧一直在闪。
3. **两条对齐轴**：品牌区居中、最近列表左对齐，眼睛没有一条可以依靠的
   竖线。
4. **三张等大卡片当页面骨架**：96px 高的卡里只有一个 20px 图标加两个字，
   上下各空掉三十多像素；三个动作等权，但九成时候用户是要点下面的最近列表。
5. **品牌 mark 不是这个产品的标识**：用的是 lucide 的 `Hexagon`，和
   `public/icon.svg`（两个节点 + 一条连线）毫无关系。
6. **`最近` 标题用了 `uppercase` + `tracking`**：中文没有大小写，这两条只
   给汉字加了一点怪字距。
7. 拖目录进窗口的覆盖态是一个 `inset-4` 的虚线框加一行字，没有层次。
8. `CloneRepoDialog` 的进度行用 `text-xs`（12px），不在 17/15/13/11 的阶梯上。

### 2. 改了什么

- **`ui/brand-mark.tsx`（新）**：把 `public/icon.svg` 的核心图形蒸成单色
  24 viewBox 的 mark——空心节点 →（1.5px 连线）→ 实心节点。`currentColor`、
  线宽 1.5，和 lucide 同一套语言，可以和界面里任何图标并排。
- **`app/Launcher.tsx`**：
  - 品牌 mark（28）与应用名（17 semibold）改成**同一行的横向 lockup**，
    左对齐；lockup、操作条、列表行共用一条左边缘，页面只剩一条对齐轴。
  - 三张浮空卡片 → **一整块分组条**：`--card` 底、1px 描边、圆角 12，
    内部两条 1px 分隔线，每段高 72（图标 20 + 标签 13）。材质和设置页、
    对话框里的分组卡片一致，视觉上是一个物件而不是三块碎片。
  - **不要 `overflow-hidden` 裁圆角**——那会连 shadcn 的 `ring-3` 焦点环
    一起裁掉。改成首尾两段各自 `rounded-l/r-[11px]`（外圆角 12 − 1px 描边）。
  - 离线条从「红字 + outline 钮」改成 `--danger-soft` 底 + 28% danger 描边
    的一条，位置提到操作条下方（页面级状态），列表不再被它挤。
  - 拖入覆盖态：`--scrim` 罩全窗 + `inset-3` 的 1.5px 虚线品牌框 + 居中一张
    `--card` 小卡（图标 + 一行字，`--shadow-dialog`）。
- **`app/WorkspaceGrid.tsx`**：
  - `SCROLL_VIEWPORT_FIX = "[&>div[data-slot=scroll-area-viewport]>div]:!block"`
    压掉 Radix 的内联 `display: table`（`!` 才盖得住内联样式），truncate
    这才生效。**别的地方的 ScrollArea 里如果也放了要 truncate 的长文本，
    同一条要照抄。**
  - 相对时间收回名称那一行的右端常驻（`ml-auto`），行右侧固定留 40px
    (`pr-10`) 给 `⋯`，两者各占各的位置，不再互相顶掉。
  - 「最近」标题和搜索框合并成一行 h-7 的标题行（搜索仍然是 > 8 个才出现，
    出现时列表不再整体下移）；标题去掉 `uppercase`/`tracking`。
  - 空状态那一行移进滚动区内、左对齐，仍然只有一行（§14）。
- **`panels/CloneRepoDialog.tsx`**：`text-xs` → `text-[length:var(--text-caption)]`。
  其余三个对话框（NewWorkspace / NewFolder / CloneRepo）本来就符合 §24.3-5，
  没动流程也没动结构。
- `styles/tokens.css` / `app.css` **一个字没改**——新版没有需要新 token 的地方。
  i18n 也**没有新增键**（§14：界面上不加新文案）。

### 3. 验证（2026-09-04，localhost:1422）

- `node .claude/skills/impeccable/scripts/detect.mjs --json <7 个文件>` → `[]`，
  exit 0；编辑过程中的 PostToolUse hook 每次也是零告警。
- `pnpm --filter @armadra/web typecheck` 干净。
- `vitest run src/app src/panels src/ui` 102 例全绿；`src/i18n src/styles` 58 例全绿。
  `Launcher.test.tsx` 从 7 例加到 10 例，新增：空列表只有一行字且没有搜索框、
  第 9 个工作空间才长出搜索框且能筛、相对时间与 `⋯` 同时存在。
- 截图：深/浅色各一张；另外验了 hover（行 + 操作段）、Tab 焦点环（第一段的
  环完整可见、左圆角正确）、拖入覆盖态（DOM 派 `dragover`）、离线态
  （patch `window.fetch` 让 `/api/workspaces` reject + 派 visibilitychange）。

### 4. 我碰过的、可能影响别人的东西

- `app/WorkspaceGrid.tsx` 里 `useWorkspacesQuery` / `WorkspaceGridProps` /
  `activeId` 的签名和 `remove-workspace.tsx` 的导出**一个都没改**，
  `sidebar/WorkspaceTree.tsx`、`sidebar/SidebarHeader.tsx`、`app/use-board-sync.ts`
  不受影响。
- 调试时清过 localStorage 的 `armadra.workspace`，并且**把 `armadra.theme` 覆盖成了
  `system`**（原值在调试中被写坏了；`system` 就是这个键的默认值）。

### 5. 还没做

- 最近列表没有键盘快捷键（比如 `↵` 打开第一项）——§14 不让在界面上加提示，
  要做就得配合命令面板一起想。
- 首页没有骨架屏：Runtime 冷启动那一两百毫秒里最近列表是空的，然后一次性
  出现。要补的话按 operate.md 的「skeleton 而不是 spinner」。

---

## Phase 4 · link-content（白板内容接入 Agent，§6.3 全链路）

已完成（2026-09-04）。入口是新增的 `apps/web/src/canvas/content-links.ts`
（收集 + 解析 + 防抖导出）；`context-links.ts` 只多了「把这一半并进链接文档」。

### 0. 先回答用户那两条疑问

**「tldraw 貌似不能进行里面图形的连接」——不成立，实测能连。**
浏览器里用**真实鼠标**（`left_click_drag`）验的两条路径：

1. **箭头工具连两个矩形**：从矩形 A 内部拖到矩形 B 内部松手 ⇒ 一条 `arrow` shape
   - **两条 `arrow` binding**（`toId` 分别是 `shape:rectA` / `shape:rectB`，
     `normalizedAnchor {0.5,0.5}`）。把 B 从 (290,250) 挪到 (330,120)，箭头的
     `getShapePageBounds` 从 `(187.5,160,104×82)` 变成 `(200,128,117×22)`——**跟随生效**。
     这条箭头 `meta` 是空的：两端都不是节点，`LinkArrow` 一个字都没碰它。
2. **矩形 → 终端节点**：同样一次真实拖动 ⇒ 箭头**保留成 tldraw arrow**（不换成
   `link` shape），`props.color = "blue"`、`arrowheadEnd = "arrow"`（指向节点那一端）、
   `meta.armadra = { contentId: <uuid>, styled: true }`。

结论：tldraw 5.4 的 `ArrowBindingUtil` 对**任意 shape** 都能绑（`canBind` 默认 true），
连线能力从来不缺；v3 之前「连不上」的感觉来自我们自己的规则——Phase 2 的
`LinkArrow` 把「末端没绑到**节点**」的把手起笔箭头删掉了。本阶段把那条规则放宽成
「末端没绑到**任何 shape**」才删。

### 1. 判定与样式（`shapes/LinkArrow.ts`，只改了 `evaluate` 一段 + 新增一个函数）

一条 arrow 两端各自是什么，决定它是什么：

| start / end                        | 结果                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| 节点 ↔ 节点                       | 一条 `edges` 行 ⇒ 换成 `link` shape（Phase 3 的行为，一个字没改） |
| 节点 ↔ 白板 shape                 | **内容链接**（§6.3）⇒ 保留成 tldraw arrow，写一次方向与颜色       |
| 白板 ↔ 白板 / 只绑一端 / 完全没绑 | 普通白板箭头，不管                                                |

- 「白板 shape」= `text` / `geo` / `draw` / `image` / `line` / `highlight` /
  **不是分组的** `frame`（`CONTENT_TYPE_KEYS` 那张表）。表外的类型
  （`bookmark` / `embed` / `video` / 另一条 `arrow`）不算内容链接，那条箭头就是
  一条普通的白板箭头。
- 样式：颜色钉在 tldraw 的 `blue` 上。`--brand` 深色 `#0a84ff` / 浅色 `#007aff`
  都是调色板里那支蓝，而 tldraw 的 `blue` 自己就跟着明暗主题走——读 CSS 变量再走
  一次 `toTldrawColor` 反而会在浅色下掉进 `grey`（`COLOR_NAMES` 里没有 `#007aff`）。
  箭头头指向节点那一端。`meta.armadra.styled` 与边共用同一个标记，写过一次之后
  用户手改颜色 / 箭头不再被覆盖（已验）。
- **把手兜底放宽**：从把手起笔、松手时 **`end` 这一端没绑到任何 shape** 才删
  （原来是「没绑到节点」就删）。所以「从把手拖到空白处 = 取消」这条 Phase 2 的
  行为保留，而「从把手拖到一个矩形上」现在会留下一条内容链接。

### 2. 稳定 uuid：`arrow.meta.armadra.contentId`（**不是** uuid v5）

两条理由，二选一时选了它：

1. 前端没有 sha-1，uuid v5 得自己实现一份；而 arrow 本来就要写 `meta.armadra`
   （`styled`），多一个字段是零成本。
2. 导出路径是 `.armadra/exports/<uuid>.png`。id 跟着**这条连线**走时，用户把线改指
   到另一个图形只是覆盖同一个文件；跟着 shape id 走（v5）则每换一次目标就在工作区
   里留下一个再也没人读的 PNG。

`ensureContentId()` 走 `editor.run(..., { history: "ignore" })`：它是记账，不是
用户的一步操作。`LinkArrow` 在交互结束时写，`collectContentLinks()` 兜底
（远端合并进来的箭头不走 `LinkArrow` 的 `source === "user"` 分支）。

### 3. 链接文档（`content-links.ts` + `context-links.ts`）

`buildLinkDocuments(document, content?)` 多了第二个参数：白板 shape 不在
`BoardDocument` 里，纯函数看不到它们，所以这一半由 `useContentLinks()` 从 editor
收集。老调用方与老单测不受影响（默认 `{}`）。

`resolveContent()` 按类型分流（`ContextLink.content`）：

| shape                                        | `content`                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `text`                                       | `text`（`renderPlaintextFromRichText`），**不导出 PNG**                            |
| `geo` 带文字                                 | `text` + `pngPath`                                                                 |
| `image`                                      | `pngPath` = 资产的 `meta.armadra.path`（`.armadra/assets/<hash>.png`），**不导出** |
| `draw` / `line` / `highlight` / 无文字 `geo` | `pngPath`                                                                          |
| `frame`                                      | `pngPath` + **框内所有子孙的文字**拼成的 `text`                                    |

- 导出 = `editor.toImageDataUrl([id], { background: true, padding: 16, scale: 2,
format: "png" })` → `runtimeApi.exportPng(workspaceId, contentId, dataUrl)` →
  拿返回的 **`relativePath`** 当 `pngPath`（runtime 交接里点名的那条）。
- 标题：`text` 取正文前 40 字（多行压成一行，超了带 `…`），`frame` 取框名，
  其余取 i18n 的类型名（新增 `content.*` 8 个键，zh + en）。
- `text` 按**字节**截到 20 000（Runtime 校验的是字节数）。
- 一个节点的链接文档超过 64 条时截断——`contextLinksRequestSchema` 的
  `.max(64)` 会 400 掉**整份**文档，宁可少推几条。
- `sameLinks` 现在也比 `content`：正文或 PNG 路径变了要重推。

**防抖 2 秒**（`EXPORT_DELAY_MS`）：每次白板改动重排一次定时器（拖一笔手绘会产生
几十条 store 事件）。停手之后按 `shapeSignature()` 判断要不要重新导出——签名只看
会影响画面的东西（自己的 `props`/`meta`，画框还要连框内子孙的相对坐标一起看），
**不看根 shape 的 `x/y`**，所以「只是挪了个位置」不会白白导出一次。推送仍走
`PUT /context-links`（`PUBLISH_DELAY_MS` 400 那一层没动）。

### 4. 快照与加载顺序（canvas-core 留的 Phase 2 待办 2，已销）

- `sync/snapshot.ts` 的 `stripDocumentRecords` 不再剔「一端指向节点 shape 的
  binding」。现在剔的是：节点 shape、`link` shape 与 `link` binding、**两端都绑
  节点**的旧 arrow 及其 binding、以及挂在这些东西下面的**全部子孙**（原来只收一层，
  改成收敛到不动点，组里套组也算）。指向被剔掉的白板 shape 的 binding 是悬空的，
  丢掉；指向**节点** shape 的留着——白板快照是内容链接唯一的存身之处。
- 新增纯函数 **`splitPendingBindings(snapshot)`**：把「`toId` 不在快照里」的
  binding 拆成 `pending`（`fromId` 也不在的直接丢，那条箭头本身已经没了）。
- `use-store-sync.load()` 改成三步：`loadSnapshot(base)` → `mergeRemoteChanges(push)`
  投影节点 → `mergeRemoteChanges(store.put(pending))`，`put` 之前再核对一次两端
  shape 真的存在（节点这次没投影出来 = 被删了，那条 binding 就不该回来）。
- `isDocumentRecord` 里 binding 的判定从「一律算文档记录」收窄成「只有 `link`
  binding 算」：内容链接就是一条 arrow + 两条 arrow binding，改了要重存快照。

### 5. Runtime（改动很小，`read_shape` / `readable_as` 上一轮就写好了）

- `collab/context_link.rs` 新增 `kind_label()`：`list` 那一行的「类型=」不再印
  `shape` 这个线上值，印**白板内容**。其余（`readable_as("shape")`、`read_shape`
  的三种回答、工作区内解析 `pngPath`）一个字没改。
- `collab/skills.rs`：`instruction_block()`（codex / gemini / opencode 读的
  `AGENTS.md` / `GEMINI.md`）补了白板内容那一段，`SKILLS_REVISION` 2 → 3。
  `linked_context_skill()`（Claude 的 `armadra-linked-context/SKILL.md`）里那一行
  「白板内容 shape」上一轮已经有了，没动。
- `collab/tests.rs` 的 `a_linked_whiteboard_shape_reads_as_text_or_a_png_path`
  多一条断言：`list` 里出现 `类型=白板内容`。

> **`.claude/skills/get-linked-context/SKILL.md` 没有改，也改不了**：仓库里没有
> 这个文件（`grep -rn get-linked-context` 只命中 `docs/tldraw-canvas-plan.md`）。
> `~/.claude/skills/get-linked-context/` 是**另一个应用**装的技能，它的 shim 指向
> 那个应用自己的 Application Support 目录，与本仓库无关。本仓库对应的那份是 `armadra-linked-context`，由 `skills.rs` 生成，
> 已按上面改好；用户机器上那份 `~/.claude/skills/armadra-linked-context/SKILL.md`
> 还是 rev 2 的旧文案，**下次装技能时会自动刷新**（我没有去写用户的家目录）。

### 6. 我改过的非归属文件（都很小，请核对）

1. **`canvas/sync/snapshot.ts`**（canvas-core）：第 4 节，`stripDocumentRecords`
   的规则 + 新增 `splitPendingBindings`。
2. **`canvas/sync/use-store-sync.ts`**（canvas-core）：只有 `load()` 的三步与
   `isDocumentRecord` 里 binding 那一行。**没碰** `pull` / `push` / 迁移那几段
   （包括另一位刚加的 `loadedEditor` 身份校验）。
3. **`canvas/sync/derive.ts`**（canvas-core）：`ArrowArmadraMeta` 多一个可选字段
   `contentId`（只加类型与注释）。
4. **`canvas/shapes/LinkArrow.ts`**（Phase 2 · edges）：第 1 节。
5. **`i18n/canvas.ts`**：新增 `content.*` 8 个键（zh + en），只增不改。

### 7. 需要别人做的

1. **polish / 收尾**：`TldrawWorkspace.tsx` **不需要**为本阶段注册任何东西——
   内容链接的收集挂在 `usePublishContextLinks()`（已经在调）里面，通过
   `useEditorHandle()` 拿 editor，注册与注销都在 hook 自己的 effect 里。
2. **已知的小毛刺（有意为之，需要的话再改）**：删掉一个被连着的白板 shape 之后，
   tldraw 会留下**那条只剩一端绑定的 arrow**（链接文档里的那条已经正确消失了）。
   没有跟着删，因为「一端悬空的箭头」本来就是白板上的合法画法；要改的话在
   `LinkArrow` 的 `evaluate` 里补一条「`meta.armadra.contentId` 有值、又掉了一端
   绑定 ⇒ 删掉」，与 Phase 2 对边箭头的做法一致。
3. **`.armadra/exports/` 的清理**：一条内容链接被删掉之后，它的
   `<contentId>.png` 会留在工作区里。Runtime 没有「删导出」的接口，也没有 GC。
   量不大（一条线一个文件、覆盖写），但收尾时值得记一笔。

### 8. 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：**整仓零错误**。
- `pnpm --filter @armadra/web test`：**67 个文件 739 个用例全绿**
  （新增 `canvas/content-links.test.ts` 30 个：判定 10（含 10 种 shape 类型的
  可读性表）、稳定 uuid 2、标题 3、字节截断 1、文字与签名 3、`resolveContent` 6、
  **防抖 1**（假定时器：1.5 s 不导、中途再改重排、停手 2 s 导一次、只挪位置不重导、
  改内容才重导）；`sync/snapshot.test.ts` 11 → 15（内容链接的箭头与 binding 留下、
  悬空 binding 丢掉、`splitPendingBindings` 两例）+ 200 个随机用例的属性测试跟着
  改判据；`shapes/LinkArrow.test.ts` 8 → 10（内容链接的样式与方向、手改样式不被
  覆盖、把手拖到白板 shape 留着）；`canvas/context-links.test.ts` 5 → 9）。
- `cargo test -p armadra-runtime`：**317 全绿**；
  `cargo clippy -p armadra-runtime --all-targets -- -D warnings` 零告警；
  `cargo fmt --check -p armadra-runtime` 干净。开发 Runtime 已用新二进制
  重启（`127.0.0.1:43120`，`/api/health` ok）。
- 浏览器 `http://localhost:1422`（**自己新建的看板 `phase4-link-content`**，
  没碰用户的 Default 也没碰 polish 的 `phase4-polish-test`；测完看板已 DELETE、
  终端会话已 terminate、`.armadra/exports/` 与 `.armadra/assets/` 里的测试文件已删、
  `context_links` 那一行已清）：
  1. 见第 0 节：真实鼠标验的两条连线路径。
  2. 四种内容各连一条到终端节点，2 s 后库里的链接文档就是：- 矩形（geo 无文字）→ `{pngPath: ".armadra/exports/e0b5….png"}` - 文字 → `{text: "先修好构建再合并"}`，**没有** `pngPath` - 画框（内含一段文字 + 一个红矩形）→ `{text: "入口在 apps/runtime/src/main.rs",
pngPath: ".armadra/exports/4bd1….png"}`；PNG 打开看，文字与红框都在 - 图片 → `{pngPath: ".armadra/assets/bf04e51a8923ec18.png"}`，**没有导出**
  3. Agent 侧（`POST /context-link/*`，走 hook socket + `x-armadra-hook-token`）：
     `list` 四行都是「类型=白板内容 … 可读：白板内容（文字或导出的 PNG 路径）」；
     `summary --node 架构图` 回「文字 + 已导出为 PNG：<绝对路径>」，
     `--node 先修好构建再合并` 只回文字，`--node 图片` 回 `.armadra/assets/…` 的绝对路径。
  4. 保存后的 `board.whiteboard`（10 019 B）里**有** 4 条内容箭头与它们指向
     `shape:<终端 uuid>` 的 binding，**没有** `armadra` 节点 shape；刷新页面 →
     5 条箭头（4 条内容链接 + 1 条纯白板箭头）连同两端 binding 原样回来，
     `contentId` 一个没变（**往返恒等**）。
  5. 删掉那个 text shape → 2 s 后链接文档从 4 条变 3 条（那条 `31424c88…` 消失）。
  6. 深色截图：三条内容链接是蓝色、箭头都指向终端节点；矩形 ↔ 矩形那条是
     白板默认色，两端没有我们写的样式。
- **没验到的**：浅色主题下的截图（只截了深色）；`highlight` / `line` 两种类型只有
  单测覆盖，没在浏览器里连过（导出走的是和 `draw` 完全一样的那一支）。

---

## Phase 4 · polish（保存冲突 / 停用 shape / 图片迁移 / 终端复跑 / 性能 / 文档）

已完成（2026-09-04）。

### 1. 保存冲突（409）自动变基

以前多个窗口同开一块板时，后一个的 CAS 一定失败，`saveState` 直接变 `error`、
弹「看板保存失败」，用户点「重试」还会再撞一次。现在：

| 文件                        | 改动                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save/canvas-save-queue.ts` | 新增纯函数 `replayLocalEdits(remote, local)` 与 `MAX_CONFLICT_REPLAYS = 3`                                                                                     |
| `save/autosave.ts`          | `onError` 里 `isConflict(cause)` → `resolveConflict()`：`GET` 最新文档 → 重放 → 写回 store（`saveState: "dirty"`）→ 下一轮防抖重新 PUT。成功保存时清零连击计数 |
| `api/client.ts`             | **一个字没改**，`isConflict()` 本来就在（`RuntimeRequestError.status === 409`）                                                                                |

重放规则（没有三方合并的基线，只有一个可靠分界点：`local.board.updatedAt`，
也就是本地这份文档最后一次与 Runtime 对齐时的 CAS 戳）：

| 情况                                    | 结果                                                        |
| --------------------------------------- | ----------------------------------------------------------- |
| 两边都有的节点                          | **本地为准**（位置 / 尺寸 / 数据 / 标题都是用户刚拖出来的） |
| 只有远端有                              | 保留（别的窗口或 Agent 新开的）                             |
| 只有本地有，`createdAt` 晚于本地 CAS 戳 | 保留（本地新建，还没存上）                                  |
| 只有本地有，`createdAt` 早于本地 CAS 戳 | 丢弃（远端删掉了，不复活）                                  |

边同理，另外剔掉两端不齐的悬空边（Runtime 拒收），并解开指向已被远端删掉的
分组的 `parentId`。看板行取远端的（`updatedAt` 就是下一次 PUT 的 CAS 戳），
只有视口 / 看板视图 / 白板快照用本地的。

**灌进 editor 不进撤销栈**：写回 store 之后由 `sync/use-store-sync` 的文档效应
接手，它走的就是 `editor.store.mergeRemoteChanges(() => push(...))` —— 所以这里
一行 editor 代码都没写，也不用碰 link-content agent 正在改的那个文件。

单测：`save/canvas-save-queue.test.ts` +3（**「远端加了一个节点 + 本地移了一个
节点」** 的重放、远端删除不复活 / 本地新建保留、悬空边与失效父级），
`save/autosave.test.ts` +2（一次 409 的完整链路 PUT→409→GET→PUT→200 且不亮红灯、
连续三次才提示）。

### 2. 停用 `note` / `bookmark` / `embed` / `video`（§4.5）

新文件 `canvas/shapes/retired-shapes.ts`：`RETIRED_SHAPE_TYPES`、
`activeShapeUtils(utils)`、`registerRetiredShapes(editor)`。

**`<Tldraw shapeUtils>` 传一份过滤过的清单是拦不住创建的** —— 组件内部用
`mergeArraysAndReplaceDefaults("type", 自定义, defaultShapeUtils)` 把默认集合
无条件合回来（只有同名的才被替换）。所以：

- `TldrawWorkspace.tsx` 的 `shapeUtils` 改成显式清单
  （`...activeShapeUtils(defaultShapeUtils), ArmadraShapeUtil, LinkShapeUtil`）——
  它是**意图声明**，注释里写清楚了；
- 真正拦住创建的是 `onMount` 里的 `registerRetiredShapes(instance)`：
  `registerAfterCreateHandler("shape")` 命中这四种且 `source === "user"` 时，
  推到微任务里 `editor.run(..., { history: "ignore" })` 删掉。必须有这一道 ——
  从别的 tldraw 页面复制一张便签过来走的是 `putExternalContent({type:"tldraw"})`，
  不经过任何一个被覆盖的处理器；
- `overrides.tools` 里把这四个 id 从 UI 工具表删掉；
- `dnd/external-content.ts` 新增 `url` 处理器 → `defaultHandleExternalTextContent`
  （原来注释里就标好了位置），卸载时一并注销。

**schema 里仍然保留这四种 shapeUtil**：老看板的快照里可能真存着一个 `note`，
util 缺席时 `loadSnapshot` 会整份失败。停用只发生在「创建」那一刻。

单测 `canvas/shapes/retired-shapes.test.ts` 5 个；浏览器实测：`putExternalContent`
一个 `url` → **text shape**（不再是 bookmark）、不抛错；`createShapes` 一个 `note`
→ 微任务后消失，同批的 `geo` 留下。

### 3. 图片节点 `sourcePath` 迁移 + 无数据降级

`canvas/sync/migrate-legacy.ts`：

- `MigrateDeps.readSourceFile?(path): Promise<Blob|null>` **换成**
  `importAsset?(path): Promise<UploadedAsset|null>`，实现是
  `runtimeApi.importAsset(workspaceId, sourcePath)`（Phase 3 · asset-import 的
  `POST .../assets/import`）。字节由 Runtime 读盘、Runtime 哈希落盘，前端一个
  字节都不碰 —— 比原来的「读成 Blob → data URL → 再上传」省一整轮。
  导入失败（文件没了 / 不是图片 / Runtime 挂了）会 `warn` 并退回节点里内联的
  `src`；`blobToDataUrl` 随之删除。
- **新增 `stickyDowngrade(node, stamp)` 与 `MigrationResult.downgraded`**：既没有
  内联 `src`、`sourcePath` 又导不进来的 `image` 节点不再「原样保留」，而是降级成
  便签（正文写原路径，尺寸 / 位置 / 标题 / 分组 / 标签全留）。留着它等于把这块板
  判死刑：Runtime 的白名单从 Phase 3 起就不收 `image`，这块板**再也存不进去**。
  落地方式是把画布上那个「退役占位壳」原地改掉（`meta.legacy = null`、
  `props.data = {kind:"sticky", content: 路径}`），派生出来就是一行真便签。
- 上传（有 data URL 但 PUT 失败）仍然**保留原节点**并 `warn`，下次打开再试 ——
  那份 data URL 是那张图仅剩的副本，不能拿它冒险。

`canvas/sync/use-store-sync.ts`（**只动了 `migrateLegacy` 的 deps 与
`dropMigratedNodes`，没碰 `load()`**）：新增 `importAsset` 依赖；
`dropMigratedNodes` 改名 `applyMigration(boardId, result)`，除了摘掉迁走的节点行，
还把 `result.downgraded` 里的便签行替换进文档。不等派生层的理由和原来一样：
标签页不可见时 `requestAnimationFrame` 停摆，派生可以几十秒都不来。

单测 `migrate-legacy.test.ts` 19 个（原 18 + 降级两例，`readSourceFile` 两例改写成
`importAsset`；`FakeEditor` 补了 `updateShapes`）。

### 4. §18.4 终端清单复跑（自建看板，真实 tmux 终端，测完 terminate 并删板）

**修掉两处真回归**：

1. **滚轮 → tmux copy-mode 的桥整个失效**（`terminal/TerminalSurface.tsx`）。
   xterm 6 起用的是 vscode 那个 `ScrollableElement`，DOM 里多出一层
   `.xterm-scrollable-element`，它在自己的 wheel 处理里 `stopPropagation()` ——
   挂在 `[data-slot="terminal-body"]` **冒泡相位**的桥一个事件都收不到。
   实测：wheel 打到 `.xterm-screen`，`document` 捕获看得到，`terminal-body`
   冒泡看不到。改成 `{ passive: false, capture: true }`（连同 `removeEventListener`）。
   捕获相位是安全的：三条豁免（直连后端 / 内层 app 开了鼠标追踪 / xterm 自己有
   回滚内容）命中时原样放行，xterm 照旧处理；`NodeShell` 的 node-body 守卫在更外层，
   普通滚轮它不 stopPropagation，所以不会把这层饿死。
2. **OSC 标题刷新一次就永久失效**（`terminal/compat.ts` + `TerminalSurface.tsx`）。
   `oscTitles` 是进程内 Map，而 `TerminalSurface` 的清理里调了
   `forgetOscTitle(nodeId)`。刷新 / 热重载 / StrictMode 二次挂载之后表就空了，
   而节点标题早被上一轮 OSC 写成了命令名 → `shouldApplyOscTitle` 判成「用户改过名」
   → 这个终端从此不跟随标题。改成：记忆写进 `localStorage`（`armadra.oscTitles`，
   按节点 id，200 条上限，读写都带 try/catch），**卸载不再 forget**。
   `forgetOscTitle` 仍导出，语义收紧成「节点真的被删掉时才调」。
   单测 `compat.test.ts` +1（自带 localStorage stub，这个测试环境是 node）。

逐项结果（每项的证据见 `docs/implementation-status.md` 的 v4 小节）：单击 0 字节
进 PTY 且选区不变、焦点给 helper textarea ✅；拖选复制、节点与相机 Δ=0 ✅；
⌘C 写系统剪贴板、粘贴发括号粘贴序列且画布不多出 text shape ✅；滚轮走桥
（修复后）✅；resize 后 `tput cols/lines` = 36/9 与 `resize` 消息一致 ✅；
折叠展开是同一个 `.xterm` 元素、没有新 hello ✅；zoom 0.3 / 1.7 都清晰 ✅；
铃声 `data-bell` 闪一次 ✅；OSC 标题跟随、手动改名后不覆盖、刷新后仍跟随 ✅。
头部 7 个按钮**不需要 hover 就全部可见**（`getBoundingClientRect` 逐个量到）。

### 5. 性能复测与文档

数字、方法与结论都写进 `docs/implementation-status.md` 的「v4 tldraw 画布 →
验证」小节（223 shape vs 3 shape 基线，平移 111.8 / 108.7 fps，拖节点 51.8 / 61.7 fps，
堆 186 / 132 MB）。另外更新了：`architecture.md`（§2.1 新增换引擎的理由、§4/§5
标注作废、§6 前端栈、**§7 三层图改成 tldraw store → 两条持久化通道**、§8 Phase 3
标注已实施、§9 最终确认）、`tldraw-canvas-plan.md`（状态行 + §8 各阶段末尾的
「已完成」行）、`docs/README.md`（索引加上 v4 计划书与本交接记录）。

### 我改过的非归属文件（都很小，请核对）

1. **`canvas/sync/use-store-sync.ts`**（canvas-core / link-content）：只有第 3 节说的
   两处 —— `migrateLegacy()` 的 deps 加 `importAsset`，`dropMigratedNodes` →
   `applyMigration`。**`load()` 一个字没动。**
2. **`canvas/TldrawWorkspace.tsx`**（canvas-core）：`shapeUtils` 显式清单、
   `overrides.tools` 删四个工具项、`onMount` 里多注册一个 `registerRetiredShapes`。
3. **`canvas/dnd/external-content.ts`**（Phase 3 content）：新增 `url` 处理器
   （那里原本就留了注释说「停用 bookmark 之后改这一行」）。
4. **`terminal/compat.ts` / `terminal/TerminalSurface.tsx`**：第 4 节两处修复。

### 需要别人做的

1. **谁都行**：`forgetOscTitle(nodeId)` 现在没有调用点了。节点被删除时调一下最干净
   （`store/canvas-store.ts` 的 `removeNodes`，或 `TerminalNode` 的关闭流程）；
   不调也只是 `localStorage` 里留一条死记录，有 200 条上限兜着。
2. **已知边界（不打算在本轮修）**：两个窗口几乎同时提交时，409 变基保证「自己
   这一下不丢、也不弹错」，但最后落库的那份会盖掉对方刚存进去的位置，而且两个
   窗口不会自动收敛（没有 `board.changed` 驱动的重载）。白板快照同理：变基时
   `board.whiteboard` 一律用本地那份。多人协同是计划书 §2 的非目标。

### 验证记录（2026-09-04）

- `pnpm --filter @armadra/web typecheck`：**整仓零错误**。
- `pnpm --filter @armadra/web test`：**67 个文件 740 个用例全绿**。
- `pnpm --filter @armadra/shared test`：63 全绿。
- `cargo test -p armadra-runtime`：**317 全绿**；
  `cargo clippy --all-targets -- -D warnings`：零告警（Rust 侧本轮一行没改）。
- 浏览器 `http://localhost:1422`（自己的 tab，两块自建看板 `phase4-polish-test` /
  `phase4-shapes-test`，两个终端会话已 `terminate`、两块板已 `DELETE`，
  `armadra.board` 已还原成用户的 Default）。
- **环境干扰说明**：`localStorage` 的 `armadra.board` 是全应用共享的，验证途中被别的
  tab 改回过用户的 Default 一次（当时立刻切走，没有在用户的板上做任何写操作）。
  后来者验证时每次 reload 前都重新 `setItem` 一遍自己的看板 id。
