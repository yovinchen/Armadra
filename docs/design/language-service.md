> 状态：批次 A、B 已实施（见 §5 表格下的实施状态两行），批次 C（Web 客户端与 UI）、D（远端）仍是目标设计。本文是 [编辑器与浏览器设计](./editor-browser-design.md) §2「语言服务」与 §4 的实施方案，对应 [功能预期总表](../status/feature-roadmap.md) §3.5 的「语言服务」一行与 [平台实施记录](../status/platform-implementation-status.md) E01 的「LSP」剩余项。本机工作空间已能拉起真实 server 并把诊断、格式化、`WorkspaceEdit` 送到会话 WebSocket；浏览器侧尚未接线，远端工作空间一律 `UNSUPPORTED`。

# 编辑器语言服务（LSP）集成设计

## 0. 结论

| 决定            | 内容                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 服务器从哪来    | 只复用执行主机上用户已安装的 language server（PATH 或设置里的绝对路径），`--version` 探测成功才算存在；缺失、探测失败、被禁用一律回答 `unsupported` 并给稳定 reason。不下载、不安装、不做任何自动动作                                                                          |
| 进程在哪跑      | 在工作空间的执行主机上：本机工作空间由 Runtime 进程内的 `language::Manager` 拉起；远端工作空间由远端 `armadra-runtime worker` 拉起，Runtime 只做转发。同一执行主机上一个 server 服务该主机上所有打开该语言文件的编辑器节点，按（执行主机, 工作空间, serverId）复用             |
| 谁是 LSP 客户端 | 执行主机侧的 `Manager` 是唯一真正与 server 握手的 JSON-RPC 客户端；每个 Web 连接得到一个「会话」，会话看到的 `initialize` 应答由 `Manager` 用缓存的 server capabilities 代答。文档状态（didOpen/didChange 影子文本与版本号）只在执行主机侧维护一份，server 重启对 Web 透明     |
| Web 客户端      | CodeMirror 官方 `@codemirror/lsp-client`（传输层可替换、按 uri 管理多文件），经一条会话专用 WebSocket 传原始 JSON-RPC 文本帧；若实测 chunk 超预算则退回一个 ≤ 600 行的自研薄客户端（§2.4 有判定标准）                                                                          |
| 权限门          | 启动 server 需要工作空间 **execute** 授权（与 Git 同理：server 会执行项目内的构建脚本、插件、`cargo check`）；会话内方法按 read / write 分级白名单，白名单之外的方法在执行主机侧拒绝                                                                                           |
| 路径边界        | Web 只见工作空间相对路径（`armadra:///<rel>`），执行主机侧把它改写成 `file://<root>/<rel>` 交给 server，反向同样改写；server 返回的工作空间之外的位置标记为 `external`，首版不打开                                                                                             |
| 多文件修改      | 重命名、代码操作、格式化返回的 `WorkspaceEdit` 先在 Web 预览（文件列表、逐文件 diff、内容版本），确认后由执行主机按 sha256 逐文件写入；受影响的已打开文档必须没有未保存草稿                                                                                                    |
| 协议            | 新增 `proto/armadra/v1/language.proto`（能力探测、会话、消息信封、编辑应用），`worker.proto` 的 `WorkerRequest/WorkerResponse` 各加 oneof 分支（编号从 30 起），远端用第二条 `worker --stdio --language-link` 连接承载全双工帧；`resources.proto` 加平台组件 `LANGUAGE_SERVER` |
| 首批语言        | TypeScript/JavaScript、Rust、Go、Python、JSON、YAML、Markdown（§1.2 表）                                                                                                                                                                                                       |

## 1. 目标与边界

### 1.1 能力

| 能力     | LSP 方法                                                                        | 首版         | 编辑器呈现                                                                      |
| -------- | ------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| 补全     | `textDocument/completion`、`completionItem/resolve`                             | 是           | CodeMirror autocomplete 源；无 server 时不注册源，不出现空列表                  |
| 诊断     | `textDocument/publishDiagnostics`（推送）                                       | 是           | 行内标记 + 行槽 + 问题面板（`ProblemsPanel`）                                   |
| hover    | `textDocument/hover`                                                            | 是           | tooltip；Markdown 走与预览相同的无脚本渲染                                      |
| 签名帮助 | `textDocument/signatureHelp`                                                    | 是           | 输入 `(` `,` 触发                                                               |
| 定义     | `textDocument/definition`、`typeDefinition`、`implementation`                   | 是           | 同工作空间：复用 `open-editor.ts` 打开并定位；工作空间之外：状态栏提示 external |
| 引用     | `textDocument/references`                                                       | 是           | 列表面板，点击定位（复用项目搜索结果的列表组件）                                |
| 符号     | `textDocument/documentSymbol`、`workspace/symbol`                               | 是           | 快速打开（⌘P）加 `@` / `#` 前缀                                                 |
| 重命名   | `textDocument/prepareRename`、`textDocument/rename`                             | 是           | 预览对话框 → 执行主机写入（§2.6）                                               |
| 格式化   | `textDocument/formatting`、`rangeFormatting`                                    | 是           | 只改草稿；保存时格式化默认关闭（`language.formatOnSave`）                       |
| 代码操作 | `textDocument/codeAction`、`codeAction/resolve`                                 | 是（无命令） | 只应用带 `edit` 的操作；带 `command` 的操作首版不显示                           |
| 折叠     | `textDocument/foldingRange`                                                     | 否           | 沿用 CodeMirror 语法折叠                                                        |
| 其它     | semanticTokens、inlayHint、callHierarchy、pull diagnostics、`executeCommand` 等 | 否           | 见 §6.2                                                                         |

### 1.2 首批语言与服务器发现

发现只在执行主机上进行，规则与 `apps/runtime/src/agent_probe.rs` 一致：只运行 `--version`（关闭 stdin、8 s 超时、64 KiB 输出上限），结果缓存 24 h，探测失败是独立答案而不是「支持」。**注意 rustup 的 `rust-analyzer` 代理即使组件未安装也存在于 PATH**，本机实测 `rust-analyzer --version` 报 `Unknown binary 'rust-analyzer' in official toolchain`——所以「文件存在」不算发现，`--version` 退出码 0 才算。

| languageId                | 扩展名                        | 候选（按顺序，先命中先用）                                | 启动参数                    | 说明                                                                                              |
| ------------------------- | ----------------------------- | --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `typescript`/`javascript` | ts tsx js jsx mjs cjs mts cts | `typescript-language-server`                              | `--stdio`                   | `typescript` 包由 server 自己在项目 `node_modules` 找；找不到时 server 自己报错，状态转 `crashed` |
| `rust`                    | rs                            | `rust-analyzer`                                           | 无                          | 根目录无 `Cargo.toml` 时靠 `initializationOptions.linkedProjects`（用户在设置里填）               |
| `go`                      | go go.mod                     | `gopls`                                                   | 无                          | 继承执行主机登录环境的 `GOPATH`/`GOFLAGS`                                                         |
| `python`                  | py pyi                        | `pyright-langserver` → `basedpyright-langserver` → `ruff` | `--stdio`；ruff 为 `server` | 退到 ruff 时能力只有诊断、格式化、代码操作，`features` 如实缩小                                   |
| `json`                    | json jsonc                    | `vscode-json-language-server`                             | `--stdio`                   |                                                                                                   |
| `yaml`                    | yaml yml                      | `yaml-language-server`                                    | `--stdio`                   |                                                                                                   |
| `markdown`                | md markdown                   | `marksman`                                                | `server`                    | 只做链接/标题补全与定义；预览仍走 `react-markdown`                                                |

候选表是 `apps/runtime/src/language/registry.rs` 里的静态常量；用户可在设置 `language.servers[<serverId>]` 覆盖 `path`/`args`/`enabled`/`initializationOptions`/`settings`。设置里不提供「安装」按钮，缺失时的文案只说明缺什么（`server_not_found` / `server_probe_failed` / `execution_not_granted` / `disabled` / `language_unknown`）。

### 1.3 生命周期

| 事件                                     | 行为                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 第一个该语言文档在某执行主机被打开       | 为（执行主机, 工作空间, serverId）拉起 server：cwd = 工作空间根，`rootUri`/`workspaceFolders` 只有这一个根；`initialize` → `initialized` → 重放该主机所有影子文档的 `didOpen`        |
| 最后一个文档关闭后空闲 `idleStopSeconds` | 默认 600 s；发送 `shutdown` → `exit`，5 s 不退出则结束进程组；状态 `idle_stopped`，会话保留，下一次 didOpen 重新拉起。影子文档表不清空，所以重启只是重新 `initialize` + 重放 didOpen |
| server 异常退出                          | 状态 `crashed`，10 分钟内最多重启 3 次（1 s / 5 s / 20 s 退避）；超出则停在 `crashed`，附 stderr 尾部 4 KiB（经 `security::redact_secrets`），设置页与状态栏提供「重启」             |
| 超过资源上限（§3.3）                     | 状态 `stopped`，reason `resource_exhausted`，不自动重启                                                                                                                              |
| 工作空间失去 execute 或 read 授权        | 立即 `shutdown`/`exit`，会话状态 `unsupported / execution_not_granted`；Web 移除全部诊断                                                                                             |
| 工作空间删除、远端主机断开、Runtime 退出 | 结束 server 进程组；远端 link 断开时远端 Worker 自己按「控制端消失」（stdio EOF）结束其 server                                                                                       |
| 设置改变（路径、禁用）                   | 受影响的 server 走「重启」路径，先 `shutdown` 再按新配置探测                                                                                                                         |

## 2. 架构

### 2.1 分层

```text
EditorNode ─┐  apps/web/src/editor/language/     Runtime（控制端）                        执行主机
EditorNode ─┼─ LanguageClient ── WS(JSON-RPC 文本帧) ── language::routes ── LanguageLink ── language::Manager ── Server(stdio JSON-RPC)
ProblemsPanel┘ (@codemirror/lsp-client)              │                  │ local: 进程内通道             ├── Session(会话 A)
                                                     │                  └ remote: ssh worker --language-link ├── Session(会话 B)
   设置页 → GET language-service ─────────────────── language::discover / 远端 LanguageCapabilities         └── Documents(影子文本, 版本)
```

- **Web**：一个工作空间、一种语言一个 `LanguageClient`（`@codemirror/lsp-client` 的 `LSPClient` + 自定义 `Transport`）；多个编辑器节点共用它。Web 不知道绝对路径，也不知道 server 在哪台机器。
- **Runtime（控制端）**：`language::routes` 提供 HTTP/WS；`LanguageLink` 抽象「到执行主机的全双工帧通道」，本机实现是进程内通道，远端实现是 `remote/language.rs` 持有的第二条 ssh 连接。控制端不解析 LSP 语义，只做会话 ↔ link 的路由与权限位传递。
- **执行主机（`language::Manager`）**：真正的 LSP 客户端。持有 server 进程、影子文档、会话表、方法白名单、uri 改写和 `WorkspaceEdit` 应用。本机工作空间时它就在 Runtime 进程里，远端时在远端 Worker 进程里——**同一份代码，两条路径经过同一组测试**。

### 2.2 执行主机侧：进程管理与多路复用

| 部件        | 职责                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`    | 一个 server 进程：spawn（无 shell、cwd = root、环境剥离 `ARMADRA_*` 与 hook 端点变量、unix `setsid` / Windows 复用命令 Worker 的 Job Object）、`Content-Length` 编解码、请求 id → 发起会话映射、`initialize` 结果缓存、stderr 环形缓冲 64 KiB、退出监测                                                                                                                                                                 |
| `documents` | 每个 uri 一份影子文本：`text`、LSP `version`（执行主机单调递增）、`refcount`（几个会话打开）、`sha256`；接受会话送来的增量/全文变更，应用到影子文本后再以执行主机版本号转发给 server。多会话同 uri：第一个会话 `didOpen`，其余只增引用；只有「拥有者」会话的 didChange 被采纳（§2.5）                                                                                                                                   |
| `session`   | 一个 Web 连接的视角：代答 `initialize`/`initialized`/`shutdown`；JSON-RPC id 加会话命名空间（`<sessionSeq>:<clientId>`），防止两个会话 id 撞车与跨会话 `$/cancelRequest`；在飞请求上限 32，超出直接回 `-32803 RequestFailed`；单请求 30 s 超时                                                                                                                                                                          |
| `mux`       | 会话 → server：按白名单与授权位过滤后转发；server → 会话：响应按 id 映射回发起会话，`publishDiagnostics` 广播给该 server 的所有会话，`$/progress` 转成 `LanguageSessionStatus.progress`；server → 客户端请求（`workspace/configuration`、`client/registerCapability`、`window/workDoneProgress/create`、`workspace/applyEdit`）由 `Manager` 自己应答，不到 Web                                                          |
| `uri`       | 双向改写。Web ↔ 执行主机：`armadra:///<rel>` ↔ `file://<canonicalRoot>/<rel>`；改写只走已知字段（`textDocument.uri`、`Location[]`、`LocationLink`、`WorkspaceEdit.changes`/`documentChanges`、`DiagnosticRelatedInformation.location`、`WorkspaceSymbol.location`）；根之外的 `file:` 转成 `armadra-external:///<不透明 id>`，其它 scheme 原样透传。改写规则有独立 fixture 测试：漏一个字段就是绝对路径泄漏或导航失效 |
| `policy`    | 方法 → 所需授权（§3.1 表）；未知方法与 `workspace/executeCommand` 拒绝（JSON-RPC `-32601`）                                                                                                                                                                                                                                                                                                                             |
| `lifecycle` | 空闲计时、重启预算、资源采样（pid + startTime 进入资源面板 `components`，kind `languageServer`）、Runtime 退出时统一结束                                                                                                                                                                                                                                                                                                |
| `edits`     | `WorkspaceEdit` 校验（全部路径在根内、每个文件带 `expectedSha256`、单文件 ≤ 2 MiB、文件数 ≤ 50）与逐文件写入（复用 `files::write_text_file`），每写一个就发布 `file.changed`（绕过自保存抑制，让干净的编辑器按既有规则自动重载）                                                                                                                                                                                        |

### 2.3 与文件内容版本、外部变更的协调

编辑器已有的保护不变：保存带 `expectedSha256`，冲突 409；`file-watch` 推 `file.changed`（[编辑器设计 §3](./editor-browser-design.md)）。LSP 只增加以下约定：

| 时机                            | 顺序                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 打开文本文件                    | `readFile` 成功且 `sha256` 存在（即 UTF-8、可给版本）→ 会话 `didOpen`（全文）。非 UTF-8 / 超过 1 MiB 的文件不开语言会话，状态栏显示「LSP 不适用」                                                                                         |
| 编辑                            | CodeMirror 变更去抖 150 ms 后 `didChange`（增量，`@codemirror/lsp-client` 生成）；执行主机应用到影子文本并递增自己的版本号                                                                                                                |
| 保存                            | 若 `formatOnSave` 开：先 `textDocument/formatting`（3 s 超时，超时就跳过并提示）→ 编辑器应用到草稿 → `PUT file`（带 `expectedSha256`）→ 成功后 `didSave`；server 要求 `includeText` 时执行主机从影子文本填入。保存失败（409）不发 didSave |
| `file.changed` 且无草稿         | 编辑器按现状自动重载 → 触发一次全文 `didChange`（version +1）。server 未打开的文件由 server 自己读磁盘，不需要通知                                                                                                                        |
| `file.changed` 且有草稿         | 现状：非模态提示条。语言会话不动——影子文本仍是草稿，这与 LSP「打开文档由客户端拥有」一致；用户选「重载」后再走上一行                                                                                                                      |
| 重命名（`file-entries/rename`） | 编辑器节点路径跟随（现状）→ Web 发 `didClose(旧 uri)` + `didOpen(新 uri)`；执行主机若 server 注册了 `workspace/didRenameFiles` 再补一条通知                                                                                               |
| 删除                            | 编辑器转 create-only 草稿（现状）；语言会话保持打开（server 只看影子文本）；用户关闭节点时 `didClose`                                                                                                                                     |
| 保存竞态                        | `WorkspaceEdit` 应用（§2.6）要求受影响的已打开文档**干净**，否则拒绝并列出需要先保存的文件；应用后通过 `file.changed` 让编辑器重载。执行主机写入时逐文件核对 `expectedSha256`，不符即停在该文件并报告已应用 / 失败列表                    |

### 2.4 Web 侧 CodeMirror 6 客户端选型

| 方案                                        | 依赖与体积                                                                                                                                               | 多文件 / 传输                                                                                                                                               | 判断                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@codemirror/lsp-client`（CodeMirror 官方） | 只依赖 `@codemirror/{state,view,language,autocomplete,lint}`；LSP 类型来自 `vscode-languageserver-protocol`（需实测是否只被当作类型、能否被 tree-shake） | `Transport { send(string); subscribe/unsubscribe }` 自定义；`Workspace` 按 uri 管理多个 `EditorView`，自带补全、hover、诊断（lint）、重命名、定义、签名帮助 | **采用**。与已用的 autocomplete/lint 同一作者与版本线，传输层正好套在我们的会话 WS 上                               |
| `codemirror-languageserver`（社区）         | 引入 `vscode-jsonrpc` + `vscode-languageserver-protocol` 运行时                                                                                          | 一个插件一个文件、只支持 WebSocket 直连 server                                                                                                              | 不采用：与「Web 不直连 server」冲突，且体积更大                                                                     |
| 自研薄客户端                                | 0 新依赖，约 600 行                                                                                                                                      | 全部自己写                                                                                                                                                  | **备选**。只在官方包 gzip 后 chunk > 150 kB、或其 `Workspace` 无法接受「同一 uri 只由拥有者视图发 didChange」时启用 |

判定在批次 C 的第一天完成：`pnpm --filter @armadra/web build` 后看 `dist/assets/language-*.js` 的 gzip 体积；两条标准任一不满足即切备选，并把结论写回本文。无论哪种，LSP 代码与 CodeMirror 内核一样只在编辑器节点里动态 `import()`（编辑器已有 §17 代码分割约束）。

传输：一个会话一条 WebSocket `GET /api/workspaces/{id}/language/sessions/{sessionId}/stream`，文本帧 = 一条 JSON-RPC 消息；鉴权与工作空间事件 WS 相同。现有工作空间事件 WS 是单向推送（`apps/web/src/api/events.ts` 不向上发送），所以不复用它。会话状态（`language.session`）仍经工作空间事件流推送，供状态栏与设置页使用而不必打开会话 WS。

### 2.5 多编辑器节点与同一文档

`open-editor.ts` 已经「同一路径复用已有编辑器」，第二个视图是用户主动创建的少数情况。首版规则：

- 一个 uri 的语言「拥有者」是第一个打开它的编辑器节点；只有拥有者的编辑产生 `didChange`。
- 第二个节点得到诊断、hover、定义（只读请求带自己视图的位置即可），状态栏显示「LSP 跟随另一节点」；它的编辑不进 LSP（草稿本来也不共享，见编辑器设计 §3 未实现项）。
- 拥有者关闭时，若还有其它节点打开同一路径，所有权转给最早的那个并发一次全文 `didChange`。

### 2.6 `WorkspaceEdit` 预览与应用

1. Web 收到 rename / codeAction / formatting 的 `WorkspaceEdit`（uri 已改写成相对路径）。单文件且是当前文档的格式化直接应用到草稿，不走预览。
2. `edit-preview.ts` 生成预览：文件列表、每文件 `unifiedLineDiff`、当前已知的内容版本（打开的文档取编辑器版本；未打开的由执行主机在应用时读取）。存在 `armadra-external:` 路径或未打开且不可写的路径 → 该项标 blocked，整个编辑不可应用。
3. 用户确认 → `POST …/language/sessions/{sessionId}/edits`，执行主机逐文件 `write_text_file(expectedSha256)`，返回 `applied[] / failed[]`。
4. 已打开的文件靠 `file.changed` 自动重载（它们必须是干净的）；失败列表在对话框里保留，用户可重新计算（再发一次 rename）。
5. server 主动的 `workspace/applyEdit`（部分 codeAction 走这条）在执行主机侧转成同样的预览流程，等待用户 60 s，超时或拒绝回 `applied: false`。

### 2.7 远端 Worker：经 stdio 协议代理

现有远端连接（`remote/client.rs`）是**严格串行**的请求—应答通道，被一个互斥量保护并兼作 Git 队列；LSP 需要 server 主动推送（诊断、进度）且不能让一次补全阻塞文件读写。因此：

- 远端每台主机在有语言会话时再开**第二条** ssh 连接：`ssh … <worker> worker --stdio --language-link [--state-dir …]`，启动行、路径校验、`ARMADRA_REMOTE_WORKER_LAUNCHER` 覆盖、握手（`runtime_version` 完全一致、能力含 `language.link.v1`）与现有连接完全相同。
- 握手之后该连接放弃「一问一答」：双方都可随时写 `WorkerRequest{language_frame}` / `WorkerResponse{language_frame}`，`request_id` 为空表示无人等待；帧上限仍是 1 MiB，单条 LSP 消息上限 960 KiB，超出的响应在执行主机侧替换为 `-32803` 错误并注明「结果过大」。
- 流控沿用 `StreamAck` 语义：`LanguageAck.received_through` + `available_credit_bytes`，每方向 4 MiB 未确认预算，超出则暂停读取 server 输出（server 自己会阻塞在 stdout，不丢消息）。
- 会话开关、能力探测、`WorkspaceEdit` 应用仍走原来的串行连接（它们是请求—应答，且需要 `allow_write/allow_execute` 与现有 `WorkerServiceRequest` 一样由控制端解析、执行主机复核）。
- link 断开：控制端把该主机所有会话置为 `disconnected`，Web 清空诊断并显示状态；重连后按 §1.3 重放 didOpen。已发出未应答的请求按 `UNKNOWN_OUTCOME` 处理（只影响 rename/apply 这类写；读请求由客户端超时重试）。
- 空闲：远端 link 在该主机所有 server 都 `idle_stopped` 或无会话 5 分钟后关闭，避免长期占用一条 ssh 会话（sshd `MaxSessions` 默认 10）。

### 2.8 协议：`proto/armadra/v1/language.proto`

字段号规划（枚举 0 恒为 UNSPECIFIED，删除即 `reserved`，`optional` 只用于「未传 ≠ 零值」）：

```proto
syntax = "proto3";
package armadra.v1;
option go_package = "armadra.local/host/gen/armadra/v1";

enum LanguageServerState {
  LANGUAGE_SERVER_STATE_UNSPECIFIED = 0;
  LANGUAGE_SERVER_STATE_AVAILABLE = 1;     // 探测到，未启动
  LANGUAGE_SERVER_STATE_UNSUPPORTED = 2;   // reason 说明缺什么
  LANGUAGE_SERVER_STATE_STARTING = 3;
  LANGUAGE_SERVER_STATE_RUNNING = 4;
  LANGUAGE_SERVER_STATE_IDLE_STOPPED = 5;
  LANGUAGE_SERVER_STATE_CRASHED = 6;
  LANGUAGE_SERVER_STATE_STOPPED = 7;       // 用户停止或资源上限
  LANGUAGE_SERVER_STATE_DISCONNECTED = 8;  // 远端 link 断开
}
enum LanguageFeature {
  LANGUAGE_FEATURE_UNSPECIFIED = 0;     LANGUAGE_FEATURE_COMPLETION = 1;
  LANGUAGE_FEATURE_DIAGNOSTICS = 2;     LANGUAGE_FEATURE_HOVER = 3;
  LANGUAGE_FEATURE_DEFINITION = 4;      LANGUAGE_FEATURE_REFERENCES = 5;
  LANGUAGE_FEATURE_RENAME = 6;          LANGUAGE_FEATURE_FORMATTING = 7;
  LANGUAGE_FEATURE_DOCUMENT_SYMBOL = 8; LANGUAGE_FEATURE_WORKSPACE_SYMBOL = 9;
  LANGUAGE_FEATURE_CODE_ACTION = 10;    LANGUAGE_FEATURE_SIGNATURE_HELP = 11;
}
enum LanguageMessageKind {
  LANGUAGE_MESSAGE_KIND_UNSPECIFIED = 0; LANGUAGE_MESSAGE_KIND_REQUEST = 1;
  LANGUAGE_MESSAGE_KIND_RESPONSE = 2;    LANGUAGE_MESSAGE_KIND_NOTIFICATION = 3;
}

// 能力探测（串行连接）
message LanguageCapabilitiesRequest { string root_id = 1; bool refresh = 2; }
message LanguageServerDescriptor {
  string server_id = 1;                // "rust-analyzer"
  string language_id = 2;              // "rust"
  repeated string file_extensions = 3;
  string executable = 4;               // 执行主机上的绝对路径；未发现为空
  string version = 5;
  LanguageServerState state = 6;
  string reason = 7;                   // 稳定 reason key，可本地化
  repeated LanguageFeature features = 8;
  uint32 restart_count = 9;
  optional int64 pid = 10;             // 与 resources.proto 一样：pid + start_time 才是身份
  optional int64 start_time_unix_ms = 11;
  uint32 open_documents = 12;
  int64 probed_at_unix_ms = 13;
}
message LanguageCapabilities {
  string execution_host_id = 1;
  repeated LanguageServerDescriptor servers = 2;
  uint32 max_document_bytes = 3;       // 1 MiB
  uint32 max_sessions = 4;             // 每执行主机 32
  uint32 max_message_bytes = 5;        // 960 KiB
}

// 会话（串行连接）
message OpenLanguageSessionRequest {
  string root_id = 1; string workspace_id = 2; string session_id = 3;
  string language_id = 4; string client_id = 5;
  bool allow_write = 6; bool allow_execute = 7;   // 控制端解析，执行主机复核
  bytes client_capabilities_json = 8;             // 取交集后代答 initialize
}
message LanguageSession {
  string session_id = 1; string server_id = 2; uint64 generation = 3;
  LanguageServerState state = 4; string reason = 5;
  bytes server_capabilities_json = 6;             // server 的 InitializeResult.capabilities
}
message CloseLanguageSessionRequest { string session_id = 1; string reason = 2; }

// 消息信封（language-link 全双工连接；本机为进程内通道）
message LanguageMessage {
  string session_id = 1;
  uint64 sequence = 2;                 // 每方向单调递增，用于 ack
  LanguageMessageKind kind = 3;
  string method = 4;                   // 响应填原请求的 method；路由与日志只看这里
  string request_id = 5;               // JSON-RPC id 的字符串形式；通知为空
  bytes payload_json = 6;              // 完整 JSON-RPC 消息，uri 已按方向改写
}
message LanguageSessionStatus {
  string session_id = 1; uint64 generation = 2;
  LanguageServerState state = 3; string reason = 4; uint32 restart_count = 5;
  optional uint32 progress_percent = 6; string progress_title = 7;
}
message LanguageAck { string session_id = 1; uint64 received_through = 2; uint32 available_credit_bytes = 3; }
message LanguageFrame {
  string link_epoch = 1;               // 每次 link 建立生成；旧 epoch 的帧丢弃
  oneof payload {
    LanguageMessage message = 10;
    LanguageSessionStatus status = 11;
    LanguageAck ack = 12;
  }
}

// WorkspaceEdit 应用（串行连接）
message LanguageApplyEditRequest {
  string root_id = 1; string session_id = 2;
  bytes workspace_edit_json = 3;               // uri 为 armadra:///<rel>
  map<string, string> expected_sha256 = 4;     // 相对路径 → 版本；缺项表示「必须不存在」
  bool allow_write = 5;
}
message LanguageAppliedFile { string path = 1; string sha256 = 2; uint64 size = 3; }
message LanguageFailedFile { string path = 1; string code = 2; string message = 3; }
message LanguageApplyEditResult { repeated LanguageAppliedFile applied = 1; repeated LanguageFailedFile failed = 2; }
```

`worker.proto` 追加（现有 oneof 最大编号 23；24–29 已划给业务域，语言服务从 30 起）：

| 消息                               | 新分支                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerRequest.action`             | `LanguageCapabilitiesRequest language_capabilities = 30; OpenLanguageSessionRequest open_language_session = 31; CloseLanguageSessionRequest close_language_session = 32; LanguageFrame language_frame = 33; LanguageApplyEditRequest language_apply_edit = 34;` |
| `WorkerResponse.result`            | `LanguageCapabilities language_capabilities = 30; LanguageSession language_session = 31; LanguageFrame language_frame = 32; LanguageApplyEditResult language_apply_edit = 33;`（关闭会话应答 `language_session`，state = STOPPED）                              |
| `WorkerHelloResponse.capabilities` | 串行连接声明 `language.v1`（能探测与开会话）；`--language-link` 连接声明 `language.link.v1`                                                                                                                                                                     |
| `resources.proto`                  | `PLATFORM_COMPONENT_KIND_LANGUAGE_SERVER = 6`，`PlatformComponentMetrics` 不加字段，`name` 为可执行文件名                                                                                                                                                       |

按 [proto/README.md](../../proto/README.md) 的规则每个 `.proto` 至少一个 `proto/fixtures/*.hex` 与三端契约测试：`language_capabilities.hex`（含 UNSUPPORTED + reason、`optional pid` 缺席）、`language_session.hex`、`language_frame_message.hex`（payload 含中文与 emoji）、`language_frame_ack.hex`、`language_apply_edit.hex`（map 字段）。

### 2.9 Runtime ↔ Web 接口（camelCase JSON；错误 `{ code, message }`）

| 接口                                                      | 内容                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/{id}/language-service`               | 现有探测接口**加宽**：`{ status: "available" \| "unavailable", reason?, executionHostId, servers: LanguageServerDescriptor[] }`；`?refresh=1` 重新探测。未授权 execute 时 `unavailable / execution_not_granted`，servers 仍列出但都是 `unsupported` |
| `POST /api/workspaces/{id}/language/sessions`             | `{ languageId, clientId, clientCapabilities }` → `{ sessionId, generation, serverId, state, serverCapabilities }`；语言无 server 时 `UNSUPPORTED`                                                                                                   |
| `DELETE …/language/sessions/{sessionId}`                  | 关闭；影子文档引用减一                                                                                                                                                                                                                              |
| `GET …/language/sessions/{sessionId}/stream`（WebSocket） | 文本帧 = JSON-RPC；控制端只做转发                                                                                                                                                                                                                   |
| `POST …/language/sessions/{sessionId}/edits`              | `{ edit, expectedSha256: { [path]: sha } }` → `{ applied: [{ path, sha256, size }], failed: [{ path, code, message }] }`                                                                                                                            |
| `POST …/language/servers/{serverId}/restart`、`…/stop`    | 手动重启 / 停止（停止后状态 `stopped / user`，直到再次重启）                                                                                                                                                                                        |
| 事件 `language.session`                                   | `{ workspaceId, sessionId, serverId, generation, state, reason?, restartCount, progress? }`                                                                                                                                                         |
| 事件 `language.server`                                    | `{ workspaceId, executionHostId, server: LanguageServerDescriptor }`，探测与状态变化时推送，设置页据此刷新                                                                                                                                          |

`packages/shared` 的 `languageServiceStatusSchema` 与 `domain.ts` 的 `languageServiceSchema` 从 `z.literal("unavailable")` 加宽为枚举；`editorNodeDataSchema.languageService` 继续只存状态摘要，不存诊断。

## 3. 安全与资源

### 3.1 权限门

| 工作空间授权    | 允许的 LSP 动作                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 无 execute      | 什么都不启动。探测仍可运行（`--version` 是 Runtime 自己的固定命令，不是项目代码）但结果标 `execution_not_granted`                                                                                                                                                                                                                                                  |
| execute         | 启动 server；`initialize/initialized/shutdown/exit`（代答）、`didOpen/didChange/didClose/didSave`（影子文本，不落盘）、`completion`、`completionItem/resolve`、`hover`、`signatureHelp`、`definition/typeDefinition/implementation/references`、`documentSymbol`、`workspace/symbol`、`documentHighlight`、`codeAction`（只读取）、`$/cancelRequest`、`$/progress` |
| execute + write | 以上加 `formatting/rangeFormatting`（编辑器无 write 本就只读，保持一致）、`prepareRename/rename`、`codeAction/resolve`、`POST …/edits`、server 的 `workspace/applyEdit`                                                                                                                                                                                            |
| 任何情况拒绝    | `workspace/executeCommand`、带 `command` 的 codeAction、`window/showDocument` 指向根外、未知方法、非本会话 id 的 `$/cancelRequest`。拒绝在执行主机侧（`policy.rs`）而不只是控制端，与 `WorkerServiceRequest` 的「执行主机复核」一致                                                                                                                                |

授权变化经现有工作空间设置流触发 §1.3 的关停；`allow_write/allow_execute` 由控制端从 `workspace.permissions` 解析后随 `OpenLanguageSessionRequest` 下发，会话生命周期内固定，变化即关会话。

### 3.2 进程隔离

- 无 shell、无用户 argv 拼接：可执行文件用探测时冻结的绝对路径，参数来自注册表或设置里的数组。
- 环境：继承执行主机登录环境（server 需要 `PATH`、`GOPATH`、`CARGO_HOME`），但剥离 `ARMADRA_*` 与 hook 端点相关变量——server 不得拿到 Runtime 凭据。
- 进程组：unix `setsid` 后 `kill(-pgid)`；Windows 复用 `command/platform_windows.rs` 的 Job Object，`containment_ready()` 为假时语言服务在 Windows 上 `unsupported / containment_unavailable`。
- server 读写范围是操作系统层的：它以用户身份运行，本来就能读整台机器。设计不假装沙箱，而是把「启动 server = 执行项目代码」放在 execute 门后并在设置页写明。

### 3.3 资源上限

| 项                   | 默认                                      | 超限行为                                                                        |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| 每执行主机 server 数 | 6（`language.maxServers`）                | 新语言 `unsupported / too_many_servers`，设置页可停掉别的                       |
| 每执行主机会话数     | 32                                        | `RESOURCE_EXHAUSTED`                                                            |
| 单 server RSS        | 4 GiB（`language.maxRssBytes`，0 = 不限） | 采样连续 3 次超限 → `shutdown`，状态 `stopped / resource_exhausted`，不自动重启 |
| 单文档               | 1 MiB（与编辑器一致）                     | 不开会话                                                                        |
| 单消息               | 960 KiB                                   | 请求拒绝 / 响应替换为错误                                                       |
| 在飞请求 / 会话      | 32                                        | `-32803`                                                                        |
| 单请求               | 30 s                                      | 超时错误，向 server 发 `$/cancelRequest`                                        |
| 空闲                 | 600 s                                     | `idle_stopped`                                                                  |
| stderr 缓冲          | 64 KiB 环形                               | 只保留尾部                                                                      |
| 远端 link 未确认预算 | 每方向 4 MiB                              | 暂停读取                                                                        |

与资源面板：server 作为平台组件 `languageServer` 出现在 `resource.sample.components`（[终端宿主设计 §8](./terminal-host-design.md)），带 pid + startTime、RSS、CPU；面板可从该行「停止」。与防休眠：语言服务**不申请** `power` 租约——它是交互式服务，不阻止睡眠；机器唤醒后 server 若已死走 `crashed` 重启预算。

### 3.4 日志与隐私

- `tracing` 只记 `sessionId`、`serverId`、`method`、JSON-RPC id、字节数、耗时、状态迁移；**任何层都不写 `payload_json`**（它含文件正文、补全文本与路径）。debug 级也不例外。
- stderr 尾部经 `security::redact_secrets` 后只在内存里，随 `language.server` 事件给设置页；不进 `board-log.jsonl`，不进数据库。
- Web 端 `console` 不打印消息正文；`@codemirror/lsp-client` 若有调试输出在生产构建关闭。
- 数据库不新增表：会话、影子文档都是进程内状态；探测缓存与 `agents.probes` 一样落在 `settings.language.probes[<hostId>][<serverId>]`。

## 4. 代码布局

约束：单文件 ≤ 800 行，测试与实现分文件，一级包按组件拆分（[仓库结构 §3.1](./repository-structure.md)）。`api.rs` 已 5.7k 行，语言服务路由不进它。

### 4.1 Rust：`apps/runtime/src/language/`

| 文件           | 行数预算 | 内容                                                                                                                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mod.rs`       | ≤ 150    | `pub` 类型、`Manager` 句柄、reason key 常量、错误映射                                                                                                                     |
| `registry.rs`  | ≤ 200    | §1.2 静态表；`language_id_for(path)`；与 `EditorNode.loadLanguage` 的扩展名表保持一致（契约测试比对）                                                                     |
| `discover.rs`  | ≤ 300    | PATH 查找、设置覆盖、`--version` 探测、24 h 缓存、`LanguageServerDescriptor` 生成                                                                                         |
| `jsonrpc.rs`   | ≤ 250    | `Content-Length` 编解码、消息分类（request/response/notification）、id 命名空间改写                                                                                       |
| `server.rs`    | ≤ 500    | 进程 spawn/退出、读写任务、`initialize` 缓存、stderr 环形、在飞请求表、`shutdown/exit`                                                                                    |
| `documents.rs` | ≤ 300    | 影子文档：全文/增量应用、版本、引用、sha256、拥有者会话                                                                                                                   |
| `session.rs`   | ≤ 400    | 会话：代答 initialize、id 命名空间、在飞上限、超时、cancel                                                                                                                |
| `mux.rs`       | ≤ 500    | server ↔ 会话路由、广播、server→客户端请求代答、进度转状态                                                                                                               |
| `uri.rs`       | ≤ 300    | 双向改写与 external 映射                                                                                                                                                  |
| `policy.rs`    | ≤ 150    | 方法 → 授权表、拒绝错误                                                                                                                                                   |
| `edits.rs`     | ≤ 300    | `WorkspaceEdit` 校验与逐文件写入、`file.changed` 发布                                                                                                                     |
| `lifecycle.rs` | ≤ 300    | 空闲计时、重启预算、资源采样接入、退出清理                                                                                                                                |
| `link.rs`      | ≤ 150    | `LanguageLink` trait（`send(LanguageFrame)` / `recv()` / `epoch()`）与进程内实现                                                                                          |
| `routes.rs`    | ≤ 400    | axum 处理器：探测、会话开关、WS stream、edits、restart/stop；在 `lib.rs` 注册                                                                                             |
| `tests/`       | —        | `mod tests;` 下分 `jsonrpc.rs`、`documents.rs`、`uri.rs`、`policy.rs`、`mux.rs`（mock server 进程）、`lifecycle.rs`（崩溃/空闲用 mock 的 `--crash-after`、`--hang` 开关） |

其它位置：`remote/language.rs`（≤ 400，远端 link 客户端：第二条 ssh 连接、握手、epoch、ack 流控、断线状态）；`worker/language_link.rs`（≤ 250，`--language-link` 服务循环：读任务 + 写任务并发）；`resources/platform.rs` 加 `LanguageServer` 组件；`settings.rs` 加 `LanguageSettings`；`events.rs` 加 `LanguageSession` / `LanguageServer` 两个变体；`apps/runtime/tests/language_real.rs`（真实 server 集成测试，见 §5）。

### 4.2 TypeScript

`apps/web/src/editor/language/`（新一级目录 `editor/`，为后续把 `EditorNode.tsx` 拆出编辑器内核预留）：

| 文件                    | 内容                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.ts`             | `LanguageClient`：按（workspaceId, languageId）复用，会话开关、`@codemirror/lsp-client` 的 `LSPClient` 装配、断线重连（指数退避，上限 5 次）                  |
| `transport.ts`          | `Transport` 实现：WebSocket、发送队列、连接前缓冲、`language.session` 事件联动                                                                                |
| `documents.ts`          | uri（`armadra:///<rel>`）↔ `(workspaceId, path)`；拥有者登记（§2.5）；节点关闭/重命名时的 didClose/didOpen                                                   |
| `extensions.ts`         | 给一个 `EditorView` 生成扩展：lsp 插件、补全源、hover、lint、快捷键（F2 重命名、F12 定义、⇧F12 引用、⇧⌥F 格式化）；作为新的 `Compartment` 热插到 `EditorNode` |
| `language-ids.ts`       | 扩展名 → languageId；`EditorNode.loadLanguage` 改为从这里取 languageId，避免两张表                                                                            |
| `diagnostics-store.ts`  | zustand：uri → Diagnostic[]，问题面板与行槽共用；会话关闭时清空                                                                                               |
| `status-store.ts`       | server / 会话状态，供状态栏、设置页、资源面板                                                                                                                 |
| `edit-preview.ts`       | `WorkspaceEdit` → 预览模型（文件、diff、blocked 原因）；`applyEdit()` 调 `runtimeApi.applyLanguageEdit`                                                       |
| `EditPreviewDialog.tsx` | shadcn `Dialog` + 复用 `DiffNode.PatchBody`                                                                                                                   |
| `ReferencesPanel.tsx`   | 引用/符号列表，复用项目搜索结果行组件                                                                                                                         |
| `LanguageStatus.tsx`    | 状态栏那一格：替换现在写死的 `t("editor.lsp")`，点击展开重启/停止                                                                                             |
| `*.test.ts(x)`          | 与实现同名分文件；`transport.test.ts` 用假 WebSocket，`client.test.ts` 用脚本化的假 server                                                                    |

其它：`apps/web/src/panels/problems/ProblemsPanel.tsx`（侧栏页，按文件分组、点击定位）；`apps/web/src/panels/settings/pages/WorkspacePage.tsx` 的语言服务行改为表格（每语言：状态徽标、版本、可执行路径、重启/停止、「重新探测」）+ 路径覆盖输入；`apps/web/src/api/client.ts` 加 `languageSessions.*`、`applyLanguageEdit`、`restartLanguageServer`；`apps/web/src/i18n/language-service.ts`（现有 `file-workflow.ts` 的 `lsp.*` 键迁入）。

`packages/shared/src/api/language.ts`：`languageServerStateSchema`、`languageFeatureSchema`、`languageServerDescriptorSchema`、`languageServiceStatusSchema`（加宽）、`openLanguageSessionRequest/ResponseSchema`、`applyLanguageEditRequest/ResultSchema`、`languageSessionEventSchema`、`languageServerEventSchema`；`api.ts` 只 re-export（现在 `api.ts` 是单文件，`api/` 目录与它并存合法；将来整体拆分时 `api.ts` → `api/index.ts`）。`domain.ts` 的 `languageServiceSchema.status` 加宽。

## 5. 实施拆解

四个批次可并行；批次间只依赖本文写定的接口形状，不依赖对方代码。协议由批次 A 先落，B/D 在 A 合入前用本文 §2.8 的字段做本地 stub。

本机验证资源（2026-09-06 实测）：`typescript-language-server`、`gopls`、`pyright-langserver` 不存在；`rust-analyzer` 只有 rustup 代理且组件未装（正好覆盖「探测失败」分支）；`ruff 0.16.1` 存在，`ruff server` 是真实 LSP（诊断、格式化、代码操作）。因此真实进程验证用 `ruff server`，其余能力用最小 mock：`tools/probes/mock-lsp.mjs`（仓库级脚本在 `tools/`）（Node ≥ 22 是仓库前置；stdio、`Content-Length` 帧；实现 initialize、didOpen/didChange 后对含 `TODO` 的行推诊断、hover 回当前单词、completion 回固定三项、rename 返回跨两个文件的 `WorkspaceEdit`、主动发 `workspace/configuration`；开关 `--crash-after=N`、`--hang`、`--big-response` 用于生命周期与上限测试）。

| 批次                     | 范围                                                                                                                                                                                                                                                                                                              | 验收命令                                                                                                                                                                                                                                                                                         | 真实进程验证                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 协议与探测             | `language.proto`、`worker.proto`/`resources.proto` 追加、fixtures、三端契约测试；`packages/shared/src/api/language.ts`；Runtime `registry.rs`、`discover.rs`、`settings.rs`、加宽 `GET language-service`（含 execute 门与 `refresh`）；`events.rs` 新变体                                                         | `pnpm protocol:generate && pnpm protocol:check && pnpm protocol:test`；`pnpm --filter @armadra/shared test`；`cargo test -p armadra-runtime language::`；`go -C apps/host test ./...`（生成 Go 可编译）                                                                                          | 在有 `ruff` 的 PATH 下 `curl …/language-service` 返回 python 行 `available` + 版本；`PATH=/usr/bin` 下同一请求全部 `unsupported / server_not_found`；`rust-analyzer` 代理返回 `server_probe_failed` 并带退出码 |
| B Runtime 进程管理与代理 | `jsonrpc`、`server`、`documents`、`session`、`mux`、`uri`、`policy`、`edits`、`lifecycle`、`link`（进程内）、`routes`（会话、WS、edits、restart）；`lib.rs` 注册                                                                                                                                                  | `cargo test -p armadra-runtime language`（mock 覆盖：两会话同 uri、id 撞车、cancel 只作用本会话、uri 改写全字段、根外路径 external、崩溃 3 次后停、空闲停后 didOpen 重放、大响应替换、write 门拒绝 rename）；`cargo test -p armadra-runtime --test language_real -- --ignored`（有 `ruff` 时跑） | `language_real.rs`：临时目录一个含未使用 `import os` 的 `.py`，开会话 → didOpen → 收到 `publishDiagnostics`（F401）→ `formatting` 返回编辑 → `POST edits` 写盘后 sha 变化并收到 `file.changed`                 |
| C Web 客户端与 UI        | `@codemirror/lsp-client` 引入与体积判定（§2.4）；`editor/language/*`；`EditorNode` 接入（新 `Compartment`、状态栏）；问题面板、引用面板、预览对话框；设置页表格；i18n；`client.ts` API                                                                                                                            | `pnpm --filter @armadra/web test`、`typecheck`；`pnpm --filter @armadra/web build` 后记录 language chunk gzip 体积（≤ 150 kB）；`i18n.test.ts` 中英键一致                                                                                                                                        | 真实浏览器 + 批次 B + mock：输入 `TODO` 出现诊断与问题面板行；hover 显示单词；补全三项；F2 重命名弹预览并写两个文件后两个编辑器自动重载；无 execute 的工作空间状态栏「LSP 未启用（需要执行权限）」且无补全入口 |
| D 远端与测试             | `worker/language_link.rs`（`--language-link`）、`remote/language.rs`、远端会话开关/edits 走串行连接、断线/重连/epoch、ack 流控、资源面板 `languageServer` 组件、Windows containment 门、文档回写（`editor-browser-design.md` §2/§4 实现状态、`feature-roadmap.md` §3.5、`platform-implementation-status.md` E01） | `cargo test -p armadra-runtime remote::language worker::language_link`（`ARMADRA_REMOTE_WORKER_LAUNCHER` 指向一个把本机二进制当远端跑的脚本，复用 H02 的回环测试方式）；`cargo test --workspace`；`pnpm test`；`go -C apps/host test ./...`                                                      | 回环「远端」工作空间 + `ruff server`：诊断经 link 到达浏览器；结束 launcher 进程 → 状态 `disconnected`、诊断清空；恢复后自动重连并重放 didOpen；资源面板出现 `ruff` 组件行并可停止                             |

实施状态 · 批次 A（2026-09-06）：`language.proto`、`worker.proto` oneof 30–34 / 30–33、`resources.proto` 的 `PLATFORM_COMPONENT_KIND_LANGUAGE_SERVER = 6`、五个 `proto/fixtures/language_*.hex` 与三端契约测试（`crates/protocol/tests/contract_language.rs`、`packages/protocol/test/contract-language.test.ts`、`apps/host/gen/armadra/v1/language_contract_test.go`）已落；`packages/shared/src/api/language.ts` 加宽 `languageServiceStatusSchema` 并新增会话 / 编辑 / 事件 schema（原 `api/search.ts` 里的窄版已移走）；Runtime `language/{registry,discover,settings}.rs` 与加宽的 `GET …/language-service`（execute 门、`?refresh=1`、按语言列 available / unsupported+reason+版本）、`events.rs` 的 `language.session` / `language.server` 变体均可用。真实进程验证：本机 `ruff 0.16.1` → python 行 `available` + 版本；无 execute 时同一行降为 `unsupported / execution_not_granted` 且保留路径与版本；rustup 的 `rust-analyzer` 代理 → `server_probe_failed`。

实施状态 · 批次 B（2026-09-06）：`language/{jsonrpc,server,documents,session,mux,uri,policy,edits,lifecycle,link,routes}.rs` 与 §2.9 的 JSON 端点、会话专用 WebSocket 已实现；进程无 shell、剥离 `ARMADRA_*`、unix `setsid` + `killpg`，Windows 走 `command::containment_ready()` 门。资源面板按 manager 记录的 (pid, startTime) 出 `languageServer` 组件行并据此执行 RSS 上限。未做：`workspace/applyEdit` 的服务器主动预览流程（§2.6 第 5 条）当前一律回 `applied: false`；`formatOnSave` 只有设置项，触发在批次 C；远端仍走 `UNSUPPORTED`。验证：`cargo test -p armadra-runtime language`（53 个用例，含 mock 的两会话同 uri、id 撞车、跨会话 cancel、uri 全字段改写、根外 external、崩溃重启重放、空闲停后重启、大响应转 `-32803`、write 门拒绝 rename）与 `cargo test -p armadra-runtime --test language_real -- --ignored`（`ruff server` 真实诊断 F401 → formatting → `POST edits` 落盘并发 `file.changed`）。

批次 B 与 C 的联调点只有一个：会话 WS 上的 JSON-RPC 文本帧与 `armadra:///<rel>` uri。两边都先对 mock 通过，再合起来跑 C 的真实浏览器场景。

## 6. 验收清单与不做的事

### 6.1 验收

| #   | 场景                        | 通过标准                                                                                                                                |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 执行主机无任何 server       | 设置页每语言 `unsupported` + 缺失原因；编辑器状态栏「LSP 不可用」；无补全源                                                             |
| 2   | rustup 代理存在但组件缺失   | `server_probe_failed`，不当作可用                                                                                                       |
| 3   | 无 execute 授权             | 不启动进程（`ps` 验证），reason `execution_not_granted`                                                                                 |
| 4   | 两个节点同一文件            | 只有一个 didOpen；第二个显示「跟随」；关闭拥有者后另一个接管                                                                            |
| 5   | 编辑 → 保存                 | didChange 去抖；保存后 didSave；409 时无 didSave                                                                                        |
| 6   | 外部修改（无草稿 / 有草稿） | 无草稿：重载 + 全文 didChange；有草稿：LSP 不动，提示条照旧                                                                             |
| 7   | 重命名跨文件                | 预览列出全部文件与 diff；有脏文件时阻止并列出；应用后 sha 校验、编辑器重载                                                              |
| 8   | server 崩溃 / 挂起 / 大响应 | 3 次后停止并显示 stderr 尾部；挂起请求 30 s 超时；大响应转错误                                                                          |
| 9   | 空闲 10 分钟                | 进程退出；再打开文件透明重启，诊断重新出现                                                                                              |
| 10  | 远端工作空间                | 第二条 ssh 连接只在有会话时存在；断线状态与重连；Web 从未收到绝对路径（抓包 grep `file://` 为 0）                                       |
| 11  | 资源面板                    | server 行有 pid/startTime/RSS；停止按钮生效                                                                                             |
| 12  | 日志                        | `RUST_LOG=debug` 全程跑完 1–10 后，日志 grep 文件正文片段为 0                                                                           |
| 13  | 体积                        | language chunk gzip ≤ 150 kB；未打开编辑器不加载                                                                                        |
| 14  | 回归                        | `pnpm test`、`cargo test --workspace`、`go -C apps/host test ./...`、`pnpm protocol:check`、`pnpm --filter @armadra/web typecheck` 全绿 |

### 6.2 不做

- 不自动下载、安装、更新任何 language server；不执行 `npm i -g` / `rustup component add` / `go install` 之类的命令，也不生成「一键安装」按钮。
- 不做 AI 补全、不把 Agent 会话接进补全源；LSP 建议是资料，不获得任何应用 RPC 权限（编辑器设计 §4）。
- 不开放 `workspace/executeCommand` 与带命令的代码操作；不开放任意 JSON-RPC 透传。
- 不做 semanticTokens、inlayHint、callHierarchy、pull diagnostics、多根工作区、工作空间之外文件的打开、同一语言多 server 并行、每文件类型的 UI 级配置。
- 不把语言服务迁到 Go Host：它是执行层能力，随 `apps/runtime` → `apps/worker` 一起走（[仓库结构 §5](./repository-structure.md) 第 7 步）。
- 不承诺 Windows 实机：Job Object 门与 T01 一样只交叉编译验证，未验证前设置页如实显示。
