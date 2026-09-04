# Git、Worktree 与 GitHub 工作流设计

> 状态：目标设计，待实施。保留画布工作面，Git/GitHub 使用辅助面板。

## 1. 界面组织

`SourceControlPanel` 使用 Changes / Branches / History / Worktrees 页签。顶部固定 RepoScopePicker：项目、执行主机、worktree、当前分支及 ahead/behind；所有操作旁都能识别目标仓库。

`GitHubPanel` 使用 Issues / Pull requests 页签，共用仓库、状态、作者、标签、负责人筛选；详情可以展开为全屏。Issue/PR 与画布节点的关联仅显示小徽标和“定位关联会话”，不将会话转换成任务卡片。

右侧面板位置不足时使用 Sheet，手机使用列表→详情→文件差异三级导航。危险动作和长操作使用现有 Dialog、AlertDialog、Progress、Toast；不为每个 Git 命令创建画布节点。

## 2. 仓库服务与状态模型

Rust Worker 的 RepositoryService 是 Git 命令唯一执行入口。Host 负责操作身份、持久结果及事件。优先调用系统 Git，使用 argv 和结构化解析；不以拼接 Shell 字符串执行用户给的分支、路径或消息。

`RepositoryScope`：executionHostId、workspaceId、repositoryId、worktreeId。`RepositoryState`：headOid、branch/detached、indexFingerprint、worktreeFingerprint、remotes、upstream、ahead/behind、operationState、observedAt、revision。

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
| Reflog                      | 高级历史入口                                    | 找回 OID 后创建分支；恢复动作仍有 ref 前置检查            |

`feature/...` 是分支名称建议，不是独立 Git 操作；默认按用途建议 `feature/…`、`fix/…`、`refactor/…`，用户可编辑。遵守项目分支/工作树命名规则，禁止使用项目明确禁止的前缀。

进阶能力是本设计的完整交付范围，不能只为它们放禁用按钮后标记完成；M4 可按基础、历史、进阶三个子里程碑交付。

Git push 的 lease 使用具体预期 ref 值，避免后台 fetch 改变远端跟踪分支后削弱保护。依据 [Git push 官方文档](https://git-scm.com/docs/git-push)。

## 4. Diff、历史图与冲突中心

### 4.1 Diff

Diff 模型包含 old/new path、blob OID、mode、status、binary、hunks、行号映射和截断状态。用原始路径字节的安全编码保留特殊文件名，UI 显示转义路径；不按换行切分 Git 的 NUL 分隔状态。

大文件默认先返回元数据，文本 diff 按块加载；图片提供缩放/并排，二进制显示大小和 hash。子模块显示记录的 commit 指针及脏状态，不递归修改。

暂存/还原 hunk 以对应 index/blob 版本为前置条件；先验证 patch，再执行并刷新状态。前端传选定 patch 的结构与指纹，后端重新确定目标，不接受任意 repo 外路径。

### 4.2 提交历史图

`GitHistoryPanel` 包括提交图、提交列表、详情与文件差异。数据为 OID、parents、subject、author、committer、time、refs、签名结果；图布局用 parent 拓扑与稳定 lane 分配，不用提交日期代替拓扑关系。

分页固定查询锚点和过滤器，保留跨页父边的延续信息，避免滚动时线条换列。支持当前分支/所有分支、作者、日期、路径和文字过滤；shallow clone 缺失历史标记边界；合并提交默认展示与第一父的差异，可切其他父。

行操作：查看 diff、复制 OID、检出、创建分支/标签、cherry-pick、revert、reset；操作详情明确区分 commit 作者和当前操作者。

### 4.3 冲突中心

显示当前 merge/rebase/cherry-pick/revert 状态、冲突文件列表、base/ours/theirs/result 四份内容。保存结果不自动标记解决，用户执行“标记已解决”后暂存；继续前确认未解决项为零。提供继续、跳过（适用时）与中止；中止失败保留状态，不显示已恢复。

Git 操作日志可复制，经脱敏后保存至 operation；凭据提示或编辑器交互通过明确的 askpass/消息流程，不能让后台操作无限等待不可见提示。

## 5. Worktree 与 Frame 绑定

### 5.1 数据与 UI

`WorktreeRecord`：repositoryId、worktreeId、path、branch、headOid、locked、prunable、isMain、status、setupState。`FrameBinding`：frameNodeId、worktreeId、defaultLaunchSettings。

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
