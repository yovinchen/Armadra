# AI Coding OS 最终方案与画板选型

> 状态：已确认；**画布层已于 2026-09-04 由 tldraw 取代 React Flow**，见
> [tldraw-canvas-plan.md](./tldraw-canvas-plan.md) 与本文 §2.1 / §5 / §7  
> 日期：2026-08-13（画布层 2026-09-04 更新）  
> 完整讨论归档：[ChatGPT 会话归档](./research/chatgpt-conversation-archive.md)

## 1. 最终结论

项目定位为：

> 一个 local-first 的 AI Coding 工作台。用户在无限工作区中组织终端、Agent、文件、任务、浏览器、日志和 Diff，通过连线传递上下文，并让执行结果回流为可审查的节点。

最终技术方案：

```text
唯一前端：React + TypeScript + Vite
主画板：tldraw 5（节点与白板同一套 store；原为 React Flow，见 §2.1）
终端 UI：xterm.js
本地/远程执行服务：Rust + Axum + Tokio
本地存储：SQLite
桌面壳：Tauri 2
通信：HTTP + WebSocket
后续同步：领域事件 + Postgres / 对象存储；需要实时协作时再引入 CRDT
```

画板最终裁决（2026-09-04 修订）：

- **主画板使用 tldraw 5**：节点、分组、连线、手绘、几何、文字、图片全在同一个
  store、同一套相机 / 选择 / 撤销里。
- **不叠加第二个画板引擎**：Quickdraw 的 `WhiteboardNode` 方案作废——白板能力
  由 tldraw 原生提供，不再需要「画布里再嵌一个画布」。
- 下面 §2–§5 是 2026-08-13 那次选型的原文，保留作为决策脉络；结论已被 §2.1
  取代。

## 2.1 为什么后来换成了 tldraw（2026-09-04）

React Flow 版本跑了两个大版本之后暴露出三件事，都不是能靠加代码绕过去的：

1. **白板是刚需，而不是「第三阶段的可选项」**。用户要在节点旁边随手画、贴图、
   贴文字、画框分区。在 React Flow 上做这些等于自己写第二套图形编辑器；叠一个
   Quickdraw 又会出现两套相机、两套选择、两套撤销。
2. **「从任何东西拉一条线到 Agent，Agent 就能读它」**要求箭头能绑到**任意**图形，
   而不只是节点。React Flow 的边只连节点句柄。
3. tldraw 的 `ShapeUtil` 可以渲染任意 React 组件，所以终端节点原样搬过去就行；
   `BindingUtil` 让箭头能绑任何 shape；`components` 槽位可以逐个置空换成我们
   自己的 shadcn UI。

代价与对策见 [tldraw-canvas-plan.md](./tldraw-canvas-plan.md) §10（视口裁剪、
体内事件、快捷键冲突、字体自托管、快照体积、水印六条风险的实测结论）。

## 2. 为什么主画板必须是 React Flow（2026-08-13 原文，已被 §2.1 取代）

这个产品的核心不是传统白板，而是可执行的节点图：

```text
File / Task / Log / Screenshot
              ↓ context
         Agent / Terminal
              ↓ execute
       Diff / Test / Browser
```

必须优先支持：

- Terminal Node：嵌入 xterm.js，处理真实键盘和鼠标输入。
- Browser Node：地址栏、网页预览、截图、控制台错误。
- Agent Node：状态、执行目标、启动/停止、等待确认。
- File / Folder Node：文件树、预览、路径、Git 状态。
- Diff Node：文件变更、patch、接受或回滚。
- Task Node：任务状态和依赖。
- 具有 `context`、`input`、`output`、`patches`、`verifies` 等语义的边。

React Flow 的自定义节点本身就是 React 组件，可以直接放入输入框、图表和其他交互元素；节点容器已提供位置、选择、拖动和连接能力。自定义边同样是 React 组件，可以承载语义标签和操作控件。

这与项目的领域模型天然一致：

```typescript
interface CanvasNode {
  id: string;
  type:
    | "terminal"
    | "agent"
    | "file"
    | "folder"
    | "browser"
    | "task"
    | "diff"
    | "log"
    | "image"
    | "markdown"
    | "whiteboard";
  position: { x: number; y: number };
  data: unknown;
}

interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  type: "context" | "input" | "output" | "depends_on" | "patches" | "verifies";
}
```

React Flow 还是 MIT 许可，可用于商业项目；Pro 服务不是运行 SDK 的强制条件。

参考：

- [React Flow 自定义节点](https://reactflow.dev/learn/customization/custom-nodes)
- [React Flow 自定义边](https://reactflow.dev/learn/customization/custom-edges)
- [xyflow 仓库与 MIT 许可](https://github.com/xyflow/xyflow)

## 3. Quickdraw 的定位

Quickdraw 是轻量、MIT 许可的无限白板 SDK，优势很明确：

- 手绘、高亮、形状、箭头、文字、便签和图片。
- 平移、缩放、选择、旋转、撤销和 PNG 导出。
- React、React Native 和原生 JavaScript 接入。
- 文档记录以 JSON-safe diff 形式变化，便于保存、同步和回放。
- 零运行时依赖，许可简单。

但它当前不适合成为本项目的主画板。

### 3.1 当前渲染模型不适合交互节点

Quickdraw 当前通过两个 Canvas 元素绘制场景和选择覆盖层。公开的 Shape 类型只有：

```typescript
"draw" | "highlight" | "geo" | "arrow" | "line" | "text" | "note" | "image";
```

终端、浏览器、文件面板不是 Canvas 2D 图形，而是需要持续交互、焦点管理、滚动和输入法支持的 DOM/React 组件。

如果把 Quickdraw 改成主画板，需要自行实现：

1. `terminal`、`browser`、`agent` 等新记录类型。
2. 与相机缩放和平移同步的 DOM overlay。
3. Canvas 与 DOM 之间的层级和事件路由。
4. 双击激活、Esc 退出、拖动画布与节点输入的模式切换。
5. DOM 节点的选择、缩放、旋转、复制和命中测试。
6. 快照、导出、协作 diff 和撤销历史兼容。
7. iframe、xterm.js、输入法和剪贴板的焦点处理。

这不再是普通集成，而是在维护一个深度 fork。

### 3.2 当前缺失的能力

Quickdraw 官方路线图仍明确列出以下缺失项：

- 第一方多人同步服务。
- Layers。
- Frames。
- Rich text。

这些能力不是全部都必须有，但 Frames、分组、复杂 DOM 节点和多人协作正好接近本项目后续需要投入的部分。

参考：

- [Quickdraw 仓库与功能说明](https://github.com/quickdrawjs/quickdraw)
- [Quickdraw Shape 渲染实现](https://github.com/quickdrawjs/quickdraw/blob/main/packages/core/src/shapes.js)
- [Quickdraw Editor Canvas 架构](https://github.com/quickdrawjs/quickdraw/blob/main/packages/core/src/editor.js)

## 4. 画板对比（2026-08-13 原文，结论已被 §2.1 取代）

> 下表最后一行的「当前建议」是 2026-08-13 的判断。2026-09-04 改用 tldraw：
> 「Terminal/Browser React 节点」与「语义连线」两行在 tldraw 上都已跑通
> （`ShapeUtil` 渲染真 xterm、自定义 `link` shape + `BindingUtil`），而「手绘与
> 便签」那一行正是换引擎的动因。许可一行仍然成立，用户决定带水印上线、
> 不申请 license key（[tldraw-canvas-plan.md](./tldraw-canvas-plan.md) §12）。

| 维度                        | React Flow        | Quickdraw                   | tldraw                  |
| --------------------------- | ----------------- | --------------------------- | ----------------------- |
| 核心定位                    | 节点图、工作流 UI | 轻量自由白板                | 完整无限画布 SDK        |
| Terminal/Browser React 节点 | **天然适合**      | 需要 DOM overlay 和深度改造 | 可通过自定义 Shape 实现 |
| 语义连线                    | **原生核心能力**  | 只有普通箭头/线             | 需要 Shape/Binding 建模 |
| 手绘与便签                  | 需要补充          | **原生优秀**                | **原生优秀**            |
| 领域数据匹配度              | **最高**          | 低                          | 中                      |
| MVP 改造量                  | **最低**          | 高                          | 中                      |
| 许可                        | MIT               | MIT                         | 生产环境需要有效许可    |
| 当前建议                    | **主画板**        | 可选白板节点                | 不采用                  |

tldraw 的画板能力更完整，但当前 SDK 不是宽松开源许可，生产环境需要有效 license key；开源项目的下游用户也需要各自满足其生产许可要求。因此它不适合作为这个计划中的默认基础依赖。

参考：[tldraw 许可说明](https://tldraw.dev/community/license)

## 5. Quickdraw 最合适的接入方式（作废，2026-09-04）

> **本节整节作废**：白板能力由 tldraw 原生提供，没有也不会有 `WhiteboardNode`。
> 保留原文只为说明「两套画板引擎会打架」这个判断——它是对的，所以最终的做法
> 不是叠加，而是把节点搬进白板引擎里。

不建议把 Quickdraw 覆盖在整个 React Flow 工作区上。两套相机、选择、键盘快捷键和撤销系统会发生冲突。

推荐把 Quickdraw 放入独立节点：

```text
React Flow 主工作区
├── TerminalNode
├── AgentNode
├── FileNode
├── BrowserNode
├── DiffNode
└── WhiteboardNode
    └── Quickdraw
        ├── 手绘
        ├── 便签
        ├── 箭头
        ├── 图片
        └── 标注
```

`WhiteboardNode` 保存：

```typescript
interface WhiteboardNodeData {
  title: string;
  quickdrawSnapshot: unknown;
  previewImage?: string;
  syncPolicy: "local_only" | "metadata_only" | "full_sync";
}
```

交互规则：

- 单击节点：选择或拖动节点。
- 双击或点击“进入白板”：激活内部 Quickdraw。
- 内部交互时阻止 React Flow 的拖动和缩放。
- 按 Esc：退出白板交互，控制权返回主工作区。
- 缩略状态显示预览图，激活时才挂载完整编辑器。
- Quickdraw 的撤销历史只管理白板节点内部；工作区撤销只管理节点位置和连线。

这样既保留 Quickdraw 的优势，也不会让它承担不适合的终端和流程编排职责。

## 6. 已确认的系统边界

### apps/web：唯一页面

```text
React + TypeScript + Vite
tldraw 5（画布：节点 shape + 原生白板 shape + frame 分组）
xterm.js
CodeMirror 6
Zustand
TanStack Query
```

负责画板、节点、终端展示、文件预览、Diff、任务和权限确认 UI。

### apps/runtime：唯一执行服务

```text
Rust
Axum
Tokio
WebSocket
portable-pty
SQLx + SQLite
notify
Git CLI wrapper
SSH（第二阶段）
```

负责 PTY、进程、文件访问、Git、Agent CLI、SSH、日志脱敏和权限策略。

### apps/desktop：薄桌面壳

```text
Tauri 2
```

只负责：

- 启动和停止 Runtime。
- 等待 Runtime 健康检查。
- 打开同一套 Web 页面。
- 托盘、通知、更新和系统权限入口。

业务逻辑不写入 Tauri command，避免形成第二套后端。

## 7. 数据模型原则

画板库不是业务数据库。必须保持领域模型与渲染引擎解耦：

```text
                  ┌──────────────── 内存真相 ────────────────┐
                  │  tldraw store（shape / binding / asset）   │
                  └───┬───────────────────────┬──────────────┘
       派生 nodes/edges │                       │ 其余记录整份序列化
                        ▼                       ▼
        Workspace / Target / Node / Edge     白板快照（不透明 JSON）
        （SQLite 的 nodes / edges 表）        （boards.whiteboard_json）
```

- **tldraw 的 store 是画布在内存里的唯一真相**，`canvas-store.document` 由它派生
  （`apps/web/src/canvas/sync/`）。
- 持久化分两条通道，`PUT .../boards/{id}/document` 一次带走：
  - **节点与连线**仍是 Runtime 的 `nodes` / `edges` 表——Runtime、控制动词、
    会话侧栏、上下文链接全都只认这张表，一行都没为画布换引擎而改。
    节点 `<uuid>` ↔ shape `shape:<uuid>`，不查表；分组是原生 `frame`。
  - **白板原生内容**（手绘、几何、文字、图片、高亮）序列化成一份 tldraw 快照，
    原样存进 `boards.whiteboard_json`，**Runtime 不解析它**。写之前先剔掉所有
    节点记录（`canvas/sync/snapshot.ts`），否则同一份数据会存两遍、加载时打架。
    上限 8 MiB，超了这一轮不保存并提示。
  - **图片资产不进快照**：字节走 `POST /api/workspaces/{id}/assets`（或按路径
    `.../assets/import`），内容寻址落在工作区的 `.armadra/assets/<sha256 前 16 位>.<ext>`，
    快照里只留 URL 与工作区相对路径。
- 终端原始输出、密钥和 `.env` 默认不进入画板同步。
- 后续替换画板引擎时，不迁移 Runtime 和领域数据模型。

## 8. 实施顺序

### Phase 1：MVP

只使用 React Flow（2026-09-04 起画布是 tldraw，其余步骤不变）：

1. Workspace 和授权目录。
2. File / Folder Node。
3. Terminal Node + xterm.js。
4. Agent Node 通过 ACP v1 启动 Claude / Codex / Gemini / OpenCode / Pi / OMP；不再向交互式 shell 注入 Prompt。
5. Task/File 到 Agent 的上下文连线。
6. Git Diff 回流为 Diff Node。
7. SQLite 保存和恢复。
8. Tauri 启动 Runtime 并打开 Web 页面。

### Phase 2：远程和浏览器

1. SSH Host 和 SSH Terminal Node。
2. Browser Node 打开 localhost 或文档。
3. 截图、console error 和测试结果回流。
4. 权限策略、日志脱敏和审计。

### Phase 3：白板能力

**已实施（2026-09-04），结论与下面的原计划不同**：没有加白板节点，而是把整个
画布换成了 tldraw，手绘 / 几何 / 文字 / 图片 / frame 全是原生 shape，与节点共用
一套相机、选择与撤销。见 [tldraw-canvas-plan.md](./tldraw-canvas-plan.md)。

~~按真实使用反馈选择：只需要简单标注就在 React Flow 上实现轻量自由绘制层；
需要完整白板就增加嵌入 Quickdraw 的 `WhiteboardNode`。~~

### Phase 4：协作

1. 先同步领域事件和节点数据。
2. 元数据与终端/代码内容分层。
3. 确认多人实时编辑需求后再加入 Yjs 或其他 CRDT。
4. 不直接把画布引擎（现在是 tldraw）的内部数据结构当跨端协议——白板快照对
   Runtime 是一段不透明字符串，节点与连线走 §7 的领域表。

## 9. 最终确认

最终方案不再摇摆：

```text
主画板：tldraw 5（节点 shape + 原生白板 shape，同一套 store / 相机 / 撤销）
自由白板：tldraw 原生，不再有独立的 WhiteboardNode
前端：React + TypeScript + Vite
Runtime：Rust + Axum + Tokio
终端：xterm.js + PTY + WebSocket
桌面：Tauri 2 薄壳
存储：SQLite local-first
远程：SSH / Remote Runtime 后置
协作：领域同步优先，CRDT 后置
```

2026-08-13 选 React Flow 的理由是「可执行节点和语义连线」，那时把「自由绘制、
标注和视觉表达」排在后面。2026-09-04 的修订不是推翻这个优先级，而是发现
tldraw 两件事都能做：自定义 shape 渲染真终端、自定义 binding 承载语义连线，
同时白板是原生的。所以画布层换成 tldraw，领域模型、Runtime、控制动词一行没改
——这正是 §7「画板库不是业务数据库」当初就想留出的余地。
