# 共享模型

`@armadra/shared` 保存纯数据与纯函数，不启动进程，不依赖具体画板引擎。

| 模块             | 内容                                              |
| ---------------- | ------------------------------------------------- |
| `domain.ts`      | 节点、连线、工作空间、状态与权限的 zod schema     |
| `agents.ts`      | 七种 CLI 的启动、prompt、resume、权限参数与能力位 |
| `api.ts`         | Runtime HTTP / WebSocket schema                   |
| `hook-events.ts` | Hook 事件名与客户端版本                           |

Runtime 的 `apps/runtime/src/agent.rs` 镜像 Agent ID 与启动程序；能力边界见[Agent 协作](../../docs/agent-collaboration.md)。

```sh
pnpm --filter @armadra/shared build
pnpm --filter @armadra/shared test
```

Web 的 `dev` / `build` 会先构建本包。
