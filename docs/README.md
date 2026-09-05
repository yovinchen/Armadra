# 文档索引

| 文档                                                                                   | 用途                                        | 状态     |
| -------------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| [architecture.md](./architecture.md)                                                   | 最终架构、画板选型、系统边界和实施阶段      | 已确认   |
| [requirements.md](./requirements.md)                                                   | Phase 1 需求拆解、验收标准与验证矩阵        | 实施中   |
| [interface-design.md](./interface-design.md)                                           | v2 视觉、布局与交互基线                     | 已被 v3 取代 |
| [redesign-plan.md](./redesign-plan.md)                                                 | v2 重构差距分析、数据/API/Store 契约与分工  | 已实施（被 v3 方案取代） |
| [v3-agent-terminal-plan.md](./v3-agent-terminal-plan.md)                             | v3 方案：Agent 改为终端 + Hook、浮层壳、画布精简；取代 redesign-plan 作为实施契约 | Phase 0–4 已实施（画布层由 v4 取代） |
| [tldraw-canvas-plan.md](./tldraw-canvas-plan.md)                                       | v4 方案：画布层换成 tldraw，节点与白板同一套 store；只替换画布层，其余契约沿用 v3 | Phase 0–4 已实施 |
| [phase1-handoff.md](./phase1-handoff.md)                                               | v4 各并行 agent 的交接记录：归属、约定、跨归属请求与逐项验证证据 | 过程记录 |
| [design/handoff/README.md](./design/handoff/README.md)                                 | 设计稿交接包（原型 HTML、SPEC、模板与逻辑） | 参考     |
| [implementation-status.md](./implementation-status.md)                                 | 实现状态、修复记录、验证证据与边界          | 已实现   |
| [research/chatgpt-conversation-archive.md](./research/chatgpt-conversation-archive.md) | 原始讨论与决策演进归档                      | 仅供追溯 |
| [research/ui-style-references/README.md](./research/ui-style-references/README.md)             | 三套外部 UI 风格的筛选矩阵、使用边界与独立档案 | 风格参考 |

## 使用规则

- `architecture.md` 是实现决策的唯一基线；画布层的细节以 `tldraw-canvas-plan.md` 为准。
- 会话归档不直接作为需求清单；其中较早的 Electron、Go 等候选方案已被最终文档覆盖（tldraw 当时被否掉，2026-09-04 又被选中，见 `architecture.md` §2.1）。
- 架构变化需要先更新 `architecture.md`，再实施代码。
- 新增设计文档统一放在 `docs/`，研究与外部材料放在 `docs/research/`。
