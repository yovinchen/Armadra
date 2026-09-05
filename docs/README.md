# 文档索引

## 开发入口

| 文档                                              | 内容                             |
| ------------------------------------------------- | -------------------------------- |
| [开发指南](development.md)                        | 依赖、启动、检查、打包与环境变量 |
| [项目约定](../AGENTS.md)                          | 代码边界与验证入口               |
| [架构](architecture.md)                           | 当前结构、数据模型与安全边界     |
| [Agent 协作](agent-collaboration.md)              | CLI 能力、上下文与消息箱协议     |
| [界面规范](ui-refinement.md)                      | 布局、交互与验收范围             |
| [平台实施记录](platform-implementation-status.md) | 实际进度与验证证据               |

## 专项设计

以下是目标方案，不代表所有功能已实现；以实施记录和源码核对进度。

| 文档                                       | 内容                                       |
| ------------------------------------------ | ------------------------------------------ |
| [平台总纲](canvas-platform-design.md)      | 需求、M0–M8 阶段与验收                     |
| [Host 与协议](host-protocol-design.md)     | Go Host、Rust Worker、数据所有权与设备接入 |
| [Agent 自动化](agent-automation-design.md) | 交接、循环卡片、计划与命名                 |
| [Git / GitHub](git-github-design.md)       | worktree、提交、Issues 与 PR               |
| [编辑器与浏览器](editor-browser-design.md) | 语言服务、远程文件与受控浏览器             |
| [终端宿主](terminal-host-design.md)        | 持久终端、ConPTY、资源与快捷键             |
| [客户端平台](client-platforms.md)          | 各平台职责与适配边界                       |

## 实施契约与参考

- [v3 Agent 终端](v3-agent-terminal-plan.md)、[tldraw 画布](tldraw-canvas-plan.md)：章节 §N 被代码引用，保留编号。
- [Windows 早期方案](windows-session-daemon.md)：设计参考，本轮目标以终端宿主方案为准。
- [M0 探针记录](research/m0-executor-probes.md)与[运行入口](../scripts/probes/README.md)：可行性证据及未验证项。
- [原生白板参考](native-whiteboard-references.md)、[UI 风格参考](research/ui-style-references/README.md)：选型资料。
- [立项会话归档](research/chatgpt-conversation-archive.md)：仅供追溯。

`history/` 保存已被取代的需求、界面方案、实施与交接记录，不作为当前实施要求；[实施批次记录](history/platform-implementation-log.md)归档各提交的详细验证过程。
新增方案登记在本索引；研究材料放 `research/`，被取代的文档放 `history/`。
架构变化同步更新 `architecture.md`。
