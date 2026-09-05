# ChatGPT 完整会话：AI Coding OS 设计

- 原始会话：https://chatgpt.com/c/6a10197d-92f0-83ea-b45e-c4a6684d5424
- 导出日期：2026-08-13
- 消息数量：16

> 本文件从会话顶部遍历至底部导出，包含用户提问、ChatGPT 过程消息、正式回复、标题、代码块和来源链接。

---

## 消息 1 · 用户

https://github.com/basketikun/infinite-canvas 可否设计一个类似的项目 构建的 app 支持 claude code  codex 等等cli 可以直接调用用户的本地终端 拉一个画框 在页面中 然后页面中可以打开浏览器 贴图 文字 标注 等等无界属性 并且支持多端数据同步 

推荐什么语言框架

---

## 消息 2 · ChatGPT

我先按“类 infinite-canvas + 本地 CLI 控制平面 + 多端同步”的方向拆架构，再结合现有项目技术栈看哪些框架更合适。

---

## 消息 3 · ChatGPT

可以做，而且方向很有价值：**把无限画布从“AI 生图工作台”扩展成“本地 AI Coding 控制台 / 多 Agent 编排白板”**。

`basketikun/infinite-canvas` 当前本身就是面向图片创作的开源无限画布工作台，已有画布编排、AI 生图、参考图编辑、对话助手、提示词库、素材管理等能力；它当前技术栈是 **Next.js / React / TypeScript / Tailwind / Ant Design / Zustand / TanStack Query + Go / Gin / GORM + Docker**。不过它也明确说还处于开发阶段，不保证历史数据兼容，更适合个人/本地部署。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/basketikun/infinite-canvas)

你想做的不是简单 fork，而是一个更偏 **AI Coding OS / Agent Canvas** 的产品。

## 推荐结论

我建议首选：

```
桌面端：Tauri 2 + React / Next.js + TypeScript
画布：tldraw SDK 起步，后期可替换自研 Canvas/WebGL/WebGPU 渲染
终端：Rust PTY 后端 + xterm.js 前端
后端：Rust 本地 Core + 可选 Go/Node 云端同步服务
同步：Yjs / tldraw sync + Postgres / SQLite / S3
浏览器：内嵌 WebView + 可选 Playwright/Chrome DevTools Protocol 控制
```

如果目标是快速做 MVP，直接用：

```
Tauri 2 + React + tldraw + xterm.js + SQLite + Yjs
```

这是最稳的组合。

---

## 为什么不是直接照搬 infinite-canvas 的技术栈？

`basketikun/infinite-canvas` 的 **Next.js + Go** 很适合 Web 工作台和 AI 生图后台，但你的需求多了几个本地能力：

1. 直接拉起用户本地终端；
2. 调用 Claude Code、Codex、Gemini CLI、OpenCode 等 CLI；
3. 读写本地项目目录；
4. 嵌入浏览器；
5. 多端同步；
6. 画布上展示终端、浏览器、图片、文字、标注、Agent 执行轨迹。

这些能力如果纯 Web 做，会受浏览器沙箱限制。桌面壳是必须的。Tauri 2 官方定位就是用 Web 前端构建跨桌面和移动端应用，同时用 Rust/Swift/Kotlin 做本地系统能力；Tauri 2 支持 Windows、macOS、Linux、Android、iOS。[![图片](https://www.google.com/s2/favicons?domain=https://v2.tauri.app&sz=128)Tauri+1](https://v2.tauri.app/start/?utm_source=chatgpt.com)

所以：**Web UI 可以继续用 React/Next，但本地控制层最好用 Tauri/Rust。**

---

## 项目形态建议

可以设计成：

```
AI Canvas Desktop
= 无限画布
+ 本地终端
+ Agent Session
+ 浏览器视图
+ 文件上下文
+ 多端同步
+ 任务编排
```

核心不是“白板”，而是“把 AI 编码过程可视化”。

### 页面上的节点类型

画布上每一个框都可以是一个 Node：

节点类型用途Terminal Node跑 Claude Code、Codex、npm、mvn、git、pytestBrowser Node打开本地服务、文档、GitHub、接口页面Text Node需求、Prompt、设计说明、TODOImage Node截图、错误图、UI 参考图File Node绑定本地文件、目录、diffAgent Node一个 Claude Code / Codex / Gemini CLI 会话Task Node可执行任务，例如“修复登录失败”“生成接口文档”Log Node保存命令输出、模型输出、执行历史Annotation Node标注、箭头、评论、局部说明

这比普通无限画布更有价值，因为它能沉淀 **AI 编程过程资产**。

---

## 推荐架构

```
┌──────────────────────────────────────────────┐
│                Canvas UI Layer                │
│ React / TypeScript / tldraw / Tailwind         │
│ - 无限画布                                    │
│ - 节点系统                                    │
│ - 标注 / 连线 / 贴图 / 文本                    │
│ - 多 Agent 会话视图                            │
└──────────────────────────────────────────────┘
                    │
                    │ Tauri IPC / WebSocket
                    ▼
┌──────────────────────────────────────────────┐
│              Local Core Runtime               │
│ Rust / Tauri                                  │
│ - PTY 管理                                    │
│ - 本地命令执行                                │
│ - 文件系统访问                                │
│ - Agent CLI 适配器                            │
│ - Browser/CDP 控制                            │
│ - 权限沙箱                                    │
└──────────────────────────────────────────────┘
                    │
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
 Claude Code     Codex CLI     Gemini/OpenCode
  Terminal        Terminal        Terminal

                    │
                    ▼
┌──────────────────────────────────────────────┐
│              Sync / Storage Layer             │
│ SQLite local-first + Yjs/tldraw sync           │
│ Postgres / Supabase / Cloudflare Durable Obj   │
│ Object Storage for images/files                │
└──────────────────────────────────────────────┘
```

---

## 语言和框架推荐

### 1. 桌面端：Tauri 2 优先

推荐：**Rust + Tauri 2**

原因很直接：

- 本地终端、PTY、文件系统、进程管理，Rust 更适合；
- Tauri 比 Electron 更轻；
- 支持跨平台桌面，Tauri 2 还支持移动端；
- 前端仍然可以用 React/Next/Vite，不牺牲 UI 生态。[![图片](https://www.google.com/s2/favicons?domain=https://v2.tauri.app&sz=128)Tauri+1](https://v2.tauri.app/start/?utm_source=chatgpt.com)

不建议一开始用 Electron，除非你非常依赖完整 Chromium 能力。Electron 的优势是内嵌浏览器和 Node 生态更直接，但长期体积、安全和权限边界会更麻烦。

我的建议：

```
MVP：Tauri 2 + Vite + React
不要一开始上 Next.js 桌面模式
```

Next.js 更适合 Web 端和服务端渲染，但桌面 App 里很多 SSR 能力用不上，反而增加复杂度。

---

### 2. 画布：tldraw 起步，不要一开始自研

推荐：**tldraw SDK**

tldraw 是 React infinite canvas SDK，官方定位就是构建白板和无限画布应用，并且提供默认 shapes、工具、撤销重做、复制粘贴、导航、协作等基础能力。它也支持自定义 shapes、tools、bindings 和 UI。[![图片](https://www.google.com/s2/favicons?domain=https://tldraw.dev&sz=128)tldraw+1](https://tldraw.dev/?utm_source=chatgpt.com)

你的项目最重要的是 Agent 编排，不是重新造画布引擎。

所以第一版不要自研 Canvas/WebGL。

推荐方式：

```
tldraw Custom Shape:
- TerminalShape
- BrowserShape
- AgentSessionShape
- FileDiffShape
- PromptShape
- ImageShape
```

后面如果遇到性能瓶颈，比如几万个节点、复杂连线、实时日志流，可以再考虑：

```
PixiJS / CanvasKit / WebGPU / 自研 tile renderer
```

但 MVP 阶段没必要。

---

### 3. 终端：xterm.js + Rust PTY

推荐：

```
前端：xterm.js
后端：portable-pty / tokio-pty-process / expectrl 等 Rust PTY 库
```

xterm.js 是浏览器里的终端组件，VS Code、Tabby、Hyper 等也使用类似方向；官方说明它可以把完整终端能力嵌入 Web 应用。[![图片](https://www.google.com/s2/favicons?domain=https://xtermjs.org&sz=128)Xterm.js+1](https://xtermjs.org/?utm_source=chatgpt.com)

架构：

```
Terminal Node
   ↓ 用户输入
xterm.js
   ↓ Tauri IPC
Rust PTY Manager
   ↓ spawn
claude / codex / gemini / bash / powershell / cmd
   ↑ stdout/stderr
xterm.js 渲染
```

每个画布终端框就是一个 PTY session。

需要支持：

```
- 新建终端
- 绑定工作目录
- 选择 shell：PowerShell / cmd / bash / zsh / fish
- 启动 CLI：claude / codex / gemini / opencode
- 保存 session 日志
- 从终端输出提取错误、文件路径、diff
- 将输出拖拽到画布成为 Log Node
```

---

### 4. CLI 适配器：不要强耦合某一个 Agent

你要支持 Claude Code、Codex 等 CLI，建议抽象成统一接口：

```typescript
interface AgentAdapter {
  id: string
  name: string
  detect(): Promise<boolean>
  start(projectPath: string, args: string[]): Promise<Session>
  send(sessionId: string, input: string): Promise<void>
  stop(sessionId: string): Promise<void>
  parseEvent?(chunk: string): AgentEvent[]
}
```

每个 CLI 是一个插件：

```
adapters/
  claude-code/
  codex/
  gemini-cli/
  opencode/
  custom-shell/
```

不要假设所有 Agent 都有 API。第一版就当它们都是“可交互终端程序”。

后期再做更强能力：

```
- 识别 diff
- 识别 tool call
- 识别文件修改
- 识别测试结果
- 识别 token usage
- 识别 approval prompt
- 自动截图浏览器状态
```

---

### 5. 浏览器节点：分两档做

这里要谨慎。你说“页面中可以打开浏览器”，有两种实现：

#### MVP 方案：WebView / iframe / 外部浏览器

适合：

```
- 打开 localhost:3000
- 打开文档页面
- 打开 GitHub
- 打开接口调试页面
```

但问题是：很多网站不允许 iframe，登录态、跨域、安全策略都会限制。

#### 进阶方案：内置 Browser Runtime + CDP

适合：

```
- 自动打开项目页面
- 截图
- 点击
- DOM 读取
- 自动测试
- 给 Agent 提供浏览器观察能力
```

可以设计：

```
Browser Node
   ↓
Local Browser Controller
   ↓
Chrome / Edge / Playwright / CDP
```

这个方向和 Claude Code / Codex 结合很强，因为可以让 Agent 看到：

```
- 当前页面截图
- console error
- network error
- DOM 片段
- 当前 URL
```

第一版不用做太重，先支持：

```
打开 URL + 截图 + console log 捕获
```

---

### 6. 多端同步：Local-first 优先

推荐：

```
本地：SQLite
协作/同步：Yjs 或 tldraw sync
云端：Postgres + Object Storage
```

Yjs 是 CRDT 协作库，官方定位就是构建多人协作应用；它提供共享 Map / Array 等数据结构，变更可以自动分发并合并，避免冲突。[![图片](https://www.google.com/s2/favicons?domain=https://yjs.dev&sz=128)Yjs+1](https://yjs.dev/?utm_source=chatgpt.com)

tldraw 也提供实时协作能力，可用 tldraw sync 或底层数据 API 接入自己的后端。[![图片](https://www.google.com/s2/favicons?domain=https://tldraw.dev&sz=128)tldraw](https://tldraw.dev/docs/collaboration?utm_source=chatgpt.com)

你的数据可以拆成三类：

```
1. 画布结构数据
   - nodes
   - edges
   - camera
   - comments
   - layout

2. 本地执行数据
   - terminal session
   - command logs
   - agent logs
   - workspace path
   - local file references

3. 大对象数据
   - 图片
   - 截图
   - 附件
   - diff patch
   - 录屏
```

同步策略：

```
画布结构：Yjs / tldraw sync
元数据：Postgres
本地缓存：SQLite
大文件：S3 / R2 / MinIO
敏感本地路径：只同步引用，不同步内容，除非用户授权
```

关键点：**终端日志和本地路径不要默认全量同步**，否则隐私和安全风险很大。

---

## 数据模型建议

可以这样设计：

```typescript
type CanvasNode =
  | TerminalNode
  | BrowserNode
  | AgentNode
  | TextNode
  | ImageNode
  | FileNode
  | DiffNode
  | TaskNode
  | AnnotationNode

interface BaseNode {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  zIndex: number
  createdAt: number
  updatedAt: number
}

interface TerminalNode extends BaseNode {
  type: 'terminal'
  sessionId: string
  cwd: string
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish'
  command?: string
}

interface AgentNode extends BaseNode {
  type: 'agent'
  adapter: 'claude-code' | 'codex' | 'gemini' | 'opencode'
  sessionId: string
  projectPath: string
  status: 'idle' | 'running' | 'waiting-approval' | 'failed' | 'done'
}

interface BrowserNode extends BaseNode {
  type: 'browser'
  url: string
  controller: 'webview' | 'external-cdp' | 'playwright'
}
```

---

## MVP 范围建议

不要第一版就做“多端 + 浏览器 + 全 Agent + 完整协作”。会炸。

建议分三期。

### Phase 1：本地 Armadra

目标：能跑起来，有核心爽点。

```
- Tauri 桌面 App
- tldraw 无限画布
- 文本 / 图片 / 标注 / 连线
- Terminal Node
- 支持本地 shell
- 支持 claude、codex 命令启动
- 保存画布到 SQLite
- 保存终端日志
- 支持拖拽本地文件到画布
```

这一版就已经有差异化了。

### Phase 2：Agent 编排

```
- Agent Node
- 每个 Agent 绑定项目目录
- 一键启动 Claude Code / Codex
- 任务卡片投递到终端
- 自动收集 diff / git status / test result
- 浏览器节点打开 localhost 页面
- console/network error 捕获
- 画布上展示执行链路
```

这个阶段开始像“AI Coding 控制台”。

### Phase 3：多端同步和团队协作

```
- Yjs / tldraw sync
- 账号系统
- 云端项目同步
- 图片/附件对象存储
- 多人协作光标
- 评论
- Agent 执行记录共享
- 权限控制
```

---

## 技术选型对比

模块推荐备选不建议桌面壳Tauri 2Electron纯 Web前端React + TypeScriptVue原生 Canvas 全手写画布tldrawExcalidraw / 自研一开始 WebGL 自研状态管理ZustandJotai / Redux Toolkit复杂 MobX 大状态终端 UIxterm.jsMonaco terminal hack自己写 terminal本地 CoreRustGoNode 单进程裸跑CLI 执行Rust PTYNode PTYHTTP 伪终端本地存储SQLiteDuckDB纯 localStorage协作同步Yjs / tldraw syncLiveblocks自己写冲突合并云端 APIGo / Rust / NodeSupabase一开始微服务化大文件S3/R2/MinIOSupabase StorageDB 存 blob

---

## 我最推荐的实际工程结构

```
ai-canvas/
  apps/
    desktop/                 # Tauri App
      src/                   # React UI
      src-tauri/             # Rust local core

    web/                     # 可选 Web 版
      src/

    server/                  # 云同步服务，可后置
      src/

  packages/
    canvas-core/             # 节点模型、画布 schema
    agent-adapters/          # claude/codex/gemini 适配器
    sync-protocol/           # Yjs/tldraw sync 封装
    ui-kit/                  # 通用 UI 组件
    terminal-protocol/       # PTY message protocol

  crates/
    local-runtime/           # Rust PTY / process / fs
    browser-controller/      # CDP / Playwright 控制
```

---

## 最小可行技术栈

我会这样定：

```
Frontend:
- React
- TypeScript
- Vite
- tldraw
- Zustand
- TanStack Query
- Tailwind CSS
- xterm.js

Desktop/Core:
- Tauri 2
- Rust
- portable-pty
- rusqlite / sqlx
- notify 文件监听
- git2 可选

Sync:
- SQLite local-first
- Yjs
- WebSocket sync server
- Postgres
- S3/R2/MinIO

Backend:
- Go + Gin，或者 Node + Hono/NestJS
```

你如果更看重工程性能和本地系统能力：**Rust 后端优先**。

你如果更看重开发速度和团队熟悉度：**Go 云端 + Rust 本地 Core**。

你如果想最快出 MVP：**Tauri + React + tldraw + xterm.js + SQLite**。

---

## 关键风险

### 1. 本地命令执行是高危能力

这个 App 本质上能执行：

```bash
rm -rf
git push
npm install
claude --dangerously-skip-permissions
```

所以必须有权限模型：

```
- 项目级授权目录
- 命令执行确认
- 危险命令拦截
- 环境变量脱敏
- 日志脱敏
- 同步前审查
```

否则一旦插件或 Prompt 被污染，风险很大。

### 2. 终端日志不要默认云同步

终端里可能有：

```
- token
- API key
- 公司内网地址
- 用户名
- 代码路径
- 私有仓库信息
```

建议默认：

```
本地保存，不上传；
用户手动选择“同步此节点”才上传。
```

### 3. 浏览器内嵌会遇到很多限制

很多站点不允许 iframe，WebView 登录态也不一定好处理。

所以 Browser Node 最好支持三种模式：

```
- 内嵌预览
- 外部浏览器打开
- CDP 控制真实 Chrome
```

---

## 最终建议

你的项目不要定位成“另一个 infinite-canvas”，而应该定位成：

```
面向 AI Coding 的本地优先无限画布工作台
```

一句话产品定义：

```
把 Claude Code、Codex、浏览器、终端、文件、截图、任务和设计说明全部放到一个可视化无限画布里，形成可回放、可同步、可编排的 AI 编程工作流。
```

技术路线我建议：

```
第一版：
Tauri 2 + React + tldraw + xterm.js + Rust PTY + SQLite

第二版：
Agent Adapter + Browser Node + Git/Diff/Test 捕获

第三版：
Yjs/tldraw sync + 云端同步 + 团队协作
```

不要一开始自研画布引擎，也不要一开始做完整云协作。先把 **“画布里拉一个终端框，直接跑 Claude Code / Codex，并把过程沉淀成节点”** 这个体验打穿。这个点打穿，就有产品价值。

---

## 消息 4 · 用户

cli 可以考虑先嵌入终端之类的 后面在考虑详细适配

---

## 消息 5 · ChatGPT

对，CLI 第一阶段按“嵌入真实终端”处理更稳，不要过早做 Claude/Codex 私有协议适配。我先看一下 `agent-canvas` 的定位和实现，再把它跟你这个项目方向对齐。

---

## 消息 6 · ChatGPT

对，你这个判断是对的：**第一阶段 CLI 不要做深度适配，先嵌入终端，把 Claude Code / Codex / Gemini / OpenCode 当成普通 CLI 程序跑起来。**

后面再做事件解析、diff 捕获、任务状态识别、Agent 协议适配。

我看了你提到的 `voicetreelab/agent-canvas` 和后续的 `voicetree`，它们跟你想法很接近，但也有一些可借鉴和可规避的地方。

## 参考项目结论

### 1. `voicetreelab/agent-canvas`

这个项目本质是：

```
Obsidian / Juggl 图谱插件
+ terminal agent 节点
+ coding agent 可视化编排
```

它 README 里写得很明确：这是一个给 VoiceTree 用的图形化界面，用来在 graph/canvas 上表示 terminal 和 coding agents，并且基于 Cytoscape.js 和 juggl-ui 做交互图。它还依赖 Obsidian 的 Terminal 插件和 Hover Editor 插件。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/voicetreelab/agent-canvas)

所以它的价值是：**证明“终端 Agent 节点 + 图谱编排”这个方向可行。**

但它的问题是：

```
- 依赖 Obsidian 插件生态
- 更像 graph view，不是完整无限画布工作台
- 技术栈受 Juggl / Obsidian 限制
- 不适合直接做独立桌面 App 的底座
```

可以参考理念，不建议直接 fork 当主线。

---

### 2. `voicetree`

`voicetree` 更接近你要的方向。它把系统定义为 **graph-based mindmap for HITL coding-agent systems**，核心原语是 nodes 和 edges；节点可以是 markdown 文件、文件夹、或者 terminal-based agent，比如 Claude Code、Codex、OpenCode、Gemini 等。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/voicetreelab/voicetree)

它还有几个非常值得借鉴的设计：

```
1. Agent 是图上的节点
2. 文件 / 任务 / 进度也是节点
3. Agent 可以基于附近节点获取上下文
4. 连线代表关系
5. Agent 可以创建自己的子图
6. Agent 终端是原生 terminal，所以人可以完全观察和接管
```

它 README 里还提到，Voicetree 的节点可以是 markdown notes、folders 或 terminal-based agents；Agent 可以看到附近节点，并能基于 local embeddings 做语义搜索。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/voicetreelab/voicetree)

这和你说的“连线表示将文件链接过去，支持访问”非常一致。

---

## 你这个项目可以吸收的核心设计

我建议你的项目不要只做“画布 + 终端”，而是做成：

```
文件 / 文档 / 图片 / 浏览器 / 终端 / Agent
都变成画布节点

节点之间的连线
就是上下文传递、依赖关系、引用关系、执行关系
```

也就是说，**连线不是装饰，而是可执行语义。**

---

## 连线语义设计

你说的“支持连线表示将文件链接过去，支持访问”，这个非常关键。可以设计成几类边：

```typescript
type EdgeType =
  | 'context'      // 作为上下文传给 Agent
  | 'input'        // 作为输入文件
  | 'output'       // Agent 输出到某节点
  | 'reference'    // 普通引用
  | 'depends_on'   // 任务依赖
  | 'opens'        // 浏览器/终端打开某资源
  | 'patches'      // diff 修改某文件
  | 'explains'     // 文档解释某代码
```

例如：

```
[需求说明.md] --context--> [Claude Code Terminal]
[错误截图.png] --context--> [Claude Code Terminal]
[src/Login.tsx] --input--> [Codex Terminal]
[Claude Code Terminal] --patches--> [src/Login.tsx]
[Browser: localhost:3000] --output--> [测试结果节点]
```

这样画布就不是白板，而是一个 **上下文路由图**。

---

## 文件节点怎么支持访问？

文件节点建议分两层：

### 第一层：文件引用

```typescript
interface FileNode {
  id: string
  type: 'file'
  path: string
  projectId: string
  name: string
  mimeType: string
  accessMode: 'read' | 'read-write'
}
```

用户把文件拖到画布上，本质是创建一个本地文件引用。

例如：

```
D:/project/demo/src/App.tsx
```

Agent Terminal 节点连接这个 File Node 后，可以获得：

```
- 文件路径
- 文件内容摘要
- 是否允许读取
- 是否允许修改
```

### 第二层：上下文注入

当你从文件节点连到终端节点时，不一定要立刻复制文件内容，而是生成一段上下文：

```
你可以访问以下文件：
- src/App.tsx
- src/router/index.ts
- package.json

任务相关说明：
- 重点检查 App.tsx 中的路由初始化
```

然后投递到 Claude Code / Codex 终端。

第一阶段最简单可以这样做：

```
用户连线文件 -> Agent 节点
点击 “Run with context”
系统把文件路径 + 任务说明 paste 到终端
```

不用先做复杂 API。

---

## 第一阶段 CLI 嵌入终端是正确路线

你可以把 Claude Code / Codex / Gemini / OpenCode 全部抽象成：

```
Terminal Agent Node
```

它们的启动方式只是不同：

```json
{
  "claude-code": {
    "command": "claude",
    "args": [],
    "cwd": "${projectPath}"
  },
  "codex": {
    "command": "codex",
    "args": [],
    "cwd": "${projectPath}"
  },
  "gemini": {
    "command": "gemini",
    "args": [],
    "cwd": "${projectPath}"
  },
  "opencode": {
    "command": "opencode",
    "args": [],
    "cwd": "${projectPath}"
  }
}
```

第一版不要解析它们内部协议，只做这几个能力：

```
- 启动 CLI
- 保持 PTY 会话
- 发送文本到终端
- 读取 stdout/stderr
- 保存终端日志
- 支持用户手动接管输入
- 支持从画布节点拼接上下文后 paste 到终端
```

这就够了。

---

## 推荐产品抽象

我建议核心概念这样设计：

```
Workspace
  └── Canvas
        ├── Node
        │     ├── File Node
        │     ├── Folder Node
        │     ├── Markdown Node
        │     ├── Image Node
        │     ├── Browser Node
        │     ├── Terminal Node
        │     └── Agent Node
        │
        └── Edge
              ├── context
              ├── input
              ├── output
              ├── reference
              ├── dependency
              └── patch
```

最重要的是：

```
Node 是资源
Edge 是关系
Agent 根据连接关系获取上下文
```

这点比普通无限画布更像“AI 编程操作系统”。

---

## 框架推荐重新排序

结合你现在补充的需求，我会更明确地推荐：

```
桌面端：Electron 优先，Tauri 次选
前端：React + TypeScript
画布：React Flow 或 tldraw
终端：xterm.js + node-pty
本地服务：Node.js 主进程 / Rust sidecar
存储：SQLite
同步：Yjs / Automerge / 后期云端 Postgres
```

这里我会稍微修正前面的建议：

**如果第一阶段重点是嵌入终端和快速迭代，Electron 比 Tauri 更省事。**

原因很现实：

```
- Electron + node-pty 成熟度高
- VS Code 也是 Electron + PTY 类似路线
- 终端、文件系统、子进程、WebView 集成都方便
- 对 Claude Code / Codex 这种 CLI 包装更快
```

Tauri 更轻，但 PTY、WebView、进程管理、跨平台细节会更折腾。

所以：

### 快速 MVP 推荐

```
Electron + React + React Flow + xterm.js + node-pty + SQLite
```

### 长期产品推荐

```
Tauri 2 / Rust Core + React + tldraw / React Flow + SQLite + Yjs
```

---

## 画布选型：React Flow vs tldraw

你的需求有“节点 + 连线 + 文件链接 + Agent 关系”，所以我现在更倾向：

### 第一版用 React Flow

因为你的核心是：

```
图节点
连线
上下文传递
Agent 编排
任务依赖
```

React Flow 天然适合 node-edge 模型。

适合做：

```
- Agent 图
- 文件关系图
- 任务 DAG
- 连线语义
- 节点面板
- 自动布局
```

### tldraw 更适合自由白板

适合做：

```
- 贴图
- 标注
- 手绘
- 文字
- 白板自由排布
```

所以你可以这样分层：

```
MVP：React Flow
后期：React Flow + tldraw-like whiteboard layer
```

或者直接用 tldraw 自定义 shape + binding，但复杂度会更高。

我的建议是：

```
如果核心是 Agent 编排：React Flow
如果核心是自由白板：tldraw
如果你要两者兼顾：React Flow 起步，后面加自由标注层
```

你的场景明显是 **Agent 编排优先**，所以 React Flow 更合适。

---

## MVP 版本功能建议

第一版只做这些：

```
1. 创建 Workspace
2. 打开本地项目目录
3. 创建 File Node / Folder Node
4. 创建 Terminal Agent Node
5. 支持 Claude / Codex / Gemini / OpenCode 启动命令
6. 支持 xterm.js 终端嵌入
7. 支持文件节点连到 Agent 节点
8. 点击 Run with Context，把连接的文件路径和说明发送到终端
9. 支持 Browser Node 打开 localhost
10. SQLite 保存画布状态
```

这个版本就能形成闭环。

---

## 一个实际交互例子

```
1. 用户拖入项目目录 /Users/me/project-a
2. 画布出现 Folder Node
3. 用户拖出 src/App.tsx、package.json、错误截图
4. 用户创建 Claude Code Agent Node
5. 把 App.tsx、package.json、错误截图连到 Claude Node
6. 在任务节点写：
   “修复启动后白屏问题，优先检查路由和依赖版本”
7. 点击 Run
8. 系统自动向终端发送：
   claude
   然后 paste 任务上下文
9. Claude Code 在真实终端里执行
10. 用户可随时接管、批准、拒绝、复制日志
11. 修改结果生成 Diff Node，连回 App.tsx
```

这个体验就比普通 CLI 强很多。

---

## 访问权限设计

一定要做权限模型。

建议每个 Workspace 有授权根目录：

```json
{
  "workspaceRoots": [
    "D:/project/demo",
    "C:/Users/guozhanhui/.claude",
    "C:/Users/guozhanhui/.codex"
  ]
}
```

文件节点只能访问授权目录下的文件。

边也可以带权限：

```typescript
interface ContextEdge {
  source: string
  target: string
  type: 'context'
  permission: {
    read: boolean
    write: boolean
    execute: boolean
    syncToCloud: boolean
  }
}
```

默认规则：

```
文件 -> Agent：只读
目录 -> Agent：可读
任务 -> Agent：可读
Agent -> 文件：需要用户确认才可写
终端日志：默认不上传云端
```

---

## 和 Voicetree 的差异化方向

Voicetree 已经在做：

```
Obsidian meets Claude Code
Graph-based agent orchestration
Markdown node + terminal agent
Local embeddings context retrieval
```

你要做差异化，可以走这几个方向：

```
1. 更强的桌面 App 体验
2. 更好的终端嵌入和多 CLI 管理
3. 更自由的白板能力：截图、标注、图片、网页
4. 更适合中文开发者和企业内网项目
5. 更强的本地权限控制
6. 更好的 Git/Diff/Test 结果可视化
7. 支持多端同步，但默认 local-first
8. 支持插件化 Agent Adapter
```

说白了：

```
Voicetree 更像 Obsidian Graph + Agent Terminal
你可以做成 Cursor/Claude Code 的可视化控制平面
```

---

## 我建议的最终技术选型

如果你想快速做出来：

```
Electron
React
TypeScript
React Flow
xterm.js
node-pty
SQLite
Drizzle ORM
Zustand
Tailwind CSS
Monaco Editor
Playwright / CDP 后置
Yjs 后置
```

如果你追求长期轻量和安全：

```
Tauri 2
React
TypeScript
React Flow / tldraw
xterm.js
Rust PTY
SQLite
Yjs
Rust permission sandbox
```

我的真实建议：

```
先 Electron，后面再评估 Tauri。
```

因为你现在最大的不确定性不是性能，而是产品交互是否成立。Electron 更快验证。

---

## 项目定位可以这样写

```
一个 local-first 的 Armadra。

用户可以在无限画布上创建文件、目录、终端、浏览器、任务、截图和文档节点；
通过连线把上下文传递给 Claude Code、Codex、Gemini、OpenCode 等 CLI Agent；
Agent 在真实本地终端中运行，用户可以随时观察、接管和授权；
执行过程、修改文件、diff、测试结果和网页状态会沉淀为可视化节点；
后续支持多端同步、团队协作和 Agent 子图编排。
```

---

## 最小代码架构

```
apps/desktop
  main/                         # Electron main process
    pty/
      PtyManager.ts             # node-pty session 管理
    fs/
      WorkspaceFs.ts            # 授权目录文件访问
    db/
      sqlite.ts
    agents/
      AgentRegistry.ts
      ClaudeAdapter.ts
      CodexAdapter.ts
      GeminiAdapter.ts

  renderer/
    canvas/
      CanvasPage.tsx
      nodes/
        TerminalNode.tsx
        FileNode.tsx
        FolderNode.tsx
        TaskNode.tsx
        BrowserNode.tsx
        ImageNode.tsx
      edges/
        ContextEdge.tsx
    terminal/
      XtermView.tsx
    store/
      canvasStore.ts

packages/
  protocol/
    ipc.ts
    nodeTypes.ts
    edgeTypes.ts
```

---

## 一句话判断

你的方向可以做，而且比单纯 infinite-canvas 更有产品价值。

但第一版不要追求“全自动 Agent 编排”，应该先打穿这个核心链路：

```
画布节点 → 连线选择上下文 → 嵌入终端启动 CLI → Agent 执行 → 输出/文件/diff 回流画布
```

技术上我建议：

```
MVP：Electron + React Flow + xterm.js + node-pty + SQLite
长期：再考虑 Tauri/Rust Core、Yjs 同步、浏览器 CDP、Agent Adapter 深度适配
```

---

## 消息 7 · 用户

所以重新设计给出详细的设计方案 包含不同的语言

---

## 消息 8 · ChatGPT

我会按“产品定位 → 架构 → 不同语言/框架方案 → MVP 路线 → 数据模型/权限/同步”的方式重新设计，重点把 Electron、Tauri/Rust、Go、Node、Flutter 等路线放在一起比较。

---

## 消息 9 · ChatGPT

下面给你一版**重新设计后的完整方案**。我会把它当成一个真实可落地的项目来设计，而不是泛泛讲“无限画布 + 终端”。

---

# 项目定位

建议项目定位为：

```markdown
Local-first Armadra

一个本地优先的 AI Coding 无限画布工作台。
用户可以在画布中创建终端、Agent、文件、目录、浏览器、截图、Markdown、任务、Diff 等节点；
通过连线把文件、需求、截图、网页、日志等上下文传给 Claude Code、Codex、Gemini CLI、OpenCode 等本地 CLI；
CLI 运行在真实本地终端中，用户可以随时观察、接管、授权；
执行结果、文件修改、Git Diff、测试结果、浏览器状态可以回流成画布节点；
后续支持多端同步、团队协作、权限控制和 Agent 编排。
```

一句话：

```markdown
把 Claude Code / Codex / Gemini CLI 从“黑盒终端”变成“可视化、可编排、可沉淀的 AI Coding 工作台”。
```

---

# 核心产品抽象

不要把它设计成普通白板。它应该是：

```markdown
节点 = 资源 / 工具 / 上下文
连线 = 关系 / 权限 / 上下文传递
画布 = AI Coding 工作流状态空间
终端 = 本地执行入口
Agent = 特殊终端节点
```

核心对象：

```markdown
Workspace
  ├── Canvas
  │   ├── Nodes
  │   │   ├── Terminal Node
  │   │   ├── Agent Node
  │   │   ├── File Node
  │   │   ├── Folder Node
  │   │   ├── Browser Node
  │   │   ├── Markdown Node
  │   │   ├── Image Node
  │   │   ├── Screenshot Node
  │   │   ├── Task Node
  │   │   ├── Diff Node
  │   │   └── Test Result Node
  │   │
  │   └── Edges
  │       ├── context
  │       ├── input
  │       ├── output
  │       ├── reference
  │       ├── depends_on
  │       ├── opens
  │       ├── patches
  │       └── verifies
  │
  ├── Local Runtime
  │   ├── PTY Sessions
  │   ├── File Access
  │   ├── Git Monitor
  │   ├── Browser Controller
  │   └── Permission Engine
  │
  └── Sync Layer
      ├── Local SQLite
      ├── Optional Cloud Sync
      └── Object Storage
```

---

# 推荐技术路线总览

我先给结论。

## 如果你要最快做出 MVP

推荐：

```markdown
Electron + React + TypeScript + React Flow + xterm.js + node-pty + SQLite
```

适合：

```markdown
- 快速验证产品交互
- 先跑 Claude Code / Codex / Gemini CLI
- 终端嵌入优先
- 本地文件访问优先
- 后续再优化体积和安全性
```

Electron 官方定位就是用 JavaScript、HTML、CSS 构建跨平台桌面应用，并通过 main process 访问操作系统能力，适合这种“Web UI + 本地能力”的产品。[![图片](https://www.google.com/s2/favicons?domain=https://electronjs.org&sz=128)Electron](https://electronjs.org/?utm_source=chatgpt.com)

## 如果你要长期做成更安全、更轻的产品

推荐：

```markdown
Tauri 2 + React + TypeScript + React Flow / tldraw + xterm.js + Rust PTY + SQLite
```

适合：

```markdown
- 更轻量
- 更强本地安全模型
- Rust 本地运行时
- 长期商业化桌面 App
- 后续移动端可能性
```

Tauri 2 支持用任意 Web 前端配合 Rust 应用逻辑构建跨平台应用，目标平台包含 Linux、macOS、Windows、Android 和 iOS。[![图片](https://www.google.com/s2/favicons?domain=https://v2.tauri.app&sz=128)Tauri](https://v2.tauri.app/?utm_source=chatgpt.com)

## 我的真实建议

```markdown
第一阶段：Electron
第二阶段：抽象 Runtime 接口
第三阶段：保留 Electron 或迁移 Tauri/Rust
```

原因很现实：你的核心风险不是性能，而是产品闭环能不能成立。

第一阶段最重要的是：

```markdown
画布节点 → 连线选择上下文 → 嵌入终端启动 CLI → Agent 执行 → 输出 / Diff / 文件状态回流画布
```

这个链路 Electron 更快打穿。

---

# 不同语言 / 框架方案对比

## 方案 A：Electron + TypeScript，全 JS/TS 主导

### 技术栈

```markdown
Desktop:
- Electron
- TypeScript
- Vite

Frontend:
- React
- React Flow
- Tailwind CSS
- Zustand
- TanStack Query
- Monaco Editor
- xterm.js

Runtime:
- Node.js
- node-pty
- chokidar
- simple-git / isomorphic-git
- better-sqlite3 / sqlite3
- Drizzle ORM

Sync:
- Yjs
- WebSocket
- Postgres / SQLite Cloud / Supabase
```

xterm.js 是浏览器里的终端前端组件，适合把终端嵌入 Web UI。[![图片](https://www.google.com/s2/favicons?domain=https://xtermjs.org&sz=128)Xterm.js](https://xtermjs.org/?utm_source=chatgpt.com)

node-pty 可以在 Node.js 中 fork 伪终端进程，并返回可读写的 terminal object，正好适合连接 xterm.js 和真实 shell / CLI。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/microsoft/node-pty?utm_source=chatgpt.com)

### 优点

```markdown
- 开发最快
- node-pty + xterm.js 成熟
- 适合 Claude Code / Codex / Gemini CLI 这种终端程序
- React 生态丰富
- Electron 插件生态强
- 跨平台打包成熟
- 后期可以做 VS Code 类似体验
```

### 缺点

```markdown
- App 体积大
- 内存占用高
- 安全边界要自己做好
- Electron main / renderer / preload 权限模型容易踩坑
- 企业环境下安全审计压力更大
```

### 适用场景

```markdown
适合 MVP、内测版、开发者工具、快速迭代。
```

### 我对它的评价

```markdown
最适合你现在阶段。
不要一开始就纠结 Tauri。
先把产品体验跑通。
```

---

## 方案 B：Tauri 2 + Rust + React

### 技术栈

```markdown
Desktop:
- Tauri 2
- Rust
- Vite

Frontend:
- React
- React Flow / tldraw
- TypeScript
- Tailwind CSS
- Zustand
- xterm.js

Runtime:
- Rust
- portable-pty / tokio process / expectrl
- notify
- git2
- rusqlite / sqlx
- serde
- tauri commands

Sync:
- Yjs 前端
- Rust WebSocket / HTTP client
- Postgres / S3
```

Tauri 的后端是 Rust-sourced binary，前端可以是任意编译成 HTML/JS/CSS 的框架。[![图片](https://www.google.com/s2/favicons?domain=https://github.com&sz=128)GitHub](https://github.com/tauri-apps/tauri?utm_source=chatgpt.com)

### 优点

```markdown
- 更轻
- 更安全
- Rust 适合做本地权限、进程、文件、PTY
- 长期可维护性好
- 跨平台潜力更强
- 可做更细粒度的本地沙箱
```

### 缺点

```markdown
- PTY、终端、WebView 细节比 Electron 更折腾
- Rust 开发成本高
- 前后端 IPC 设计要更严谨
- MVP 速度不如 Electron
```

### 适用场景

```markdown
适合长期产品、商业桌面 App、安全要求高的企业工具。
```

### 我对它的评价

```markdown
长期理想方案，但不建议第一天就用。
除非团队 Rust 很强。
```

---

## 方案 C：Go + Wails + React

### 技术栈

```markdown
Desktop:
- Wails
- Go
- React
- TypeScript

Runtime:
- Go os/exec
- creack/pty
- fsnotify
- go-git
- SQLite

Frontend:
- React Flow
- xterm.js
```

### 优点

```markdown
- Go 写本地服务很舒服
- 文件、进程、Git、WebSocket 都好写
- 编译简单
- 部署清晰
- 后端云服务也可以复用 Go
```

### 缺点

```markdown
- 桌面生态不如 Electron / Tauri
- WebView 能力受限
- UI 集成成熟度一般
- 社区体量较小
- 做复杂桌面体验不如 Electron
```

### 适用场景

```markdown
适合你偏后端工程化、想用 Go 快速写本地 Runtime。
```

### 我对它的评价

```markdown
如果你特别喜欢 Go，可以考虑。
但从产品生态看，不如 Electron 起步稳。
```

---

## 方案 D：纯 Web + Local Agent Daemon

### 技术栈

```markdown
Frontend:
- Next.js / React
- React Flow / tldraw
- xterm.js

Local Daemon:
- Node / Go / Rust
- WebSocket
- PTY
- File access
- Git monitor

Browser:
- 用户打开 Web 页面
- 页面连接 localhost daemon
```

### 架构

```markdown
Browser UI
   ↓ WebSocket
localhost:4317 Local Daemon
   ↓
PTY / File / Git / Browser / Agent CLI
```

### 优点

```markdown
- Web 部署方便
- 多端访问天然
- UI 可以远程打开
- Local daemon 单独升级
- 类似很多 AI IDE / dev server 的架构
```

### 缺点

```markdown
- 本地 daemon 安全风险高
- 浏览器权限限制多
- 用户安装体验复杂
- localhost 通信和鉴权要做好
- 企业代理 / 防火墙可能干扰
```

### 适用场景

```markdown
适合后期做 Web 控制台 + 本地 Agent Runtime。
```

### 我对它的评价

```markdown
可以作为第二阶段架构，不适合作为第一版桌面体验。
```

---

## 方案 E：Flutter / Dart 桌面端

### 技术栈

```markdown
Desktop:
- Flutter
- Dart

Terminal:
- Flutter terminal package
- Native PTY bridge

Runtime:
- Dart FFI
- Rust / Go sidecar

Canvas:
- Flutter CustomPainter
- 自研节点系统
```

### 优点

```markdown
- 跨端 UI 一致性好
- 移动端潜力强
- 渲染性能好
```

### 缺点

```markdown
- Web 生态弱
- React Flow / tldraw / xterm.js 这些不能直接复用
- 终端和 WebView 成本高
- 自研画布成本高
- AI Coding 工具生态不在 Flutter 这边
```

### 适用场景

```markdown
更适合消费级跨端 App，不适合你这个开发者工具。
```

### 我对它的评价

```markdown
不推荐。
```

---

## 方案 F：C# / .NET + Avalonia / WinUI

### 技术栈

```markdown
Desktop:
- .NET
- Avalonia / WinUI
- WebView2
- C#

Runtime:
- System.Diagnostics.Process
- ConPTY on Windows
- SSH / PTY bridge
```

### 优点

```markdown
- Windows 原生体验好
- 企业 Windows 环境友好
- WebView2 稳定
- 对你 Windows 使用场景有优势
```

### 缺点

```markdown
- 跨平台复杂
- React 生态复用弱
- 画布和终端要花更多成本
- macOS/Linux 体验不如 Electron/Tauri
```

### 适用场景

```markdown
如果只做 Windows 企业内部工具，可以考虑。
```

### 我对它的评价

```markdown
除非你明确只做 Windows，不推荐。
```

---

# 最终语言选择建议

## 最推荐组合

```markdown
前端语言：TypeScript
本地 Runtime：第一版 Node.js，后期 Rust
云端服务：Go 或 Node.js
同步协议：Yjs
数据存储：SQLite + Postgres
```

也就是：

```markdown
MVP：
TypeScript 全栈 + Electron

长期：
TypeScript UI + Rust Local Core + Go/Node Cloud
```

---

# 画布引擎选择

你现在的需求不是纯白板，而是“节点 + 连线 + 上下文传递”。所以我建议优先：

```markdown
React Flow
```

React Flow 的基本模型就是 nodes、edges、viewport，并支持自定义节点和自定义边。[![图片](https://www.google.com/s2/favicons?domain=https://reactflow.dev&sz=128)React Flow](https://reactflow.dev/learn/concepts/building-a-flow?utm_source=chatgpt.com)

它的自定义节点可以嵌入表单、图表、交互元素等，这对 Terminal Node、Browser Node、File Node 很重要。[![图片](https://www.google.com/s2/favicons?domain=https://reactflow.dev&sz=128)React Flow](https://reactflow.dev/learn/customization/custom-nodes?utm_source=chatgpt.com)

自定义边也可以渲染额外控件，适合在连线上放“context / input / output / readonly / writable”等语义标记。[![图片](https://www.google.com/s2/favicons?domain=https://reactflow.dev&sz=128)React Flow](https://reactflow.dev/learn/customization/custom-edges?utm_source=chatgpt.com)

## React Flow 适合

```markdown
- Agent 编排
- 文件连线
- 上下文传递
- 任务依赖
- DAG / Graph
- 节点状态
- 自动布局
- 执行流展示
```

## tldraw 适合

```markdown
- 自由白板
- 手绘标注
- 图片贴图
- 箭头
- 便签
- 视觉化思考
```

tldraw 是 React infinite canvas SDK，支持自定义 shapes、tools 和 UI。[![图片](https://www.google.com/s2/favicons?domain=https://tldraw.dev&sz=128)tldraw](https://tldraw.dev/?utm_source=chatgpt.com)

## 实际建议

```markdown
MVP：React Flow
后续：加 tldraw 风格自由标注层
```

不要一开始就做双画布。先把图模型跑通。

---

# 推荐整体架构

```markdown
┌─────────────────────────────────────────────┐
│                 Renderer UI                  │
│ React + TypeScript + React Flow              │
│                                             │
│ - Canvas                                    │
│ - Terminal Node                             │
│ - Agent Node                                │
│ - File Node                                 │
│ - Browser Node                              │
│ - Task Node                                 │
│ - Diff Node                                 │
│ - Image / Markdown / Annotation Node         │
└─────────────────────────────────────────────┘
                    │
                    │ IPC
                    ▼
┌─────────────────────────────────────────────┐
│              Local Runtime Layer             │
│ Electron Main / Rust Core / Go Daemon        │
│                                             │
│ - PTY Manager                               │
│ - Process Manager                           │
│ - File Access Manager                       │
│ - Git Monitor                               │
│ - Browser Controller                        │
│ - Permission Engine                         │
│ - Secret Redactor                           │
└─────────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
  Claude Code    Codex CLI    Gemini CLI
  OpenCode       Shell        Git / npm / mvn

                    │
                    ▼
┌─────────────────────────────────────────────┐
│              Storage / Sync Layer            │
│                                             │
│ Local: SQLite                               │
│ Realtime: Yjs                               │
│ Cloud: Postgres                             │
│ Object: S3 / R2 / MinIO                      │
└─────────────────────────────────────────────┘
```

---

# 核心模块设计

## 1. Canvas UI 模块

### 节点类型

```typescript
type CanvasNodeType =
  | 'terminal'
  | 'agent'
  | 'file'
  | 'folder'
  | 'browser'
  | 'task'
  | 'markdown'
  | 'image'
  | 'screenshot'
  | 'diff'
  | 'test_result'
  | 'log'
  | 'annotation'
```

### 边类型

```typescript
type CanvasEdgeType =
  | 'context'
  | 'input'
  | 'output'
  | 'reference'
  | 'depends_on'
  | 'opens'
  | 'patches'
  | 'verifies'
```

### 节点基础结构

```typescript
interface BaseNode {
  id: string
  type: CanvasNodeType
  title: string
  x: number
  y: number
  width: number
  height: number
  status?: 'idle' | 'running' | 'waiting' | 'done' | 'failed'
  createdAt: number
  updatedAt: number
}
```

---

## 2. Terminal Node

Terminal Node 是第一阶段最重要的节点。

```typescript
interface TerminalNode extends BaseNode {
  type: 'terminal'
  sessionId: string
  cwd: string
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish'
  envProfileId?: string
  scrollback?: number
}
```

能力：

```markdown
- 创建终端
- 选择工作目录
- 选择 shell
- 输入 / 输出
- resize
- copy / paste
- 保存日志
- 重启 session
- attach / detach
```

前端：

```markdown
xterm.js
```

后端：

```markdown
Electron: node-pty
Tauri: Rust PTY
Go: creack/pty
```

---

## 3. Agent Node

第一阶段 Agent Node 本质上就是带启动模板的 Terminal Node。

```typescript
interface AgentNode extends BaseNode {
  type: 'agent'
  adapter: 'claude' | 'codex' | 'gemini' | 'opencode' | 'custom'
  sessionId?: string
  projectPath: string
  launchCommand: string
  launchArgs: string[]
  mode: 'terminal'
}
```

### Agent Adapter

```typescript
interface AgentAdapter {
  id: string
  name: string
  detect(): Promise<boolean>
  getDefaultCommand(): string
  getDefaultArgs(): string[]
  buildContextPrompt(input: ContextBundle): string
}
```

### 第一阶段支持

```markdown
- claude
- codex
- gemini
- opencode
- custom shell command
```

### 不做的事情

第一阶段不要做：

```markdown
- 不解析 Claude Code 私有协议
- 不解析 Codex 内部事件
- 不做自动 approval
- 不做自动工具调用注入
- 不模拟人类操作终端
```

只做：

```markdown
把上下文拼成文本，paste 到真实终端。
```

---

## 4. File Node / Folder Node

文件节点不是复制文件，而是引用本地路径。

```typescript
interface FileNode extends BaseNode {
  type: 'file'
  path: string
  projectRoot: string
  mimeType: string
  size: number
  readonly: boolean
  syncPolicy: 'local_only' | 'metadata_only' | 'full_sync'
}
```

目录节点：

```typescript
interface FolderNode extends BaseNode {
  type: 'folder'
  path: string
  projectRoot: string
  includePatterns?: string[]
  excludePatterns?: string[]
}
```

文件节点能力：

```markdown
- 打开文件
- 查看内容
- 复制路径
- 生成摘要
- 作为上下文连给 Agent
- 作为修改目标
- 观察 Git diff
```

---

## 5. Edge 连线语义

这是这个项目和普通画布最大的区别。

```typescript
interface CanvasEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  type: CanvasEdgeType
  permissions?: EdgePermission
  label?: string
}
```

权限：

```typescript
interface EdgePermission {
  read?: boolean
  write?: boolean
  execute?: boolean
  syncToCloud?: boolean
}
```

例子：

```markdown
[需求说明] --context--> [Claude Agent]
[src/App.tsx] --input/read--> [Claude Agent]
[Claude Agent] --patches/write-confirm--> [src/App.tsx]
[Browser localhost:3000] --verifies--> [Task]
[错误截图] --context--> [Codex Agent]
```

---

## 6. Context Bundle 上下文打包

当用户点击 Agent Node 的 “Run with Context”，系统根据连线收集上下文。

```typescript
interface ContextBundle {
  task?: string
  files: Array<{
    path: string
    content?: string
    summary?: string
    mode: 'path_only' | 'summary' | 'full_content'
  }>
  images: Array<{
    path: string
    description?: string
  }>
  browserStates: Array<{
    url: string
    title?: string
    consoleErrors?: string[]
    screenshotPath?: string
  }>
  notes: Array<{
    title: string
    content: string
  }>
}
```

生成 Prompt：

```markdown
你正在处理当前项目。

任务：
{task}

可访问文件：
- src/App.tsx
- package.json

相关说明：
{notes}

请优先检查上述文件。
如果需要修改，请直接在本地项目中修改。
```

第一阶段可以只注入路径，不注入完整文件内容。因为 Claude Code / Codex 本身可以读本地文件。

---

## 7. Browser Node

Browser Node 分三档。

### MVP：外部浏览器 / WebView 打开 URL

```typescript
interface BrowserNode extends BaseNode {
  type: 'browser'
  url: string
  mode: 'webview' | 'external'
}
```

能力：

```markdown
- 打开 localhost
- 打开 GitHub
- 打开文档
- 截图
```

### Phase 2：CDP 控制真实浏览器

```markdown
Chrome / Edge DevTools Protocol
- 获取 console error
- 获取 network error
- 截图
- DOM 摘要
- 当前 URL
```

### Phase 3：给 Agent 提供浏览器观察

```markdown
Browser Node --context--> Agent Node

Agent 可获得：
- 当前页面截图
- console errors
- network failures
- DOM summary
```

---

## 8. Git / Diff 模块

Agent 执行后，需要把变化回流画布。

```markdown
Git Monitor:
- before snapshot
- after snapshot
- changed files
- diff hunks
- test result
```

Diff Node：

```typescript
interface DiffNode extends BaseNode {
  type: 'diff'
  repoPath: string
  files: Array<{
    path: string
    additions: number
    deletions: number
    patch: string
  }>
  sourceAgentNodeId?: string
}
```

交互：

```markdown
- 查看 diff
- 应用 / 回滚
- 生成说明
- 连回对应文件节点
```

---

# 同步设计

Yjs 是高性能 CRDT，用于构建可自动同步的协作应用，提供 Map、Array 等共享类型，并能自动合并并发修改。[![图片](https://www.google.com/s2/favicons?domain=https://docs.yjs.dev&sz=128)Yjs 文档](https://docs.yjs.dev/?utm_source=chatgpt.com)

## 同步对象分类

### 可以同步

```markdown
- 画布节点位置
- 边关系
- Markdown 内容
- 任务描述
- 图片附件
- Diff 元数据
- Browser URL
```

### 默认不应该同步

```markdown
- 终端完整日志
- 本地绝对路径
- 环境变量
- API Key
- .env 文件
- SSH key
- 公司内网地址
- 私有代码全文
```

### 同步策略

```markdown
local_only:
  只在本机保存

metadata_only:
  同步文件名、相对路径、摘要，不同步内容

full_sync:
  用户明确授权后同步完整内容
```

## 存储建议

```markdown
Local:
- SQLite
- IndexedDB for Yjs cache
- 文件附件存在 app data directory

Cloud:
- Postgres: workspace / user / canvas / node metadata
- Object Storage: images / screenshots / attachments
- Yjs WebSocket Server: realtime collaboration
```

---

# 权限设计

这个项目能执行本地命令，权限必须从第一天设计。

## Workspace 授权根目录

```json
{
  "workspaceRoots": [
    "D:/project/demo",
    "C:/Users/guozhanhui/.claude",
    "C:/Users/guozhanhui/.codex"
  ]
}
```

所有文件访问必须在授权根目录内。

## 命令权限

```typescript
interface CommandPolicy {
  allowList: string[]
  denyList: string[]
  requireConfirmPatterns: string[]
}
```

默认高危命令：

```markdown
rm -rf
del /s
format
sudo
chmod -R
git push
git reset --hard
curl | sh
Invoke-WebRequest ... | iex
npm publish
docker system prune
```

## 日志脱敏

默认脱敏：

```markdown
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
Authorization: Bearer
password=
token=
secret=
```

---

# MVP 功能范围

第一版不要做太大。

## 必须做

```markdown
1. 创建 Workspace
2. 选择本地项目目录
3. React Flow 画布
4. File Node / Folder Node
5. Terminal Node
6. Agent Node
7. xterm.js 嵌入终端
8. node-pty 启动 shell / claude / codex / gemini
9. 文件节点连到 Agent 节点
10. 点击 Run with Context，把上下文 paste 到终端
11. SQLite 保存画布
12. Git diff 检测
13. 终端日志本地保存
```

## 暂缓

```markdown
- 多端同步
- 团队协作
- Agent 深度协议解析
- 自动 approval
- 浏览器自动操作
- 自研白板引擎
- 云端 RAG
- 插件市场
```

---

# 推荐 MVP 技术结构

```markdown
ai-canvas/
  apps/
    desktop/
      electron/
        main/
          index.ts
          ipc.ts
          pty/
            PtyManager.ts
            PtySession.ts
          agents/
            AgentRegistry.ts
            ClaudeAdapter.ts
            CodexAdapter.ts
            GeminiAdapter.ts
            CustomAdapter.ts
          fs/
            WorkspaceFs.ts
            FileIndexer.ts
          git/
            GitMonitor.ts
          db/
            schema.ts
            sqlite.ts
          security/
            PermissionEngine.ts
            SecretRedactor.ts

        preload/
          index.ts

        renderer/
          src/
            app/
              App.tsx
            canvas/
              CanvasPage.tsx
              nodeTypes.ts
              edgeTypes.ts
              nodes/
                TerminalNode.tsx
                AgentNode.tsx
                FileNode.tsx
                FolderNode.tsx
                TaskNode.tsx
                DiffNode.tsx
                BrowserNode.tsx
              edges/
                ContextEdge.tsx
                InputEdge.tsx
                OutputEdge.tsx
            terminal/
              XtermTerminal.tsx
            store/
              canvasStore.ts
              sessionStore.ts
            api/
              ipcClient.ts

  packages/
    protocol/
      src/
        nodes.ts
        edges.ts
        ipc.ts
        context.ts

    shared/
      src/
        types.ts
        utils.ts
```

---

# IPC 设计

Renderer 不直接碰 Node API。通过 preload 暴露安全 API。

```typescript
window.aiCanvas = {
  workspace: {
    openDirectory(): Promise<Workspace>
    listFiles(root: string): Promise<FileEntry[]>
  },

  terminal: {
    createSession(options: CreateTerminalOptions): Promise<SessionId>
    write(sessionId: string, data: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    kill(sessionId: string): Promise<void>
    onData(sessionId: string, cb: (data: string) => void): void
  },

  agent: {
    detectAdapters(): Promise<AgentAdapterInfo[]>
    startAgent(options: StartAgentOptions): Promise<SessionId>
    runWithContext(options: RunWithContextOptions): Promise<void>
  },

  git: {
    getStatus(repoPath: string): Promise<GitStatus>
    getDiff(repoPath: string): Promise<GitDiff>
  }
}
```

---

# 数据库表设计

## workspaces

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## canvases

```sql
CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## nodes

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## edges

```sql
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## terminal_sessions

```sql
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  shell TEXT NOT NULL,
  command TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

## terminal_logs

```sql
CREATE TABLE terminal_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

---

# Agent 启动配置

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "command": "claude",
      "args": [],
      "cwdMode": "workspace"
    },
    {
      "id": "codex",
      "name": "Codex CLI",
      "command": "codex",
      "args": [],
      "cwdMode": "workspace"
    },
    {
      "id": "gemini",
      "name": "Gemini CLI",
      "command": "gemini",
      "args": [],
      "cwdMode": "workspace"
    },
    {
      "id": "opencode",
      "name": "OpenCode",
      "command": "opencode",
      "args": [],
      "cwdMode": "workspace"
    }
  ]
}
```

---

# 用户交互流程

## 流程 1：最小闭环

```markdown
1. 用户打开 App
2. 创建 Workspace
3. 选择本地项目目录
4. 画布出现 Folder Node
5. 用户创建 Claude Agent Node
6. 用户把 src/App.tsx、package.json 连到 Claude Agent
7. 用户创建 Task Node：
   “修复启动白屏，检查路由和依赖”
8. Task Node 连到 Claude Agent
9. 点击 Run with Context
10. 系统启动 claude 终端
11. 系统 paste 上下文
12. Claude Code 在真实终端执行
13. 用户手动确认权限
14. 执行完成后，系统检测 git diff
15. 生成 Diff Node
16. Diff Node 连回修改过的 File Node
```

---

# 与 Agent Canvas / Voicetree 的差异化

你可以借鉴它们的“图 + Agent + terminal”思想，但你的项目应该差异化在：

```markdown
1. 独立桌面 App，而不是依赖 Obsidian
2. 更强的终端嵌入
3. 更强的文件权限模型
4. 更强的浏览器节点
5. 更强的 Git/Diff/Test 回流
6. 更适合 Claude Code / Codex / Gemini CLI 统一管理
7. 更偏 AI Coding 控制平面，而不是知识图谱
8. 支持后续多端同步
```

---

# 多语言实现路线总结

方案UI本地 Runtime终端适合阶段推荐度Electron + TSReactNode.jsnode-ptyMVP最高Tauri + RustReactRustRust PTY长期产品很高Go + WailsReactGoGo PTY后端团队中Web + DaemonReactNode/Go/RustDaemon PTY后期多端中FlutterFlutterDart/RustNative bridge跨端消费级低C#/.NETAvalonia/WinUIC#ConPTYWindows only中低

---

# 最终建议路线

## 第一阶段：Electron MVP

```markdown
Electron
React
TypeScript
React Flow
xterm.js
node-pty
SQLite
Drizzle
Zustand
Tailwind
simple-git
```

目标：

```markdown
把“画布 + 文件连线 + 本地终端 Agent”打穿。
```

## 第二阶段：Agent Workflow

```markdown
- Git diff 自动回流
- Test result node
- Browser node
- Console error capture
- Context bundle 优化
- Agent session 管理
```

## 第三阶段：Local-first Sync

```markdown
- Yjs
- WebSocket Sync
- Postgres
- S3/R2
- 权限同步策略
```

## 第四阶段：Rust Core / Tauri 评估

```markdown
- 如果 Electron 性能 / 安全 / 体积成为问题，再迁移本地 Runtime
- 或者保留 Electron UI，把核心 Runtime 抽成 Rust sidecar
```

---

# 最小产品命名方向

可以叫：

```markdown
Agent Canvas
Code Canvas
Dev Canvas
Local Agent Canvas
FlowCode
CodeFlow Canvas
AICanvas
Terminal Canvas
WorkGraph
ContextGraph
```

我更建议定位词用：

```markdown
Armadra
```

因为比 Agent Canvas 更明确。

---

# 最关键的一句话

不要第一版就做“智能 Agent 编排平台”。

第一版只做一个强闭环：

```markdown
文件 / 任务 / 截图 / 文档节点
        ↓ 连线
Agent 终端节点
        ↓ 本地 CLI 执行
Git Diff / 日志 / 测试结果
        ↓
回流成画布节点
```

这个闭环跑通，项目就成立。

---

## 消息 10 · 用户

如果还考虑 web端 支持ssh 跨服务等等 哪一个更适合

---

## 消息 11 · ChatGPT

如果还要考虑 **Web 端、SSH、跨服务器、多工作区、多 Agent 远程执行**，那推荐路线要变。

前面如果只是“本地桌面 + 嵌入终端 + Claude/Codex CLI”，我会推荐：

```markdown
Electron + React + React Flow + xterm.js + node-pty
```

但如果你明确要支持：

```markdown
- Web 端访问
- SSH 连接远程机器
- 跨服务器执行 CLI
- 多个远程 workspace
- 多端同步
- 远程终端
- 团队协作
- 未来可能部署成企业平台
```

那更适合的架构是：

```markdown
Web First + Local/Remote Agent Runtime
```

也就是：

```markdown
前端：Web App / Desktop App 共用一套 React UI
后端：中心控制服务
执行端：本地或远程 Agent Daemon
连接：WebSocket / SSH / Tailscale / Cloud Tunnel
```

---

# 最推荐路线

## 结论

如果你要同时支持桌面和 Web，我推荐：

```markdown
前端：
React + TypeScript + React Flow + xterm.js

控制服务：
Go / Node.js / Rust 后端

执行端：
Agent Runtime Daemon，支持本地和远程部署

终端协议：
WebSocket + PTY

远程能力：
SSH / Agent Daemon / Tunnel

存储：
Postgres + Redis + Object Storage + SQLite local cache
```

更具体一点：

```markdown
MVP 推荐：
React + TypeScript + React Flow + xterm.js
Node.js / Go 后端
SSH2 / PTY
Postgres
WebSocket

长期推荐：
React UI
Go Control Plane
Rust / Go Agent Runtime
Postgres + Redis
Yjs / CRDT Sync
S3 / R2 / MinIO
```

---

# 为什么不能只用 Electron？

Electron 适合本地桌面，但 Web 端有几个天然问题：

```markdown
1. Web 页面不能直接访问本地终端
2. Web 页面不能直接访问用户文件系统
3. Web 页面不能直接 spawn Claude/Codex CLI
4. Web 页面不能直接建立完整 SSH PTY
5. Web 页面无法安全管理多个远程执行环境
```

所以如果要 Web 化，必须引入：

```markdown
Agent Runtime / Daemon
```

也就是一个跑在本地或远程服务器上的小服务，专门负责：

```markdown
- 创建终端
- 启动 CLI
- 读写文件
- 执行命令
- 访问 Git 仓库
- 管理 SSH
- 回传日志
- 同步状态
```

Web 前端只负责展示和控制。

---

# 推荐总体架构

```markdown
┌─────────────────────────────────────────────┐
│              Web / Desktop UI                │
│ React + React Flow + xterm.js                │
│                                             │
│ - 无限画布                                  │
│ - 文件节点                                  │
│ - Agent 节点                                │
│ - SSH 终端节点                              │
│ - Browser 节点                              │
│ - Diff 节点                                 │
└─────────────────────────────────────────────┘
                    │
                    │ HTTPS / WebSocket
                    ▼
┌─────────────────────────────────────────────┐
│              Control Plane                   │
│ Go / Node.js / Rust                          │
│                                             │
│ - 用户 / Workspace                           │
│ - 权限 / Token                               │
│ - 节点状态                                  │
│ - Agent Registry                            │
│ - SSH Connection Manager                     │
│ - Sync Service                              │
│ - Audit Log                                 │
└─────────────────────────────────────────────┘
                    │
      ┌─────────────┼─────────────┐
      │             │             │
      ▼             ▼             ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Local    │  │ Remote   │  │ Remote   │
│ Runtime  │  │ Runtime  │  │ Runtime  │
│ Windows  │  │ Linux A  │  │ Linux B  │
└──────────┘  └──────────┘  └──────────┘
      │             │             │
      ▼             ▼             ▼
 Claude/Codex   Claude/Codex   Git/npm/mvn
 Shell          Docker         Python/Java
```

这个架构比纯桌面更像：

```markdown
AI Coding Control Plane
```

---

# 三种执行模式

你应该支持三种 Runtime 模式。

## 1. Local Runtime

适合个人开发机。

```markdown
Web/Desktop UI
   ↓
localhost Agent Runtime
   ↓
本地 shell / claude / codex / git / npm / mvn
```

用途：

```markdown
- 本机项目开发
- 个人 Claude Code / Codex CLI
- 本地文件访问
- 本地 Git diff
```

实现：

```markdown
Electron 内置 Runtime
或者
独立 localhost daemon
```

---

## 2. SSH Runtime

适合远程服务器。

```markdown
Web UI
   ↓
Control Plane
   ↓ SSH
Remote Server
   ↓
bash / zsh / claude / codex / git
```

用途：

```markdown
- 连接云服务器
- 操作远程项目
- 远程跑测试
- 远程构建
- 远程 Docker / Kubernetes
```

特点：

```markdown
优点：
- 不需要在远程机器安装 daemon
- 只要有 SSH 权限即可

缺点：
- 状态管理弱
- 文件监听麻烦
- 多会话恢复麻烦
- 权限审计较弱
- 跨网络容易不稳定
```

适合第一版 Web 远程能力。

---

## 3. Remote Agent Runtime

适合长期企业级。

```markdown
Web UI
   ↓
Control Plane
   ↓ WebSocket / gRPC
Remote Agent Runtime
   ↓
PTY / File / Git / Docker / Agent CLI
```

用途：

```markdown
- 团队共享远程执行环境
- 持久化 Agent Session
- 多 workspace
- 权限控制
- 审计
- 文件索引
- Git diff 回流
- 浏览器 / Playwright 自动化
```

特点：

```markdown
优点：
- 状态可控
- 安全策略可控
- 会话可恢复
- 文件监听容易
- 日志采集容易
- 可以做资源隔离

缺点：
- 需要安装 agent
- 运维复杂度上升
```

长期最推荐。

---

# 哪个语言更适合？

## 如果考虑 Web + SSH + 跨服务，推荐排序变成：

```markdown
1. Go + React
2. Node.js + React
3. Rust + React
4. Electron-only
5. Tauri-only
```

---

# 方案 1：Go Control Plane + Go/Rust Runtime

这是我最推荐的长期方案。

## 技术栈

```markdown
Frontend:
- React
- TypeScript
- React Flow
- xterm.js
- Zustand
- TanStack Query

Control Plane:
- Go
- Gin / Echo / Fiber
- WebSocket
- gRPC 可选
- PostgreSQL
- Redis
- MinIO / S3

Runtime Agent:
- Go 或 Rust
- PTY
- File Watcher
- Git
- Process Manager
- Docker / SSH
```

## 优点

```markdown
- Go 非常适合写控制平面
- WebSocket、SSH、PTY、文件服务都好写
- 单二进制部署方便
- 远程 Agent 很适合 Go
- 企业部署友好
- 性能和并发足够
- 比 Node 更稳
- 比 Rust 开发快
```

## 缺点

```markdown
- 前后端类型共享不如 TypeScript
- UI 还是要 React
- 某些本地桌面能力不如 Electron 直接
```

## 适合你这个项目吗？

非常适合。

如果目标是：

```markdown
个人本地 + Web 控制台 + SSH + 远程服务器 + 企业内部部署
```

我会推荐：

```markdown
React + Go Control Plane + Go Agent Runtime
```

---

# 方案 2：Node.js / TypeScript 全栈

## 技术栈

```markdown
Frontend:
- React
- TypeScript
- React Flow
- xterm.js

Backend:
- Node.js
- NestJS / Hono / Fastify
- ws / socket.io
- ssh2
- node-pty
- Prisma / Drizzle
- PostgreSQL
```

## 优点

```markdown
- 开发最快
- 前后端都是 TypeScript
- xterm.js + node-pty 天然匹配
- SSH 库成熟
- 很适合 MVP
- 适合快速做 Web 远程终端
```

## 缺点

```markdown
- 长期稳定性不如 Go
- 多租户隔离要小心
- 远程 Agent 长期运行不如 Go/Rust 稳
- 高并发终端会话时资源管理复杂
```

## 适合阶段

```markdown
MVP / 原型 / 小团队快速验证
```

如果你想三五天打一个 Demo，Node 全栈最快。

---

# 方案 3：Rust Control Plane + Rust Runtime

## 技术栈

```markdown
Frontend:
- React
- TypeScript

Backend:
- Rust
- Axum
- Tokio
- WebSocket
- SQLx
- Postgres
- Rust PTY
- Rust SSH
```

## 优点

```markdown
- 性能好
- 安全性强
- 适合长期 Runtime
- 适合本地权限、进程、沙箱
- 适合高可靠 Agent
```

## 缺点

```markdown
- 开发成本高
- 团队门槛高
- 业务迭代速度慢
- Web 管理后台开发没 Go/Node 快
```

## 适合阶段

```markdown
核心 Runtime / 安全沙箱 / 高可靠 Agent
```

我的建议是：

```markdown
Rust 不要一开始全栈用。
可以后期把 Runtime 核心模块用 Rust 重写。
```

---

# 方案 4：Electron + Web 服务混合

这是一个折中方案。

```markdown
Desktop:
- Electron
- React
- node-pty

Web:
- React
- 同一套 Canvas UI

Server:
- Go / Node Control Plane

Runtime:
- Desktop 内置 Local Runtime
- Remote Agent Runtime
```

架构：

```markdown
Desktop App = Web UI + Local Runtime
Web App = Web UI only
Control Plane = 统一同步和远程调度
Runtime Agent = 远程执行
```

优点：

```markdown
- 本地桌面体验好
- Web 端也能用
- UI 代码可以复用
- 本地和远程都支持
```

缺点：

```markdown
- 架构复杂
- 需要同时维护 Desktop 和 Web 部署
```

这个是长期很合理的架构。

---

# 我建议你的最终路线

## 第一阶段：Web + Local Daemon，而不是纯 Electron

如果你已经明确考虑 Web 端，我建议不要从纯 Electron 开始，而是：

```markdown
React Web UI
+
Local Agent Daemon
```

也就是：

```markdown
浏览器打开 http://localhost:xxxx
Local Daemon 提供：
- PTY
- 文件访问
- Claude/Codex CLI 启动
- Git diff
- WebSocket terminal stream
```

这样第一版就天然兼容未来 Web。

## 推荐 MVP 架构

```markdown
Frontend:
React + TypeScript + React Flow + xterm.js

Local Daemon:
Go 或 Node.js

Storage:
SQLite

Communication:
WebSocket + HTTP

Agent:
claude / codex / gemini / opencode as CLI
```

### 如果你更重视开发速度

```markdown
Local Daemon 用 Node.js
```

### 如果你更重视长期可维护

```markdown
Local Daemon 用 Go
```

我更推荐：

```markdown
Go Local Daemon
```

因为后面远程 Agent Runtime 也可以复用。

---

# 具体推荐版本

## 最推荐组合

```markdown
Web/Desktop UI:
- React
- TypeScript
- React Flow
- xterm.js
- Zustand
- TanStack Query
- Tailwind CSS
- Monaco Editor

Control Plane:
- Go
- Gin / Echo
- WebSocket
- PostgreSQL
- Redis
- Casbin / OPA 可选

Runtime Agent:
- Go
- creack/pty
- fsnotify
- go-git
- Docker SDK
- SSH client/server support

Local Storage:
- SQLite

Cloud Storage:
- Postgres
- S3 / MinIO / Cloudflare R2

Sync:
- Yjs / 自研 event log
```

---

# Web 端 SSH 设计

Web 端不能直接 SSH，要通过后端代理。

## SSH Terminal Node

```markdown
Browser
  ↓ WebSocket
Control Plane
  ↓ SSH
Remote Server PTY
```

前端：

```markdown
xterm.js
```

后端：

```markdown
SSH client + PTY request
```

Node 数据结构：

```typescript
interface SshTerminalNode {
  id: string
  type: 'ssh_terminal'
  hostId: string
  cwd?: string
  shell?: string
  sessionId: string
}
```

Host 配置：

```typescript
interface RemoteHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'private_key' | 'agent'
  privateKeyRef?: string
}
```

安全要求：

```markdown
- 密钥加密保存
- 支持 SSH Agent
- 不在前端暴露私钥
- WebSocket session 绑定用户权限
- 命令审计
```

---

# 跨服务器设计

要抽象 Execution Target。

```typescript
type ExecutionTargetType =
  | 'local'
  | 'ssh'
  | 'remote_agent'
  | 'docker'
  | 'kubernetes'
```

```typescript
interface ExecutionTarget {
  id: string
  type: ExecutionTargetType
  name: string
  workspaceRoot: string
  capabilities: {
    pty: boolean
    fileRead: boolean
    fileWrite: boolean
    git: boolean
    browser: boolean
    docker: boolean
  }
}
```

Agent Node 不直接绑定本机，而是绑定 Execution Target：

```typescript
interface AgentNode {
  id: string
  type: 'agent'
  adapter: 'claude' | 'codex' | 'gemini' | 'opencode'
  targetId: string
  cwd: string
  command: string
}
```

这样同一个画布可以有：

```markdown
Claude 本地节点
Codex 远程服务器节点
Gemini Docker 节点
测试服务器 SSH 节点
```

---

# 多端同步怎么做？

Web 端 + 桌面端 + 远程 Runtime 之后，数据要分层。

## 控制层数据

同步：

```markdown
- workspace
- canvas
- nodes
- edges
- tasks
- comments
- node positions
```

存 Postgres。

## 执行层数据

不一定全同步：

```markdown
- terminal logs
- command outputs
- process status
- agent session
```

本地/远程 Runtime 保存，Control Plane 存索引。

## 敏感数据

默认不同步：

```markdown
- env
- API key
- private key
- .env
- terminal raw logs
- private code
```

需要用户授权后同步。

---

# 最终架构建议

如果你的目标只是本地工具：

```markdown
Electron + React + node-pty
```

如果你的目标是 **Web + SSH + 跨服务器 + 多端同步**：

```markdown
React Web UI
+
Go Control Plane
+
Go Runtime Agent
+
xterm.js
+
React Flow
+
Postgres / SQLite
```

这是更合适的。

---

# 我给你的最终选择

## MVP 但兼容未来

```markdown
React + TypeScript + React Flow + xterm.js
Go Local Daemon
SQLite
WebSocket
```

浏览器访问：

```markdown
http://localhost:1420
```

Local Daemon 提供：

```markdown
- /api/workspaces
- /api/files
- /api/terminals
- /api/agents
- /api/git
- /ws/terminal/:sessionId
```

后面要桌面端：

```markdown
用 Electron / Tauri 包一层 Web UI
```

后面要远程：

```markdown
Go Daemon 部署到服务器，注册到 Control Plane
```

后面要团队协作：

```markdown
加 Postgres + 登录 + 权限 + Yjs
```

---

# 推荐演进路线

## Phase 1：Local Web Daemon

```markdown
React Web UI
Go Daemon
SQLite
本地终端
本地文件
Claude/Codex CLI
React Flow 连线
```

## Phase 2：SSH Terminal

```markdown
SSH Host 管理
Web SSH Terminal
远程文件浏览
远程 Agent Node
```

## Phase 3：Remote Runtime Agent

```markdown
服务器安装 agent
agent 注册 control plane
持久化 session
远程 Git/Diff
远程文件索引
```

## Phase 4：Cloud Control Plane

```markdown
账号体系
Workspace 同步
Postgres
对象存储
多人协作
权限审计
```

## Phase 5：Desktop Shell

```markdown
Electron / Tauri 打包
本地托盘
本地 Runtime 自动启动
系统权限管理
```

---

# 最简判断

```markdown
只做本地桌面：
Electron 最适合。

本地 + Web + SSH + 跨服务器：
Go Control Plane + Go Runtime Agent + React Web UI 最适合。

长期安全和高性能：
React UI + Go 控制面 + Rust 核心 Runtime。
```

我的推荐是：

```markdown
React + Go + xterm.js + React Flow
```

这条路最适合你现在设想的 **Armadra + Web + SSH + 跨服务执行**。

---

## 消息 12 · 用户

根据上面的功能 web 端 app端 windows mac linux 能最少量开发的是哪一种 不想维护多套环境等等信息只想维护一套服务一套页面

---

## 消息 13 · ChatGPT

最少维护成本的选择是：

```markdown
一套 Web 页面 + 一套后端服务 + 桌面端只做 WebView 壳
```

也就是：

```markdown
核心方案：
React / TypeScript Web App
+
Go 后端 / Runtime Service
+
WebSocket Terminal
+
SQLite / Postgres
+
桌面端用 Tauri 或 Electron 只包一层
```

最终形态：

```markdown
Web 端：
直接访问 https://your-app.com

Windows / macOS / Linux App：
打开同一套 Web 页面，只是外面套一个桌面壳

本地能力：
通过本机 Local Runtime Service 提供

远程能力：
通过 SSH / Remote Runtime Service 提供
```

---

# 最推荐架构

```markdown
┌─────────────────────────────────────────────┐
│              同一套前端页面                  │
│ React + TypeScript + React Flow + xterm.js  │
│                                             │
│ Web / Windows / macOS / Linux 全部复用       │
└─────────────────────────────────────────────┘
                    │
                    │ HTTP / WebSocket
                    ▼
┌─────────────────────────────────────────────┐
│              同一套后端服务                  │
│ Go Runtime / Control Service                │
│                                             │
│ - 终端 PTY                                  │
│ - Claude / Codex / Gemini CLI 启动           │
│ - 文件访问                                  │
│ - Git Diff                                  │
│ - SSH                                       │
│ - Workspace 管理                            │
│ - 权限控制                                  │
└─────────────────────────────────────────────┘
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
    本机终端      SSH 远程机     Remote Agent
```

---

# 最少维护版本

## 技术选型

```markdown
前端：
- React
- TypeScript
- React Flow
- xterm.js
- Zustand
- Tailwind CSS
- Monaco Editor

后端 / Runtime：
- Go
- WebSocket
- PTY
- SSH
- SQLite
- Git

桌面壳：
- Tauri 2
```

一句话：

```markdown
React Web 页面 + Go 单体服务 + Tauri WebView 壳
```

这是维护量最少、长期也最稳的一种。

---

# 为什么不是 Electron？

Electron 也能做，但如果你说：

```markdown
不想维护多套环境
只想维护一套服务一套页面
同时支持 Web / App / Windows / macOS / Linux
```

那 Electron 不是最优。

Electron 更像：

```markdown
桌面 App 优先
Web 端另说
```

而你的目标更像：

```markdown
Web App 优先
桌面端只是打包入口
```

所以更推荐：

```markdown
Tauri 壳 + Web App
```

Tauri 只负责：

```markdown
- 启动本地 Go Runtime
- 打开 WebView
- 托盘
- 自动更新
- 本地权限提示
```

业务页面、画布、终端 UI 全部还是同一套 React。

---

# 为什么后端选 Go？

因为你这个后端不是普通 CRUD，它要做：

```markdown
- 创建 PTY 终端
- 启动 Claude Code / Codex / Gemini CLI
- 管理进程
- WebSocket 传输终端流
- SSH 远程连接
- 文件读写
- Git Diff
- 跨平台 Windows / macOS / Linux
- 后续还能部署成 Remote Agent
```

Go 非常适合这种 Runtime 服务。

Node 也能做，但长期会有几个问题：

```markdown
- node-pty 跨平台依赖编译麻烦
- 多终端会话资源管理更弱
- 做远程 Agent 长期运行不如 Go 稳
- 单二进制分发不如 Go 简洁
```

Rust 也能做，但开发成本更高。

所以综合最优：

```markdown
Go Runtime Service
```

---

# 最终推荐模式

## 一套前端

```markdown
apps/web
```

负责所有 UI：

```markdown
- 无限画布
- 文件节点
- Agent 节点
- SSH 终端节点
- Browser 节点
- Diff 节点
- 任务节点
- 图片 / 文字 / 标注
```

Web 端和桌面端完全复用。

---

## 一套服务

```markdown
apps/runtime
```

Go 写一个服务，既可以本地运行，也可以远程部署。

它提供：

```markdown
HTTP API:
- /api/workspaces
- /api/files
- /api/agents
- /api/git
- /api/ssh-hosts
- /api/canvas

WebSocket:
- /ws/terminal/:sessionId
- /ws/agent/:sessionId
- /ws/sync
```

---

## 一个桌面壳

```markdown
apps/desktop
```

Tauri 只做壳：

```markdown
- 启动 Go runtime
- 打开 React 页面
- 系统托盘
- 自动更新
- 本地端口检测
- 本地权限提示
```

桌面端不写业务逻辑。

---

# 目录结构建议

```markdown
armadra/
  apps/
    web/
      src/
        canvas/
        nodes/
        terminal/
        browser/
        stores/
        api/

    runtime/
      cmd/
        server/
      internal/
        pty/
        ssh/
        files/
        git/
        agents/
        workspace/
        canvas/
        security/
        sync/
      data/

    desktop/
      src-tauri/
      tauri.conf.json

  packages/
    shared/
      types/
      protocol/
      schemas/
```

---

# 运行方式

## Web 云端模式

```markdown
用户浏览器
   ↓
你的云端 Control Service
   ↓
SSH / Remote Runtime
```

适合：

```markdown
- 团队协作
- 远程服务器
- 企业内部平台
```

---

## 本地模式

```markdown
Tauri App
   ↓
内置 React Web 页面
   ↓
localhost Go Runtime
   ↓
本地 Claude / Codex / Git / 文件
```

适合：

```markdown
- 个人开发机
- 本地项目
- 内网环境
```

---

## 混合模式

```markdown
Tauri App / Web Browser
   ↓
云端 Control Plane
   ↓
本地 Runtime / SSH Runtime / Remote Agent
```

适合长期版本。

---

# 关键点：桌面端不要写独立逻辑

你要避免：

```markdown
Web 一套路由
Electron 一套路由
Tauri 一套路由
后端一套
本地又一套
```

正确做法是：

```markdown
所有 UI 都在 apps/web
所有 Runtime 都在 apps/runtime
apps/desktop 只是一个启动器
```

桌面端只处理：

```markdown
- 启动 runtime 二进制
- 检查端口
- 打开 WebView
- 关闭时清理进程
```

---

# 最少维护方案排名

## 第一名：React + Go Runtime + Tauri Shell

```markdown
维护成本：低
跨平台：强
Web 支持：强
本地能力：强
长期可扩展：强
推荐度：最高
```

这是你的最佳选择。

---

## 第二名：React + Node Runtime + Electron Shell

```markdown
维护成本：中
开发速度：快
桌面体验：强
Web 支持：中
长期稳定性：中
```

适合快速 Demo，但长期不如 Go Runtime 干净。

---

## 第三名：纯 Web + 云端 Go 服务

```markdown
维护成本：低
Web 支持：强
本地能力：弱
CLI / 文件访问：依赖 SSH / Remote Agent
```

如果你完全不需要本地 Claude Code/Codex CLI，可以这样做。

但你明显需要本地终端，所以不够。

---

## 第四名：Tauri + Rust 全家桶

```markdown
维护成本：中高
性能：强
安全：强
开发速度：慢
```

长期可以考虑，但第一版不建议。

---

# 最终结论

你想要：

```markdown
Web 端
App 端
Windows
macOS
Linux
最少开发
不维护多套环境
一套服务
一套页面
```

最适合的是：

```markdown
React Web App
+
Go Runtime Service
+
Tauri Desktop Shell
```

最终只维护两块核心：

```markdown
1. apps/web：一套页面
2. apps/runtime：一套服务
```

桌面端只是包装，不承载业务。

可以这样定技术栈：

```markdown
Frontend:
React + TypeScript + React Flow + xterm.js + Tailwind + Zustand

Runtime:
Go + WebSocket + PTY + SSH + SQLite + Git

Desktop:
Tauri 2 WebView Shell

Storage:
本地 SQLite
云端 Postgres，可后置

Sync:
先普通 API + WebSocket
后续再加 Yjs
```

这条路线最符合你的目标：**一套页面、一套服务，同时覆盖 Web / Windows / macOS / Linux。**

---

## 消息 14 · 用户

最推荐的 给出详细的完整的设计方案 包含功能设计 还有rust 版本

---

## 消息 15 · ChatGPT

我会给你一版“最推荐主线方案”，再单独给 Rust Runtime 版本。主线仍然坚持一套页面、一套服务，桌面端只做壳，避免后期维护炸裂。

---

## 消息 16 · ChatGPT

下面给你一版**最推荐完整设计方案**。目标是满足你前面所有约束：

```markdown
一套页面
一套服务
支持 Web
支持 Windows / macOS / Linux App
支持本地终端
支持 SSH / 跨服务器
支持 Claude Code / Codex / Gemini / OpenCode 等 CLI
支持无限画布、连线、文件、浏览器、贴图、文字、标注
后续支持多端同步
尽量不维护多套环境
```

最终推荐：

```markdown
React Web App
+
Rust Runtime Service
+
Tauri Desktop Shell
```

也就是：

```markdown
apps/web      一套页面
apps/runtime  一套 Rust 服务
apps/desktop  Tauri 壳，只负责启动 runtime + 打开 webview
```

Tauri 官方支持任意前端框架，并用 Rust 做应用逻辑；它面向 Windows、macOS、Linux，也支持移动端扩展，所以很适合“同一套 Web 页面 + 桌面壳”的路线。[![图片](https://www.google.com/s2/favicons?domain=https://v2.tauri.app&sz=128)Tauri+1](https://v2.tauri.app/?utm_source=chatgpt.com)

---

# 1. 总体定位

项目可以定义为：

```markdown
Armadra

一个 local-first 的 AI 编程控制平面。

用户可以在无限画布上创建文件、目录、终端、Agent、浏览器、截图、文档、任务、Diff 等节点；
通过连线把上下文传给 Claude Code、Codex、Gemini CLI、OpenCode 等 CLI；
CLI 在本地或远程真实终端中运行；
执行日志、Git Diff、测试结果、浏览器状态可以回流成画布节点；
同一套页面可运行在 Web、Windows、macOS、Linux。
```

一句话：

```markdown
把 AI Coding 从“散落的终端窗口”变成“可视化、可编排、可回放、可同步的工作流画布”。
```

---

# 2. 最推荐技术栈

## 前端

```markdown
React
TypeScript
Vite
React Flow
xterm.js
Tailwind CSS
Zustand
TanStack Query
Monaco Editor
Yjs，后期同步用
```

选择 React Flow 的原因：你的核心不是纯白板，而是 **节点 + 连线 + 上下文传递 + Agent 编排**。React Flow 的节点就是 React 组件，适合嵌入终端、文件面板、浏览器预览、Diff 面板等交互节点；它也支持自定义节点、连接点和边。[![图片](https://www.google.com/s2/favicons?domain=https://reactflow.dev&sz=128)React Flow+2![图片](https://www.google.com/s2/favicons?domain=https://reactflow.dev&sz=128)React Flow+2](https://reactflow.dev/?utm_source=chatgpt.com)

xterm.js 用来做浏览器里的终端组件，它本身就是给 Web 应用嵌入完整终端能力的前端组件，也被 VS Code 等项目用于集成终端。[![图片](https://www.google.com/s2/favicons?domain=https://xtermjs.org&sz=128)Xterm.js+1](https://xtermjs.org/?utm_source=chatgpt.com)

## Runtime 服务

```markdown
Rust
Axum
Tokio
WebSocket
portable-pty / shell process manager
russh / openssh / ssh2
notify
git2 / git CLI wrapper
sqlx
SQLite
serde
tower
tracing
```

## 桌面壳

```markdown
Tauri 2
```

桌面端不写业务，只做：

```markdown
启动 Rust runtime
打开 WebView
托盘
自动更新
本地端口探测
权限提示
```

## 存储

```markdown
本地：
SQLite

云端后置：
Postgres
Redis
S3 / R2 / MinIO

同步后置：
Yjs / CRDT
```

Yjs 是 CRDT 协作框架，提供 Map、Array 等共享类型，能自动同步并合并并发修改，适合后续多端画布同步。[![图片](https://www.google.com/s2/favicons?domain=https://docs.yjs.dev&sz=128)Yjs 文档+1](https://docs.yjs.dev/?utm_source=chatgpt.com)

---

# 3. 为什么我最终推荐 Rust Runtime，而不是 Go / Node？

你现在的最终目标已经不是简单 MVP，而是：

```markdown
Web + App
本地终端
SSH
跨服务器
权限控制
长期 Runtime
多端同步
本地文件访问
安全边界
```

这类东西本质上是一个 **本地/远程执行内核**。

Rust 更适合做这个内核：

```markdown
进程管理更稳
并发模型清晰
内存安全
适合长期运行 daemon
适合权限边界
适合桌面端与 Tauri 统一
适合后期做 sandbox / policy engine
```

缺点也很明显：

```markdown
开发速度比 Go / Node 慢
PTY / SSH / WebSocket / 文件 watcher 要写得更严谨
团队 Rust 门槛更高
```

但是你说的是“最推荐、完整方案”，不是最快 Demo，所以我会选：

```markdown
React + Rust Runtime + Tauri
```

如果只求 2 周内快速验证，我会选 Go 或 Node；但如果要长期做成产品，Rust 版本更值得。

---

# 4. 总体架构

```markdown
┌──────────────────────────────────────────────┐
│                 apps/web                      │
│ React + TypeScript + React Flow + xterm.js    │
│                                              │
│ - Canvas                                     │
│ - Terminal Node                              │
│ - Agent Node                                 │
│ - File / Folder Node                         │
│ - Browser Node                               │
│ - Task Node                                  │
│ - Diff Node                                  │
│ - Image / Markdown / Annotation Node          │
└──────────────────────────────────────────────┘
                      │
                      │ HTTP / WebSocket
                      ▼
┌──────────────────────────────────────────────┐
│              apps/runtime                     │
│ Rust Runtime Service                          │
│                                              │
│ - Workspace Manager                          │
│ - PTY Manager                                │
│ - SSH Manager                                │
│ - Agent Manager                              │
│ - File Access Manager                        │
│ - Git Monitor                                │
│ - Browser Controller                         │
│ - Permission Engine                          │
│ - Sync Gateway                               │
│ - SQLite Storage                             │
└──────────────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   Local Shell      SSH Host     Remote Runtime
   Claude Code      Linux Dev    Agent Daemon
   Codex CLI        Build Box    Future
   Gemini CLI
```

桌面端：

```markdown
┌──────────────────────────────────────────────┐
│               apps/desktop                    │
│ Tauri Shell                                   │
│                                              │
│ - 启动 runtime 二进制                         │
│ - 打开 apps/web 页面                          │
│ - 托盘 / 自动更新 / 本地通知                  │
└──────────────────────────────────────────────┘
```

Web 端：

```markdown
Browser
  ↓
Rust Runtime / Cloud Control Plane
  ↓
Local Runtime / SSH / Remote Runtime
```

---

# 5. 三种运行模式

## 模式一：纯本地桌面模式

适合个人开发。

```markdown
Tauri App
  ↓
localhost Rust Runtime
  ↓
本地项目 / 本地 shell / Claude Code / Codex CLI
```

特点：

```markdown
无需云端
数据存在 SQLite
终端日志默认本地
最适合个人工具
```

---

## 模式二：Web + Local Runtime

适合浏览器访问本地服务。

```markdown
Chrome / Edge
  ↓
http://localhost:14288
  ↓
Rust Runtime
  ↓
本地终端 / 本地文件
```

特点：

```markdown
不需要桌面壳
但浏览器访问本地 runtime 需要鉴权 token
适合开发调试和高级用户
```

---

## 模式三：Web + SSH / Remote Runtime

适合跨服务器。

```markdown
Web UI
  ↓
Control Plane / Runtime
  ↓
SSH Host / Remote Agent
  ↓
远程 shell / 远程项目 / 远程 Claude Code
```

特点：

```markdown
适合云服务器
适合团队环境
适合企业内网部署
```

---

# 6. 核心功能设计

## 6.1 Workspace

Workspace 是最高级别的工作区。

```typescript
interface Workspace {
  id: string
  name: string
  mode: 'local' | 'ssh' | 'remote'
  roots: WorkspaceRoot[]
  createdAt: number
  updatedAt: number
}
```

WorkspaceRoot：

```typescript
interface WorkspaceRoot {
  id: string
  type: 'local' | 'ssh' | 'remote'
  path: string
  targetId: string
  readOnly: boolean
}
```

功能：

```markdown
创建工作区
选择本地目录
绑定 SSH Host
绑定远程 Runtime
管理授权目录
查看 Git 状态
查看文件树
```

---

## 6.2 Canvas 画布

画布是工作流状态空间。

用 React Flow 做第一版，因为它天然支持 node / edge 模型。后续如果需要自由手绘、贴图、白板，可以追加 tldraw-like annotation layer。

Canvas 功能：

```markdown
缩放 / 拖拽 / 框选
节点创建
节点连接
节点分组
节点搜索
自动布局
节点状态标记
右键菜单
边语义选择
保存 / 恢复
```

---

## 6.3 节点类型

### Terminal Node

普通终端节点。

```typescript
interface TerminalNode {
  id: string
  type: 'terminal'
  targetId: string
  sessionId?: string
  cwd: string
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish'
  status: 'idle' | 'running' | 'closed' | 'failed'
}
```

功能：

```markdown
新建终端
选择执行目标
选择工作目录
输入输出
复制粘贴
resize
保存日志
重启 session
```

---

### Agent Node

Agent Node 第一阶段本质是“带启动模板的终端”。

```typescript
interface AgentNode {
  id: string
  type: 'agent'
  adapter: 'claude' | 'codex' | 'gemini' | 'opencode' | 'custom'
  targetId: string
  cwd: string
  command: string
  args: string[]
  sessionId?: string
  status: 'idle' | 'running' | 'waiting_approval' | 'done' | 'failed'
}
```

功能：

```markdown
启动 Claude Code
启动 Codex CLI
启动 Gemini CLI
启动 OpenCode
自定义命令
从连接节点收集上下文
将上下文 paste 到终端
用户随时接管
```

第一版不做深度协议适配，只把它们当 CLI。

---

### File Node

```typescript
interface FileNode {
  id: string
  type: 'file'
  targetId: string
  path: string
  relativePath: string
  mimeType: string
  size: number
  readonly: boolean
  syncPolicy: 'local_only' | 'metadata_only' | 'full_sync'
}
```

功能：

```markdown
展示文件名
打开文件
预览内容
复制路径
加入上下文
查看 Git diff
标记只读 / 可写
```

---

### Folder Node

```typescript
interface FolderNode {
  id: string
  type: 'folder'
  targetId: string
  path: string
  includePatterns: string[]
  excludePatterns: string[]
}
```

功能：

```markdown
文件树浏览
拖出文件节点
索引目录
作为 Agent 上下文
限制扫描范围
```

---

### Task Node

```typescript
interface TaskNode {
  id: string
  type: 'task'
  title: string
  content: string
  status: 'todo' | 'running' | 'blocked' | 'done' | 'failed'
  priority: 'low' | 'medium' | 'high'
}
```

功能：

```markdown
描述任务
连接到 Agent
作为上下文输入
展示执行状态
```

---

### Browser Node

第一阶段先做 URL 预览 / 外部打开；第二阶段做 CDP 控制。

```typescript
interface BrowserNode {
  id: string
  type: 'browser'
  targetId?: string
  url: string
  mode: 'external' | 'webview' | 'cdp'
  title?: string
  screenshotPath?: string
  consoleErrors?: string[]
}
```

功能：

```markdown
打开 localhost
打开文档
保存截图
捕获 console error，第二阶段
捕获 network error，第二阶段
DOM 摘要，第三阶段
```

---

### Diff Node

```typescript
interface DiffNode {
  id: string
  type: 'diff'
  targetId: string
  repoPath: string
  sourceSessionId?: string
  files: DiffFile[]
}
```

```typescript
interface DiffFile {
  path: string
  additions: number
  deletions: number
  patch: string
}
```

功能：

```markdown
展示 Agent 改了哪些文件
展示 patch
连回 File Node
支持回滚
支持生成 commit message
```

---

### Log Node

```typescript
interface LogNode {
  id: string
  type: 'log'
  sessionId: string
  title: string
  content: string
  level: 'info' | 'warn' | 'error'
}
```

功能：

```markdown
从终端输出拖拽生成
保存错误日志
连给 Agent 作为上下文
```

---

### Image / Screenshot Node

```typescript
interface ImageNode {
  id: string
  type: 'image'
  path: string
  source: 'local' | 'screenshot' | 'clipboard'
  caption?: string
}
```

功能：

```markdown
贴图
截图
UI 标注
连给 Agent
```

---

### Markdown / Note Node

```typescript
interface MarkdownNode {
  id: string
  type: 'markdown'
  title: string
  content: string
}
```

功能：

```markdown
需求文档
Prompt
设计说明
问题记录
```

---

## 6.4 边 / 连线语义

这是项目的核心。

```typescript
type EdgeType =
  | 'context'
  | 'input'
  | 'output'
  | 'reference'
  | 'depends_on'
  | 'patches'
  | 'verifies'
  | 'opens'
```

边结构：

```typescript
interface CanvasEdge {
  id: string
  source: string
  target: string
  type: EdgeType
  label?: string
  permission?: EdgePermission
}
```

权限：

```typescript
interface EdgePermission {
  read: boolean
  write: boolean
  execute: boolean
  syncToCloud: boolean
}
```

例子：

```markdown
Task Node --context--> Claude Agent
File Node --input/read--> Claude Agent
Screenshot Node --context--> Codex Agent
Claude Agent --patches--> File Node
Browser Node --verifies--> Task Node
Diff Node --output--> Claude Agent
```

连线不是装饰，而是：

```markdown
上下文传递
权限表达
依赖关系
执行结果回流
```

---

# 7. Context Bundle 设计

当用户点击 Agent Node 的 “Run with Context”，系统根据连线生成上下文包。

```typescript
interface ContextBundle {
  task?: {
    title: string
    content: string
  }

  files: Array<{
    path: string
    relativePath: string
    mode: 'path_only' | 'summary' | 'full_content'
    content?: string
    summary?: string
  }>

  folders: Array<{
    path: string
    includePatterns: string[]
    excludePatterns: string[]
  }>

  notes: Array<{
    title: string
    content: string
  }>

  images: Array<{
    path: string
    caption?: string
  }>

  browserStates: Array<{
    url: string
    title?: string
    consoleErrors?: string[]
    screenshotPath?: string
  }>

  logs: Array<{
    title: string
    content: string
  }>
}
```

第一阶段生成 Prompt：

```markdown
当前项目目录：
{cwd}

任务：
{task}

你可以重点查看以下文件：
- src/App.tsx
- package.json
- src/router/index.ts

相关说明：
{notes}

相关日志：
{logs}

请在本地项目中完成修改。修改后请说明改动点，并建议我运行哪些命令验证。
```

然后把这段内容 paste 到真实终端中的 Claude Code / Codex CLI。

---

# 8. Runtime API 设计

## HTTP API

```markdown
GET    /api/health
GET    /api/version

POST   /api/workspaces
GET    /api/workspaces
GET    /api/workspaces/:id
DELETE /api/workspaces/:id

GET    /api/files/tree
GET    /api/files/read
POST   /api/files/write
POST   /api/files/search

POST   /api/terminals
GET    /api/terminals/:id
POST   /api/terminals/:id/resize
POST   /api/terminals/:id/kill

GET    /api/agents
POST   /api/agents/detect
POST   /api/agents/start
POST   /api/agents/run-with-context

GET    /api/git/status
GET    /api/git/diff
POST   /api/git/snapshot

POST   /api/ssh/hosts
GET    /api/ssh/hosts
POST   /api/ssh/test
POST   /api/ssh/terminals

GET    /api/canvases
POST   /api/canvases
PUT    /api/canvases/:id
```

## WebSocket

```markdown
/ws/terminal/:sessionId
/ws/agent/:sessionId
/ws/events
/ws/sync
```

Terminal WebSocket 消息：

```typescript
type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }

type TerminalServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string }
```

---

# 9. Rust Runtime 模块设计

```markdown
apps/runtime/
  Cargo.toml
  src/
    main.rs
    config.rs
    state.rs

    api/
      mod.rs
      health.rs
      workspace.rs
      terminal.rs
      agent.rs
      files.rs
      git.rs
      ssh.rs
      canvas.rs

    ws/
      mod.rs
      terminal_ws.rs
      events_ws.rs
      sync_ws.rs

    runtime/
      mod.rs
      targets.rs
      local.rs
      ssh.rs
      remote.rs

    pty/
      mod.rs
      session.rs
      manager.rs

    agents/
      mod.rs
      adapter.rs
      claude.rs
      codex.rs
      gemini.rs
      opencode.rs
      custom.rs

    files/
      mod.rs
      access.rs
      watcher.rs
      indexer.rs

    git/
      mod.rs
      monitor.rs
      diff.rs

    security/
      mod.rs
      permissions.rs
      redactor.rs
      command_policy.rs

    storage/
      mod.rs
      db.rs
      models.rs
      migrations.rs

    ssh/
      mod.rs
      client.rs
      session.rs

    browser/
      mod.rs
      controller.rs
```

---

# 10. Execution Target 抽象

为了同时支持本地、SSH、远程 Runtime，需要统一抽象：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TargetKind {
    Local,
    Ssh,
    RemoteAgent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionTarget {
    pub id: String,
    pub name: String,
    pub kind: TargetKind,
    pub workspace_root: String,
    pub capabilities: TargetCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetCapabilities {
    pub pty: bool,
    pub file_read: bool,
    pub file_write: bool,
    pub git: bool,
    pub browser: bool,
    pub docker: bool,
}
```

Terminal / Agent 都不直接绑定本地，而是绑定 target：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartTerminalRequest {
    pub target_id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
}
```

这样同一个画布可以同时有：

```markdown
本地 Claude Code
远程 SSH Codex
Linux 服务器测试终端
远程 Docker 构建节点
```

---

# 11. PTY Manager 设计

```rust
pub struct PtyManager {
    sessions: DashMap<String, PtySessionHandle>,
}

pub struct PtySessionHandle {
    pub id: String,
    pub target_id: String,
    pub cwd: String,
    pub created_at: DateTime<Utc>,
    pub stdin_tx: mpsc::Sender<Vec<u8>>,
    pub output_rx: broadcast::Sender<Vec<u8>>,
}
```

能力：

```markdown
create_session
write
resize
kill
subscribe_output
save_log
```

本地 PTY：

```markdown
Windows: PowerShell / cmd
macOS: zsh / bash
Linux: bash / zsh / fish
```

SSH PTY：

```markdown
通过 SSH request_pty 创建远程 pseudo terminal
WebSocket 只负责转发输入输出
```

---

# 12. Agent Adapter 设计

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentAdapterInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub detected: bool,
    pub version: Option<String>,
}

pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn default_command(&self) -> &'static str;
    fn default_args(&self) -> Vec<String>;

    fn build_context_prompt(&self, bundle: &ContextBundle) -> String;
}
```

Claude 示例：

```rust
pub struct ClaudeAdapter;

impl AgentAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn name(&self) -> &'static str {
        "Claude Code"
    }

    fn default_command(&self) -> &'static str {
        "claude"
    }

    fn default_args(&self) -> Vec<String> {
        vec![]
    }

    fn build_context_prompt(&self, bundle: &ContextBundle) -> String {
        build_common_prompt(bundle)
    }
}
```

第一阶段 Adapter 只做：

```markdown
检测 CLI 是否存在
生成启动命令
生成上下文 Prompt
启动终端
paste Prompt
```

不要做：

```markdown
解析 Claude 内部事件
绕过授权
自动 approval
模拟隐藏协议
```

---

# 13. SSH 设计

SSH Host：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHost {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: SshAuthType,
    pub private_key_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshAuthType {
    Password,
    PrivateKey,
    Agent,
}
```

SSH 功能：

```markdown
主机管理
连接测试
远程终端
远程文件树
远程 Agent Node
远程 Git diff
```

密钥安全：

```markdown
私钥不进前端
密码不明文落库
使用系统 keychain，后续
本地加密存储，MVP
WebSocket session 绑定用户
```

---

# 14. 文件访问权限设计

Workspace 授权根目录：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRoot {
    pub id: String,
    pub target_id: String,
    pub path: String,
    pub read_only: bool,
}
```

所有文件访问先过 Permission Engine：

```rust
pub struct PermissionEngine {
    roots: Vec<WorkspaceRoot>,
    command_policy: CommandPolicy,
}

impl PermissionEngine {
    pub fn can_read_path(&self, target_id: &str, path: &Path) -> bool {
        // 必须在授权 root 内
        true
    }

    pub fn can_write_path(&self, target_id: &str, path: &Path) -> bool {
        // root 不只读，且路径允许
        true
    }

    pub fn should_confirm_command(&self, cmd: &str) -> bool {
        // 匹配危险命令
        false
    }
}
```

默认危险命令：

```markdown
rm -rf
sudo
chmod -R
chown -R
git reset --hard
git push --force
npm publish
docker system prune
curl ... | sh
Invoke-WebRequest ... | iex
del /s /q
format
```

---

# 15. 日志脱敏

Secret Redactor：

```rust
pub struct SecretRedactor {
    patterns: Vec<Regex>,
}
```

默认脱敏：

```markdown
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
Authorization: Bearer xxx
password=xxx
token=xxx
secret=xxx
x-api-key
.env 内容
```

终端日志策略：

```markdown
默认本地保存
默认不同步云端
用户手动选择后才同步
同步前脱敏
```

---

# 16. Git / Diff 回流

执行前：

```markdown
保存 git status snapshot
```

执行后：

```markdown
重新读取 git status
计算 changed files
读取 git diff
创建 Diff Node
Diff Node 连回被修改的 File Node
```

Diff 回流流程：

```markdown
Agent Node running
   ↓
session closed / user clicked collect diff
   ↓
runtime git diff
   ↓
web 创建 Diff Node
   ↓
Diff Node --patches--> File Node
```

---

# 17. 数据库设计

## workspaces

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## targets

```sql
CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## workspace_roots

```sql
CREATE TABLE workspace_roots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  path TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

## canvases

```sql
CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## nodes

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL,
  height REAL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## edges

```sql
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## terminal_sessions

```sql
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  shell TEXT,
  command TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

## terminal_logs

```sql
CREATE TABLE terminal_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

## ssh_hosts

```sql
CREATE TABLE ssh_hosts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  secret_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

---

# 18. 前端目录设计

```markdown
apps/web/
  src/
    main.tsx
    App.tsx

    api/
      client.ts
      terminal.ts
      workspace.ts
      files.ts
      agents.ts
      git.ts
      ssh.ts

    canvas/
      CanvasPage.tsx
      nodeTypes.ts
      edgeTypes.ts
      contextBundle.ts

      nodes/
        TerminalNode.tsx
        AgentNode.tsx
        FileNode.tsx
        FolderNode.tsx
        TaskNode.tsx
        BrowserNode.tsx
        DiffNode.tsx
        LogNode.tsx
        ImageNode.tsx
        MarkdownNode.tsx

      edges/
        ContextEdge.tsx
        InputEdge.tsx
        OutputEdge.tsx
        PatchEdge.tsx

    terminal/
      XtermView.tsx
      useTerminalSession.ts

    workspace/
      WorkspaceList.tsx
      WorkspaceCreate.tsx
      FileTree.tsx

    stores/
      canvasStore.ts
      workspaceStore.ts
      sessionStore.ts

    components/
      Layout.tsx
      Sidebar.tsx
      Inspector.tsx
      Toolbar.tsx
```

---

# 19. Monorepo 结构

```markdown
armadra/
  apps/
    web/
      package.json
      vite.config.ts
      src/

    runtime/
      Cargo.toml
      src/
      migrations/

    desktop/
      src-tauri/
      tauri.conf.json
      package.json

  packages/
    shared/
      src/
        types.ts
        schemas.ts
        protocol.ts

  docs/
    architecture.md
    security.md
    protocol.md
```

核心原则：

```markdown
apps/web 是唯一页面
apps/runtime 是唯一服务
apps/desktop 只是壳
```

---

# 20. 桌面端 Tauri 设计

Tauri 负责：

```markdown
启动 runtime
等待 runtime ready
打开 webview
退出时关闭 runtime
托盘图标
本地通知
自动更新，后置
```

桌面启动流程：

```markdown
1. Tauri 启动
2. 检查 runtime 是否已运行
3. 如果没有，启动内置 runtime 二进制
4. runtime 随机或固定端口启动
5. Tauri 打开 http://127.0.0.1:{port}
6. 前端通过 HTTP / WebSocket 连接 runtime
```

不建议把大量业务逻辑写在 Tauri command 里，否则会变成两套后端。

---

# 21. Web 部署形态

后期有两种 Web 形态。

## 私有本地 Web

```markdown
用户运行 runtime
浏览器访问 localhost
```

## 云端控制台

```markdown
用户访问 cloud app
cloud app 连接：
- SSH Host
- Remote Runtime Agent
- 用户本地 Runtime，后期通过 tunnel
```

---

# 22. 多端同步设计

第一版：

```markdown
SQLite 本地保存
手动导入导出 workspace
```

第二版：

```markdown
账号系统
Postgres 保存 workspace/canvas/node/edge 元数据
对象存储保存图片、截图、附件
终端日志默认不同步
```

第三版：

```markdown
Yjs 同步画布状态
多人实时协作
节点锁
评论
Presence 光标
```

同步策略：

```markdown
local_only:
  不同步

metadata_only:
  同步路径、标题、摘要，不同步内容

full_sync:
  用户授权后同步完整内容
```

---

# 23. MVP 功能范围

第一版不要做太大。最小闭环如下：

```markdown
1. 启动 Rust runtime
2. 打开 React 页面
3. 创建 Workspace
4. 选择本地目录
5. 画布创建 Folder Node
6. 从文件树拖 File Node
7. 创建 Agent Node
8. Agent Node 启动 claude / codex / gemini
9. xterm.js 显示真实终端
10. File Node / Task Node 连到 Agent Node
11. Run with Context
12. runtime 把上下文 paste 到终端
13. 用户在终端中确认 / 接管
14. 执行结束后收集 git diff
15. 生成 Diff Node
16. SQLite 保存画布
```

这个闭环就足够验证价值。

---

# 24. 第二阶段功能

```markdown
SSH Host 管理
SSH Terminal Node
远程 File Node
远程 Agent Node
Browser Node 打开 localhost
console error 捕获
终端日志拖拽生成 Log Node
Diff 回滚
任务状态流转
上下文模板管理
```

---

# 25. 第三阶段功能

```markdown
Remote Runtime Agent
多端同步
账号系统
团队 workspace
权限角色
审计日志
Yjs 实时协作
对象存储
浏览器 CDP 控制
Playwright 自动验证
Agent 执行回放
```

---

# 26. Rust 版本关键 crate 建议

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
tower = "0.5"
tower-http = "0.6"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
tracing = "0.1"
tracing-subscriber = "0.3"
dashmap = "6"
anyhow = "1"
thiserror = "2"
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "chrono", "uuid"] }
chrono = { version = "0.4", features = ["serde"] }
notify = "8"
regex = "1"
portable-pty = "0.9"
git2 = "0.20"
```

SSH crate 可以根据实现取舍：

```markdown
russh
openssh
ssh2
```

实际工程里，SSH 的坑比较多，可以先把 SSH 放第二阶段。

---

# 27. Rust Runtime 最小示意

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let state = AppState::new().await?;

    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(api::health))
        .route("/api/terminals", axum::routing::post(api::create_terminal))
        .route("/ws/terminal/{id}", axum::routing::get(ws::terminal_ws))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:14288").await?;

    tracing::info!("runtime listening on http://127.0.0.1:14288");

    axum::serve(listener, app).await?;

    Ok(())
}
```

Terminal WS 简化逻辑：

```rust
pub async fn terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        let _ = handle_terminal_socket(socket, state, session_id).await;
    })
}
```

PTY Manager 思路：

```rust
impl PtyManager {
    pub async fn create_local_session(
        &self,
        req: StartTerminalRequest,
    ) -> anyhow::Result<String> {
        let session_id = uuid::Uuid::new_v4().to_string();

        // 创建 PTY
        // spawn shell / command
        // 建立 stdin channel
        // 建立 output broadcast
        // 注册 session

        Ok(session_id)
    }

    pub async fn write(&self, session_id: &str, data: Vec<u8>) -> anyhow::Result<()> {
        // 找到 session stdin_tx，写入
        Ok(())
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        // 调整 PTY size
        Ok(())
    }
}
```

---

# 28. 安全边界

你这个项目风险点很高，因为它能执行真实命令。

必须有这些默认策略：

```markdown
1. Runtime 默认只监听 127.0.0.1
2. Web 访问 runtime 必须带本地 token
3. token 首次启动生成，存在本地 config
4. 文件访问必须在 workspace root 内
5. 终端日志默认不同步
6. SSH 私钥不进前端
7. 危险命令提示确认
8. 云同步默认 metadata_only
9. .env / secret 自动脱敏
10. Agent 修改文件后生成 Diff Node，让用户可审查
```

---

# 29. 推荐开发顺序

## Week 1：基础骨架

```markdown
Rust runtime 启动
React 页面连接 runtime
SQLite 初始化
Workspace 创建
React Flow 画布
节点保存 / 恢复
```

## Week 2：终端闭环

```markdown
PTY Manager
xterm.js
WebSocket 输入输出
Terminal Node
本地 shell
```

## Week 3：Agent 闭环

```markdown
Agent Node
Claude/Codex/Gemini command detect
Run with Context
Task/File -> Agent 连线
paste prompt 到终端
```

## Week 4：文件与 Diff

```markdown
File Tree
File Node
Folder Node
Git status
Git diff
Diff Node
```

## Week 5：SSH

```markdown
SSH Host
SSH Terminal Node
远程 shell
远程工作目录
```

## Week 6：桌面壳

```markdown
Tauri 启动 runtime
WebView 打开页面
打包 Windows/macOS/Linux
```

---

# 30. 最终结论

你要的“最少维护、一套页面、一套服务、Web + Windows/macOS/Linux App + SSH + 本地 CLI”最推荐：

```markdown
React + TypeScript + React Flow + xterm.js
+
Rust Runtime Service
+
Tauri Desktop Shell
```

不要做：

```markdown
Web 一套
Electron 一套
Tauri 一套
后端一套
本地 Runtime 又一套
```

正确边界是：

```markdown
apps/web：
唯一 UI

apps/runtime：
唯一执行服务

apps/desktop：
只负责包装和启动
```

产品闭环先打穿这一条：

```markdown
File / Task / Log / Screenshot Node
        ↓ 连线作为上下文
Agent Terminal Node
        ↓ Claude Code / Codex / Gemini CLI
真实本地或远程终端执行
        ↓
Git Diff / Test Result / Log 回流画布
```

这个闭环成立，后面再加 SSH、Remote Runtime、多端同步、团队协作，架构不会推倒重来。

