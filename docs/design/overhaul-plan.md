# 全面修改方案（2026-09）

> 状态：目标设计（总纲）。本文是接下来一轮全部改动的唯一入口：把已经完成的 Electron 换壳收口，补齐用户提出的界面与功能要求，并按已拍板的方向把 Rust Runtime 与 Go Host 合并为**一个 TypeScript 核心**。各专项的细节在各自设计文档里，本文只定范围、顺序、团队与验收。
> 范围：`apps/desktop`、`apps/web`、`apps/runtime`（逐域退役）、`apps/host`（逐域退役）、`crates/*`、`proto/`、`docs/`、CI 与发布。
> 输入：主线 `359058afd`（Electron 壳已实施；全量测试全绿）；用户 2026-09-19 的四项要求（见 §1）。

## 1. 用户要求与硬性规则

| #   | 要求                                                                                                                                                      | 落点                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| U1  | 全部内容合入 `main`，测试全部通过，问题全部修复                                                                                                           | §4 P0；每批合入后主树重跑全量回归                                    |
| U2  | 全部功能检查与设计复查，看功能是否完善                                                                                                                    | §4 P2（复查报告 → 修复批）                                           |
| U3  | 新建窗口（含浏览器）按标准浏览器大小创建，内容按比例展示，终端等内容更多、chrome 更少                                                                     | §4 P1（节点尺寸与密度）                                              |
| U4  | 画板可从 Mermaid 图导入并画到页面上                                                                                                                       | §4 P1（Mermaid 导入，设计见 [mermaid-import.md](mermaid-import.md)） |
| U5  | 名称与 logo 全部替换；侧栏头部对齐                                                                                                                        | §4 P1（品牌与头部）                                                  |
| U6  | 剩余 Rust 与 Go 全部改为 TypeScript：**一个核心，两种壳**                                                                                                 | §4 P3（设计见 [typescript-core.md](typescript-core.md)）             |
| U7  | 推送仓库并进行多端编译                                                                                                                                    | §4 P4                                                                |
| R1  | **项目与一切内容统一采用 Armadra 自己的表述**（含文档、注释、提交信息、研究材料）。唯一例外：hook 修复逻辑里必须匹配的用户磁盘旧路径字面量                | §4 P4 清洗批；所有 Agent 提示词写明                                  |
| R2  | 画布修改经 `canvas-store`；文案在 i18n；只用现有 shadcn 组件；Runtime JSON camelCase、错误 `{ code, message }`；迁移编号只增、未知库拒绝启动（AGENTS.md） | 各批验收                                                             |

## 2. 现状（`359058afd`）

- 桌面壳：Electron，`apps/desktop`；回环 HTTP 静态服务；Runtime 双监听；`identity:ticket`；浏览器节点 `<webview>` + `browser:drive`；更新状态机 TS；electron-builder 三平台。Tauri 与截屏流已删除。
- 执行层：Rust Runtime 135,530 行（终端 tmux/PTY/SSH、Hook、SQLite 14 迁移、Git、语言服务、浏览器授权、资源、Worker 协议）；`crates/hook` 3,241、`crates/protocol` 5,393、`crates/session-host` 4,221。
- 服务层：Go Host 145,464 行（生成码 60,590）：身份/设备/票据、定时、事件、GitHub、更新清单、六域所有权服务（迁移做了一半）、手机端页面托管。
- 测试：web 2,355、desktop 580 + 40、host-client 291、shared 170、protocol 140、runtime 1,000+、Go 30 包——全绿。

## 3. 架构目标（U6）

```
apps/web         唯一前端（不变）
apps/desktop     Electron 壳：窗口/菜单/托盘/对话框/更新/浏览器 guest 驱动；内嵌或拉起 core
apps/desktop/src/core   Electron-free 的 TS 核心：终端、Hook/Agent、画布/设置/工作空间、身份/设备/会话、
                 定时与事件、Git/文件、语言服务、资源、GitHub、更新清单；一份 SQLite + 迁移账本
apps/server      无窗口壳：node:http + ws + HTTPS + 单 owner 认证，托管前端给浏览器与手机；同一份 core
```

删除项：`apps/runtime`、`apps/host`、`crates/*`、`proto/` 与三处生成码、`pnpm protocol:*`、Worker 协议、所有权迁移、`migrations.lock` 三处校验收敛为一处。分阶段、双实现并存、开关切换、可回滚——见 [typescript-core.md](typescript-core.md)。

## 4. 工作流

### P0 合入与回归（已完成）

`main` 快进到 `359058afd` 并推送；全量测试全绿。

### P1 界面与功能补齐（进行中，4 个并行批）

| 批                  | 内容                                                                                                                                                                                                                    | 验收                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P1.1 品牌与头部     | 开发模式 `app.setName`/Dock 图标/About；`electron-builder.yml` 品牌字段测试；侧栏头部三按钮同尺寸同基线、macOS 红绿灯留白、`no-drag`                                                                                    | desktop/web 测试绿；CDP 截图核对                             |
| P1.2 节点尺寸与密度 | browser 1280×800、terminal 960×600、editor 960×640、diff 1200×700、files 360×640、sticky 280×220；新建后相机对准到 1.0；头部 40→32、终端内边距 8→4、工具栏 28；终端默认字号 12                                          | `registry.test.ts` 与契约 §3.4 表一致；vitest 断言；CDP 截图 |
| P1.3 Mermaid 导入   | flowchart/graph → 原生几何 + 文字 + 连线（dagre 布局，可编辑，一步撤销）；其他图类型 → SVG 图片回退；入口：对话框（输入+预览）、粘贴识别、`.mmd` 拖入；`securityLevel: strict`、`htmlLabels: false`；mermaid 独立 chunk | 三种 fixture 纯函数测试；构建 chunk 体积；`pnpm check`       |
| P1.4 功能复查       | 对照功能总表逐行核查（仍成立/回退/断裂/未验证）、UI 死角、文档漂移、IPC 占位、测试盲区、Top 15 修复项、文案清洗清单                                                                                                     | `docs/status/electron-migration-review.md`                   |

### P2 复查修复

按 P1.4 的 Top 15 分「S 一个 Agent 打包做 / M、L 各一个 Agent」，每项独立提交与验收；文档漂移由同一批统一改。

### P3 TypeScript 核心（U6）

阶段 R0–R7、每阶段范围/参照/测试数/验收/风险/规模/建议 Agent 数，全部在 [typescript-core.md](typescript-core.md)。原则：

- **吸收而非移植**：Host 的职责并入 core 对应域，因分进程才存在的机制整段删除。
- **不可变契约**：HTTP/WS API 面、SQLite schema 与迁移账本、`hook-endpoint.env`/`endpoints.json`、`armadra-hook` 命令面、Agent 环境变量注入表、token 0600 文件语义、契约 §N 编号。
- **双实现并存**：壳按开关拉起 Rust Runtime 或 TS core；每个域切换后旧实现保留一个阶段再删。
- **先证明可行**：R0 骨架 + R1 画布/设置/身份（删得最多、最纯）先行；终端 R2 最难，单独一个团队。

### P4 收尾（每轮合入后都做一次的项目，最终一次性收口）

| 项                     | 做法                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Armadra 文案清洗（R1） | 删除已整合结论的七份历史研究材料；49 个文件里的注释/文档改写为 Armadra 自己的表述；`git grep -in` 检查旧名称命中归零（仅代码中的磁盘字面量例外，文档写作「旧版接入残留」）；历史提交信息中的旧名称清洗另行用 `git filter-repo --replace-text` 重写后强推（`main` 与 feature 分支） |
| 文档                   | `guides/architecture.md`、`development.md`、`feature-roadmap.md` §2 技术框架表、`client-platforms.md` 与现状一致；`docs/README.md` 登记                                                                                                                                            |
| 多端编译（U7）         | 推送后触发 `release.yml`：macOS（arm64/x64 dmg+zip）、Windows（nsis+zip）、Linux（AppImage/deb/rpm）；未签名阶段更新器关闭；本地 macOS `dist` 冷启动验收                                                                                                                           |
| 回归                   | `pnpm check`、`pnpm -r test`、`cargo test --workspace`（退役前）、`go -C apps/host test ./...`（退役前）、`pnpm protocol:test`（退役前）                                                                                                                                           |

## 5. 团队与模型

| 角色        | 模型                                                        | 用途                                                                                                               |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 设计/核心批 | Claude Opus                                                 | 跨进程边界、安全不变量、性能判断（R0–R3、浏览器驱动、Mermaid 布局）                                                |
| 机械批      | Claude Sonnet                                               | 品牌替换、文档同步、测试移植、清洗                                                                                 |
| 辅助工人    | Codex（`gpt-6-astra`，reasoning high，`codex exec` 非交互） | 大体量直译类任务（Rust 测试 → vitest、Go 路由 → TS 路由的骨架）、清洗批；每个任务独立 worktree，产物按同一验收合入 |

合并纪律：每批一个 worktree、一个分支（名字按用途，不用 `codex` 作前缀）；cherry-pick 到 `feature/host-protocol-foundation`，主树复跑触及的套件与 `pnpm check`，再快进 `main`。提交信息遵循仓库习惯，不加署名。

## 6. 顺序与依赖

```
P0 ✓ → P1.1 ∥ P1.2 ∥ P1.3 ∥ P1.4 → P2（按 P1.4）→ P3 R0 → R1 ∥（R2 团队）→ R3 → R4 ∥ R5 → R6 → R7 → P4 收口
                                   └ typescript-core.md 设计评审（用户）在 P3 之前
P4 的清洗与多端编译在 P2 后先做一次（让仓库尽早干净、CI 尽早验证），P3 完成后再做最终一次。
```

## 7. 验收总表

- 用户可见：新建浏览器节点即标准浏览器尺寸且 1:1 可用；终端 960×600 下约 120×36；Mermaid 三类样例导入正确；Dock/菜单/About 全是 Armadra；侧栏头部对齐。
- 仓库：`git grep -in` 检查旧名称仅剩代码中的磁盘字面量，`docs/` 与 `tools/` 无残留；`pnpm check` 全绿；三平台产物在 CI 落地。
- 架构：P3 结束时仓库里没有 `.rs`、`.go`、`.proto`；一个 core、两种壳；一份数据库与账本。
