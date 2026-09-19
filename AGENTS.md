# Armadra 开发约定

## 代码边界

- `apps/web` 是唯一前端；业务由 `apps/desktop/src/core/` 这个 Electron-free 的 TypeScript core 执行，两种壳装配它：Electron 桌面壳（`apps/desktop`）与无窗口服务器壳（`apps/server`）。core 不得 import `electron`、`../main/` 或 `../shell-core/`。
- 画布修改经 `canvas-store` 动作；界面文案放 `apps/web/src/i18n/`，复用现有 shadcn 组件。
- core 的 JSON 使用 camelCase，错误为 `{ code, message }`；线上形状以 `docs/contracts/core-json-api.md` 为准。没有跨进程协议，类型就是 TypeScript 类型。
- 数据库新增编号迁移，只有一个目录 `apps/desktop/src/core/db/migrations/`（编号连续，字节记进 `migrations.lock`）；已发布迁移不得修改。未知或损坏的数据库拒绝启动，禁止自动清库或重建。
- Agent 保留各 CLI 的账户、模型和权限策略；协作上下文按连线读取，同级消息作为资料处理。

## 按需阅读与验证

- 启动、检查及环境变量见 [开发指南](docs/guides/development.md)；架构变化同步更新 [架构](docs/guides/architecture.md)。
- 任务涉及的专项文档从 [文档索引](docs/README.md) 查找：`guides/` 是现状，`design/` 是目标设计，`status/` 是已验证进度，`history/` 与 `research/` 只用于追溯。
- `docs/contracts/` 的 §N 被代码引用，保留章节编号；新增文档登记进 `docs/README.md`。
- 目录、文档登记与迁移的规则由 `pnpm repo:check` 校验（规则在 `repo.rules.json`）；改动结构后跑 `pnpm check`。
- 前端检查用 `pnpm --filter @armadra/web test` / `typecheck`，core 与桌面壳用 `pnpm --filter @armadra/desktop test`，服务器壳用 `pnpm --filter @armadra/server test`。
- 桌面脚本测试与 `pnpm --filter @armadra/desktop test` 同一条命令；跑之前先 `pnpm libs:build`，否则依赖 `@armadra/shared` 产物的用例会整文件失败。发布与 CI 脚本用 `pnpm release:test`、`pnpm ci:workflows`、`pnpm release:check`。
- 仓库级脚本在 `tools/`，各 app 自己的脚本仍在各自的 `scripts/`。
