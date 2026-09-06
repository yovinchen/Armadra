# 画布换成 React Flow（替换 tldraw 5.4）

> 状态：目标设计。本文是 [tldraw 画布契约](../history/tldraw-canvas-plan.md)的替代方案：把画布引擎从 tldraw 5.4 整体换成 React Flow（`@xyflow/react`，MIT），白板层自写。tldraw 契约的 §N 编号仍被源码注释引用，该文件保留不动；本文实施完成后由收尾批把它标为「已被取代」并移入 `history/`。
> 范围：`apps/web/src/canvas/` 及画布外的 tldraw 依赖、`boards.whiteboard_json` 的新格式与客户端一次性转换、实施批次与验收。Runtime、Host、`proto/`、数据库迁移一概不改（§3.5 给出核实结果）。
> 输入：2026-09-06 基线 `1a212504` 的代码盘点（`apps/web/src/canvas` 80 个文件、源码 9,186 行、测试 6,536 行、`vitest` 343 项 / 35 个测试文件；全树 40 个文件 import `tldraw` / `@tldraw/*`，其中非测试 32 个）；`@xyflow/react` 12.11.3（MIT，pnpm store 里已有），`perfect-freehand`（MIT）。

## 0. 结论

| 决定     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 为什么换 | tldraw 5.4 的 `LicenseProvider` 在非开发来源（打包桌面的 `tauri://localhost`、Windows 的 `http://tauri.localhost`）上没有密钥时挂载 5 秒后卸掉整个编辑器（实施记录已确认，画布与终端 socket 一起消失）。`tldraw` / `@tldraw/editor` 是 tldraw 自有许可证；`@tldraw/tlschema` / `@tldraw/store` 虽为 MIT，单独留下没有意义。React Flow 是 MIT，无许可门，v3 时代已经在本项目跑过一年（`canvas/geometry.ts`、`tidy.ts`、`connection.ts`、`viewport.ts`、`zoom.ts` 的纯函数就是那时留下的）。 |
| 真相模型 | **`canvas-store` 重新成为唯一内存真相**（v3 规则）。React Flow 是受控视图：`nodes` / `edges` 由 `document.nodes / edges` 与白板文档投影出来，用户手势经 `onNodesChange` 等回调翻译成 `canvas-store` 动作。tldraw 时代「editor 是真相、文档反向派生」的双轨（`sync/use-store-sync.ts`）整个删除。                                                                                                                                                                                           |
| 白板层   | 墨迹、文字、几何形、图片、直线/箭头**全部是 React Flow 节点**（类型 `wb.*`，id 前缀 `wb:`），与 Agent 节点共用视口、选区、框选、拖动、缩放、层级、复制粘贴与撤销栈；它们不进 `nodes` 表，存在 `whiteboard_json`。墨迹用 `perfect-freehand` 生成轮廓，SVG 渲染。                                                                                                                                                                                                                            |
| 保留     | 7 种节点与节点体代码、`canvas-store` 全部动作签名、`nodes` / `edges` 表与 Runtime 接口、上下文连线的贴边贝塞尔与箭头语义、内容引用（白板对象 → Agent，`ContextLink.kind = "shape"` 契约不变）、Frame↔worktree 绑定、整理排布、锁定、Esc 回选择、缩略图状态描边、右键三套菜单、拖放与粘贴规则、白板偏好的大部分、快捷键表、手机焦点页。                                                                                                                                                    |
| 放弃     | tldraw 特有能力：旋转、富文本（tiptap）、手写体字体、云朵等 14 种非常用几何形、弯曲/肘形箭头、曲线样条、图片裁剪与翻转、Frame 裁剪子级、`note` / `bookmark` / `embed` / `video`、tldraw 调试面板、增强辅助模式、缩放方向反转、「手绘 / 整洁」风格档。转换时能降级的降级（§3.2），不能的丢弃并一次性告知用户。                                                                                                                                                                              |
| 数据契约 | `whiteboard_json` 仍是**不透明、带版本的 JSON 字符串**（§3.1 v2 格式，`{"engine":"armadra-flow","version":2,…}`）。Runtime 与 Host 只看长度与摘要，已逐文件核实（§3.5）；不新增迁移，不改 `proto/`。旧 tldraw 快照在客户端加载时一次性转换，下一次保存写回；转换前先把原文备份到工作区 `.armadra/imports/`（§3.3）。                                                                                                                                                                       |
| 归属标识 | React Flow 右下角的「React Flow」归属链接保留（MIT 礼节，不传 `proOptions.hideAttribution`）；缩略图与锁按钮为它让出 24px。                                                                                                                                                                                                                                                                                                                                                                |
| 实施     | 6 个批次（§5）：B0 骨架 + 节点承载 + store 同步（串行）→ B1 连线 / Frame / 整理 / 覆盖层 ‖ B2 白板层 ‖ B3 tldraw 快照转换 → B4 菜单 / 偏好 / Dock / 手机 / 清理 ‖ B5 内容引用 → B6 验收与文档。独立分支 `feature/canvas-react-flow` 完成后合入 `main`。                                                                                                                                                                                                                                    |
| 不做     | 多人协同；白板对象的实时合并（保存冲突时白板整块以本地为准，沿用 `save/canvas-save-queue.ts` 的既有局限）；Runtime 解析白板；把墨迹渲染搬进 Rust；手机上的绘图工具（只保留平移、缩放、选择、焦点页）。                                                                                                                                                                                                                                                                                     |

## 1. 范围与现状

### 1.1 现状盘点

| 区域         | 文件                                                                                                                                                                                                                                                                                                               | tldraw 依赖形态                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 装配         | `canvas/TldrawWorkspace.tsx`（685 行）                                                                                                                                                                                                                                                                             | `<Tldraw>`、组件槽位、`TLUiOverrides`、相机选项、右键命中、命令表注册               |
| 同步         | `canvas/sync/{project,derive,snapshot,use-store-sync,pushed}.ts`                                                                                                                                                                                                                                                   | 文档 ⇄ shape 投影、白板快照过滤、`mergeRemoteChanges`                               |
| 自定义 shape | `canvas/shapes/{ArmadraShapeUtil,LinkShapeUtil,NodeArrowShapeUtil}.tsx`、`{LinkArrow,LinkBindingUtil,armadra-shape,link-shape,link-path,retired-shapes}.ts`、`ConnectionHandles.tsx`                                                                                                                               | `ShapeUtil` / `BindingUtil` / `sideEffects` / `T` 校验器 / 全局类型注册             |
| 白板内容     | `canvas/content-links.ts`（623 行）、`create-content-reference.ts`、`assets.ts`、`dnd/external-content.ts`（563 行）、`dnd/os-drop.ts`、`menus/{add-menu,shape-menu}`、`StylePanel.tsx`、`escape-to-select.ts`、`tidy-editor.ts`                                                                                   | `editor.*` API、`TLAssetStore`、`putExternalContent`、`renderPlaintextFromRichText` |
| 覆盖层       | `canvas/overlays/{CanvasOverlays,StatusMinimap,CanvasNavigationPanel,WorktreeBindingBadge}.tsx`、`minimap.ts`、`SubagentLayer.tsx`、`derived-edges.ts`                                                                                                                                                             | `components.OnTheCanvas` / `Minimap` 槽位、`react()` 订阅                           |
| 画布外       | `app/use-tldraw-preferences.ts`、`shell/Dock.tsx`、`shell/DockTools.tsx`、`store/canvas/{internal,nodes,selectors}.ts`（直接 import）；`store/canvas/{selection,view,edges,layout}.ts`、`save/autosave.ts`、`files/use-workspace-file-drag.ts`、`nodes/NodeShell.tsx`、`panels/viewport.ts`（经 `editor-context`） | `editor.user.updateUserPreferences`、`useValue`、`editor.getCamera` 等              |
| 样式与文案   | `styles/canvas.css`（317 行，30 处 `.tl-*` / `.tlui-*`）、`i18n/canvas.ts`（含 tldraw 词典补丁与 `wb.*` 偏好文案）、`i18n/commands.ts`                                                                                                                                                                             | 变量映射与槽位换肤                                                                  |
| 构建         | `apps/web/package.json`（`tldraw`、`@tldraw/assets`、`@tldraw/tlschema` 5.4.0）、`vite.config.ts`（`tldraw` 分组、`optimizeDeps.exclude`）、`app/test-setup.ts`（`matchMedia` 桩）                                                                                                                                 | —                                                                                   |
| 不受影响     | `nodes/*Node.tsx` 节点体、`terminal/`、`packages/shared`（`whiteboard` 字段、`contextLinkSchema`）、`apps/runtime`、`apps/host`、`proto/`、`tools/canvas-ownership-e2e.mjs`（白板按字节往返）                                                                                                                      | 只有注释里的「tldraw 计划 §N」引用                                                  |

### 1.2 能力清单与映射

从代码逐项核对；「批次」指 §5 的实施批。React Flow 的 API 名以 12.11.3 的 `dist/esm/types/component-props.d.ts` 为准（`ViewportPortal`、`NodeResizer`、`MiniMap`、`useReactFlow`、`useViewport`、`useOnViewportChange`、`getNodesBounds`、`getViewportForBounds`、`ConnectionMode`、`SelectionMode`、`useConnection`、`useInternalNode`、`onlyRenderVisibleElements`、`zoomActivationKeyCode`、`panActivationKeyCode`、`selectionOnDrag`、`deleteKeyCode`、`nodeDragThreshold`、`autoPanOnNodeDrag`、`snapToGrid`、`isValidConnection`、`onNodeDragStop`、`getIntersectingNodes`、`screenToFlowPosition`、`fitBounds`、`setCenter`、`zoomTo`）。

| 编号 | 能力                                                                                                            | 现在的实现                                                                                          | React Flow 方案                                                                                                                                                                                                                                                                                                                                               | 批次 |
| ---- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| F01  | 7 种节点承载（终端 / 便签 / 编辑器 / 差异 / 文件 / 浏览器 + 自动化两卡）                                        | `ArmadraShapeUtil` 把 `NODE_BODY[nodeType]` 挂进 `HTMLContainer`                                    | 一种自定义节点类型 `armadra`（`flow/nodes/ArmadraNode.tsx`），`data` 直接是 `CanvasNode`；显式 `width/height`；`dragHandle: ".drag-handle"`（头部）；`onlyRenderVisibleElements=false`（终端不能卸载）                                                                                                                                                        | B0   |
| F02  | 节点体不被画布抢事件（终端点击 / 滚轮走 tmux 桥）                                                               | `NodeShell.useNodeBodyGuards`：合成事件 `stopPropagation` + 原生两相滚轮守卫、`pointsAtOverlay`     | 拖拽只从 `dragHandle` 起，体内不再拦指针；体加 `nowheel` 类（`noWheelClassName`）挡普通滚轮；捕获相位把 ⌘/Ctrl+滚轮转发到 `.react-flow__pane`（d3-zoom 挂载处，实施时以 `ZoomPane` 源码为准）以保住缩放；`pointsAtOverlay` 删除（`NodeResizer` 把手是 DOM 元素，不与体重叠）                                                                                  | B0   |
| F03  | resize、最小尺寸、折叠 40px、展开高度记忆                                                                       | `ArmadraShapeUtil.onResize` + `NODE_META.minSize`                                                   | `<NodeResizer minWidth minHeight isVisible={selected}>`，折叠时禁纵向把手；`onResizeEnd` → `store.resizeNode`                                                                                                                                                                                                                                                 | B0   |
| F04  | 最大化 / 还原（改真实 rect，记 `premaxRect`）                                                                   | `store.maximizeNode` + `NodeShell.maximizeRect`（读 tldraw 视口）                                   | `maximizeRect` 改读 `getFlow().getViewport()` 与容器尺寸；store 动作不变                                                                                                                                                                                                                                                                                      | B0   |
| F05  | 分组 = Frame（标题、色带、拖进拖出换父、删组不删组员）                                                          | tldraw 原生 `frame`，`meta.armadra` 装标签 / 批注 / 绑定                                            | 节点类型 `group`（`flow/nodes/GroupNode.tsx`）：RF 子流——组员 `parentId` + 相对坐标（与文档约定一致）；拖动结束用 `getIntersectingNodes` + 现有 `geometry.hitTestGroup` 自动换父（`store.setParent`）；**不裁剪子级**（差异，§1.3）；组不能进组（沿用 store 规则）                                                                                            | B1   |
| F06  | 上下文连线：把手起笔、贴边贝塞尔、箭头指向可读端、中点标签、合法性                                              | `ConnectionHandles` 切 `arrow` 工具 → `LinkArrow` 换形为 `link` shape；几何在 `link-path.ts`        | `ConnectionHandles` 变成两个 `<Handle type="source" id="left/right">`；节点整体套一个只在 `useConnection().inProgress` 时可命中的 `<Handle type="target" id="body">`；`ConnectionMode.Loose`；`isValidConnection` 走 `connection.isValidLink`；`onConnect` → `store.addEdge`；自定义边 `LinkEdge` 用 `useInternalNode` 取两端矩形套 `linkCurve`，不用把手坐标 | B1   |
| F07  | 派生边（rope / subagent）与子代理卡片不入库                                                                     | `components.OnTheCanvas` 里的 `CanvasOverlays`（页面坐标 SVG + 绝对定位卡片）                       | `<ViewportPortal>` 内渲染同一组件；坐标仍是画布坐标，`derived-edges.ts`、`SubagentLayer.ts` 纯函数原样保留                                                                                                                                                                                                                                                    | B1   |
| F08  | Frame ↔ worktree 绑定徽章、初始化脚本、修复提示                                                                | `WorktreeBindingLayer` 挂在 `CanvasOverlays`；纯函数 `frame-binding.ts`                             | 徽章改渲染在 `GroupNode` 头部下方（不再需要页面坐标换算）；`frame-binding.ts` 不动；`FrameReferenceBadges` 同样搬进 `GroupNode`                                                                                                                                                                                                                               | B1   |
| F09  | 整理排布（连通分量 + 视口宽高比裹行）、整理后 fit                                                               | `tidy.ts` 纯函数 + `tidy-editor.ts`（读 editor 全部 shape）                                         | `tidy.ts` 不动；`tidy-editor.ts` 改为 `tidy-flow.ts`：从 store 取顶层节点与白板对象的矩形、连线与引用当链接，输出 `moveNodes` + `whiteboard.moveItems` 一次提交（一条历史）                                                                                                                                                                                   | B1   |
| F10  | 视口：100% 打开、适应视图只缩不放、⌘0/⌘=/⌘-、居中到节点、缩放 0.1–3                                             | `viewport.ts` / `zoom.ts` 纯函数；`TldrawWorkspace` 相机节流 300ms；`Dock.zoomToLevel`              | RF 视口 `{x,y,zoom}` 与 `Viewport` 同一语义（tldraw 时代要乘除缩放的换算删除）；`useOnViewportChange` 节流 300ms → `setViewport`；`fitView` 用 `getNodesBounds` + `getViewportForBounds` 后 `zoom = min(zoom, 1)`；`zoomTo` / `setCenter` 带 `duration`；`minZoom=0.1 maxZoom=3`                                                                              | B0   |
| F11  | 手势：滚轮平移（Shift 横向）、⌘/Ctrl+滚轮与捏合缩放、空格 / 中键拖平移、左键空白框选、Shift 多选                | tldraw `cameraOptions.wheelBehavior:"pan"`                                                          | `panOnScroll zoomOnScroll={false} zoomOnPinch zoomActivationKeyCode={["Meta","Control"]} panActivationKeyCode="Space" panOnDrag={[1]} selectionOnDrag multiSelectionKeyCode="Shift" zoomOnDoubleClick={false} nodeDragThreshold={4}`；输入设备偏好为 `mouse` 时 `zoomOnScroll` 开、`panOnScroll` 关                                                           | B0   |
| F12  | 锁定视图（锁相机、白板工具置灰）                                                                                | `canvas-lock.ts` + `editor.setCameraOptions({isLocked})`                                            | `canvas-lock.ts` 不动；锁定时 `panOnDrag panOnScroll zoomOnPinch zoomOnScroll` 全关、`zoomActivationKeyCode=null`；工具组置灰规则 `isToolDisabledWhenLocked` 不动                                                                                                                                                                                             | B0   |
| F13  | 只有一个键盘监听器（`keybindings.ts`）；Delete / ⌘Z / ⌘A / ⌘D 走 `canvas.*`                                     | `overrides` 清空 tldraw 的 `kbd`                                                                    | `deleteKeyCode={null} selectionKeyCode={null}`（框选靠 `selectionOnDrag`）；RF 只保留 Shift 多选与 Space 平移两个键；其余全部经 `registerCanvasCommands`                                                                                                                                                                                                      | B0   |
| F14  | Esc 回选择工具                                                                                                  | `escape-to-select.ts`（绕 tldraw 两个 bug）                                                         | 同名模块简化：window 冒泡相位监听，焦点在画布或 body、无 Radix 菜单、不在文字编辑时 `toolStore.setTool("select")`                                                                                                                                                                                                                                             | B0   |
| F15  | 撤销 / 重做（拖动一次一条；Agent 远端建的节点不被撤掉）                                                         | `editor.undo()`；`mergeRemoteChanges` 不进栈                                                        | 自写 `history/`（§2.7）：按实体的反向补丁；`setDocument` / 远端事件 / 保存变基 `history:"ignore"`；拖动、resize、文字编辑各在手势结束时提交一条                                                                                                                                                                                                               | B0   |
| F16  | 选择：混合多选、`selectedNodeIds` 只装节点                                                                      | `use-store-sync` 的 `react("armadra selection")`                                                    | `onSelectionChange` → `selectNodes(节点 id)` + `whiteboard.select(item id)`；`store.selectNodes` 反向写 RF 的 `selected`（投影时按 store 标记）                                                                                                                                                                                                               | B0   |
| F17  | 删除分流：节点（有会话先确认）/ 边 / 白板对象                                                                   | `tools.splitSelectionForDelete`                                                                     | 同一函数改成按 id 前缀分流（`wb:` / 边 id / 节点 id）；确认框与 `endSessionsOf` 原样搬到 `FlowWorkspace`                                                                                                                                                                                                                                                      | B0   |
| F18  | 右键：空白 = 新建菜单；节点 = 节点菜单；白板对象 = 对象菜单；边 = 删除连线                                      | 容器 `onContextMenu` + `getShapeAtPoint`                                                            | `onPaneContextMenu` / `onNodeContextMenu` / `onEdgeContextMenu` / `onSelectionContextMenu` 分别设菜单目标；三套 Radix 菜单内容不变，`shape-menu.tsx` 改名 `item-menu.tsx`                                                                                                                                                                                     | B4   |
| F19  | 复制（⌘D 复制节点）                                                                                             | `store.duplicateNodes`；白板走 tldraw 内置 ⌘C/⌘V                                                    | 保留 ⌘D；新增 `canvas.copy / cut / paste`（⌘C/⌘X/⌘V，`allowInTerminal=false allowWhileTyping=false`）：白板对象与非终端节点序列化为 `armadra/canvas@1` JSON 写系统剪贴板；粘贴按 `pasteAtCursor` 偏好落点；外部文本 / 图片粘贴沿用 F27 规则                                                                                                                   | B2   |
| F20  | 缩略图：按 Agent 状态描边、点击定位、可收起                                                                     | `StatusMinimap`（自绘 canvas）+ `CanvasNavigationPanel`                                             | RF `<MiniMap pannable zoomable nodeColor nodeStrokeColor nodeStrokeWidth onNodeClick>`，颜色函数复用 `minimap.ts` 的 `minimapStroke`；收起状态与 `minimap-preferences` 不变；位置右下、为归属链接让位                                                                                                                                                         | B1   |
| F21  | Dock 工具组：选择 / 手 / 画笔 / 高亮 / 形状（下拉）/ 直线 / 箭头 / 文字 / 画框 / 图片；当前工具高亮；键 V/H/D/… | `tools.ts` 表 + `editor.setCurrentTool`；`DockTools` 用 `useValue`                                  | `tools.ts` 表不动（id 改为我们自己的工具 id，集合相同）；工具状态在 `interaction/tool-store.ts`（`useSyncExternalStore`），Dock / 快捷键 / 命令面板同一入口                                                                                                                                                                                                   | B2   |
| F22  | 墨迹（画笔）、高亮                                                                                              | tldraw `draw` / `highlight` shape                                                                   | `wb.ink` 节点：点集（相对原点，`[x,y,pressure]`）+ `perfect-freehand` 轮廓 → SVG path；高亮 = 粗、半透明、`mix-blend-mode`；绘制时 `InkTool` 覆盖层捕获指针，进行中笔迹画在 `<ViewportPortal>`，松手落成节点                                                                                                                                                  | B2   |
| F23  | 几何形（矩形 / 椭圆 / 菱形 / 三角 / 六边 / 星）+ 标签                                                           | tldraw `geo`                                                                                        | `wb.shape` 节点（SVG），`NodeResizer` 调整；双击编辑标签（plain text）                                                                                                                                                                                                                                                                                        | B2   |
| F24  | 文字                                                                                                            | tldraw `text`（富文本）                                                                             | `wb.text` 节点：纯文本、自动高度、`NodeResizer` 只调宽；双击进入 `Textarea`（shadcn）编辑，Esc / 失焦提交                                                                                                                                                                                                                                                     | B2   |
| F25  | 直线 / 箭头                                                                                                     | tldraw `line` / `arrow`（可绑定）                                                                   | `wb.line` 节点：两个或多个点、两端箭头开关；不绑定任何对象（差异）                                                                                                                                                                                                                                                                                            | B2   |
| F26  | 图片：拖入 / 粘贴 / 按路径导入，字节走资产接口                                                                  | `assets.ts` 的 `TLAssetStore` + `external-content.createImageShapes`                                | `wb.image` 节点：`assetPath`（工作区相对）+ 尺寸；上传逻辑保留在 `assets.ts`（去掉 `TLAssetStore` 形状），显示 URL 由 `runtimeApi.assetUrl` 现算                                                                                                                                                                                                              | B2   |
| F27  | 外部内容分流：图片 → 图片；文本 / URL → 文字；OS 文件 → editor / files 节点；工作区文件树拖入                   | `registerExternalContent` 覆盖 tldraw 的 `files/text/url` 处理器 + `os-drop.ts`                     | 拖放与粘贴都由我们自己接（RF 不接管 drop / paste）：`dnd/external-content.ts` 去掉 tldraw 分支，`os-drop.ts` 的 `onDrop` 成为唯一入口；规则表不变                                                                                                                                                                                                             | B2   |
| F28  | 样式面板：颜色 / 粗细 / 虚实 / 填充 / 箭头 / 对齐                                                               | tldraw `DefaultStylePanel` 换肤                                                                     | 自写 `whiteboard/StylePanel.tsx`（shadcn `Popover` / `ToggleGroup` / `Tooltip`），显隐规则 `shouldShowStylePanel` 不变；改「下一个对象的样式」或选中对象的样式                                                                                                                                                                                                | B2   |
| F29  | 内容引用：白板对象 → Agent（右键「引用到 Agent」、拖线、64 上限、文字 + PNG、串行发布、重试）                   | `content-links.ts` + `create-content-reference.ts`（tldraw arrow + binding，`toImageDataUrl` 导出） | 引用 = RF 边类型 `reference`（存 `whiteboard_json.references`，不是 `edges` 行）；PNG 由自写栅格化器 `whiteboard/raster.ts` 生成；发布 / 缓存 / 重试状态机原样保留（§2.5）                                                                                                                                                                                    | B5   |
| F30  | 白板偏好：背景、网格、吸附、动态尺寸、动画、工具锁、换行、聚焦、边缘滚动、粘贴至光标、输入设备、默认颜色 / 粗细 | `use-tldraw-preferences.ts` 双向同步                                                                | `app/use-canvas-preferences.ts` 单向：偏好 → RF props / 工具默认；映射表 §2.10；四项无对应者删除（调试、增强辅助、缩放反转、风格档）                                                                                                                                                                                                                          | B4   |
| F31  | 画布偏好菜单（右上工具簇）与设置 → 白板页                                                                       | `CanvasPreferencesMenu.tsx`、`WhiteboardPage.tsx`                                                   | 同一表驱动，删掉四项；文案 zh/en 同步删                                                                                                                                                                                                                                                                                                                       | B4   |
| F32  | 手机：触控平移 / 捏合、选中后进入焦点页、Dock 紧凑工具面板                                                      | tldraw 触控 + `MobileFocusPage`                                                                     | RF 触控由 d3-zoom 提供（`panOnDrag` 单指、`zoomOnPinch` 双指）；手机上工具组只留选择 / 手（`isCompactLayout()`），绘图工具不开放；焦点页不变                                                                                                                                                                                                                  | B4   |
| F33  | 会话侧栏 / 命令面板居中到节点                                                                                   | `CENTER_NODE_EVENT` + `centerOnNode`                                                                | `flow-context.ts` 保留同名事件；`setCenter(box.center, {zoom: max(z, 0.6), duration: 200})`                                                                                                                                                                                                                                                                   | B0   |
| F34  | 自动保存：白板在保存那一刻序列化；8 MiB 上限；409 变基                                                          | `captureWhiteboard(editor)` → `stripDocumentRecords`                                                | `whiteboard/serialize.ts`：`serializeWhiteboard(doc)`；上限与变基逻辑不变（`replayLocalEdits` 里白板仍取本地）                                                                                                                                                                                                                                                | B0   |
| F35  | 远端改动（Agent 开节点、另一窗口）灌入不进撤销栈                                                                | `mergeRemoteChanges`                                                                                | `setDocument` 走 `history:"ignore"`；RF 是受控视图，投影自动更新                                                                                                                                                                                                                                                                                              | B0   |
| F36  | 归属切换 / 只读态                                                                                               | `canvas-ownership` 网关；`importTargetIsActive` 检查 `editor.getIsReadonly`                         | 只读时 `nodesDraggable={false} nodesConnectable={false} elementsSelectable` 保留、工具组置灰；`importTargetIsActive` 改读 `canEditCanvas`                                                                                                                                                                                                                     | B0   |
| F37  | 网格 / 点阵背景与画布底色偏好                                                                                   | `.tl-grid` 换肤 + `--canvas-bg` / `--canvas-dot`                                                    | `<Background variant="dots" gap={gridSize} color="var(--canvas-dot)">`；底色仍是容器上的 `--canvas-bg`                                                                                                                                                                                                                                                        | B0   |
| F38  | 国际化                                                                                                          | `i18n/canvas.ts`（含 tldraw 词典补丁）                                                              | 删除 tldraw 词典补丁与四项偏好文案；新增复制 / 粘贴、样式面板、转换提示文案；zh / en 同步                                                                                                                                                                                                                                                                     | B4   |

### 1.3 用户可感知的差异

| 差异                                                                     | 处理                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| 旋转不再支持；旧快照里的旋转对象按未旋转落位                             | 转换报告里列出（§3.3），对象仍在原包围盒              |
| 文字是纯文本，不再有加粗 / 列表 / 链接；字体固定为应用字体栈（无手写体） | 转换时富文本压成纯文本，换行保留                      |
| 几何形只保留 6 种；云朵、箭头形、心形等转成矩形并保留标签                | 转换报告                                              |
| 白板箭头不再吸附到对象上；弯曲 / 肘形箭头变直线                          | 转换报告                                              |
| Frame 不裁剪子级（组员拖出边界仍可见，拖出即换父）                       | 文档说明；组员 `extent` 不设 `"parent"`               |
| 点击节点体会选中节点（tldraw 时代体内点击不改选区）                      | 有意为之：⌘方向键焦点导航从此不必先点头部             |
| 图片不再有裁剪 / 翻转；旧图按可见像素栅格化后作为新资产                  | 转换时经 `raster.ts` 导出并上传，失败则整张丢弃并报告 |
| 缩略图由 React Flow 绘制：矩形按状态描边保留，白板对象一律低对比         | 与现状一致                                            |
| 右下角多一个「React Flow」链接                                           | 保留                                                  |

## 2. 架构与契约

### 2.1 内存真相与同步

```text
                 ┌──────────────── 内存真相：canvas-store ────────────────┐
                 │ document.nodes / edges（nodes、edges 表）               │
                 │ whiteboard: WhiteboardDoc（items、references，§3.1）    │
                 │ selectedNodeIds、selectedItemIds、maximized、viewport   │
                 └───────┬──────────────────────────────┬────────────────┘
        投影（useMemo，纯函数）│                              │ 保存那一刻序列化
                         ▼                              ▼
     React Flow nodes / edges（受控）           PUT …/document { nodes, edges,
       ├─ armadra / group 节点 ← document.nodes    viewport, whiteboard: v2 JSON }
       ├─ wb.* 节点           ← whiteboard.items
       ├─ link 边             ← document.edges
       └─ reference 边        ← whiteboard.references
                         ▲
       手势回调（onNodesChange / onNodeDragStop / onResizeEnd / onConnect /
       onSelectionChange / 工具覆盖层）→ canvas-store 动作 → history 记录
```

四条规则：

1. **画布修改一律经 `canvas-store` 动作**（AGENTS.md）。React Flow 的回调只做翻译，不持有状态；`applyNodeChanges` 不用于持久字段。
2. **手势中的临时位置不进文档。** 拖动 / resize 进行中的坐标放在 `flow/drafts.ts`（模块级 Map + `useSyncExternalStore`），投影时覆盖到 RF 节点上；`onNodeDragStop` / `onResizeEnd` 才调 `moveNodes` / `resizeNode` / `whiteboard.moveItems`，一次手势一条历史。
3. **投影是纯函数且按对象身份缓存。** `sync/project.ts`：`projectNodes(document, whiteboard, drafts, selection) → Node[]`、`projectEdges(document, whiteboard, selection) → Edge[]`；`CanvasNode` 对象没换就复用上一次的 RF 节点对象，避免 30 个终端因一次相机移动全量重渲。
4. **远端灌入不进撤销栈。** `setDocument`、WS 事件重载、保存变基走 `history: "ignore"`；本地动作默认记录。

### 2.2 节点模型

| RF 节点类型 | 来源                         | id          | `data`       | 尺寸                                 | 可拖 | 可连   | 可 resize                 | 备注                                            |
| ----------- | ---------------------------- | ----------- | ------------ | ------------------------------------ | ---- | ------ | ------------------------- | ----------------------------------------------- |
| `armadra`   | `document.nodes`（非 group） | 节点 uuid   | `CanvasNode` | `size` 或 `defaultNodeSize`；折叠 40 | 头部 | 是     | 是（`NODE_META.minSize`） | `NODE_SHELL_SELF` 规则不变                      |
| `group`     | `document.nodes`（group）    | 节点 uuid   | `CanvasNode` | `size`                               | 整块 | 否     | 是                        | 子节点 `parentId` 指向它；`zIndex` 低于普通节点 |
| `wb.ink`    | `whiteboard.items`           | `wb:<uuid>` | `InkItem`    | 点集包围盒                           | 整块 | 引用端 | 是（缩放点集）            | `perfect-freehand`                              |
| `wb.text`   | `whiteboard.items`           | `wb:<uuid>` | `TextItem`   | 宽固定，高自动                       | 整块 | 引用端 | 只调宽                    | 双击编辑                                        |
| `wb.shape`  | `whiteboard.items`           | `wb:<uuid>` | `ShapeItem`  | `w/h`                                | 整块 | 引用端 | 是                        | 6 种 geo                                        |
| `wb.image`  | `whiteboard.items`           | `wb:<uuid>` | `ImageItem`  | `w/h`                                | 整块 | 引用端 | 是（锁比例）              | 字节在 `.armadra/assets/`                       |
| `wb.line`   | `whiteboard.items`           | `wb:<uuid>` | `LineItem`   | 点集包围盒                           | 整块 | 否     | 否（拖端点）              | 端点把手自绘                                    |

`wb.*` 节点的 `parentId` 可以是 `group` 节点（Frame 内的白板内容），坐标相对 Frame；`whiteboard_json` 里以节点 uuid 记 `parentId`。加载时先投影 `document.nodes`，白板对象随后投影，父级不存在的对象退回页面级（与现状 `restorePendingRecords` 的兜底一致）。

### 2.3 边模型

| RF 边类型   | 来源                    | 持久化            | 两端                      | 画法                                                                                                                  |
| ----------- | ----------------------- | ----------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `link`      | `document.edges`        | `edges` 表        | 两个节点（含 group）      | `LinkEdge`：`link-path.linkCurve` 贴边贝塞尔、箭头按 `edgeArrowheads`、中点标签按 `edgeLabelKey`，缩放 < 0.5 隐藏标签 |
| `reference` | `whiteboard.references` | `whiteboard_json` | 一端 `wb.*`、一端终端节点 | 直线 + 单箭头指向节点，颜色 `--muted-foreground`，可选中可删                                                          |

派生边（rope / subagent）不是 RF 边，仍在 `<ViewportPortal>` 里画。

`isValidConnection(connection)` 的判定表：

| source → target      | 结果                                                        |
| -------------------- | ----------------------------------------------------------- |
| 节点 → 节点          | `connection.isValidLink`（自连、重复拒绝）→ `store.addEdge` |
| 节点 → `wb.*` 或反向 | 引用；`referenceCountForNode ≥ 64` 拒绝并 toast             |
| `wb.*` → `wb.*`      | 拒绝（用直线 / 箭头工具）                                   |
| 任一端是 group       | 只允许作为 `link` 的一端（现状）                            |

### 2.4 白板层

`whiteboard/` 是画布下的一级子包，只依赖 `@armadra/shared`、`perfect-freehand` 与 `flow/flow-context`：

| 文件                                                        | 内容                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.ts`                                                  | `WhiteboardDoc`、`Item` 联合类型、`Reference`、zod 校验（§3.1）                                                                                                                                                        |
| `store.ts`                                                  | `whiteboard` slice 挂进 `canvas-store`：`addItems / updateItem / moveItems / resizeItem / removeItems / reorder / select / addReference / removeReferences / setWhiteboard(doc)`；每个动作经 `commit` 置脏并记历史     |
| `serialize.ts`                                              | `serializeWhiteboard(doc): string`、`parseWhiteboard(text): ParsedWhiteboard`（v2 / tldraw / 未知三态，§3.3）                                                                                                          |
| `ink.ts`                                                    | `strokeOutline(points, options)`（`perfect-freehand.getStroke`）、`outlineToPath`、`simplifyPoints`、`inkBounds`、`scaleInk`                                                                                           |
| `geometry.ts`                                               | 6 种几何形的路径、`lineBounds`、`hitTestItem`（右键 / 引用命中用）                                                                                                                                                     |
| `raster.ts`                                                 | `rasterizeItems(items, {scale:2, padding:16, background}) → Blob`：`OffscreenCanvas`（回退 `HTMLCanvasElement`），墨迹用 `Path2D` 填充，图片经 `fetch` → `createImageBitmap`（不污染画布），文字用 `fillText` 简易折行 |
| `nodes/{InkNode,TextNode,ShapeNode,ImageNode,LineNode}.tsx` | 每种 ≤ 200 行；共用 `ItemFrame`（选中框、`NodeResizer`、`nodrag` 的编辑区）                                                                                                                                            |
| `tools/{InkTool,ShapeTool,TextTool,LineTool,FrameTool}.tsx` | 工具覆盖层：`tool !== "select"` 时铺满画布的 `pointer-events: all` 层，`screenToFlowPosition` 换算，进行中的图形画在 `<ViewportPortal>`，松手调 store；`toolLock` 关闭时回到选择                                       |
| `StylePanel.tsx`                                            | F28                                                                                                                                                                                                                    |
| `clipboard.ts`                                              | F19 的序列化 / 反序列化                                                                                                                                                                                                |

样式属性沿用 tldraw 的名字集合，值域收窄：`color`（13 个颜色名，映射到我们自己的明暗两套十六进制表，从 `WhiteboardPage.SWATCHES` 抽到 `whiteboard/palette.ts`）、`size`（s/m/l/xl → 线宽 2/3.5/5/10）、`dash`（solid/dashed/dotted）、`fill`（none/semi/solid）。

层级：白板对象与节点共用 RF 的 `zIndex`；`store.reorder` 实现「置顶 / 置底」；`elevateNodesOnSelect={false}`（选中终端不该压过别人）。

### 2.5 上下文连线与内容引用

- 节点把手：`NodeShell` 的 `ConnectionHandles` 改为渲染 `<Handle type="source" position={Left|Right} id="left"|"right">`，尺寸与命中区沿用平台设计 §4.1（圆点 14 / 命中 34，触屏 16 / 36）。`isConnectableStart` 只在把手上，节点体不能起笔。
- 落点：节点上覆盖一个 `<Handle type="target" id="body" isConnectableStart={false}>`，样式 `inset:0; opacity:0`，`pointer-events` 只在 `useConnection().inProgress` 时开；`wb.*` 节点同法。`connectionRadius={24}`。
- 连线预览：`connectionLineComponent` 用 `linkCurve`，从起笔把手所在边的中点出发，与落成后的 `LinkEdge` 同一条曲线（ui-refinement「连线预览与持久化链接使用同一组边缘端口与 Bézier 几何」保持成立）。
- 内容引用的数据流不变：`content-links.ts` 的 `useContentLinks()` 改成订阅 `whiteboard.references` 与 `items`，`shapeSignature` 换成 item JSON（去掉 `x/y`），`resolveContent` 换成 `raster.ts` 与 item 文本；`ContextLink.content { status, sourceShapeId, shapeType, text, textTruncated, pngPath }` 一个字段不改（Runtime `collab/context_link.rs` 不动）。`sourceShapeId` 填 `wb:<uuid>`，`shapeType` 填 `ink / text / shape / image / line / frame`（新值只是提示，Runtime 不按它分支——已核实 `read_shape` 只读 `text` / `png_path`）。
- Frame 引用：`group` 节点也可作引用来源（现状允许 `frame` / `group`），PNG 取 Frame 内白板对象的栅格，文字取其中 `wb.text` / 标签拼接。

### 2.6 Frame ↔ worktree

`frame-binding.ts`、`store/canvas/nodes.ts` 里的继承逻辑、`WorktreeBindingBadge` 的初始化脚本闸全部不动；变化只有渲染宿主（进 `GroupNode`）与 `enclosingBoundFrame` 的输入（仍是 `document.nodes`）。`git-github-design.md` G03 的行为矩阵原样成立。

### 2.7 历史（撤销 / 重做）

`store/canvas/history.ts`（≤ 300 行）：

```ts
interface HistoryEntry {
  label: string;
  before: EntityPatch; // id → 实体 | null（null = 不存在）
  after: EntityPatch;
}
type EntityPatch = {
  nodes: Map<string, CanvasNode | null>;
  edges: Map<string, CanvasEdge | null>;
  items: Map<string, Item | null>;
  references: Map<string, Reference | null>;
};
```

- `internal.commit(state, mutate, { history?: "record" | "ignore", label? })` 计算前后文档的逐实体差异（按对象身份比较，成本与变动条数成正比），默认记录；栈深 200。
- `undo` 只回放 `before` 里出现的实体：远端在此期间新增的节点不受影响（tldraw 时代 `mergeRemoteChanges` 的语义）；被远端删掉的实体撤销时复活为本地新建（与保存变基 `replayLocalEdits` 的规则一致）。
- 文字编辑 / 便签正文：进入编辑时开一个 `coalesce` 会话，提交时才形成一条。
- `useCanUndo / useCanRedo` 改订阅 history（`selectors.ts` 去掉 editor）。
- 视口、选区、面板状态、最大化的 `premaxRect` 一律不进历史（现状）。

### 2.8 选择、复制粘贴、删除

- 选区在 store：`selectedNodeIds`（节点）+ `selectedItemIds`（白板对象）+ `selectedEdgeIds`；`onSelectionChange` 一次写三项。`canvas.selectAll` 选全部。
- `canvas.delete`：`splitSelectionForDelete` → 白板对象直接 `removeItems`；节点走确认框；边 `removeEdges`；引用 `removeReferences`。
- 剪贴板（F19）：`whiteboard/clipboard.ts` 写 `text/plain` 为 JSON `{ "armadra": "canvas@1", items, nodes, references }`；读取时先认这个签名，否则按外部内容规则（图片 → `wb.image`，文本 → `wb.text`）。粘贴点：`pasteAtCursor` 开则用最近一次指针位置（`interaction/pointer.ts` 记录），否则视口中心。粘贴 / 复制都不在输入框、终端里生效（`os-drop.isTextEntry` 不变）。

### 2.9 视口、缩放、锁定与快捷键

| 命令                | 实现                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas.zoomIn/Out` | `zoomTo(clampZoom(z * ZOOM_STEP), { duration: ZOOM_DURATION })`（`zoom.ts` 常量不变）                                                                           |
| `canvas.zoom100`    | `zoomTo(1, { duration })`                                                                                                                                       |
| `canvas.fitView`    | `fitBounds(visibleBounds(), { padding: 0.05, duration: 200 })` 后若 `zoom > 1` 再 `zoomTo(1)`；`visibleBounds` 取所有 RF 节点的 `getNodesBounds`                |
| `canvas.tidy`       | `tidy-flow.arrangeCanvas({ aspect })` 后 `requestAnimationFrame(fitView)`                                                                                       |
| `canvas.focus*`     | `geometry.nearestInDirection` 不变                                                                                                                              |
| `canvas.tool.*`     | `toolStore.setTool(id)`；锁定时 `isToolDisabledWhenLocked` 拒绝                                                                                                 |
| Dock 缩放档位       | `zoomTo(step)`；`useZoomLevel` 改用 `useViewport()`（需在 `<ReactFlowProvider>` 内，Dock 已在 `App` 的 provider 之下；`flow-context` 另提供树外的 `getFlow()`） |

`<ReactFlowProvider>` 包住整个 `App`（v3 做法），`flow/flow-context.ts` 用 `useReactFlow()` 在 `FlowWorkspace` 挂载时把实例登记成模块级句柄（`getFlow()` / `useFlowHandle()` / `screenToPage()`），画布外的模块只经它取实例。

### 2.10 偏好映射

| 偏好键          | 现在（tldraw）                 | React Flow 方案                                                              | 处置 |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------- | ---- |
| `background`    | `--canvas-bg` / `--canvas-dot` | 不变（容器背景 + `<Background color>`）                                      | 保留 |
| `grid`          | `isGridMode`                   | `<Background>` 渲染与否                                                      | 保留 |
| `gridSize`      | `gridSize / 4`                 | `<Background gap>` 直接用像素值；`snapGrid=[g,g]`                            | 保留 |
| `snap`          | `isSnapMode`                   | `snapToGrid`                                                                 | 保留 |
| `dynamicSize`   | `isDynamicSizeMode`            | 新对象线宽 / 字号除以当前 `zoom`                                             | 保留 |
| `animation`     | `animationSpeed`               | 视口动画 `duration` 200 / 0                                                  | 保留 |
| `toolLock`      | `isToolLocked`                 | `tool-store`：落成后是否回选择                                               | 保留 |
| `wrap`          | `isWrapMode`                   | `selectionMode` 取 `Full` 或 `Partial`                                       | 保留 |
| `focus`         | `isFocusMode`                  | 隐藏缩略图、样式面板、锁按钮                                                 | 保留 |
| `edgeScroll`    | `edgeScrollSpeed`              | `autoPanOnNodeDrag` / `autoPanOnConnect`                                     | 保留 |
| `pasteAtCursor` | `isPasteAtCursorMode`          | `clipboard.ts` 落点                                                          | 保留 |
| `inputMode`     | `inputMode`                    | `mouse` → `zoomOnScroll` / `panOnScroll={false}`；`trackpad` / `auto` → 反之 | 保留 |
| `defaultColor`  | `setStyleForNextShapes`        | `tool-store.nextStyle`                                                       | 保留 |
| `defaultSize`   | 同上                           | 同上                                                                         | 保留 |
| `debug`         | `isDebugMode`                  | 无对应                                                                       | 删除 |
| `enhancedA11y`  | `enhancedA11yMode`             | 无对应                                                                       | 删除 |
| `zoomInverted`  | `isZoomDirectionInverted`      | RF 无 API；不做滚轮反转 hack                                                 | 删除 |
| `style`         | `dash: draw` + `font: draw`    | 没有手写字体可用                                                             | 删除 |

删除的键在 `preferences/whiteboard.ts`、`WhiteboardPage.tsx`、`CanvasPreferencesMenu.tsx`、`i18n/canvas.ts`、`keybindings.ts`（`canvas.toggleToolLock/Grid/Focus` 三条保留）同 PR 清理；旧 localStorage 键残留无害。

### 2.11 跨批接口契约（并行 Agent 只调用、不修改他人归属）

| 模块（归属批）                                  | 导出                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow/flow-context.ts`（B0）                    | `getFlow(): ReactFlowInstance` 或 `null`、`useFlowHandle()`、`screenToPage(point)`、`CENTER_NODE_EVENT`、`requestCenterOnNode(id)`、`containerSize()` |
| `flow/drafts.ts`（B0）                          | `setDraft(id, { position?, size? })`、`clearDrafts(ids)`、`useDrafts()`                                                                               |
| `sync/project.ts`（B0）                         | `projectNodes(...)`、`projectEdges(...)`、`isDocumentNodeId(id)`、`isItemId(id)`、`toItemId(uuid)`、`fromItemId(id)`                                  |
| `store/canvas/history.ts`（B0）                 | `record(entry)`、`undo()`、`redo()`、`useCanUndo()`、`useCanRedo()`、`beginCoalesce(label)` / `endCoalesce()`                                         |
| `interaction/tool-store.ts`（B0 骨架，B2 填充） | `CanvasToolId`、`getTool()`、`setTool(id)`、`useTool()`、`nextStyle` 读写                                                                             |
| `whiteboard/model.ts`（B2）                     | `WhiteboardDoc`、`Item`、`Reference`、`whiteboardDocSchema`、`emptyWhiteboard()`                                                                      |
| `whiteboard/store.ts`（B2）                     | §2.4 的动作；B1 的 `tidy-flow` 调 `moveItems`，B5 调 `addReference / removeReferences`                                                                |
| `whiteboard/raster.ts`（B2）                    | `rasterizeItems(items, options): Promise<Blob>`；B5 调用                                                                                              |
| `flow/edges/LinkEdge.tsx`（B1）                 | `edgeTypes` 常量；B5 追加 `reference`                                                                                                                 |

## 3. 数据与迁移

### 3.1 `whiteboard_json` v2

```json
{
  "engine": "armadra-flow",
  "version": 2,
  "items": [
    {
      "id": "3f…",
      "kind": "ink",
      "x": 120,
      "y": 80,
      "w": 210,
      "h": 96,
      "z": 3,
      "parentId": null,
      "style": { "color": "black", "size": "m" },
      "highlight": false,
      "points": [
        [0, 0, 0.5],
        [3.2, 1.1, 0.6]
      ]
    },
    {
      "id": "…",
      "kind": "text",
      "x": 0,
      "y": 0,
      "w": 240,
      "h": 48,
      "z": 4,
      "style": { "color": "black", "size": "m", "align": "start" },
      "text": "两行\n文字"
    },
    {
      "id": "…",
      "kind": "shape",
      "x": 0,
      "y": 0,
      "w": 160,
      "h": 120,
      "z": 5,
      "style": {
        "color": "blue",
        "size": "m",
        "dash": "solid",
        "fill": "semi"
      },
      "geo": "rectangle",
      "label": ""
    },
    {
      "id": "…",
      "kind": "image",
      "x": 0,
      "y": 0,
      "w": 400,
      "h": 300,
      "z": 6,
      "assetPath": ".armadra/assets/0a1b….png",
      "alt": ""
    },
    {
      "id": "…",
      "kind": "line",
      "x": 0,
      "y": 0,
      "w": 300,
      "h": 40,
      "z": 7,
      "style": { "color": "grey", "size": "m", "dash": "solid" },
      "points": [
        [0, 0],
        [300, 40]
      ],
      "arrowStart": false,
      "arrowEnd": true
    }
  ],
  "references": [
    { "id": "<contentId uuid>", "itemId": "3f…", "nodeId": "<节点 uuid>" }
  ],
  "legacy": {
    "engine": "tldraw",
    "sha256": "…",
    "bytes": 12345,
    "backup": ".armadra/imports/whiteboard-<boardId>-tldraw.json"
  }
}
```

约束：`items` 按 `z` 升序即绘制顺序；坐标为画布单位，`parentId` 为 `group` 节点 uuid 时相对该 Frame；`points` 相对 `x/y`；`ink.points` 第三分量是压力（0–1）；单个 `ink` 点数上限 4,000（`simplifyPoints` 在落成时压到 0.35px 容差以内）；整份字符串仍受 `MAX_WHITEBOARD_BYTES`（8 MiB）约束。`legacy` 只在由转换生成的第一份里存在，用户之后任何白板编辑都保留它（记账，不占空间）。`references.id` 就是 `ContextLink.id`，保持 `.armadra/exports/<uuid>.png` 的文件名稳定（现状 `contentId` 的用途）。zod 校验在 `whiteboard/model.ts`，校验失败按「未知格式」处理（§3.3）。

### 3.2 旧数据：不迁移（用户决定，2026-09-06）

产品尚未正式发版，**不做 tldraw 快照到 v2 的转换，也不做备份**。`whiteboard/serialize.parseWhiteboard(text)` 只认 v2：空串、无法解析、`version !== 2` 或 `engine !== "armadra"` 的内容一律按 `emptyWhiteboard()` 处理，下一次保存写回 v2 并覆盖旧文本；不弹提示、不留原文。原 §3.2 的 M01–M17 转换规则与 §3.3 的三态解析、备份通道、回退整段作废，原批次 B3 取消，`whiteboard/migrate/` 目录不建，B0 第 0 步的 tldraw 夹具不生成。

数据结构可以直接改：`whiteboard_json` 仍是跨端不透明字节（§3.5 核实结果不变），但若某处按 v2 存储更简单，也允许改契约并在本文单列，不必顾及旧库。

### 3.3 加载与写回

`FlowWorkspace` 打开画布时把解析结果写进 `whiteboard/store`；白板变化置脏走 `save/autosave.ts` 的既有路径，保存体为 `serialize.serialize(doc)`。

### 3.4 `viewport_json`

存储值一直是 React Flow 语义（`{x, y, zoom}` = 屏幕像素平移量 + 缩放；`viewport.ts` 注释与 `TldrawWorkspace.onCameraChange` 的 `x * z` 换算证明 tldraw 时代写回的就是这个语义）。切换后直接 `setViewport(board.viewport)`，无转换；`initialViewportFor` 与 `isDefaultViewport` 不变。

### 3.5 Runtime 与 Host 核实结果

| 端      | 文件                                                         | 对 `whiteboard_json` 做什么                                                                                                                                                                       | 受影响                                                                                                   |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime | `apps/runtime/src/db/validation.rs` `validate_whiteboard`    | 只查长度 ≤ `MAX_WHITEBOARD_BYTES`                                                                                                                                                                 | 否                                                                                                       |
| Runtime | `db/documents.rs`、`db/boards.rs`、`model.rs`                | 原样读写字符串；`Board.whiteboard` 注释写着「runtime never looks inside」                                                                                                                         | 否                                                                                                       |
| Runtime | `migration_export.rs`                                        | 以字节做 sha256 与长度进入迁移清单                                                                                                                                                                | 否                                                                                                       |
| Runtime | `ownership/records.rs`、`ownership/import.rs`                | 反向导出 / 导入：`CanvasWhiteboard.schema_version` 必须等于常量 `1`（这是 proto 包级版本，不是 JSON 里的 `version`），比对 sha256 与长度，检查 UTF-8；`engine_version: "tldraw"` 只是标签，不比较 | 否                                                                                                       |
| Runtime | `collab/context_link.rs` `read_shape`                        | 只读 `ContextLink.content.text / png_path / source_shape_id / text_truncated`                                                                                                                     | 否                                                                                                       |
| Host    | `apps/host/internal/canvashost/entities.go` `validateCanvas` | `len(Snapshot) ≤ 8 MiB`、`len(EngineVersion) ≤ 64`、sha256 长度                                                                                                                                   | 否                                                                                                       |
| Host    | `canvashost/materialize.go`                                  | 旧库投影：整段字符串装进 `CanvasWhiteboard{SchemaVersion:1, EngineVersion:"tldraw", Snapshot, Sha256, Bytes}`                                                                                     | 否                                                                                                       |
| Host    | `canvashost/verify.go` 第 5 项「whiteboards」                | 只比较清单摘要与字节数                                                                                                                                                                            | 否                                                                                                       |
| Host    | `internal/migration/import.go`                               | 同上，sha256 + 长度                                                                                                                                                                               | 否                                                                                                       |
| Web     | `canvas-ownership/mapping.ts` `WHITEBOARD_ENGINE`            | 填进 `engineVersion` 的标签                                                                                                                                                                       | 改成 `"armadra-flow"`（纯标签，三端都不比较；Host / Runtime 常量保持 `"tldraw"` 不动，避免触碰跨端代码） |
| proto   | `proto/armadra/v1/canvas.proto` `CanvasWhiteboard`           | 注释说「opaque: schema version, engine version, bytes and a digest」                                                                                                                              | 否（注释里的 tldraw 字样留到下次协议改动时顺手改）                                                       |

结论：**不改契约、不加迁移、不改 Host 与 Runtime 源码**。`packages/shared` 的 `boardSchema.whiteboard` 注释可在 B4 顺手改成「不透明白板文档（§3.1）」。

## 4. 代码布局

### 4.1 目标目录

`apps/web/src/canvas/` 按职责拆成六个子包，每个文件 ≤ 800 行（`repo.rules.json` 硬上限 1500）：

```text
canvas/
  FlowWorkspace.tsx            装配：<ReactFlow> props、Background、MiniMap、Panel、工具覆盖层、菜单、确认框（≤ 450）
  commands.ts                  不变
  connection.ts                不变
  canvas-lock.ts               不变
  escape-to-select.ts          改造（去 editor）
  geometry.ts                  不变
  tidy.ts                      不变
  tidy-flow.ts                 替代 tidy-editor.ts
  tools.ts                     改造：工具 id 自有、删除样式面板对 tldraw 类型的引用
  viewport.ts / zoom.ts        不变
  derived-edges.ts             不变
  SubagentLayer.tsx            不变（改名 subagent-layout.ts 可选）
  frame-binding.ts             不变
  content-links.ts             改造（B5）：订阅 whiteboard，去 editor
  create-content-reference.ts  改造（B5）：写 references
  assets.ts                    改造：去 TLAssetStore，只留上传 / 路径 / URL
  flow/
    flow-context.ts            §2.11
    drafts.ts                  手势临时坐标
    use-flow-nodes.ts          投影 + 回调翻译（onNodesChange / onNodeDragStop / onResizeEnd / onSelectionChange / onConnect）
    use-flow-viewport.ts       视口节流与 setViewport 反向、初始视口、fitView
    flow-options.ts            由偏好与锁定算出的 <ReactFlow> props（纯函数）
    nodes/ArmadraNode.tsx      F01–F04
    nodes/GroupNode.tsx        F05、F08 宿主
    nodes/node-types.ts        nodeTypes 常量（含 wb.*）
    edges/LinkEdge.tsx         F06
    edges/ReferenceEdge.tsx    F29
    edges/ConnectionLine.tsx   预览线
    edges/edge-types.ts
    Minimap.tsx                F20
    overlays/CanvasOverlays.tsx   ViewportPortal 宿主（rope / subagent）
    overlays/WorktreeBindingBadge.tsx   保留内容，宿主改 GroupNode
  whiteboard/                  §2.4
    model.ts store.ts serialize.ts ink.ts geometry.ts raster.ts palette.ts clipboard.ts StylePanel.tsx
    nodes/ tools/
  interaction/
    tool-store.ts              F21
    pointer.ts                 最近指针位置（粘贴落点）
    keyboard.ts                RF 键位常量（deleteKeyCode null 等）
  menus/                       add-menu.ts AddMenuContent.tsx node-menu.tsx item-menu.tsx（原 shape-menu）edge-menu.tsx
  dnd/                         external-content.ts（去 tldraw）os-drop.ts
  sync/
    project.ts                 CanvasNode / Item → RF Node、Edge（纯函数）
```

删除：`TldrawWorkspace.tsx`、`StylePanel.tsx`（tldraw 版）、`CanvasPreferencesMenu.tsx`（改造后留在 `menus/`）、`editor-context.ts`（被 `flow/flow-context.ts` 取代，`CENTER_NODE_EVENT` 等导出名不变）、`tidy-editor.ts`、`shapes/` 整个目录、`sync/{derive,snapshot,use-store-sync,pushed}.ts`、`overlays/{StatusMinimap,CanvasNavigationPanel}.tsx`、`overlays/minimap.ts`（只保留颜色函数到 `flow/Minimap.tsx`）、`shapes/retired-shapes.ts`。

### 4.2 现有文件处置

| 文件                                                                                                                       | 处置 | 说明                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas/TldrawWorkspace.tsx`                                                                                               | 删除 | 装配逻辑迁 `FlowWorkspace.tsx`（删除确认、命令表、右键、居中事件原样搬）                                                                                                   |
| `canvas/editor-context.ts`                                                                                                 | 替换 | `flow/flow-context.ts`；`store/canvas/*`、`save/autosave.ts`、`files/use-workspace-file-drag.ts`、`panels/viewport.ts`、`nodes/NodeShell.tsx`、`shell/Dock*.tsx` 改 import |
| `canvas/sync/project.ts`                                                                                                   | 重写 | 从 tldraw 记录投影改为 RF Node / Edge；`edgeArrowheads`、`edgeLabelKey`、颜色表保留                                                                                        |
| `canvas/sync/{derive,snapshot,use-store-sync,pushed}.ts`                                                                   | 删除 | 反向派生不再存在                                                                                                                                                           |
| `canvas/shapes/*`                                                                                                          | 删除 | `link-path.ts` 保留并移到 `flow/edges/link-path.ts`；`ConnectionHandles.tsx` 改写后移到 `flow/nodes/`；`LinkArrow.ts` 的把手合法性逻辑并入 `use-flow-nodes.onConnect`      |
| `canvas/content-links.ts`、`create-content-reference.ts`                                                                   | 改造 | B5                                                                                                                                                                         |
| `canvas/assets.ts`                                                                                                         | 改造 | 去 `TLAssetStore`                                                                                                                                                          |
| `canvas/dnd/external-content.ts`                                                                                           | 改造 | 去 `getAssetInfo / sanitizeSvg / AssetRecordType`：图片尺寸用 `createImageBitmap` 量，SVG 只按 MIME 放行不再消毒（B2 决定：SVG 一律栅格化为 PNG 后上传，规避脚本）         |
| `canvas/dnd/os-drop.ts`                                                                                                    | 改造 | `onDrop` 成为唯一入口；粘贴守卫改成我们自己的 `document` paste 监听                                                                                                        |
| `canvas/menus/shape-menu.tsx`                                                                                              | 改名 | `item-menu.tsx`，`editor.*` 换 store 动作；「转成便签」保留                                                                                                                |
| `canvas/menus/add-menu.ts`                                                                                                 | 改造 | `addTextShape / addFrameShape` 改调 `whiteboard.addItems` / `store.addNode("group")`                                                                                       |
| `canvas/CanvasPreferencesMenu.tsx`                                                                                         | 改造 | 删四项；移到 `menus/`                                                                                                                                                      |
| `canvas/overlays/CanvasOverlays.tsx`                                                                                       | 改造 | 宿主换 `<ViewportPortal>`；`WorktreeBindingLayer`、`FrameReferenceBadges` 从这里移出                                                                                       |
| `canvas/overlays/WorktreeBindingBadge.tsx`                                                                                 | 改造 | 去掉 `WorktreeBindingLayer` 的页面坐标定位，由 `GroupNode` 直接渲染 `WorktreeBindingBadge`                                                                                 |
| `canvas/overlays/{StatusMinimap,CanvasNavigationPanel}.tsx`、`minimap.ts`                                                  | 删除 | `flow/Minimap.tsx`                                                                                                                                                         |
| `canvas/tools.ts`                                                                                                          | 改造 | `CANVAS_TOOL_IDS` 不变；`GeoOption.geo` 改我们的 `Geo` 类型；`splitSelectionForDelete` 按 id 前缀                                                                          |
| `canvas/tidy-editor.ts`                                                                                                    | 替换 | `tidy-flow.ts`                                                                                                                                                             |
| `canvas/escape-to-select.ts`                                                                                               | 改造 | 去 editor                                                                                                                                                                  |
| `canvas/{commands,connection,canvas-lock,geometry,tidy,viewport,zoom,derived-edges,frame-binding}.ts`、`SubagentLayer.tsx` | 保留 | 一行不改（`geometry.ts` 顶部注释可顺手改）                                                                                                                                 |
| `nodes/NodeShell.tsx`                                                                                                      | 改造 | 去 `pointsAtOverlay` / `stopPointer`、滚轮守卫改 `nowheel` + ⌘滚轮转发、`maximizeRect` 读 flow；`ConnectionHandles` import 路径变                                          |
| `nodes/registry.ts`                                                                                                        | 保留 | `DRAG_HANDLE_CLASS` 直接成为 RF `dragHandle` 选择器                                                                                                                        |
| `store/canvas/internal.ts`                                                                                                 | 改造 | 删 `withEditor / updateNodeShape / createNodeShapes / shapeOf`；`commit` 接历史                                                                                            |
| `store/canvas/{nodes,edges,layout,selection,view}.ts`                                                                      | 改造 | 删掉每个动作末尾的 `withEditor(...)` 块；`view.ts` 的 `undo/redo` 转 history、`setViewport` 反向写 flow、`arrangeNodes` 调 `tidy-flow`                                     |
| `store/canvas/selectors.ts`                                                                                                | 改造 | `useCanUndo/Redo` 读 history                                                                                                                                               |
| `store/canvas/types.ts`                                                                                                    | 改造 | 加 `whiteboard: WhiteboardDoc`、`selectedItemIds`、`selectedEdgeIds`，`setWhiteboard(doc, opts)` 签名变（字符串版删除）                                                    |
| `store/defaults.ts`                                                                                                        | 保留 |                                                                                                                                                                            |
| `save/autosave.ts`                                                                                                         | 改造 | `syncWhiteboard` 改 `serializeWhiteboard(state.whiteboard)`；未知格式保留原文的规则                                                                                        |
| `save/canvas-save-queue.ts`                                                                                                | 保留 |                                                                                                                                                                            |
| `app/use-tldraw-preferences.ts`                                                                                            | 替换 | `app/use-canvas-preferences.ts`：只留背景变量与 `flow-options` 输入；反向通道删除                                                                                          |
| `app/preferences/whiteboard.ts`、`app/preferences-store.ts`                                                                | 改造 | 删四键                                                                                                                                                                     |
| `panels/settings/pages/WhiteboardPage.tsx`                                                                                 | 改造 | 删四项；色板表移到 `whiteboard/palette.ts` 并 import                                                                                                                       |
| `shell/Dock.tsx`、`shell/DockTools.tsx`                                                                                    | 改造 | `useValue` → `useViewport` / `useTool`；`zoomToLevel` → `zoomTo`                                                                                                           |
| `shell/ControlsCluster.tsx`                                                                                                | 改造 | 菜单 import 路径                                                                                                                                                           |
| `panels/github/FrameReferenceBadges.tsx`                                                                                   | 改造 | 宿主改 `GroupNode`                                                                                                                                                         |
| `styles/canvas.css`                                                                                                        | 重写 | 删全部 `.tl-*` / `.tlui-*`；新增 `.react-flow__*` 覆盖（背景色、选中框、把手、缩略图、归属链接位置、`.wb-*`）；`.workspace-surface` / `.canvas-dock` 等布局规则保留        |
| `i18n/canvas.ts`、`i18n/commands.ts`                                                                                       | 改造 | §1.2 F38                                                                                                                                                                   |
| `keybindings.ts`                                                                                                           | 改造 | 新增 `canvas.copy / cut / paste`；删 `canvas.tool.*` 之外无变化                                                                                                            |
| `app/test-setup.ts`                                                                                                        | 改造 | 删 tldraw 的 `matchMedia` 桩（RF 需要 `ResizeObserver` 桩，jsdom 没有）                                                                                                    |
| `app/App.tsx`                                                                                                              | 改造 | `<ReactFlowProvider>` 包最外层；`TldrawWorkspace` → `FlowWorkspace`；`useCanvasPreferences`                                                                                |
| `apps/web/package.json`、`vite.config.ts`                                                                                  | 改造 | §4.3                                                                                                                                                                       |

### 4.3 依赖变化

| 操作 | 包                                                                                                                                              | 许可证 | 说明                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 移除 | `tldraw@5.4.0`                                                                                                                                  | tldraw | 含 `@tldraw/editor`（同许可）、tiptap、prosemirror 等传递依赖一并消失                                                                    |
| 移除 | `@tldraw/assets@5.4.0`、`@tldraw/tlschema@5.4.0`                                                                                                | MIT    | 字体 / 图标不再需要自托管；vite `optimizeDeps.exclude` 删除                                                                              |
| 新增 | `@xyflow/react@^12.11.3`                                                                                                                        | MIT    | 传递依赖 `@xyflow/system`、`zustand@4`（与项目 `zustand@5` 并存，各自独立）、`classcat`、`d3-{drag,selection,zoom}` 等（均 BSD-3 / MIT） |
| 新增 | `perfect-freehand@^1.2`                                                                                                                         | MIT    | 无依赖                                                                                                                                   |
| 改   | `vite.config.ts` 分组 `tldraw` → `xyflow`：正则匹配 `@xyflow`、`d3-*`、`classcat` 三组包名                                                      | —      | 预计 chunk 约 180 kB / gzip 60 kB（v3 时代实测 179 kB），比 tldraw 的 1749 kB 小一个量级                                                 |
| 改   | `apps/desktop/src-tauri/tauri.conf.json` CSP                                                                                                    | —      | 不需要改：不再有 `?url` 字体，`img-src` 已含 `blob: data:`                                                                               |
| 改   | `README.md`、`apps/web/README.md`、`docs/guides/{architecture,client-platforms,ui-refinement,development}.md`、`docs/status/feature-roadmap.md` | —      | B6 把「tldraw」改成「React Flow」，`VITE_TLDRAW_LICENSE_KEY` 一行删除，架构 §3 / §5 重写                                                 |

## 5. 实施拆解

### 5.1 批次总览

| 批  | 名称                                   | 并行性         | 前置   | 预计规模（新增 + 改动行）    | 文件所有权（只在这里面改）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------- | -------------- | ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0  | 骨架 + 节点承载 + store 同步           | 串行，单 Agent | —      | 约 3,000 行；删除约 4,500 行 | `canvas/FlowWorkspace.tsx`、`canvas/flow/**`（除 `edges/`、`Minimap.tsx`）、`canvas/sync/`、`canvas/interaction/`、`canvas/whiteboard/{model,serialize}.ts`（骨架）、`canvas/{escape-to-select,tools,tidy-flow}.ts`、`store/canvas/**`、`save/autosave.ts`、`nodes/NodeShell.tsx`、`nodes/registry.ts`、`app/{App,test-setup}.tsx`、`app/use-canvas-preferences.ts`、`shell/Dock*.tsx`、`styles/canvas.css`、`package.json`、`vite.config.ts`、`i18n/canvas.ts`（只删 tldraw 词典补丁）；删除 `canvas/shapes/`、`canvas/overlays/{StatusMinimap,CanvasNavigationPanel}.tsx` |
| B1  | 连线 / Frame / 整理 / 覆盖层 / 缩略图  | 与 B2 并行     | B0     | 约 1,300 行                  | `canvas/flow/edges/**`、`canvas/flow/nodes/{GroupNode,ConnectionHandles}.tsx`、`canvas/flow/Minimap.tsx`、`canvas/flow/overlays/**`、`canvas/tidy-flow.ts`（B0 只放签名）、`canvas/connection.ts`、`panels/github/FrameReferenceBadges.tsx`、`app/minimap-preferences.ts`                                                                                                                                                                                                                                                                                                   |
| B2  | 白板层                                 | 与 B1 并行     | B0     | 约 2,400 行                  | `canvas/whiteboard/**`、`canvas/dnd/**`、`canvas/assets.ts`、`canvas/interaction/pointer.ts`、`keybindings.ts`（只加三条）、`i18n/canvas.ts`（只加 `clipboard.*`、`style.*` 段）                                                                                                                                                                                                                                                                                                                                                                                            |
| B3  | ~~tldraw 快照转换~~（已取消，见 §3.2） | —              | —      | 0                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B4  | 菜单 / 偏好 / Dock / 手机 / 清理       | 与 B5 并行     | B1、B2 | 约 1,100 行；删除约 600 行   | `canvas/menus/**`、`shell/ControlsCluster.tsx`、`panels/settings/pages/WhiteboardPage.tsx`、`app/preferences/**`、`app/preferences-store.ts`、`app/commands.ts`、`shell/MobileFocusPage.tsx`（如需）、`platform/layout.ts`（只读）、`i18n/{canvas,commands,mobile}.ts` 其余部分；**实施时另需 B0 的四个文件**——`app/use-canvas-preferences.ts`（偏好映射与 `data-canvas-focus`）、`canvas/tools.ts`（样式面板显隐与手机工具集）、`styles/canvas.css`（专注模式的三条规则）、`shell/DockTools.tsx`（手机工具组）                                                             |
| B5  | 内容引用                               | 与 B4 并行     | B1、B2 | 约 800 行                    | `canvas/content-links.ts`、`canvas/create-content-reference.ts`、`canvas/flow/edges/ReferenceEdge.tsx`、`canvas/menus/item-menu.tsx` 的引用子菜单（与 B4 协调：B4 先建文件并留插槽）、`docs/guides/native-whiteboard-references.md`                                                                                                                                                                                                                                                                                                                                         |
| B6  | 验收、性能、打包、文档                 | 串行，单 Agent | B4、B5 | 文档为主                     | `docs/guides/**`、`docs/status/**`、`docs/history/tldraw-canvas-plan.md`（原 `docs/contracts/`，只改状态行并移入 `history/`）、`README.md`、`apps/web/README.md`、`docs/README.md`、`.github/workflows/release.yml`（删许可证 secret）；跨批接线另改 `canvas/whiteboard/nodes/ItemFrame.tsx`、`canvas/{tools,tidy-flow}.ts`、`canvas/menus/**`、`canvas/flow/flow-options.ts`、`canvas/sync/project.ts`、`canvas/whiteboard/tools/{ToolLayer,use-tool-pointer}.ts`                                                                                                          |

分支策略：主 Agent 建 `feature/canvas-react-flow`（自 `feature/host-protocol-foundation` `1a212504`），每批一个 worktree 分支 `feature/canvas-react-flow-b<N>`，完成后由主 Agent 按 B0 → B1/B2/B3 → B4/B5 → B6 顺序 cherry-pick；B1–B3 若在 B0 交付前开工，只能基于 B0 的接口文件（§2.11）写纯函数与组件，不得自行修改 B0 归属文件。

### 5.2 每批详情

通用验收命令（每批都跑）：`pnpm --filter @armadra/web typecheck`、`pnpm --filter @armadra/web test`、`pnpm repo:check`、`pnpm format:check`；触及 `packages/shared` 注释以外内容时加 `pnpm --filter @armadra/shared test`；B3 / B5 加 `cargo test -p armadra-runtime`（证明契约未变，预期无改动）与 `pnpm canvas:e2e`（白板字节往返）。真实浏览器检查按 §6.3 中标了该批编号的项。

| 批  | 输入                                                                                                                                               | 输出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 通过标准                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0  | §2.1–§2.3、§2.7–§2.9、§2.11、§4；现 `TldrawWorkspace.tsx`、`sync/`、`store/canvas/`                                                                | 依赖替换；`FlowWorkspace`；`flow/*`；`sync/project.ts`；`store/canvas/*` 去 editor；`history.ts`；`whiteboard/{model,serialize}.ts` 骨架（v2 空文档、只认 v2 的解析、序列化；其它内容按空白板处理）；`NodeShell` 改造；Dock / DockTools 最小改造（工具组只显示选择 / 手，其余按钮禁用直到 B2）；`canvas.css` 重写；测试迁移（§6.1 标 B0 的行）。tldraw 依赖的其它文件（`content-links.ts`、`create-content-reference.ts`、`dnd/external-content.ts`、`assets.ts`、`shape-menu.tsx`、`StylePanel.tsx`、`CanvasPreferencesMenu.tsx`、`use-tldraw-preferences.ts`、`WhiteboardPage.tsx`）在 B0 里**先降到最小可编译版本**（导出名与签名保留，实现返回空 / no-op，文件头写 `// B<N> 重建`），不允许留下任何 `tldraw` import | 7 种节点在浏览器里可建、拖（只认头部）、resize、折叠、最大化、分组加入 / 离开、删除（有会话弹确认）；终端点击 0 字节进 PTY、滚轮走 tmux 桥、⌘滚轮缩放；撤销 / 重做拖动一步一条，Agent 经 `open-agent` 建的节点不被 ⌘Z 撤掉；自动保存与 409 变基通过 `canvas-store.test.ts` / `autosave.test.ts`；全树 `grep -rE "tldraw" apps/web/src` 为 0；`pnpm --filter @armadra/web build` 通过且无 `tldraw` chunk |
| B1  | §2.3、§2.5 前三条、§2.6、F05、F07–F10、F20；现 `LinkShapeUtil.tsx`、`LinkArrow.ts`、`tidy-editor.ts`、`StatusMinimap.tsx`、`CanvasOverlays.tsx`    | `LinkEdge` + `ConnectionLine` + `ConnectionHandles`（Handle 版）+ `isValidConnection` / `onConnect`；`GroupNode`（标题、色带、`NodeResizer`、绑定徽章、GitHub 徽标宿主）与拖放换父；`tidy-flow.ts`；`CanvasOverlays` 进 `ViewportPortal`；`flow/Minimap.tsx`；`link-path.test.ts`、`tidy-editor.test.ts` 改写                                                                                                                                                                                                                                                                                                                                                                                                           | 把手拉线到另一节点建边、拖到空白取消、自连 / 重复 toast；边选中变粗、Delete 删边、删节点级联删边；组员拖出 Frame 自动离组、拖入自动入组、删组不删组员；整理后一屏放下（`fitView` 只缩不放）；rope / 子代理卡片跟随节点；缩略图描边 working / attention / unread 三色、点击定位、可收起                                                                                                                  |
| B2  | §2.4、§2.8、§2.10 的 `defaultColor/size/dynamicSize/toolLock`、F19、F21–F28；现 `external-content.ts`、`assets.ts`、`os-drop.ts`、`StylePanel.tsx` | `whiteboard/**`（五种节点、五个工具、样式面板、剪贴板、栅格化）；`tool-store` 填充；Dock 工具组全部启用；拖放 / 粘贴 / 按路径导入去 tldraw；`external-content.test.ts`、`asset-import.test.ts`、`os-drop.test.ts`、`workspace-drop.test.tsx` 改写；新增 `ink.test.ts`、`serialize.test.ts`、`clipboard.test.ts`、`raster.test.ts`（node canvas 不可用时只测输入校验）                                                                                                                                                                                                                                                                                                                                                   | 画笔 / 高亮 / 六种形状 / 直线 / 箭头 / 文字 / 画框在浏览器可画、可选、可拖、可 resize、可置顶置底、可复制粘贴、可撤销；图片拖入 / 粘贴 / Dock 按钮走资产接口且快照里只有 `assetPath`；白板与节点混合框选、混合删除；文字编辑时快捷键不触发；保存后刷新页面一切原位；8 MiB 上限提示                                                                                                                      |
| B3  | 已取消（§3.2：不迁移旧数据）                                                                                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B4  | §1.2 F18、F30–F32、F38、§2.10；现 `menus/`、`CanvasPreferencesMenu.tsx`、`WhiteboardPage.tsx`、`preferences/whiteboard.ts`                         | 三套右键菜单接 RF 回调；`edge-menu.tsx`；偏好四项删除与映射接线（`use-canvas-preferences.ts` 完整版、`flow-options.ts`）；设置页；手机：工具组收窄、触控验证；i18n 清理；`packages/shared` 注释                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 右键空白 / 节点 / 白板对象 / 边四种菜单正确；13 项偏好每项改动立即生效并刷新后保持；`i18n.test.ts` 通过（zh / en 键集合一致）；390×844 视口：单指平移、双指缩放、点节点 → 焦点页 → 返回，不出现横向滚动；全树搜索 `wb.debug`、`enhancedA11y`、`zoomInverted`、`whiteboard.style` 均为 0                                                                                                                 |
| B5  | §2.5、F29；现 `content-links.ts`、`create-content-reference.ts`、`native-whiteboard-references.md`                                                 | `ReferenceEdge`；引用创建（右键 / 拖线）、上限、去重定位；`useContentLinks` 改订阅 store；`raster.ts` 接入导出；`content-links.test.ts`（28 项）与 `context-link-publication.test.ts` 改写；指南更新                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 白板文字引用到 Agent 后 `armadra-hook context summary --node <标题>` 回文字；墨迹 / 形状 / 图片 / Frame 引用回 PNG 路径且文件存在；改动对象两秒后重新导出；删对象删引用；64 上限 toast；`cargo test -p armadra-runtime` 无改动通过                                                                                                                                                                      |
| B6  | §6                                                                                                                                                 | 打包桌面验证记录、30 节点压力记录、手机记录写入 `docs/status/platform-implementation-status.md`；`architecture.md` §3 / §5 重写；`feature-roadmap.md` §2 技术框架与 §3.1 更新；README 两处；`development.md` 删 `VITE_TLDRAW_LICENSE_KEY`；`tldraw-canvas-plan.md` 状态行改「已被 canvas-react-flow.md 取代」并移到 `docs/history/`（同时更新源码注释里的相对路径引用，`repo:check` 的链接规则会拦）                                                                                                                                                                                                                                                                                                                    | §6.3–§6.6 全部勾选；`pnpm check` 通过                                                                                                                                                                                                                                                                                                                                                                   |

### 5.2.1 各批的实际偏离（收尾批回填）

一行一批，只记**与本文不同**的地方；照着做的部分不重复。

| 批  | 偏离                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0  | 投影必须同时写 `width/height` **与 `measured`**：React Flow 的 `adoptUserNodes` 只在 `userNode.measured` 存在时才把上一次的 `handleBounds` 带过去（`parseHandles`），少了它，任何一次全量重建（`setNodeExtent`）都会让所有连线永久消失。本文 §2.2 没写这一条。                                                                                  |
| B1  | `LinkEdge` / `ReferenceEdge` **不用** `EdgeProps` 给的把手坐标，改读 `useInternalNode` 的绝对矩形自己选边（§2.5 只说预览线与持久边共用曲线，没说端点从哪来）；`ConnectionHandles` 因此多出一个「从不参与交互」的 source 锚点，否则 `getEdgePosition` 报 `error008`、整条边不画。`onConnectEnd` 改信 `connectionState.isValid`，不再重跑判定表。 |
| B2  | 手形工具在 `use-tool-pointer.ts` 里自接了一份左键平移（本文 §2.10 把平移全部交给 React Flow 的 props）。收尾批已收敛回 `flow-options`，见下。                                                                                                                                                                                                   |
| B3  | 整批取消（§3.2，2026-09-06 用户决定不迁移旧数据）。                                                                                                                                                                                                                                                                                             |
| B4  | 另改了 B0 归属的四个文件（§5.1 已回填）；`CanvasPreferencesMenu.tsx` 从 `canvas/` 移到 `canvas/menus/`；专注模式改成根元素上的 `data-canvas-focus` + 一条 CSS，而不是让每个浮层自己订阅 store。                                                                                                                                                 |
| B5  | 引用是 `whiteboard.references` 的一行、画成 `reference` 边（本文 §2.5 已经这么定，但 B4 的 `ReferenceMenuItems.tsx` 插槽签名按**多选**设计，B5 的子菜单按**单个对象**设计，两边对不上，直到收尾批才接上）。引用边留了一个中点删除按钮，因为当时 Delete 键删不掉它。                                                                             |
| B6  | 见下。                                                                                                                                                                                                                                                                                                                                          |

### 5.2.2 B6 的结果

**跨批接线**（前几批交接里点名的七项）：

| 项                            | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 白板对象的把手             | 已做。`ItemFrame` 复用 `flow/nodes/ConnectionHandles` 的 `dropOnly`（需求逐字相同：不能起笔、铺满对象的落点、一个 source 锚点），不再在 `whiteboard/` 下写第二份。此前白板对象一个 `<Handle>` 都没有，`getEdgePosition` 报 `error008`，引用边**一条都画不出来**。                                                                                                                                                                                                                                                   |
| 2. 首帧引用边                 | 复现，但只差**一帧**，且不是引用边独有。真实 Chrome 实测：节点在第 29 帧（582 ms）出现、边在第 30 帧（598 ms）出现，控制台无 `error008`。原因是 `isNodeInitialized` 要求 `internals.handleBounds` 已存在，而它要等 `ResizeObserver` 首测——**显式写 `sourceHandle` / `targetHandle` 治不了**，那只影响 `getHandle` 的查找。唯一能治的是在投影上声明 `handles`，但那会让 `parseHandles` 每次 `adoptUserNodes` 都用我们声明的值覆盖 DOM 量到的把手，连线交互的落点判定跟着改。16 ms 的一帧不值这个风险，**记为不做**。 |
| 3. Delete 删引用边            | 已做。`splitSelectionForDelete` 加第四堆（引用），`canvas.delete` 调 `whiteboard.removeReferences`；`canvas.selectAll` 一并收进引用 id。                                                                                                                                                                                                                                                                                                                                                                            |
| 4. 菜单接线                   | 已做。`ReferenceMenuItems.tsx` 占位删除，`item-menu` 直接渲染 `<ReferenceSubmenu itemId>`（只认命中的那一个对象）；`edge-menu` 按 `isReferenceEdgeId` 分流，后者改成纯函数以便进 zustand 选择器。                                                                                                                                                                                                                                                                                                                   |
| 5. 手形工具                   | 已做。`flowOptions` 收当前工具：手形时 `panOnDrag: [0,1]`、`selectionOnDrag: false`、`nodesDraggable: false`；`use-tool-pointer` 里那份左键平移删掉，光标交还给 React Flow 的 `.react-flow__pane.draggable`。**顺带修掉一个真 bug**：投影在每个节点上钉 `draggable: true`，而 RF 算的是 `node.draggable \|\| (nodesDraggable && node.draggable === undefined)`，per-node 值一直压着全局值——只读画布也拖得动节点。                                                                                                   |
| 6. `tidy-flow`                | 已做。`setWhiteboard(...)` 换成 `whiteboard.moveItems(...)`，`beginCoalesce` / `endCoalesce` 不动。                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7. §2.5 的 Frame 作为引用来源 | **不做**，理由：`Reference.itemId` 在 §3.1 v2 里是白板对象的 uuid，而 Frame 是 `document.nodes` 的一行。要让 group 当来源，得给已经落地的 v2 格式加一个「来源是节点还是对象」的判别字段，并让 `content-links` 多一条「取 Frame 内对象的栅格 + 标签拼接」的解析分支。收尾批改持久化格式没有回旋余地（改错了旧板子打不开），而这一条不是任何验收项的前置。留给后续批次连同 §2.5 的 Frame 段一起做。                                                                                                                   |

**验收数字**见 §6 各节的回填。

### 5.3 冲突规避规则

- 同一文件只有一个批次可改（§5.1 所有权列）；跨批需要改别人的文件时，在本批的交接记录里写「需要 B<N> 在 <文件> 做 <改动>」，自己用插槽 / 最小绕过继续。`i18n/canvas.ts` 三批都要加键：各加**独立注释段**（`/* B2 clipboard */` 等），不动他人段落，主 Agent 合并时按段拼接。
- `keybindings.ts` 只有 B2 追加三条，其余批不碰。
- `FlowWorkspace.tsx` 归 B0；B1–B5 通过 B0 预留的挂载点接入：`nodeTypes` / `edgeTypes` 常量文件、`<ToolLayer />` 插槽、`<CanvasMenus />` 插槽、`onBoardOpened(document)` 钩子。
- 测试文件跟随实现文件归属；共享夹具放 `canvas/test-support/`（B0 建，含 `makeNode`、`makeItem`、`renderFlow(children)` 包 `ReactFlowProvider` 与 `ResizeObserver` 桩）。

## 6. 验收

### 6.1 现有测试处置（`src/canvas` 343 项 / 35 文件）

| 测试文件                                                | 项数 | 处置                                                                         | 批  |
| ------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- | --- |
| `geometry.test.ts`                                      | 17   | 保留                                                                         | B0  |
| `tidy.test.ts`                                          | 12   | 保留                                                                         | B0  |
| `viewport.test.ts`                                      | 8    | 保留                                                                         | B0  |
| `zoom.test.ts`                                          | 8    | 保留                                                                         | B0  |
| `connection.test.ts`                                    | 4    | 保留                                                                         | B0  |
| `derived-edges.test.ts`                                 | 8    | 保留                                                                         | B0  |
| `SubagentLayer.test.ts`                                 | 5    | 保留                                                                         | B0  |
| `frame-binding.test.ts`                                 | 17   | 保留（去掉 `tldraw` 的类型 import）                                          | B0  |
| `tools.test.ts`                                         | 18   | 改写：样式面板类型、删除分流按 id 前缀                                       | B0  |
| `sync/project.test.ts`                                  | 10   | 重写：RF 投影往返、身份缓存                                                  | B0  |
| `sync/snapshot.test.ts`                                 | 16   | 删除；等价断言进 `whiteboard/serialize.test.ts`                              | B0  |
| `shapes/ArmadraShapeUtil.test.ts`                       | 10   | 重写为 `flow/nodes/ArmadraNode.test.tsx`（折叠高度、最小尺寸、拖拽只认头部） | B0  |
| `shapes/armadra-shape` 相关（`retired-shapes.test.ts`） | 5    | 删除                                                                         | B0  |
| `shapes/link-path.test.ts`                              | 8    | 移动到 `flow/edges/`                                                         | B1  |
| `shapes/LinkArrow.test.ts`                              | 18   | 重写为 `flow/edges/connect.test.ts`（合法性、方向、把手取消）                | B1  |
| `shapes/ConnectionHandles.test.tsx`                     | 9    | 重写（Handle 版）                                                            | B1  |
| `shapes/NodeArrowShapeUtil.test.tsx`                    | 1    | 删除（预览线在 `ConnectionLine.test.tsx` 覆盖）                              | B1  |
| `tidy-editor.test.ts`                                   | 7    | 重写为 `tidy-flow.test.ts`                                                   | B1  |
| `overlays/minimap.test.ts`                              | 13   | 缩减为颜色函数 4 项                                                          | B1  |
| `overlays/CanvasNavigationPanel.test.tsx`               | 1    | 重写为 `flow/Minimap.test.tsx`                                               | B1  |
| `overlays/WorktreeBindingBadge.test.tsx`                | 5    | 保留（宿主换 `GroupNode`）                                                   | B1  |
| `dnd/external-content.test.ts`                          | 19   | 改写（去 tldraw 分支）                                                       | B2  |
| `dnd/asset-import.test.ts`                              | 10   | 改写                                                                         | B2  |
| `dnd/os-drop.test.ts`                                   | 1    | 改写                                                                         | B2  |
| `dnd/workspace-drop.test.tsx`                           | 5    | 改写                                                                         | B2  |
| `assets.test.ts`                                        | 5    | 改写                                                                         | B2  |
| `menus/add-menu.test.ts`                                | 15   | 改写（文字 / 画框走 store）                                                  | B4  |
| `CanvasPreferencesMenu.test.tsx`                        | 4    | 改写（删四项）                                                               | B4  |
| `content-links.test.ts`                                 | 28   | 重写（引用模型）                                                             | B5  |
| `context-links.test.ts`                                 | 10   | 保留（链接文档拼装，与白板无关）                                             | B5  |
| `context-link-publication.test.ts`                      | 3    | 保留                                                                         | B5  |

画布外：`app/use-tldraw-preferences.test.ts`（23）→ `use-canvas-preferences.test.ts`（映射表 + 背景换算保留）；`store/canvas-store.test.ts`（51）去掉 `setEditor` 假对象的三项、加历史 8 项；`nodes/NodeShell.test.tsx`（26）去 `pointsAtOverlay` 两项；`shell/Dock.test.tsx`（6）、`app/App.test.tsx`（4）、`shell/MobileShell.test.tsx`（12）改 mock 目标。目标总数不低于现状。

### 6.2 新增测试

| 编号 | 层     | 用例                                                                           | 批  |
| ---- | ------ | ------------------------------------------------------------------------------ | --- |
| T01  | 纯函数 | `projectNodes` 对未变节点返回同一对象；草稿覆盖位置；组员相对坐标              | B0  |
| T02  | store  | 历史：拖动一条、远端 `setDocument` 不入栈、撤销不删远端新增、coalesce 文字编辑 | B0  |
| T03  | 组件   | `ArmadraNode` 折叠 40px；`NodeResizer` 最小尺寸；`nowheel` 存在                | B0  |
| T04  | 纯函数 | `serializeWhiteboard` ↔ `parseWhiteboard` 往返；未知格式保留原文；8 MiB       | B0  |
| T05  | 纯函数 | `isValidConnection` 判定表 §2.3 四行                                           | B1  |
| T06  | 纯函数 | `tidy-flow`：锁定对象不动、白板对象参与、Frame 整体移动                        | B1  |
| T07  | 纯函数 | `ink.ts`：轮廓闭合、简化后点数、缩放                                           | B2  |
| T08  | 纯函数 | `clipboard.ts`：签名识别、粘贴偏移、外部文本 / 图片分流                        | B2  |
| T10  | 组件   | `useContentLinks` 对 `references` 变化发布 pending → ready；删除对象撤销引用   | B5  |

### 6.3 真实浏览器检查项（Chrome 与打包壳各一遍）

| 编号 | 检查                                                                                           | 批  |
| ---- | ---------------------------------------------------------------------------------------------- | --- |
| A01  | 终端：头部拖动、体内点击 0 字节、滚轮走 `POST /api/terminals/{id}/scroll`、⌘滚轮缩放且终端不滚 | B0  |
| A02  | 编辑器 / 浏览器 / 文件节点：体内滚动、输入不触发画布快捷键                                     | B0  |
| A03  | 撤销拖动、撤销删除（会话确认后）、重做                                                         | B0  |
| A04  | 两个窗口同开一块板：一边拖节点另一边 3 秒内更新，撤销互不影响                                  | B0  |
| A05  | 连线、Frame、整理、缩略图（B1 通过标准）                                                       | B1  |
| A06  | 白板全部工具、样式面板、复制粘贴、图片资产（B2 通过标准）                                      | B2  |
| A08  | 右键菜单四种、偏好 13 项、深浅色下线条 / 文字 / 选中框可见                                     | B4  |
| A09  | 内容引用端到端（B5 通过标准）                                                                  | B5  |
| A10  | 右下角「React Flow」链接可见且可点，不被缩略图 / 锁按钮 / Dock 遮挡                            | B6  |

**收尾批复核结果**（2026-09-06，Chrome 152，1440×900，DPR 2，自己的 profile，CDP 驱动，页面可见）：

| 编号 | 结果 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A01  | 🔶   | 头部拖动移动节点、体内点击 **0 个** `POST …/input`、滚轮走 `POST /api/terminals/{id}/scroll`（5 次）且视口不动——都对。**⌘滚轮只在终端没有键盘焦点时才缩放**：空白处 0.665→0.785、终端体上（画布有焦点）0.785→0.928，而 xterm 的隐藏 textarea 拿到焦点时同一个手势变成平移（缩放比例不变，`translate` y +240）。根因：`NodeShell` 把 ⌘滚轮转发给 `.react-flow__pane`，但 React Flow 判定缩放看的是 `useKeyPress(zoomActivationKeyCode)`，而那个 hook **忽略来自输入框的按键**，所以焦点在终端里时 Meta 从没「按下过」。终端本身不滚（0 次 scroll 请求），所以只丢了缩放这一半。 |
| A02  | ✅   | 文件节点的体带 `nowheel`；焦点在终端里按 Delete，节点数 5 → 5（画布快捷键没被触发）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A03  | ✅   | 连按撤销移除 4 个白板对象（一次一个），重做恢复 1 个；删引用后撤销把它放回来。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A04  | ❌   | 两个**独立可见窗口**（两边 `document.hidden === false`）同开一块板：A 里把节点从 `translate(504px, 328px)` 拖到 `translate(515px, 565px)`，Runtime 文档随即变成 `{"x":515,"y":565}`，**B 在 25 秒内一动不动**。事件通道是通的（`…/events` 握手 101）。两处原因都在 `canvas/` 之外：`api/events.ts` 收到 `board.changed` 只失效 `sessions` / `git-status` / `git-diff` 三个 key，不失效 `["board", …]`；`app/use-board-sync.ts` 又有一句 `if (document?.board.id === board.data.board.id) return;`，refetch 回来的同一块板会被直接丢掉。                                        |
| A05  | ✅   | 画框工具建出 1 个 `group` 节点；一键整理后前 6 个节点的 `transform` 全变；缩略图存在且有收起按钮。                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A06  | ✅   | 画笔 / 形状 / 直线 / 文字各画一次，各**只**新增 1 个对象，类型分别是 `wb.ink` / `wb.shape` / `wb.line` / `wb.text`；工具不是选择时样式面板出现。                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A08  | ✅   | 四种菜单都对：空白（新建终端 + 7 个 Agent + 便签 / 文件管理器 / 打开文件 / 导入文件）、节点（分组 / 加入组 / 复制 / 折叠 / 最大化 / 删除）、白板对象（置顶 / 置底 / 复制 / 引用到 Agent / 删除）、引用边（重新同步引用 / 移除引用）。深色下 `--canvas-bg: #191919`、连线描边 `rgba(255,255,255,0.55)`。                                                                                                                                                                                                                                                                        |
| A09  | ✅   | 见 §6.3 下方的引用端到端记录。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A10  | ✅   | 链接在 `(1366, 791)`，`document.elementFromPoint` 在它的中心返回的就是这个 `<a>`（`href="https://reactflow.dev/attribution"`，`pointer-events: auto`），没有被缩略图 / 锁按钮 / Dock 盖住。                                                                                                                                                                                                                                                                                                                                                                                    |

**A01 与 A04 的后续修复**（2026-09-07，上面那张表是 09-06 那一轮的记录，原样保留）：

- **A01**：⌘滚轮不再转发给 `.react-flow__pane`。React Flow 判定缩放看的是
  `useKeyPress(zoomActivationKeyCode)`，而那份状态由 keydown 落在谁身上决定，
  焦点在 xterm 的隐藏 textarea 里时并不可靠。现在 `NodeShell` 在捕获相位自己
  把这一下算成一次缩放（`canvas/interaction/wheel-zoom.ts`，复用
  `canvas/zoom.ts` 的倍率与定点公式），与键盘焦点无关；普通滚轮仍归节点体
  （`nowheel` + `stopPropagation` 只挡带修饰键的那一路）。
- **A04**：两处都补上了。`app/use-board-sync.ts` 订阅 `board.changed`，按事件
  带的 `updatedAt` 认出「自己刚存的那一次」而跳过，其余让 `["board", …]` 失效；
  重取回来的同一块板不再被丢掉，改走 `canvas/sync/merge.ts`：视口留本地的、
  本地这一轮动过的实体（`store/canvas/pending.ts`）留本地的、其余照收远端的，
  内容没变的实体连对象身份一起复用（投影缓存不失效）。远端灌入既不进撤销栈
  也不清空它；手势进行中（`flow/drafts.ts` 非空）先不合，松手那一刻补上。
  同一份账也接到 409 变基上，于是两个窗口同时改**不同**的节点时谁的都不丢。
  验证：`canvas/sync/two-windows.test.ts` 用两份真的 store（`vi.resetModules()`
  各 import 一次）跑完整链路；传输那半边用一台真 Runtime 加两个 `/events`
  WebSocket 客户端另跑一遍（事件到达两端、版本号一致、过期 CAS 写 409）。
- **引用来源扩到 Frame**：引用一个 Frame = 引用它圈住的那一片
  （`canvas/frame-reference.ts`）。成员按几何算（白板对象从来没有 `parentId`），
  `content.text` 是成员清单、`pngPath` 是框里所有白板对象一起栅格化的一张；
  `sourceShapeId` 填 Frame 的节点 id、`shapeType` 填 `group`。上限与去重规则
  一个字没改，Runtime 也没有改动——它从不按来源类型分支，`collab/tests/content.rs`
  里新加的一条把这件事钉住了。
- **引用边首帧**：`EdgeWrapper` 在 `getEdgePosition` 返回 null 时整条边不画，
  而起点侧的把手包围盒要等一轮测量。白板对象与 Frame 的把手是 `inset: 0` 的
  整块覆盖层，几何算得出来，所以 `sync/project.ts` 直接把它写进投影
  （`dropOnlyHandles`），第一帧就有位置。带圆点把手的普通节点不给：那两个点的
  包围盒由 CSS 决定，写死一份近似值会让连线起点和吸附判定偏掉。

A09 的端到端（同一次会话，抓的是真实请求）：

1. 文字对象 → `PUT …/context-links/{nodeId}`，`{"kind":"shape","content":{"status":"ready","sourceShapeId":"wb:cf3b246c-…","shapeType":"text","textTruncated":false,"text":"引用验证 B6"}}`，Runtime 的 `context_links` 里落成同一份。
2. 墨迹对象 → 先 `status:"pending"`，再 `POST …/exports/{id}/png`（`dataUrl` 形式），最后 `status:"ready"` 带 `pngPath: ".armadra/exports/383f3fb7-….png"`；文件真的在工作区里（8,459 字节）。

§2.5 的字段一个没变（`sourceShapeId` 是 `wb:<uuid>`，`shapeType` 是 `text` / `ink`），Runtime 不用改。

### 6.4 打包桌面验证（必做）

1. `pnpm --filter @armadra/desktop build`（macOS arm64；需要一次性的 updater 签名密钥，见实施记录「桌面打包与首启」）。
2. 空数据目录启动（`ARMADRA_DATA_DIR=$(mktemp -d)`）：新建工作空间、开一个终端、画一笔、连一条线；**从挂载起计时 60 秒画布不消失**，节点 / 连线 / 白板 / 终端都在；重启应用后一切原位。
3. 真实数据目录（复制一份用户库）启动：转换报告出现，白板对象与 tldraw 构建的截图对照；`.armadra/imports/whiteboard-*-tldraw.json` 存在。
4. debug 壳设置 `ARMADRA_DESKTOP_DIAGNOSTIC_WS=ws://127.0.0.1:<port>`（`docs/guides/development.md` 环境变量表）并用 `websocat` 接收：无 `console.error`、无未捕获异常、`PUT …/document` 返回 200 且请求体 `whiteboard` 以 `{"engine":"armadra-flow"` 开头。
5. Windows 交叉：`pnpm --filter @armadra/desktop test` 与 `tauri build --debug` 的 CI 作业通过；实机仍标「待验证」。

### 6.5 30 节点压力

对照 `docs/status/platform-implementation-status.md` T03 行的口径（30 个终端节点，CPU 46% → 2.2%，pane pid 不变）：同一脚本再跑一遍，记录空闲 CPU、连续平移 10 秒的帧率（Chrome Performance 面板，目标 ≥ 55 fps）、JS 堆（对照 v4 记录 102.9 MB / 222 shape）。另加 300 条墨迹 + 30 节点的组合，帧率 ≥ 45 fps；不达标时先做 `wb.*` 节点的视口外 `hidden`（自写，不用 `onlyRenderVisibleElements`），再考虑把墨迹合并到单层 SVG（那会失去逐条选择，需回到本文改设计）。

**收尾批实测**（2026-09-06，Chrome 152，1440×900，DPR 2，120 Hz 屏，前台可见窗口；30 个终端节点 + 300 条墨迹全部在视口内，`scale 0.35`，React Flow 不裁剪，所以这是最坏情况）：

| 场景                 | 平均 fps | p50   | p95   | 最慢一帧 | > 33.4 ms 的帧 | JS 堆    |
| -------------------- | -------- | ----- | ----- | -------- | -------------- | -------- |
| 空闲 3.01 s          | 120.1    | 120.5 | 108.7 | 17.6 ms  | 0              | 124.0 MB |
| 手形连续平移 10.02 s | 112.1    | 120.5 | 107.5 | 58.4 ms  | 7 / 1123       | 125.0 MB |
| 拖一个节点 6.09 s    | 108.3    | 120.5 | 60.2  | 75.1 ms  | 3 / 660        | 174.9 MB |

组合场景的目标是 ≥ 45 fps，实测 108–112 fps，**不触发 §7 R02 的裁剪与单层 SVG 备选**。300 条墨迹序列化后 186,358 字节，离 8 MiB 上限很远。

未复跑的部分：T03 那一行的「空闲 CPU 46% → 2.2%、pane pid 不变」需要 30 个**活的** tmux 会话，这一轮的 30 个终端节点没有会话，所以 CPU 与 pid 两列不具可比性，仍以 T03 的原记录为准。

### 6.6 手机 390×844

Chrome 设备模式与一台真机（iOS Safari）：单指平移、双指缩放、点节点头部进焦点页、返回、底部导航切面板；Dock 只显示选择 / 手；无横向滚动条；`platform-implementation-status.md` H03 行补一句「React Flow 触控已验证」。

**收尾批抽查**（Chrome 设备模式 390×844，DPR 3，`mobile: true`，5 触点）：`scrollWidth` 与 `clientWidth` 同为 390，**没有横向滚动**；Dock 的工具组只剩「选择 / 手形」两项（`PHONE_TOOL_IDS`）；画布正常挂载。iOS Safari 真机仍未测。

## 7. 风险与回退

| 编号 | 风险                                                                       | 影响                    | 缓解                                                                                          | 回退                                  |
| ---- | -------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| R02  | React Flow 全量渲染（无裁剪）在多墨迹下掉帧                                | 大白板卡顿              | §6.5 的组合压力；`memo` + 轮廓缓存；阈值触发 `hidden` 裁剪                                    | 墨迹合并单层（设计变更）              |
| R03  | 历史模块自写，边界情况（远端删除 + 本地撤销）语义与 tldraw 不同            | 撤销出现意外复活 / 丢失 | §2.7 规则表 + T02；与保存变基同一套规则                                                       | 栈深设 0 关闭撤销只影响体验，不丢数据 |
| R04  | 键盘 / 指针事件与 RF 抢（Space 平移、Shift 多选、`nowheel`、输入框内粘贴） | 终端或输入框行为回归    | v3 契约 §18 的终端清单在 B0 逐项重跑；`deleteKeyCode` / `selectionKeyCode` 置空；粘贴守卫保留 | 单项 prop 可逐个关闭                  |
| R05  | Frame 不裁剪、无旋转、无富文本被用户视为退化                               | 体验差异                | §1.3 明确列出；转换报告告知                                                                   | 不回退（这是选型的代价）              |
| R06  | 保存冲突时白板整块以本地为准（现状局限）在两窗口同画时更明显               | 另一窗口的笔迹被覆盖    | 沿用 `MAX_CONFLICT_REPLAYS`；文档说明                                                         | 无                                    |
| R08  | 并行批次在 `i18n/canvas.ts`、`FlowWorkspace.tsx` 冲突                      | 合并失败                | §5.3 的分段与插槽规则；主 Agent 顺序 cherry-pick                                              | 冲突批重放到最新基线                  |
| R09  | 打包壳（WKWebView）下 d3-zoom 的触控板手势与 Chrome 不同                   | 平移 / 缩放手感差       | §6.4 在壳里逐项检查；`panOnScroll` 的 `panOnScrollSpeed` 可调                                 | 无                                    |
| R10  | 更高版本客户端写出的 `version: 3` 被本版打开                               | 白板显示为空            | §3.3「未知即保留」：不覆盖原文，编辑才覆盖并提示                                              | 无数据丢失                            |

整个特性在 `feature/canvas-react-flow` 上完成并通过 §6 后合入 `main`；合入前 `main` 上仍是 tldraw 构建，`whiteboard_json` 两种格式互不破坏（§3.3 回退段）。
