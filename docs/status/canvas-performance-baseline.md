# 画布性能基线（30 个终端 + 真实会话）

> 状态：已验证记录。[Electron 迁移](../design/electron-migration.md) §3 的 P0–P3 用这张表验收。
> 脚本：`tools/probes/canvas-stress.mjs`（用法见[探针说明](../../tools/probes/README.md)）。

## 1. 为什么要另记一份

[React Flow 画布](../design/canvas-react-flow.md) §6.5 的那张表里，30 个终端节点**没有会话**，所以量不到用户报的卡顿——卡顿出在「会话状态跳动 → `updateNodeData` → 换一份 `document` → 全量重投影」这条链上（[画布调研](../research/nodeterm/canvas-nodes-and-state.md) §7.2）。这份基线把「活会话」这一列补上。

两张表**不可直接比较**：§6.5 在有屏幕的 120 Hz 窗口里跑，这里是无头 Chrome，`requestAnimationFrame` 上限 60 Hz。fps 很快撞顶，**有判别力的是重渲组件数与最慢一帧**。

## 2. 场景

- 30 个终端节点，每个都连着一个真实的 Runtime PTY 会话（脚本核对 `GET …/sessions` 的 `alive`，不到 30 就直接失败）；另加 1 张便签。
- 视口 `zoom 0.35`，全部节点在视口内，React Flow 不裁剪——与 §6.5 同一个最坏情况。
- 1440×900、DPR 1、无头 Chrome 153.0.8010.48、macOS（Darwin 25.6.0）、Vite 开发服务器（非生产构建）。
- 四段：空闲 3 s；手形连续平移 10 s；拖一个节点 6 s；便签里连续输入 100 字符。

## 3. 基线（改动前，`33b138f56`，2026-09-19）

| 场景          | 平均 fps | p50 帧时 | p95 帧时 | 最慢一帧 | > 33.4 ms | JS 堆    |
| ------------- | -------- | -------- | -------- | -------- | --------- | -------- |
| 空闲 3.0 s    | 60.0     | 16.7 ms  | 16.8 ms  | 16.8 ms  | 0 / 179   | 117.2 MB |
| 平移 10.3 s   | 56.9     | 16.7 ms  | 16.8 ms  | 150.0 ms | 6 / 587   | 182.9 MB |
| 拖节点 6.4 s  | 60.0     | 16.7 ms  | 16.7 ms  | 16.8 ms  | 0 / 386   | 204.9 MB |
| 输入 100 字符 | 60.0     | 16.7 ms  | 16.8 ms  | 16.8 ms  | 0 / 216   | 76.4 MB  |

| 指标                                     | 基线   | 说明                                          |
| ---------------------------------------- | ------ | --------------------------------------------- |
| 一次会话状态跳动的 React commit 次数     | 39     | 销毁一个会话（三级终止 `session`）            |
| 一次会话状态跳动的重渲组件数             | 11,179 | DevTools `didFiberRender` 判据，约 287/commit |
| 连续输入 100 字符的 React commit 次数    | 11     | 便签本来就是本地 state + 失焦提交             |
| 连续输入 100 字符触发的 `PUT …/document` | 0      | 同上                                          |
| 整轮跑完的撤销栈深度                     | 31     | 30 条会话记账 + 1 条便签正文                  |

## 4. 基线读出来的三件事

1. **一次会话状态跳动重渲 11,179 个组件**，按名字排头几位是 `Presence` / `Popover` / `Popper` / `PopoverTrigger`——节点头部那几个 Radix Popover。也就是说一个节点的一次数据更新，把**所有**节点的整个头部子树重渲了一遍。这是 §7.2 第 1 条的直接证据。
2. **便签输入不是问题。** `nodes/StickyNode.tsx` 现在已经是本地 state + 失焦提交（调研 §7.3-3 描述的「每次击键 `updateNodeData`」在这个基线上已经不成立），`nodes/NodeShell.tsx` 的改名同理。100 个字符只有 11 次 React commit、0 次保存。
3. **撤销栈里有 30 条不该在的记录。** 每个终端建会话时 `terminal/surface/use-session.ts` 写一次 `sessionId`，走的是记历史的默认路径，于是开一块 30 个终端的板子，⌘Z 要按 30 次才碰得到用户自己的第一次编辑。

### 4.1 `updateNodeData` / `updateNode` 调用点频率审计

非测试调用点全表，按频率分三档：

| 频率                     | 调用点                                                                                                                                                                                                                                                                                                        | 处置                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **每次连接 / 每次退出**  | `terminal/surface/use-session.ts`（`sessionId`）、`use-transport.ts`（`lastExitCode`）、`use-launch.ts` 与 `agent/pending-launch.ts`（`agent.initialCommand`）                                                                                                                                                | 改 `history: "ignore"`；仍然存盘 |
| **每次用户动作**（按次） | `nodes/FilesNode.tsx`、`nodes/TerminalNode.tsx`（选模型）、`nodes/browser/BrowserNode.tsx`（导航）、`nodes/terminal-menu.ts`、`canvas/menus/node-menu.tsx`、`canvas/flow/overlays/WorktreeBindingBadge.tsx`、`files/file-operations.ts`、`panels/github/MergeCleanup.tsx`、`panels/git/log/worktree-frame.ts` | 不动                             |
| **一段编辑一次**（失焦） | `nodes/StickyNode.tsx`（正文）、`nodes/NodeShell.tsx`（改名）、`meta/NodeMeta.tsx`（批注）、`meta/annotations.ts`（✦ AI 命名，异步一次）                                                                                                                                                                      | 已是本地 state + 失焦提交        |

**没有一个按键写文档的调用点。**

## 5. P1–P3 之后（同一脚本、同一台机器复跑）

| 场景          | fps 前 → 后 | p95 帧时 前 → 后 | 最慢一帧 前 → 后 | > 33.4 ms 前 → 后 |
| ------------- | ----------- | ---------------- | ---------------- | ----------------- |
| 空闲 3.0 s    | 60.0 → 60.0 | 16.8 → 16.7 ms   | 16.8 → 16.8 ms   | 0 → 0             |
| 平移 10.3 s   | 56.9 → 59.5 | 16.8 → 16.8 ms   | 150.0 → 33.4 ms  | 6 → 1             |
| 拖节点 6.5 s  | 60.0 → 59.7 | 16.7 → 16.8 ms   | 16.8 → 50.0 ms   | 0 → 1             |
| 输入 100 字符 | 60.0 → 60.0 | 16.8 → 16.7 ms   | 16.8 → 16.8 ms   | 0 → 0             |

| 指标                                     | 前     | 后    |
| ---------------------------------------- | ------ | ----- |
| 一次会话状态跳动的重渲组件数             | 11,179 | 7,894 |
| 一次会话状态跳动的 React commit 次数     | 39     | 31    |
| 十秒平移的 `projectNodes` 调用次数       | 72     | 8     |
| 十秒平移的节点投影次数                   | 2,232  | 248   |
| 连续输入 100 字符期间的 `commit()` 次数  | 0      | 0     |
| 连续输入 100 字符触发的 `PUT …/document` | 0      | 0     |
| 整轮跑完的撤销栈深度                     | 31     | 1     |

**拖节点那一段的「最慢一帧」变差是量法变了，不是回归。** 基线那一轮的拖拽
按在 `[data-slot="node-header"]` 上，而拖拽把手是 `.drag-handle`，平移之后
`term-1` 还被移出了视口——那一段**什么都没拖动**，测的是静止画面。脚本现在
按住真正的把手、挑离画布中心最近的那个节点，并在事后核对节点确实位移过
（`result.json` 的 `dragMoved`），拖不动直接失败。改后那一列才是第一份真实
的拖拽数据；基线表的拖节点一行只能当作「同等静止负载下的空转」看。

fps 在这台无头 Chrome 上撞在 60 Hz 的顶上，四段都贴着上限，所以**有判别力的
是右边三列**：平移的最慢一帧 150 ms → 33.4 ms、掉帧 6 → 1，投影次数降到
九分之一。

### 5.1 改了什么

- **P1**：内存徽标只订阅自己那一行（`panels/resources/use-resources.ts` 的
  `useSessionResources`），不再把整份采样快照搬进三十个组件的 state；
  `app/use-board-sync.ts` 只订阅板 id 而不是整份 `document`；会话 id、退出码
  与启动行改走 `history: "ignore"`。
- **P2**：`canvas/flow/use-flow-nodes.ts` 只订阅 `nodes` / `edges` 两个数组
  引用（投影的入参类型收窄成 `CanvasTables`）；`CanvasOverlays` 的包围盒按需
  算；`diffSnapshots` 跳过原样传进来的表；`FlowWorkspace` 收一层 `memo`。
- **P3**：便签补一道卸载兜底（编辑到一半被卸下来不再丢字），并把「不按键提交、
  也不加防抖」写进注释与单测。

### 5.2 这一轮推翻的两条既有判断

1. **「便签每次击键 `updateNodeData`」在这个基线上不成立。**
   （[画布调研](../research/nodeterm/canvas-nodes-and-state.md) §7.2-2 / §7.3-3）
   `nodes/StickyNode.tsx`、`nodes/NodeShell.tsx` 的改名、`meta/NodeMeta.tsx`
   的批注、`nodes/browser/BrowserNode.tsx` 的地址栏，全部已经是本地 state +
   失焦 / 回车提交。审下来**没有一个**文本输入按键写文档，所以 P3 没有可摘的
   果子——`commit()` 在连续输入 100 字符期间本来就是 0 次。
2. **卡顿的大头不在「高频信号写进 document」，而在「一个高频信号被三十个
   组件各订阅一份」。** 会话状态、连接状态、`pendingLaunch`、agent 忙闲早就
   各有薄 store 或本地 state（`agent/status-store.ts`、`agent/pending-launch.ts`、
   `TerminalSurface` 的 `patch()`）。真正按 tick 打三十下的是资源采样快照。

### 5.3 剩下的大头（本轮没动）

按根因拆改后的 7,894：

| 来源                                | 量      | 说明                                                                                                     |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `NodeComponentWrapperInner`（一次） | ≈ 2,966 | 一个节点的数据变了，React Flow 仍然重建整张节点表：投影复用了没变的那三十个对象，但 `nodes` 数组换了身份 |
| `AppShell`（四次）                  | ≈ 4,000 | `terminal.exit` / `board.changed` 让 `sessions` / `git-status` / `board` 几个查询接连失效                |
| 其余                                | ≈ 900   | 真正该动的那个终端、Dock 用量、侧栏                                                                      |

两条都不是「订阅太宽」能再收的：前者要动 React Flow 受控节点的接法，后者要
把壳里那几个查询的失效面缩小。都超出本轮范围。

**`selected` 没有移出投影输入。** 任务里列了这一条，但这块画布是**受控**的
（`useFlowNodes` 的文件头注释写明「`applyNodeChanges` 一次都没用到——那会让
React Flow 变成第二份真相」）：`selected` 只从投影进 React Flow，撤掉它之后
store 里的选区（点节点、命令面板、Esc 回选择工具）就再也画不出来。要按调研
§7.3-2 做，得先把选区改成 React Flow 自己持有，那是设计变更。

## 6. 未记的部分

- **Tauri 壳基线待记。** `docs/design/electron-migration.md` §3 要求 Chrome 与 Tauri 壳各记一次；这一轮只记了 Chrome。壳里跑同一脚本需要把 CDP 换成诊断桥（`ARMADRA_DESKTOP_DIAGNOSTIC_WS`），不在本轮范围内。
- 生产构建下的数字没有记：脚本跑的是 Vite 开发服务器，React 是 DEV 构建（重渲计数依赖它）。
- 120 Hz 有屏幕窗口的数字仍以 §6.5 的那张表为准。
