# Phase 1 需求拆解与验收矩阵

> 状态：Phase 1 核心闭环已实现，发布级加固持续进行  
> 需求基线：[architecture.md](../guides/architecture.md)  
> 范围：Phase 1 MVP；远程执行、浏览器自动化、白板和多人协作不在本阶段内

## 1. 交付目标

Phase 1 必须形成一个可运行的 local-first 闭环，而不是只有静态画板：

```text
授权本地 Workspace
  → 将文件、目录和任务放入画板
  → 通过语义边把上下文交给 Agent / Terminal
  → 在真实 PTY 中运行 CLI
  → 检测 Git 变化并生成 Diff Node
  → 将画板与会话元数据保存到 SQLite
  → 重启后恢复 Workspace 和画板
```

## 2. 角色与核心场景

主要用户是需要同时组织代码、任务和多个 AI CLI 的本地开发者。首版只解决一个核心场景：在一个经过明确授权的项目目录中，把任务和文件上下文交给真实 CLI，观察执行，并审查产生的 Git diff。

## 3. 功能需求

### R1 Workspace 与路径授权

- R1.1 创建 Workspace 时必须提交名称与绝对根路径。
- R1.2 Runtime 必须规范化并验证根路径真实存在且为目录。
- R1.3 文件读取、目录浏览、PTY cwd 与 Git 操作只能发生在授权根目录内。
- R1.4 `..`、符号链接或绝对路径不得逃逸授权根目录。
- R1.5 Web 首次打开时显示创建入口；已有 Workspace 时可直接恢复。

验收：授权根内文件可读；根外路径返回 403；重启 Runtime 后 Workspace 仍存在。

### R2 文件与目录节点

- R2.1 可浏览 Workspace 目录，默认忽略 `.git`、`node_modules`、`target` 和构建产物。
- R2.2 文件节点保存相对路径、类型、大小、只读状态和同步策略，不复制原文件。
- R2.3 目录节点保存相对路径及可选 include/exclude 规则。
- R2.4 文件内容按需读取；文本文件返回内容，二进制或超限文件返回明确错误。
- R2.5 可从资源侧栏把文件或目录添加到当前画板。

验收：添加节点后刷新页面位置与元数据不丢失；读取越权或超限文件失败且无内容泄漏。

### R3 领域模型、画板与语义边

- R3.1 领域 Node/Edge 与 React Flow 渲染结构分离，通过 adapter 转换。
- R3.2 MVP 支持 `file`、`folder`、`task`、`terminal`、`agent`、`diff`、`log` 节点。
- R3.3 支持 `context`、`input`、`output`、`depends_on`、`patches`、`verifies` 语义边。
- R3.4 创建连线时必须选择或推导合法语义；边展示类型标签和方向。
- R3.5 节点移动、创建、删除和连线修改自动持久化。
- R3.6 支持画板平移、缩放、适配视图、MiniMap 与基础键盘操作。

验收：画板变化在短暂防抖后写入 SQLite；刷新后拓扑和位置一致。

### R4 Terminal 与真实 PTY

- R4.1 Runtime 使用 `portable-pty` 创建系统 shell，cwd 必须位于 Workspace 内。
- R4.2 Web 使用 xterm.js 展示输出并发送键盘输入。
- R4.3 WebSocket 传输 PTY 输入、输出、resize、状态和退出事件。
- R4.4 支持创建、重新连接、调整尺寸和终止 session。
- R4.5 终端日志只保存在本地 SQLite，并在落库前执行基础密钥脱敏。
- R4.6 断开 WebSocket 不自动杀死 session；Runtime 退出时清理子进程。

验收：可以执行 `pwd`/`printf` 等交互命令；resize 有效；结束状态和脱敏日志可查询。

### R5 Agent 与上下文注入

- R5.1 Agent 是带适配器配置的 Terminal，支持 `claude`、`codex`、`gemini`、`opencode` 与 `custom`。
- R5.2 Runtime 检测命令是否存在，但不解析各 CLI 私有协议。
- R5.3 `Run with context` 收集指向 Agent 的 Task/File/Folder/Log 上下文边。
- R5.4 MVP 默认注入任务文本和本地相对路径；不自动上传完整源码。
- R5.5 首次启动或 session 已退出时创建 PTY，再把格式化 prompt 写入真实终端。
- R5.6 危险操作的批准仍由 CLI 和用户完成，Canvas 不自动确认。

验收：检测结果可见；上下文 prompt 可预览；运行后 PTY 收到与画板连线一致的内容。

### R6 Git Diff 回流

- R6.1 Runtime 可读取 Workspace 的 porcelain 状态、summary 与统一 diff。
- R6.2 只读 Git 命令不超出 Workspace，也不自动 stage、commit、reset 或 push。
- R6.3 用户点击“扫描变更”后，为有变化的仓库创建或更新 Diff Node。
- R6.4 Diff Node 展示文件、增删统计和 patch 预览，并以 `output`/`patches` 边关联来源 Agent 和文件节点。
- R6.5 非 Git 目录返回可理解状态，不使画板崩溃。

验收：fixture 仓库修改后能获得正确文件名和 patch；未修改与非 Git 状态均可区分。

### R7 SQLite 持久化

- R7.1 保存 Workspace、Canvas、Node、Edge、Terminal Session 与脱敏日志。
- R7.2 Runtime 启动时自动迁移 schema，并创建默认 Canvas。
- R7.3 写画板采用事务，节点和边要么一起成功，要么一起回滚。
- R7.4 API 返回稳定 JSON Schema；前端用共享 Schema 校验边界数据。
- R7.5 Canvas 保存携带服务端版本；过期快照必须返回冲突，不得静默覆盖较新数据。

验收：数据库重开后数据一致；无效节点类型或悬空边写入失败；旧版本并发保存返回 409。

### R8 Tauri 2 薄壳

- R8.1 Desktop 只管理 Runtime 生命周期、健康检查和 Web 页面，不复制业务 API。
- R8.2 开发模式可连接外部 Runtime/Web；生产模式从 sidecar 启动 Runtime。
- R8.3 关闭应用时终止由它启动的 Runtime。
- R8.4 未找到 sidecar 或健康检查失败时显示明确错误。

验收：Tauri 配置和 Rust 壳可编译；生命周期逻辑有单元可测的进程/健康边界。

## 4. 非功能需求

### 安全

- 所有路径先 canonicalize 再做祖先关系验证。
- API 默认只监听 `127.0.0.1`，不得默认暴露局域网。
- CORS 仅允许本地开发源和 Tauri 源。
- 日志脱敏覆盖常见 API key、Bearer、password、token、secret 形式。
- 错误响应不得包含密钥、完整环境变量或根外文件内容。

### 可用性与可访问性

- 主要操作触控目标不小于 44px。
- 键盘焦点清晰，图标按钮有 accessible name。
- 颜色不是状态的唯一表达；状态同时使用文字或图标。
- 320px 宽度仍可完成 Workspace 选择、节点查看和主要操作。
- 支持 `prefers-reduced-motion`，终端和画板内部焦点不被全局快捷键抢占。

### 性能与可靠性

- 目录列表有深度和条目数上限；文件预览有大小上限。
- 画板写入防抖且事务化。
- PTY 输出采用有界批处理，避免逐字符触发 React render。
- Runtime 暴露 `/health`；Web 对离线、连接中、在线分别展示状态。

## 5. 验证层级

| 层级             | 重点                                       | 通过条件                         |
| ---------------- | ------------------------------------------ | -------------------------------- |
| Shared 单元测试  | Schema、领域约束、React Flow adapter       | 类型检查与测试全绿               |
| Runtime 单元测试 | 路径沙箱、脱敏、context prompt、Git parser | 不依赖 UI 可稳定复现             |
| Runtime 集成测试 | HTTP、SQLite、文件 fixture、Git fixture    | 核心 API 闭环可运行              |
| Web 组件测试     | Store、节点、空态、错误态                  | 用户动作产生正确请求与状态       |
| 浏览器 E2E       | 创建 Workspace、加节点、连线、保存、恢复   | 刷新前后数据和界面一致           |
| 构建检查         | Web、Runtime、Desktop                      | release/dev 构建至少完成编译验证 |

## 6. 明确后置

以下能力属于 architecture.md 的 Phase 2–4，不以占位 UI 冒充完成：SSH/Remote Runtime、Browser/CDP 自动化、Quickdraw WhiteboardNode、团队协作、云同步、CRDT、插件市场、Agent 私有协议解析与自动批准。
