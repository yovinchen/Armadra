# 画板导入 Mermaid 图

> 状态：已实施（2026-09-19，基线 `359058afd`）。把一段 Mermaid 文本变成画板上的内容：flowchart 走「原生对象」路径，落成可编辑、可移动、一步撤销的几何形与连线；其余图种走「图片回退」，经现有资产导入路径落成图片对象。
> 范围：`apps/web/src/canvas/whiteboard/mermaid/`（新增）、`canvas/whiteboard/tools/use-clipboard.ts`、`canvas/menus/add-menu.ts`、`canvas/dnd/external-content.ts`、`keybindings/commands.ts`、`i18n/`、`vite.config.ts` 的 chunk 分组。白板文档格式（[React Flow 画布](canvas-react-flow.md) §3.1 的 v2）**不变**，不新增对象类型、不新增迁移。
> 输入：mermaid 12.0.0 与 `@dagrejs/dagre` 3.1 在本仓 jsdom 环境下的实测（见 §2.1、§7）。

## 1. 结论与决策

| #   | 决策                                                                       | 依据                                                                                                                       |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| D1  | **用官方 `mermaid` 包解析，不自写解析器**                                  | Mermaid 语法有 11 种图种、各自一套 jison 文法且逐版演进；自写解析器等于永久维护一个会持续落后的方言（§2.1）               |
| D2  | **mermaid 与 dagre 只出现在动态 `import()` 的 chunk 里**                   | mermaid 打包后约 2.7 MB（未压缩），绝不能进首屏；实测首屏 chunk 不变（§7）                                                |
| D3  | **flowchart / graph → 原生白板对象；其余图种 → 图片对象**                  | flowchart 的 `db` 暴露了完整的节点 / 边 / 子图三元组，能无损映射到白板的五类对象；其余图种的 `db` 形状各异且语义无对应物   |
| D4  | **布局用 dagre，不用 mermaid 自己的渲染结果**                              | mermaid 的坐标藏在渲染出的 SVG 里，取回来要量 DOM；dagre 是 mermaid 自己 flowchart 布局用的同一个库，纯函数、可在单测里跑 |
| D5  | **subgraph 落成一个更大的矩形框，画在成员后面**，不是 React Flow 的父子节点 | 白板对象的 `parentId` 指向 `group` 节点（画布节点），不能指向另一条白板对象；用 z 序表达包含关系最省事也最好编辑         |
| D6  | **落库经 `whiteboard/store.addItems` 一次调用**                            | 它已经是批量动作，一次 `setWhiteboard` 即一条历史；不需要新增 store 动作（§4.4）                                          |
| D7  | **颜色全部取画板调色板，丢弃 Mermaid 自己的配色**                          | 导入的图必须和手画的内容看起来是同一块板；Mermaid 主题色在深色画布上不可读（§5）                                          |
| D8  | **粘贴识别到 Mermaid 时先弹对话框确认，不直接落地**                        | 识别是前缀匹配，必然有误判；一段以 `graph` 开头的普通文本被吞掉比多一次确认糟得多（§6.2）                                 |

## 2. 解析

### 2.1 为什么用官方包

`mermaid@12` 导出两个我们要用的入口，实测（jsdom，本仓 vitest 环境）都能跑：

| 调用                                      | 返回                                                                    | 用途                     |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------ |
| `mermaid.parse(text)`                     | `{ diagramType: "flowchart-v2" \| "sequence" \| … }`，语法错时 `throw` | 判图种、拿错误           |
| `mermaid.mermaidAPI.getDiagramFromText(t)` | `{ type, text, db, parser, renderer }`                                  | 拿 flowchart 的 `db`     |
| `mermaid.render(id, text)`                | `{ svg }`                                                               | 图片回退（**需要真 DOM**） |

flowchart 的 `db` 上我们只用四个读方法，实测返回：

```
db.getDirection()  → "LR" | "TB" | "BT" | "RL"
db.getVertices()   → Map<id, { id, text, type, styles[], classes[], labelType }>
db.getEdges()      → [{ start, end, type, text, stroke, length }]
db.getSubGraphs()  → [{ id, title, nodes[] }]
db.getClasses()    → { [name]: { id, styles[], textStyles[] } }
```

`type` 实测取值：`square` `round` `diamond` `circle` `stadium` `subroutine` `cylinder` `odd` `hexagon` `trapezoid` `lean_right` `lean_left` `inv_trapezoid` `doublecircle`，裸节点（`a --> b` 里的 `a`）是 `null`。
`edge.type` 是 `arrow_point` / `arrow_open` / `arrow_cross` / `arrow_circle`，`edge.stroke` 是 `normal` / `thick` / `dotted`。

自写解析器要复刻的就是上面这张表加十几种边写法（`-->` `-.->` `==>` `---` `--text-->` `-- text ---` …），而且每次 Mermaid 发版都会多几种。官方包是唯一可维护的选项。

### 2.2 包体积与切分

| 包                | 版本     | 未压缩  | 落点                                                        |
| ----------------- | -------- | ------- | ----------------------------------------------------------- |
| `mermaid`         | ^12.0.0  | ~2.7 MB | 只被 `mermaid/parse.ts` 与 `mermaid/render.ts` 动态 `import()` |
| `@dagrejs/dagre`  | ^3.1.1   | ~200 kB | 被 `mermaid/layout.ts` 静态 import，整个目录只从懒加载的对话框进入 |

两条保证：

1. `ImportMermaidDialog.tsx` 由 `ToolLayer` 经 `React.lazy` 挂载，且**只在对话框打开时才渲染**，所以 `layout.ts` → dagre 整条链是异步的。
2. `parse.ts` / `render.ts` 里对 mermaid 的引用一律写成 `await import("mermaid")`，即使将来有人把 `parse.ts` 静态 import 进首屏，mermaid 本身仍留在自己的 chunk 里。

`vite.config.ts` 的 `codeSplitting.groups` 增加一组 `mermaid`（`priority: 20`，匹配 `node_modules/{mermaid,@dagrejs,dagre-d3-es,cytoscape*,khroma,langium,…}`），目的只是**给这块起个稳定名字**方便体积回归，不改变它的异步性质。实测见 §7。

唯一一个进首屏的文件是 `detect.ts`：它是 30 行纯正则，不 import 任何重依赖，因为 `use-clipboard.ts` 每次粘贴都要问它。

### 2.3 中间模型

`parse.ts` 不把 mermaid 的 `db` 直接交给下游，先收敛成一个自己的模型，这样 `layout.ts` / `to-items.ts` 都是可单测的纯函数，且 Mermaid 换版本时只有 `parse.ts` 要改：

```ts
type MermaidDirection = "TB" | "BT" | "LR" | "RL";

interface MermaidNode   { id; label; shape: MermaidShape; fill: string | null }
interface MermaidEdge   { from; to; label; arrowStart; arrowEnd; dash: Dash }
interface MermaidGroup  { id; label; nodes: string[] }
interface MermaidGraph  { direction; nodes[]; edges[]; groups[] }

type MermaidParsed =
  | { kind: "graph"; diagramType: string; graph: MermaidGraph }
  | { kind: "image"; diagramType: string };   // 回退，交给 render.ts
```

`parseMermaid(text)` 是唯一的异步入口：`mermaid.parse` 先跑（拿图种、抛语法错），`diagramType` 以 `flowchart` 开头才继续取 `db` 转 `MermaidGraph`，否则返回 `{ kind: "image" }`。
`graphFromDb(db)` 是纯函数，接口就是上面四个读方法，单测里喂真 db（jsdom 跑得动）也能喂假的。

## 3. 两条路径

### 3.1 路径 a：原生对象（flowchart / graph）

**形状映射**（白板只有六种几何：`rectangle` `ellipse` `diamond` `triangle` `hexagon` `star`）：

| Mermaid `type`                                                                     | 白板 `geo`  | 理由                             |
| ---------------------------------------------------------------------------------- | ----------- | -------------------------------- |
| `diamond`                                                                          | `diamond`   | 一一对应                         |
| `hexagon`                                                                          | `hexagon`   | 一一对应                         |
| `circle` `doublecircle` `stadium`                                                  | `ellipse`   | 圆与胶囊都是圆角轮廓，椭圆最近   |
| `square` `round` `subroutine` `cylinder` `odd` `trapezoid` `lean_*` `inv_*` `null` | `rectangle` | **降级默认**：认不出的一律矩形   |

`triangle` 与 `star` 没有 Mermaid 对应物，导入永远不会产出这两种——这是有意的，不拿它们硬凑。

**对象产出**（一个 Mermaid 图 → 一次 `addItems`）：

| Mermaid 元素 | 白板对象                                                               |
| ------------ | ---------------------------------------------------------------------- |
| subgraph     | `shape`（`geo: rectangle`、`fill: "none"`、`label` = 标题），最先入列 |
| edge         | `line`（`points` 两点、`arrowEnd`、`dash` 按 `stroke`）                |
| edge 标签    | `text`（居中在线段中点，`align: "middle"`），空标签不产出             |
| node         | `shape`（`geo` 按上表、`label` = 节点文字）                            |

`ShapeItem` 自带 `label` 字段，所以节点文字**不另起 `text` 对象**——否则移动一个节点要拖两次。
入列顺序即 z 序（`addItems` 对 `z === 0` 的对象按数组顺序递增编号），所以子图框在最底、连线在中间、节点压在连线上、边标签在最上。

**连线端点**：线段从起点形状中心指向终点形状中心，两端各自裁到形状边界上。裁剪走一条统一代码路径——把 `geo` 取成多边形（椭圆按 64 边形近似，其余用 `geometry.geoVertices`），求中心射线与各边的交点。这样「箭头停在菱形的斜边上而不是它的外接矩形上」是免费的，并且可以在单测里断言端点确实落在边界上。

**布局**：`layout.ts` 用 dagre，`rankdir` 直接取 Mermaid 声明的方向（`TB` / `BT` / `LR` / `RL`），节点尺寸由标签文字估算（字符数 × 字宽 + 内边距，字宽取 `palette.fontSize(size) * 0.58`，高度取两倍行高），结果整体平移到以落点为中心。dagre 的图是**扁平的**：subgraph 不参与布局，框是事后按成员包围盒 + 内边距算出来的（D5）。

生成的对象和手画的没有任何区别：可选中、可拖、可改样式、可删，撤销一次整张图消失。

### 3.2 路径 b：图片回退（其余图种）

`sequenceDiagram` / `classDiagram` / `stateDiagram` / `erDiagram` / `gantt` / `pie` / `mindmap` / `timeline` / `journey` / `quadrantChart` 等一律：

```
mermaid.render(id, text) → svg 字符串
  → new File([svg], "<图种>.svg", { type: "image/svg+xml" })
  → dnd/external-content.createImageShapes([file], at)
```

`createImageShapes` 是现成的资产导入路径，**一行都不用改**，它已经做完了我们需要的三件事：

1. `image/svg+xml` 先经 `rasterizeSvg` 在本地栅格化成 PNG——白板的 `image` 对象只认位图，而且把原始 SVG 存进工作区等于把一份可执行文档放进画布（`external-content.ts` 的既有决定）。
2. 字节经 `assets.uploadAsset` 落到 `.armadra/assets/`，**内容寻址**，同一张图只存一份；8 MiB 上限（`MAX_ASSET_BYTES`）由它判，超了抛 `AssetTooLargeError` 并且已经提示过一次。
3. 自然尺寸解码后经 `imageShapeSize` 等比缩到 800 px 以内，白板文档里只留 `assetPath`。

渲染容器是一个 `position:absolute; left:-10000px` 的离屏 `<div>`，用完即 `remove()`。

## 4. 入口

### 4.1 加号菜单 / 命令

`menus/add-menu.ts` 的 `content` 组增加 `add.importMermaid`（图标 `Workflow`），`shortcut: "canvas.importMermaid"`。命令本身注册在 `ToolLayer`（白板层自己的插槽，不动 `FlowWorkspace`），默认键 **⌘⇧M**——`keybindings/commands.ts` 全表里 `Mod+Shift+M` 与 `Mod+M` 都空着，`keybindings.test.ts` 的冲突检测能兜住将来的撞车。

### 4.2 对话框

shadcn `Dialog` + `Textarea` + `Button` + `Tabs`，左输入右预览：

- 左侧 `Textarea` 输入 Mermaid 文本，400 ms 去抖后跑一次 `mermaid.parse`。
- 右侧预览是 `mermaid.render` 出来的 SVG，经 `dangerouslySetInnerHTML` 放进容器——安全性见 §5，`securityLevel: "strict"` 已经把脚本与 HTML 标签剥掉了。
- 窄屏（`< 768px`）用 `Tabs` 把「编辑 / 预览」切成两页，不并排。
- 确认落到**视口中心**（`interaction/pointer.viewportCentre()`），不是鼠标最后位置——对话框盖着画布，鼠标位置没有意义。

对话框的开关状态是一个模块级 zustand store（`mermaid/open.ts`），所以菜单、命令、粘贴、拖放四个入口都能打开它而不必互相 import 组件。

### 4.3 粘贴

`detect.ts` 的 `looksLikeMermaid(text)`：去掉 `%%` 注释行与 `%%{…}%%` 指令块后，首个非空行必须匹配

```
^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|
  gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|requirementDiagram|
  C4Context|sankey-beta|xychart-beta|block-beta)\b
```

`use-clipboard.paste()` 在「纯文本 → `wb.text`」那一支之前插一道：命中就**打开对话框并预填文本**，不直接落地（D8）。`armadra/canvas@1` 的 JSON 与文件两支在它前面，顺序不变。

### 4.4 拖放 `.mmd` / `.mermaid`

`external-content.ts` 的 `FileRoute` 增加第三个取值 `"mermaid"`，`routeFile` 在图片判定之后、文件兜底之前按扩展名认它（MIME 一律是空串或 `text/plain`，只能看扩展名）。`addBrowserFiles` 把这一支读成文本后打开对话框；多个 `.mmd` 一次拖进来时只开第一个，其余按普通文件导入（对话框一次只能确认一张图）。

桌面壳的 OS 拖放给的是绝对路径而不是 `File`，`addNodesForPaths` 那条路**本轮不接**：它要先 `importLocalFiles` 复制进工作区再 `readFile` 读回来，为一个次要入口引入两次往返不值当。遗留项，见 §8。

## 5. 样式与安全

**样式**——导入的图必须看起来是这块板上的内容：

- 颜色一律取白板当前的「下一个对象样式」（`tool-store.getNextStyle()`，即用户在样式面板里选的那支笔），深浅两套色值由 `palette.colorHex` 按画布底色选（`scheme.canvasScheme()`）。
- 字号用 `palette.fontSize(style.size)`，与白板文字对象同一档表，所以导入的标签和手打的文字一样大。
- Mermaid 的 `style x fill:#f9f` 与 `classDef` **只映射填充色**：把十六进制吸附到调色板里最近的一个颜色名（RGB 欧氏距离），再把那个节点的 `fill` 设成 `"semi"`。描边色、字色、线宽一概丢弃——它们是为 Mermaid 自己的主题调的，在我们的板上只会打架。
- 边的 `stroke` 映射到白板的 `dash`：`normal → solid`、`dotted → dashed`、`thick → solid`（白板没有线宽维度的边样式，`thick` 无损降级）。

**安全**——图文本可能来自剪贴板、来自别人发的文件，一律当不可信数据：

- `mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false } })`，每次 `parse` / `render` 前都设一遍（mermaid 的配置是全局的，别的代码将来改了不能连累我们）。`strict` 下 Mermaid 自己会剥掉标签里的 HTML、禁用 `click` 交互与 `script` 指令。
- 预览渲染在离屏容器里，用完即弃；**不执行任何来自图文本的脚本**，也不给它任何回调（`bindFunctions` 从不调用）。
- 原生对象路径根本不碰 DOM：标签文字进的是 `ShapeItem.label`，由 `ShapeNode` 当纯文本渲染。
- 回退路径产出的 SVG 在进工作区之前已经被栅格化成 PNG（§3.2 第 1 条），所以磁盘上落的永远是像素。

## 6. 失败形态

| 情况                             | 表现                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| 语法错                           | 对话框里显示 Mermaid 原话的错误行（`error.message` 首段 + `error.hash.line + 1`），确认按钮禁用，**不产生任何对象** |
| 图种能解析但 `db` 缺方法         | 当成回退路径走图片                                                         |
| `mermaid.render` 抛（无 DOM 等） | toast 一条 `mermaid.renderFailed`，对话框留在原处，不落对象                 |
| 图片上传超 8 MiB                 | `uploadAsset` 自己提示，不落对象                                           |
| 空图（0 节点）                   | 确认按钮禁用                                                               |
| 落地中途换了画板                 | `importTargetIsActive` 为假，整批丢弃（沿用既有资产导入规则）               |

「不产生半成品」由结构保证：解析 → 布局 → 生成对象三步全在内存里做完，只有最后一次 `addItems` 才碰文档。

## 7. 验收

- 纯函数单测：`detect.test.ts`（正反样本）、`parse.test.ts`（真 mermaid，三种 fixture）、`layout.test.ts`（方向、不重叠、居中）、`to-items.test.ts`（对象数量 / 类型 / 标签 / 端点落在形状边界上 / z 序）。
- `render.ts` 在 jsdom 里跑不了（实测 `childNodeEl.node(...)?.getBBox is not a function`，jsdom 没有 SVG 度量），所以涉及它的测试一律 `vi.mock`，只断言调用契约。
- `pnpm --filter @armadra/web test` / `typecheck`、`pnpm check` 全绿。
- 体积回归：`pnpm --filter @armadra/web build` 后 `mermaid` chunk 独立存在，首屏 chunk 不变。

## 8. 遗留

1. 桌面壳 OS 拖放的 `.mmd` 绝对路径（§4.4）。
2. 反向导出（白板 → Mermaid 文本）不在本轮范围。
3. `classDef` 的描边 / 字色、`linkStyle`、`click` 交互一律丢弃，不打算支持。
4. 极大的图（> 200 节点）没有做分页或降级，dagre 在主线程上跑；实测 60 节点内无感。
