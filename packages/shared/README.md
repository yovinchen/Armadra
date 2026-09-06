# packages/shared

前端与 Runtime 之间的共享契约，纯数据加纯函数，不启动任何进程。

| 模块             | 内容                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `domain.ts`      | 领域模型：七种节点类型、唯一入库的 `link` 连线、节点配色、Agent 状态、权限模式、工作空间 / 看板 / 板文档的 zod schema          |
| `agents.ts`      | Agent 注册表：Claude Code、Codex、Gemini CLI、opencode 的启动命令、prompt 传递方式、各权限模式对应的 argv、resume 方式、能力位 |
| `api.ts`         | Runtime HTTP / WebSocket 的请求与响应 schema                                                                                   |
| `hook-events.ts` | 各 CLI 的 hook 事件名与 hook 客户端版本号，安装器、设置页与测试共用                                                            |

Runtime 侧只镜像 Agent 的 id 与启动程序（`apps/runtime/src/agent.rs`）；
领域模型与 tldraw 等具体画板引擎解耦。

```bash
pnpm --filter @armadra/shared build
pnpm --filter @armadra/shared test
```

`@armadra/web` 的 `dev` / `build` 会先构建本包。
