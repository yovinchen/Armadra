# 文件编辑器与受控浏览器设计

> 状态：目标设计，待实施。面向桌面、浏览器客户端与移动端的同一执行服务。

## 1. 交互位置与通用模型

画布保留 Editor、Files、Diff、Browser 节点。节点展开后可进入焦点模式，文件树/搜索结果及 Git 面板可打开关联节点；同一路径默认复用已有编辑器，用户可主动新建第二个视图。

文件和浏览器目标始终绑定 executionHostId。远程项目中的网页 `localhost` 指向浏览器所在执行主机，文件路径指向 Worker 根目录；节点头部用简短主机徽标显示来源。

UI 使用现有 shadcn/Radix 原语组织工具栏、菜单、Sheet、Dialog、Tabs；编辑区域与终端有独立快捷键上下文，不与画布拖动/缩放抢事件。

## 2. 编辑器能力范围

保留 CodeMirror 6，扩充 LanguageService 和文档管理。是否未来替换编辑内核是实现细节，不以换内核代替功能交付。

| 功能     | 行为                                                            |
| -------- | --------------------------------------------------------------- |
| 文本编辑 | 语法高亮、行号、折叠、缩进、括号匹配、多光标、行操作、撤销/重做 |
| 搜索替换 | 当前文件/选择区、大小写/正则/全词、替换预览                     |
| 快速打开 | 路径模糊匹配、最近文件、跳转行列                                |
| 项目搜索 | Worker 侧执行，支持 glob/忽略规则/大小上限，结果分页与取消      |
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

### 2.1 文件管理器拖拽

左侧文件树和 Files 节点使用同一文件引用，包含协议版本、Runtime/Host 来源、工作空间和规范化相对路径。内部拖拽传递文件引用；打开预览复用项目中的文件，不把一次拖动变成重复导入。

| 落点 | 行为 |
| --- | --- |
| 普通终端 | 核对当前会话、generation、工作空间及 shell，插入经过引用的文件路径；不附加回车 |
| Agent 终端 | 插入供提示词引用的路径文本，保留会话身份检查；不自动运行文件或执行命令 |
| 画布 | 在落点打开文本预览、图片或文件管理节点，复用现有预览/资产入口 |
| 输入框、对话框、其他项目或不明执行位置 | 保持原输入语义或明确拒绝，不猜测远端路径、不创建错误画布节点 |

终端拒绝含控制字符的路径；POSIX、PowerShell 和 CMD 使用各自规则，无法可靠表示的路径报告原因。拖动期间切换画布或重启会话后，过期的异步结果不再插入。

浏览器的外部 File 对象不包含可信绝对路径，不能拿文件名或 fakepath 冒充终端位置。已有外部文件到画布的导入继续使用原流程。Tauri Windows 的原生拖放处理会替换 WebView2 的 HTML5 处理器，因此内部拖拽需要指针事件适配，同时保留系统文件导入；参见 [Tauri 拖放配置](https://v2.tauri.app/reference/config/#dragdropenabled)。

指针适配有启动阈值、落点反馈及取消/失焦/卸载清理。一次拖动只能由一个落点消费；终端接收后不能再触发画布预览，取消拖动也不能触发文件点击动作。

## 3. 文档、保存与外部变更

`DocumentId = executionHostId + workspaceId + normalizedRelativePath`。状态包含 baseVersion、baseHash、draftRevision、encoding、eol、dirty、externalVersion、readOnlyReason。编辑器视图 ID 与文档 ID 分开，两个节点打开同文件共享本设备草稿，避免互相覆盖。

读取返回 bytes/encoding/version；写入包含 expectedVersion、目标编码和 EOL。Worker 检查规范路径和版本后执行同目录临时文件写入、刷新与原子替换；保留权限，遇到符号链接按明确策略写入允许的真实目标，不直接替换链接造成语义变化。

原子替换只保证保存完整，不保证与外部编辑器的强互斥。写入前重新核对指纹，监听写入后的外部变化；变化竞争时保留恢复副本并提示，不声称能对所有外部写者实现原子 CAS。

外部变化规则：

- 本地没有草稿：自动刷新并尽量保留光标/滚动。
- 有未保存草稿：显示三方 base/local/disk 合并，不覆盖草稿。
- 文件被移动/删除：保留草稿，允许重新定位或另存为。
- 远端断开：草稿可本机持久化，标题显示未同步；重连比较版本后保存。
- 保存响应丢失：查询文件版本/hash 判断是否已保存，再决定重试。

编辑器撤销栈只包含文本操作，画布撤销栈只包含布局；Git 还原、语言服务多文件修改和重命名以操作预览及明确完成事件处理，不让普通 Ctrl+Z 跨进程撤销 Git。

删除文件优先可恢复暂存；后台任务仍持有文件引用时提示范围。上传采用分块 hash 校验和临时目标，完成后一次性发布；重名覆盖先预览。大文件采用只读/分块模式，初始阈值 5 MiB、500k 行，可配置并实测，不能整文件直接卡住主线程。

## 4. 语言服务与不受信任预览

LSP 运行在 Worker 侧，生命周期按工作空间/语言复用，idle 时回收。LSP 的 JSON-RPC 在执行端适配，跨端走类型化 EditorService 或限范围的版本化载荷，不开放任意进程通道。

格式化/重命名/代码操作返回 WorkspaceEdit，客户端预览文件列表、内容和版本，再由 Worker 执行。版本不符就重新计算；未允许的项目外路径拒绝。

Markdown 预览禁用任意脚本，HTML 经清理；相对链接解析在工作空间资源服务下。HTTP 内容、Markdown 和语言服务建议都是资料，不获得应用 RPC 权限。SVG 用隔离预览，禁止把脚本能力直接带入应用文档。

## 5. 受控浏览器架构决定

采用受管 Chromium + 独立 Browser Worker。画布节点显示该浏览器会话的画面并转发操作，Agent 控制同一个 session。保留旧 iframe 为明确的兼容预览模式；它不计入“受控浏览器已完成”的验收。

原因：Tauri 在不同平台使用不同 WebView 引擎，不能假设桌面系统 WebView 都具有同一套 Chromium 调试接口；原生子 WebView 与 tldraw 缩放、裁剪、遮挡的行为也需要逐平台验证。依据 [Tauri WebView 平台说明](https://v2.tauri.app/reference/webview-versions/) 与 [WebView API](https://v2.tauri.app/reference/javascript/api/namespacewebview/)。

首轮 Browser Worker 使用 Rust 管理 Chromium 生命周期和受限 CDP 适配；不引入公开的原始 CDP 代理。浏览器二进制按 OS/架构单独受管下载或使用用户选定的受支持路径，校验 hash/签名和版本；缺少浏览器时提供安装/选择流程及明确不可用状态。

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

URL 只允许 http/https；开发项目可以显式声明 loopback 服务。访问执行主机上的应用管理端口、云元数据地址和非项目内网目标有独立网络策略，检查重定向及解析结果；不能让任意远端页面通过浏览器绕过 Host 的授权。

页面新窗口默认转受管新 tab 并提示；下载存入工作空间指定目录，状态包含来源、目标、大小及校验。上传由用户/已授权 Agent 选择项目内文件；不可通过页面 file chooser 读取整个执行主机。

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

涉及账号、发布、购买、权限等动作仍受调用方授权范围约束；页面本身的文字不能提升 Agent 的 Host 权限。Cookie 密钥默认不向 Agent 返回，登录由浏览器会话维持；将来若提供凭据导出必须另设能力与审计。

## 8. 画面传输与跨端输入

浏览器 viewport 使用 CSS 像素，`BrowserFrame` 包含 frameSeq、navigationEpoch、viewportWidth/Height、deviceScaleFactor、编码、时间和资产/bytes。客户端在 tldraw shape 内缩放显示，不把画布缩放直接写成网页 viewport 尺寸。

点击坐标从显示框映射回 CSS viewport，携带 frameSeq；过旧帧或导航变化时拒绝输入并请求新画面。移动端可切文本元素列表来提高可操作性。文本选择/剪贴板由 Browser Worker 受限接口配合，截图画面本身不能提供浏览器原生复制和无障碍语义。

首版使用图像帧 + 输入事件，按焦点和网络预算控制帧率；被遮挡/无人订阅的会话停止画面传输，但保留页面及 Agent 操作能力。优先验证 CDP screencast，相关实验性能力需要探测；fallback 为有界截图更新并明确降低流畅度，不用于承诺视频体验。后续视频通道可替换帧载荷而保持输入与 session 契约。

目标交互预算：本机焦点页面点击至更新画面 p95 ≤ 200 ms，局域网 p95 ≤ 350 ms；这是验收目标而非实测结果。M0 用表单、滚动长页、Canvas 页面和中文输入建立基线，不通过时调整方案后再标记完整浏览器支持。

输入法使用 composition 生命周期，提交文本通过受控文本输入路径，不逐按键拆中文；快捷键中的浏览器 Back/Reload 只作用当前 browser session。辅助技术使用可读元素树和页面状态描述，不把纯图像当成无障碍完成。

## 9. 后台与恢复

BrowserSession 与节点生命周期分离：节点隐藏不关闭页面；Host 重启后尝试重新认领 Browser Worker。Browser Worker 崩溃后可恢复 profile、URL 和历史，但不能恢复任意网页 JS 堆/未提交表单，必须显示恢复方式与丢失范围。

画布无订阅者时，截图暂停；有 Agent 控制或自动化正在等待页面时不销毁 session。空闲浏览器回收策略必须排除下载、权限请求、未完成上传和 active lease，回收前保存可恢复信息。

“关闭浏览器节点”区分移除展示和结束 BrowserSession；结束需要检查其他设备订阅与任务引用。网页普通登录状态存于执行主机隔离 profile，不同步整个 profile 到其他设备。

## 10. 测试与交付

编辑器：UTF-8/BOM/CRLF、非 UTF-8 提示、大文件、符号链接、权限拒绝、外部修改、远程断线、保存响应丢失、多节点同文件、LSP 多文件变更、草稿恢复、Markdown 注入。

浏览器：三 OS、headless、不同缩放/DPI、嵌套 Frame、旧帧点击、导航中输入、iframe、中文 IME、滚动、表单、上传下载、popup、dialog、登录持久化、慢网络、人工接管、Worker 崩溃、外部页面无应用 IPC 权限。

端到端场景：编辑项目 → 启动 dev server → 节点打开页面 → 人工输入 → Agent 读取并继续同一页面 → 截图附到会话 → 手机查看和接管 → 关闭全部 UI 后自动化继续访问 → 重连查看同一结果。
