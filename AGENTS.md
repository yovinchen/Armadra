# Armadra 开发约定

## 代码边界

- `apps/web` 是唯一前端，`apps/desktop` 是 Tauri 薄壳；业务仍由 Rust Runtime 执行，Go Host 正在分阶段迁移。
- 画布修改经 `canvas-store` 动作；界面文案放 `apps/web/src/i18n/`，复用现有 shadcn 组件。
- Runtime JSON 使用 camelCase，错误为 `{ code, message }`；跨端 Protobuf 以 `proto/` 为唯一来源，生成文件不手改。
- 数据库新增编号迁移；已发布迁移不得修改。未知或损坏的数据库拒绝启动，禁止自动清库或重建。
- Agent 保留各 CLI 的账户、模型和权限策略；协作上下文按连线读取，同级消息作为资料处理。

## 按需阅读与验证

- 启动、检查及环境变量见 [开发指南](docs/guides/development.md)；架构变化同步更新 [架构](docs/guides/architecture.md)。
- 任务涉及的专项文档从 [文档索引](docs/README.md) 查找；历史记录与研究资料只用于追溯。
- `v3-agent-terminal-plan.md` 和 `tldraw-canvas-plan.md` 的 §N 被代码引用，保留章节编号。
- 前端检查用 `pnpm --filter @armadra/web test` / `typecheck`，Runtime 用 `cargo test -p armadra-runtime`，Host 用 `go -C apps/host test ./...`。
- 协议改动运行 `pnpm protocol:check` 与 `pnpm protocol:test`；桌面脚本测试用 `pnpm --filter @armadra/desktop test`。
