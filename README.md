<img src="./apps/web/public/icon.png" alt="Armadra" width="96" />

# Armadra

本地优先的桌面画布：将真实 CLI Agent 放在无限画布上，通过连线共享上下文。
支持 Claude Code、Codex、OpenCode、Pi、OMP 和 GitHub Copilot。

## 能做什么

- **终端与会话**：tmux、直连 PTY、SSH；按各 CLI 实际能力提供恢复、权限模式、Hook 状态和子代理卡片。
- **画布**：白板绘图、便签、分组、编辑器、Git 差异、文件树和浏览器节点。
- **协作**：按连线读取上下文，使用 `post / inbox / ack` 消息箱；默认不向其他终端自动粘贴消息。
- **开发工具**：Git 状态与提交、会话检索、用量、主题、语言、数据备份。

会话索引目前覆盖 Claude / Codex；各 Agent 的能力差异见 [协作说明](docs/guides/agent-collaboration.md)。

## 快速开始

需要 Node.js ≥ 22 与项目锁定的 pnpm，没有别的工具链。
建议安装 tmux，缺失时使用直连 PTY。macOS 桌面目标为 ≥ 13.3。

```sh
pnpm install
./armadra.sh run web       # core + 浏览器前端
# 或
./armadra.sh run desktop   # 桌面壳持有 core
```

```sh
pnpm --filter @armadra/desktop build   # 桌面打包
./armadra.sh help                     # 脚本命令
```

分步启动、检查、端口与数据位置见 [开发指南](docs/guides/development.md)。

## 项目结构

| 目录                                         | 职责                                            |
| -------------------------------------------- | ----------------------------------------------- |
| [apps/web](apps/web/README.md)               | React / Vite / React Flow 前端                  |
| [apps/desktop](apps/desktop/README.md)       | Electron 桌面壳，`src/core/` 是业务所在         |
| apps/server                                  | 无窗口服务器壳：同一个 core，外加托管前端与认证 |
| [packages/shared](packages/shared/README.md) | 领域模型、CLI 注册表与 JSON schema              |

业务由一个 Electron-free 的 TypeScript core 执行，两种壳装配它；进度见
[TypeScript Core 进度](docs/status/typescript-core-status.md)，结构见
[架构](docs/guides/architecture.md)。

## 文档与品牌

[文档索引](docs/README.md) · [架构](docs/guides/architecture.md) · [开发约定](AGENTS.md)

Logo 使用[唯一源文件](assets/brand/armadra-armadillo-primary.png)，再生成桌面图标与 Web favicon。

[MIT License](LICENSE)
