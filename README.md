# AI Coding Canvas

一个 local-first 的 AI Coding 工作台：在无限工作区中组织终端、Agent、文件、任务、浏览器、日志和 Diff，通过语义连线传递上下文，并让执行结果回流为可审查节点。

## 品牌标识

- 当前名称保持为 **AI Coding Canvas**。
- 默认 Logo 源文件为 [`design/logo-concepts/armadra-armadillo-primary.png`](./design/logo-concepts/armadra-armadillo-primary.png)。
- 桌面端各平台图标由该源文件生成到 `apps/desktop/src-tauri/icons/`；Web favicon 同步为 `apps/web/public/icon.png`。
- 如需更换默认 Logo，应先替换或确认源文件，再重新生成桌面端图标，避免各平台品牌资源不一致。

## 当前状态

Phase 1 MVP 已实现，并于 2026-09-02 按设计稿完成 v2 桌面端界面重构：启动页与多工作空间/多看板、10 类节点与三态缩放、6 种语义连线、拖拽/粘贴创建、手绘标注、一键整理、⌘K、设置与 Diff 扫描抽屉。网关与外部端为预留。

已确认的技术边界：

- 唯一前端：React + TypeScript + Vite。
- 主画板：React Flow（`@xyflow/react`）；节点/连线/看板数据由 Runtime SQLite 持久化。
- 自由白板：Quickdraw 作为后置的可选 `WhiteboardNode`。
- 终端：xterm.js + PTY + WebSocket。
- Agent：ACP v1；支持 Claude、Codex、Gemini、OpenCode、Pi 与 OMP，并保留 Custom ACP 入口。
- 唯一执行服务：Rust + Axum + Tokio。
- 本地存储：SQLite。
- 桌面端：Tauri 2 薄壳。

## 文档

- [最终架构与画板选型](./docs/architecture.md)
- [Phase 1 需求与验收矩阵](./docs/requirements.md)
- [界面设计基线（v2）](./docs/interface-design.md)
- [v2 重构差距分析与实施契约](./docs/redesign-plan.md)
- [设计稿交接包](./docs/design/handoff/README.md)
- [实现状态与验证证据](./docs/implementation-status.md)
- [完整 ChatGPT 会话归档](./docs/research/chatgpt-conversation-archive.md)
- [文档索引](./docs/README.md)

## 工程目录

```text
apps/
  web/       React 主界面（app 壳 / shell / sidebar / canvas / nodes / inspector / modals / i18n / styles）
  runtime/   Rust 执行服务（工作空间、看板、PTY、ACP、Git、网关预留）
  desktop/   Tauri 2 薄桌面壳（dialog / opener 插件）
packages/
  shared/    领域模型、协议与 Schema
docs/
  architecture.md
  redesign-plan.md
  design/handoff/
  research/
```

## 本地运行

需要 Node.js 22+、pnpm 11+ 和 Rust 1.97+。

```bash
pnpm install
cargo run -p ai-coding-canvas-runtime
pnpm --filter @ai-coding-canvas/web dev
```

Runtime 默认监听 `127.0.0.1:43120`，Web 默认监听 `127.0.0.1:1420`。

Pi 通过固定版本 `pi-acp@0.0.33` 桥接 ACP；OMP 使用原生 `omp acp`。Runtime 会补齐 macOS GUI 通常缺失的 Homebrew、mise shims 与 mise Node 安装目录，因此在终端中可用的 Agent 不会仅因从 `.app` 启动就被误判为未安装。

验证：

```bash
cargo test -p ai-coding-canvas-runtime
pnpm check:rust
pnpm typecheck
pnpm test
pnpm build
```

实现仍以 [`docs/architecture.md`](./docs/architecture.md) 为决策基线；Phase 2–4 不用占位功能冒充完成。
