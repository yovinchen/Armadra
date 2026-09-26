# 浏览器节点的 Agent 工具

状态：已实施（2026-09，typescript-core-status §52）。本文是 `armadra-hook browser <动词>` 的设计；[编辑器与浏览器](editor-browser-design.md)里「受控浏览器」的动作表与引用规则以本文为准。

## 1. 目标与边界

画布上的 Agent 通过连线驱动一个浏览器节点：读页面、点、填表、等、截图，并能看控制台与请求。设计要求它达到给大模型用的浏览器自动化工具的成熟度，同时不放松原有的三条安全底线：

- **不执行任意 JS。** `Runtime.evaluate` 及其同类不在白名单里；页面侧只运行冻结脚本表里的几段只读脚本（一段例外见 §5）。
- **字段只说已填或空，从不给内容。** 密码框同样。
- **只拿元数据。** 请求记录里没有请求体、响应体和任何头；地址里名字像凭据的查询参数被抹掉。

授权链不变：节点令牌 → 连线 → 同工作空间 → 控制租约 → CDP 白名单（按参数校验）。

## 2. 动词清单是唯一来源

动词、参数与一句话说明集中在 `apps/desktop/src/core/browser/verb-spec.ts`（`args.ts` 转出）。读它的地方：

- `armadra-hook --help` 的浏览器段由 `browserUsage()` 生成；
- 技能正文的浏览器动词表（`BROWSER_VERB_SPECS`，中文说明 `helpZh`，注意事项 `BROWSER_NOTES_ZH`）；
- core 的 `VERBS`、桌面壳 drive 通道的 `DRIVE_VERBS`、hook 客户端的 `BROWSER_VERBS`。

`verb-spec.test.ts` 核对清单与实现：每个参数都被 `shellArgs` 转发；help 点名的错误码都存在；按键都被白名单放行；`read --mode`、`navigate --action`、`scroll --direction` 列出的每个值都真的有效。旧的手写 help 与实现有八处对不上（ref 格式、两个不存在的错误码、两种没实现的读法、白名单外的按键、三个没转发的参数、落进 goto 的 `stop`、往下滚的「向左」），现在都由这组测试守住。

| 动词                                                          | 要点                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `read`                                                        | 缺省 `snapshot`；另有 `text`、`links`、`title`、`console`、`network`；`elements` 等于 `snapshot --interactive` |
| `click` / `hover`                                             | 目标见 §4；`--double`                                                                                          |
| `drag --from --to`                                            | 引用或 CSS 选择器                                                                                              |
| `type` / `fill --field 引用=值`                               | 不给目标时打进当前焦点；`fill` 按元素类型处理文本框、复选框、下拉                                              |
| `select`                                                      | 原生下拉、combobox、listbox                                                                                    |
| `press --key`                                                 | 命名键、F1–F12、组合键（§6）                                                                                   |
| `scroll`                                                      | 上下左右、到顶到底，或把目标滚进可视区域                                                                       |
| `wait`                                                        | `--text`、`--text-gone`、`--idle`、`--selector`、地址、标题；最长 30 秒                                        |
| `capture` / `pdf`                                             | 视口、整页（`captureBeyondViewport`）、元素截图；PDF 写进工作区                                                |
| `resize`                                                      | 200–3840 × 200–2160，`--reset` 复原                                                                            |
| `upload` / `download` / `tabs` / `close` / `dialog` / `lease` | 与原先相同                                                                                                     |

每个动词都认 `--node`、`--tab`；改页面的动作认 `--snapshot`。

## 3. 快照

`read --mode snapshot` 用 `Accessibility.getFullAXTree` 逐个文档读无障碍树，一行一个东西：

```
- heading "注册" [level=1]
- textbox "邮箱" [ref=e1] [required] [empty]
- combobox "城市" [ref=e4] [value="北京"] [options=北京|上海|广州]
- iframe "http://localhost:5173/cross"
  - button "跨源按钮" [ref=e14]
```

- **框架。** 同进程 iframe 用页面会话按 `frameId` 读；跨源 iframe 是独立 target，经 `Target.setAutoAttach`（flatten，不等调试器）进来成为子会话，从子会话读。两者在拥有它的 `<iframe>` 元素处拼起来（`DOM.getFrameOwner`）。
- **引用。** 可交互角色（button、link、textbox、checkbox、combobox、option、tab、switch、slider 等）带 `eN`。同一元素在页面不换时引用不变；编号只增不复用，导航之后旧编号不会指向新页面的别的东西。
- **控量。** `--interactive` 只列可交互元素（按框架分组）；`--depth` 只展开 N 层；`--max-bytes` 截断并说明还有多少项。
- **过滤。** 可编辑的节点只写 `[filled]` / `[empty]`，不输出值，也不输出它里面的文字；AX 树忽略的节点（`display:none`、`aria-hidden`）本来就不在；标签文字与旁边控件的名称相同则不重复。

### 引用失效

引用按「会话 + backend 节点 id」指向一个 DOM 节点。使用时先用 `Accessibility.getPartialAXTree` 看节点是否还在：同一节点、同一角色即可用（名称变了也算，按钮从「保存」变成「已保存」还是它）。节点没了，或引用属于上一个导航世代，就**按角色与名称在同源页面上重找一次**：恰好一个就用，并在回答里写明「eX 已失效，按角色与名称重新定位为 eY」；零个或多个就以 `browser_stale_ref` 拒绝并说明是哪种。换了站点的一律拒绝。

### 差异快照

`--snapshot` 让改页面的动作之后顺带回一份：有同一页面上一份整页快照时给新增与消失的行（引用稳定，所以没变的行不算），换了页面或没有基准时给整页（8 KB 上限）。

## 4. 定位

`--ref`、`--role [--name]`（先精确再按包含，多个时列出候选并各自发引用）、`--selector`（主框架）、`--x --y`。

按下之前：把元素（以及外面每一层 iframe）滚进可视区域，用 `DOM.getContentQuads` 取中心，跨源 iframe 里的元素逐层加上 iframe 内容框的位置；再用冻结脚本 `elementState` 检查可见、未禁用、中心点确实落在它身上——被别的东西挡住时拒绝并说出挡住它的是什么。指针移过去之后再量一次，悬停展开的菜单收起会让下面的东西挪位。

## 5. 表单与下拉

- 文本一律经 `Input.insertText`，清空用 `selectAll` + `deleteBackward` 两个编辑命令；从不给字段赋值。
- 原生 `<select>`：先 `DOM.focus`（不点开，点开的是系统菜单，合成按键够不着），再逐字发 `char` 事件做键入跳转；键入跳转对 CJK 不生效，或选项重名时，调用唯一的写入脚本 `chooseOption`：只对已启用的 SELECT、只按下标选它自己的已启用选项，并触发 `input` 与 `change`。这是冻结脚本表里唯一的写入者，源码测试钉住它的每一处赋值。
- 自绘下拉（combobox、listbox、带弹出的 button）：点开，在快照里找 option / menuitem / treeitem，可编辑的先键入过滤，再点选项。

## 6. 按键白名单

`keys.ts` 按「键 + 修饰键」逐项判断，白名单与 `press` 读同一张表：命名键与 F1–F12 带任何修饰键都行；字母与数字必须带 Ctrl、Meta 或 Alt（光秃秃的字母是打字）；带 Ctrl / Meta 的 C、V、X（剪贴板）与 W、Q、T、N（窗口与标签）一律不放。按键事件不能带 `text`；唯一例外是只含一个字符、没有键名和修饰键的 `char` 事件，它等于一次单字符的 `insertText`。macOS 上组合键附带 `selectAll` / `undo` / `redo` 编辑命令。

## 7. 开发者能力

用户决定：控制台、请求元数据与 PDF 对所有 Agent 默认开放；执行任意 JS 仍不开放。

- 白名单只为此增加订阅：`Log.enable/disable` 与 `Network.enable`（固定 `maxPostDataSize: 0`）/`disable`。所有会返回正文、提交体、Cookie、证书或会改流量的 `Network.*` 方法逐个写进禁止表；`sole-call-site.test.ts` 钉住 Network 域只有这两个方法，并确认读请求事件的只有 `devlog.ts`，且它不读任何头。
- `devlog.ts` 每页两个环形缓冲（各 500 条）。控制台记级别、来源、文字（1000 字以内）与位置；请求记方法、地址、类型、状态、大小、耗时、失败原因、是否来自缓存。地址去掉用户名密码与片段，名字像凭据的查询参数值换成「…」。
- `wait --idle`：500 ms 内没有进行中的请求。拿到响应后 5 秒没动静、或 10 秒没响应的请求不再算进行中（长轮询、流）；跨源 iframe 的文档请求在那个 iframe 会话导航到它时记为结束。
- 桌面壳在 Agent 第一次驱动时才接上调试器，之前的控制台输出不在缓冲里；headless 后端从开标签就开始记。

## 8. 对话框、租约与超时

- 页面弹着 alert / confirm / prompt 时，除 `dialog`、`tabs`、`download`、`close`、`lease` 与 `read --mode console|network` 之外的动词都以 `browser_dialog_pending` 拒绝并带上对话框文字。引起对话框的那次点击不等在对话框后面：输入事件与「对话框打开」赛跑，回答里说明页面弹出了对话框。
- 桌面壳上 Agent 经 CDP 发的键鼠不会触发 guest 的 `before-input-event` 或 `focus`（Electron 42 实测；只触发壳里没人监听的 `before-mouse-event`），所以 Agent 自己的动作不会被当成人在操作而抢走租约。探针的桌面一段每跑完整批动词都核对租约仍在 Agent 手里。
- hook 客户端给浏览器动词 70 秒预算（hook 事件仍是 1.5 秒）：预算不够时客户端会换下一个候选端点重发同一个动词。

## 9. 两个后端的差别

|          | headless（服务器壳、无壳的 core）        | 桌面壳 `<webview>`                                                                                     |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| PDF      | CDP `Page.printToPDF`                    | Electron `printToPDF`；页面含跨源 iframe 时先拒绝（Electron 打印这种页面永远不返回），其余加 20 秒上限 |
| `resize` | 改 headless 自己的视口，画面流跟着变     | CDP 设备尺寸模拟，调试器断开（人接管）即恢复                                                           |
| `--tab`  | 指向该 target                            | 指向该标签的 guest，不切换人看到的那一个                                                               |
| 整页截图 | 跨源 iframe 在视口以外的部分截出来是空白 | 同左                                                                                                   |

## 10. 验证

- 单测：`core/browser/cdp/verbs.test.ts`（每个动词对一个脚本化页面 `fake-page.ts`）、`allowlist.test.ts`、`refs.test.ts`、`scripts.source.test.ts`、`verb-spec.test.ts`、`main/browser/verbs.test.ts`（桌面壳的标签路由、调试器事件、打印）。
- 真浏览器：`core/browser/headless/verbs.live.integration.test.ts`（真 Chromium 跑全部动词）。
- 端到端：`tools/probes/browser-agent-e2e.mjs [--electron]`，见 [探针说明](../../tools/probes/README.md)。
