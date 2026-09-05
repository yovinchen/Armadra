# 实现状态与验证证据

> 更新：2026-09-04  
> 需求基线：[requirements.md](./requirements.md) · 实施契约：[v3-agent-terminal-plan.md](./v3-agent-terminal-plan.md)（画布层由 [tldraw-canvas-plan.md](./tldraw-canvas-plan.md) 取代）

## v4 tldraw 画布（2026-09-04，分支 `main`，未合并）

按 [tldraw-canvas-plan.md](./tldraw-canvas-plan.md) 把画布层从 React Flow 换成
tldraw 5.4，Phase 0–4 全部实施。跨 agent 的交接细节在
[phase1-handoff.md](./phase1-handoff.md)。

**一句话**：tldraw 的 store 成为画布在内存里的唯一真相。Agent 终端、便签、
编辑器等节点是自定义 `armadra` shape，分组是原生 `frame`，上下文链接是自定义
`link` shape，手绘 / 几何 / 文字 / 图片 / 高亮是 tldraw 原生 shape。持久化分两条
通道：节点与连线仍是 Runtime 的 `nodes` / `edges` 表，白板原生内容存成一份 tldraw
快照放在 `boards.whiteboard_json`。

### 各阶段实现

| 阶段 | 实现 |
| --- | --- |
| Phase 0 · PoC | tldraw 5.4 + `getAssetUrlsByImport()` 自托管字体图标（`optimizeDeps.exclude: ["@tldraw/assets"]` 必需）；四条风险全部证伪或给出对策：视口裁剪只 `display:none` 不卸载组件（仍设 `canCull() => false`，否则 `FitAddon` 量到 0×0）、体内指针用合成事件 `stopPropagation` 就够、滚轮必须原生监听且分两相、tldraw 快捷键用 `TLUiOverrides` 删 `kbd` 摘干净 |
| Phase 1 · 节点画布迁移 | `canvas/sync/`（`project` / `derive` / `snapshot` / `pushed` / `use-store-sync`）双向同步；`canvas-store` 动作签名不变、内部驱动 editor，`history` 字段删除、撤销转调 `editor.undo()`；`ArmadraShapeUtil` + `NodeShell` 去 React Flow；Runtime 迁移 0009 `boards.whiteboard_json` + 资产接口 + 导出泛化；Dock / 命令面板 / 侧栏改用 `editor-context`。`apps/web/src` 全树 `@xyflow/react` = 0 |
| Phase 2 · 连线与派生层 | 箭头 ↔ edge 双向（身份记在 shape props、合法性在交互结束时判、删节点级联删边）；rope 与子代理卡片迁到 `components.OnTheCanvas`；缩略图按 Agent 状态描边（`StatusMinimap` 整块自绘） |
| Phase 3 · 白板能力 | Dock 工具组 10 项 + 工具键 + 样式面板换肤 + shape 右键菜单 + 锁定画布；`registerExternalContentHandler` 分流（图片 → 原生 image shape 走资产接口，文本 / URL → 原生 text shape，OS 路径 → `editor` / `files` 节点）；`draw` / `image` 节点迁移成原生 shape，Runtime 白名单收紧成「只读不写」；`POST .../assets/import` 按路径导入；上下文链接改成自定义 `link` shape（贴边贝塞尔）；设置里的「白板」页 |
| Phase 4 · 白板内容接入 Agent | 白板 shape 的内容链接（`ContextLink.kind = "shape"`，文字直接给文本、图片直接给 `.armadra/assets/` 路径）；保存冲突自动变基；停用 `note` / `bookmark` / `embed` / `video`；退役 `image` 节点按 `sourcePath` 导入或降级成便签 |

### Phase 4 · polish 的四件事（2026-09-04）

| 项 | 实现 |
| --- | --- |
| 保存冲突（409）自动变基 | `save/canvas-save-queue.ts` 新增纯函数 `replayLocalEdits(remote, local)`；`save/autosave.ts` 收到 409 → `GET` 最新文档 → 重放 → 写回 store（`use-store-sync` 用 `mergeRemoteChanges` 灌进 editor，**不进撤销栈**）→ 重新保存。分界点是 `local.board.updatedAt`（本地这份文档最后一次与 Runtime 对齐的 CAS 戳）：`createdAt` 晚于它的节点是本地新建、保留；早于它又不在远端的是远端删掉的、不复活。连续 3 次 409 才亮红灯 |
| 停用四种原生 shape | `canvas/shapes/retired-shapes.ts`：显式 shape 清单（`defaultShapeUtils` 去掉 `note` / `bookmark` / `embed` / `video`）+ 运行时创建守卫。守卫是必需的——`<Tldraw>` 内部用 `mergeArraysAndReplaceDefaults` 把默认集合无条件合回来，过滤后的清单只是意图声明；而从别的 tldraw 页面复制一张便签走的是 `putExternalContent({type:"tldraw"})`，不经过任何一个被覆盖的处理器。schema 里仍保留这四种，否则老快照 `loadSnapshot` 会整份失败。`dnd/external-content.ts` 的 `url` 分支改成落一段文字 |
| 旧数据策略（2026-09-05） | 用户决定不兼容任何旧数据：增量迁移 0002–0009 合并为单一 `0001_initial.sql`（230 行，与旧链 12 张表逐列比对一致）；删除 v2→v3 转换、`draw`/`image` 迁移、`.armadra/drawings/` 回退与 `export-png` 旧路由；Runtime 启动时发现旧库即改名为 `canvas.db.legacy-<时间戳>` 并新建（有测试）。本机旧库已按此改名 |
| 图片节点 `sourcePath` 迁移 | `MigrateDeps.readSourceFile` 换成 `importAsset(sourcePath)`，实现是 `POST /api/workspaces/{id}/assets/import`——字节由 Runtime 读盘、Runtime 哈希落盘，前端一个字节都不碰。既没有内联 `src`、`sourcePath` 又导不进来的 `image` 节点**降级成便签**（正文写原路径）：留着它等于把这块板判死刑，Runtime 从此拒收 `image` |
| 终端两处回归修复 | ① 滚轮 → tmux copy-mode 的桥**整个失效**：xterm 6 起用 vscode 的 `ScrollableElement`（DOM 多一层 `.xterm-scrollable-element`），它在自己的 wheel 处理里 `stopPropagation()`，冒泡相位的监听器一个事件都收不到 → 改成捕获相位。② OSC 标题记忆放在进程内 Map 且在组件卸载时清掉，刷新 / 热重载 / StrictMode 二次挂载之后这个终端**再也不跟随标题** → 记忆写进 `localStorage`（按节点 id，200 条上限），卸载不再清 |

### 验证（2026-09-04）

| 项 | 结果 |
| --- | --- |
| `pnpm --filter @armadra/web typecheck` | 0 错误 |
| `pnpm --filter @armadra/web test` | 67 文件 740 用例通过 |
| `pnpm --filter @armadra/shared test` | 63 用例通过 |
| `cargo test -p armadra-runtime` | 317 通过 |
| `cargo clippy --all-targets -- -D warnings` | 0 警告 |

**§18.4 终端清单**（自建看板上一个真实 tmux 终端节点，测完 terminate 并删板）：

| 项 | 结果 |
| --- | --- |
| 体内单击 | 0 字节进 PTY（WS 只有 `ping`），画布选区保持空，焦点给 `.xterm-helper-textarea` |
| 拖选复制 | 选区矩形出现，节点与相机纹丝不动（Δ = 0），0 字节进 PTY |
| ⌘C / ⌘V | ⌘C 写进系统剪贴板；粘贴发出括号粘贴序列 `ESC[200~…ESC[201~`，画布**不**多出 text shape（粘贴守卫生效） |
| 滚轮走 tmux 桥 | `POST /api/terminals/{id}/scroll` 发出，tmux 进 copy-mode `[10/193]`，相机 Δ = 0；反向滚回退出 copy-mode。**修复后**才通过，见上表 |
| resize 后行列 | 节点 380×260 → `resize cols=46 rows=12`；缩到 300×200 → `cols=36 rows=9`，PTY 里 `tput cols; tput lines` = 36 / 9 |
| 折叠展开不重连 | 折叠 `h=40` 且记下 `expandedHeight=260`、正文 `display:none`；展开回 260，**同一个 `.xterm` 元素**（打标记验证），没有新 hello、缓冲区完整 |
| 缩放 0.3 / 1.7 | 两端文字都清晰（DOM 渲染器 + CSS transform），无重绘错位 |
| 铃声 | `printf '\a'` → `data-bell` 置位再撤销（0.6 s 闪烁） |
| OSC 标题 | `printf '\e]0;hi\a'` → 节点标题变 `hi`；用户手动改过名之后不再覆盖；**刷新之后仍然跟随**（修复后） |

**性能复测（§11 手工）**：自建看板、20 个便签 + 200 条 `draw` shape（共 223 个 shape），
浏览器面板 493×486、120 Hz、zoom 0.45，rAF 采样 2 秒。

| 场景 | 223 shape | 3 shape 基线 |
| --- | --- | --- |
| 静置 | 120.5 fps / 最差帧 9.4 ms | 120.6 fps / 9.4 ms |
| 拖动画布（每帧 `setCamera`） | 111.8 fps / 50.1 ms | 108.7 fps / 58.3 ms |
| 拖动节点（每帧 `updateShapes`） | 51.8 fps / 66.7 ms | 61.7 fps / 59.2 ms |
| JS 堆 | 186 MB | 132–138 MB |

结论：200 条手绘对平移几乎零成本（差 3 fps），只多吃约 50 MB 堆。真正的瓶颈是
**拖节点那条链路**（editor → 派生 → store → 置脏），它和 shape 总数基本无关：
3 个 shape 时也只有 62 fps。采样用的是「每帧写一次 `updateShapes`」，比真实拖拽
更极端（真实拖拽走 tldraw 自己的 translate 会话）。

### 已知边界

- **两个窗口同时改同一块板**：409 变基保证「自己这一下不丢、也不弹错」，但两边
  几乎同时提交时最后落库的那份会盖掉对方刚存进去的位置，且两个窗口不会自动
  收敛（没有 `board.changed` 驱动的重载）。多人协同本来就是计划书 §2 的非目标。
- **白板快照不做合并**：变基时 `board.whiteboard` 一律用本地那份，另一个窗口这段
  时间画的手绘会被盖掉。节点、连线、分组不受影响。
- tldraw 水印（右下角「Made with tldraw」）按用户决定保留，不申请许可 key。
- 桌面壳的 Tauri `onFileDrop` 路径没有在真机上跑过（端点用 curl 实测过）。
- `escape-to-select.ts` 的两条兜底是绕 tldraw 5.4 的缺陷，升级 tldraw 时先跑一遍
  模块注释里的复现步骤，能删就删。

---

## v3 终端 + Hook 重构（2026-09-04，分支 `main`，未合并）

按 [v3-agent-terminal-plan.md](./v3-agent-terminal-plan.md) 完成 Phase 0–4。

### Phase 4（2026-09-04 晚）

| 能力 | 实现 |
| --- | --- |
| 对话索引与 resume | `apps/runtime/src/index/`：扫描 claude / codex / gemini 转录目录建索引（本机 1799 条，3.5 s），`GET /api/conversations`，`POST /api/conversations/refresh`；`assembleLaunchCommand({resume})`（claude/gemini `--resume`，codex `resume <id>`）；命令面板「历史对话」分组 → 新终端节点以 resume 启动 |
| 看板视图（已于当晚按用户要求移除，见 §25 条目） | 迁移 0008 `boards.kanban_json`；⌘⇧B 全屏看板（288px 列、拖拽换列、列管理、`+ 新建会话`），卡片 = terminal/sticky 节点，点击回画布居中 |
| 标签 / 评论 / AI 命名 | 节点 `labels` / `note` 字段；终端节点头部保持单行 34px，标签在右键菜单编辑、看板卡片显示；AI 命名 / 评论在「更多」菜单的对话框中；`POST /api/agent-status/{id}/suggest-title`（转录首条用户消息，无模型调用） |
| 终端完整兼容（§18） | 固定头部 + `absolute` xterm 容器、`proposeDimensions` 守卫的 fit、隐藏滚动条、`React.memo`；DOM 渲染器默认、WebGL 可选；unicode11 / clipboard(OSC 52) / web-links(OSC 8) / search 按需加载；OSC 0 标题自动跟随、铃声闪烁、`macOptionIsMeta`、键盘放行策略；tmux `terminfo` 探测、`RGB`、`aggressive-resize`、`set-titles`；直连 `TERM/COLORTERM`；Runtime 输出 16 ms / 64 KiB 合批；终端设置块 |
| 代码分割与桌面 | 入口 chunk 2.2 MB → 69 kB（CodeMirror、xterm addons、看板、设置等懒加载）；Tauri 标题栏覆盖 + 托盘 + 最低 macOS 13.3 + updater 骨架；`.app` 与 DMG 已打包实测（包内 sidecar 与 hook 安装器解析正常）；`docs/windows-session-daemon.md` 设计 |
| 修复 | 最大化/折叠触发 React Flow 无限循环（投影选区快照落后一帧）已修并加回归测试；删除终端节点先销毁会话；`CommandDialog` 缺 cmdk 上下文导致 ⌘K 崩溃已修 |
| 终端复制 / 点击 / 滚屏（§18.5） | tmux `mouse off`、`focus-events off`、外层 `smcup@:rmcup@`、`terminal-features clipboard`：单击/聚焦 0 字节进 PTY，xterm 原生拖选，⌘C 与右键 复制/粘贴，OSC 52 透传；滚轮桥接 `POST /api/terminals/{id}/scroll` → tmux copy-mode（输入即退出，程序自带鼠标追踪时不桥接）；`copyOnSelect` 设置 |
| Dock | 新增「一键整理」按钮（调用 `canvas.tidy`） |

**Phase 4 验证（2026-09-04）**：shared 59、前端 439（41 文件）、Rust 301（runtime 253 + armadra-hook 48）测试通过；clippy 0 警告；`vite build` 入口 69 kB；§18.4 终端清单逐项通过（画布缩放清晰度仅做了 DOM 渲染器确认）；折叠/最大化、复制、点击、滚屏在浏览器中实测。

### 用户反馈轮次（2026-09-04 晚，§19–§23）

| 项 | 实现 |
| --- | --- |
| 用量球 | Runtime `src/usage/`（Claude OAuth usage / Codex wham usage，token 不出进程，5 分钟缓存）；右下角 36px 环形进度球，悬停/点击展开各窗口与重置倒计时；设置可关 |
| 100% 比例 | 打开看板不再 fitView：zoom 1、内容左上留 40px；适应视图 maxZoom 1；浏览器 900×620、编辑器 700×480 |
| 左侧栏 | 删除顶栏；260px 固定侧栏：工作空间树（展开看板、`+` 打开/新建/克隆、⋯ 新建看板/重命名/投递记录/关闭/从列表移除）→ Agent 状态分组 + 历史；⌘⇧L 折叠；红绿灯拖拽区在侧栏顶部 |
| 首页 | 居中圆角布局：新建文件夹 / 打开文件夹 / 克隆仓库（`POST /api/git/clone` 任务 + 进度轮询，完成自动打开）+ 最近卡片（⋯ 从列表移除，`DELETE /api/workspaces/{id}` 不动磁盘） |
| 任意互连 | 所有节点带把手，任意两节点可连；箭头/标签按可读端决定；画布连线自动同步到 Runtime 上下文链接文档；Agent 可读文件/目录/图片/画图/网页/差异 |
| 画图节点 | `draw` 类型：笔/橡皮/颜色/撤销，笔迹入库，导出 PNG 到 `.armadra/drawings/` 供 Agent 读取 |
| 缩放 | 捏合/⌘+滚轮以光标为中心缩放（0.1–3）、滚轮平移、⌘0/⌘1/⌘=/⌘- |
| SSH | 设置 SSH 主机（校验、测试连接、argv 无注入）；`+` 菜单「SSH 终端 · 主机」，节点 `⇅ 主机` chip |
| 设置页 | 左 220px 固定导航 + 搜索，右侧独立滚动卡片，点击平滑定位、滚动 scroll-spy，记住上次分区 |
| 整理 | 按连通分量 + 视口宽高比分行铺排，完成后适应全部（maxZoom 1） |

**验证（2026-09-04 晚）**：shared 60、前端 541（51 文件）、Rust 344（runtime 296 + armadra-hook 48）测试通过；typecheck 与 clippy 零告警；入口 chunk 86 kB。

### 设置分页与 Apple HIG 视觉重做（2026-09-04 深夜，§24）

| 项 | 实现 |
| --- | --- |
| 设置页 | ChatGPT 式居中对话框 820×600：左 200px 分组导航（通用 / AI / 连接 / 高级），右侧每个分区独立一页（通用、通知、Agent、Hook 与 Skills、终端、工作区、SSH、数据、账号与用量、快捷键、关于），子页在同栏推入；新增：Agent 三态、自定义启动命令、自定义 Agent、通知拆分 + 音量与试听、数据页（目录 / 备份 / 索引重建 / 日志保留）、账号凭据来源、快捷键录制重绑定与冲突提示、开源许可 |
| 视觉 | token 体系（三级表面、圆角 6/10/12/14、字号 17/15/13/11、阴影与动效变量、侧栏材质）；首页 720px 列 + 列表行；侧栏 240px 源列表材质 + Tauri sidebar vibrancy；工具簇合并为单条圆角栏；Dock 44px；节点头部同色 + 1px 分隔、色点/色条可选、状态胶囊 11px；对话框 / 看板 / 命令面板统一尺寸；全局无 <11px 文字 |

**验证**：前端 559 测试 / typecheck 0 错误 / 入口 85 kB；Rust 345 测试 / clippy 0 警告；11 个设置分页与主要页面深浅色截图核对。

### 「新建 Agent 启动即被杀」排查与修复（2026-09-04 晚，§25）

**现象**：打包 app 里新建 Codex 节点，终端打出 `zsh: killed codex`；Gemini 停在登录；opencode 空白。

**根因**（三层）：

1. 本机装了两份 codex：Homebrew 下 0.117.0（其二进制的签名证书已被吊销，`spctl` 报 `CSSMERR_TP_CERT_REVOKED`，一执行即被系统 SIGKILL）与 mise 下 0.153.2（正常）。Runtime 探测到的是 mise 那份，但启动行只往 shell 里敲裸命令 `codex`；tmux 里的 shell 经 `path_helper` 重排后 Homebrew 在前，于是跑的是被吊销那份。
2. 数据目录下的 tmux 服务器是更早从开发 runtime（在 Claude Code 沙箱 Bash 里启动）拉起来的，打包 app 复用了同一个 socket；服务器保留了启动者的整份环境（`CLAUDECODE=1`、`CLAUDE_CODE_*`、`MallocNanoZone=0`……）与沙箱，之后每个会话都继承。
3. Codex ≥ 0.15x 用 `deny_unknown_fields` 解析 `hooks.json`；第三方安装器写入的顶层 `"version": 1` 让 Codex 拒掉整份文件（`unknown field version`），任何 hook 都不再运行。我们的安装器此前“保留未知顶层键”，会把这个问题一并保留。

**修复**：

| 处 | 改动 |
| --- | --- |
| `apps/web/src/agent/launch.ts` | 启动行优先用设置里的自定义命令，其次用 `GET /api/agents` 的 `resolvedPath`（绝对路径、shell 引号），不再敲裸命令名；Agent 设置页的启动命令占位符显示实际解析到的路径 |
| `apps/runtime/src/terminal/backend.rs` | `child_environment()`：终端子进程（tmux 服务器 / 会话 / attach 客户端 / direct PTY）一律用**构造**的环境——身份与 locale 白名单、`*_PROXY`、增强版 PATH、`TERM/COLORTERM`——不继承 runtime 自己的环境 |
| `apps/runtime/src/terminal/tmux.rs` | 服务器选项 `@armadra-runtime` 记录启动者（可执行路径@版本）；启动对账时发现是别的 runtime 起的服务器：无会话则 `kill-server` 重建，有会话则保留并记 warn |
| `apps/runtime/src/main.rs` | 启动即把进程 PATH 换成 `agent_path()`，Finder 启动时也能找到 tmux / mise / Homebrew |
| `apps/runtime/src/hook/install/codex.rs` | 写 `hooks.json` 前丢弃 `description` / `hooks` 之外的顶层键（测试随之改为断言 `version` 被丢弃） |

**移除看板视图**（用户 2026-09-04 晚：「看板视图不需要，以及对应点击出来的页面都移除」）：删掉 `KanbanView/KanbanColumn/KanbanCard`、工具簇按钮、`app.kanban` 命令与 ⌘⇧B、工作区设置页的「看板列」组、`--z-kanban`；节点标签 / 评论 / AI 命名与命令面板「历史对话」保留，代码从 `kanban/` 移到 `meta/`，文案键 `kanban.*` → `meta.*`。`board.kanban` 数据列与 Runtime schema 原样保留（旧库不动）。顺手修了快捷键页 `toKeymap` 遇到 `null`（删回默认的乐观更新）时崩溃的问题。

**顺带收尾**：账号与用量页新增「获取用量」开关（写 Runtime `usage.enabled`）；TooltipProvider 延迟改为 500ms；`prettier --write src`（96 个文件，含 shadcn 生成件）。

**验证**：前端 567 测试 / tsc 0 / prettier 0；Rust 308 + 48 测试 / clippy 0；dev 浏览器里新建 Codex 节点以 mise 绝对路径启动 v0.153.2；重新打包并替换运行中的 app，杀掉旧 tmux 服务器后由新 runtime 重建，Sub2api 看板重新启动 Codex 成功。

### Phase 0–3

| 能力 | 实现 |
| --- | --- |
| 数据模型 v3 | 8 类节点（terminal 含 agent / sticky / group / editor / diff / files / browser / image）、单一 `link` 边、节点级 `title/color/collapsed/parentId`；迁移 0004（v2 映射 + 备份）、0005（终端后端列）、0006/0007（Agent 状态列） |
| 前端基座 | Tailwind v4 + shadcn CLI 生成组件（`src/ui`）、token 主题（深/浅/跟随系统）、`useT()` 多语言（zh/en，键值奇偶性测试 + CJK 扫描测试）、`keybindings.ts` 命令注册表 |
| 壳 | TabBar 44px、Dock、ControlsCluster、Banners、Launcher、SettingsOverlay（AI/工作区/界面/应用）、CommandPalette、NewWorkspaceDialog |
| 画布 | React Flow 浮动边、派生 rope/subagent 边、StatusMiniMap、右键菜单（画布/节点）、NodeResizer/折叠/最大化/焦点层、撤销重做、Tidy、OS 文件拖放与粘贴 |
| 节点 | NodeShell（3px 顶色条、状态胶囊、光晕、允许/拒绝）+ 8 个节点体、SubagentCard、PendingLaunch ▶ |
| 面板 | SessionsSidebar（工作空间/状态分组、信号徽标、历史）、ExplorerDrawer、SourceControlDrawer（status/diff scope/stage/unstage/revert/commit）、DeliveryLog、ControlConfirmDialog |
| 终端后端 | `TerminalBackend` trait：tmux（默认，`-u` + UTF-8 locale、隔离 socket/conf、capture/paste/foreground/进程树终止、GC 与启动对账）/ direct 兜底；WS `hello/snapshot/stale`、三级 terminate、recycle；前端自动重连 |
| Agent 运行时 | Hook 服务（TCP + Unix socket、应用 bearer + 派生节点令牌三分校验、端点文件）、四个 provider 归一器 + §5.4 归约器、`agent_status` 镜像、20 分钟 stale 与终端退出 close-out、安装器（claude/codex 含 trusted_hash 复现/gemini/opencode）、`armadra-hook` Rust 客户端 sidecar（hook / context / canvas / doctor） |
| Agent 协作 | 上下文链接四动词（仅可读已连线节点）、画布控制动词（含 `close` 人工确认）、消息投递门链 + 队列 + 回执 + `.armadra/board-log.jsonl` 追踪、权限直答（answer 文件 / 按键回退）、skills/AGENTS.md 安装、子代理卡片、`--after` 待启动 DAG |
| 前端状态 | 未读只由 Runtime 置位、已读回执清除；通知（Tauri notification / Web Notification）与提示音；侧栏分组 attention → working → unread |

### 验证结果（2026-09-04）

| 检查 | 结果 |
| --- | --- |
| `packages/shared` build/test/typecheck | 44 passed |
| `apps/web` tsc / vitest / vite build | 0 错误 / 382 passed（34 文件）/ 构建通过（主 chunk 2.1 MB，待代码分割） |
| `cargo test --workspace` | runtime 224 passed，armadra-hook 37 + 11 passed |
| `cargo clippy --workspace --all-targets` | 0 warnings |
| 真实浏览器（1440×900） | 启动页 → 工作空间恢复；深/浅主题；中英文切换即时生效；新建 Claude 节点自动在 tmux 中启动 Claude Code；hook 驱动 RUNNING → DONE（未读光晕）；权限请求 NEEDS YOU → 允许；终端中文 `echo 中文渲染测试 你好世界` 正常渲染 |
| 旧库迁移 | 本机 v2 库自动备份为 `canvas.db.backup-v3-*` 并迁移 |

### 已知边界

- Tauri 桌面包（DMG）本轮未重新打包；`cargo check` 通过，`prepare-sidecar` 已包含 `armadra-hook`。
- codex/gemini 转录目录布局按文档推断，未在真实目录验证；opencode 未安装，其插件与 `export` 格式未实测。
- 子代理卡片只展示事件里的 `result`，未接转录尾部；rope 边的"已启动"记忆仅会话内。
- 未做：用量胶囊（需读 Claude OAuth 凭据）、语音、SSH、远程 Runtime、GitHub、Windows 守护进程实现（仅设计）。

---

## v2 桌面端界面重构（2026-09-02，历史记录）

按 [docs/design/handoff](./design/handoff/README.md) 的高保真原型重构了整套界面，同时把数据模型升级到多看板。实现细节与文件归属见 [redesign-plan.md](./redesign-plan.md)。

| 能力           | 实现                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据模型 v2    | Workspace 含颜色/权限/网关开关/最近打开；Workspace → Board 一对多；节点 10 类（task/agent/terminal/diff/file/context/note/browser/image/log）、`zoom` 三态；连线 6 种语义；状态 10 种；Board 持久化 `viewport` 与 `strokes`                          |
| Runtime 迁移   | `0003_boards.sql`：`canvases` → `boards`，`nodes/edges.canvas_id` → `board_id`，旧类型/状态/语义在 SQL 中映射，v2 必填字段回填；真实旧库回归测试                                                                                                     |
| Runtime API v2 | 工作空间 PATCH/open、看板 CRUD、看板文档 GET/PUT（CAS）、`git/status`、`git/stage`、`git/revert`、`/api/gateway`（预留，不监听）、终端 GET/terminate（含 PID）、适配器 `resolvedPath`；ACP 事件结构化（message/user/thinking/tool/plan/usage）       |
| 应用壳         | 顶栏 36 / 工作空间轨 52 / 侧栏 236 / Inspector 272 / 状态栏 24；靛蓝主题 token；启动页 + 最近工作空间；看板列表增删改                                                                                                                                |
| 画布           | 点阵背景、右上工具栏（选择/画笔/一键整理）、左下缩放柱、节点 mini/normal/focus、摘要阈值、手绘笔迹层、语义连线 + 中点标签 + 1–6 热键选择层、一键整理、全部快捷键                                                                                     |
| 拖拽与粘贴     | 懒加载文件树（Git M/A/D/? 徽标）、节点面板、拖到画布/Agent 节点创建与自动 `ref` 连线、粘贴文本/图片、OS 文件拖入                                                                                                                                     |
| 节点内部       | 10 类节点内容组件；Agent 时间线（思考折叠、工具行、权限卡、上下文 chips、输入框、停止/运行）；终端 PID/摘要/清屏/重连/停止/重新运行；Diff 逐文件与全部接受/回滚（回滚需确认）、导出 patch；便签转任务；沙箱 iframe 浏览器；Inspector v2 与可执行动作 |
| 弹层           | 新建工作空间（权限卡、网关开关、目录选择）、设置（模型与提供方/ACP/网关与外部端/外观/快捷键）、⌘K（创建/跳转/命令，模糊匹配）、Diff 扫描抽屉                                                                                                         |
| 桌面           | `tauri-plugin-dialog`、`tauri-plugin-opener`、窗口拖放事件、CSP 允许 iframe；网页版自动回退                                                                                                                                                          |

### 集成阶段发现并修复

1. 一个无法预览的未跟踪二进制文件（如仓库根目录的设计稿 zip）曾让整次 `git/diff` 返回 400；现逐文件标记 `previewable:false`，导出 patch 时跳过。
2. 新建的浏览器节点 `url` 为空时曾被 Runtime 校验拒绝，导致看板保存失败；现允许空地址，并增加"所有面板默认节点都可保存"的回归测试。
3. `git/status` 在无 upstream 时曾序列化 `ahead/behind: null` 与 Web schema 不符，顶栏 Git 状态整体失效；现 Runtime 省略键、Web 接受 nullish。

### 验证结果

| 检查                                                                                                       | 结果                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Runtime 单元/安全/迁移/真实 PTY 测试                                                                       | 52 passed，2 个凭据型 ACP live test 保持 ignored                                                                       |
| Shared Schema 测试                                                                                         | 15 passed                                                                                                              |
| Web 测试（store/dnd/nodes/agent timeline/modals 等 16 个文件）                                             | 100 passed                                                                                                             |
| TypeScript typecheck（shared + web）                                                                       | passed                                                                                                                 |
| Web production build                                                                                       | passed（主 chunk > 500 kB 的非阻断提示仍在）                                                                           |
| `cargo check --workspace`（含 Tauri desktop 新插件）                                                       | passed                                                                                                                 |
| 真实浏览器：启动页、新建工作空间、主壳、任务派发建 Agent、终端启动、节点三态、设置/⌘K/Diff 抽屉、浅/深主题 | passed（1440×900）                                                                                                     |
| 旧库迁移                                                                                                   | 本机已有的 2 个 v1 工作空间在启动 v2 Runtime 时自动迁移为各含一个 `Default` 看板；迁移前已备份 `canvas.db.backup-v1-*` |
| Tauri DMG 打包                                                                                             | `bundle_dmg.sh` 在本次无 GUI 会话中失败；`.app` 与 Rust 检查正常，需在交互式会话重跑                                   |

### 明确边界

- 网关与外部端仍是预留：UI 显示状态与设置项，Runtime 不监听 7420，也不存在设备配对。
- ACP 会话不支持在同一会话内追问：输入框每次发送都会以新会话启动（Runtime `AcpClientMessage` 只有 cancel / permission_response）。
- Agent 头部 tokens 只在 Agent 提供 `usage` 事件时显示；本机可用适配器未观测到该事件。
- 浏览器节点「截图到画布」、图片「在图上标注」、便签「拆分为多条」、Agent「推送到外部端」按设计以禁用态展示。
- 未实现节点手动改尺寸。

---

## Phase 1 MVP（2026-08-13，历史记录）

### 已完成

| 能力           | 实现                                                                                    |
| -------------- | --------------------------------------------------------------------------------------- |
| Workspace 授权 | 绝对目录校验、canonical 路径边界、最近 Workspace 与恢复                                 |
| 文件/目录      | 有界列表、构建目录忽略、文本预览、二进制与 1 MiB 限制                                   |
| 语义画板       | React Flow、自定义节点、语义选择器、方向箭头                                            |
| Terminal       | `portable-pty`、xterm.js、WebSocket input/output/resize/status/terminate、短输出 replay |
| Agent          | ACP v1、Claude/Codex/Gemini/OpenCode/Pi/OMP 探测、权限确认、归属校验与真实 CLI 启动     |
| Git Diff       | 只读 status/diff、子目录、中文路径、授权根校验                                          |
| Local-first    | SQLite migration、串行自动保存、版本冲突检测、事务保存、session 与脱敏日志              |
| Desktop        | Tauri 2 薄壳、sidecar 准备、严格健康检查、就绪后显示窗口与优雅退出                      |
| 安全加固       | Git symlink 防泄漏、WS Origin 限制、Agent session 归属、Schema 契约校验                 |

### Phase 1 实测发现并修复的问题

1. PTY reader 曾在普通线程中获取 Tokio runtime 并 panic；现改为创建线程前捕获 Handle。
2. Git 在 Workspace 是更大仓库子目录时可向上发现仓库并泄漏根外 diff；现强制仓库根位于授权 Workspace。
3. 终止状态曾被 exit watcher 覆盖；现使用条件状态迁移。
4. Agent session 曾可跨 Workspace 复用；现先校验 session 所属 Workspace 和状态。
5. Rust RFC 3339 `+00:00` 与 Web Zod 默认 `Z` 格式不兼容；Shared Schema 明确接受 offset。
6. 自动保存响应曾可能覆盖请求期间的新编辑；现比较快照，较新编辑保持 dirty。
7. 自动保存曾允许多个 PUT 乱序提交；现使用单飞队列，Runtime 通过 `updated_at` CAS 拒绝过期保存。
8. Git Diff 曾可跟随未跟踪 symlink 读取授权根外文件；现拒绝 symlink/特殊文件并限制预览为 1 MiB。
9. 普通 Terminal session 曾可被 Agent API 复用；现持久化 session 类型、owner node 与 adapter。
10. 任意网页曾可凭 session ID 升级 WebSocket；现只接受本地开发源和 Tauri Origin。
11. macOS `.app` 启动时曾可能缺少交互式 shell PATH；现 Runtime 对探测与 ACP 子进程使用同一条补全 PATH。
12. ACP 思考分片与用量元数据曾逐 token 触发渲染；现 Runtime 归一化消息，Web 按动画帧合并文本流。

### Phase 1 边界（仍然有效）

- Workspace 路径校验约束 Runtime 的文件、初始 cwd 与 Git API，但普通 PTY 不是操作系统沙箱。
- Desktop 的签名、公证和自动更新属于发布工程，不在功能验收内。
- 高输出终端日志按 chunk 异步落库；后续应改成有界单写队列和批量事务。
- SSH、Browser/CDP、多端同步、CRDT 和团队协作属于后续阶段。
