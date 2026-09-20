# v3 方案：Agent 改为"终端 + Hook"、浮层壳、画布精简

> 状态：Phase 0–4 已实施（2026-09-04，分支 main）。验证结果见 implementation-status.md  
> 日期：2026-09-04  
> 输入：当前代码盘点（2026-09-04）  
> 不变边界：[architecture.md](../guides/architecture.md) 的三层结构（React Flow / core / 桌面壳）与"SQLite 为真相"原则继续有效；本文取代 [redesign-plan.md](../history/redesign-plan.md) 成为新的实施契约。
> 2026-09-19：本文写于桌面壳还是 Tauri 的时候，壳相关的段落（`tauri.conf.json`、`tauri-plugin-*`、sidecar 打包）按当时的实现记述；章节编号被代码引用，所以正文不动。壳的现状见 [Electron 迁移](../design/electron-migration.md) 与 [架构](../guides/architecture.md)。
> 2026-09-20（R7d）：执行服务已从 Rust Runtime 换成 `apps/desktop/src/core/` 这个 TypeScript core，`armadra-hook` 从 Rust 小二进制换成随包的单文件 JS。正文里说「Rust」「sidecar」的地方按当时的实现读；§N 编号不变，被代码引用的仍是本文。

## 0. 一句话结论

保留 `React Flow + React + core + SQLite` 骨架不动（壳当时是 Tauri），做三件事：

1. **页面改成浮层壳**：五区固定壳改成"顶部标签栏 + 全屏画布 + 浮层"，删掉 Inspector、工作空间轨、状态栏、侧栏；引入 Tailwind v4 + shadcn/ui（Radix 原语）重做全部组件。
2. **Agent 改为"终端 + Hook"**：不再用 ACP 单轮会话。Agent 节点 = 终端节点里跑 CLI（Claude Code / Codex / Gemini / OpenCode），状态由 Runtime 的 Hook 服务接收各 CLI 的 hook 回报；权限在节点头部直答；Agent 之间通过"上下文链接"读取对方转录、通过"带帧粘贴"互发消息、通过本地控制 API 在画布上开新节点。
3. **画布精简**：10 种节点 → 8 种，6 种语义连线 → 1 种上下文链接（其余视觉边由状态派生、不入库），删除三态节点/摘要阈值/手绘层/连线选择层/复杂拖拽载荷，补上目前缺的：节点 resize、折叠、最大化、右键菜单、会话侧栏、MiniMap。

兼容性目标同时覆盖三层：**Agent CLI 兼容**（每个 provider 一个 hook 适配器，没有 hook 的 CLI 也能作为普通终端跑）、**平台兼容**（hook 客户端用独立可执行程序而不是 `sh + curl`，Windows 无需 tmux/curl）、**渲染兼容**（macOS WKWebView / Windows WebView2 / Linux WebKitGTK 的 CSS 基线明确到版本）。

## 1. 术语

- **Agent 节点**：跑着某个 CLI（Claude Code / Codex / Gemini / OpenCode）的终端节点；本文说"终端节点"时包含它。
- **Hook**：CLI 在回合开始/结束、权限请求等时机回调 Runtime 的回报机制，是本方案里 Agent 状态的唯一来源。
- **浮层壳**：除标签栏与画布外，其余界面（会话侧栏、抽屉、Dock、设置）都以浮层形式叠在画布上，不占固定分区。

命名约定：环境变量统一 `ARMADRA_*` 前缀，项目内产物统一放 `.armadra/` 目录。

## 2. 现状差距（2026-09-04 实测）

| 维度       | 当前                                                             | 目标设计                                                        | 决定                         |
| ---------- | ---------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------- |
| 壳         | 顶栏 36 + 轨 52 + 侧栏 236 + Inspector 272 + 状态栏 24，五区固定 | 标签栏 44 + 画布；其余全部浮层                                  | 改为浮层壳                   |
| 组件       | 手写 CSS 4.7k 行，无组件库；密度高、字号小、对比弱               | Tailwind v4 + shadcn/ui（Radix 原语）                           | 引入 Tailwind v4 + shadcn/ui |
| Agent      | ACP 子进程，一次 prompt 一个 session，不能追问；时间线自渲染     | CLI 在 PTY 里跑，hook 回报状态，权限 hook 直答                  | 换成终端 + Hook              |
| Agent 协作 | 无                                                               | 上下文链接、消息投递、画布控制、子代理卡片、`--after` DAG       | 分两阶段实现                 |
| 节点       | task/agent/terminal/diff/file/context/note/browser/image/log     | terminal(含 agent)/sticky/group/editor/diff/files/browser/image | 收敛为 8 种                  |
| 连线       | 6 种语义 + 1–6 热键选择层 + 推荐矩阵                             | 1 种入库的 context link；rope/ephemeral 派生                    | 只保留 link                  |
| 节点显示   | mini/normal/focus 三态 + 缩放阈值强制 mini + portal 聚焦         | resize / collapse(40px) / maximize / focus 层                   | 换成这四个动作               |
| 画布装饰   | 手绘笔迹层（5 色，入库）                                         | 无                                                              | 删除                         |
| 会话管理   | 无                                                               | 会话侧栏（按项目/状态分组、三色信号徽标）                       | 新增                         |
| 终端       | portable-pty，128 chunk 回放，Runtime 重启即丢                   | tmux 持久 + 快照重连 + 背压                                     | 本方案不改（见 §10 后续）    |

当前可删代码量（前端约 4500 行 TS/TSX + `acp.rs` 830 行 + `nodes.css`/`canvas.css` 大部分）已在盘点中逐文件列出，见 §9。

## 3. 页面设计

### 3.1 壳布局

```text
┌──────────────────────────────────────────────────────────────────┐
│ TabBar 44px（docked）：品牌 · 工作空间 tab（色点/未读数/⌄菜单）· +    │
├──────────────────────────────────────────────────────────────────┤
│ 画布（flex:1，纯黑底 + 点阵 24px）                                  │
│  ┌ Sessions 300px ┐                         ┌ 工具簇 34px×N ┐    │
│  │ 浮层 top:54     │                         │ ⌘K 资源管理器  │    │
│  │ left:14         │                         │ 源码控制 设置   │    │
│  └────────────────┘                         └───────────────┘    │
│                                                                    │
│  Controls 左下      canvas-pills          MiniMap 右下             │
│                ┌── Dock（底部居中，毛玻璃，圆角 16）──┐              │
│                │ +  ↶ ↷  ●保存  100% ▾               │              │
└──────────────────────────────────────────────────────────────────┘
浮层：Explorer 抽屉 360 / 源码控制抽屉 460 / 设置全屏 overlay / 通知条堆栈 top:46
```

z-index 栈固定为：画布内容 0 → pills 5 → sessions 12 → dock 20 → 工具簇与 pinned 抽屉 26 → 通知条 27 → tabbar 30 → focus 层 40 → 右键菜单 46 → 抽屉/对话框 55。

启动页保留（当前 `Launcher.tsx` 的"最近工作空间"卡片网格），但样式重做；打开工作空间后进入 TabBar 壳。多看板保留数据模型，UI 上放进 tab 的 `⌄` 菜单（切换看板 / 重命名 / 新建），默认只有一个 `Default`，不再占用侧栏。

### 3.2 画布交互

- 缩放范围 0.05–2；滚轮缩放、触控板平移；空格临时平移；`select` 模式框选（Shift 追加）。
- 背景 `<Background variant="dots" gap=24 size=2.5 offset=1.25>`，点落在网格线上。
- 左下 `<Controls>`（缩放 ± / 适应 / 相机锁），右下 `<MiniMap>` 按 Agent 状态描边（working 琥珀、needs-you 红、unread 强调色）。
- 画布右键菜单：新建终端 → 各 Agent（Claude / Codex / Gemini / OpenCode）→ 新建便签 → 新建文件管理器 → 打开文件… → 新建浏览器 → 分隔 → 全选 / 适应视图 / 整理画布。同一份菜单规格驱动画布右键、Dock `+`、Sessions 项目头 `+` 三个入口。
- 节点右键菜单：分组 / 加入组 / 移出组 → 颜色 → 复制 → 折叠/展开 → 最大化 → Agent 专属（重启 Agent / 切换权限模式 / 恢复会话）→ 删除。
- 节点操作：`<NodeResizer>`（选中时显示，最小尺寸表见 §3.4）；折叠到 32px 头部（xterm 保持挂载）；最大化改真实 rect（终端因此获得更多行）并记录 `premaxRect`；Focus 层把节点 DOM 移到 `fixed inset-0 z-40`，Esc 不退出（留给 CLI），用工具簇按钮退出。
- 整理（Tidy）：沿用现有 `auto-arrange.ts` 的拓扑分列算法。
- 撤销/重做：节点位置、尺寸、增删、连线的画布级历史（Dock 按钮 + ⌘Z / ⌘⇧Z），不含节点内部内容。
- 拖放只保留三种：OS 文件 → editor 节点；OS 文件夹 → files 节点；图片 → image 节点。粘贴文本 → sticky。删除 `payload.ts` 的 4 种载荷 × 2 种传输 × 节点级投放目标。

### 3.3 连线

入库只有一种 `link`（上下文链接）。渲染为 `FloatingEdge`：读两端节点绝对矩形，在相对边中点之间画贝塞尔（`data.anchor:"horizontal"` 时只走左右两侧）；强调色宽 2，选中 3.5。终端↔终端为双向箭头、标签 `⇄ 上下文`；源节点是便签时为单向箭头、标签 `🗒 便签`（便签只被读取，不回写）。判断依据是 `sourceNode.type === "sticky"`，与是否带 `agent` 无关。

派生边（每帧从状态计算、不入库）：

- **rope**：节点 A 通过控制 API 打开了 B，或 B 用 `--after A` 等待 A。颜色取 A 的 Agent 品牌色，1.5px；等待中虚线 `6 4` + 流动 + `⏳`。
- **subagent 边**：父 Agent → 临时子代理卡片。

连线手势：终端/便签节点左右各一个 13px 圆形 `bridge-handle`（静默 opacity .4，hover 1），右 `link-out` 拖到左 `link-in` 即建立 link。选中后 ⌫ 删除。

### 3.4 节点视觉

通用外壳 `.node-shell`：`bg-panel`，1px 边框且**顶边 3px 由节点色着色**，圆角 10，`shadow 0 8px 28px rgba(0,0,0,.4)`；选中边框变强调色。三种状态光晕用包裹层伪元素做 opacity 动画（不动画 box-shadow）：`unread` 蓝 2s、`working` 陶土色 `#d97757` 2.6s、`attention` 红 1.8s。

头部 `padding 6px 8px; gap 8px; bg-panel-header; cursor grab`，从左到右：折叠三角 → 12px 色点（点击弹 7 色调色板 Popover）→ 标题（点击变 input，`max-w-[220px]` 省略）→ 会话名 chip → Agent chip（品牌色）→ 状态胶囊 → spacer → 右侧图标钮：刷新 ⟳ / 搜索 / 最大化 / 关闭 ×。

状态胶囊：9.5px / 700 / `tracking-[.06em]` 全大写 + 前置 7px 圆点：`RUNNING`（陶土色，点脉冲）· `NEEDS YOU`（红，脉冲）· `TURN FAILED`（红，不脉冲）· `QUEUED`（灰，尾随 ▶）· `PAUSED`（灰）。`blocked` 且有 `pendingId` 时头部直接出现 `✓ 允许` / `✕ 拒绝` 两个内联按钮。

Agent 品牌色：Claude `#d97757`、Codex `#10a37f`、Gemini `#4285f4`、OpenCode `#a78bfa`。节点调色板 7 色：`#0a84ff #32d74b #ffd60a #ff453a #bf5af2 #6ac4dc #ff9f0a`。

尺寸表（2026-09-19 修订：数字按「内容自己的标准尺寸」重定，浏览器 = 一块标准视口 1280×800，终端按 12px 字号排得下约 120×36；章节编号 §3.4 不变，旧数字见本条之前的版本）：

| 节点                 | 默认尺寸 | 最小尺寸 | 内容                                                                                                                                                      |
| -------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| terminal（含 Agent） | 960×600  | 320×200  | xterm + fit + web-links + unicode11                                                                                                                       |
| sticky               | 280×220  | 160×120  | 底 `${color}22`、边 `color`；平时渲染 Markdown，点击切 textarea；底部相对时间                                                                             |
| group                | 800×560  | 200×140  | 1.5px 虚线 + 圆角 14 + `${color}0f`；框体 `pointer-events:none`，只有顶边浮动标签胶囊（色点 + 可编辑名，也是拖拽把手）可交互；用 React Flow parent/子节点 |
| editor               | 960×640  | 320×200  | 阶段一用 CodeMirror 6 只读/可编辑 + 保存；Monaco 留待后续                                                                                                 |
| diff                 | 1200×700 | 420×220  | 只读 diff 视图（工作区 / 暂存区），接受/回滚动作迁到源码控制抽屉                                                                                          |
| files                | 360×640  | 220×160  | 面包屑 + 过滤框 + 列表；双击文件 → 新 editor 节点                                                                                                         |
| browser              | 1280×800 | 480×320  | 沙箱 iframe 预览（不变），标注"预览"                                                                                                                      |
| image                | 260×200  | 160×120  | `<img>`                                                                                                                                                   |

节点外壳的密度同批收紧（2026-09-19）：折叠高度 40 → **32**（头部 30），终端内边距 8 → **4**，头部图标钮 26 → **24**、标题 12px；浏览器节点工具栏高 28、地址栏 12px。新建节点落在视口中心；当时缩放低于 0.5 时把相机抬到 100% 并对准它，这样按标准尺寸建出来的节点一出现就是 1:1 可用的。

临时卡片（不入库、不进撤销）：**subagent**（父 Agent 下方，左侧 3px 陶土竖条，任务名 + 计时 + tokens/工具数，展开看转录）。

### 3.5 会话侧栏

300px 浮层卡片，`top 54 left 14`，`max-h calc(100vh-96px)`，未 pin 时由左上 34px 图标 hover 弹出，⌘⇧L pin。结构：标题行（Sessions · 计数 · pin/关）→ 分组 tabs（工作空间 / 状态，2px 强调色下划线）→ 过滤框 → 列表 → 底部"历史"折叠（已关闭会话可重开）。

- 工作空间模式：项目头（chevron、字母 monogram、名字、`⎇` 分支、三个信号徽标 🔔 需要你 / ✓ 完成未读 / ↻ 运行中 各带计数、`+`）→ 组 → 会话行。
- 状态模式：按 `attention → working → unread → idle → unknown` 分区（2026-09-04 裁决：正在运行且有未读的节点归入运行中，与 MiniMap 一致，行内仍显示未读标记；未读只由已读回执清除，新回合不清除），区内按最近状态变更排序，显示"处于该状态多久"。
- 会话行：左侧状态标记（needs-you 红铃铛脉冲 / unread 蓝对勾 / 其余 8px 圆点）、标题（双击改名）、Agent chip、上下文 % chip、`×` 结束；第二行 meta：目录名 / 状态时长。点击行 → 画布居中到该节点。

### 3.6 其他浮层

- **Explorer 抽屉**（⌘⇧E）：右侧 360px + scrim；可 pin 成 `top 96 right 14 bottom 14` 的 320px 浮卡。内容沿用 `FileTree.tsx` 的懒加载树 + Git 徽标；点击文件 → editor 节点。
- **源码控制抽屉**（⌘⇧G）：460px；status 列表、stage/unstage、逐文件 diff（打开为 diff 节点）、回滚（确认）、commit（输入框 + ⌘⏎）。现有 `git.rs` 已支持 status/diff/stage/revert，只需补 commit。
- **设置**（⌘,）：全屏 overlay，左侧分组导航（AI / 工作区 / 界面 / 应用），右侧 `max-w-[860px]` 内容列。AI 组：Agent 启用/禁用、默认 Agent、默认权限模式、Hook 安装状态与"重新安装"按钮、自定义 Agent（命令 + 参数 + 基准 Agent）。
- **命令面板**（⌘K）：cmdk；分组"新建 / 跳转到节点 / 命令"。
- **通知条堆栈**：保存失败、Runtime 断开、Hook 未安装、终端压力。
- **删除确认**：统一 `AlertDialog`。

## 4. 组件库与主题

### 4.1 选型

| 层       | 选择                                                       | 理由                                                                            |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 原子样式 | Tailwind v4（`@tailwindcss/vite`）                         | 零运行时；与 shadcn/ui 配套；CSS 变量主题天然契合                               |
| 组件     | shadcn/ui（Radix Primitives，源码拷入 `apps/web/src/ui/`） | 可完全定制、无黑盒样式；键盘/无障碍/焦点管理由 Radix 保证；拷入源码不受升级破坏 |
| 命令面板 | cmdk                                                       | shadcn Command 即基于它                                                         |
| Toast    | sonner                                                     | 轻、可堆叠                                                                      |
| 图标     | lucide-react（已用）                                       | 不变                                                                            |
| 动效     | motion（已用）仅 opacity/transform                         | 不变                                                                            |
| 编辑器   | @codemirror/\*                                             | 体积小、WebKit 兼容好；Monaco 后置                                              |
| 终端     | @xterm/xterm 6 + fit + web-links + unicode11               | WebGL addon 在 WKWebView 上易丢上下文，默认不启用                               |

需要拷入的 shadcn 组件：Button、Input、Textarea、Switch、Select、Tabs、Tooltip、Popover、DropdownMenu、ContextMenu、Dialog、AlertDialog、Sheet（抽屉）、Command、ScrollArea、Badge、Separator、Kbd（自写）。

### 4.2 兼容性基线

Tailwind v4 依赖 `@property`、`color-mix()`、cascade layers，运行时最低要求 **Safari 16.4 / Chrome 111 / Firefox 128**。对应桌面壳：macOS 13.3+（WKWebView）、Windows 10 1809+ WebView2 常青版、Linux WebKitGTK 2.40+。Tauri 配置里把 `minimumSystemVersion` 设为 13.3；低于此版本启动页给出明确提示。若评审要求支持 macOS 12，则退回 Tailwind v3.4（组件代码不变，只换构建插件）。

### 4.3 主题 token

`tokens.css` 改为"表面高度"命名并映射到 shadcn 变量名，深色优先，浅色暖白：

```css
:root {
  /* dark */
  --tint-rgb: 255 255 255;
  --bg: #1e1e1e;
  --panel: #282828;
  --panel-header: #323232;
  --canvas-bg: #000;
  --canvas-dot: #4a4a4a;
  --surface-sunken: #161616;
  --surface-deep: #202020;
  --surface-raised: #2e2e2e;
  --surface-overlay: #343434;
  --border: rgb(var(--tint-rgb) / 0.1);
  --text: rgb(var(--tint-rgb) / 0.85);
  --muted: rgb(var(--tint-rgb) / 0.55);
  --accent: #0a84ff;
  --accent-text: #6cb0ff;
  --danger: #ff453a;
  --warn: #ff9f0a;
  --caution: #ffd60a;
  --success: #32d74b;
  --agent-working: #d97757;
  --radius: 8px;
  --radius-sm: 6px;
  --radius-lg: 12px;
  --term-bg: #0a0a0a;
  /* shadcn aliases */
  --background: var(--bg);
  --foreground: var(--text);
  --card: var(--panel);
  --popover: var(--surface-overlay);
  --primary: var(--accent);
  --destructive: var(--danger);
  --ring: var(--accent);
}
:root[data-theme="light"] {
  --tint-rgb: 58 48 38;
  --bg: #fdfbf7;
  --panel: #ffffff;
  --panel-header: #f3efe8;
  --canvas-bg: #f6f2ea;
  --canvas-dot: #cfc8bc;
  --text: rgb(var(--tint-rgb) / 0.9);
  --muted: rgb(var(--tint-rgb) / 0.7);
  --accent: #007aff; /* 其余同名覆盖 */
}
```

规则：所有颜色只通过变量；状态必须"图标 + 文字"；不加载在线字体；`prefers-reduced-motion` 关闭脉冲光晕。

## 5. Agent 设计（终端 + Hook，当时以 Rust 实现，现由 core 承接）

### 5.1 模型

- 没有独立的 Agent 节点类型。`terminal` 节点数据增加 `agent?: { id, accountId?, permissionMode?, model?, sessionId?, initialCommand }`。
- Agent 注册表 `packages/shared/src/agents.ts`（纯数据）：

| 字段              | 说明                                                           |
| ----------------- | -------------------------------------------------------------- |
| `id`              | `claude` / `codex` / `gemini` / `opencode` / `custom:<uuid>`   |
| `label` / `color` | 显示名与品牌色                                                 |
| `launchCmd`       | 程序名                                                         |
| `promptMode`      | `argv` / `flag-prompt` / `stdin-after-start`                   |
| `permissionFlag`  | 权限模式如何映射到命令行参数                                   |
| `sessionIdFlag?`  | 可由我们预铸会话 ID 的 CLI                                     |
| `capabilities`    | `hooks` / `resume` / `subagent` / `contextLink` / `usage` 集合 |
| `hookAdapter`     | 见 §5.3                                                        |

- 启动行由纯函数 `assembleLaunchCommand(spec)` 生成，按顺序拼：程序（含设置里的覆盖）→ 权限模式参数 → 模型参数 → 预铸 `--session-id` → prompt。prompt 压成一行，因为它是被**敲进 shell** 的，不是 exec。
- 创建 Agent 节点 = 创建终端节点（PTY 环境里注入 §5.2 的变量）→ shell 就绪后写入启动行 + Enter。

### 5.2 Hook 服务（Runtime 内）

Runtime 在现有 `127.0.0.1:43120` 之外**再监听一个 Unix socket**（`<data>/hook.sock`，Windows 用命名管道），供 hook 客户端调用；TCP loopback 作为回退。

注入 PTY 的环境变量（只放"地址"，不放凭据，因为进程环境可被同用户读到）：

| 变量                       | 含义                              |
| -------------------------- | --------------------------------- |
| `ARMADRA_NODE_ID`          | 节点 ID，所有 hook 的门槛         |
| `ARMADRA_AGENT_ID`         | provider                          |
| `ARMADRA_ENDPOINT_FILE`    | 0600 端点文件路径                 |
| `ARMADRA_CANVAS_CONTROL=1` | 允许调用控制 API                  |
| `ARMADRA_PERM_WAIT_SECS`   | >0 时启用 hook 直答权限（阶段三） |

端点文件 `<data>/hook-endpoint.env`（0600，每次 hook 调用重新读取，因为终端可能比 Runtime 活得久）：`ARMADRA_HOOK_PORT`、`ARMADRA_HOOK_SOCK`、`ARMADRA_HOOK_TOKEN`（应用级 bearer）、`ARMADRA_NODE_TOKEN_DIR`、`ARMADRA_HOOK_VERSION`。

每节点令牌**派生而不存储**：`kid = b64url(HMAC(secret, "armadra-node-kid-v1"))[0..8]`，`mac = b64url(HMAC(secret, "armadra-node-v1|" + nodeId))`，令牌 `kid.mac`，写到 `<data>/node-tokens/<nodeId>`（0700/0600，原子写）。`secret` 32 字节，首次生成后存于 OS keyring（`keyring` crate），回退到 0600 文件。

校验三分：`verified`（本实例 kid 且 mac 正确，常量时间比较）/ `legacy`（无令牌或外来 kid，允许，仅作标记）/ `forged`（本实例 kid 但 mac 错，403）。状态回报路由 `legacy` 也接受；控制/消息路由要求 `verified`。

### 5.3 Hook 客户端与安装器

**客户端用独立可执行程序 `armadra-hook`**（随壳一起打包），而不是 `sh + curl`：Windows 无需 curl/sh，行为跨平台一致，也能做常量时间比较和原子文件写。行为：

1. 无 `ARMADRA_NODE_ID` → 读空 stdin 并 exit 0（在用户自己的终端里是零副作用）。
2. 读端点文件；按名字读取 `<tokenDir>/<nodeId>` 令牌（查找，不扫描）。
3. stdin 全量读入内存（上限 1 MiB），POST `/hook/<agentId>`，body 为 JSON `{nodeId, version, payload, pendingId?, answered?}`，头 `X-Armadra-Hook-Token`、`X-Armadra-Node-Token`、`X-Armadra-Hook-Client: <rev>`。先 socket 后 TCP，连接超时 0.5s、总超时 1.5s，失败静默（fail-open）。
4. 权限等待模式（§5.5）时前台轮询答案文件并把决定打印到 stdout。

**安装器**（core 的 agent hooks 安装模块，设置页"安装 / 重新安装 / 卸载"）：

| provider | 接缝                                                                                                                         | 事件                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude   | 合并到 `~/.claude/settings.json` 的 `hooks`，命令 `"<armadra-hook> claude"`                                                  | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, PermissionRequest, Stop, StopFailure, SessionEnd, SubagentStart, SubagentStop |
| codex    | `~/.codex/hooks.json` + `config.toml` 的 `hooks.state.<key>.trusted_hash`（必须复现 codex 自己的哈希，否则 hook 静默不触发） | 同上子集 + SubagentStart/Stop                                                                                                                        |
| gemini   | `~/.gemini/settings.json`                                                                                                    | BeforeAgent / AfterAgent / BeforeTool / AfterTool / Notification / SessionStart / SessionEnd（不订阅逐 chunk 的 AfterModel）                         |
| opencode | `<config>/plugins/armadra-status.js` 插件（只能从 `event` 总线拿事件）                                                       | `session.idle`、`message.updated`、`permission.asked`、`tool.*`                                                                                      |

安装幂等：以命令里 `armadra-hook` 的路径尾作为"我们管理的条目"识别并重写；卸载只删这些条目。设置页显示每个 provider 的安装状态与脚本版本；版本落后时通知条提示。每个 provider 的事件列表放在 `packages/shared/src/agents/hook-events.ts` 单一来源。

### 5.4 状态归一与归约

每 provider 一个归一函数 → 统一事件：

```text
AgentEvent {
  nodeId, agentId, kind: state|session|subagent-start|subagent-end,
  state?: working|waiting|blocked|done,
  newTurn?, interrupted?, errored?, idle?, awaitingInput?,
  pendingId?, askKind?, sessionId?, sessionPhase?, lastMessage?,
  toolUseId?, subagentType?, taskLabel?, durationMs?, tokens?, toolUses?, result?,
  verified?, clientRevision?
}
```

映射：UserPromptSubmit / BeforeAgent / user message → `working + newTurn`；Pre/PostToolUse → `working`；PermissionRequest / 权限型 Notification → `blocked (+pendingId)`；AskUserQuestion / `request_user_input` → `waiting (+awaitingInput)`；Stop / AfterAgent / `session.idle` → `done`；StopFailure → `done + errored`；claude 的空闲提示 Notification → `done + idle`（仅作"救援"）；SessionStart/End → `session`。

归约器（core 的 agent 状态归约模块，前端 store 用同一套规则做本地镜像）：

- **done 保持 3s**：迟到的非 `newTurn` 的 `working` 不能复活刚结束的回合（claude hook 并行执行）。
- **idle 救援**只能把 `working` 变为 `done`，不能动 blocked/waiting。
- **awaitingInput 保持**：未回答的问题，其回合结束的 `done` 改写为 `waiting`。
- session 事件重置为 idle；subagent 事件只记身份不改主状态。
- **20 分钟无事件**的 `working` 由定时器打一条合成结束边。
- 状态镜像落 SQLite `agent_status`（节点 ID、状态、更新时间、sessionId、pendingId、unread），Runtime 重启后标记 `restored`（restored 的 `done` 不视为新鲜 idle）。

推送：`WS /api/workspaces/{id}/events` 广播 `agent.status`、`agent.subagent`、`agent.approval`、`agent.delivery`、`terminal.exit`。前端：节点胶囊、光晕、MiniMap 描边、会话侧栏徽标、系统通知（窗口未聚焦时，Tauri notification 插件）、提示音（每节点 5s 节流）。

### 5.5 权限直答

阶段二先做"**观察 + 快捷键**"：`blocked` 时头部显示 `✓ 允许 / ✕ 拒绝`，点击向 PTY 写入 CLI 对应按键（claude：`1`/`3`+Enter 或 `y`/`n`，按 provider 表）。它对所有 CLI 都可用，代价是依赖 CLI 提示行的形状。

阶段三对 claude 启用 **hook 直答**（确定性）：`PermissionRequest` hook 且 `ARMADRA_PERM_WAIT_SECS>0` 时，客户端铸 `pendingId = <nodeId>-<epochMs>-<pid>`，把请求 JSON 写到 `<data>/pending/<id>.json`（0600），前台 POST 事件（带 `pendingId`），然后每 0.5s 轮询 `<id>.answer`。UI 答复 → Runtime 原子写一行 `allow`/`deny` → 客户端删除两个文件、后台 POST `answered=<decision>`、把 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` 打到 stdout。超时不输出 → CLI 回到自己的交互提示（fail-open）。启动时与每小时清理 10 分钟以上的孤儿文件。`agent_approvals` 表记录 request/answer/resolver 以便审计。

### 5.6 上下文链接（Agent 读对方）

- `link` 边即"上下文链接"。前端每次连线变化把每个节点的链接文档 `{nodeId, links:[{id,title,kind}]}` PUT 到 Runtime；Runtime 存 `context_links` 表。
- Skill：Runtime 把 `~/.claude/skills/armadra-linked-context/SKILL.md` 写入（内容自撰），非 claude 的 CLI 以标记块 `<!-- armadra:linked-context:start/end -->` 合并到 `~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、opencode `AGENTS.md`。Skill 指示 Agent 运行 `armadra-hook context <verb> --node <id|title>`。
- 动词：`list` / `summary` / `transcript` / `terminal`，POST `/context-link/<verb>`，回复 `text/plain` 散文。
  这四个动词各自的读取上限、增量游标（`--since`）、每条连线的读取预算与脱敏，见 `docs/design/agent-delivery.md` §13：本节写的是当初的形状，`summary` 那一档此后换成了真正的摘要，`-n` 只留给 `transcript` 与 `terminal`。
- 授权：**只能读自己链接文档里列出的节点**，持有 bearer 也读不到未链接节点。
- 数据来源：claude 用 hook 上报的 `transcript_path`；codex/gemini 按 sessionId 在各自目录定位；opencode 用 `opencode export <id>`；`terminal` 动词读 PTY 的屏幕快照（阶段二先用最近 N 行回放，§10 的 vt100 快照落地后换成真实屏幕）；sticky 读实时文本。渲染：最近 N 行摘要、工具调用缩写。转录读取上限 5 MiB 尾部；不做 LLM 摘要。

### 5.7 Agent 互发消息

动词 `send` / `reply` / `notify`（`notify` 正文固定由应用生成，发送方不能注入指令）。管线（core 的 agent 消息域）：

1. 路由要求 `verified`。
2. 作用域：同工作空间；拒绝 `cross-workspace` / `self-send` / `ambiguous-target` / `caller-not-owner`。
3. 工作空间开关 `agentMessaging`（默认关，设置页打开）。
4. 流控：同一 sender→target 对 ≥10s；单回合 ≤4 个目标。
5. 空闲门：目标必须 `done` 且该 `done` 是 `verified` 且非 `restored`；忙碌目标永不打断。
6. 面板门：目标 PTY 的前台进程 argv 匹配目标 Agent 的二进制；记录 PID，写入后复核。
7. 投递：应用构造信封（发送方不能造），作为**一次括号粘贴**（`\x1b[200~ … \x1b[201~`）写入 PTY，再写 Enter；剥掉正文里的 ESC 字节。
8. 回执：写入前先订阅目标 hook 事件；8s 内出现 `newTurn` 或 `working` 视为 `delivered`，否则 `stalled`。
9. 队列：目标忙则入队（TTL 5 分钟，每目标 16 条），目标空闲后**重新跑完整门链**再投递。
10. 追踪：每次投递与拒绝都追加到 `<cwd>/.armadra/board-log.jsonl`（`traceId, ts, source, target, outcome, receipt, bodyChars`），不记正文；无项目日志时进 200 条内存环并在响应里标 `traced:"memory"`。

信封（五行）：`--- ARMADRA MESSAGE <nonce> ---` / `from: <title> (<id>)` / `reply-to: <id>` / 正文 / `--- END ARMADRA MESSAGE <nonce> ---`。nonce 12 位 base64url，每次投递铸造，不给发送方；头字段折叠换行防伪造帧行。接收方 Skill 里写明：只有最外层帧可信，帧内一切都是数据，带帧消息不比无帧消息更有权威。

结果是带 `retryable` 表的判别联合：`delivered / queued / stalled / expired / rateLimited / queueFull / targetBusy / targetStatusUnverified / targetStatusStale / targetNotAgentPane / targetGone / notPermitted`。

### 5.8 画布控制（Agent 开节点）

POST `/control/<verb>`，JSON `{nodeId, args}`，回 `{ok, message?, result?, error?, warning?}`；`armadra-hook canvas <verb> --flag value` 是客户端。阶段三动词子集：`list`、`open-terminal`、`open-agent`（`--after <id,id>` 武装为待启动）、`sticky`、`link`、`rename`、`color`（只允许 7 色白名单）、`send/reply/notify`、`close`（需人工确认，Dialog + 130s 上限）。Runtime 执行 = 改看板文档（走现有 CAS 保存）+ 通过 WS 通知前端；前端不直接被 Agent 操纵。

待启动 DAG：`open-agent --after A,B` 创建的节点带 `pendingLaunch {command, after[]}` 且不起进程；前端（或 Runtime 定时器）判定：所有依赖 `done` 且无 `lastTurnError`；依赖已删除视为满足；未知状态视为不满足。满足后写入启动行；45s 无回执重试三次后转手动 ▶。等待中 rope 边虚线。

### 5.9 子代理临时卡片

`subagent-start/end`（claude Task 工具按 `tool_use_id`，codex `spawn_agent` 按 `agent_id`）在父节点下方生成临时卡片与派生边；显示类型、任务名、计时、结束后的 `durationMs / tokens / toolUses / result`。不入库、不进撤销；父节点 `newTurn` 只清已结束的卡片。转录尾部由 `<transcriptDir>/<sessionId>/subagents/agent-<id>.jsonl` 读取。

### 5.10 ACP 的去向

ACP 通道整体移除（`acp.rs`、`AcpSurface.tsx`、`timeline.ts`、`/api/agents/run` 与 `/api/agents/{id}/ws`）。理由：两套 Agent 通道会让状态、权限、会话侧栏都出现两种语义；终端 + Hook 覆盖了同样的 CLI 集合，而且天然支持多轮。`agent.rs` 保留探测可执行文件与 PATH 补全的部分。

## 6. 数据模型与迁移（`0004_v3_domain.sql`）

节点类型：`terminal | sticky | group | editor | diff | files | browser | image`。

| 旧类型                            | 迁移                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| agent                             | `terminal`，`data.agent = {id: adapter 映射, initialCommand: 由 command/args 拼}`，`sessionId` 清空 |
| task                              | `sticky`，`content = "# 标题\n描述\n- [ ] 子项"`                                                    |
| note                              | `sticky`                                                                                            |
| file                              | `editor {path}`                                                                                     |
| context                           | `files {path}`                                                                                      |
| log                               | 删除（无持久价值）                                                                                  |
| terminal / diff / browser / image | 原样，去掉多余字段                                                                                  |

边：所有 kind → `link`；删除 `strokes_json`、`zoom` 列；状态列改为 `agent_status` 表（不再存 node.status）。新表：

```text
agent_status(node_id PK, workspace_id, agent_id, state, unread, session_id, pending_id, verified, restored, updated_at)
agent_approvals(id PK, node_id, workspace_id, request_json, answer, answered_by, created_at, answered_at)
context_links(node_id PK, workspace_id, links_json, updated_at)
agent_deliveries(trace_id PK, workspace_id, source_node_id, target_node_id, outcome, receipt, body_chars, created_at)
hook_installs(agent_id PK, client_revision, installed_at, config_path)
```

数据层的 `valid_node_data` 校验按新类型收紧；迁移前自动备份 `canvas.db.backup-v2-*`，并用现有真实 v2 库做回归测试。

## 7. API 与 WS

新增：

```text
GET    /api/workspaces/{id}/sessions                 会话侧栏数据（终端 + agent 状态 + 未读）
WS     /api/workspaces/{id}/events                   agent.status / agent.subagent / agent.approval / agent.delivery / terminal.exit / board.changed
POST   /api/terminals                                 增加 agent 字段（注入 ARMADRA_* 环境变量）
GET    /api/agents                                    注册表 + 可执行文件探测 + hook 安装状态
POST   /api/agents/{id}/hooks/install | uninstall
POST   /api/approvals/{pendingId}/answer              {decision}
PUT    /api/workspaces/{id}/context-links/{nodeId}
POST   /api/git/commit
--- 以下只在 hook socket / loopback 上暴露，要求 bearer ---
POST   /hook/{agentId}
POST   /context-link/{verb}
POST   /control/{verb}
```

移除：`/api/agents/run`、`/api/agents/{id}/ws`、`/api/agents/context-preview`、`/api/gateway`。WS 消息形状进入 `packages/shared/src/api.ts`（当前终端与 ACP 的 socket 形状散落在组件里，这次统一）。

## 8. 前端目录（目标）

```text
apps/web/src
  ui/                      shadcn 组件（拷入源码）+ Kbd
  styles/tokens.css        §4.3
  styles/app.css           @import "tailwindcss" + 少量全局
  app/App.tsx              Provider + Launcher/Shell 切换
  app/Launcher.tsx
  shell/TabBar.tsx  Dock.tsx  ControlsCluster.tsx  Banners.tsx
  sessions/SessionsSidebar.tsx  SessionRow.tsx  grouping.ts
  panels/ExplorerDrawer.tsx  SourceControlDrawer.tsx  SettingsOverlay.tsx  CommandPalette.tsx
  canvas/CanvasWorkspace.tsx  FloatingEdge.tsx  StatusMiniMap.tsx  menus/(canvas|node)-menu.tsx
  canvas/history.ts（撤销）  tidy.ts（原 auto-arrange）  zones.ts（可选）
  nodes/NodeShell.tsx（外壳/头部/胶囊/光晕）  registry.ts（类型 → 组件/尺寸/颜色）
  nodes/TerminalNode.tsx  StickyNode.tsx  GroupNode.tsx  EditorNode.tsx  DiffNode.tsx  FilesNode.tsx  BrowserNode.tsx  ImageNode.tsx  SubagentCard.tsx
  terminal/TerminalSurface.tsx  transport.ts
  agent/status-store.ts（归约镜像）  approvals.ts  launch.ts（assembleLaunchCommand）
  store/canvas-store.ts  save/canvas-save-queue.ts  api/client.ts  api/events.ts（WS 订阅）
  keybindings.ts           命令注册表：id / scope / 默认键 / allowInTerminal
```

删除：`inspector/`、`shell/Rail|Sidebar|StatusBar|Topbar|gateway`、`sidebar/BoardList|NodePalette`、`canvas/StrokeLayer|EdgePicker|edge-types|node-zoom|SemanticEdge|diff-scan`、`canvas/dnd/payload|useNodeDropTarget|hint`、`agent/AcpSurface|timeline`、`nodes/TaskNode|ContextNode|LogNode|FileNode|AgentNode|actions|useNodeCommand`、`modals/DiffScanDrawer`、`components/MobileNav`、`preferences/`（并入设置）。

快捷键（`Cmd` 在 macOS 是 ⌘，其余平台 Ctrl）：⌘K 命令面板 · ⌘, 设置 · ⌘T 新终端 · ⌘⇧C 新 Agent · ⌘⇧L 会话侧栏 · ⌘⇧E 资源管理器 · ⌘⇧G 源码控制 · ⌘⇧U 资源面板 · ⌘⇧F 焦点模式 · ⌘⇧Enter 最大化 · ⌘W 关闭节点 · ⌘Z/⌘⇧Z 撤销重做 · ⌘⇧A 整理 · ⌘方向键 按几何切换节点 · ⌦/⌫ 删除 · ⌘F 终端搜索。每条命令带 `allowInTerminal` 位：终端聚焦时只有 ⌘K/⌘,/⌘⇧L/⌘⇧E/⌘⇧G/⌘⇧U/⌘W/⌘F 放行，其余键进 xterm。

## 9. 实施阶段与并行分工

按"先定契约，再并行 opus agent"的方式推进。每阶段先由一个 agent 落契约文件（shared schema / 迁移 / 组件基座），其余 agent 只调用不修改。

### Phase 0 · 基座（1 个 agent，串行，约 1 天）

1. Tailwind v4 + shadcn 初始化，拷入 §4.1 组件，`tokens.css` 按 §4.3。
2. `packages/shared`：v3 `domain.ts`（8 节点、1 边、agent 数据）、`agents.ts` 注册表、`hook-events.ts`、WS 事件联合、API schema。
3. Runtime：`0004` 迁移 + `model.rs`/`db.rs` 校验 + 真实 v2 库回归测试。
4. `nodes/registry.ts`、`NodeShell.tsx` 骨架、`keybindings.ts` 注册表——这三者是 Phase 1 的跨 agent 接口。

验收：`pnpm typecheck`、`cargo test`、旧库迁移测试通过；应用能以空壳启动。

### Phase 1 · 壳与画布（4 个 agent 并行，约 3 天）

| Agent  | 归属                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| shell  | TabBar、Dock、ControlsCluster、Banners、Launcher 重做、SettingsOverlay（外观/工作区组）、CommandPalette               |
| canvas | CanvasWorkspace 精简、FloatingEdge、StatusMiniMap、右键菜单、NodeResizer/折叠/最大化/焦点层、撤销重做、Tidy、拖放三件 |
| nodes  | 8 个节点体 + SubagentCard 外观（数据先用桩）、TerminalSurface 迁入新外壳、EditorNode（CodeMirror）、DiffNode 只读     |
| panels | SessionsSidebar（先用终端会话 + 桩状态）、ExplorerDrawer、SourceControlDrawer（含 Runtime `git/commit`）              |

验收：1440×900 真实浏览器走查；所有浮层 z 栈正确；终端在节点 resize/折叠/最大化后 fit 正确；深浅主题；`prefers-reduced-motion`。

### Phase 2 · Agent 运行时（3 个 agent 并行，约 4 天）

| Agent           | 归属                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| runtime-hook    | hook socket + bearer/节点令牌 + 端点文件 + `/hook` 路由 + 归一/归约 + `agent_status` + 工作空间事件 WS + 20 分钟 sweep                     |
| runtime-install | `armadra-hook` 二进制（sidecar 打包进 Tauri）+ claude/codex/gemini/opencode 安装器 + 设置页安装状态 API                                    |
| web-agent       | 创建 Agent 节点流程（`launch.ts`）、PTY 环境注入、节点头 Agent chip/状态胶囊/光晕、会话侧栏接真实状态、快捷键式允许/拒绝、系统通知与提示音 |

验收：本机 claude 与 codex 各跑一个节点，状态 working → blocked → done 全部由 hook 驱动且 UI 正确；Runtime 重启后镜像标记 `restored`；伪造节点令牌被 403；在用户自己的终端里运行同一 CLI 无任何副作用。

### Phase 3 · Agent 协作（3 个 agent 并行，约 4 天）

| Agent             | 归属                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime-collab    | `context_links` + `/context-link` 四个动词 + 转录定位器 + `/control` 动词子集 + 消息管线/队列/追踪 + `agent_deliveries`                                          |
| runtime-approvals | claude hook 直答（pending 文件、答案文件、清理）+ `agent_approvals`                                                                                              |
| web-collab        | Skill/AGENTS.md 安装状态 UI、消息设置开关、投递结果通知、SubagentCard 接真实事件、`--after` 待启动 DAG 与 rope 边、`.armadra/board-log.jsonl` 查看器（简单列表） |

验收：A 链接 B 后 A 能读 B 的最近 20 行摘要且读不到未链接的 C；A 向空闲 B 发消息 8s 内 B 进入 working 并留下 trace；B 忙时入队并在空闲后投递；claude 权限直答 allow/deny/超时三条路径；子代理卡片随 claude Task 出现和结束。

### Phase 4 · 打磨（视排期）

看板轻量视图（列 + 会话卡片投影）、通知/托盘、Monaco 替换 CodeMirror、tmux 持久终端与 vt100 屏幕快照（终端持久化本来排在更前面，因为它与 UI/Agent 改造正交，顺延到此处）。

## 10. 风险与需要 PoC 的点

| 风险                                                      | 处理                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| codex `trusted_hash` 算法变化导致 hook 静默失效           | 安装后用一条探测会话验证 hook 是否回报；失败在设置页红字提示     |
| CLI 权限提示行形状变化让"快捷键式允许/拒绝"失效           | 按 provider 表配置按键；claude 尽快切到 hook 直答                |
| `armadra-hook` 在 Windows 下的命名管道与 0600 文件语义    | Windows 用 ACL 限定当前用户；先做 PoC                            |
| 终端里 Agent CLI 退出后消息被 shell 执行                  | 投递前后双重校验前台进程 PID/argv；不匹配则 `targetNotAgentPane` |
| Tailwind v4 在旧 macOS 上不渲染                           | §4.2 明确最低版本；保留 v3.4 退路                                |
| React Flow 子节点（group）与 NodeResizer/最大化的几何冲突 | Phase 1 canvas agent 先做 group 的 PoC，再接入其他节点           |
| xterm 在节点频繁 resize 时的性能                          | resize 去抖 80ms；折叠/离屏节点暂停 fit                          |

## 11. 测试矩阵（新增部分）

- shared：v3 schema、v2→v3 数据映射、`assembleLaunchCommand` 各 promptMode、hook 事件表完整性。
- runtime：令牌派生/三分校验、hook 归一（每 provider 样例载荷）、归约器五条不变量、安装器幂等与卸载、迁移回归、消息门链每一种拒绝原因、队列 TTL/容量、pending 文件清理。
- web：status store 归约镜像、keybindings 放行位、SessionsSidebar 分组排序、FloatingEdge 几何、撤销栈；渲染面（NodeShell、TerminalNode、SessionsSidebar、TabBar）补 Testing Library 用例——当前这些大面全部无测试。
- 端到端（手工走查清单）：§9 各阶段验收项。

## 12. 与既有文档的关系

本文取代 [redesign-plan.md](../history/redesign-plan.md) 成为实施契约，[architecture.md](../guides/architecture.md) 的三层结构与"SQLite 为真相"原则不变；[interface-design.md](../history/interface-design.md) 描述的 v2 五区界面随本文作废。

早先排在前面的四项能力里，"ACP 多轮会话"被本方案的"终端 + Hook"整体替代（§5.10）；持久终端、快照重连、终端背压与本方案正交，顺延到 Phase 4。Editor / Group / 文件 watcher / 设置分层并入 Phase 1；SSH、远程 Runtime、GitHub 集成、配对、语音仍排在更远处，不在本文范围。

## 13. Phase 1 跨模块接口契约（并行 agent 只调用、不修改他人归属）

所有签名以 `packages/shared` v3 类型为准（`CanvasNode`、`CanvasEdge`、`BoardDocument`、`NodeType`、`AgentStatus`、`WorkspaceEvent`）。

### 13.1 `store/canvas-store.ts`（归属 canvas）

```ts
interface CanvasState {
  workspace: Workspace | null; boards: BoardBrief[]; boardId: string | null;
  document: BoardDocument | null;
  selectedNodeIds: string[];
  focusNodeId: string | null;              // 焦点层
  maximized: Record<string, { x:number; y:number; width:number; height:number }>; // premaxRect
  panels: { sessions: "hidden"|"peek"|"pinned"; explorer: "closed"|"drawer"|"pinned"; scm: "closed"|"drawer";
            settings: boolean; palette: boolean; kanban: boolean };
  saveState: "idle"|"saving"|"saved"|"error"; saveError: string | null;
  history: { past: BoardDocument[]; future: BoardDocument[] };
}
interface CanvasActions {
  setWorkspace; setBoards; selectBoard; setDocument; setSaveState; setSaveError;
  setPanel(key: keyof CanvasState["panels"], value): void;
  selectNodes(ids: string[]): void;
  addNode(type: NodeType, opts?: { position?: Position; title?: string; color?: string; data?: Partial<NodeData>; parentId?: string }): string; // 返回 id
  updateNode(id, patch: Partial<Omit<CanvasNode,"id"|"type"|"data">>): void;
  updateNodeData(id, patch: Partial<NodeData>): void;
  moveNodes(moves: { id; position }[]): void;
  resizeNode(id, size, position?): void;
  setCollapsed(id, collapsed: boolean): void;
  maximizeNode(id) / restoreNode(id): void;
  setFocusNode(id | null): void;
  setParent(ids: string[], parentId: string | null): void;
  removeNodes(ids): void; duplicateNodes(ids): string[];
  addEdge(source, target): string | null;   // 已存在或自连返回 null
  removeEdges(ids): void;
  setViewport(v): void;                     // 不进历史、不置 dirty
  undo(); redo();                           // 只覆盖节点/边的结构变化
  arrangeNodes(): void;                     // Tidy
}
export const useCanvasStore: UseBoundStore<StoreApi<CanvasState & CanvasActions>>;
export const useSelectedNodes = () => CanvasNode[];
```

### 13.2 `nodes/registry.ts` 与 `nodes/NodeShell.tsx`（归属 nodes）

```ts
export interface NodeBodyProps {
  id: string;
  node: CanvasNode;
  selected: boolean;
  collapsed: boolean;
  focused: boolean;
}
export const NODE_META: Record<
  NodeType,
  {
    label: string;
    icon: LucideIcon;
    defaultSize: Size;
    minSize: Size;
    defaultColor: string;
    hasBridgeHandles: boolean;
  }
>;
export const NODE_BODY: Record<NodeType, ComponentType<NodeBodyProps>>;

export interface NodeShellProps {
  node: CanvasNode;
  selected: boolean;
  status?: { tone: StatusTone; label: string; pulse?: boolean };
  glow?: "working" | "attention" | "unread";
  headerChips?: ReactNode; // 会话名 / Agent chip
  headerActions?: ReactNode; // 右侧图标钮，在"最大化 / 关闭"之前
  approval?: { pendingId: string; onAnswer: (d: "allow" | "deny") => void };
  children: ReactNode;
}
export function NodeShell(props: NodeShellProps): JSX.Element;
// NodeShell 内部：折叠三角、色点(ColorPicker)、可编辑标题、状态胶囊、最大化、关闭、NodeResizer（selected && !collapsed，minSize 取 NODE_META）、
// 左右 bridge handle（hasBridgeHandles 时）、光晕包裹层。所有动作直接调 useCanvasStore。
export function CanvasNodeRenderer(props: NodeProps<RFNode>): JSX.Element; // React Flow nodeTypes 的唯一入口，按 node.type 选 body 并包 NodeShell
```

### 13.3 `canvas/menus/add-menu.ts`（归属 canvas；shell 与 panels 只消费）

```ts
export interface AddMenuContext {
  addNode: CanvasActions["addNode"];
  position: Position;
  workspace: Workspace;
  agents: AgentInfo[];
}
export interface AddMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: "terminal" | "agent" | "content" | "canvas";
  shortcut?: CommandId;
  run: (ctx: AddMenuContext) => void;
  disabledReason?: (ctx: AddMenuContext) => string | null;
}
export function buildAddMenu(agents: AgentInfo[]): AddMenuItem[]; // 新建终端 → 各 Agent → 便签 → 文件管理器 → 打开文件… → 浏览器 → ─ → 全选/适应视图/整理
export function AddMenuContent(props: {
  ctx: AddMenuContext;
  kind: "context" | "dropdown";
}): JSX.Element; // 渲染成 ContextMenu 或 DropdownMenu 子项
```

### 13.4 `api/events.ts` 与 `agent/status-store.ts`（Phase 1 由 panels 建骨架，Phase 2 web-agent 填充）

```ts
export function useWorkspaceEvents(workspaceId: string | null): void;   // App 挂一次；内部维护单个 WS，自动重连
export function onWorkspaceEvent<T extends WorkspaceEvent["type"]>(type: T, handler: (e: Extract<WorkspaceEvent,{type:T}>) => void): () => void;
export const useAgentStatusStore: { statuses: Record<nodeId, AgentStatus>; upsert; markRead(nodeId) };
export const useAgentStatus = (nodeId: string) => AgentStatus | undefined;
export const useSessions = (workspaceId) => { sessions: SessionRow[]; refresh }; // GET /sessions + 事件增量
```

### 13.5 布局与快捷键（归属 shell）

`App.tsx` 渲染顺序：`TabBar` → `CanvasWorkspace`（flex:1）→ 浮层 `SessionsSidebar`、`ControlsCluster`、`Dock`、`Banners`、`ExplorerDrawer`、`SourceControlDrawer`、`SettingsOverlay`、`CommandPalette`、`Toaster`。`useKeybindings` 在 App 挂一次，处理器把 panel 类命令映射到 `setPanel`，画布类命令通过 `canvas/commands.ts` 暴露的 `canvasCommands`（由 canvas 归属，签名 `Record<CommandId, () => void>` 的可变注册表 `registerCanvasCommand(id, fn)`）转发。

### 13.6 i18n

沿用 `i18n/<module>.ts` 的模块化 messages；每个 agent 只改自己模块文件；新增键必须同时有 `zh` 与 `en`。

## 14. 文案与组件硬性原则（2026-09-04 用户补充）

1. **界面只保留必要按钮**：不放说明性段落、提示文字、"预留/未实现"标签、统计信息条；空状态最多一行。每个按钮一个 lucide 图标，必要时配一个中文词；通过 Tooltip 提供说明，不在界面上写描述。
2. **文案统一中文**：不出现中英混排（如"Runtime 0.1.0 · 本地运行"）；品牌名与 CLI 名（Claude、Codex、Git）保留原文，其余全部中文；`en` 键值只在 i18n 文件里保留，界面默认不展示。
3. **组件一律用标准库**：按钮、菜单、弹层、抽屉、开关、选择、标签页、提示、命令面板、Toast 全部使用 `src/ui/` 下由 shadcn CLI 生成的组件（Radix 原语），禁止在业务目录里自造等价组件或写裸 `<button className=…>`；只允许在 `src/ui/` 内做少量组合（status-pill、color-picker、icon-button）。
4. **删除现有壳里的所有文字装饰**：顶栏的 Runtime 版本/保存态文字、状态栏、Inspector 的说明段、启动页底部说明、空画布提示卡、设置页每项下方的解释文字。

## 15. 终端后端：tmux 为主、直连为兜底（2026-09-04 定案）

### 15.1 选择树

```text
macOS / Linux
├─ 系统 tmux ≥ 3.2（tmux -V 探测）        → TmuxBackend（默认）
└─ 无 tmux 或设置强制 direct                → DirectPtyBackend（现有 portable-pty）
Windows
├─ 设置显式选择 "tmux (MSYS2)"               → TmuxBackend（默认关；MSYS pty 层与原生 CLI 兼容性差）
├─ 持久终端（Phase 4）                       → 独立守护进程 + ConPTY
└─ 其他                                      → DirectPtyBackend
```

设置项 `terminal.backend = auto | tmux | direct`，默认 `auto`。`GET /api/health` 与 `GET /api/terminals/backend` 报告实际生效的后端、tmux 版本与 socket 路径；设置页只显示一个下拉框。

### 15.2 会话模型（迁移 `0005_terminal_backend.sql`）

`terminal_sessions` 新增：

| 列                   | 含义                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `session_key`        | 稳定逻辑键 = 所属节点 ID；节点重建/回收后不变                          |
| `backend_kind`       | `direct` / `tmux`                                                      |
| `backend_ref`        | tmux 会话名 `armadra-<workspace前8位>-<session_key前8位>-<generation>` |
| `generation`         | 每次 create/recycle 递增；WS 帧与事件都带它，旧代次一律拒绝            |
| `attach_state`       | `detached` / `live` / `exited`                                         |
| `last_output_at`     | 回收策略与侧栏"多久没动"                                               |
| `termination_intent` | `none` / `process` / `session` / `recycle`                             |

Runtime 启动时用 `list-sessions` 与数据库对账：tmux 里活着 → `detached`（可 attach）；不在 → `exited`；tmux 里有但数据库没有的 `armadra-*` 会话 → 记为孤儿，进入回收。

### 15.3 tmux 隔离与配置

所有 tmux 命令统一前缀 `tmux -S <data_dir>/tmux.sock -f <data_dir>/tmux.conf`，与用户自己的 tmux server 和 `~/.tmux.conf` 完全隔离。`tmux.conf` 由 Runtime 生成并在版本变化时覆盖：

```text
set -g prefix None            # 不劫持 Ctrl+B，所有按键直达 CLI
set -g status off
set -g mouse on               # 滚轮进入 tmux 历史（copy-mode），CLI 开启鼠标追踪时自动透传
set -g history-limit 5000
set -g escape-time 0
set -g focus-events on
set -g allow-passthrough on   # OSC/APC 透传（剪贴板、图片等）
set -g set-clipboard on
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*:Tc"
set -g window-size latest     # 多个 client 时以最近活动的 client 尺寸为准
set -g exit-empty on
set -g exit-unattached off
set -g remain-on-exit off
set -g detach-on-destroy on
```

### 15.4 后端 trait 与 tmux 映射

```rust
#[async_trait]
pub trait TerminalBackend: Send + Sync {
    fn kind(&self) -> BackendKind;
    async fn create(&self, spec: TerminalSpec) -> Result<TerminalHandle>;      // 新会话 + generation
    async fn attach(&self, key: &SessionKey, generation: u64, size: PtySize) -> Result<AttachHandle>; // 输出流 + 输入 sink
    async fn write(&self, key: &SessionKey, bytes: &[u8]) -> Result<()>;
    async fn resize(&self, key: &SessionKey, size: PtySize) -> Result<()>;
    async fn capture(&self, key: &SessionKey, lines: u32, with_escapes: bool) -> Result<String>;
    async fn paste(&self, key: &SessionKey, text: &str, press_enter: bool) -> Result<()>;   // 括号粘贴
    async fn foreground(&self, key: &SessionKey) -> Result<ForegroundInfo>;  // pane_pid, pane_current_command, 子进程 argv
    async fn interrupt(&self, key: &SessionKey) -> Result<()>;               // Ctrl+C
    async fn terminate_process(&self, key: &SessionKey) -> Result<()>;      // kill 进程树
    async fn destroy(&self, key: &SessionKey) -> Result<()>;                // 连同持久会话
    async fn list_alive(&self) -> Result<Vec<BackendRef>>;
}
```

| 动作              | tmux 实现                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create            | `new-session -d -s <ref> -x <cols> -y <rows> -c <cwd> -e ARMADRA_NODE_ID=… -e ARMADRA_AGENT_ID=… -e ARMADRA_ENDPOINT_FILE=… [-e …] <shell>`；随后 attach  |
| attach            | 在 Runtime 持有的 `portable-pty`（rows×cols）里启动 `tmux … attach-session -t <ref>` client；client 重绘即得到当前屏幕；client 退出不影响 server          |
| write             | 写 client 的 PTY（按键经 tmux 到 pane）                                                                                                                   |
| resize            | resize client PTY；`window-size latest` 让 pane 跟随                                                                                                      |
| capture           | `capture-pane -p [-e] -J -t <ref> -S -<lines>`；无转义版供 Agent 读，带转义版供快照                                                                       |
| paste             | 写临时文件 → `load-buffer -b armadra-<nonce> <file>` → `paste-buffer -p -d -b armadra-<nonce> -t <ref>` → 需要时 `send-keys -t <ref> Enter`；正文先剥 ESC |
| foreground        | `display -p -t <ref> '#{pane_pid} #{pane_current_command}'` + 读子进程（`ps -o pid,args --ppid` / `/proc`）                                               |
| interrupt         | `send-keys -t <ref> C-c`                                                                                                                                  |
| terminate_process | 取 pane_pid 子树，SIGTERM → 2s → SIGKILL                                                                                                                  |
| destroy           | `kill-session -t <ref>`                                                                                                                                   |
| list_alive        | `list-sessions -F '#{session_name} #{session_attached} #{session_activity}'`                                                                              |

DirectPtyBackend 保持现有实现，`capture` 用最近 chunk 回放拼接，`paste` 直接写括号粘贴序列，`list_alive` 返回内存表。

### 15.5 WebSocket 协议（`/api/terminals/{id}/ws`）

服务端 → 客户端：

- `hello {sessionId, generation, backend, rows, cols, alive}`：连接即 attach，第一帧。
- `snapshot {data}`：仅 direct 后端发送（回放拼接）；tmux 后端由 client 重绘，不发。
- `output {data}`、`status {status, exitCode?}`、`warning {message}`（不变）。
- `stale {generation}`：客户端携带的 generation 已过期，客户端应清屏并按新的 hello 重建。

客户端 → 服务端：

- `input {data}`、`resize {cols, rows}`（不变）。
- `terminate {mode: "interrupt" | "process" | "session"}`：三级语义，替代原来的无参 terminate。
- 连接关闭 = detach，进程不动。

REST 新增：`GET /api/terminals/{id}/capture?lines=&escapes=`、`POST /api/terminals/{id}/paste {text, enter}`（Phase 3 前仅本地 UI 使用）、`POST /api/terminals/{id}/recycle`（同一 session_key 新 generation）、`GET /api/terminals/backend`。

### 15.6 回收与安全

- 每 10 分钟扫描：`detached` 超过 `terminal.detachedGraceMinutes`（默认 24h）且所属节点已删除或工作空间已关闭的会话 → `destroy`；每轮最多 8 个，kill 前再次确认未被 attach。
- 节点删除 → `destroy`；节点隐藏/画布切换 → 只 detach。
- 所有 attach/write/terminate 仍按现有 session owner + workspace 校验；tmux socket 与 conf 目录 0700。
- tmux 缺失或版本过低时启动页/设置页给一条通知条，自动回退 direct。

### 15.7 前端影响

`TerminalSurface` 只做四件事：连接时清屏并等 `hello`；收到 `snapshot`/`output` 写入 xterm；`resize` 去抖 80ms；重连或 `stale` 时清屏重建。折叠/离屏节点关闭 WS（detach），展开时重新 attach。终端头部右键增加"中断 / 结束进程 / 销毁会话 / 回收"四项，分别对应三级 terminate 与 recycle。

### 15.8 实施位置

本节并入 **Phase 2**，由 `runtime-terminal` agent 独立承担（core 的终端域：backend/direct/tmux/gc 各部分、迁移 0005、路由与 WS 改造）；协议已先落到共享类型层，Phase 1 的 nodes agent 按协议实现前端。验收：tmux 存在时重启后节点可重新 attach 且画面完整；`capture` 与 `paste` 在 claude 会话中可用；无 tmux 环境自动回退且行为与现在一致；旧 generation 的 WS 帧被拒绝。

## 16. 目标设计的行为细节（2026-09-04）

把 §3 的壳与 §4 的组件展开到可验收的粒度：以下每条都是实现时逐项对照的规格，之前只在 §3 里写了骨架。

**壳与画布**

- 标签栏：品牌 mark + 项目 tab（色点 + 名称 + 看板切换图标）+ `+`；macOS 红绿灯内嵌在同一条栏里。
- Sessions 浮卡默认 pin 在左上（标题 `Sessions <计数>`、工作空间 / 状态两个 tab、过滤框、项目头 + 会话行）。
- 右上工具簇：`⌘K` 搜索胶囊 + Explorer / 源码控制 / 设置 / 帮助，每个 34px 方钮。
- 左下：缩放 +/−、适应、相机锁；旁边是用量胶囊（形如 `67% 5h · 72% wk`，按 provider 分列）。
- 底部 Dock：`+`（强调色）、撤销、重做、相机后退/前进、保存、适应视图、`−  65%  +`。
- 终端节点：顶部 3px 节点色条；头部 = 折叠三角、色点、标题、右侧 刷新 / 搜索 / AI 命名 / 评论 / 最大化 / ×；头部下方一行 `+ Label` 标签入口；选中时四角 + 四边中点共 8 个 resize 把手。
- 看板视图（⌘⇧B）：列 `未分组` / `待办` / … / `+ 添加列`，每列底部 `+ 新建会话`，卡片即会话。

**命令面板（⌘K）分组**：新建（新建终端 / Claude Code / Codex / Gemini / OpenCode / 便签 / 打开文件… / 打开网页… / 新建浏览器 / 新建 worktree…）→ 已打开的终端（跳转到某节点，命中输出内容时标注来源）→ 历史对话（跨项目的转录索引：标题 + 项目名 + 相对时间，可恢复）→ 视图（聚焦节点）。**历史对话分组需要新建能力**：扫描各 provider 的转录目录建立标题索引（Phase 3 的协作域转录读取逻辑已经会读转录，可顺势加索引 + `resume` 启动行）。

**设置项（SettingsOverlay 的目标清单）**

- Agents：每个 Agent `默认 / 启用 / 禁用` 三态；"启动命令"允许为每个内置 Agent 填自定义包装命令（需以 `exec claude "$@"` 结尾，flags 会追加）。
- 账号：隔离的 Claude 登录（各自 config dir、凭据、转录），节点终身绑定账号；Codex 账号按机器分组。
- 自定义 Agent：自带 CLI 或包装内置 harness；env 支持 `${env:VAR}` / `${env:VAR:fallback}`。
- 模型网关：一个 OpenAI 兼容网关 URL + 凭据来源（环境变量名或本地保护存储）+ "发现模型"。
- 终端：终端主题（预览块 + 下拉）、字体（下拉 + 完整 CSS 栈 + 浏览已安装字体）、字号 13、粗体、行高/字距、光标形状（Block/Bar/Underline）+ 闪烁、未聚焦时光标样式（Outline）。
- Shell：默认 shell（空 = 系统默认）。
- tmux：持久会话开关、Scrollback lines 50000、Keep lead pane wide（agent teams 70/30 分栏保护）、离屏终端释放（分钟，0 = 从不；离屏后释放视图但 tmux 继续跑）。
- 行为：默认视图 Canvas/Kanban、Grid size 24、默认节点尺寸 960×600、Snap to grid、Snap to grid mode、Pan-hover delay 600ms、双击聚焦、Markdown 预览、侧栏默认折叠、侧栏分组方式 工作空间/状态。
- 通知：后台完成通知开关、提示音（音量滑杆 + Finished / Needs you 试听）、手机推送（Needs you / Task completed / Live Activities / 在电脑前时暂缓）。

**并入 Phase 3/4 的条目**

1. 对话索引与 `resume`：Runtime 扫描转录目录建索引（标题 = 首条用户消息，200 KB/会话上限），命令面板新增"历史对话"分组，选中后以 `--resume <id>` 启动新终端节点。
2. 设置页补齐：Agent 三态与自定义启动命令、终端字体/字号/光标、tmux 滚屏行数与离屏释放分钟数、行为项（网格、默认尺寸、吸附、双击聚焦）、通知音量与试听。
3. 终端头部补 "AI 命名"（用转录首条消息生成标题）与 "评论"（便签式批注，入库为节点 `note` 字段）；`+ Label` 对应看板标签。
4. 左下用量胶囊：读取各 provider 的本地用量文件（Claude `~/.claude` 的 usage/statsig 缓存等）属于较后的 usage 能力，先只做 Claude 的 5h/周窗口。

## 17. Phase 4 范围（2026-09-04 启动）

| 项                | 归属              | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 对话索引与 resume | runtime-index     | 扫描 claude `~/.claude/projects/**/*.jsonl`、codex `CODEX_HOME/sessions/**/rollout-*.jsonl`、gemini `~/.gemini/tmp/**/chats/*.json`；表 `conversations(provider, session_id, title, cwd, path, updated_at, bytes)`；启动全量 + 每 60s 增量（mtime）；`GET /api/conversations?q=&limit=`；shared `assembleLaunchCommand({resume: sessionId})`（claude `--resume <id>`、codex `resume <id>`、gemini `--resume <id>`，能力位 `resume`） |
| 看板数据          | runtime-index     | 迁移 0008：`boards.kanban_json {columns:[{id,title,color}], cards:{nodeId: {columnId, order}}}`；节点新增 `labels: string[]`、`note: string`（评论）；shared schema + 校验                                                                                                                                                                                                                                                           |
| AI 命名           | runtime-index     | `POST /api/agent-status/{nodeId}/suggest-title`：取转录首条用户消息前 40 字（去命令前缀、折叠空白）；无转录时用终端 capture 最后一条命令                                                                                                                                                                                                                                                                                             |
| 历史对话入口      | web-kanban        | 命令面板新增分组「历史对话」（provider 图标、标题、目录名、相对时间）；选中 → 新建 terminal 节点，`agent.initialCommand` 为 resume 启动行                                                                                                                                                                                                                                                                                            |
| 看板视图          | web-kanban        | ⌘⇧B 切换；`fixed top-[var(--tabbar-h)] inset-x-0 bottom-0 z-[var(--z-kanban)]`；列 288px 横向滚动；默认列「未分组 / 待办 / 进行中 / 完成」；卡片 = terminal/sticky 节点（标题、Agent chip、状态胶囊、Label chips）；拖拽换列（dnd 用 `@dnd-kit/core`）；列底 `+ 新建会话`（AddMenu）；`+ 添加列`；点击卡片 → 回画布并居中                                                                                                            |
| 头部补齐          | web-kanban        | 节点头部 ✦ AI 命名（调 suggest-title → 写 title）、评论（Popover 内 Textarea，写 `note`）、`+ Label` chip（Popover 输入，写 `labels`）                                                                                                                                                                                                                                                                                               |
| 代码分割          | desktop-packaging | CodeMirror 语言包、xterm addons、DiffNode/EditorNode/FilesNode、Settings/CommandPalette/Kanban/DeliveryLog 全部 `React.lazy` + `Suspense`；主 chunk < 700 kB                                                                                                                                                                                                                                                                         |
| Tauri             | desktop-packaging | `titleBarStyle: Overlay` + `hiddenTitle`（TabBar 已留 86px）、托盘（显示/隐藏窗口、退出）、`minimumSystemVersion 13.3`、updater 配置骨架（无密钥，默认关闭）、`prepare-sidecar` 含 armadra-hook 的 release 构建、DMG 打包实测                                                                                                                                                                                                        |
| Windows 守护进程  | desktop-packaging | 只写设计 `docs/design/windows-session-daemon.md`（协议、状态文件、ConPTY、generation、背压），不实现                                                                                                                                                                                                                                                                                                                                 |

暂缓：用量胶囊（需读取 Claude OAuth 凭据）、语音、SSH、远程 Runtime、GitHub。

## 18. 终端完整兼容性：分析与实现决定（2026-09-04）

### 18.1 用户反馈与根因

- "每个终端里多出的 Tab 会让页面一直跳动"：任何随 hover / 选中 / 状态而出现或消失的行（标签行、提示条、临时按钮）都会改变 xterm 容器高度 → ResizeObserver → `fit()` → 向 PTY 发 resize → tmux/CLI 整屏重绘 → 滚动条出现或消失 → 容器宽度再变 → 再 fit。这是一个反馈环。**决定**：终端节点从头部以下只有 xterm，头部固定 34px，任何 UI 状态都不改变 body 尺寸；标签只在看板卡片显示、在右键菜单编辑；AI 命名/评论进"更多"菜单。

### 18.2 布局稳定性（不跳动）

1. body：`position:relative; overflow:hidden`，xterm 容器 `absolute inset-0`，无 padding 变化；`.xterm-viewport` 隐藏原生滚动条（`scrollbar-width:none`），滚动能力由 tmux 历史提供，避免滚动条导致的宽度振荡。
2. `fit()` 只在 body 尺寸变化时触发，去抖 80ms，并用 `proposeDimensions()` 与当前 `cols/rows` 比较，**相同则不发 resize**；忽略亚像素变化（四舍五入到整数像素）。
3. 折叠时保持挂载（`display:none`），展开后只 fit 一次；离屏/隐藏时不 fit。
4. xterm 组件用 `React.memo`，节点选中/状态变化不重挂 xterm；body 加 `nodrag nowheel`，滚轮不冒泡到画布。
5. 渲染器：xterm 6 默认 DOM 渲染器，随画布 CSS 缩放文字保持清晰；WebGL 作为设置项（默认关），启用时监听 `onContextLoss` 自动回退；不用 canvas addon。

### 18.3 终端语义兼容矩阵

| 能力                       | 决定                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TERM / terminfo            | tmux 内 `default-terminal`：启动时 `infocmp tmux-256color` 探测，无则退回 `screen-256color`；`terminal-overrides ",*:Tc"` + `terminal-features ",xterm-256color:RGB"`；tmux client 侧 `TERM=xterm-256color`；直连后端 `TERM=xterm-256color`、`COLORTERM=truecolor`                                                                                                                                                         |
| 256 色 / 真彩              | xterm 原生；tmux 通过上表透传                                                                                                                                                                                                                                                                                                                                                                                              |
| Unicode / CJK / emoji 宽度 | `Unicode11Addon` 在 `open()` 前激活；`tmux -u`；`LANG/LC_CTYPE` UTF-8 兜底；字体栈 Latin 等宽在前、CJK 回退在后                                                                                                                                                                                                                                                                                                            |
| 中文输入法                 | 依赖 xterm 的 composition 处理；`ime.ts` 保证合成期间不发送半成品；测试 `compositionstart/update/end`                                                                                                                                                                                                                                                                                                                      |
| 键盘                       | `macOptionIsMeta` 设置项（默认关，避免 Option 组合字符失效）；⌘C 有选区时复制，否则不发送；⌘V 走 xterm paste（应用开启 2004 时自动括号粘贴）；`attachCustomKeyEventHandler` 放行注册表里 `allowInTerminal=false` 的全局快捷键，其余全部进终端（含 Ctrl+C/Z/D、方向键、F1–F12、Home/End、Shift+方向）                                                                                                                       |
| 鼠标                       | **tmux `mouse off` + `focus-events off`**（2026-09-04 修订，见 §18.5）：tmux 不再替客户端开鼠标/焦点上报，点击与拖拽完全归 xterm——单击只聚焦、**零字节进 PTY**，拖拽是 xterm 原生选区。CLI 自己请求鼠标追踪时（`vim` `set mouse=a`、`htop`）tmux 仍把请求转给客户端，xterm 照常发 SGR 1006，退出后自动关闭                                                                                                                 |
| 剪贴板                     | 选区由 xterm 自己持有：⌘C 有选区时 `navigator.clipboard.writeText`，失败回退隐藏 textarea + `execCommand('copy')`（WKWebView 里必须在手势内调用）；终端体上右键菜单「复制 / 粘贴」；`copyOnSelect` 设置项（默认关）。内层 CLI 的 OSC 52 由 `@xterm/addon-clipboard` 落地，透传链是 tmux `set-clipboard on` + **`set -as terminal-features ",xterm*:clipboard"`**——只有 `set-clipboard on` 时 tmux 不会把 OSC 52 转给客户端 |
| 备用屏 / 光标 / 铃声       | 原生；`bell` 事件 → 头部图标闪一次，不出声                                                                                                                                                                                                                                                                                                                                                                                 |
| 标题                       | OSC 0/2 → `onTitleChange` → 仅当用户未手动改名（`titleAuto` 标记）时更新节点标题                                                                                                                                                                                                                                                                                                                                           |
| 超链接                     | `WebLinksAddon` + 原生 OSC 8（`linkHandler` 走 `platform.openExternal`）                                                                                                                                                                                                                                                                                                                                                   |
| 括号粘贴                   | xterm 与 tmux 均原生；投递消息用 `paste-buffer -p`                                                                                                                                                                                                                                                                                                                                                                         |
| DA / 查询                  | xterm 自动应答 tmux 的 DA/DSR/OSC 查询                                                                                                                                                                                                                                                                                                                                                                                     |
| 多视图尺寸                 | tmux `window-size latest` + `aggressive-resize on`                                                                                                                                                                                                                                                                                                                                                                         |
| Windows 直连               | 后端上报 `platform:"windows"` 时设置 xterm `windowsPty {backend:"conpty"}`                                                                                                                                                                                                                                                                                                                                                 |
| 输出吞吐                   | Runtime 输出泵按 16ms 或 64 KiB 合批后发 WS；xterm `write` 串行                                                                                                                                                                                                                                                                                                                                                            |
| 设置项                     | 字体、字号（13）、行高（1.2）、字距（0）、光标形状/闪烁、Option 作 Meta、WebGL；改动后重新 fit 一次                                                                                                                                                                                                                                                                                                                        |
| 搜索                       | 搜索框放在头部 Popover，不改变 body 尺寸                                                                                                                                                                                                                                                                                                                                                                                   |

### 18.5 选择与点击的修订（2026-09-04 用户反馈：「终端不能复制，并且点击也会输入无用内容」）

**复现**（实测，改前）：终端里任意单击 → PTY 收到 `\e[<0;8;3M` + `\e[<0;8;3m`；拖拽 → 收到 `\e[<0;6;2M` / `\e[<32;26;2M`，且 `window.getSelection()` 为空、xterm 选区层 0 个矩形，所以 ⌘C 无内容可复制。

**根因**：`tmux.conf` 里的 `set -g mouse on` 会让 tmux **替客户端**打开 SGR 鼠标上报。xterm 一旦进入鼠标追踪模式就停止做原生文本选择（改为把每次按下转成转义序列发出去），于是「不能复制」；而这些字节对不消费它们的程序就是垃圾输入，于是「点击输入无用内容」。`focus-events on` 是同一类问题（`\e[I` / `\e[O`）。

**决定**（已实现）：

| 选项                 | 值                                 | 理由                                                                         |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `mouse`              | `off`                              | 选区还给 xterm；内层 app 自己要鼠标时 tmux 仍转发请求，`vim`/`htop` 不受影响 |
| `focus-events`       | `off`                              | 避免 `[I` / `[O` 漏进不消费它们的 pane                                       |
| `terminal-overrides` | 追加 `,*:smcup@:rmcup@`            | 客户端不进备用屏（实测原始字节流中 `\e[?1049h` 计数为 0）                    |
| `set-clipboard`      | `on`（保持）                       | 内层 OSC 52 的前半条链                                                       |
| `terminal-features`  | 追加 `set -as ",xterm*:clipboard"` | 后半条链；缺它 tmux 不会把 OSC 52 转给客户端                                 |
| `allow-passthrough`  | `on`（保持）                       | —                                                                            |

前端：⌘C 走 `navigator.clipboard.writeText`，失败回退隐藏 textarea + `execCommand('copy')`；终端体加右键 ContextMenu「复制 / 粘贴」（走 portal，不改 body 尺寸）；新增设置项「选中即复制」（默认关）；单击只 `focus()`，不写任何字节。

**滚屏怎么办**：`smcup@:rmcup@` 只保证客户端不进备用屏（原始字节流里 `\e[?1049h` 计数为 0），但 tmux 3.7b 仍然是用绝对光标寻址重绘、不发 IND/SU（`\eD` 与 `\e[S` 计数均为 0），所以 tmux 的历史**不会**落进 xterm 的 scrollback（实测 `seq 1 200` 与逐行慢输出后都是 `scrollHeight == clientHeight`）。而 `mouse off` 又断了滚轮进 copy-mode 的老路。因此滚屏改为**显式的滚轮桥**：

```text
wheel（终端体，passive:false）
  └─ 跳过：后端不是 tmux ／ xterm 报告 mouseTrackingMode !== 'none' ／ xterm 自己还有回滚内容
  └─ deltaY + deltaMode → 整行（120px = 1 档 = 3 行；deltaMode 1 = 行，2 = 一屏）
  └─ 小数零头攒在累加器里（触控板一次轻扫是几十个 deltaY:2，逐个取整会全变 0）
  └─ 30ms 节流合并 → POST /api/terminals/{id}/scroll { lines }（正 = 更早的输出）
        └─ tmux：#{pane_in_mode} 为 0 时先 `copy-mode -e`，再 `send-keys -X -N <n> scroll-up|scroll-down`
        └─ 滚完重新读 #{pane_in_mode} 回写 in_copy_mode（`-e` 会在回到底部时自己退出）
        └─ direct：no-op，xterm 自己有 5000 行 scrollback
```

`write()` 与 `paste()` 在动手之前先看 `in_copy_mode`，为真就 `send-keys -X cancel`：**打字永远优先于滚屏**，否则按键会被 copy-mode 当成命令吃掉。标志位缓存在会话里而不是每次按键去问 tmux——`write()` 是每个字符都要走的热路径。

向下滚且不在 copy-mode 时直接返回：进 copy-mode 只为了往下滚会立刻被 `-e` 弹出来。

**实测**（滚轮桥）：三档滚轮 → 三个 `{"lines":3}` 请求，画面从第 200 行退到第 171 行并显示 tmux 的 `[12/451]` 指示；copy-mode 里原生拖选仍然可用（选区层 2 个矩形，⌘C 拿到 `"171"`）；随后打字 → 自动退出 copy-mode，`after-scroll-marker` 正常回显；Claude Code 这类自己开了鼠标追踪的 TUI 上滚轮**不桥接**（0 个请求），滚轮按 app 自己的请求原生处理。

### 18.4 验收清单（在节点里逐项执行）

`vim` 备用屏 + 鼠标 · `htop` · `claude` TUI 框线对齐 · `ls --color` · `printf '\e[38;2;255;0;0mTC\e[0m'` 真彩 · `echo 你好🙂` 宽度与对齐 · 输入法合成输入中文 · `printf '\e]52;c;aGVsbG8=\a'` 后系统剪贴板为 `hello` · `printf '\e]0;hi\a'` 节点标题变 `hi` · 多行括号粘贴 · `vim` 打开时拖拽节点尺寸 · 画布 50% / 150% 缩放文字清晰 · `while :; do echo -n .; sleep 0.05; done` 运行 60s 节点尺寸零抖动 · `vim` 中刷新页面后画面完整重连 · Runtime 重启后自动重连。

## 19. 用量胶囊（2026-09-04 用户确认）

| 项     | 决定                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- | ---- | --------- | ---------------------------------------------------------- |
| 位置   | 右下角、MiniMap 上方 14px 的浮动胶囊（`z-[var(--z-pills)]`）；无任何 provider 凭据时整体不渲染                                                                                                                                                                                                                                                                                                                                                     |
| 数据   | core 的用量域：Claude 读 macOS 钥匙串 `Claude Code-credentials`（`security find-generic-password -s ... -w`）或 `~/.claude/.credentials.json` 的 OAuth access token → 官方 OAuth usage 接口（5h / 7d 窗口利用率、重置时间）；Codex 读 `~/.codex/auth.json` 的 access token + account id → ChatGPT 后端用量接口（主/次窗口 `used_percent`、`reset_at`）。接口形状以本机 CLI 实际请求为准（抓包/源码核对），字段不符时该 provider 返回 `unavailable` |
| 安全   | token 只在 Runtime 内存中使用，绝不写日志、不进 SQLite、不发给前端；`GET /api/usage` 只返回百分比与时间；仅 loopback                                                                                                                                                                                                                                                                                                                               |
| 刷新   | 启动后 10s 首查，之后每 5 分钟；`POST /api/usage/refresh`；401/网络错误 → 该 provider `status:"error"` 并带 `reason` 代码（`expired_credentials` / `unauthorized` / `forbidden` / `rate_limited` / `network` / `parse` / `no_windows` / `unreadable_credentials` / `provider_error`，2026-09-15 补），胶囊显示灰色横线，卡片按代码给一句可操作的说明；上游文本只进日志                                                                             |
| UI     | `Claude 5h 67% · 7d 72% │ Codex 5h 9%`：provider 名 + 迷你进度条（≥80% 警告色，≥95% 危险色）+ 百分比；点击 Popover：每个窗口一行（名称、进度、重置倒计时）、刷新按钮；设置 → 界面「显示用量」开关（默认开）                                                                                                                                                                                                                                        |
| shared | `usageSchema {providers: [{id, status:"ok"                                                                                                                                                                                                                                                                                                                                                                                                         | "unavailable" | "error", windows:[{key:"5h" | "7d" | "primary" | "secondary", label, usedPercent, resetsAt}], fetchedAt}]}` |

## 20. 用户反馈第二轮（2026-09-04）：比例、左侧栏、首页

| 项         | 决定                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 打开比例   | 首次打开看板不再 fitView 缩放；视口 zoom 固定 1（100%），只平移到节点包围盒左上角（留 40px 边距）；已有持久化视口且 zoom ≠ 1 的旧看板保持原样。Dock 缩放菜单保留 50/100/150/适应。浏览器节点默认 1280×800、编辑器 960×640，均按 100% 设计                                                                                                                             |
| 左侧栏     | 固定 docked 侧栏（宽 260px，`--sidebar-w`），位于 TabBar 之下、画布左侧，画布 flex-1；⌘⇧L 折叠/展开（折叠为 0 宽，画布自动填满，终端 fit 一次）；上半「看板」：列表行（名称、节点数）、新建/重命名（双击）/删除（确认），当前看板高亮；下半「会话」：沿用 SessionsSidebar 的分组/过滤/信号徽标/历史，去掉浮动卡片、peek 与 pin 逻辑；左上角的会话图标改为侧栏折叠按钮 |
| 首页       | 居中布局：顶部品牌 mark；三张大圆角（`rounded-2xl`）操作卡：新建文件夹 / 打开文件夹 / 克隆仓库；下方「最近」列表为圆角卡片（名称、路径、时间、颜色点，hover 抬起）；无说明文字；设置入口右上角                                                                                                                                                                        |
| 新建文件夹 | 对话框：父目录（Tauri 选目录）+ 名称 → `POST /api/workspaces` 新增 `createDirectory:true`（Runtime `mkdir`，已存在则 409）                                                                                                                                                                                                                                            |
| 克隆仓库   | 对话框：仓库 URL（https/ssh/git@）、父目录、可选目录名 → `POST /api/git/clone {url, parent, name?}`；Runtime 用系统 `git clone --progress`，进度行通过工作空间事件 `git.clone {jobId, line                                                                                                                                                                            | done | error}`推送，前端对话框内显示进度条/最近一行；完成后自动创建工作空间并打开；URL 只允许`https://`、`ssh://`、`git@host:path`；目标目录不得已存在 |

## 21. 用户反馈第三轮（2026-09-04）：缩放、任意互连、画图、SSH

| 项       | 决定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缩放手势 | 触控板捏合 → 缩放；⌘/Ctrl + 滚轮 → 以光标为中心缩放；普通滚轮 → 平移（Shift 横向）；空格 + 拖拽 → 平移；⌘0 = 100%、⌘1 = 适应（maxZoom 1）、⌘= / ⌘- 步进 ×1.2；范围 0.1–3；缩放动画 120ms；Dock 显示当前百分比                                                                                                                                                                                                                                                                                                 |
| 任意互连 | 所有节点类型都有左 `link-in` / 右 `link-out` 把手（group 除外）；`isValidConnection` 只禁止自连与重复；`addEdge` 不再强制便签为源；渲染：源或目标之一为 terminal 且另一方为内容节点 → 单向箭头指向 terminal（内容 → Agent）；terminal↔terminal → 双向；内容↔内容 → 无箭头细线（仅分组语义）。标签按源类型：便签 / 图片 / 画图 / 文件 / 目录 / 网页 / 差异 / 上下文                                                                                                                                          |
| 内容可读 | core 的协作域上下文链接逻辑扩展来源：`editor` → 文件内容（≤ 200 KB，超出截断并说明）；`files` → 目录列表（≤ 500 项）；`image` → 若有 `sourcePath` 给路径，否则把 data URL 落盘到 `<workspace>/.armadra/images/<nodeId>.png` 并给路径；`draw` → 导出 PNG 到 `<workspace>/.armadra/drawings/<nodeId>.png` 并给路径；`browser` → URL；`diff` → 当前 diff 文本（≤ 200 KB）；`list` 动词返回每个链接节点的类型与可读方式；SKILL.md 同步说明                                                                        |
| 画图节点 | 新类型 `draw`（默认 480×360，最小 240×180）：白板底（浅色 `#fffdf7` / 深色 `--surface-deep`），工具条 4 钮（笔 / 橡皮 / 颜色 7 色 / 撤销）放在节点头部右侧（不改 body 高度）；笔迹 `{points:[x,y,p?][], color, width}` 存于 `data.strokes`（上限 500 笔 / 20000 点，世界坐标为节点内像素）；渲染用 `<canvas>`，指针事件用 `nodrag`；`POST /api/workspaces/{id}/nodes/{nodeId}/export-png` 由前端把 canvas `toDataURL` 上传，Runtime 落盘到 `.armadra/drawings/` 供 Agent 读取；迁移 0009 无需（data 是 JSON） |
| SSH      | 设置 → 新分组「SSH」：主机列表（名称、host、user、port、identity 文件路径、额外参数），存 `settings.json` `ssh.hosts[]`（Runtime `GET/PATCH /api/settings` 已支持）；添加菜单 / 命令面板出现「SSH 终端 → <主机>」；创建 terminal 节点 `data.ssh = {hostId}`，Runtime 创建会话时命令为 `ssh -t -o ServerAliveInterval=30 [-p port] [-i identity] user@host`（在本地 tmux 内运行，断线后节点显示已退出，可重新运行）；节点头部显示 `⇅ host` chip；不做远端文件与远端 hook（后续）                               |

## 22. 用户反馈第四轮（2026-09-04）：去掉顶栏，左侧管理工作空间 → 看板 → Agent

| 项                 | 决定                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶栏               | 删除 TabBar。macOS 红绿灯所在的 44px 拖拽区放在左侧栏顶部（`-webkit-app-region: drag`，内含品牌 mark；折叠时保留一条 44px 拖拽条）                                                                                                                                                                                                                               |
| 第一栏「工作空间」 | 树形列表：每个已打开的工作空间一行（颜色点、名称、chevron、未读数 Badge、`⋯`：新建看板 / 重命名 / 关闭），展开后缩进显示其看板（名称、节点数；当前看板高亮；双击重命名；`⋯` 删除）；点击看板 = 切换工作空间 + 看板；行尾 `+` = 新建看板；栏头 `+` DropdownMenu：打开文件夹 / 新建文件夹 / 克隆仓库（复用首页对话框）；最近未打开的工作空间不在树里（回首页打开） |
| 第二栏「Agent」    | 当前工作空间的会话按状态分组（需要你 / 运行中 / 未读 / 空闲 / 历史），行内保留 Agent chip、状态标记、× 结束、点击居中；顶部过滤框；不再有"工作空间/状态"两个 tab（工作空间维度已由第一栏承担）                                                                                                                                                                   |
| 迁移的入口         | 看板视图切换（⌘⇧B）→ 右上工具簇；投递记录 → 工作空间行 `⋯` 菜单；打开工作空间 → 栏头 `+`                                                                                                                                                                                                                                                                         |
| 尺寸               | 侧栏 260px，可折叠；第一栏最多占 45% 高度并可滚动，第二栏占剩余                                                                                                                                                                                                                                                                                                  |

### 19.1 修订（2026-09-04）：用量显示改为球形

- 右下角（MiniMap 上方）一个 36px 圆球：外圈为 conic-gradient 环形进度（取各 provider 当前窗口的最高占用），环色 `--brand` / ≥80% `--warn` / ≥95% `--danger`；球心显示最高占用的百分比数字（10px），无文字标签。
- 鼠标悬停（`HoverCard`，`openDelay 120ms`）向左上展开面板：每个 provider 一组（名称 + 各窗口行：标签、进度条、百分比、重置倒计时），底部一个刷新 IconButton；移开即收起；键盘聚焦球体也可展开。
- 无任何 provider 凭据时不渲染；设置「显示用量」开关不变。

## 23. 用户反馈第五轮（2026-09-04）：设置页重写、整理布局

| 项       | 决定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置页   | 全屏层内两栏：左 220px 固定导航（分组标题 + 分区项，顶部搜索框按分区名/设置项名过滤），右侧 `overflow-y:auto` 独立滚动内容列（`max-w-[880px]`），每个分区是一张 `rounded-2xl` 卡片，`id` 锚点；点击导航 → `scrollIntoView({behavior:"smooth", block:"start"})`；右侧滚动用 IntersectionObserver 做 scroll-spy 更新导航高亮；URL hash/内存记住上次分区；分区顺序：Agent、账号与 Hook、SSH、终端、工作区（后端、看板、消息）、界面（主题、语言、通知、用量、侧栏）、快捷键、应用（版本、更新）；每行只有标签 + 控件，无说明文字 |
| 整理布局 | `tidy(nodes, edges, viewport)`：1) 按连通分量分组，分量内按拓扑深度排列成"行内从左到右、深度递增"；2) 目标区域宽高比 = 当前视口宽高比；行宽上限 = `sqrt(总面积 × 宽高比) × 1.15`，节点按分量依次放入当前行，放不下则换行（行高 = 行内最高节点），行间距 48、列间距 60；3) 分组框整体作为一个节点参与，成员随之平移；4) 完成后 `fitView({padding:0.08, maxZoom:1, duration:200})` 容纳全部                                                                                                                                     |

## 24. 设置页按 ChatGPT 模式重做 + 全局视觉按 Apple HIG 重做（2026-09-04）

### 24.1 ChatGPT 设置页分析（桌面端 / 网页端，2025–2026 版）

**结构**：一个居中模态窗口（约 760×560，`rounded-2xl`，深浅色随系统），左侧 200px 导航列表（每项 = 16px 线性图标 + 标签，选中项浅灰底圆角 8px），右侧是**当前分区独立的一页**（切换时整页替换，不跨分区滚动；页内超高才滚动）。顶部只有分区标题（17px semibold），无搜索框。每页由若干"行"组成：行 = 左标签（13px）+ 右控件（Switch / Select / Button），行高 44px，行间 1px 分隔线，少数行下有一行 11px 灰色脚注（仅在必须解释后果时）。危险操作（删除账号、退出所有设备）用红色文字按钮放在页尾。

**分区与配置项**（对照我们的映射）：

| ChatGPT 分区                       | 主要配置                                                                                          | 我们的分区         | 我们的配置项                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| General                            | 主题（系统/深/浅）、强调色、语言、口语语言、语音、显示后续建议、代码块始终显示、归档/删除全部对话 | **通用**           | 主题、语言、侧栏默认展开、显示用量、打开时恢复上次工作空间                                                             |
| Notifications                      | 回复通知、任务通知（推送/邮件）                                                                   | **通知**           | 后台完成通知、需要你时通知、提示音 + 音量、试听                                                                        |
| Personalization                    | 自定义指令（进入编辑页）、记忆开关 + 管理、模型建议                                               | **Agent**          | 每个 Agent 启用/默认（Default/Enabled/Disabled 三态）、默认权限模式、自定义启动命令、自定义 Agent 列表（进入子页编辑） |
| Apps & connectors / Connected apps | 已连接的第三方应用列表 + 连接/断开按钮                                                            | **Hook 与 Skills** | 每个 CLI 的 hook 安装状态 + 安装/重装/卸载、Skill 安装状态、hook 直答开关                                              |
| Data controls                      | 改进模型开关、共享链接管理、导出数据、删除账号                                                    | **数据**           | 数据目录路径 + 在访达中打开、备份数据库、清理历史会话/对话索引重建、`.armadra` 日志保留天数                            |
| Security                           | 多因素、退出所有设备                                                                              | **SSH**            | 主机列表（子页编辑）、测试连接                                                                                         |
| Subscription / Account             | 套餐、账单                                                                                        | **账号与用量**     | Claude/Codex 用量窗口、凭据来源（钥匙串/文件）、刷新                                                                   |
| About                              | 版本、更新、条款                                                                                  | **关于**           | 版本、检查更新（占位禁用）、开源许可                                                                                   |
| —                                  | —                                                                                                 | **终端**           | 后端（自动/tmux/直连）、断开保留、字体、字号、行高、光标、闪烁、Option 作 Meta、WebGL、选中即复制                      |
| —                                  | —                                                                                                 | **快捷键**         | 命令表（分组、可重绑定：点击键位 → 录制新组合，冲突提示）                                                              |
| —                                  | —                                                                                                 | **工作区**         | 当前工作空间：Agent 互发消息开关、看板列、默认 Agent 覆盖                                                              |

**实现方式**：`SettingsDialog`（`Dialog` 居中，`w-[820px] h-[600px] max-w-[92vw] max-h-[88vh]`）；左栏 `nav` 200px：分组标题（11px uppercase muted）+ 项（`Button variant=ghost` 高 32、圆角 8、选中 `bg-[var(--surface-raised)]`）；右栏 `main`：标题栏 56px（标题 + 可选右侧动作）+ 页体 `overflow-y-auto px-8 py-4`；页体内容 = 若干 `SettingsGroup`（`rounded-xl border bg-[var(--card)]`，内含 `SettingsRow`，行间 `divide-y`）；子页（自定义 Agent 编辑、SSH 主机编辑）在同一右栏内推入（`←` 返回，标题变为子页名），不用叠对话框。路由状态 `settings.section` / `settings.subpage` 存 store；⌘, 打开上次分区；Esc 关闭。移除 scroll-spy 与搜索。

### 24.2 Apple 页面设计原则（HIG）→ 我们的 token 与规则

| 原则                               | 落地                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **层级用材质与灰度表达，不用线框** | 三级表面：窗口底 `--bg`、侧栏/面板 `--panel`（比底浅 4%）、卡片/分组 `--card`（再浅 3%）；边框只用 1px `rgba(tint, .08)`，浮层加 `shadow-lg` 一处即可                                                                                                                              |
| **8pt 网格**                       | 所有间距取 4/8/12/16/24/32；行高 44（设置行）/ 32（列表行）/ 28（工具栏钮）；圆角：控件 6、卡片 10、面板 12、对话框 14、球 9999                                                                                                                                                    |
| **字体层级（SF Pro）**             | 标题 17 semibold、分区标题 15 semibold、正文 13 regular、辅助 11 regular；数字用 tabular-nums；不再出现 9.5px/10px 文字（状态胶囊改 11px medium、字距 0.02em）                                                                                                                     |
| **系统强调色**                     | 强调色 `#0A84FF`（浅色 `#007AFF`）只用于选中态、主要按钮、进度；其余按钮为 `secondary`（灰底）或 `ghost`                                                                                                                                                                           |
| **源列表侧栏**                     | 侧栏用半透明材质：`bg-[color-mix(in srgb, var(--panel) 85%, transparent)] backdrop-blur-xl`（Tauri 窗口设为透明背景 + `window-vibrancy` sidebar 材质，网页回退纯色）；分组标题 11px uppercase muted、项高 28、圆角 6、选中项 `bg-[var(--accent)]/15`；图标 16px 线性、与文字间距 8 |
| **分组表单**                       | 设置与对话框统一用"标签左 / 控件右"的分组卡片，卡片内行 1px 分隔，卡片外无边框重叠                                                                                                                                                                                                 |
| **克制的图标与文字**               | 工具簇按钮 28×28、图标 16px、`stroke 1.5`；Tooltip 延迟 500ms；图标按钮没有文字，文字按钮没有图标（主要操作除外）                                                                                                                                                                  |
| **一致的窗口 chrome**              | 红绿灯区 44px 与侧栏同材质；无顶栏；画布纯黑/暖白                                                                                                                                                                                                                                  |
| **动效**                           | 只用 opacity/transform，120–180ms `ease-out`；页面切换淡入 120ms；无弹跳                                                                                                                                                                                                           |
| **深浅色对等**                     | 每个组件在两套主题下都用同一套语义 token，浅色下阴影减半、边框加深到 `.10`                                                                                                                                                                                                         |

### 24.3 页面逐一设计

1. **首页（Launcher）**：整窗口 `--bg`；顶部 44px 拖拽区；内容居中列 `max-w-[720px]`：品牌 mark 40px + 应用名 17 semibold（品牌名允许）；三张操作卡 `h-[96px] rounded-[12px] bg-[var(--card)] hover:bg-[var(--surface-raised)]`，图标 20px + 标签 13 medium；「最近」11px uppercase 标题 + 列表行（不是网格）：行高 56、左颜色点 8px、名称 13 medium、路径 11 muted、右侧相对时间 11 + `⋯`；行 hover `bg-[var(--surface-raised)]` 圆角 8；右上角设置 IconButton 28px。
2. **主界面**：侧栏 240px 源列表材质（见 24.2）；工作空间行 28px、看板行缩进 24px；Agent 分组标题 11px uppercase；会话行 40px（两行文本 13/11）；右上工具簇 28px 钮、间距 8，背景 `--panel` 圆角 10 一整条（不是分散圆钮）；Dock 高 44、圆角 12、`--panel` 90% + blur、按钮 32；MiniMap 圆角 10 边框 1px；用量球不变。
3. **节点**：头部 32px、`bg-[var(--card)]`、底部 1px 分隔（去掉更深的 header 底色）；3px 顶色条改为左上角 8px 色点 + 1px 顶色描边（更克制；用户可在设置中选择"色条"风格）；圆角 10；阴影 `0 1px 2px rgba(0,0,0,.2), 0 8px 24px rgba(0,0,0,.18)`（浅色减半）；状态胶囊 11px medium 圆角 6 无字距全大写（改为首字母大写 / 中文）；把手 10px；选中 = 1.5px 强调色描边。
4. **设置**：见 24.1。
5. **对话框**：统一 `max-w-[480px] rounded-[14px]`，标题 15 semibold、正文行 13、按钮区右对齐（取消 secondary + 主按钮 accent），危险操作 `destructive`。
6. **看板视图**：列 288 → 300px、列头 13 semibold + 计数 11、卡片 `rounded-[10px] bg-[var(--card)]` 间距 8、拖拽时 `shadow-lg` + 轻微缩放 1.02。
7. **命令面板**：`max-w-[600px]`，输入 15、行高 36、分组标题 11 uppercase。

验收：浅/深色下逐页截图对比；无 <11px 文字；间距均为 4 的倍数；所有控件来自 `src/ui`；无说明性段落。

## 25. 终端子进程环境与 Agent 启动路径（2026-09-04 晚，用户反馈「新建都是问题」）

1. **启动行用探测到的绝对路径**。`GET /api/agents.resolvedPath` 是 Runtime 在增强 PATH 上验证过的那一份；终端里的 shell 自有一套 PATH 顺序（`path_helper`、rc 文件），裸命令名可能解析到另一份（本机：Homebrew 下签名被吊销的旧 codex）。设置里的自定义启动命令仍然优先。
2. **终端环境是构造的，不是继承的**（`child_environment()`）。Runtime 自己的环境来自启动者——Finder 几乎为空，编辑器 / 另一个 Agent 的终端则带着那个会话的变量——而 tmux 服务器会把启动者的环境保留到它退出为止。白名单：`HOME USER LOGNAME SHELL TMPDIR SSH_AUTH_SOCK LANG LC_* XDG_* DISPLAY`、`*_PROXY`；再加 `PATH=agent_path()`、`TERM=xterm-256color`、`COLORTERM=truecolor`、UTF-8 locale。交互式 shell 从 rc 文件重建其余部分。
3. **tmux 服务器归属**。`@armadra-runtime` 服务器选项 = `<exe>@<version>`，首个 `new-session` 后盖章；启动对账时发现是别的 runtime 的服务器：空则 `kill-server`（下一次 `new-session` 重建），有会话则保留并 warn——会话是用户的。
4. **Runtime 进程 PATH**：`main()` 第一件事就是 `set_var("PATH", agent_path())`，`tmux` / `ps` / `infocmp` / 探测都走同一条 PATH。
5. **Codex `hooks.json`**：只允许 `description` / `hooks` 两个顶层键，其余丢弃（Codex `deny_unknown_fields`）。
6. **看板视图已移除**（用户决定）。§17 里的看板视图、⌘⇧B、工作区设置「看板列」不再存在；标签 / 评论 / AI 命名与「历史对话」保留在 `apps/web/src/meta/`。`board.kanban` 仍在 schema 与数据库里，只是没有 UI 写它。
