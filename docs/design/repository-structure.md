# 仓库结构、规则与完整性校验

> 状态：**部分实施**。方案本身（目标结构、六类规则、校验入口、七步顺序）保持完整；现状描述以源码为准，调整顺序见 §5。
> 2026-09-06：§5 第 1–5 步已实施；第 6 步（大文件拆分）另行进行；第 7 步延后。
> 目的：让 Desktop、Web、Go 中转服务、Rust 执行层各自打包在固定位置，文档与脚本有统一登记规则，并由一条命令校验仓库完整性。
> 2026-09-19：桌面壳已换成 Electron，本文提到 Tauri 的部分是换壳之前写下的，只作为当时的方案记录；壳的现状见 [Electron 迁移](./electron-migration.md) 与 [架构](../guides/architecture.md)。
> 后续变更：Rust Runtime、Go Host、`crates/`、`proto/` 已在之后一轮改造中整体合并重写为一个 TypeScript core（`apps/desktop/src/core/`），由 Electron 桌面壳（`apps/desktop`）与新增的无窗口服务器壳（`apps/server`）装配，仓库里不再有 `.rs` / `.go` / `.proto` 文件。以下 §1、§2 的目标目录树、§3.1–§3.3 的 Rust/Go/Protobuf 具体规则、§4 的 `cargo`/`go` 校验命令与 CI 矩阵、§5 的调整顺序，都是那一轮改造之前写下的方案记录，已被 [TypeScript Core 设计](./typescript-core.md) 的目标目录（`apps/desktop/src/core/*` 与 `apps/server/`）取代；仍然适用的是与语言无关的通用规则——文档登记与链接、`docs/` 分区职责、`tools/` 归属仓库级脚本、根目录白名单、提交信息与分支命名——这些保留在下文，不因语言变化而失效。

## 1. 现状评估

> 以下是 Rust Runtime / Go Host 多语言阶段的现状记录，仅供追溯；该阶段已结束，现状见顶部「后续变更」。

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

> 以下目录树是 Rust Runtime / Go Host 阶段写下的目标记录，已被 [TypeScript Core 设计](./typescript-core.md) 顶部列出的目标目录（`apps/desktop/src/core/*` 与新增的 `apps/server/`）取代，仅供追溯。

```text
.
├── apps/                      可运行产物，每个目录独立打包
│   ├── desktop/               Electron 壳：窗口、托盘、受管二进制、更新（不写业务）
│   ├── web/                   React / React Flow 前端（唯一页面）
│   ├── host/                  Go 中转服务：身份、调度、事件、业务状态、Worker 管理
│   └── worker/                Rust 执行层（由 apps/runtime 演进）：终端、文件、Git、Hook、进程测量
├── crates/                    Rust 库，只被 apps 或其他 crate 依赖
│   ├── protocol/              Protobuf 生成与契约测试
│   ├── hook/                  armadra-hook 客户端（第 3 步已改名）
│   └── (session-host/ browser-worker/ 后续按需新增)
├── packages/                  TypeScript 库
│   ├── shared/                领域模型、CLI 注册表、schema
│   ├── protocol/              Protobuf 生成（第 3 步已与包名对齐）
│   └── host-client/           Host 握手与身份客户端
├── proto/                     契约唯一来源 + fixtures
├── tools/                     仓库级脚本（第 4 步已迁入）：protocol、smoke、repo-check
│   └── probes/                可行性探针，不进入发布
├── docs/
│   ├── README.md              索引，唯一入口
│   ├── guides/                开发、架构、约定、平台说明（现行事实）
│   ├── design/                目标设计（canvas-platform、host-protocol、git-github …）
│   ├── status/                实施记录与功能预期总表
│   ├── contracts/             被代码 §N 引用的计划文档，只增不改编号
│   ├── history/               被取代的文档
│   └── research/              研究材料
├── assets/brand/              Logo 源文件（第 2 步已迁入）
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

规则写入 `repo.rules.json`，由 `tools/repo-check.mjs` 执行；下面是规则的自然语言版本，写于 Rust Runtime / Go Host 阶段。§3.1 里针对 `crates/*`、Cargo/go.mod 的具体校验与 §3.2 整节（`proto/` 作为唯一来源、`buf lint`、三端契约测试）已随语言合并作废——现在没有跨进程协议，契约就是 TypeScript 类型（见 [TypeScript Core 设计](./typescript-core.md) 与 AGENTS.md）；目录扁平化、单文件行数上限、文档登记、i18n 与仓库卫生这些与语言无关的规则仍然适用，只是校验方式要换成读 `package.json` 而非 `Cargo.toml`/`go.mod`。

### 3.1 目录与包

| 规则                                                                                                                                   | 校验方式                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/*` 每个目录必须有 `README.md`，且提供 `test` 与 `typecheck` 脚本                                                                 | 读取 `package.json`                          |
| `packages/*` 目录名等于包名去掉 `@armadra/` 前缀                                                                                       | 比对 `name` 字段                             |
| ~~`crates/*` 目录名等于 crate 名去掉 `armadra-` 前缀~~                                                                                 | 已废弃：仓库不再有 `crates/`                 |
| `apps/web` 不得导入 `child_process`、`fs`、`net`；core（`apps/desktop/src/core/`）不得 import `electron`、`../main/`、`../shell-core/` | grep import                                  |
| 业务写入只在 core                                                                                                                      | 现状即如此，无需白名单表                     |
| 源码单文件不超过约定行数，测试不与实现同文件                                                                                           | 行数统计；现有超限文件登记在豁免表并逐步拆分 |

### 3.2 协议与生成文件（已废弃，仅供追溯）

> `proto/` 目录与 Protobuf 生成流程已随语言合并移除；跨端契约现在直接是 TypeScript 类型，形状以 `docs/contracts/core-json-api.md` 为准。以下三条规则不再适用。

| 规则                                                               | 校验方式                                 |
| ------------------------------------------------------------------ | ---------------------------------------- |
| ~~`proto/` 是唯一来源；三处生成目录只能由 `protocol:generate` 改~~ | ~~`protocol:check` 比对生成物 diff~~     |
| ~~字段号不复用、删除字段 `reserved`、枚举 0 为 UNSPECIFIED~~       | ~~`buf lint`/自定义 lint 读取 `.proto`~~ |
| ~~每个 `.proto` 至少一个 `proto/fixtures/*.hex` 与三端契约测试~~   | ~~文件名匹配~~                           |

### 3.3 数据库与迁移

| 规则                                 | 校验方式                                  |
| ------------------------------------ | ----------------------------------------- |
| 迁移文件编号连续、已发布文件字节不变 | `migrations.lock` 记录 sha256，检查时比对 |
| 新迁移必须附带对应域的测试用例       | 新增迁移文件时要求同 PR 含对应测试改动    |

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

> 下面的命令块是 Rust Runtime / Go Host 阶段写下的，`cargo test`、`go test`、`protocol:check` 已不存在。现状命令以 AGENTS.md 为准：`pnpm repo:check`、`pnpm check`；前端用 `pnpm --filter @armadra/web test` / `typecheck`；core 与桌面壳用 `pnpm --filter @armadra/desktop test`（跑之前先 `pnpm libs:build`）；服务器壳用 `pnpm --filter @armadra/server test`；发布与 CI 脚本用 `pnpm release:test`、`pnpm ci:workflows`、`pnpm release:check`。

```sh
pnpm repo:check          # tools/repo-check.mjs：§3 全部静态规则，秒级
pnpm check               # format:check + typecheck + repo:check
pnpm libs:build          # desktop / server 测试依赖的产物，先构建
./armadra.sh check       # 本地一键：以上全部
```

CI（`.github/workflows/ci.yml`）在 Rust Runtime / Go Host 阶段是一个三平台矩阵作业，不按路径分：平台差异出在
终端后端（tmux / Unix socket 对 ConPTY / 命名管道），而这类问题只有在三个系统上
都跑过才暴露，按路径裁剪会正好跳过它——这条理由本身与语言无关，现状 CI 是否仍是三平台矩阵、具体跑哪些
`pnpm --filter` 命令，以实际的 `.github/workflows/ci.yml` 与 [CI 与发布](../guides/ci-release.md) 为准；下表与后一段的
`cargo clippy` / `go vet` 等具体步骤是旧实现，已作废。

| 矩阵行           | 内容                                                  |
| ---------------- | ----------------------------------------------------- |
| `ubuntu-latest`  | 下列全部，外加 Host 对另外三个 GOOS/GOARCH 的交叉编译 |
| `macos-14`       | 下列全部                                              |
| `windows-latest` | 下列全部，Go 不开 `-race`（需要 cgo）                 |

每行（旧实现）：`pnpm check`、`pnpm repo:test` / `release:test`、`pnpm -r test` /
`typecheck`、web build、`pnpm protocol:test`、`cargo clippy -D warnings`、
`cargo test`（均 `--exclude armadra-desktop`）、Go `vet` 与 `test`、桌面壳
`cargo check`。分支保护要求这三行都通过。

平台专属用例用条件编译或运行时平台判断门控，CI 不做按名字过滤的
排除；`pnpm ci:workflows` 会校验工作流里没有这类过滤，也会校验 runner 标签与
发布矩阵的三元组与 `tools/release/artifacts.mjs` 一致（这条校验脚本仍在，具体内容随发布产物演进）。

## 5. 调整顺序（Rust Runtime / Go Host 阶段的历史记录）

> 状态行与开头已记录第 1–5 步已实施；第 6、7 步描述的「拆分 `api.rs`/`git_repository.rs`」「`apps/runtime` → `apps/worker`，Host 成为唯一业务写入方」并未按这个方向走完——实际走向是把 Runtime、Host、crates、proto 整体合并重写成 TypeScript core，而不是把 Runtime 降级为 Worker。以下步骤仅供追溯当时的排期思路。

按风险从低到高，每步单独提交并跑全量检查：

1. 新增 `tools/repo-check.mjs` 与 `repo.rules.json`，先只做「文档登记、链接、黑名单文件、包名一致」四条；加 `pnpm repo:check` 与 CI。
2. 清理根目录：`output/` 加入忽略并删除已跟踪文件，`design/logo-concepts` 移到 `assets/brand`，更新 README 链接。
3. `packages/protocol-ts` → `packages/protocol`，`crates/armadra-hook` → `crates/hook`；只改路径与 workspace 配置，不改代码。
4. `scripts/` → `tools/`，`armadra.sh` 与 `package.json` 指向新路径。
5. 文档分目录：`guides/`、`design/`、`status/`、`contracts/`；移动前 grep 代码中的文件名引用（`v3-agent-terminal-plan` 在 web、runtime 与 shared 中被注释引用；已归档的旧画布契约移入 `history/` 后，注释里只保留它的 §N 编号，不写路径），一并更新。
6. 拆分超大文件：`api.rs` 的测试移到 `tests/`，路由按 workspace / terminal / git / settings 分模块；`git_repository.rs` 按 status / refs / history / operations 拆分。行数规则先以豁免表方式启用。
7. 随 H01 写入所有权切换，`apps/runtime` → `apps/worker`，Host 成为唯一业务写入方；此时删除白名单表规则。

第 1–4 步不改变任何运行行为，可在一天内完成；第 5 步需同步更新所有文档链接；第 6–7 步随功能迁移进行。
