# 实现状态与验证证据

> 更新：2026-09-02  
> 需求基线：[requirements.md](./requirements.md) · 界面契约：[redesign-plan.md](./redesign-plan.md)

## v2 桌面端界面重构（2026-09-02）

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
