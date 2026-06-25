# 桌面端界面重构：差距分析与实施契约

> 状态：已实施（2026-09-02 集成完成；验证结果见 implementation-status.md）  
> 日期：2026-09-02  
> 设计来源：[docs/design/handoff](./design/handoff/README.md)（`SPEC.md`、`src/template.html`、`src/logic.js`、可运行原型 HTML）  
> 决策基线：[architecture.md](./architecture.md) 仍然有效；本文只描述在其边界内如何落地设计稿。

本文是所有实施 Agent 的**唯一契约**。文件归属、数据模型、API 形状、Store 接口在此定义；实现时若发现契约有误，先修改本文再改代码，并在最终报告里说明。

---

## 0. 不可变的技术边界

| 项       | 决定                                                                               | 理由                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 画布引擎 | 继续使用 React Flow（`@xyflow/react`）                                             | 设计稿原型是手写 canvas，但 architecture.md 已裁决主画板为 React Flow；所有设计行为映射到 RF 的 viewport / 自定义节点 / 自定义边 / `ViewportPortal` |
| 持久化   | 继续使用 Runtime SQLite（新增 boards 表）；**不采用** SPEC §1 的 `.aicanvas/` 目录 | 现有 CAS 保存、迁移、会话归属校验都依赖 SQLite；`.aicanvas/` 导出可作为后续功能                                                                     |
| 前端     | React 19 + TS + Vite + Zustand + TanStack Query + Motion + lucide-react            | 不引入新的 UI 组件库；图标用 lucide，设计稿里的 Unicode 符号仅在状态文字/边标签中保留                                                               |
| 桌面     | Tauri 2 薄壳；只加 `dialog`、`opener` 插件与拖放事件                               | 业务逻辑不进 Tauri command                                                                                                                          |
| 文案     | 界面文案中文优先（zh-CN 默认），保留 en 键值以免 i18n 系统失效                     | SPEC 约束"文案全部中文"；现有 i18n 机制保留                                                                                                         |
| 状态表达 | 每个状态必须 图标 + 文字                                                           | SPEC 约束                                                                                                                                           |
| 动效     | 沿用 interface-design.md 的克制原则（仅 opacity/transform，无循环装饰）            | 设计稿的 `running` 旋转图标是唯一允许的循环动画                                                                                                     |

---

## 1. 差距分析（现状 → 设计稿）

### 1.1 应用结构与数据模型

| 维度              | 现状                                             | 设计稿                                                                         | 改动                                             |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Workspace ↔ 画布 | 1:1（`canvases.workspace_id UNIQUE`）            | Workspace 含多个 Board，默认 `Default`                                         | 新增 `boards` 表；节点/连线挂到 board            |
| Workspace 字段    | id/name/rootPath                                 | + 颜色、读/写/执行权限、允许外部端、最近打开时间                               | 迁移增加列                                       |
| 节点类型          | terminal/agent/file/folder/task/diff/log（7）    | task/agent/terminal/diff/file/context/note/browser/image/log（10）             | `folder`→`context` 改名；新增 note/browser/image |
| 连线语义          | context/input/output/depends_on/patches/verifies | link/dispatch/produce/write/trigger/ref                                        | 全量替换 + 旧数据映射                            |
| 节点状态          | idle/running/waiting/done/failed                 | running/waiting/done/review/modified/idle/error/disconnected/connecting/linked | 扩展；`failed`→`error`                           |
| 节点显示态        | 无                                               | `zoom: mini / normal / focus`；画布缩放 < 阈值强制 mini                        | 节点顶层新增 `zoom`                              |
| 手绘              | 无                                               | `board.strokes[]` 世界坐标                                                     | board 级字段                                     |
| 视口              | 每次 fitView                                     | `board.viewport {x,y,zoom}` 持久化                                             | board 级字段                                     |

### 1.2 布局与视觉

| 区域       | 现状                                                              | 设计稿                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶栏       | 58px，品牌 + Runtime + 保存态 + 扫描 Diff + 主题/语言 + 重连/退出 | 36px，ws / board 面包屑、Runtime、保存态、网关态、Git 分支与未提交数、扫描 Diff（带计数）、⌘K 搜索框、主题、设置                                        |
| 工作空间轨 | 无                                                                | 52px，每个 ws 一个字母色块（运行中角标）、＋、底部网关/设置                                                                                             |
| 侧栏       | 260px Explorer（目录列表 + 4 个节点按钮）                         | 236px：ws 名/路径、看板列表（＋）、项目文件树（可拖、Git M/A 徽标）、添加节点面板（3 列 9 类，可拖）                                                    |
| 画布       | RF 默认 Controls + MiniMap                                        | 点阵背景 24px、右上工具栏（选择/画笔+5 色/清除笔迹/一键整理）、左下缩放柱（+ / 百分比 / − / 适应）、摘要模式提示、聚焦提示；不要 MiniMap                |
| Inspector  | 310px                                                             | 272px：类型图标 + 可改标题 + 类型·id、状态/位置/尺寸卡、显示状态三段选择、连接列表（可删）、可执行动作、复制/删除；未选中时看板概览 + 运行概览 + 外部端 |
| 状态栏     | 32px                                                              | 24px：本地/网关模式、活动会话统计、网关端口、路径                                                                                                       |
| 主题       | 绿色强调 `#10a37f`                                                | 靛蓝 `#5B5BD6` / `#7C7CF0`，完整 token 见 §6                                                                                                            |
| 启动页     | 表单式 WorkspaceGate                                              | 左 300px 操作栏（打开项目位置/新建工作空间/连接远程网关/拖放区/设置）+ 右侧最近工作空间卡片网格                                                         |

### 1.3 节点内部

| 节点                 | 现状                                                                     | 设计稿要求                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent                | 适配器名 + 输入数 + AcpSurface（text/status/permission 三类） + 运行按钮 | 头部 ACP 状态 + 提供方 select + 耗时（tokens 仅在 Runtime 提供 usage 时显示）；时间线 user/assistant/thinking(折叠)/tool(名称/参数/结果状态)/permission；权限卡 允许一次/始终允许/拒绝 + 决策回显；底部上下文 chips（可移除、可拖入）、输入框（Enter 发送）、停止、运行 |
| Terminal             | 启动按钮 / xterm                                                         | 头部 cwd + 连接状态 + PID；xterm；底部 摘要（运行中 · N 行 / 退出码）+ 清屏 / 重连 / 停止 / 重新运行                                                                                                                                                                    |
| Diff                 | 文件 details 列表                                                        | 头部 文件数 +add −del 已处理 x/y；每文件 M/A/D 徽标、展开 patch、回滚此文件/接受此文件；底部 全部回滚/全部接受                                                                                                                                                          |
| File                 | 路径 + 预览                                                              | 等宽预览（card2 背景），标题为路径，副标题语言                                                                                                                                                                                                                          |
| Context（原 folder） | 路径 + 排除数                                                            | 路径 + 子文件 chips（前 3 个 +N）+ 大致 token 估算                                                                                                                                                                                                                      |
| Note                 | 无                                                                       | 淡黄底 textarea、字数、@ Agent、转为任务                                                                                                                                                                                                                                |
| Browser              | 无                                                                       | 地址栏 ‹ › ↻ ↗、iframe 内容、底部 截图到画布 / 发送给 Agent                                                                                                                                                                                                            |
| Image                | 无                                                                       | 图片预览（data URL）                                                                                                                                                                                                                                                    |
| Log                  | pre                                                                      | 过滤 chips（全部/Agent/终端/网关）+ 时间戳行                                                                                                                                                                                                                            |
| Task                 | textarea                                                                 | 描述 + 子任务清单（checkbox）+ 派发按钮                                                                                                                                                                                                                                 |

### 1.4 交互

- 拖拽创建：文件树/文件夹/图片/节点卡 → 画布；文件/文件夹 → Agent 节点（新建 File/Context + `ref` 连线 + 上下文 chip）；拖动中画布虚线高亮 + 提示文案。
- 粘贴：文本 → Note（首行标题）；图片 → Image。
- 连线：右侧端口拖到目标 → 语义选择弹层（1-6 数字键，Esc）；连线中点 pill `图标 + 标签 + →`，link/ref 虚线；选中相关节点高亮。
- 一键整理：按拓扑深度分列，列内纵向堆叠，无连线放最后一列，完成后 fitView。
- 快捷键：⌘K ⌘N ⌘O ⌘⇧N ⏎ Esc ⇧1 ⇧0 ⌫ ⌘⏎ ⌘⇧L ⌘⇧T。
- 弹层：新建工作空间、设置（5 个 tab）、⌘K、Diff 扫描抽屉。
- 网关：本期**预留**。UI 处处显示网关状态，但状态只能是「已关闭」或「已启用（预留，尚未开放外部端接入）」，不得伪造在线设备。

---

## 2. 领域模型 v2（`packages/shared/src/domain.ts`）

```ts
nodeType: "task" | "agent" | "terminal" | "diff" | "file" | "context" | "note" | "browser" | "image" | "log"
edgeType: "link" | "dispatch" | "produce" | "write" | "trigger" | "ref"
nodeStatus: "idle" | "running" | "waiting" | "done" | "review" | "modified" | "error" | "disconnected" | "connecting" | "linked"
nodeZoom: "mini" | "normal" | "focus"

CanvasNode {
  id, boardId, type, position {x,y}, size? {width,height},
  zoom: nodeZoom (default "normal"),
  data: CanvasNodeData, createdAt, updatedAt
}
// data 通用字段：kind, title(1..160), subtitle?(≤160), status
task:     { description ≤20000, checklist: {id,text,done}[] }
agent:    { adapter, sessionId?, projectPath, command ≤1024, args[], contextChips: {id,kind:"file"|"context"|"note"|"browser"|"text",label,value}[] }
terminal: { sessionId?, cwd, shell, command?, lastExitCode? }
diff:     { repoPath, sourceAgentNodeId?, files: {path, status:"M"|"A"|"D"|"R"|"?", additions, deletions, patch, previewable (default true), state:"pending"|"accepted"|"reverted"}[] }
file:     { path, mimeType, size, readonly, syncPolicy, language? }
context:  { path, includePatterns[], excludePatterns[] }
note:     { content ≤20000 }
browser:  { url, history: string[] (≤50), historyIndex }
image:    { src (data: URL, ≤ 2 MiB), mimeType, width?, height?, sourcePath? }
log:      { content ≤100000, level, entries?: {at, source:"agent"|"terminal"|"gateway"|"system", text}[] }

CanvasEdge { id, boardId, sourceNodeId, targetNodeId, type: edgeType, label?, createdAt, updatedAt }
Stroke { id, color, width (default 3), points: {x,y}[] }   // 世界坐标
Viewport { x, y, zoom }
Board { id, workspaceId, name, sortOrder, viewport, createdAt, updatedAt }
BoardDocument { board, nodes, edges, strokes }
Workspace { id, name, rootPath, color, permissions {read,write,execute}, gatewayEnabled, lastOpenedAt, createdAt, updatedAt }
WorkspaceSummary = Workspace & { boards: {id,name,nodeCount}[] }
```

旧数据映射（Runtime 加载时做，一次性）：

- 节点 `folder` → `context`；状态 `failed` → `error`。
- 连线 `context`→`ref`，`input`→`dispatch`，`output`→`produce`，`patches`→`write`，`depends_on`→`trigger`，`verifies`→`link`。
- 原 `canvases` 行 → `boards`（name 改为 `Default`，sortOrder 0）。
- 旧 `edge.permissions` 字段丢弃。

上下文收集（`apps/web/src/canvas/context.ts`）：进入 Agent 的 `ref` 与 `dispatch` 连线的源节点 + Agent 自身 `contextChips`。ContextItem kind 扩展为 `task | file | context | log | note | browser | text`。

---

## 3. Runtime API v2

保留：`GET /health`、文件、终端、Agent 相关路由。修改/新增：

| 方法   | 路径                                             | 说明                                                                                                                                                                    |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| GET    | `/api/workspaces`                                | 返回 `WorkspaceSummary[]`，按 `lastOpenedAt` 倒序                                                                                                                       |
| POST   | `/api/workspaces`                                | body `{name, rootPath, color?, permissions?, gatewayEnabled?}`；同根目录幂等返回；自动建 `Default` 看板                                                                 |
| PATCH  | `/api/workspaces/{id}`                           | 更新 name/color/permissions/gatewayEnabled                                                                                                                              |
| POST   | `/api/workspaces/{id}/open`                      | 刷新 `lastOpenedAt`                                                                                                                                                     |
| GET    | `/api/workspaces/{id}/boards`                    | `Board[]`                                                                                                                                                               |
| POST   | `/api/workspaces/{id}/boards`                    | `{name}` → `Board`                                                                                                                                                      |
| PATCH  | `/api/workspaces/{id}/boards/{boardId}`          | `{name?, sortOrder?}`                                                                                                                                                   |
| DELETE | `/api/workspaces/{id}/boards/{boardId}`          | 不允许删除最后一个看板（409）                                                                                                                                           |
| GET    | `/api/workspaces/{id}/boards/{boardId}/document` | `BoardDocument`                                                                                                                                                         |
| PUT    | `/api/workspaces/{id}/boards/{boardId}/document` | body `{expectedUpdatedAt, nodes, edges, strokes, viewport}` → `BoardDocument`（沿用 CAS 冲突 409）                                                                      |
| GET    | `/api/workspaces/{id}/git/status`                | `{repository, branch: string                                                                                                                                            | null, changedCount, ahead?, behind?}` |
| GET    | `/api/workspaces/{id}/git/diff`                  | 现有；`files[].status` 归一为 `M/A/D/R/?`；二进制/过大的未跟踪文件不再导致整次扫描失败，而是 `previewable:false` + 空 `patch`（UI 显示「无法预览」，导出 patch 时跳过） |
| POST   | `/api/workspaces/{id}/git/stage`                 | `{paths: string[]}` → `git add -- <paths>`；路径必须在授权根内且为普通文件                                                                                              |
| POST   | `/api/workspaces/{id}/git/revert`                | `{paths}` → 已跟踪：`git checkout -- <path>`；未跟踪：删除文件（拒绝 symlink/目录）；返回 `{reverted: string[]}`                                                        |
| GET    | `/api/gateway`                                   | `{enabled:boolean, port:7420, addresses: string[], devices: [], implemented:false}`；enabled 来自当前 workspace.gatewayEnabled（query `workspaceId`）                   |
| GET    | `/api/terminals/{sessionId}`                     | `TerminalSession`（新增 `pid: number                                                                                                                                    | null`）                               |
| POST   | `/api/terminals/{sessionId}/terminate`           | 终止会话（现有 WS 内 terminate 也保留）                                                                                                                                 |
| GET    | `/api/agents`                                    | 现有 `AdapterInfo[]`，新增 `resolvedPath: string                                                                                                                        | null`                                 |

ACP WebSocket `update` 事件的归一化（`acp.rs normalize_update`）改为结构化：

```json
{ "kind": "message",  "text": "..." }
{ "kind": "user",     "text": "..." }
{ "kind": "thinking", "text": "..." }
{ "kind": "tool", "toolCallId": "...", "title": "读取文件", "status": "pending|in_progress|completed|failed", "toolKind": "read|edit|execute|...|null", "detail": "参数/路径摘要或 null" }
{ "kind": "plan", "entries": [{"content":"...","status":"..."}] }
{ "kind": "usage", "inputTokens": n, "outputTokens": n }   // 仅当 Agent 提供
```

权限事件保持 `permission` / `permission_resolved`；`permission` 的 `request` 里若有 `toolCall.title`、`toolCall.kind`、`toolCall.rawInput` 原样透传。

`validate_context_items` 接受新 kind 集合。

---

## 4. Web Store 契约（`apps/web/src/store/canvas-store.ts`）

```ts
interface CanvasState {
  workspace: Workspace | null;
  boards: Board[];                    // 当前 workspace 的看板
  boardId: string | null;             // 当前看板
  document: BoardDocument | null;     // 当前看板文档（nodes/edges/strokes/viewport）
  selectedNodeId: string | null;
  saveState: "idle"|"dirty"|"saving"|"saved"|"failed"; saveError: string|null;
  tool: "select" | "pen"; penColor: string;
  mobilePanel: "resources"|"canvas"|"inspector";
  modal: null | "newWorkspace" | "settings" | "command" | "diffScan";
  summaryThreshold: number;           // 0.6 默认，来自设置

  setWorkspace(ws|null); setBoards(boards); selectBoard(boardId);
  setDocument(doc); selectNode(id|null); setSaveState(); setSaveError();
  setTool(); setPenColor(); setModal(); setMobilePanel(); setSummaryThreshold();
  addNode(data, position?, options?: {size?, zoom?, select?}) => CanvasNode|null;
  updateNode(id, partialData); moveNode(id, position); resizeNode(id, size);
  setNodeZoom(id, zoom);               // focus 时其它 focus 节点回到 normal
  removeNodes(ids[]); duplicateNode(id);
  addEdge(source, target, type) ; removeEdges(ids[]);
  addStroke(stroke); clearStrokes();
  setViewport(viewport);               // 不置 dirty（单独节流保存）；实现：viewport 写入 document 但 saveState 只在 nodes/edges/strokes 变化时置 dirty，viewport 由 App 以 2s 节流单独 PUT
  arrangeNodes(positions: Record<id,{x,y}>);
}
```

`inferEdgeType(source, target)`：task→agent `dispatch`；file/context/note/browser/image/log→agent `ref`；agent→diff `produce`；diff→file `write`；agent/terminal→terminal/agent `trigger`；其它 `link`。`legalEdgeTypes` 永远返回全部 6 种，推荐项排第一。

---

## 5. 前端文件结构与归属

```
apps/web/src/
  styles.css                    # 只 @import 下列文件
  styles/tokens.css             # 主题变量（§6）            [A3]
  styles/base.css               # reset、字体、通用按钮/输入  [A3]
  styles/shell.css              # 顶栏/轨/侧栏/Inspector/状态栏/启动页 [A3→B4]
  styles/canvas.css             # 画布、工具栏、缩放、边、picker、笔迹、拖放提示 [B1]
  styles/nodes.css              # 节点卡片外壳 + 各节点内部 [B3]
  styles/modals.css             # 四个弹层 + ConfirmDialog   [B4]
  i18n/index.ts                 # 合并各模块 messages         [A3]
  i18n/shell.ts launcher.ts canvas.ts nodes.ts agent.ts terminal.ts inspector.ts explorer.ts modals.ts
  preferences/Preferences.tsx   # 只保留 Provider/t/theme/locale/summaryThreshold，messages 来自 i18n [A3]
  platform/index.ts             # isTauri(), pickDirectory(), openExternal(url), onFileDrop(cb)  [A3 建 web 回退 → B4 补 Tauri]
  app/App.tsx                   # 壳布局 + 数据加载 + 保存 + 快捷键挂载 [A3；B1 提供 shortcuts hook]
  app/Launcher.tsx              # 启动页 [A3]
  shell/Topbar.tsx Rail.tsx Sidebar.tsx StatusBar.tsx   [A3→B4]
  sidebar/BoardList.tsx [A3]  FileTree.tsx NodePalette.tsx [B2]
  inspector/Inspector.tsx       [B3]
  canvas/CanvasWorkspace.tsx CanvasToolbar.tsx ZoomControls.tsx StrokeLayer.tsx SemanticEdge.tsx EdgePicker.tsx auto-arrange.ts shortcuts.ts edge-types.ts node-zoom.ts   [B1]
  canvas/NodeCard.tsx           # 节点外壳：头部(类型图标/标题/状态/−/⤢)、mini/focus 渲染、Handles、拖放目标 props  [B1]
  canvas/dnd/payload.ts DropLayer.tsx useNodeDropTarget.ts paste.ts   [B2]
  canvas/context.ts             [A1]
  nodes/index.ts                # 类型 → 内容组件注册表 + 类型元数据（图标/颜色/默认尺寸/中文名） [A3 建骨架，B3 填]
  nodes/TaskNode.tsx AgentNode.tsx TerminalNode.tsx DiffNode.tsx FileNode.tsx ContextNode.tsx NoteNode.tsx BrowserNode.tsx ImageNode.tsx LogNode.tsx  [B3]
  agent/AcpSurface.tsx  terminal/TerminalSurface.tsx   [B3]
  modals/NewWorkspaceModal.tsx SettingsModal.tsx CommandPalette.tsx DiffScanDrawer.tsx  [B4]
  components/ConfirmDialog.tsx  [保留]
  api/client.ts  save/canvas-save-queue.ts  store/canvas-store.ts  [A1]
```

**跨归属接口（必须按此签名，谁归属谁实现，其他人只调用）：**

- `nodes/index.ts`：`NODE_META: Record<NodeType, { label: string; description: string; icon: LucideIcon; color: string; softColor: string; defaultSize: {width,height}; glyph: string }>`；`NODE_CONTENT: Record<NodeType, ComponentType<{ id: string; data: CanvasNodeData; focused: boolean }>>`。
- `canvas/dnd/useNodeDropTarget.ts`：`useNodeDropTarget(nodeId: string, nodeType: NodeType): { onDragOver, onDragLeave, onDrop, isOver: boolean }`（B2 实现，B1 的 NodeCard 调用）。
- `canvas/dnd/DropLayer.tsx`：`<DropLayer />` 渲染在 `<ReactFlow>` 兄弟位置，内部用 `useReactFlow()`；`canvas/dnd/paste.ts`：`usePasteToCanvas()` hook（B2 实现，B1 在 CanvasWorkspace 调用）。
- `canvas/shortcuts.ts`：`useCanvasShortcuts()`（B1 实现，A3 的 App 调用）。
- `platform/index.ts`：`isTauri(): boolean`、`pickDirectory(): Promise<string|null>`、`openExternal(url): Promise<void>`、`onFileDrop(cb: (paths: string[], position: {x,y}) => void): () => void`。
- `store` 的 `modal` 字段由 Topbar/Rail/快捷键设置，B4 的弹层组件只读它并渲染。
- Inspector 的「可执行动作」通过 `nodes/index.ts` 导出 `NODE_ACTIONS: Record<NodeType, (ctx) => Action[]>`（B3 实现）。

`ReactFlowProvider` 包在 App 最外层（A3），任何组件可用 `useReactFlow()`。

---

## 6. 主题 Token（`styles/tokens.css`）

```css
:root {
  /* light */
  --bg: #f3f4f8;
  --panel: #ffffff;
  --card: #ffffff;
  --card2: #f5f6fa;
  --border: rgba(25, 28, 50, 0.09);
  --text: #1b1d26;
  --muted: #6b7080;
  --faint: #a0a5b3;
  --dot: rgba(25, 28, 50, 0.1);
  --accent: #5b5bd6;
  --accent-soft: rgba(91, 91, 214, 0.12);
  --accent-line: rgba(91, 91, 214, 0.35);
  --ok: #1f9d64;
  --warn: #d18f0f;
  --warn-soft: rgba(209, 143, 15, 0.1);
  --err: #dc4c4a;
  --err-soft: rgba(220, 76, 74, 0.1);
  --info: #2e7cf6;
  --info-soft: rgba(46, 124, 246, 0.12);
  --diff: #8a4fd6;
  --diff-soft: rgba(138, 79, 214, 0.12);
  --shadow: 0 6px 20px rgba(30, 30, 70, 0.07);
  --shadow-lg: 0 24px 60px rgba(30, 30, 70, 0.22);
  --term-bg: #1b1d26;
  --topbar-h: 36px;
  --rail-w: 52px;
  --sidebar-w: 236px;
  --inspector-w: 272px;
  --statusbar-h: 24px;
  --font-ui:
    -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    system-ui, sans-serif;
  --font-mono: ui-monospace, Menlo, monospace;
}
:root[data-theme="dark"] {
  --bg: #0e0f12;
  --panel: #15161a;
  --card: #1b1c21;
  --card2: #23252b;
  --border: rgba(255, 255, 255, 0.08);
  --text: #edeef2;
  --muted: #9a9fad;
  --faint: #666b78;
  --dot: rgba(255, 255, 255, 0.08);
  --accent: #7c7cf0;
  --accent-soft: rgba(124, 124, 240, 0.18);
  --accent-line: rgba(124, 124, 240, 0.45);
  --ok: #3fbf7f;
  --warn: #e3b341;
  --warn-soft: rgba(227, 179, 65, 0.12);
  --err: #f0605d;
  --err-soft: rgba(240, 96, 93, 0.14);
  --info: #5b9bf0;
  --info-soft: rgba(91, 155, 240, 0.16);
  --diff: #c792ea;
  --diff-soft: rgba(199, 146, 234, 0.16);
  --shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  --shadow-lg: 0 30px 70px rgba(0, 0, 0, 0.6);
  --term-bg: #0a0b0d;
}
```

节点类型色（`nodes/index.ts`，与设计稿一致）：task `#2E7CF6`、agent `#5B5BD6`、terminal `#1F9D64`、diff `#8A4FD6`、file `#D18F0F`、context `#0E9AA7`、log `#6B7080`、image `#E0762E`、note `#B8860B`、browser `#0E9AA7`；softColor 为同色 14% 透明。默认尺寸：task 280×250、agent 430×600、terminal 480×280、diff 400×420、file 300×230、context 280×150、log 360×220、image 260×200、note 260×180、browser 520×380；mini 240×52。画笔色：`#5B5BD6 #DC4C4A #1F9D64 #D18F0F #1B1D26`。

状态文案/图标：running ◐ 运行中（旋转）· waiting ⏸ 等待确认 · done ✓ 已完成 · review ◇ 待审阅 · modified ● 已修改 · idle ○ 空闲 · error ✕ 失败 · disconnected ⊘ 已断开 · connecting ◌ 连接中（旋转）· linked ⇄ 已引用。颜色：running/accent、waiting/warn、done/ok、review/diff、modified/warn、idle/muted、error/err、disconnected/err、connecting/warn、linked/info。

连线语义：link ⇄ 软链接（虚线）· dispatch ➤ 派发给 · produce ◆ 产出 · write ✎ 写入 · trigger ⚡ 触发 · ref @ 引用（虚线）。

---

## 7. 实施阶段与并行分工

| 阶段 | Agent          | 范围                                                                                                                                                                                                                                                                                           | 依赖                            |
| ---- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| A1   | shared-store   | `packages/shared`（domain v2、api v2、adapter、context）、`apps/web/src/api/client.ts`、`store/canvas-store.ts`、`save/canvas-save-queue.ts`、`canvas/context.ts` 及其测试；让现有 web 组件在类型上暂时通过（最小改动，允许临时 `// TODO(A3)`）                                                | 无                              |
| A2   | runtime        | `apps/runtime`：迁移 0003、model/db/api/lib、git status/stage/revert、acp 归一化、terminal pid/terminate、gateway、context kinds；`cargo test` 通过                                                                                                                                            | 无（按 §2/§3 契约）             |
| A3   | shell          | token/CSS 拆分、i18n 拆分、Preferences 精简、platform 回退、App 壳布局（顶栏/轨/侧栏/Inspector 占位/状态栏）、Launcher、BoardList、`nodes/index.ts` 骨架（元数据 + 暂时复用旧内容组件）、NodeCard 拆分为外壳 + 内容注册表；桩文件：`canvas/dnd/*`、`canvas/shortcuts.ts`、`modals/*`（空组件） | A1                              |
| B1   | canvas         | 画布核心：工具栏、缩放柱、tri-state zoom + 阈值、笔迹层、一键整理、语义边 v2 + picker 热键、快捷键 hook、NodeCard 外壳最终版、去 MiniMap                                                                                                                                                       | A3                              |
| B2   | dnd            | 文件树（懒加载展开、Git 徽标、可拖）、节点面板、DropLayer、节点拖放目标、粘贴、启动页拖入文件夹                                                                                                                                                                                                | A3                              |
| B3   | nodes          | 10 个节点内容组件、AcpSurface v2、TerminalSurface v2、Inspector v2、NODE_ACTIONS、Diff 接受/回滚接入 API                                                                                                                                                                                       | A3（API 由 A2 提供，契约见 §3） |
| B4   | modals-desktop | 四个弹层、Topbar/Rail/StatusBar 最终版（网关态、Git 态、Diff 计数、⌘K 入口）、Tauri dialog/opener/拖放 + CSP + capabilities、settings 持久化                                                                                                                                                   | A3                              |
| C    | integrate      | `pnpm typecheck && pnpm test && pnpm build && cargo test`，浏览器逐屏对照原型截图，修复集成问题，更新 `docs/implementation-status.md`、`docs/interface-design.md`、README                                                                                                                      | B1–B4                           |

规则：

1. 只改自己归属的文件；需要别人文件的改动，在报告里写明"需要 X 在 Y 文件加 Z"，由集成阶段处理。i18n 只改自己的模块文件。
2. 不引入新的 npm/cargo 依赖，除非本文列出：`@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-opener`（B4）。
3. 每个阶段结束必须 `pnpm --filter <pkg> typecheck` 与相关测试通过；A2 必须 `cargo test -p ai-coding-canvas-runtime` 通过。
4. 不做假数据：没有真实来源的字段（tokens、外部端设备）要么隐藏，要么标注「预留」。
5. 中文文案放 i18n 模块，不硬编码在 JSX 中（简单符号除外）。
