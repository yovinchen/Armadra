# Git 工具窗口：IDEA 式日志与提交

> 状态：目标设计（2026-09-07）。取代 [git-github-design.md](./git-github-design.md) §1 的页签式 `SourceControlPanel` 与 §4.2 的单仓库历史图；§2、§3、§5–§12 的仓库服务、功能范围、worktree、AI 提交信息与 GitHub 部分不变。

## 1. 为什么改

现有源码控制抽屉是 460px 宽的右侧抽屉，塞了九个页签（变更 / 分支 / 历史 / 引用日志 / Worktree / Stash / 标签 / 远端 / 合并与冲突），每个页签各自一套列表与表单；仓库切换是一个下拉框，历史图只认一个仓库、一个起点。用户实测的结论是「太繁琐」，参照对象是 JetBrains IDEA 的 Git 工具窗口：

- 一个 **日志（Log）** 页：三栏——分支树 | 提交图表格 | 提交详情与变更文件；筛选都在表格上方一条工具栏里。
- 一个 **提交（Commit）** 页：变更树（按仓库分组、复选框决定提交内容）+ 提交信息 + 提交 / 提交并推送。
- 多仓库不是切换，而是**同一张图**：所有仓库的提交按时间交错，每行左侧一条颜色条标识仓库，分支树按仓库分组，工具栏「路径」筛选可以缩到某几个仓库（IDEA 的 `VcsLogMultiRepoJoiner` 就是按时间戳合并各仓库已排好序的提交列表，图本身不区分仓库）。
- Stash、标签、远端、worktree、引用日志都不是页签：它们是分支树里的节点和右键菜单。

## 2. 表面与布局

### 2.1 工具窗口

- 右侧栏「源码控制」按钮与 ⌘⇧G 打开 **Git 工具窗口**，它是一个**底部停靠**的工作面板（IDEA 把 Git 停在底部），默认高度 `--git-window-h`（40vh，可拖动，记入偏好），可最大化为整块画布区域；仍受 `WorkPanelSheet` 的「一次只开一个工作面板」规则约束，但方向是 bottom 而不是 right，因为三栏需要宽度。
- 窗口顶部一行：`日志` / `提交` 两个页签，右侧是执行主机徽标、刷新、最大化、关闭。
- 手机（`isCompactLayout`）用焦点页：`日志` 页是「分支列表 → 提交列表 → 详情 → 文件差异」四级；`提交` 页是「变更树 → 文件差异」两级。

### 2.2 日志页三栏

```
┌ 分支树 220px ┬ 工具栏：搜索框  分支▾  用户▾  日期▾  路径(仓库)▾  ⚙ ┬ 详情 360px ┐
│ ▾ armadra   │ ● lanes │ 消息 + ref 徽标        │ 作者    │ 日期  │ hash │ 3f2a1c9 ✓ main   │
│   ▾ 本地    │ │ ●     │ fix(web): …           │ yov…    │ 02:57 │      │ 作者 / 提交者      │
│     ✓ main  │ │ │●    │ feat(sidebar): …      │ …       │       │      │ 完整信息           │
│   ▸ 远端    │ …                                                       │ ▾ 变更文件（树）   │
│   ▸ 标签    │                                                         │   apps/web/… 3    │
│   ▸ Worktree│                                                         │   （点一行看差异） │
│ ▸ codex     │                                                         │                   │
└─────────────┴─────────────────────────────────────────────────────────┴───────────────────┘
```

三栏都可拖动改宽，左右两栏可收起（收起状态记入偏好）。

**分支树**（左）：每个已发现仓库一个根节点（名称 + 当前分支 + ahead/behind 徽标 + 仓库颜色点）；根下固定四组：`本地`、`远端`（按远端名再分一层）、`标签`、`Worktree`；Stash 有条目时出现第五组 `Stash (n)`。分支名按 `/` 分段成子树（`feat/foo`、`feat/bar` 折进 `feat`），当前分支加 ✓ 并加粗，收藏分支置顶（星标）。点击一个分支 = 图只显示它的可达提交；⌘ 点击多选；点仓库根 = 该仓库全部分支；顶部 `HEAD` 节点（所有仓库）= 默认视图。树上有过滤输入框。

**提交图表格**（中）：列为「图 + 消息（含 ref 徽标）」「作者」「日期」「hash」；行高固定 24px，行虚拟化，滚到底自动续页；多仓库时每行左侧 3px 颜色条；HEAD 行有工作树未提交变更时最上面一行显示「未提交的变更」虚线节点（同 vscode-git-graph）。图形车道沿用 `commitGraph()` 的父拓扑算法（车道回收、合并空心点、页外父提交虚线短桩），只是把节点 key 从 `oid` 改成 `repositoryPath + oid`，不同仓库的 DAG 互不相连，天然各占车道。

工具栏：搜索框（文本匹配消息 / hash，`.*` 正则与 `Cc` 大小写两个开关）、`分支`（与树同步）、`用户`（作者列表，含「我的」）、`日期`（今天 / 7 天 / 30 天 / 自定义）、`路径`（仓库多选 + 目录路径，⌘ 点击单选某仓库）、设置菜单（显示所有分支、高亮我的提交、紧凑行、显示 hash 列）。筛选全部在服务端执行（§3.1）。

**详情**（右）：hash（可复制）、作者 / 提交者与时间、ref 徽标、完整提交信息；下方是变更文件树（按目录分组，可切平铺；重命名两端、状态字母、增删行数），点文件在同栏内展开差异（复用现有 diff 视图），双击在编辑器节点里打开该文件的当时版本。合并提交显示「与哪一个父比」的切换。

右键菜单——提交行：检出该版本、在此新建分支 / 标签、cherry-pick、revert、把当前分支重置到这里（soft / mixed / hard）、从这里交互式 rebase、与本地比较、与分支比较、复制 hash / 信息、在画布上引用（生成内容引用）。分支节点：检出、从此新建分支、合并到当前分支、把当前分支 rebase 到此、推送、拉取、重命名、删除、设置上游、与当前分支比较、显示与工作树的差异、收藏。标签 / 远端 / worktree / stash 节点各有对应的增删与应用动作；引用日志是 `HEAD` 节点的右键项「引用日志…」，打开为表格上方的一个可关闭视图。

### 2.3 提交页

- 顶部：`提交到 <当前分支>` 与仓库分组；操作中（merge / rebase / cherry-pick 进行中）时顶部一条横幅：状态、继续 / 跳过 / 中止，冲突文件在变更树里单独一组 `冲突 (n)`（红），双击进三方合并（编辑器已实现）。
- 变更树：按仓库分组（单仓库不显示仓库层），组内 `已暂存` / `变更` / `未跟踪` / `冲突`；每个节点带复选框，勾选即进入本次提交（勾选 = stage，取消 = unstage，行为与索引一致，不再另有「暂存区」概念暴露给用户）；目录节点可整组勾选；平铺 / 树形切换；点文件在右侧看差异，差异里可按 hunk 勾选（现有 hunk 暂存）。
- 底部：提交信息（历史消息下拉、AI 生成按钮沿用 `CommitMessageAssistant`）、`修正上一次提交` 开关、`提交` 与 `提交并推送` 分列按钮（推送走现有 push / lease 动作）。多仓库勾选跨仓库文件时按仓库各提交一次，同一条信息。
- 工具栏：刷新、`Stash…`（对话框：信息、含未跟踪）、`Unstash…`（列表：应用 / 弹出 / 删除 / 查看）、丢弃选中变更（现有确认门）。

## 3. 数据与接口

### 3.1 多仓库日志

> 数据层已实现（2026-09-07）。Runtime `apps/runtime/src/git/repository/log.rs` 与 `tree.rs`、路由 `apps/runtime/src/git/api/workspace.rs`、schema `packages/shared/src/git-repository.ts`、网关 `apps/web/src/git/gateway.ts` 的 `log()` / `refs()`。下面的字段名就是实现的字段名。

新增工作空间级读取 `POST /api/workspaces/{id}/git/log`：

```jsonc
{
  "repositories": ["." , "packages/foo"],   // 省略 = 全部已发现仓库
  "refs": { "kind": "head" | "all" | "named", "names": ["main", "origin/dev"] },
  "authors": ["yovinchen"], "since": "…", "until": "…",
  "paths": ["apps/web"], "text": { "query": "…", "regex": false, "matchCase": false },
  "cursor": null, "limit": 100
}
```

响应 `{ commits: LogCommit[], nextCursor, repositories: [{path, color}], truncated }`，`LogCommit` = 现有 `CommitRecord` + `repositoryPath`（即 `oid`、`parents`、`subject`、`authorName`、`authorEmail`、`authorTime`、`committerTime`、`refs`，再加 `repositoryPath`；提交者姓名不在 `CommitRecord` 里，详情栏需要时走单仓库的 `commit` 读取）。实现：每个仓库一次 `git log --date-order --decorate=full --ignore-missing -z --format=…%cI…%ct…%D…` 加 `--all` / 分支名、`--author`、`--since/--until`、`--grep`（`--fixed-strings` / `--extended-regexp`，`--regexp-ignore-case`）、`-- paths`。

几处实现细节：

- **合并顺序**用 `%ct`（epoch 秒）比较而不是 `%cI` 字符串——同一工作空间的两个仓库可能带不同时区，字符串比较会把 `+08:00` 和 `+00:00` 排错。同戳按仓库在发现列表里的顺序，再按各自原顺序。
- **`refs` 里 `named` 的名字是工作空间级的**：多数仓库没有那个分支。`--ignore-missing` 让「没有」等于「这个仓库不贡献行」，而不是一次失败的读——匹配 Git 自己的报错文本在中文机器上会失效。未出生的 `HEAD` 同理。
- **`color` 恒等于该检出在发现列表（`git_discovery`，同一套跳过规则与上限）里的序号**，缩窄 `repositories` 不改变它。请求里的 `repositories` 必须是发现列表里的路径，否则 404：颜色是那个列表里的位置，列表外的路径没有颜色。
- **游标**是每个仓库各自的 `(anchorOid, offset)` 加筛选条件的 SHA-256。`limit` 不参与哈希（offset 是绝对计数）。条件变了、仓库集合变了、或某个仓库在这套筛选下最新的提交不再是 `anchorOid`（页面在读者脚下移动了），都返回 HTTP 400 `{ "code": "invalid_cursor" }`——这是新增的 `AppError::InvalidCursor`，与普通 `bad_request` 分开，因为客户端的修复是自动的：丢掉游标重读第一页。
- `limit` 1–200，默认 100；仓库数超过 32（或发现本身触顶）时只合并前 32 个并报 `truncated`。
- `paths` 是**仓库相对**的 pathspec，在每个参与合并的仓库里各自生效（与单仓库 `history` 的拼写一致）。

`GET /api/workspaces/{id}/git/refs`：所有仓库的分支树数据，一次返回 `[{repositoryPath, repositoryId, kind, name, head: {oid, branch}, branches: [{name, oid, upstream, ahead, behind, current}], remotes: [{name, branches: [{name, oid}]}], tags: [{name, oid, annotated}], worktrees: [{path, branch, oid, locked}], stashCount}]`，供左栏一次构树；单仓库接口保留给右键动作。实现：每个仓库一次 `for-each-ref`（含 `%(upstream:short)` 与 `%(upstream:track,nobracket)`，不为每个分支起子进程），加 `worktree list --porcelain` 与一次 `rev-list --walk-reflogs --count refs/stash`。

- `head.oid` 在未出生分支上是 `null`，`head.branch` 在游离 HEAD 上是 `null`。
- `upstream` 是短名（`origin/main`），和这份载荷里其余的短名一致；没有上游时 `ahead`/`behind` 是 `null` 而不是 0（「没有可推的」和「没地方推」不是一回事）。
- `tags[].oid` 是标签指向的**提交**（附注标签取 peel 后的对象），因为树节点跳转的是提交。
- 读不出来的检出被略过而不是让整个请求失败：一个坏掉的 vendored clone 不该让分支树整块消失。该读取需要执行权限（要跑 `worktree list` 与 stash 计数），与单仓库的 `worktrees` / `stashes` 一致。

Host 模式：两条读取加进 git 域的 `GitReadMethod`（`LOG = 28`、`REFS = 29`），SSH 远端走 `WorkerServiceOperation`（`GIT_LOG = 54`、`GIT_REFS = 55`，`CONTRACT_VERSION` 升到 3）。两条都是**工作空间级**的，Go Host 的 `workspaceWideRead` 把它们和 `REPOSITORIES` 一起豁免检出作用域检查——工作空间根仍由文件系统域的注册决定，从不取自请求。`git-e2e` 加了用例；写动作全部复用现有 `GitRepositoryAction`，不新增写路径。

### 3.2 前端

- 新目录 `apps/web/src/panels/git/window/`（窗口壳与页签）、`git/log/`（分支树、图表格、详情）、`git/commit/`（变更树、消息区、stash 对话框）；旧的 `History.tsx`、`Branches.tsx`、`Stashes.tsx`、`Tags.tsx`、`Remotes.tsx`、`Reflog.tsx`、`Worktrees.tsx`、`Integrations.tsx` 中的**动作与对话框**抽成可复用模块保留，列表壳删除；`SourceControlDrawer.tsx` 由窗口壳取代。
- 图表格用 `@tanstack/react-virtual`（仓库已有依赖则复用，没有则加）；面板拖宽用现有 `ResizablePanel` 组件（shadcn resizable），没有则加 shadcn `resizable`。
- 状态：`panels.scm` 值增加 `"bottom"`（停靠底部）与 `"maximized"`；日志筛选、分支树展开与收藏、面板宽高进 `preferences-store` 的 `git` 段。
- 文案进 `i18n/git-log.ts`、`git-commit.ts`，`git-repository.ts` 里页签相关的键删掉。

## 4. 不做

- 不做 IDEA 的「折叠线性段」「IntelliSort」——先做筛选与多仓库；记为后续。
- 不做跨仓库的一次提交（跨仓库勾选 = 按仓库各提交一次）。
- 不改 Runtime 的写路径、锁与队列；不改 GitHub 面板。
- 不做画布上的 Git 节点；Git 仍是工作面板。

## 5. 验收

- 三个以上仓库（根 + 嵌套 + worktree）的工作空间：日志页一张图、颜色条正确、`路径` 筛到单仓库、分支树按仓库分组、⌘ 多选分支。
- 筛选（用户 / 日期 / 路径 / 文本 / 正则）都在服务端生效，翻页游标在筛选变化后作废。
- 提交页：勾选即暂存、跨仓库提交按仓库拆分、操作横幅与冲突组、Stash / Unstash。
- Runtime 直连与 Host 模式（`pnpm ownership:e2e --domain git`）都通过；Web 测试覆盖树构造、多仓库车道、游标合并、勾选↔暂存映射；手机 390×844 四级导航可用。
