# Git、Worktree 与 GitHub 工作流设计

> 状态：Git 部分见 §3；§7–§10 的 GitHub 部分（G04）已实施，实现说明见 §11。保留画布工作面，Git/GitHub 使用辅助面板。**§1 的页签式面板与 §4.2 的单仓库历史图已被 [Git 工具窗口](./git-tool-window.md) 取代**；§2、§3、§4.0–§4.1、§4.3、§5–§12 不变。

## 1. 界面组织

Git 界面见 [Git 工具窗口](./git-tool-window.md)：底部停靠的两页签工具窗口（日志 / 提交），仓库不是切换器而是同一张图上的颜色条与分支树里的一组。此处原先描述的九页签 `SourceControlPanel` 与它的 RepoScopePicker 已经拆掉——保留这一段只为说明这两者是同一个界面的两代，服务与数据模型（§2、§3）没有跟着换。

批量状态（`POST /git/repository/status-batch`）与服务端 pathspec 是同一件事的两半，两者都留在新界面里。原先聚合视图每个仓库一次往返，十二个仓库就是十二次；更糟的是那十二个答案被当成一份列表渲染，而它们是十二个不同时刻观察到的。现在一次请求一次观察，读不出来的仓库带着自己的 `{ code, message }` 回来——十二个里坏一个不该让另外十一个变成空白。status、diff 与 log 都接受 pathspec 数组并由 Git 过滤；status 的过滤同时作用于计数与行，两者因此描述同一个集合（分支与 ahead/behind 不受影响，它们是关于检出的事实，不是关于这次筛选的）。pathspec 一律走 `--` 之后，且拒绝绝对路径、`..` 与以 `-` 开头的写法。

`GitHubPanel` 使用 Issues / Pull requests 页签，共用仓库、状态、作者、标签、负责人筛选；详情可以展开为全屏。Issue/PR 与画布节点的关联仅显示小徽标和“定位关联会话”，不将会话转换成任务卡片。

右侧面板位置不足时使用 Sheet，手机使用列表→详情→文件差异三级导航。危险动作和长操作使用现有 Dialog、AlertDialog、Progress、Toast；不为每个 Git 命令创建画布节点。

## 2. 仓库服务与状态模型

Rust Worker 的 RepositoryService 是 Git 命令唯一执行入口。Host 负责操作身份、持久结果及事件。优先调用系统 Git，使用 argv 和结构化解析；不以拼接 Shell 字符串执行用户给的分支、路径或消息。

`RepositoryScope`：executionHostId、workspaceId、repositoryId、worktreeId。`RepositoryState`：headOid、branch/detached、indexFingerprint、worktreeFingerprint、remotes、upstream、ahead/behind、operationState、observedAt、revision。

**仓库发现（已实施）**：`GET /api/workspaces/{id}/git/repositories` 从工作空间根递归扫描，深度上限可配置（默认 4），只跳过 `node_modules`、`target`、`dist`、`.git` 内部与 `.armadra`。**gitignore 不作为跳过依据**：被忽略的目录常常正是独立检出所在。每个 `.git` 目录或 `.git` 文件解析为 `GitRepository { repositoryId, repositoryPath, name, kind: root | nested | submodule | worktree, parentRepositoryId, headBranch, dirtyCount }`。

扫描本身只读文件系统，不为每个候选起子进程；`dirtyCount` 是唯一需要跑 `status` 的字段，因此没有执行授权时它是 `null`——「未统计」和「干净」是两件事，界面分开显示。`repositoryId` 沿用既有推导（规范 common dir 的 SHA-256），所以与各快照上的 `repositoryId` 对得上；链接 worktree 与主检出天然共用一个 id（本来就是同一个仓库），**`repositoryPath` 才是检出的身份**。结果按工作空间缓存，`file.changed` 命中 `.git` 时失效。

既有请求（status、diff、stage、unstage、revert、resolve、head-commit、commit 与全部 `/git/repository/*`）都接受 `path`，缺省是工作空间根，所以单仓库工作空间行为不变。

Git 仓库/索引/文件系统是代码状态真相，Host 里的状态是缓存。使用文件监听加节流复核，执行前重新读取。外部 CLI 修改同一仓库时可观察，但内部队列不能锁住外部 Git；版本检查发现变化后冲突返回，不盲目覆盖。

读取可并发；每个 worktree 的索引/工作树写操作串行。改 refs、worktree 管理和网络 ref 更新按 common git dir 加仓库级锁，锁排序固定，避免多 worktree 死锁。已有 Git lock 文件只报忙，不自行删除。

## 3. 完整 Git 功能范围

| 功能                        | UI / 预览                                       | 实现与失败行为                                            |
| --------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Init/Clone                  | 新建仓库/克隆窗口、目标目录、进度、取消         | 无仓库状态可初始化；克隆取消仅清本次生成的临时目录        |
| 状态                        | Staged / Changes / Untracked / Conflicts 分组   | 保留重命名两端、二进制、子模块状态；未跟踪目录可展开      |
| 文件/批量暂存               | 行内 +、选中项、全部                            | 显示作用路径；不把忽略文件自动纳入                        |
| Hunk/行暂存                 | Diff 内选择片段并预览 patch                     | 基于 index/blob 指纹，patch stale 时重新加载，不误应用    |
| 取消暂存                    | 行内 −、片段、全部                              | unborn HEAD 有独立处理；保留工作树内容                    |
| 还原未暂存                  | 选择文件/hunk，展示将丢失内容                   | 明确从 index 还原；与从 HEAD 覆盖两区分开                 |
| 未跟踪文件删除              | 删除列表、大小、可恢复路径                      | 优先暂存到回收位置；永久删除单独确认                      |
| Diff                        | staged/unstaged、commit↔commit、branch↔branch | 支持统一/并排、空白选项、搜索；二进制和大文件用摘要       |
| 提交                        | 消息编辑器、预览文件数、签名状态                | 只提交 index；hooks 失败保留日志和消息草稿                |
| Amend                       | 显示原提交与将变更内容                          | 明确改写历史；不默认启用、不隐含 force push               |
| 分支创建/切换/重命名/删除   | BranchPicker、远端分支、最近分支                | 检查 ref 名、被 worktree 占用、脏文件冲突                 |
| 从某提交创建分支            | History 行动作                                  | 固定起始 OID，预览目标与是否同时切换                      |
| Detached checkout           | 警示当前游离状态                                | 可创建新分支保存后续提交                                  |
| Fetch                       | 选择远端、可选 prune、进度                      | 只刷新 refs；失败不改变工作树                             |
| Pull                        | 明确 upstream 与 ff-only/merge/rebase           | 默认 ff-only；分叉时用户选择策略                          |
| Push / Publish branch       | 展示远端、分支及待推提交                        | 无 upstream 可设置；认证失败可重试但重新核对 refs         |
| Sync                        | fetch → 计算差异 → 选定 pull 策略 → push        | UI 显示步骤；任一步失败停止，不是盲目 pull+push           |
| 强制推送                    | 高级操作，展示被覆盖的远端 OID                  | 使用明确 expected OID 的 force-with-lease；远端变化则拒绝 |
| Merge                       | 分支选择、差异预览、结果状态                    | 冲突进入 ConflictCenter；支持继续/中止                    |
| Rebase                      | 起点、目标、提交列表                            | continue/skip/abort；交互式步骤作为可审核 todo 编辑器     |
| Cherry-pick / Revert commit | 选择提交、方向、预览                            | 序列状态持久；冲突可继续/中止；merge commit 要求主线选择  |
| Reset                       | soft/mixed/hard 明确区分影响范围                | hard 展示文件损失；不得由普通“撤销”触发                   |
| Stash                       | include-untracked 可选、命名、列表、diff        | apply 与 drop 分离；pop 冲突不假定 stash 已删除           |
| Tag / Remote                | 标签创建/删除/推送，远端增删改                  | 展示本地/远端范围；带凭据 URL 脱敏                        |
| Reflog                      | 高级历史入口（已实施，见 §4.0）                 | 找回 OID 后创建分支；恢复动作仍有 ref 前置检查            |

`feature/...` 是分支名称建议，不是独立 Git 操作；默认按用途建议 `feature/…`、`fix/…`、`refactor/…`，用户可编辑。遵守项目分支/工作树命名规则，禁止使用项目明确禁止的前缀。

进阶能力是本设计的完整交付范围，不能只为它们放禁用按钮后标记完成；M4 可按基础、历史、进阶三个子里程碑交付。

Rebase、Sync 与强制推送已在 Runtime `RepositoryService` 与 `apps/web/src/panels/git/` 实现：

- `StartRebase{onto, expectedStateToken}` 把当前分支重放到已核对的提交上。重放期间 HEAD 游离，所有权因此绑定 Git 自己的 `rebase-merge` 记录（`onto`、`orig-head`、`head-name`）与 `orig-head` 的文件身份，而不是不动的 HEAD。冲突复用现有 Continue/Abort：continue 要求冲突已解决并暂存，且允许在下一个被重放的提交上再次停下；abort 恢复记录的分支与 OID。外部或 Runtime 重启后的序列仍可读、不可驱动。`skip` 仍只属于空 cherry-pick，不用来丢弃整个被重放的提交。
- `Sync{remote, branch, expectedRemoteOid}` 在同一个 owned 操作里依次执行 fetch、仅快进 pull、push。任一步失败即停止，并报告停在哪一步、当前 HEAD 与远端 OID；分叉分支不会被自动 merge 或 rebase。
- 强制推送只有 `Push.forceWithLease{expectedRemoteOid}` 一条路径，映射到 `--force-with-lease=refs/heads/<branch>:<oid>`；`--no-force` 在所有推送上保留，所以不存在不带租约的强制推送，界面另外要求对被覆盖的远端 OID 做二次确认。

Git push 的 lease 使用具体预期 ref 值，避免后台 fetch 改变远端跟踪分支后削弱保护。依据 [Git push 官方文档](https://git-scm.com/docs/git-push)。

M4 补齐的其余部分同样落在 Runtime `RepositoryService` 与 `apps/web/src/panels/git/`：

- `git init` 只对不属于任何仓库的工作区开放，界面先确认再执行；已在仓库内（含祖先仓库、裸仓库）一律拒绝，不嵌套第二个仓库。这是唯一没有 common git dir 队列可排的写路径，因为队列键要等仓库存在才有。
- amend 需要带上界面展示过的 HEAD OID，HEAD 变过即拒绝；提交已存在于远端跟踪引用时还要再勾一次确认。amend 不推送，也不强推。
- 还原分为两个动作：`source=index` 用 `git checkout --` 只丢暂存之后的改动，`source=head` 用 `git restore --source=HEAD --staged --worktree` 连暂存一起丢；未跟踪文件只有删除一种含义。首次提交前拒绝从 HEAD 还原。
- 冲突文件有显式「标记已解决」：服务重读文件，仍含冲突标记时拒绝并给出行号，通过后才 `git add` 该路径。
- Diff 增加并排视图、`--ignore-all-space` 与 diff 内搜索。忽略空白只影响补丁与行数统计，文件列表照旧列出仅空白变化的文件（标注「仅空白差异」），并排视图纯排版、不重算差异。
- 历史行操作：复制 OID、游离检出、从该提交建分支、cherry-pick、`Revert{targetOid, mainline, expectedStateToken}`、`Reset{mode, targetOid, expectedStateToken, discardChanges}`。revert 与 cherry-pick 共用同一套 owned 序列与 Continue/Abort，没有 skip；hard reset 在工作区不干净时必须显式确认，并先用 stash 后端记录一份含未跟踪文件的快照作为可恢复点。
- 标签与远端各有独立页签。标签的删除与推送按标签对象本身 CAS，创建不提供 force，推送保留 `--no-force`；远端 URL 走与克隆相同的白名单，其中的凭据在离开 Runtime 前脱敏，界面也不会把脱敏值回填后送回。
- 交互式 rebase 提供可审阅的 todo：预览将被重放的提交（最旧在前），支持重排与 `pick`、`reword`、`edit`、`squash`、`fixup`、`drop`，随后用写入仓库 Git 目录的临时文件加 `GIT_SEQUENCE_EDITOR=cp -- '<path>'` 非交互执行。提交的 todo 必须覆盖区间内全部提交，丢弃只能显式写 drop。`reword` 的新信息在提交 todo 时就定下来——运行期没有编辑器可开，这也正是它在列表里可审阅的原因；它写成 `pick` 加一条本服务自己生成的 `exec git commit --amend --file '<路径>'`，信息走文件而不是命令行参数，非 `reword` 的条目带信息是拒绝而不是忽略。`edit` 停下后由 Continue 继续；`squash` 与 `fixup` 都要求前面还有一个保留的提交。`exec` 仍不开放给调用方：它唯一的含义就是「跑一条别人给的命令」。含合并提交的区间不走 todo 编辑器。
- 暂停中的 rebase 可以 `skip`：丢弃当前停下的那个被重放的提交，其余照常继续，随后与 continue 走同一套完成校验（回到原分支、确认过的目标提交可达）。它不要求先解决冲突——在一个已决定丢弃的改动上先做完工作是没有意义的——但界面在按钮旁写明这是丢弃，并且和其他写一样过确认门。cherry-pick 的 skip 仍只对空提交开放，revert 仍只有 continue/abort。

## 4. Diff、历史图与冲突中心

### 4.0 Reflog（已实施）

`GET /git/repository/reflog` 按引用分页返回条目（`index`、`selector`、`oid`、`previousOid`、`action`、`message`、`committerName`、`loggedAt`），面板作为 History 之外的独立页签。

三件事决定了它的形状：

- **分页按位置数，不按锚点。** reflog 是往前面插的，没有一个不动的锚可以钉住窗口；游标只带偏移与引用，换引用即失效。每条自带 `loggedAt`，所以窗口滑动过是看得出来的。
- **`selector` 是给人看的，`oid` 是用来动的。** `HEAD@{3}` 会随新条目往前挤而指向别的提交，而且多条可以共用一个 OID（一次没移动的 checkout 也会记）。所以恢复动作——游离检出、从这里建分支、reset——一律用该行自己的 OID，并复用历史页那套确认门与 `expectedStateToken`。
- **对象 ID 没有 reflog。** 传一个 OID 当引用是拒绝，不是空页：空页会被读成「这里什么都没发生过」。

`loggedAt` 取自 `--date=iso-strict` 下的 `%gD`——那是唯一暴露条目自身时间的位置——索引取行在页内的位置，因为 `git log -g` 就是从 0 开始按序列出的。

### 4.1 Diff

Diff 模型包含 old/new path、blob OID、mode、status、binary、hunks、行号映射和截断状态。用原始路径字节的安全编码保留特殊文件名，UI 显示转义路径；不按换行切分 Git 的 NUL 分隔状态。

大文件默认先返回元数据，文本 diff 按块加载；图片提供缩放/并排，二进制显示大小和 hash。子模块显示记录的 commit 指针及脏状态，不递归修改。

暂存/还原 hunk 以对应 index/blob 版本为前置条件；先验证 patch，再执行并刷新状态。前端传选定 patch 的结构与指纹，后端重新确定目标，不接受任意 repo 外路径。

### 4.2 提交历史图

历史图见 [Git 工具窗口](./git-tool-window.md) §2.2 与 §3.1：它是**工作空间级**的一张图（`POST …/git/log` 把每个检出各自排好序的提交按 `%ct` 交错合并），筛选全部在服务端执行，游标绑定筛选条件。此处原先描述的单仓库 `GitHistoryPanel`（一个仓库、一个起点、客户端二次过滤）已经拆掉。

没有跟着换的是图本身：车道分配仍然只看 parent 拓扑，第一父提交沿用同一车道所以主线是笔直一列，其余父提交各占一条新车道并在合并处**回收**旧车道；合并提交画空心点；父提交不在本页时画虚线残桩，不猜位置。多仓库下节点的身份从 `oid` 换成 `仓库路径 + oid`，不同检出的 DAG 因此互不相连。

选中行的详情也没有换：哈希、父提交、作者、日期，以及 `GET /git/repository/commit` 返回的文件列表（状态、增删行数，二进制报 `null` 而不是 0）；点击文件用 `GET /git/repository/commit-file` 取该文件的 patch。「比较到当前」把比较基准从第一父提交换成当前 HEAD，两侧都由服务端解析成 OID 后再比较。文件列表与 patch 是两次请求：一个提交可能改动上千文件，而单个文件可能有若干 MB，合成一次读取会让「选中一行」变成无界操作。

### 4.3 冲突中心

显示当前 merge/rebase/cherry-pick/revert 状态、冲突文件列表、base/ours/theirs/result 四份内容。保存结果不自动标记解决，用户执行“标记已解决”后暂存；继续前确认未解决项为零。提供继续、跳过（适用时）与中止；中止失败保留状态，不显示已恢复。

Git 操作日志可复制，经脱敏后保存至 operation；凭据提示或编辑器交互通过明确的 askpass/消息流程，不能让后台操作无限等待不可见提示。

## 5. Worktree 与 Frame 绑定

### 5.1 数据与 UI

`WorktreeRecord`：repositoryId、worktreeId、path、branch、headOid、locked、prunable、isMain、status、setupState。

**已实施（G03）**：`FrameBinding { worktreePath, branch, repositoryId, initScript, initScriptState, initScriptNodeId }` 落在 group 节点的 `data.binding` 上，随节点文档一起往返持久化。绑定是**对已存在检出的一条记录**，不是检出本身。Frame 头部的 `WorktreeBindingBadge` 显示分支、路径、脏文件数与初始化脚本状态，脏文件数复用同一份仓库发现结果；检出不在发现结果里时显示 repair 提示，提供重新创建与解绑。

路径继承分两种：终端 `cwd` 用绝对路径（Runtime 直接把它交给子进程，相对路径会相对 Runtime 自己的工作目录解析），编辑器 / 文件树的 `path` 与 Diff 的 `repoPath` 用工作空间相对路径，与 `defaultNodeData` 一致。初始化脚本只跑一次：只有 `pending` 状态会触发，且在写入终端之前先把状态持久化为 `running`。

Frame 头部显示分支、路径和脏状态；点击打开 Worktrees 页。创建向导选择新/现有分支、base ref、目录、是否创建 Frame、是否执行初始化脚本。worktree 目录名由用途生成，不能用固定工具名。

### 5.2 创建和继承

1. 读取 `worktree list` 的机器可读结果，校验目录和分支占用；不用强制选项绕过已有 checkout。
2. 创建操作记录，执行 git worktree add，持久化结果，再创建/绑定 Frame。
3. 创建成功但 UI 写入失败时重查 worktree 并补绑定，不能重复创建或未经确认删除。
4. Frame 内新终端、Agent、编辑器、Diff、文件树默认使用 worktree 路径；节点显式覆盖时显示来源。
5. 移动已有运行节点进另一 Frame 只改画布分组，不改变运行进程 cwd。提供“在此 worktree 新建/重启”明确动作。
6. 初始化脚本视为项目代码执行，首次确认确切内容与目录；日志可查看。依赖它的 Agent 等待 setup 成功，失败不自动放行。

### 5.3 删除与异常

解绑只清 FrameBinding，保留 worktree、分支和文件。删除 worktree 前检查脏文件、未推提交、活跃 Session、编辑器草稿及计划引用；用户处理后执行。主 worktree 不提供删除，locked worktree 先显示锁原因。远程执行同一套 Worker API。

删除后的分支独立处理，不隐式删除。外部 Git 已增删 worktree 时重新对账，显示 orphan/prunable；prune 仅清理过期管理记录，不把它当删除目录。依据 [Git worktree 官方文档](https://git-scm.com/docs/git-worktree)。

## 6. AI 提交信息

调用 SuggestionService，输入 staged diff、文件摘要、最近提交风格和用户约定；带 `headOid + indexFingerprint`。超预算时按文件摘要和关键 hunk 裁剪，显示未包含清单，不能用工作树未暂存内容冒充待提交内容。

输出 subject/body 两段，支持中文/英文、Conventional Commits 选项与重新生成。预览后用户可编辑；使用后台独立 CLI，不抢占画布终端。

生成期间 index 改变，候选标记过期。提交前重新核对指纹，要求用户确认使用旧草稿或重新生成；AI 不自动执行 stage/commit/push。超时保留用户原草稿并显示可操作错误。

## 7. GitHub Issues 与状态映射

### 7.1 列表与详情

Issues 页提供 open/closed/all、标签、负责人、里程碑、作者、搜索和更新时间。详情含正文、评论、活动、关联 PR/分支/会话；支持创建、编辑、评论、分配、标签、里程碑、关闭和重新打开。

Issue 的“重开”使用 GitHub issue state；平台运行的“重试”在关联 Session/Automation 的运行详情中，不向 GitHub 发不存在的 restart 动作。

查询 Issues 时明确过滤 PR 类型记录；分页、权限不足、限流和缓存时效可见。缓存显示真实的远端状态及 observedAt。

### 7.2 映射配置

每个仓库只能选择一个主要状态来源：

1. `ProjectFieldMapping`：GitHub Projects v2 的 Status 字段及 option ID 映射到面板状态分组。
2. `LabelMapping`：准确标签名 → 状态分组；配置冲突与多个命中时显示 unmapped/conflict。

状态组仅用于 GitHub 条目，不存在本地会话卡片。状态移动通过菜单/选择器，首版不做任务拖动排序。关闭 Issue 与移动到 Done 分组是两项动作，只有显式配置联动规则才一起执行。

Projects v2 条目与 Issue 是不同对象：先确保 item 存在，再更新字段；labels/assignees 等改 Issue/PR 本身。依据 [GitHub Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)。

### 7.3 同步语义

读取使用条件请求、分页及退避；支持 webhook 的部署可增量刷新，普通本机 Host 用轮询。Webhook 验证签名并以 delivery ID 去重，参考 [GitHub webhook 验证](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。

变更请求保存 actionId、远端对象 ID、旧状态、目标状态与客户端预期更新时间。GitHub 不提供对应原子版本锁时，采用执行前重读、执行后核验；文档不宣称拥有强 CAS。失败显示 pending/failed/conflicted，不把 optimistic UI 永久当结果。

标签移动只移除当前映射管理的标签，保留其他标签。远端自动化再次改动时接受最新远端事实，显示原因，不反复强写造成回环。Projects 字段和 Issue 状态的组合写入部分失败时逐项显示，允许继续或手动修复。

GitHub Issue 状态和编辑能力依据 [Issues REST API](https://docs.github.com/en/rest/issues/issues)，实施时固定 API 版本并做错误兼容。

## 8. Pull request 管理

| 功能     | 设计                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 列表     | open/closed/merged/draft、作者、review requested、检查状态                              |
| 创建     | base/head、标题、正文、关联 Issue、Draft；先检查 head 是否已推送                        |
| 查看     | 提交、文件差异、讨论、评审、检查、冲突/可合并状态                                       |
| 编辑     | 标题正文、标签、负责人、评审者、Draft/Ready、关闭/重开                                  |
| 本地检出 | 新建 worktree 或选择已有 worktree；fork PR 不覆盖用户现有分支                           |
| 评审     | 普通评论、行内评论、Approve/Request changes，发送前预览                                 |
| 检查     | 列出 CI 结果及日志链接；有权限时提供适用 workflow run 的重跑，不假设所有 check 都能重启 |
| 合并     | merge/squash/rebase 按仓库允许策略；使用预期 head SHA，重读检查/保护结果                |
| 清理     | 合并后删除源分支/关闭关联 worktree为独立操作；默认保留运行会话                          |

合并前显示仓库、PR、base、head、预期 SHA、策略和提交信息。请求期间 head 改变则停止并刷新；远端保护策略及 merge queue 等能力按实际返回处理，不能因为本地显示绿色就保证可合并。

行内评论记录 commit OID、路径、左右侧及行号；Diff 更新后过期草稿重新定位或转普通评论，不静默贴错行。所有评论、评审、创建和合并均由用户明确操作或已授予该具体自动化的授权触发。

PR 创建、编辑及合并语义依据 [GitHub Pull requests REST API](https://docs.github.com/en/rest/pulls/pulls)。

## 9. 认证与组件边界

Git 的 SSH key/credential helper 由 Worker 执行主机使用；GitHub API 凭据由 Host 凭据服务引用，两者分开。首版支持显式接入现有 `gh` 登录或 token 引用，长期预留 GitHub App/OAuth。GitHub Enterprise 用可配置 API base 与独立认证；远端 URL 检测不得把企业仓库错误发到公共服务。

外部内容（Issue 正文、PR 评论、diff）作为资料进入 AI 上下文，不授予额外执行能力。令牌不写进项目 `.armadra`、日志或共享 Protobuf 数据。

组件建议：`RepositoryScopePicker`、`GitChangesList`、`DiffViewer`、`CommitComposer`、`BranchPicker`、`GitHistoryPanel`、`ConflictCenter`、`WorktreeManager`、`GitHubIssueList`、`IssueDetail`、`StatusMappingEditor`、`PullRequestDetail`、`ReviewComposer`。

## 10. API、操作恢复与测试

每个写操作携带 repo scope、requestId、expected head/index/ref；返回 operationId 与 affected resources。事件为 RepositoryChanged、OperationProgress、ConflictDetected、WorktreeChanged、IssueChanged、PullRequestChanged。客户端收到事件后局部刷新，不全量重载画布。

Host 重启后的 Git 操作按实际 Git 状态对账：commit 查 OID/index，push 查远端 ref，merge/rebase 查进行中状态；取消只能结束子进程并复核结果，不能保证远端没有接受 push。未知结果显示待确认，不能自动再次 commit。

必测仓库：未提交过的仓库、detached HEAD、shallow clone、子模块、二进制/大文件、空格/换行/中文文件名、重命名、冲突、签名失败、Git hooks 失败、不同 OS、SSH 仓库、并发外部 Git、worktree 锁定。

必测 GitHub 场景：无权限/令牌过期/限流、Issue 与 PR 混合返回、Projects 字段删除、标签冲突、外部状态变化、webhook 重复/伪签名、合并前 SHA 改变、私有 fork、评论位置过期、组合写入部分失败。

端到端门槛：克隆 → 建 worktree/分支 → 编辑 → hunk 暂存 → AI 草拟 → 提交 → push → 创建 PR → 查看检查/评审 → 合并 → 独立清理，全程不需要离开应用手动补齐缺失的产品入口。

## 11. G04 实现说明

§7–§10 由 Go Host 实现，前端经 `packages/host-client` 的 `HostGithubClient` 调用；契约在 `proto/armadra/v1/github.proto`（消息与枚举名拼作 `Github`，仅因 prost 与 protobuf-es 只在名称大小写匹配时才裁剪枚举前缀）。

- **凭据**（§9）：`apps/host/internal/githubcred`。两种来源都要用户显式开启——复用本机 `gh` 登录只按需读取、不落库；粘贴的 token 写入 macOS Keychain，其他平台降级为 0600 文件并在状态里如实标注。写钥匙串走工具的交互提示（stdin），不走 `-w` 参数，否则 token 会出现在进程参数里；写完再读回校验。配置先验证再存储，被拒绝的 token 不留痕迹。内存副本最多存活一分钟，撤销即清空。Token 不进数据库、日志与任何返回的 Protobuf 消息。
- **API base 与远端归属**：`githubapi.NormalizeAPIBase` 只接受 HTTPS；`BelongsTo` 在本地判定远端 URL 属于哪个服务，企业仓库不会被发到公共服务，反之亦然。`GITHUB_API_BASE` 只提供首次配置的默认值，`GITHUB_CA_FILE` 供内部 CA 签发的 Enterprise 使用。
- **传输**（§7.3）：`githubapi` 统一处理 ETag 条件请求、Link 分页（只取页码，响应无法引导下一次请求）、限速头与退避。写操作永不重试：结果未读即报 `UNKNOWN_OUTCOME`，由调用方重新读取。重定向一律拒绝。
- **状态映射**（§7.2）：`githubhost.ValidateMapping` 校验单一来源、组 ID/标签/选项唯一，并在两个方向的联动构成环时拒绝（组指向自身是不动点，允许）。同一 Issue 命中多个组显示 conflict，不擅自挑一个。`MoveIssue` 逐项返回 `GithubWriteOutcome`，标签移动只动映射管理的标签，关闭 Issue 只在显式配置联动时发生。
- **PR 合并**（§8）：`MergePull` 重读 PR 与检查，`expected_head_sha` 或 `expected_check_rollup` 不符即停；仅提供仓库允许的合并策略；结果未读时重读而非重试。
- **行内评审**（§8「评审」）：`GithubPullFile.patch` 带回远端给的 unified diff（每文件上限 64 KiB，超过就整份丢掉而不是截断——评论锚点是 hunk 头算出来的行号，截断之后的行号会把意见贴到没人读过的行上）。面板据此逐行给评论入口，草稿随同一次 `SubmitReview` 提交，因此在远端是一份评审而不是一堆散评论；远端标了 `outdated` 的历史行内评论不画在当前 diff 上，另起一段并写明位置已经对不上。
- **检查重跑**（§8「检查」）：`RerunChecks` 只对 `rerunnable` 且没通过的 workflow run 发 `/actions/runs/{id}/rerun[-failed-jobs]`，逐个返回 `GithubWriteOutcome`；发之前重读 PR，head 变了就是 `HEAD_MOVED` 且一条不发；一条都不能重跑时是 `NOT_RERUNNABLE` 而不是静默无事发生。结果未读的那次停在 `PENDING`，永不自动再发——重发一次已经排上的流水线就是第二条流水线。
- **合并后清理**（§8「清理」）：`DeleteBranch` 只删远端分支，必须带上面板显示的 `expected_sha` 并由 Host 重读比对，分支前进过就是 `REF_MOVED`；已经不在是 `NOT_FOUND` 而不是「删掉了」。本地检出的移除是另一个动作，走仓库面板那条安全移除，成功之后才清 `FrameBinding`（解绑只清画布上的绑定，不动磁盘），运行中的会话一概不碰。fork 的 head 分支不提供删除。
- **刷新**：本机 Host 无 webhook，Host 在每个列表/详情响应里给出 `poll_interval_ms`，由客户端按这个节奏轮询。
- **`ExternalReference`**：迁移 v4 的 `github_references`，ID 由链接语义派生，因此重复关联是同一条记录而不是两个徽标。

已知限制：Issue 全文过滤与 PR 的作者 / draft / review-requested 过滤在 Host 本地完成（search API 属另一套配额）；Projects v2 状态字段每个项目最多读 500 个条目，超出的 Issue 显示未映射；token scopes 只保留上次验证的结果，重启后为空。

## 12. B5 实现说明（写入所有权）

§2 的「Rust Worker 的 RepositoryService 是 Git 命令唯一执行入口。Host 负责操作身份、持久结果及事件」已由
[业务所有权迁移](./host-business-migration.md) 的 B5 批落地，契约在 `proto/armadra/v1/git.proto`。

- **队列在 Host，命令在执行主机**：`apps/host/internal/githost` 记操作身份、排序、前置版本与结论；
  `apps/runtime/src/worker/git.rs` 走的是 HTTP 路由用的同一批代码，所以经 Host 下的提交与经 Runtime 下的
  提交是同一个提交、同一套校验。
- **锁序**（§2「锁排序固定」）：改 refs、worktree 管理与网络操作先取 common git dir 的锁，再取 worktree 的锁；
  只动索引与工作树的操作只取后者。方向只有一个，所以共用 common dir 的多个检出不会死锁。
- **前置版本**：写入携带界面读到的 HEAD / 索引 / ref，执行前由执行主机重读比对；外部命令改过就是拒绝，不是覆盖。
- **结果未知**：被打断的操作停在 `UNKNOWN_OUTCOME`，不自动重跑也不折叠成失败——重跑一次已经送达的推送会让远端
  ref 前进两次。Host 重启后的对账按种类判定：网络类一律未知，提交读 HEAD 判定，其余未知。
- **读不入库**：除 `RepositoryState` 这一份带 `observedAt` 的快照外，转发的读一律不缓存，状态码原样带回。

- **两种 Worker，按活多久分**：写与读各起一个短命 Worker——队列在起进程之前就已经建立了排他，所以每操作一个进程不增加竞态，
  换来的是隔离：一次卡死的 rebase、一个挂在提示上的凭据助手，倒掉的是跑那一个操作的进程。**克隆例外**：它的 `git` 子进程比启动它的帧活得久，
  作业在 Worker 自己的注册表里，进程一结束作业就没了——所以 clone 的三个方法走一个**常驻** Worker。每个 Worker 有**自己**的状态目录：
  状态目录是一个 Worker 私有的日志与 outbox，两个进程开同一个就是一次争用的 SQLite，会直接让一帧失败
  （`TestRealRustWorkersRunConcurrentlyWithPrivateStateDirectories`）。
- **进度走上行帧**（§10 进度）：`git --progress` 写到 stderr 的百分比进到操作自己的快照（Runtime 直连模式的面板也读得到），
  变化时经 `WorkerGitUpcall` 上报，Host 按三条规则应用——已落定的条目不再打开、百分比不倒退、**结论从不取自上报**
  （`RunGitOperation` 的响应才是结论）。克隆是唯一的例外，因为它没有一个用来落定的响应帧：终态确实来自上报，
  而 `GetClone` 仍会重读作业，所以丢一帧的代价是慢一拍而不是错一次。
- **本地镜像可克隆**：Worker 通道接受工作空间根内的本地目录作为克隆源，HTTP 路由不接受。差别在于注册过的根：
  HTTP 路由克隆到调用方指定的父目录，那里的本地源就是「任意路径复制到任意路径」；这里两端都在某个人注册过的根内。
- **落在根外的检出按名拒绝**：`ErrOutsideRoot` 与一般的权限失败分开，因为它指出的是可修的那件事——一条漂到项目外的 Frame 绑定
  不是「设备没有授权」。Host 的判定是两条已规范化绝对路径之间的文本包含（macOS 的 `/private` 前缀先抹平，那是同一个目录的两种拼法），
  能解符号链接的是执行主机，它做同样的判定。
- **Frame 绑定有判定**：`GIT_READ_METHOD_WORKTREE_BINDING` 回的是带理由的裁决（`ok` / `pathMissing` / `notAWorktree` /
  `repositoryMismatch` / `branchChanged`），因为修法不同：目录没了可以重建，分支被切走了不能——那个检出还在，重建只会失败。

已知限制：一次操作的帧上限仍是一分钟，超时报 `UNKNOWN_OUTCOME`；进度上报只让这道坎在逼近时可见，并不移动它——那要靠常驻的 git Worker。
