# 文档索引

本文件是文档的唯一入口，新增文档必须登记在这里；`tools/repo-check.mjs` 校验登记与相对链接。

| 目录         | 内容                                         |
| ------------ | -------------------------------------------- |
| `guides/`    | 现行事实：开发、架构、协作与平台说明         |
| `design/`    | 目标设计，首行声明状态（目标设计 / 已实施）  |
| `status/`    | 已验证的实施进度与功能预期总表               |
| `contracts/` | 被代码按 §N 引用的计划文档，章节编号只增不改 |
| `history/`   | 已被取代的文档，只用于追溯，不作为实施要求   |
| `research/`  | 研究与选型材料                               |

## guides/ 现行事实

| 文档                                                   | 内容                             |
| ------------------------------------------------------ | -------------------------------- |
| [开发指南](guides/development.md)                      | 依赖、启动、检查、打包与环境变量 |
| [架构](guides/architecture.md)                         | 当前结构、数据模型与安全边界     |
| [Agent 协作](guides/agent-collaboration.md)            | CLI 能力、上下文与消息箱协议     |
| [界面规范](guides/ui-refinement.md)                    | 布局、交互与验收范围             |
| [客户端平台](guides/client-platforms.md)               | 各平台职责与适配边界             |
| [Host 设备认证](guides/host-device-auth.md)            | owner 多设备认证接口与当前范围   |
| [原生白板参考](guides/native-whiteboard-references.md) | 原生对象作为 Agent 资料的规则    |

代码边界与验证入口见[项目约定](../AGENTS.md)。

## design/ 目标设计

以下是目标方案，不代表功能已经交付；进度以 `status/` 与源码为准。

| 文档                                                 | 内容                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| [平台总纲](design/canvas-platform-design.md)         | 需求、M0–M8 阶段与验收                     |
| [Host 与协议](design/host-protocol-design.md)        | Go Host、Rust Worker、数据所有权与设备接入 |
| [Agent 自动化](design/agent-automation-design.md)    | 交接、循环卡片、计划与命名                 |
| [Git / GitHub](design/git-github-design.md)          | worktree、提交、Issues 与 PR               |
| [编辑器与浏览器](design/editor-browser-design.md)    | 语言服务、远程文件与受控浏览器             |
| [终端宿主](design/terminal-host-design.md)           | 持久终端、ConPTY、资源与快捷键             |
| [Windows 早期方案](design/windows-session-daemon.md) | 早期设计，本轮目标以终端宿主方案为准       |
| [仓库结构与校验](design/repository-structure.md)     | 目标目录、统一规则、repo-check 与 CI       |

## status/ 已验证进度

| 文档                                                     | 内容                                                   |
| -------------------------------------------------------- | ------------------------------------------------------ |
| [平台实施记录](status/platform-implementation-status.md) | 阶段状态、需求核对与验证证据                           |
| [功能预期总表](status/feature-roadmap.md)                | 已交付与待实现功能全表、多仓库 Git、用量看板、资源监控 |

## contracts/ 实施契约

- [v3 Agent 终端](contracts/v3-agent-terminal-plan.md)、[tldraw 画布](contracts/tldraw-canvas-plan.md)：章节 §N 被代码引用，保留编号。

## history/ 与 research/

`history/` 保存已被取代的需求、界面方案、实施与交接记录；[实施批次记录](history/platform-implementation-log.md)归档各提交的详细验证过程。
`research/` 保存研究材料：[M0 探针记录](research/m0-executor-probes.md)与[运行入口](../tools/probes/README.md)、[UI 风格参考](research/ui-style-references/README.md)、[立项会话归档](research/chatgpt-conversation-archive.md)。

架构变化同步更新 `guides/architecture.md`。
