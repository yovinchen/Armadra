<img src="./apps/web/public/icon.png" alt="Armadra" width="96" />

# Armadra

本地优先的桌面画布：把 Claude Code、Codex、Gemini CLI、opencode 这些 CLI Agent
作为终端节点放在一块 tldraw 白板上，节点之间连一条线就能把上下文传过去。

> A local-first desktop canvas that puts Claude Code, Codex, Gemini CLI and
> opencode on a tldraw whiteboard as live terminal nodes, and passes context
> between them by drawing a link.

## 功能

**Agent 终端节点**

- 节点里跑的是真实 CLI，不经过中间协议；终端由 tmux 托管，Runtime 重启后会话还在。
- 状态（工作中 / 等待 / 阻塞 / 完成）来自各 CLI 的 hook 回报，不靠猜屏幕内容。
- 权限请求在节点头部直接回答，不用切回终端敲键。
- 支持 `default` / `auto-edit` / `full-auto` / `plan` 四种权限模式与 resume 已有会话。
- 内置 Claude Code、Codex、Gemini CLI、opencode，可用 `custom:<id>` 接自定义 CLI。

**白板**

- 手绘、高亮、几何图形、直线箭头、文字、图片、画框分区，都是 tldraw 原生 shape。
- 白板内容与节点共用一套相机、选择和撤销栈。

**连线即上下文**

- 节点连节点：Agent 能读对方的转录、摘要或终端画面。
- 白板内容连节点：便签、文字、图片、画框里的东西都能被 Agent 读到。

**Agent 协作**

- 互相读取转录、互发消息、在画布上开新节点、建便签、连线、改名改色、关节点。
- 子代理以卡片形式挂在父节点旁边。

**其他节点**：便签、分组、代码编辑器（CodeMirror 6）、Git 差异、文件树、内嵌浏览器。

**会话与检索**：Runtime 扫描各 CLI 的本地转录建索引，命令面板里可跨项目搜索并 resume。

**终端后端**：tmux（默认）、直连 PTY、SSH 远程主机。

**Git**：状态、diff、暂存 / 取消暂存 / 还原、提交、克隆仓库。

**设置**：主题与语言（简体中文 / English）、白板偏好、快捷键、Agent 与 hook 安装、
终端后端、SSH 主机、数据目录与备份、用量配额。

## 技术栈

| 层      | 技术                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| 前端    | React 19、Vite、tldraw 5、shadcn/ui（Radix）、Tailwind v4、xterm.js、CodeMirror 6、Zustand、TanStack Query |
| Runtime | Rust、Axum、Tokio、SQLx + SQLite、portable-pty、tmux                                                       |
| 桌面    | Tauri 2                                                                                                    |
| 工程    | pnpm workspace + Cargo workspace                                                                           |

## 快速开始

前置：Node.js ≥ 22、pnpm 11、Rust stable、tmux、macOS ≥ 13.3（桌面端）。

一条命令从检查到运行：

```bash
./armadra.sh all        # doctor → install → check → build → run
./armadra.sh run web    # 只起 Runtime 与浏览器里的前端
./armadra.sh help       # 全部子命令
```

分步执行：

```bash
pnpm install

# Runtime，监听 127.0.0.1:43120
cargo run -p armadra-runtime

# 前端，浏览器里跑
pnpm --filter @armadra/web dev

# 或者跑桌面壳
pnpm --filter @armadra/desktop dev
```

打包桌面端：

```bash
pnpm --filter @armadra/desktop build
```

测试：

```bash
pnpm --filter @armadra/web test
pnpm --filter @armadra/shared test
cargo test -p armadra-runtime
```

数据放在 `~/Library/Application Support/Armadra`（macOS），工作区内的图片资产、
导出与板日志放在项目的 `.armadra/` 目录。更多命令与环境变量见
[docs/development.md](./docs/development.md)。

## Agent 侧

在设置的「Hook」页给某个 CLI 安装 hook，Runtime 会把 hook 命令写进该 CLI 的配置文件，
并装上两个技能：`armadra-canvas`（在画布上开节点、建便签、连线、发消息）与
`armadra-linked-context`（读取相连节点的转录、摘要或终端画面）。Claude 装成
`~/.claude/skills/<name>/SKILL.md`，其余 CLI 写进各自指令文件里一段带标记的区块，
卸载时原样移除。

## 目录

```text
apps/web/         React 前端，唯一页面
apps/runtime/     Rust 执行服务（终端、文件、Git、hook、协作、会话索引）
apps/desktop/     Tauri 2 薄壳
crates/armadra-hook/   注入 Agent 终端的 hook 客户端
packages/shared/  领域模型、Agent 注册表、API 与 hook 事件的 zod schema
docs/             文档
```

## 品牌

Logo 源文件是 [`design/logo-concepts/armadra-armadillo-primary.png`](./design/logo-concepts/armadra-armadillo-primary.png)；
桌面端各平台图标由它生成到 `apps/desktop/src-tauri/icons/`，Web favicon 同步为
`apps/web/public/icon.png`。换 Logo 先换源文件，再重新生成派生资源。

## 文档

[docs/README.md](./docs/README.md) 是文档索引。架构见
[docs/architecture.md](./docs/architecture.md)。

## 许可

[MIT](./LICENSE)。
