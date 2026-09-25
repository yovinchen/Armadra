# 文件编辑器与受控浏览器设计

> 状态：目标设计。§2 的搜索替换、快速打开、项目搜索、文件信息、Markdown 预览、文件管理与 §3 的外部变更检测已实施（E01/M4），语言服务只有能力探测；§5–§9 的受控浏览器首轮已实施（B01/M5，macOS 实机验收），未做项逐条列在各节末尾。面向桌面、浏览器客户端与移动端的同一执行服务。
> 2026-09-19：桌面壳已换成 Electron，本文提到 Tauri 的部分是换壳之前写下的，只作为当时的方案记录；壳的现状见 [Electron 迁移](./electron-migration.md) 与 [架构](../guides/architecture.md)。

## 1. 交互位置与通用模型

画布保留 Editor、Files、Diff、Browser 节点。节点展开后可进入焦点模式，文件树/搜索结果及 Git 面板可打开关联节点；同一路径默认复用已有编辑器，用户可主动新建第二个视图。

文件和浏览器目标始终绑定 executionHostId。远程项目中的网页 `localhost` 指向浏览器所在执行主机，文件路径指向执行主机上的工作区根目录；节点头部用简短主机徽标显示来源。

UI 使用现有 shadcn/Radix 原语组织工具栏、菜单、Sheet、Dialog、Tabs；编辑区域与终端有独立快捷键上下文，不与画布拖动/缩放抢事件。

## 2. 编辑器能力范围

保留 CodeMirror 6，扩充 LanguageService 和文档管理。是否未来替换编辑内核是实现细节，不以换内核代替功能交付。

| 功能     | 行为                                                            |
| -------- | --------------------------------------------------------------- |
| 文本编辑 | 语法高亮、行号、折叠、缩进、括号匹配、多光标、行操作、撤销/重做 |
| 搜索替换 | 当前文件/选择区、大小写/正则/全词、替换预览                     |
| 快速打开 | 路径模糊匹配、最近文件、跳转行列                                |
| 项目搜索 | 执行主机侧执行，支持 glob/忽略规则/大小上限，结果分页与取消     |
| 语言服务 | 补全、诊断、hover、定义、引用、符号、重命名、格式化、代码操作   |
| 文件信息 | 编码、BOM、LF/CRLF、tab/space、语言、只读、当前执行主机         |
| Markdown | 编辑/预览/分屏，代码块高亮、项目内资源与链接                    |
| 媒体预览 | 图片缩放/透明背景/尺寸；不支持的二进制提供下载及外部打开        |
| Git 集成 | 行边变更标记、打开当前文件 diff、查看历史版本                   |
| 导入导出 | 拖入文件、上传进度、复制到项目或只预览的明确选择                |
| 文件管理 | 新建、重命名、移动、删除、复制路径；目录展开懒加载              |
| 草稿管理 | 异常退出恢复、多个视图共享文档状态、关闭时处理未保存内容        |

语言服务按执行主机安装和探测，不把本机路径传给远端 LSP。无语言服务器时仍能完成文本编辑和语法高亮，显示缺失的具体能力；不弹出空补全列表假装已接入。

建议组件：`DocumentController`、`EditorToolbar`、`CodeEditorSurface`、`MarkdownPreview`、`ProjectSearchPanel`、`ProblemsPanel`、`SaveConflictDialog`、`LanguageServiceStatus`。

已实现（E01/M4）：

| 功能     | 实现                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 搜索替换 | CodeMirror `search({ top: true })`，面板自带大小写/正则/全字；替换那一行由 `EditorState.readOnly` 决定是否出现，面板文案经 `EditorState.phrases` 走 i18n                                                                                    |
| 快速打开 | ⌘P → `GET …/file-index?query=&limit=`，core 侧模糊匹配文件名（命中路径的排在后面），跳过 `.git`/`node_modules`/`target`/`dist` 等与 `.armadra`，扫描上限 40 000 项、默认返回 40 条，截断如实标注；同一路径复用已有编辑器                    |
| 项目搜索 | ⌘⇧H → 资源管理器「搜索」页 → `POST …/file-search`。字面量或正则、大小写、全字、包含/排除 glob、每文件命中上限（默认 20）、5s 总时长上限；>1 MiB 与含 NUL 的文件只计入 `skipped` 不读取；按文件分页（`offset`/`nextOffset`），点命中打开到行 |
| 文件信息 | 读取返回 `encoding`(`utf-8`/`unknown`)、`bom`、`eol`(`lf`/`crlf`/`mixed`/`none`)、`readonly`，编辑器状态栏显示；非 UTF-8 的文件 core 不给内容版本，因此天然只读                                                                             |
| Markdown | 头部按钮在 编辑 / 并排 / 预览 之间轮转。`react-markdown` 不接 `rehype-raw`，裸 HTML 与 `<script>` 只作为文本出现；相对路径图片经 `file-download` 读取，链接只放行 http/https 与文档内锚点                                                   |
| 文件管理 | 文件树右键与顶部按钮：新建文件/文件夹、重命名、移动（改路径或拖到目录行）、删除到回收站；受工作区 write 权限约束，无权限时菜单项不出现                                                                                                      |
| 语言服务 | 只有能力探测：`GET …/language-service` 恒为 `{ status: "unavailable", reason: "not_implemented" }`，设置 → 工作区显示「未启用」，编辑器状态栏显示「LSP 未启用」，不出现任何补全入口                                                         |

`eol` 为 `crlf` 时编辑器声明 `EditorState.lineSeparator`，保存取 `state.sliceDoc()`，一次保存不会把 CRLF 悄悄改成 LF；BOM 读取时剥离、保存时按 `bom` 写回。`mixed` 无法原样还原，状态栏说明保存会统一成 LF。共享领域类型里预留了 `languageService: { status: "unavailable" }`（`editorNodeDataSchema`），除此之外没有任何 LSP 代码。

删除只移动不删除：条目进入工作区 `.armadra/trash/<id>/`，旁边一份 `entry.json` 记着原路径，`POST …/file-entries/restore` 放回原处；原处被占用就是 409，不覆盖。`.armadra` 自身拒绝被这组接口创建、改名或删除，文件树也不展示它。

上表「语言服务」那一行与下面这句都是 E01/M4 当时的样子；语言服务的现状以[语言服务设计](./language-service.md) §5 的实施状态为准（批次 A–E 已落：真实 server、诊断与问题面板、补全 / hover / 定义、引用侧栏页、符号 `@` / `#`、代码操作、重命名预览、远端 link 与 restart / stop）。

尚未实现：最近文件与跳转行列输入、媒体预览的缩放与透明背景、Git 行边标记。

2026-09-26 补：项目搜索可以取消——页面每次只留一个请求，新查询、离开搜索页、点「停止」都会中止上一个；core 在连接断开时中止扫描（扫描每 64 个文件让一次事件循环，5s 总时长上限照旧）。文件树右键加了复制路径、复制相对路径，以及只在桌面壳且本机工作区时出现的「在访达 / 资源管理器中显示」，由 core 的 `POST …/reveal` 校验路径在工作区内后拉起系统文件管理器。

已实现（2026-09-26）：快速打开在输入为空时先列本机最近打开的文件（按工作空间存在 localStorage），输入 `路径:行:列` 打开到位置、`:行[:列]` 跳当前编辑器，「跳转到行」（⌃G）就是带着 `:` 打开快速打开；Git 行边标记由 `git/diff` 两个作用域的 patch 倒推出 HEAD 的行，编辑时实时重算，保存、重载、窗口回焦与 Git 面板写操作之后重取；预览种类加了 `video` / `audio` / `pdf`（core 的 `mediaPreviewOf` 判定，只收引擎能播的格式、且不超过下载路由的 16 MiB），字节经 `file-download` 取回按 MIME 包成 blob 交给原生 `<video>` / `<audio>` / `<iframe>`，图片支持适应 / 1:1 / 滚轮缩放与透明棋盘格。

尚未实现：搜索结果的取消按钮。

### 2.1 文件管理器拖拽

左侧文件树和 Files 节点使用同一文件引用，包含协议版本、执行来源、工作空间和规范化相对路径。内部拖拽传递文件引用；打开预览复用项目中的文件，不把一次拖动变成重复导入。

| 落点                                   | 行为                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| 普通终端                               | 核对当前会话、generation、工作空间及 shell，插入经过引用的文件路径；不附加回车 |
| Agent 终端                             | 插入供提示词引用的路径文本，保留会话身份检查；不自动运行文件或执行命令         |
| 画布                                   | 在落点打开文本预览、图片或文件管理节点，复用现有预览/资产入口                  |
| 输入框、对话框、其他项目或不明执行位置 | 保持原输入语义或明确拒绝，不猜测远端路径、不创建错误画布节点                   |

终端拒绝含控制字符的路径；POSIX、PowerShell 和 CMD 使用各自规则，无法可靠表示的路径报告原因。拖动期间切换画布或重启会话后，过期的异步结果不再插入。

浏览器的外部 File 对象不包含可信绝对路径，不能拿文件名或 fakepath 冒充终端位置。已有外部文件到画布的导入继续使用原流程。Tauri Windows 的原生拖放处理会替换 WebView2 的 HTML5 处理器，因此内部拖拽需要指针事件适配，同时保留系统文件导入；参见 [Tauri 拖放配置](https://v2.tauri.app/reference/config/#dragdropenabled)。

指针适配有启动阈值、落点反馈及取消/失焦/卸载清理。一次拖动只能由一个落点消费；终端接收后不能再触发画布预览，取消拖动也不能触发文件点击动作。

## 3. 文档、保存与外部变更

`DocumentId = executionHostId + workspaceId + normalizedRelativePath`。状态包含 baseVersion、baseHash、draftRevision、encoding、eol、dirty、externalVersion、readOnlyReason。编辑器视图 ID 与文档 ID 分开，两个节点打开同文件共享本设备草稿，避免互相覆盖。

读取返回 bytes/encoding/version；写入包含 expectedVersion、目标编码和 EOL。core 检查规范路径和版本后执行同目录临时文件写入、刷新与原子替换；保留权限，遇到符号链接按明确策略写入允许的真实目标，不直接替换链接造成语义变化。

原子替换只保证保存完整，不保证与外部编辑器的强互斥。写入前重新核对指纹，监听写入后的外部变化；变化竞争时保留恢复副本并提示，不声称能对所有外部写者实现原子 CAS。

外部变化规则：

- 本地没有草稿：自动刷新并尽量保留光标/滚动。
- 有未保存草稿：显示三方 base/local/disk 合并，不覆盖草稿。
- 文件被移动/删除：保留草稿，允许重新定位或另存为。
- 远端断开：草稿可本机持久化，标题显示未同步；重连比较版本后保存。
- 保存响应丢失：查询文件版本/hash 判断是否已保存，再决定重试。

已实现（E01/M4，core + 画布）：编辑器节点打开文本文件时用 `POST /api/workspaces/{id}/file-watch` 注册，core 监听该文件的父目录，变化经现有工作空间事件通道推 `file.changed`（`workspaceId` / `path` / `kind` = modified·removed·replaced / `sha256` / `size` / `mtime`）。写入前先登记即将发布的哈希，自身保存不会被报成外部修改；关闭节点、撤销读权限、删除工作空间和 core 关停都会释放 watcher。监听不可用时注册回答 `status: "unsupported"`，客户端退回 `GET /api/workspaces/{id}/file-version`（窗口重新获得焦点时问一次，不轮询）。

节点侧：无草稿自动重载并提示；有草稿显示非模态提示条，提供比较（磁盘版 → 草稿的行级 diff，复用变更节点的着色）、重载放弃草稿、保留草稿三种选择。保留草稿把最新磁盘版本当作下一次保存的内容版本，之后磁盘再变仍然 409 并重新提示。文件被删除时只保留草稿，下一次保存按新建提交。

三方合并已实现（2026-09-07），但落在 **Git 冲突**上而不是本节原本写的 base/local/disk：编辑器读到的正文里有 Git 冲突标记时，头部出现「三方合并」，打开的是共同祖先 / 我们的 / 他们的三栏加一份结果。三份原文取自 Git 索引（`git/repository/integration` 已经给出三个 blob），不是解析工作区文件里的标记——标记只有在 diff3 风格下才带祖先，而没有祖先的「三方合并」只是二选一。每处冲突可取一侧、两侧、祖先或都不要；两边改成同一样东西的地方不算冲突，不会拿去问人。写盘带打开视图时读到的内容版本，随后仍由现有的 `git/resolve` 重读文件、确认没有冲突标记才入索引——保存一个文件不等于解决了它。代码在 `apps/web/src/editor/merge/`，行级 diff3 在 `apps/web/src/lib/merge3.ts`（不引入新依赖）。

草稿保护已实现（2026-09-26）：未保存的草稿去抖后写进本机 localStorage（工作空间 + 路径一条，记着改起时的内容版本与正文），关页面与节点卸载时立刻落下；重开时磁盘还是那一版就原样放回，磁盘变了则放回草稿、保存凭据退回旧版本（直接保存会 409），提示条给出「合并」——base = 草稿改起时的正文、ours = 草稿、theirs = 磁盘，复用 `editor/merge/` 的对话框（草稿模式只把结果放回编辑器，不写盘）。打开时文件已不在而本机有草稿，就把草稿当正文打开并按新建保存；文件被删或移走时提示条提供「另存为」，写到新路径后节点改指过去。

重新定位已实现（2026-09-26）：提示条的「重新定位」选一个已存在的文件——「合并」以草稿改起时的正文为 base、目标文件为 theirs 走同一个合并对话框，结果写成目标文件的本机草稿再把节点改指过去（不写盘）；「覆盖」再确认一次后带着读到的内容版本写盘（期间被改就 409）。目标不存在时不代为新建，那是另存为。

尚未实现：标题的「未同步」状态。`replaced` 依赖 inode，Windows 上退化为 `modified`。

编辑器撤销栈只包含文本操作，画布撤销栈只包含布局；Git 还原、语言服务多文件修改和重命名以操作预览及明确完成事件处理，不让普通 Ctrl+Z 跨进程撤销 Git。

删除文件优先可恢复暂存；后台任务仍持有文件引用时提示范围。上传采用分块 hash 校验和临时目标，完成后一次性发布；重名覆盖先预览。大文件采用只读/分块模式，初始阈值 5 MiB、500k 行，可配置并实测，不能整文件直接卡住主线程。

重命名已实现为「画布跟着走」（E01/M4）：`file-entries/rename` 成功后，打开该文件、或该目录下任一文件的编辑器与文件管理器节点一起改路径；节点标题只在它原本就是旧文件名时才跟着改，用户手改过的标题保留。删除不动节点：编辑器正监听这个文件，`removed` 那条既有路径会把它转成 create-only 草稿。

## 4. 语言服务与不受信任预览

LSP 运行在执行主机侧，生命周期按工作空间/语言复用，idle 时回收。LSP 的 JSON-RPC 在执行端适配，跨端走类型化 EditorService 或限范围的版本化载荷，不开放任意进程通道。

格式化/重命名/代码操作返回 WorkspaceEdit，客户端预览文件列表、内容和版本，再由执行主机执行。版本不符就重新计算；未允许的项目外路径拒绝。

Markdown 预览禁用任意脚本，HTML 经清理；相对链接解析在工作空间资源服务下。HTTP 内容、Markdown 和语言服务建议都是资料，不获得应用 RPC 权限。SVG 用隔离预览，禁止把脚本能力直接带入应用文档。

## 5. 受控浏览器架构决定

采用受管 Chromium + 独立 Browser Worker。画布节点显示该浏览器会话的画面并转发操作，Agent 控制同一个 session。保留旧 iframe 为明确的兼容预览模式；它不计入“受控浏览器已完成”的验收。

原因：Tauri 在不同平台使用不同 WebView 引擎，不能假设桌面系统 WebView 都具有同一套 Chromium 调试接口；原生子 WebView 与画布缩放、裁剪、遮挡的行为也需要逐平台验证。依据 [Tauri WebView 平台说明](https://v2.tauri.app/reference/webview-versions/) 与 [WebView API](https://v2.tauri.app/reference/javascript/api/namespacewebview/)。

首轮 Browser Worker 使用 core 管理 Chromium 生命周期和受限 CDP 适配；不引入公开的原始 CDP 代理。浏览器二进制按 OS/架构单独受管下载或使用用户选定的受支持路径，校验 hash/签名和版本；缺少浏览器时提供安装/选择流程及明确不可用状态。

M0 必须验证 macOS/Windows/Linux 的启动、页面渲染、输入法、画布裁剪、帧传输与无头服务器模式。若某平台 PoC 不通过，登记具体能力缺口，不能以普通 iframe 替代后标记完整。音视频、DRM、浏览器扩展和通用同步账号不作为本期浏览器验收目标；开发预览、交互、调试、登录、文件上传下载必须完成。

## 6. 浏览器节点功能

| 类别       | 内容                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| 导航       | URL/搜索输入、前进、后退、刷新、停止加载、标题、加载进度和错误页                 |
| 会话       | 同一项目可多个浏览器节点；每个节点对应明确 tab/session，按策略共享或隔离 profile |
| 开发预览   | localhost/远端服务 URL、响应式尺寸、页面缩放、截图、打开关联终端                 |
| 交互       | 鼠标、滚动、键盘、选择文本、复制粘贴、中文输入、触摸转发                         |
| 调试       | Console 错误、Network 请求摘要/失败、页面错误；敏感 header/body 默认隐藏         |
| 页面能力   | JS Dialog、文件选择、下载队列、popup 请求、权限请求与登录持久化                  |
| 历史与收藏 | 项目范围历史、固定起始页、清理浏览数据                                           |
| 共享状态   | Agent 正在操作徽标、人工接管、当前控制者、只读观察者                             |
| 远程查看   | 同一 BrowserSession 在桌面、浏览器和手机上呈现                                   |

URL 只允许 http/https；开发项目可以显式声明 loopback 服务。访问执行主机上的应用管理端口、云元数据地址和非项目内网目标有独立网络策略，检查重定向及解析结果；不能让任意远端页面通过浏览器绕过 core 的授权。

页面新窗口默认转受管新 tab 并提示；下载存入工作空间指定目录，状态包含来源、目标、大小及校验。上传由用户/已授权 Agent 选择项目内文件；不可通过页面 file chooser 读取整个执行主机。

已实现（B01/M5，core 的 `browser/` 域）：

| 类别   | 实现                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器 | 按 `browser.executablePath` → `ARMADRA_BROWSER_PATH`/`CHROME_PATH` → 各平台标准安装位置查找 Chrome/Chromium/Edge/Brave；找不到时 `GET …/browser/availability` 回 `available:false`、`reasonCode:"chrome_not_found"` 并列出查过的路径，不下载、不假装 |
| 会话   | 一个浏览器节点一个 `BrowserSession`，独立 0700 profile 在 `<数据目录>/browser-profiles/<sessionId>`；`browser_sessions` 表 + profile 就是重启后重新拉起的全部依据，登录状态随 profile 留在执行主机                                                   |
| 导航   | `POST …/navigate` 的 goto/back/forward/reload/stop；只放行 http/https，拒绝实例元数据地址与 Armadra 自己的 43120/43121                                                                                                                               |
| 画面   | CDP `Page.startScreencast` 的 JPEG 帧经现有工作空间 WS 推 `browser.frame`；订阅按 focused/visible/hidden 分级（65/1×/15fps、40/2×/5fps、不推流），订阅全部失效即停流、页面继续跑                                                                     |
| 输入   | `POST …/input` 转发鼠标/滚轮/键盘/触摸，中文与 IME 走 `Input.insertText`；请求带 `navigationEpoch`，页面已导航时整批拒绝（409），客户端等新帧而不是重放                                                                                              |
| 尺寸   | `POST …/viewport` 写 `Emulation.setDeviceMetricsOverride`，节点尺寸变化去抖后跟随，画布缩放不写进页面 viewport                                                                                                                                       |
| 截图   | `POST …/capture` 存到工作区 `.armadra/browser/<sessionId>-<时间>.png`，返回工作区相对路径、尺寸、字节数与 sha256                                                                                                                                     |
| 调试   | Console 与 Network 各 200 条有界环形缓冲，`GET …/read?mode=console` / `?mode=network` 读取；只有方法/URL/状态/MIME/字节数/失败码，不采集任何 header 与响应体                                                                                         |
| 下载   | `Browser.setDownloadBehavior` 落在数据目录的暂存区，队列里是 `pending`；`POST …/downloads/{id}` 接受才移进工作区 `.armadra/downloads/`（重名加序号），拒绝就删掉暂存文件                                                                             |

尚未实现：受管浏览器二进制的下载与校验、页面缩放、项目范围历史与固定起始页、清理浏览数据、JS Dialog 与 popup 处理、上传、重定向后的网络策略复检、Agent 操作徽标与人工接管租约。

## 7. Agent 浏览器接口

`BrowserAction` 以明确 oneof 定义动作，不开放通用 `eval` 或任意 CDP method。浏览器 Worker 可内部执行固定的 DOM 辅助脚本，调用者不能注入代码。

| 动作                            | 输入                                                | 输出                                |
| ------------------------------- | --------------------------------------------------- | ----------------------------------- |
| Create / Navigate               | 项目、URL、profileRef                               | browserSessionId、navigationEpoch   |
| Read                            | text / elements / links / title / console / network | 有界内容、稳定元素引用、截断状态    |
| Click / Type / Select           | elementRef、文本/选项                               | actionId、实际目标及结果            |
| Press / Scroll                  | 允许的键或方向/距离                                 | 更新序号、超时/失败原因             |
| Wait                            | 元素/URL/明确状态、timeout                          | 命中或超时；不无限等待 network idle |
| Capture                         | viewport/full、格式                                 | 工作空间资产引用、尺寸、hash        |
| Upload / Download               | 明确文件引用/下载 ID                                | 状态、目标路径、大小                |
| Back / Forward / Reload / Close | session、navigationEpoch                            | 操作结果与新 epoch                  |

DOM 元素引用绑定 session/tab/frame/navigationEpoch；页面导航或元素失效后返回 STALE_TARGET，重新 Read，禁止猜测旧选择器继续点击。Iframe 操作同时绑定 frameId。截图与页面动作依靠 CDP 的 [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) 和 [Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) 等域在执行端转换，协议版本在 M0 锁定并测试。

动作身份包含真实 Agent Session 和项目授权；开始时获取 BrowserControlLease。人类点击“接管”立即撤销 Agent 输入租约，已经派发但结果未明的动作显示 unknown，不重复执行。读页面可以多读者，输入默认单写者。

涉及账号、发布、购买、权限等动作仍受调用方授权范围约束；页面本身的文字不能提升 Agent 在 core 里的权限。Cookie 密钥默认不向 Agent 返回，登录由浏览器会话维持；将来若提供凭据导出必须另设能力与审计。

已实现（B01/M5）：`armadra-hook browser <navigate|read|click|type|wait|capture>` 经 `POST /browser/{verb}` 到达 core，与 `context`/`canvas` 同一套凭据。授权是三重检查：目标必须出现在调用者自己的上下文链接文档里、必须是同工作空间的 `browser` 节点、且调用者持有本 core 签发的节点令牌（`legacy` 一律拒绝）；`browser` 能力可在自定义 Agent 设置里关掉。人与 Agent 操作的是同一个 session，没有第二个只给 Agent 的浏览器。

`read` 支持 text/elements/links/title/console/network，正文按字节上限截断并如实标注。元素引用是 `e<navigationEpoch>-<序号>`，页面导航后同一个引用返回 `STALE_TARGET`，必须重新 read；`links` 不发引用，因为链接要么走 elements 要么直接用它报出的 href。`wait` 只接受 selector / url-contains / title-contains 三选一，上限 30 秒，没有 network idle 这一项。每一次动作（含被拒绝的）都写进节点活动 `.armadra/board-log.jsonl`。

尚未实现：Select/Press/Scroll/Upload/Download/Back/Forward/Close 动词、BrowserControlLease 与人工接管、多 tab 与 iframe 定位。

## 8. 画面传输与跨端输入

浏览器 viewport 使用 CSS 像素，`BrowserFrame` 包含 frameSeq、navigationEpoch、viewportWidth/Height、deviceScaleFactor、编码、时间和资产/bytes。客户端在画布的浏览器节点内缩放显示，不把画布缩放直接写成网页 viewport 尺寸。

点击坐标从显示框映射回 CSS viewport，携带 frameSeq；过旧帧或导航变化时拒绝输入并请求新画面。移动端可切文本元素列表来提高可操作性。文本选择/剪贴板由 Browser Worker 受限接口配合，截图画面本身不能提供浏览器原生复制和无障碍语义。

首版使用图像帧 + 输入事件，按焦点和网络预算控制帧率；被遮挡/无人订阅的会话停止画面传输，但保留页面及 Agent 操作能力。优先验证 CDP screencast，相关实验性能力需要探测；fallback 为有界截图更新并明确降低流畅度，不用于承诺视频体验。后续视频通道可替换帧载荷而保持输入与 session 契约。

目标交互预算：本机焦点页面点击至更新画面 p95 ≤ 200 ms，局域网 p95 ≤ 350 ms；这是验收目标而非实测结果。M0 用表单、滚动长页、Canvas 页面和中文输入建立基线，不通过时调整方案后再标记完整浏览器支持。

输入法使用 composition 生命周期，提交文本通过受控文本输入路径，不逐按键拆中文；快捷键中的浏览器 Back/Reload 只作用当前 browser session。辅助技术使用可读元素树和页面状态描述，不把纯图像当成无障碍完成。

已实现（B01/M5）：`browser.frame` 事件携带 `sessionId`/`generation`/`frameSeq`/`navigationEpoch`/viewport 尺寸/`deviceScaleFactor`/base64 JPEG/时间戳。节点把位图画进 `<canvas>`，显示尺寸交给 CSS，点击坐标按显示框与位图的比例映射回 CSS viewport 再连同 `navigationEpoch` 发回。新订阅者会先收到一张用 `Page.captureScreenshot` 补的首帧——`startScreencast` 只在合成器有新内容时出帧，静止页面否则要等到有东西动才看得见。中文输入落在画布上方一块透明文本域，提交文本按 `text` 事件走，不拆成按键。

尚未实现：延迟基线测量（§8 的 p95 目标仍是验收目标而非实测）、移动端文本元素列表、视频通道。

## 9. 后台与恢复

BrowserSession 与节点生命周期分离：节点隐藏不关闭页面；core 重启后尝试重新认领 Browser Worker。Browser Worker 崩溃后可恢复 profile、URL 和历史，但不能恢复任意网页 JS 堆/未提交表单，必须显示恢复方式与丢失范围。

画布无订阅者时，截图暂停；有 Agent 控制或自动化正在等待页面时不销毁 session。空闲浏览器回收策略必须排除下载、权限请求、未完成上传和 active lease，回收前保存可恢复信息。

“关闭浏览器节点”区分移除展示和结束 BrowserSession；结束需要检查其他设备订阅与任务引用。网页普通登录状态存于执行主机隔离 profile，不同步整个 profile 到其他设备。

已实现（B01/M5）：关闭节点只退订画面，页面继续跑，重新打开同一节点接回同一 session（`DELETE …/sessions/{id}` 默认 `terminate=false`）；`terminate=true` 才结束进程组、删 profile、删行。core 启动时后台重放所有 `keepAlive` 的行：按原 profile 重新拉起、回到记录的 URL，`generation` +1 好让客户端认出这是重启后的会话；页面 JS 堆与未提交的表单回不来，节点状态如实显示。core 正常退出会关掉自己启动的全部浏览器。

限制：core 被 SIGKILL 时来不及关浏览器，残留进程会占住 profile，下次重启该会话报 `launch_failed` 并显示 disconnected，需要手动清理。Windows 上只能结束浏览器主进程，没有进程组语义。空闲回收策略、跨设备订阅检查与"结束前保存可恢复信息"尚未实现。

## 10. 测试与交付

编辑器：UTF-8/BOM/CRLF、非 UTF-8 提示、大文件、符号链接、权限拒绝、外部修改、远程断线、保存响应丢失、多节点同文件、LSP 多文件变更、草稿恢复、Markdown 注入。

浏览器：三 OS、headless、不同缩放/DPI、嵌套 Frame、旧帧点击、导航中输入、iframe、中文 IME、滚动、表单、上传下载、popup、dialog、登录持久化、慢网络、人工接管、Worker 崩溃、外部页面无应用 IPC 权限。

端到端场景：编辑项目 → 启动 dev server → 节点打开页面 → 人工输入 → Agent 读取并继续同一页面 → 截图附到会话 → 手机查看和接管 → 关闭全部 UI 后自动化继续访问 → 重连查看同一结果。
