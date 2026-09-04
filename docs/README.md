# 文档

## 下一阶段设计（待实施）

本组文档描述目标功能，不表示当前代码已经实现。新增需求与旧计划冲突时，按总纲及对应专项文档实施；当前功能状态仍以源码与当前架构为准。

| 文档                                                       | 内容                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [canvas-platform-design.md](./canvas-platform-design.md)   | 总纲：确认范围、移除任务看板、组件位置、需求矩阵、迁移、M0–M8 阶段与验收         |
| [host-protocol-design.md](./host-protocol-design.md)       | Go 常驻 Host、Rust Worker、Protobuf、数据所有权、SSH、设备接入、移动端与协作预留 |
| [agent-automation-design.md](./agent-automation-design.md) | 能力继承、上下文占用、跨 Agent 交接、独立循环卡片、后台计划与自动命名            |
| [git-github-design.md](./git-github-design.md)             | Git 全流程、历史图、worktree/Frame、AI 提交信息、Issues 状态映射与 PR 管理       |
| [editor-browser-design.md](./editor-browser-design.md)     | 编辑器、语言服务、远程文件、受控浏览器与 Agent 操作、跨端画面                    |
| [terminal-host-design.md](./terminal-host-design.md)       | Windows ConPTY 宿主、持久终端、渲染/休眠、资源、防休眠、快捷键与更新预留         |

## 当前有效

| 文档                                                     | 是什么                                                                                              | 给谁看                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| [architecture.md](./architecture.md)                     | 三层结构、画布层、Agent 运行时、数据模型、端口与文件位置、安全边界                                  | 想知道系统怎么搭起来的人         |
| [development.md](./development.md)                       | 前置依赖、本地运行、测试、打包、目录结构、环境变量                                                  | 第一次把仓库跑起来的人           |
| [v3-agent-terminal-plan.md](./v3-agent-terminal-plan.md) | v3 实施契约：Agent = 终端 + Hook、浮层壳、接口契约、tmux 后端、文案与组件原则。代码注释按 §N 引用它 | 改 Runtime、hook、终端或接口的人 |
| [tldraw-canvas-plan.md](./tldraw-canvas-plan.md)         | v4 实施契约：画布层换成 tldraw，shape / binding / 快照持久化。代码注释按 §N 引用它                  | 改画布、节点 shape 或白板的人    |
| [windows-session-daemon.md](./windows-session-daemon.md) | Windows 持久化会话守护进程的设计（协议、状态文件、ConPTY、背压）。**只有设计，未实现**              | 要做 Windows 终端持久化的人      |

`v3-agent-terminal-plan.md` 与 `tldraw-canvas-plan.md` 的章节编号被代码注释引用，改动时不要重排 §N。Windows 早期设计保留供追溯，本轮目标以 `terminal-host-design.md` 为准。

## 当前实现补充

- [Agent 适配与低干扰协作](./agent-collaboration.md)：七种 CLI 能力与可复用的消息箱协议。
- [界面布局与交互规范](./ui-refinement.md)：桌面风格、五处布局修复、响应式与验收范围。

## 参考材料

| 文档                                                                                   | 是什么                                                               |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [research/chatgpt-conversation-archive.md](./research/chatgpt-conversation-archive.md) | 立项阶段的完整会话归档，记录选型是怎么演进的。仅供追溯，不是需求清单 |
| [research/ui-style-references/README.md](./research/ui-style-references/README.md)     | 三套外部 UI 风格的筛选矩阵与使用边界                                 |

## 历史记录

`history/` 里是已经被取代的文档，保留下来是为了追溯决策，**不要照着实施**。

| 文档                                                                   | 是什么                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [history/implementation-status.md](./history/implementation-status.md) | v2 / v3 / v4 各阶段的实现状态、修复记录与验证证据                  |
| [history/phase1-handoff.md](./history/phase1-handoff.md)               | v4 并行开发时各 agent 的交接记录：归属、约定、跨归属请求、逐项验证 |
| [history/redesign-plan.md](./history/redesign-plan.md)                 | v2 重构契约，已被 v3 方案取代                                      |
| [history/interface-design.md](./history/interface-design.md)           | v2 五区界面基线，已被 v3 浮层壳取代                                |
| [history/requirements.md](./history/requirements.md)                   | Phase 1 需求拆解与验收矩阵                                         |

## 规则

- 架构变化先改 `architecture.md`，再动代码。
- 新的实施方案放在 `docs/` 根目录并在上表登记；外部研究材料放 `docs/research/`；
  被取代的文档移进 `docs/history/` 而不是就地改写。
