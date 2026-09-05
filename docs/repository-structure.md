# 仓库结构、规则与完整性校验

> 状态：2026-09-05 确定的目标结构与校验方案，**延后实施**：待功能预期总表中进行中的任务完成后再整体调整，期间不做零散目录移动。现状描述以源码为准；调整顺序见 §5。
> 目的：让 Desktop、Web、Go 中转服务、Rust 执行层各自打包在固定位置，文档与脚本有统一登记规则，并由一条命令校验仓库完整性。

## 1. 现状评估

按层划分的目录（`apps/`、`crates/`、`packages/`、`proto/`）本身是合理的，问题集中在五处：

| 问题                                                                                                                                   | 影响                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/runtime` 同时是业务权威（`canvas.db`、HTTP 路由）和执行层，与 `apps/host` 职责重叠                                               | 两套后端、两个数据库、两份路由；迁移期间边界靠文档约束       |
| 单文件过大：`api.rs` 4.7k 行（路由与测试同文件）、`git_repository.rs` 2.7k 行、`terminal/mod.rs` 2k 行                                 | 冲突频繁，审阅困难，测试与实现无法分开跑                     |
| 没有 CI，也没有统一校验入口：`armadra.sh check`、pnpm scripts、`scripts/*.mjs`、Go 与协议检查各自独立                                  | 「文档写了但没登记」「生成文件漂移」「忘跑 Go 测试」无人拦截 |
| 文档 20 余份平铺在 `docs/`，目标设计、现状、计划、历史混排；`§N` 被代码引用的两份计划不能随意移动                                      | 新人分不清哪份是现行契约                                     |
| 根目录有 `output/`、`design/`、`.idea`、`.playwright-cli` 等非源码内容，`packages/protocol-ts` 目录名与包名 `@armadra/protocol` 不一致 | 打包与脚本要写特例                                           |

结论：层级不必推倒，需要补齐「每类目录的固定规则 + 一条校验命令 + CI」，并在业务迁移时把 Runtime 明确降为 Worker。

## 2. 目标结构

```text
.
├── apps/                      可运行产物，每个目录独立打包
│   ├── desktop/               Tauri 壳：窗口、托盘、sidecar、更新（不写业务）
│   ├── web/                   React / tldraw 前端（唯一页面）
│   ├── host/                  Go 中转服务：身份、调度、事件、业务状态、Worker 管理
│   └── worker/                Rust 执行层（由 apps/runtime 演进）：终端、文件、Git、Hook、进程测量
├── crates/                    Rust 库，只被 apps 或其他 crate 依赖
│   ├── protocol/              Protobuf 生成与契约测试
│   ├── hook/                  armadra-hook 客户端（现 crates/armadra-hook）
│   └── (session-host/ browser-worker/ 后续按需新增)
├── packages/                  TypeScript 库
│   ├── shared/                领域模型、CLI 注册表、schema
│   ├── protocol/              Protobuf 生成（现 protocol-ts，目录名与包名对齐）
│   └── host-client/           Host 握手与身份客户端
├── proto/                     契约唯一来源 + fixtures
├── tools/                     仓库级脚本（现 scripts/）：protocol、smoke、repo-check、release
│   └── probes/                可行性探针，不进入发布
├── docs/
│   ├── README.md              索引，唯一入口
│   ├── guides/                开发、架构、约定、平台说明（现行事实）
│   ├── design/                目标设计（canvas-platform、host-protocol、git-github …）
│   ├── status/                实施记录与功能预期总表
│   ├── contracts/             被代码 §N 引用的计划文档，只增不改编号
│   ├── history/               被取代的文档
│   └── research/              研究材料
├── assets/brand/              Logo 源文件（现 design/logo-concepts）
├── .github/workflows/         CI
├── AGENTS.md CLAUDE.md README.md LICENSE
├── armadra.sh                 开发者入口，内部只调用 tools/ 与包脚本
├── package.json pnpm-workspace.yaml tsconfig.base.json
├── Cargo.toml Cargo.lock
└── repo.rules.json            §3 规则的机器可读版本，供 tools/repo-check 读取
```

打包位置：

| 产物             | 来源           | 输出                                                                    |
| ---------------- | -------------- | ----------------------------------------------------------------------- |
| 桌面安装包       | `apps/desktop` | `target/release/bundle/`                                                |
| Web 静态产物     | `apps/web`     | `apps/web/dist/`，桌面打包时嵌入                                        |
| `armadra-host`   | `apps/host`    | `target/release/armadra-host-<triple>`                                  |
| `armadra-worker` | `apps/worker`  | `target/release/armadra-worker-<triple>`                                |
| `armadra-hook`   | `crates/hook`  | `target/release/armadra-hook-<triple>`                                  |
| 协议生成         | `proto/`       | `crates/protocol/src/gen`、`packages/protocol/src/gen`、`apps/host/gen` |

所有 sidecar 统一由 `apps/desktop/scripts/prepare-sidecar.mjs` 暂存，不再各自约定输出路径。

## 3. 统一规则

规则写入 `repo.rules.json`，由 `tools/repo-check.mjs` 执行；下面是规则的自然语言版本。

### 3.1 目录与包

| 规则                                                                                         | 校验方式                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/*` 每个目录必须有 `README.md`，且提供 `test` 与 `typecheck`/`vet`/`clippy` 之一        | 读取 package.json / Cargo.toml / go.mod      |
| `packages/*` 目录名等于包名去掉 `@armadra/` 前缀                                             | 比对 `name` 字段                             |
| `crates/*` 目录名等于 crate 名去掉 `armadra-` 前缀                                           | 比对 `[package].name`                        |
| `apps/web` 不得导入 `child_process`、`fs`、`net`；`apps/desktop` 的 Rust 不得依赖 sqlx / git | grep import 与 Cargo 依赖                    |
| 业务写入只在 `apps/host`（迁移完成前允许 `apps/worker` 保留白名单表）                        | 白名单在 rules 文件内，缩减时更新            |
| 源码单文件不超过 1500 行，测试不与实现同文件（Rust 用 `tests/` 或 `*_test.rs` 子模块）       | 行数统计；现有超限文件登记在豁免表并逐步拆分 |

### 3.2 协议与生成文件

| 规则                                                           | 校验方式                             |
| -------------------------------------------------------------- | ------------------------------------ |
| `proto/` 是唯一来源；三处生成目录只能由 `protocol:generate` 改 | `protocol:check` 比对生成物 diff     |
| 字段号不复用、删除字段 `reserved`、枚举 0 为 UNSPECIFIED       | `buf lint`/自定义 lint 读取 `.proto` |
| 每个 `.proto` 至少一个 `proto/fixtures/*.hex` 与三端契约测试   | 文件名匹配                           |

### 3.3 数据库与迁移

| 规则                                          | 校验方式                                  |
| --------------------------------------------- | ----------------------------------------- |
| 迁移文件编号连续、已发布文件字节不变          | `migrations.lock` 记录 sha256，检查时比对 |
| 新迁移必须附带 `db.rs`/`schema.go` 的测试用例 | 新增迁移文件时要求同 PR 含对应测试改动    |

### 3.4 文档

| 规则                                                                                  | 校验方式                        |
| ------------------------------------------------------------------------------------- | ------------------------------- |
| `docs/**/*.md` 必须在 `docs/README.md` 登记（history/ 与 research/ 只登记目录）       | 解析索引链接集合                |
| 相对链接必须可解析                                                                    | 遍历 Markdown 链接              |
| `docs/contracts/` 内文档的 `## N.` 编号只增不改                                       | 与上一次提交比对标题编号序列    |
| `docs/design/` 首行必须声明状态（目标设计 / 已实施）；`docs/status/` 只记录已验证事实 | 正则匹配首段                    |
| 架构改动同 PR 更新 `docs/guides/architecture.md`                                      | 变更触及 apps/\* 顶层目录时提示 |

### 3.5 界面与本地化

| 规则                                          | 校验方式                               |
| --------------------------------------------- | -------------------------------------- |
| 文案只在 `apps/web/src/i18n/`，中英键集合一致 | 现有 `i18n.test.ts`，纳入 repo-check   |
| 组件只用 `apps/web/src/ui/` 内的 shadcn 实现  | 禁止直接 import `radix-ui` 到 ui/ 之外 |

### 3.6 仓库卫生

| 规则                                                                           | 校验方式                  |
| ------------------------------------------------------------------------------ | ------------------------- |
| 禁止提交：`output/`、`*.db*`、`.idea/`、`.playwright-cli/`、`dist/`、`target/` | `git ls-files` 匹配黑名单 |
| 根目录只允许白名单文件                                                         | 目录列表比对              |
| 提交信息 `type(scope): subject`，scope 取自目录名                              | commit-msg 钩子（可选）   |
| 分支与 worktree 命名 `feature/`、`fix/`、`docs/` 前缀                          | 文档约定，不强制          |

## 4. 校验入口

```sh
pnpm repo:check          # tools/repo-check.mjs：§3 全部静态规则，秒级
pnpm check               # format:check + typecheck + protocol:check + repo:check
pnpm test                # web / shared / protocol-ts / desktop 脚本
cargo test --workspace   # worker、hook、protocol
go -C apps/host test ./...
./armadra.sh check       # 本地一键：以上全部
```

CI（`.github/workflows/ci.yml`）按改动路径分作业：

| 作业     | 触发路径                                 | 内容                                            |
| -------- | ---------------------------------------- | ----------------------------------------------- |
| repo     | 任意                                     | `pnpm check`、`pnpm repo:check`                 |
| web      | `apps/web`、`packages/`                  | test、typecheck、build                          |
| rust     | `apps/worker`、`crates/`、`apps/desktop` | fmt、clippy `-D warnings`、test                 |
| host     | `apps/host`、`proto/`                    | vet、test `-race`、Windows/Linux 交叉编译       |
| protocol | `proto/`                                 | generate 后 diff 为空、三端契约测试             |
| desktop  | `apps/desktop`                           | prepare-sidecar、`tauri build --debug`（macOS） |

分支保护要求 repo 与受影响作业通过；发布分支额外跑 desktop。

## 5. 调整顺序

按风险从低到高，每步单独提交并跑全量检查：

1. 新增 `tools/repo-check.mjs` 与 `repo.rules.json`，先只做「文档登记、链接、黑名单文件、包名一致」四条；加 `pnpm repo:check` 与 CI。
2. 清理根目录：`output/` 加入忽略并删除已跟踪文件，`design/logo-concepts` 移到 `assets/brand`，更新 README 链接。
3. `packages/protocol-ts` → `packages/protocol`，`crates/armadra-hook` → `crates/hook`；只改路径与 workspace 配置，不改代码。
4. `scripts/` → `tools/`，`armadra.sh` 与 `package.json` 指向新路径。
5. 文档分目录：`guides/`、`design/`、`status/`、`contracts/`；移动前 grep 代码中的文件名引用（`v3-agent-terminal-plan`、`tldraw-canvas-plan` 在 web、runtime 与 shared 中被注释引用），一并更新。
6. 拆分超大文件：`api.rs` 的测试移到 `tests/`，路由按 workspace / terminal / git / settings 分模块；`git_repository.rs` 按 status / refs / history / operations 拆分。行数规则先以豁免表方式启用。
7. 随 H01 写入所有权切换，`apps/runtime` → `apps/worker`，Host 成为唯一业务写入方；此时删除白名单表规则。

第 1–4 步不改变任何运行行为，可在一天内完成；第 5 步需同步更新所有文档链接；第 6–7 步随功能迁移进行。
