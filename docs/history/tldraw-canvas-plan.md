# v4 方案：画布换成 tldraw，白板与 Agent 节点同一套模型

> 状态：**已被 [canvas-react-flow.md](../design/canvas-react-flow.md) 取代**（2026-09-06）。画布引擎已整体换回 React Flow，白板层自写；本文只作追溯。**§N 编号仍被源码注释引用（`tldraw plan §6.1` / `§6.2` / `§6.3`），不要重排。**  
> 取代原因：tldraw 5.4 的 `LicenseProvider` 在非开发来源（打包桌面的 `tauri://localhost`）上没有密钥时，挂载 5 秒后会卸掉整个编辑器，画布与终端 socket 一起消失。详见新文的 §0。  
> 历史状态：Phase 0–4 已实施（2026-09-04，分支 `main`，未合并）。实现与验证数字见 [implementation-status.md](./implementation-status.md) 的「v4 tldraw 画布」，跨 agent 交接见 [phase1-handoff.md](./phase1-handoff.md)  
> 基线：分支 `main`，[v3-agent-terminal-plan.md](../contracts/v3-agent-terminal-plan.md) 的 §5（Agent 运行时）、§13（接口契约）、§14（文案与组件原则）、§15（tmux 后端）、§18（终端兼容）继续有效；本文只替换画布层  
> 输入：2026-09-04 代码盘点（`apps/web/src/canvas` 3.4k 行、`nodes` 2.4k 行、`store/canvas-store.ts` 810 行、13 个文件直接 import `@xyflow/react`、45 个文件消费 `canvas-store`）、tldraw 5.4.0（peer React `^19.2.1`，本项目 19.2.8）

## 0. 一句话结论

把 React Flow 换成 tldraw，**tldraw 的 store 成为画布在内存里的唯一真相**：Agent 终端、便签、编辑器等节点是自定义 shape，分组是 tldraw 原生 frame，上下文链接是两端绑定的 tldraw 箭头，手绘、几何、文字、图片、高亮是 tldraw 原生 shape。持久化分两条通道：节点与连线仍是 Runtime 的 `nodes` / `edges` 表（Runtime、hook、控制动词、会话侧栏一行都不用改），白板原生内容存成一份 tldraw 快照放在 `boards.whiteboard_json`。`canvas-store` 保留全部动作签名，内部改成驱动 tldraw editor，所以 45 个消费方几乎不动。

用户得到的：Excalidraw 级别的随手画、贴文字、贴图片、画框分区，加上「从任何东西拉一条箭头到 Agent，Agent 就能读它」。

## 1. 选型依据

| 维度               | Excalidraw                           | tldraw 5.4                                           | 决定             |
| ------------------ | ------------------------------------ | ---------------------------------------------------- | ---------------- |
| 自定义元素         | 无。元素类型固定，终端只能叠在另一层 | `ShapeUtil` 渲染任意 React 组件                      | tldraw           |
| 箭头绑定           | 只绑自己的元素                       | 箭头可绑任何 shape，且有自定义 `BindingUtil`         | tldraw           |
| 视口 / 选择 / 撤销 | 与 React Flow 双轨                   | 一套                                                 | tldraw           |
| UI 可替换          | 整套自带 UI，难融入 shadcn           | `components` 逐槽位替换或置空                        | tldraw           |
| 风格               | 手绘固定                             | 几何为主，手绘笔刷可选；与终端、编辑器同框协调       | tldraw           |
| 许可               | MIT                                  | 免费使用带「Made with tldraw」水印，去水印需许可 key | 先带水印，见 §12 |
| React 19           | 支持                                 | peer `^19.2.1`，本项目 19.2.8                        | 通过             |

## 2. 目标与非目标

目标：

1. 白板能力：手绘（笔、高亮）、几何（矩形、椭圆、菱形…）、直线与箭头、文字、图片（粘贴 / 拖入 / 裁剪）、frame 分区、样式（颜色、粗细、虚实、填充）。
2. 现有节点全部保留并可缩放、折叠、最大化、右键、resize，终端零回归（§18 清单逐项重跑）。
3. 「连线即链接」：两个节点之间的箭头 = 上下文链接；节点与白板内容（文字、图片、frame、任意 shape）之间的箭头 = Agent 可读该内容。
4. 撤销、缩放手势、100% 打开、整理布局、缩略图、会话侧栏居中定位，行为与 v3 相同或更好。

非目标（本方案不做）：多人协同、tldraw 的多页面（page）、tldraw 自带的书签 / 嵌入 / 视频 shape、Runtime 理解 tldraw 记录格式。

## 3. 架构

```text
                      ┌──────────────── 内存真相 ────────────────┐
                      │  tldraw store（shape / binding / asset）   │
                      └───┬───────────────────────┬──────────────┘
        节点与连线的投影   │                       │  白板原生内容
                          ▼                       ▼
            canvas-store.document（只读派生）      getSnapshot() 过滤
            ├─ 会话侧栏 / 缩略图 / context-links   │
            ├─ autosave → POST /boards/{id}/save   │ 合并进同一次 save
            └─ Runtime nodes / edges 表            └─ boards.whiteboard_json
```

三条规则：

1. **tldraw store 是内存真相。** 拖动、resize、连线、撤销都发生在 tldraw；`canvas-store.document` 由 `store.listen` 派生，只读，给画布之外的模块用（侧栏、会话列表、context-links、缩略图、命令面板）。
2. **`canvas-store` 的动作签名不变，实现改为驱动 editor。** `addNode / updateNode / updateNodeData / moveNodes / resizeNode / setCollapsed / maximizeNode / restoreNode / setParent / removeNodes / duplicateNodes / addEdge / removeEdges / setViewport / undo / redo / arrangeNodes` 全部保留；`history` 字段删除，撤销改走 `editor.undo()`。这样 45 个消费方里只有 13 个直接 import React Flow 的文件需要改。
3. **Runtime 只认 `nodes` / `edges`，白板快照对它是不透明字符串。** 控制动词（`open-agent` / `sticky` / `link` / `rename` / `color` / `close`）、hook 服务、会话索引一行不改。远端改动（Agent 开节点）经现有 WS 事件 → 重新加载文档 → `store.mergeRemoteChanges` 灌回 tldraw，不进撤销栈。

## 4. 形状模型

### 4.1 节点 shape：`armadra`

一种自定义 shape 类型，`props` 直接镜像 `CanvasNode`（去掉 `position` / `size`，它们对应 shape 的 `x / y / w / h`）：

```ts
type ArmadraShape = TLBaseShape<
  "armadra",
  {
    w: number;
    h: number;
    nodeType: "terminal" | "sticky" | "editor" | "diff" | "files" | "browser";
    title: string;
    color: string;
    collapsed: boolean;
    expandedHeight?: number;
    labels: string[];
    note: string;
    data: CanvasNodeData; // 与 shared 的 discriminatedUnion 完全一致
  }
>;
```

- id 约定：`shape:<节点 uuid>`，双向映射不用查表。
- `ArmadraShapeUtil` 负责几何（矩形）、resize（按 `NODE_META.minSize`）、指示器、`canEdit=false`、`hideSelectionBoundsFg`；`component()` 渲染现有 `NodeShell` + `NODE_BODY[nodeType]`，节点体代码不动。
- **拖拽只认头部**：节点体 `onPointerDown` 停止冒泡（等价现在的 `nodrag`），头部不拦截，tldraw 的 select 工具负责拖动。终端体、编辑器、浏览器、便签正文都属于「体」。
- **滚轮**：节点体 `onWheel` 停止冒泡（等价 `nowheel`），终端的滚轮继续走 tmux copy-mode 桥；头部与空白处交给 tldraw 相机。
- 折叠：`h = COLLAPSED_HEIGHT`，展开时恢复 `expandedHeight`；最大化：改真实 `x/y/w/h`，`premaxRect` 仍记在 `canvas-store.maximized`。
- 折叠时体只 `display:none` 不卸载（§3.4 规则不变）。

### 4.2 分组 = tldraw 原生 `frame`

frame 天生就是「有标签、能裁剪、拖进拖出自动换父」的组框。frame 的 `name` = 组节点 `title`，`color` = 组节点 `color`（5.x 的 frame 有颜色属性，PoC 确认）。持久化时 frame ↔ `group` 类型的 `nodes` 行，子 shape 的 `parentId` ↔ `node.parentId`，坐标相对父级的约定与现在一致。`canvas.group` 命令 = 选中项外包一个 frame 并 `reparentShapes`。

### 4.3 上下文链接 = 两端绑定的 `arrow`

- 用户用箭头工具从 A 拉到 B，或从节点的左右把手拉线（把手保留：`armadra` 的 component 渲染两个把手，按下时 `editor.setCurrentTool("arrow")` 并起笔）。
- **落库规则**：一条 arrow 两端都绑定到 `armadra` 或 `frame` shape ⇒ 是一条 `edges` 行（id = `shape:<边 uuid>`）。只绑一端或绑到白板 shape ⇒ 不进 `edges`，但进白板快照，并按 §6.3 变成 Agent 可读的「内容链接」。
- 箭头方向语义不变：箭头头指向「可读端」；双方都是终端时双向。样式由 `edgeAppearance` 决定，通过 `editor.updateShapes` 写 arrow 的 `arrowheadStart / arrowheadEnd / color / dash`，用户手动改样式不影响语义。
- 合法性沿用 `connection.ts`：不能自连、同一对不能连两次；在 `sideEffects.registerBeforeCreateHandler("binding")` 里拦。
- 删除 arrow ⇒ 删 edge；删节点 ⇒ tldraw 自动清掉绑定的 arrow ⇒ 派生出 `removeEdges`。

### 4.4 派生边与子代理卡片 = `OnTheCanvas` 覆盖层

rope（`--after` 等待关系）与 subagent 卡片**不是 shape**，不入库、不可选中、不进撤销。用 `components.OnTheCanvas` 在页面坐标里渲染一层 SVG + 绝对定位卡片，位置从 `editor.getShapePageBounds` 每帧取。`derived-edges.ts` 的纯函数原样保留，只换渲染宿主。

### 4.5 白板原生 shape

**能用 tldraw 原生的就用原生**（用户 2026-09-04 定）：保留 `draw / highlight / geo / line / arrow / text / image / frame` 与对应工具；停用 `note / bookmark / embed / video`。便签仍是我们的 `armadra:sticky`，原因只有一个：Agent 的控制动词 `sticky` 会写 `nodes` 表，而 Runtime 不写白板快照；它可 Markdown、可 resize，tldraw 的 `note` 不开放，避免两种便签并存。

图片一律是 tldraw 原生 image shape，资源通过 §6.2 的资产接口落到工作区文件，而不是 base64 塞进 JSON。文本一律是 tldraw 原生 text shape。

`draw` 与 `image` 两种节点类型直接退役，**不做迁移**（2026-09-05 用户定：项目不兼容任何旧数据）。节点类型只有 6 种：`terminal / sticky / group(frame) / editor / diff / files / browser`。

## 5. 交互规范

| 手势 / 键                        | 归属                                          | 实现                                                                            |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| 滚轮                             | 平移（Shift 横向）                            | `cameraOptions.wheelBehavior: "pan"`                                            |
| ⌘/Ctrl + 滚轮、捏合              | 以光标为中心缩放 0.1–3                        | tldraw 内置，`zoomSteps` 与 `constraints` 按 §21 设                             |
| 空格 + 拖、中键拖                | 平移                                          | tldraw 内置                                                                     |
| 左键空白拖                       | 框选                                          | select 工具                                                                     |
| ⌘0 / ⌘1 / ⌘= / ⌘-                | 100% / 适应 / 放大 / 缩小                     | `keybindings.ts` → `canvas.*` 命令 → `editor.setCamera / zoomToFit`             |
| 工具键 V / D / R / A / T / H / F | 选择 / 笔 / 矩形 / 箭头 / 文字 / 高亮 / frame | 新增到 `keybindings.ts`，`allowInTerminal=false`，`allowWhileTyping=false`      |
| Delete / ⌘Z / ⌘A / ⌘D            | 现有 `canvas.*` 命令                          | 调 `editor.deleteShapes / undo / selectAll / duplicateShapes`                   |
| 右键                             | 我们自己的 ContextMenu                        | 空白处 = 添加菜单；shape 上 = 节点菜单或 shape 菜单（样式、置顶置底、转成便签） |
| 双击文字 / geo                   | tldraw 内置文字编辑                           | 保留                                                                            |

**只有一个键盘监听器**的规则（§8）不变：tldraw 的 UI 快捷键通过 `overrides` 清空全部 `kbd`，避免它和 `useKeybindings` 抢键。终端聚焦时除 §8 列的 7 条之外一律进 xterm。

**tldraw UI 槽位**：`Toolbar / MenuPanel / PageMenu / NavigationPanel / HelpMenu / DebugPanel / KeyboardShortcutsDialog / ContextMenu / QuickActions / ActionsMenu` 置空，由 Dock、右键菜单、命令面板承担；`Minimap` 与 `StylePanel` **复用 tldraw 默认实现并换肤**（用户定）：tldraw 的 `--color-panel / --color-text / --color-selected / --color-muted-* / --radius-*` 等变量在 `canvas.css` 里逐一映射到 `tokens.css` 的三级表面、圆角 6/10/12、字号 13/11 与深浅色；面板阴影、边框、间距对齐 Dock 与设置页；文字编辑与样式面板的字体走应用字体栈。验收标准是截图并排看不出两套风格。

**Dock** 新增工具组：选择、手、笔、高亮、形状（下拉）、箭头、文字、frame、图片；当前工具高亮；`Esc` 回到选择。Dock 仍是我们的 shadcn 组件。

## 6. 数据与 Runtime

### 6.1 数据库 schema

只有一份 `migrations/0001_initial.sql`（最终 schema，`boards.whiteboard_json TEXT NOT NULL DEFAULT ''`）。没有增量迁移：Runtime 启动时若发现本机数据库是别的版本写的（迁移账本里有本版本不认识的版本号或校验和），就把它改名为 `canvas.db.legacy-<时间戳>` 并新建空库，旧内容一律抛弃，不升级、不抢救。

- `GET /boards/{id}` 返回 `whiteboard: string`；`POST /boards/{id}/save` 请求体新增 `whiteboard: string`（上限 8 MiB，超过拒绝）。`saveBoardRequestSchema` / `boardDocumentSchema` 同步加字段。
- 快照内容：tldraw `getSnapshot(store).document` 里**过滤掉** `armadra` shape、`frame` shape、两端都绑节点的 `arrow` 及其 binding（这些由 `nodes/edges` 表承载），只留白板原生记录与 tldraw 的 schema 版本信息。加载时先灌白板快照，再把 `nodes/edges` 投影成 shape 合并进去。
- 旧列 `strokes_json`（v2 遗留）本次不动。

### 6.2 资产：`POST /api/workspaces/{id}/assets`

图片、粘贴的文件走 `TLAssetStore.upload`：multipart 上传 → Runtime 写到 `<workspace>/.armadra/assets/<sha256 前 16 位>.<ext>`，返回 `{ id, path, url }`；`resolve` 返回 `http://127.0.0.1:<port>/api/workspaces/{id}/assets/<id>`。上限沿用 `MAX_IMAGE_SRC_BYTES` 放宽到 8 MiB；`.armadra/assets` 在 Runtime 的路径白名单内。Agent 读到的是文件路径。

### 6.3 内容链接：`ContextLink` 新增 `kind: "shape"`

现有 `contextLinkSchema { id, title, kind }` 的 `id` 是 uuid；白板 shape 不是节点，所以扩成：

```ts
contextLinkSchema = z.object({
  id: z.string().uuid(), // 节点 id，或为 shape 生成的稳定 uuid（shape:<uuid>）
  title: z.string().max(160),
  kind: z.string().max(40), // 新增 "shape"
  content: z
    .object({
      // 仅 kind === "shape"
      text: z.string().max(20_000).optional(), // text / geo 里的文字
      pngPath: z.string().max(4_000).optional(), // 导出的 PNG，工作区相对路径
    })
    .optional(),
});
```

- 客户端在 `context-links.ts` 的 `buildLinkDocuments` 里，把绑到白板 shape / frame 的 arrow 也算成链接：文字类直接带 `text`；image shape 直接给资产文件路径（不再导出）；frame、draw、geo 用 `editor.toImage([id])` 导出 PNG，走泛化后的 `POST /api/workspaces/{id}/exports/{shapeUuid}/png`（现有 `export_node_png` 改成不再要求 `draw` 节点，路径改为 `.armadra/exports/<uuid>.png`），链接文档里带 `pngPath`。导出防抖沿用 `EXPORT_DELAY_MS`。
- Runtime `collab/context_link.rs` 的 `readable_as` / `read_content` 增加 `"shape"` 分支：有 `text` 回文字，有 `pngPath` 回路径。`get-linked-context` 技能的文案补一句「白板内容」。
- frame 是最推荐的链接单位：用户框一块区域拉到 Agent，Agent 得到整块的 PNG 加框内所有文字。

### 6.4 不变的部分

`nodes` / `edges` 表结构、节点类型校验（`db.rs` 白名单只有 6 种在用类型）、hook、控制动词、会话索引、通知、用量、SSH、设置页。

## 7. 前端目录（目标）

```text
apps/web/src/
  canvas/
    TldrawWorkspace.tsx      # 替换 CanvasWorkspace：<Tldraw> 装配、components、overrides、cameraOptions
    editor-context.ts        # 全局 editor 句柄：useEditorRef()、getEditor()（Dock / 命令面板 / 侧栏用）
    sync/
      project.ts             # nodes/edges → shape/binding 记录（纯函数，替代 shared/canvas-adapter.ts）
      derive.ts              # store 记录 → CanvasNode/CanvasEdge（纯函数）
      snapshot.ts            # 白板快照过滤 / 合并（纯函数）
      use-store-sync.ts      # store.listen → canvas-store.document；远端文档 → mergeRemoteChanges
      migrate-draw.ts        # draw 节点 → tldraw draw shape
    shapes/
      ArmadraShapeUtil.tsx      # §4.1
      armadra-shape.ts          # props 校验（tldraw T 校验器 ↔ zod）
      LinkArrow.ts           # §4.3 的 sideEffects：绑定合法性、样式、edge 派生
      FrameGroup.ts          # §4.2：frame ↔ group 行
    overlays/
      DerivedEdgesLayer.tsx  # §4.4
      SubagentLayer.tsx      # 改为 OnTheCanvas 宿主
      ConnectionHandles.tsx  # 节点左右把手起箭头
    tools/                   # 需要时自定义 StateNode（预计只有「从把手起箭头」）
    commands.ts              # 不变
    context-links.ts         # 扩 §6.3
    tidy.ts / geometry.ts    # 纯函数保留；geometry 里 React Flow 专用部分删除
    menus/                   # 添加菜单不变；节点菜单增加 shape 菜单
    dnd/os-drop.ts           # 改接 editor.registerExternalContentHandler
  nodes/                     # NodeShell 去掉 NodeResizer / Handle；其余节点体不变；DrawNode / ImageNode 删除
  shell/Dock.tsx             # 工具组 + 缩放，改用 editor-context
  store/canvas-store.ts      # 动作改为驱动 editor；document 派生只读；history 删除
  styles/canvas.css          # .react-flow__* 规则删除，改为 .tl-* 换肤
```

删除：`@xyflow/react` 依赖与 vite 的 `xyflow` 分组、`packages/shared/src/canvas-adapter.ts`、`canvas/FloatingEdge.tsx`、`canvas/RopeEdge.tsx`、`canvas/StatusMiniMap.tsx`（改用 tldraw Minimap + 状态描边）、`canvas/viewport.ts` 与 `zoom.ts` 里 React Flow 专用部分、`nodes/DrawNode.tsx`、`nodes/ImageNode.tsx`。

## 8. 实施阶段与并行分工

### Phase 0 · PoC 与基座（1 个 agent，串行，约 1 天）

产出一个分支上的可运行 spike，并把结论写回本文 §10：

1. 装 tldraw 5.4，`getAssetUrlsByImport` 自托管字体与图标（WKWebView 离线必须），vite 分组加 `tldraw`。
2. 一个 `armadra` shape 里跑真 xterm + tmux：拖头部、体内点击 0 字节进 PTY（§18.5）、体内滚轮走桥、⌘+滚轮缩放、resize 后 fit、折叠。
3. **视口裁剪**：把终端 shape 移出视口再移回，确认 tldraw 是否卸载 shape 组件。若卸载，实现「DOM 寄养」：xterm 只 `open` 一次到模块级持有的 `div`，shape 组件挂载时 `appendChild`、卸载时摘走，WebGL 插件在此模式下禁用。
4. frame 颜色属性、frame 内 `armadra` shape 的裁剪与拖出。
5. arrow 绑定到 `armadra` shape；`registerBeforeCreateHandler` 拦非法绑定。
6. 20 个终端 shape + 200 条手绘的帧率与内存，对比现状。
7. `overrides` 清空 kbd 后，`useKeybindings` 的 7 条终端放行键仍正确。

任一项失败即回到本文 §12 重新决策；全部通过再开 Phase 1。

#### Phase 0 结论（2026-09-04，已执行）

**结论：go。** §8 的 7 项全部通过，§10 表格逐行回填。Spike 在 `apps/web/src/canvas/poc/`（`TldrawPoc.tsx` / `armadra-poc-shape.tsx` / `PocNodeShell.tsx` / `probe.ts`），入口是 `apps/web/src/app/App.tsx` 里的 `?poc=tldraw` 分支，Phase 1 收尾时整个 `poc/` 目录连同该分支一起删掉。

**必须采用的实现方式**

1. **不需要「DOM 寄养」。** 裁剪不卸载组件，`armadra` 只要 `canCull() => false` 就够（`display:none` 会让 xterm 量到 0×0）。`getAppOwnedElement` / `onReleaseAppOwnedElement` 作为备用手段留在 §4.1 的注释里，不进 Phase 1 的必做项。
2. **节点体的滚轮守卫要分两相。** 冒泡相位 `stopPropagation` 挡普通滚轮（保住 §18.5 的 tmux 桥），捕获相位只拦 ⌘/Ctrl+滚轮并把事件转发一份到 `.tl-canvas`（保住缩放，同时不让终端跟着滚历史）。指针事件用 React 合成事件的 `stopPropagation` 即可。
3. **连线合法性不能写在 `registerBeforeCreateHandler` 里。** 5.4 的签名是 `(record, source) => R`，没有「取消」的返回值（只有 `registerBeforeDeleteHandler` 能返回 `false`）。身份级规则（自连、同一对重复）走 `registerAfterCreateHandler("binding", …)`，命中后**推迟到微任务**再 `editor.run(() => editor.deleteShape(arrowId), { history: "ignore" })`——在副作用刷新里直接删箭头，正在拉线的 arrow 工具会读到已删除的 shape 并在 `onTerminalHandleDrag` 抛异常。类型级规则（谁可以被绑）走 `ShapeUtil.canBind(opts)`。
4. **`@tldraw/tlschema` 必须是 `apps/web` 的直接依赖。** 自定义 shape 在 5.4 走全局类型注册（见下），`declare module "@tldraw/tlschema"` 解析不到包时 TS 会把它当成一条 ambient 声明而不是模块增强，`TLShape<"armadra">` 直接退化成 `unknown`。
5. **vite 必须加 `optimizeDeps.exclude: ["@tldraw/assets"]`**，否则 dev server 起不来（见 §10 字体行）。分组已加 `tldraw`（收 `tldraw` / `@tldraw` / `@tiptap` / `prosemirror-*` / `@use-gesture` 等），产出单独一块 1749 kB（gzip 534 kB）。

**tldraw 5.4 的确切 API 名（Phase 1 四个 agent 直接引用）**

| 用途              | API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 包                | `tldraw@5.4.0`、`@tldraw/assets@5.4.0`、`@tldraw/tlschema@5.4.0`（`tldraw` 自身 `export * from "@tldraw/editor"`，编辑器 / store / tlschema / validate 的全部符号都能从 `"tldraw"` 导入）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 自定义 shape 注册 | `declare module "@tldraw/tlschema" { interface TLGlobalShapePropsMap { armadra: ArmadraProps } }`，之后 `type ArmadraShape = TLShape<"armadra">`；同理 `TLGlobalBindingPropsMap`、`TLGlobalRecordPropsMap`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ShapeUtil 必写    | `static type`、`static props: RecordProps<S>`（校验器用 `T.number` / `T.string` / `T.boolean`，来自 `@tldraw/validate`）、`getDefaultProps()`、`getGeometry()`、`component()`、**`getIndicatorPath(shape): TLIndicatorPath`**（5.4 的抽象方法，返回 `Path2D`，取代 4.x 的 `indicator(): JSX`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ShapeUtil 可选    | `canCull` / `canBind(opts: TLShapeUtilCanBindOpts)` / `canEdit` / `canResize` / `canScroll` / `canBeLaidOut` / `hideRotateHandle` / `hideResizeHandles` / `hideSelectionBoundsFg` / `hideSelectionBoundsBg` / `onResize`（配 `resizeBox(shape, info)`）/ `onClick` / `getClipPath` / `getAppOwnedElement` / `onReleaseAppOwnedElement`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 组件槽位          | `TLComponents = TLEditorComponents & TLUiComponents`。编辑器侧：`Background / Canvas / CollaboratorCursor / Grid / InFrontOfTheCanvas / LoadingScreen / OnTheCanvas / ShapeWrapper / Spinner / SvgDefs / ErrorFallback / ShapeErrorFallback`。UI 侧：`ContextMenu / ActionsMenu / HelpMenu / ZoomMenu / MainMenu / Minimap / StylePanel / PageMenu / NavigationPanel / Toolbar / RichTextToolbar / ImageToolbar / VideoToolbar / KeyboardShortcutsDialog / QuickActions / HelperButtons / DebugPanel / DebugMenu / MenuPanel / TopPanel / SharePanel / CursorChatBubble / Dialogs / Toasts / A11y / FollowingIndicator / PeopleMenu*`。**`Minimap` 的宿主是 `NavigationPanel`**，把 `NavigationPanel` 置空缩略图就没人渲染了——要么保留它，要么自己挂 `DefaultMinimap`；样式面板默认实现是 `DefaultStylePanel` / `DefaultStylePanelContent` |
| 清快捷键          | `TLUiOverrides.actions(editor, actions, helpers)` / `.tools(...)`，遍历返回的 `Record<string, TLUiActionItem \| TLUiToolItem>` 删掉 `kbd`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 相机              | `<Tldraw options={{ camera: TLCameraOptions }}>`——顶层 `cameraOptions` prop 已 deprecated，且 `TldrawOptions` 上的字段名是 **`camera`** 而不是文档里写的 `cameraOptions`。`TLCameraOptions { isLocked, panSpeed, zoomSpeed, zoomSteps, wheelBehavior: "none"\|"pan"\|"zoom", constraints? }`；运行时改用 `editor.setCameraOptions()`，移动用 `editor.setCamera(point, { immediate })` / `centerOnPoint` / `zoomToFit`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| frame             | `TLFrameShapeProps { w, h, name, color: TLDefaultColorStyle }`（**有 `color`**）；子级裁剪读 `editor.getShapeClipPath(id)`（返回 `polygon(...)` 字符串）；拖进拖出自动换父，`parentId` 在 `page:page` 与 `shape:<frame>` 之间切换，坐标自动转成父级相对                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 绑定              | `editor.createBinding({ type:"arrow", fromId, toId, props:{ terminal:"start"\|"end", normalizedAnchor, isExact, isPrecise } })`、`editor.getBindingsFromShape(id, "arrow")`、`editor.deleteBinding`、`editor.canBindShapes({ fromShape, toShape, binding })`；副作用 `editor.sideEffects.registerBeforeCreateHandler / registerAfterCreateHandler / registerAfterChangeHandler / registerBeforeDeleteHandler`（只有 before-delete 能返回 `false` 否决）                                                                                                                                                                                                                                                                                                                                                                                    |
| 远端合并          | `editor.store.mergeRemoteChanges(fn)`（side effect 的 `source` 为 `"remote"`，不进撤销栈）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 历史              | `editor.undo() / redo() / markHistoryStoppingPoint()`、`editor.run(fn, { history: "ignore" })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 快照              | `editor.getSnapshot(): { document: TLStoreSnapshot, session }`、`editor.loadSnapshot(snapshot, opts)`；纯函数版 `getSnapshot(store)` / `loadSnapshot(store, snapshot, opts)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 资产              | `<Tldraw assets={TLAssetStore}>`；`TLAssetStore { upload(asset, file, abortSignal) => { src, meta? }, resolve?(asset, ctx), remove?(assetIds) }`；内置 `inlineBase64AssetStore` 可做对照                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 导出              | `editor.toImage(shapes, opts) => { blob, width, height }`、`editor.toImageDataUrl(...)`、`exportAs(editor, ids, opts)`。**5.4 没有 `exportToBlob`**，§6.3 写的 `editor.toImage([id])` 是对的                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 其他              | `createShapeId(name?)`、`editor.getCulledShapes()`、`editor.getRenderingShapes()`（整页，不按视口筛）、`compressLegacySegments(segments)`（构造 draw shape 用）、`defaultShapeUtils` / `defaultBindingUtils`、`HTMLContainer`（内容要交互必须自己写 `pointerEvents: "all"`，`.tl-html-container` 默认 `pointer-events: none`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**性能（粗略对比，同一台机器、同一个 WebKit 面板）**

|                                                         | tldraw（PoC）                                                                          | React Flow（现状）                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| 内容                                                    | 21 个 `armadra` 节点外壳（1 个连真实 tmux 终端）+ 200 条 draw + 1 个 frame = 222 shape | 220 个便签节点（临时看板，测完已删） |
| 脚本建全部内容                                          | 51 ms                                                                                  | —                                    |
| 画布容器下的 DOM 节点                                   | 967（222 shape 里 184 个被裁剪成 `display:none`）                                      | 7264（220 个节点全渲染，无裁剪）     |
| JS 堆                                                   | 89.6 MB（3 shape）→ 102.9 MB（222 shape），+13.3 MB                                    | 109.6 MB                             |
| 连续相机推进（含库自身的响应式重算 + 强制布局），120 次 | 0.148 ms/次（3 shape）→ 0.47 ms/次（222 shape）                                        | —                                    |
| 只改容器 transform + 强制布局，120 次                   | 0.015 ms/次                                                                            | 0.009 ms/次                          |
| 生产构建 chunk                                          | `tldraw` 1749 kB / gzip 534 kB（`xyflow` 现在是 179 kB / gzip 58 kB）                  | —                                    |

数字的读法：两者「纯平移」的合成代价都可以忽略，真正的差别是 **DOM 规模**——tldraw 把视口外的 shape 裁成 `display:none`，React Flow 全量渲染；222 个 shape 下 tldraw 的相机推进也只要 0.47 ms，离 16.7 ms 的帧预算很远。代价是包体大了约 10 倍。**真实帧率没有测到**：这次的浏览器面板是隐藏的，`requestAnimationFrame` 完全不回调，只能用「相机推进 + 强制同步布局」的耗时代理。§11 的「手工」一行仍需在真机上重跑 20 终端 + 手绘的拖动帧率。

**Phase 1 之前需要注意的两处偏差**

- `apps/web/vite.config.ts` 已加 `tldraw` 分组与 `optimizeDeps.exclude`，`xyflow` 分组等 §7 收尾时再删。
- PoC 分支只替换 `CanvasWorkspace`，autosave 与命令表都挂在 `CanvasWorkspace` 里，所以 `?poc=tldraw` 下画布改动不落库——这是有意的（不污染用户看板），Phase 1 的 `TldrawWorkspace` 必须把这两样接回去。

**已完成（2026-09-04）**：六条风险全部有实测结论，见 §10；结论 go。

### Phase 1 · 节点画布迁移（4 个 agent 并行，约 3 天）

目标：tldraw 上跑通全部 7 种节点 + frame 分组 + 节点间连线，白板工具暂不开放，行为与 v3 等价。

| agent                | 归属                                                                                                                                                        | 交付                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| canvas               | `canvas/TldrawWorkspace.tsx`、`editor-context.ts`、`sync/*`、`overlays/*`、`commands.ts`、`context-links.ts`（节点部分）                                    | 装配、投影与派生、远端合并、命令表、100% 打开、整理后 fitView、居中事件               |
| nodes                | `canvas/shapes/*`、`nodes/NodeShell.tsx`、`nodes/*Node.tsx` 的 React Flow 依赖清理                                                                          | `ArmadraShapeUtil`、把手、resize、折叠、最大化、`FrameGroup`、`LinkArrow`             |
| store+shared+runtime | `store/canvas-store.ts`、`packages/shared`、`apps/runtime`（迁移 0009、save/load、assets、export 泛化、`db.rs` 类型白名单、`context_link.rs`）              | 动作改为驱动 editor；schema 与接口按 §6 落地并有测试                                  |
| shell                | `shell/Dock.tsx`、`shell/ControlsCluster.tsx`、`panels/CommandPalette.tsx`、`app/commands.ts`、`app/App.tsx`、`main.tsx`、`sessions/*`、`styles/canvas.css` | 去掉 `useReactFlow`，改用 `editor-context`；Minimap 换肤与状态描边；tldraw token 映射 |

Phase 1 出口：`pnpm test`、`typecheck`、`cargo test`、clippy 零告警；§18.4 终端清单在 tldraw 里逐项通过；旧看板打开无丢失。

**已完成（2026-09-04）**：四个 agent 并行交付，`apps/web/src` 全树 `@xyflow/react` = 0；交接记录见 [phase1-handoff.md](./phase1-handoff.md)。

### Phase 2 · 连线语义与派生层（2 个 agent 并行，约 2 天）

| agent    | 交付                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| edges    | 箭头 ↔ edge 双向：创建、删除、方向与样式、合法性、撤销一致；把手起笔工具；节点删除级联                              |
| overlays | rope / subagent 卡片迁到 `OnTheCanvas`；`derived-edges` 测试复用；`StatusMiniMap` 的状态描边在 tldraw Minimap 上复现 |

**已完成（2026-09-04）**：边的身份改记在 shape 上、合法性推迟到交互结束再判；rope 与子代理卡片迁到 `OnTheCanvas`，缩略图按 Agent 状态描边。

### Phase 3 · 白板能力开放（3 个 agent 并行，约 2 天）

| agent   | 交付                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tools   | Dock 工具组、工具键、样式面板换肤、右键 shape 菜单、`Esc` 回选择、锁定画布                                                                                                     |
| content | `registerExternalContentHandler`：图片 → image shape（资产上传）、OS 文件 / 文件夹 → editor / files 节点、文本一律 → tldraw text shape（用户定）；粘贴同规则；`image` 节点迁移 |
| migrate | `draw` / `image` 节点 → 原生 shape 的迁移与回归测试；白板快照过滤 / 合并的属性测试；8 MiB 上限与超限提示                                                                       |

**已完成（2026-09-04）**：另加两个计划外的 agent —— asset-import（按路径导入资产）与 link-shape（上下文链接改成自定义 shape 的贴边贝塞尔）。

### Phase 4 · 白板内容接入 Agent（2 个 agent 并行，约 2 天）

| agent        | 交付                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| link-content | §6.3 全链路：arrow 绑到 shape / frame → 链接文档带 `text` / `pngPath` → Runtime 回内容；导出防抖；`get-linked-context` 与 `armadra-linked-context` 技能文案 |
| polish       | 20 终端 + 大量手绘的性能复测；深浅色；tldraw 水印位置；`docs/implementation-status.md` 更新                                                                 |

**已完成（2026-09-04）**：polish 这一半还顺带修了两处终端回归（滚轮桥被 xterm 6 的 `ScrollableElement` 吞掉、OSC 标题记忆刷新即丢），并给保存冲突加了自动变基。

### 收尾（1 个 agent，约 0.5 天）

删除 §7 列出的文件与依赖，清 `canvas.css`，更新 `architecture.md` 的三层图（React Flow → tldraw），本文状态改为「已实施」。

**已完成（2026-09-04）**：`canvas/poc/` 与 `@xyflow/react` 依赖已清；`architecture.md` 的三层图与画布层描述已改成 tldraw；本文状态行已更新。

## 9. 跨模块接口契约（并行 agent 只调用、不修改他人归属）

### 9.1 `canvas/editor-context.ts`（归属 canvas）

```ts
export function getEditor(): Editor | null; // 画布未挂载时 null
export function useEditor(): Editor | null; // 订阅挂载 / 卸载
export function screenToPage(point: { x: number; y: number }): Position;
export function centerOnNode(nodeId: string, zoomFloor?: number): void;
export const CENTER_NODE_EVENT: string; // 不变
```

### 9.2 `canvas/sync/project.ts` 与 `derive.ts`（归属 canvas）

```ts
export function nodeToShape(node: CanvasNode): ArmadraShape | TLFrameShape;
export function edgeToArrow(
  edge: CanvasEdge,
  nodes: readonly CanvasNode[],
): { arrow: TLArrowShape; bindings: TLArrowBinding[] };
export function shapeToNode(
  shape: ArmadraShape | TLFrameShape,
  boardId: string,
): CanvasNode;
export function arrowToEdge(
  arrow: TLArrowShape,
  bindings: readonly TLArrowBinding[],
  boardId: string,
): CanvasEdge | null; // 非两端节点绑定时 null
export const shapeId: (nodeId: string) => TLShapeId;
export const nodeId: (shapeId: TLShapeId) => string;
```

### 9.3 `store/canvas-store.ts`（归属 store）

`CanvasActions` 全部保留签名；新增 `setWhiteboard(snapshot: string)`；删除 `history`、`undo/redo` 改为转调 editor。`document` 仍是 `BoardDocument | null`，新增 `document.board.whiteboard`。`useSelectedNodes / useCanvasNode / useIsMaximized` 不变；`useCanUndo / useCanRedo` 改读 editor。

### 9.4 `canvas/shapes/ArmadraShapeUtil.tsx`（归属 nodes）

`NodeShellProps` 与 `NodeBodyProps` 不变；`NodeShell` 不再引用 `NodeResizer / Handle / useStore`；把手与 resize 的 UI 由 `ArmadraShapeUtil` 与 `ConnectionHandles` 提供。`NODE_META` 去掉 `draw` 与 `image` 两项。

### 9.5 `packages/shared`（归属 store+shared+runtime）

`boardDocumentSchema.board.whiteboard: z.string().max(8 MiB).default("")`；`saveBoardRequestSchema.whiteboard`；`contextLinkSchema.content`；`NODE_TYPES` 里 `draw` 与 `image` 标记为 `deprecated`（读入允许，`addNode` 拒绝）。

### 9.6 快捷键与 i18n

新工具键与文案：`canvas.tool.select / hand / draw / highlight / geo / arrow / text / frame / image`，`canvas.lock`，`edge.shape`，`shape.*` 菜单项。zh / en 同步，禁止中英混排（§14）。

## 10. 风险与 PoC 结论

| 风险                                      | 影响                             | 对策                                                         | PoC 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tldraw 视口裁剪卸载 shape 组件            | 终端出视口即断开、回来要重连重绘 | §8 Phase 0-3 的「DOM 寄养」；或 `OnTheCanvas` 宿主渲染节点体 | **风险不成立，不需要寄养。** 5.4 的裁剪只把容器设成 `display:none`（`ShapeUtil.canCull` 的 doc comment 原文、`Shape.tsx` 的 `useShapeCulling` 实现），组件不卸载；`getRenderingShapes()` 也是整页渲染，不按视口。实测把相机推到 −20000 再回来，`mount/unmount` 计数不变、xterm DOM 是同一个元素、无重连。仍然给 `armadra` 设 `canCull() => false`，因为 `display:none` 会让 `FitAddon` 量到 0×0。真要寄养也有官方 API：`ShapeUtil.getAppOwnedElement()` + `onReleaseAppOwnedElement()`（承诺挂载期间不卸载 / 不重建 / 不搬家，搬动用 `Node.moveBefore`），PoC 里已跑通 adopt / release                                                                                                                                                         |
| 体内指针与 tldraw 抢事件                  | 终端点击变成选中 / 拖动          | 体 `onPointerDown` 停止冒泡；只在头部拖                      | **通过。** 指针：tldraw 的 canvas 事件是挂在 `.tl-canvas` 上的 React props，体上 `onPointerDown` 的合成 `stopPropagation` 就够——实测体内单击选区仍为空、只把焦点给 `xterm-helper-textarea`、终端缓冲区 0 变化；体内拖 150×100 shape 不动、相机不动；头部拖 120×84 shape 精确位移 120/84。滚轮：tldraw 的 wheel 是**原生**监听且挂在 `.tl-canvas` 上，React 19 的委托在 React 根（更外层），合成事件的 stopPropagation 来不及，必须用原生监听器。而且要分两相：**冒泡相位**挡普通滚轮（终端自己的 wheel 监听在更深的 `[data-slot="terminal-body"]`，捕获相位会把 §18.5 的 tmux 桥饿死），**捕获相位**只拦 ⌘/Ctrl+滚轮并转发一份到 `.tl-canvas`。实测普通滚轮：相机不动 + `POST /api/terminals/{id}/scroll` 照发；⌘+滚轮：缩放 1→3 且桥 0 次请求 |
| tldraw 键盘快捷键与 `useKeybindings` 冲突 | ⌘Z、Delete 双触发                | `overrides` 清空 kbd；单元测试断言 tldraw 不再注册           | **通过。** `TLUiOverrides.actions/tools` 里把每个 item 的 `kbd` 删掉之后，画布里按 Delete / Backspace 不删 shape、⌘Z 不撤销、⌘A 不全选。终端聚焦时 `keybindings.ts` 的放行键照常：⌘K 开命令面板（`[cmdk-root]` 出现），⌘T（`allowInTerminal:false`）被挡住、节点数不变。注意 `Escape`、方向键这类走 tldraw 的 `useDocumentEvents`，不由 `kbd` 表控制，Phase 3 开工具时要单独确认                                                                                                                                                                                                                                                                                                                                                               |
| WebGL xterm 在 CSS transform 下           | 模糊或上下文丢失                 | 默认 DOM 渲染器不变；寄养模式禁 WebGL                        | **通过，无需禁用。** 打开 `armadra.terminal.webgl` 后终端起 3 个 canvas 层，在 tldraw 的 CSS transform 下 zoom 1.7 文字清晰、zoom 0.3 仍正常绘制，控制台无错、无 context lost。默认仍保持 DOM 渲染器（§18 不变），WebGL 继续是可选项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 字体与图标资源                            | WKWebView 离线时手绘字体缺失     | `@tldraw/assets` 自托管；CJK 回退系统字体                    | **通过，但要改 vite 配置。** `getAssetUrlsByImport()` 来自 `@tldraw/assets/imports.vite`，dev / build 全部走 `localhost`，没有一条 `tldraw.com` 请求。**必须加 `optimizeDeps.exclude: ["@tldraw/assets"]`**：该入口全是 `./fonts/x.woff2?url` 形式的导入，vite 8 的 rolldown 依赖预打包不认 `?url`，否则 dev server 直接以 53 条 `UNLOADABLE_DEPENDENCY` 启动失败。生产构建产出 16 个 woff2（合计 1.3 MB）+ 52 个 svg/json，全部落在 `dist/assets`                                                                                                                                                                                                                                                                                             |
| 快照体积                                  | 大量手绘 + 内嵌图片撑爆 save     | 图片走资产接口；8 MiB 上限；超限提示                         | **结构确认。** `editor.getSnapshot()` 返回 `{ document, session }`，`document.store` 是 `id → record` 的扁平表、`document.schema.schemaVersion = 2`；3 个 shape 时 `JSON.stringify(document)` = 1933 B。按 §6.1 过滤掉 `armadra` / `frame` / 两端绑节点的 arrow 只是删 key，成本可忽略。draw shape 的 `segments` 在 5.4 已经是 **base64 delta 编码的 `path` 字符串**（`TLDrawShapeSegment { type, path, dim }`），不再是点数组，体积本身就比 v2 的 `strokes_json` 小；构造时用 `compressLegacySegments([{ type, points }])`。8 MiB 上限继续按计划做                                                                                                                                                                                            |
| 水印                                      | 右下角「Made with tldraw」       | 先接受；申请许可 key 后 `licenseKey` 传入                    | 用户决定（PoC 里确认水印固定在右下角，文案「Get a license for production」，不挡 Dock）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 远端合并与撤销                            | Agent 开的节点被用户 ⌘Z 撤掉     | `mergeRemoteChanges` 不进历史                                | **通过。** `editor.store.mergeRemoteChanges(fn)` 里建的 shape 在随后的 `editor.undo()` 中原样保留，同一次撤销把用户自己那步位移回退了（x 740 → 700）。配套 API：`editor.markHistoryStoppingPoint()` 标记撤销点，`editor.run(fn, { history: "ignore" })` 让一段改动完全不进栈                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 11. 测试矩阵（新增部分）

| 层         | 用例                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| shared     | `whiteboard` 上限；`contextLink.content` 校验；`draw` / `image` 只读不写                                               |
| web 纯函数 | `project / derive` 往返恒等；`snapshot` 过滤后不含节点记录；`arrowToEdge` 对单端绑定返回 null；`migrate-draw` 坐标平移 |
| web 组件   | `ArmadraShapeUtil` 折叠高度、最大化矩形；把手起箭头；体内 pointerdown 不改选区                                         |
| web 集成   | 打开旧看板 → 节点、连线、分组一个不少；撤销拖动；删节点级联删边；远端新增节点不进撤销                                  |
| runtime    | 0009 迁移；save 带 `whiteboard` 往返；assets 上传路径白名单与哈希去重；export 泛化；`context_link` 的 `shape` 分支     |
| 手工       | §18.4 终端清单；20 终端 + 手绘性能；深浅色；捏合 / ⌘滚轮 / 空格拖                                                      |

## 12. 用户决定（2026-09-04）

1. **水印**：带「Made with tldraw」上线，不申请许可 key。
2. **样式面板**：复用 tldraw 的样式面板与缩略图，换肤到与现有软件风格统一（§5）。
3. **文本粘贴**：一律变 tldraw 文字，不再生成便签。
4. **内容类节点**：尽量复用 tldraw 原生，图片与文本都用原生 shape；`image` 与 `draw` 节点类型退役（§4.5）。便签因 Agent 控制动词依赖而保留。
5. **旧数据（2026-09-05 补充）**：不做任何兼容或迁移，旧库与旧节点直接抛弃。
