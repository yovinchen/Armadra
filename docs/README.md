# 文档索引

| 文档                                                                                   | 用途                                        | 状态     |
| -------------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| [architecture.md](./architecture.md)                                                   | 最终架构、画板选型、系统边界和实施阶段      | 已确认   |
| [requirements.md](./requirements.md)                                                   | Phase 1 需求拆解、验收标准与验证矩阵        | 实施中   |
| [interface-design.md](./interface-design.md)                                           | v2 视觉、布局与交互基线                     | 已实现   |
| [redesign-plan.md](./redesign-plan.md)                                                 | v2 重构差距分析、数据/API/Store 契约与分工  | 已实施   |
| [design/handoff/README.md](./design/handoff/README.md)                                 | 设计稿交接包（原型 HTML、SPEC、模板与逻辑） | 参考     |
| [implementation-status.md](./implementation-status.md)                                 | 实现状态、修复记录、验证证据与边界          | 已实现   |
| [research/chatgpt-conversation-archive.md](./research/chatgpt-conversation-archive.md) | 原始讨论与决策演进归档                      | 仅供追溯 |

## 使用规则

- `architecture.md` 是实现决策的唯一基线。
- 会话归档不直接作为需求清单；其中较早的 Electron、tldraw、Go 等候选方案已被最终文档覆盖。
- 架构变化需要先更新 `architecture.md`，再实施代码。
- 新增设计文档统一放在 `docs/`，研究与外部材料放在 `docs/research/`。
