# 探针 —— 缩放画布上的 `<webview>`（W3.0 go/no-go）

**日期：** 2026-09-19 · **Electron：** 42.10.1（Chromium 148.0.7778.280，Node 24.18.1） · **平台：** darwin arm64，Retina `devicePixelRatio = 2`，真窗口非 headless · **批次：** [Electron 迁移](../../design/electron-migration.md) W3.0 / [浏览器节点](browser-node.md) §6 批次 0

## 结论先行

**六条全部通过，两条 no-go 闸门（第 3、6 条）均为 go：`<webview>` 方案的前提成立，§4 不需要重估。**

[浏览器节点](browser-node.md) §2.1 的两条推断都被证实：缩放下的命中测试**零偏差**，而且文字是**按合成缩放重新栅格化**的（不是位图放大）；guest 内的滚轮**完全不冒泡到宿主**，所以「悬停在网页上 Cmd+滚轮缩放画布」这个手势在 webview 节点上**必然失效，且没有任何宿主侧的补救手段**。§1.2 的 keep-alive 起因也在第 6 条里**被精确撞到**：拖拽、缩放、平移、在 nodes 数组**最前面插入**、**删除兄弟节点**全部零重载，而**把两个 webview 节点在数组里对调**，只有被 React 真正 `insertBefore` 移动的那一个 guest 被杀。

## 目标

在不动 Armadra 任何现有代码的前提下回答：把一个裸 `<webview>` 直接放进 React Flow 的 CSS transform 里，人还能正常用吗；以及 guest 在画布的常规操作下活不活得下来。

## 环境与工程

独立最小 Electron 工程 `tools/probes/electron-webview/`（自带 `package.json`，**不属于根 pnpm workspace**，不 import Armadra 任何模块）：

- `BrowserWindow({ useContentSize: true, width: 1500, height: 1000, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } })`；
- 渲染页是 `@xyflow/react` **12.11.6** + React **19.2.8**（与 `apps/web` 同版本），`minZoom 0.01` / `maxZoom 2`；
- 三个节点：`wv-1`、`wv-2`（各 520×360，header 28px，其余是一个裸 `<webview style="width:100%;height:100%">`，容器 `nodrag nowheel`，**无遮罩、无 hover-guard**，`src` 以属性方式命令式设置），外加一个普通节点 `plain-1` 当兄弟；
- guest 视口实测 **520 × 332 CSS px**，`devicePixelRatio = 2`，`webContents.getZoomFactor() = 1`；
- fixture 在 `http://127.0.0.1:<random>`（`file://` 的 origin 不稳定，计数器会失真）：四角与中心五个按钮在 `click` 时把 `event.clientX/Y`、`event.target.id`、`document.elementFromPoint` 的 id 与一个递增计数器写到页面上；另有可滚动长文本、`<select>`、IME `<input>`、一段用于栅格化测量的黑底白字，以及两个加载计数器。

全部自动化，无人工操作：主进程合成输入、`webContents.capturePage` 截图、经渲染进程对 guest `executeJavaScript` 读回自报值，写出 `out/result.json`。**连跑两次，判定与第 3 条的三个比值逐位相同。** 截图落在已忽略的 `out/`，不入库。

### 第 0 条（不在验收单里，但改变了整个探针的形状）

`webContents.sendInputEvent` **到不了 guest**。第一版用它合成点击，结果 guest 的 `clickCount` 一次都没动，而宿主 document 收到了事件——它直接注入宿主 RenderWidget，不经浏览器进程的命中测试路由，因此永远不会被路由进 guest 这个 OOPIF。

```
sendInputEventReachedGuest  false
cdpInputReachedGuest        true
```

改用宿主窗口 `webContents.debugger` 的 CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` 后全部通。这条走的是真实鼠标同一条路由。**下面所有测量都基于 CDP 输入；这也意味着 W3.3 的自动化验收只能这么测，用 `sendInputEvent` 写出来的 webview 测试会全绿地测了个寂寞。**

---

## 1. zoom = 0.25 / 0.5 / 1 / 2，四角与中心

**步骤：** 每个缩放先把 `wv-1` 的左上角摆到窗口 (20, 20)，读 `<webview>` 元素变换后的 `getBoundingClientRect()` 与 guest 自报的按钮几何，算出按钮中心对应的宿主窗口坐标（取整），在那里合成一次点击，再读回 guest 自报的 `clientX/Y` 与命中元素。

**原始测量：**

| zoom | `<webview>` 宿主矩形 | 实测缩放 | 命中元素全对 | 偏离瞄准点 | 偏离按钮几何中心 |
| ---- | -------------------- | -------- | ------------ | ---------- | ---------------- |
| 0.25 | 130 × 83             | 0.25     | 是（5/5）    | **0 px**   | ≤ 1 px           |
| 0.5  | 260 × 166            | 0.5      | 是（5/5）    | **0 px**   | ≤ 1 px           |
| 1    | 520 × 332            | 1        | 是（5/5）    | **0 px**   | 0 px             |
| 2    | 1040 × 664           | 2        | 是（5/5）    | **0 px**   | 0 px             |

「偏离瞄准点」是把取整后的宿主坐标反算回 guest CSS 像素，与 guest 自报的 `clientX/Y` 比；20 次点击**全为 0**。「偏离几何中心」在 0.25 / 0.5 下的 1 px 完全来自宿主整数像素取整（1 个宿主像素 = 4 或 2 个 guest 像素），不是坐标换算误差。`event.target.id` 与 `document.elementFromPoint` 的 id 每次都等于预期按钮。

**结论：** 零偏差。[浏览器节点](browser-node.md) §2.1「缩放画布上的 webview 点击不偏是平台属性」得到实测支持——宿主渲染进程不参与任何换算，合成与命中测试在 Chromium 的 surface 层连同祖先 transform 一起完成。**Armadra 不需要写任何 scale 补偿代码。**

## 2. 平移画布后重复第 1 条

**步骤：** 每个缩放先把视口摆到「目标位置减去 (+300, −200)」，然后在空白画布上合成一次真实的左键拖拽 (+300, −200)（不是调 `setViewport`），使节点正好落回 (20, 20) 且四角都在窗口内；再重复第 1 条的五次点击。另加一轮**分数平移**：`setViewport(x + 137.5, y − 83.25)`，因为整数拖拽藏得住平移分量上的取整 bug。

**原始测量：**

| 轮次                          | 拖拽实际落差   | 落定视口              | 命中全对 | 偏离瞄准点 | 偏离几何中心 |
| ----------------------------- | -------------- | --------------------- | -------- | ---------- | ------------ |
| pan zoom=0.25                 | (+300, −200)   | (10, 10, 0.25)        | 是       | **0 px**   | ≤ 1 px       |
| pan zoom=0.5                  | (+300, −200)   | (0, 0, 0.5)           | 是       | **0 px**   | ≤ 1 px       |
| pan zoom=1                    | (+300, −200)   | (−20, −20, 1)         | 是       | **0 px**   | 0 px         |
| pan zoom=2                    | (+300, −200)   | (−60, −60, 2)         | 是       | **0 px**   | 0 px         |
| 分数平移 zoom=1（+137.5/−83.25） | —              | (117.5, −103.25, 1)   | 是       | **0.5 px** | 0 px         |

**结论：** 平移分量不引入任何偏移，分数平移下的 0.5 px 是宿主整数像素取整的上界，仍然命中正确元素。第 1、2 条合起来说明：**缩放与平移都不需要补偿，也不需要在某个缩放阈值以下关闭交互以「保证点得准」**——点得准从来不是问题（能不能看清是另一回事，见第 6 节约束）。

## 3. 文字是位图放缩还是重新栅格化 —— **no-go 闸门之一**

**步骤：** 判据在测量之前写死在 `lib/metrics.cjs` 文件头：取**同一块** guest 文字（240 × 28 CSS px 的黑底白字），在 zoom 0.5 / 1 / 2 下按变换后的宿主矩形裁剪 `capturePage`，统计设备像素上的「中间灰阶占比」（亮度落在 min/max 各 20% 之间的像素比例）与「最大相邻水平梯度」。
重新栅格化 → 笔画随缩放变粗而抗锯齿边仍是约 1 个设备像素，**中间灰阶占比随缩放下降**、峰值梯度保持满量程；位图放大 → 每个源像素被拉伸并插值，中间灰阶占比持平或上升、**峰值梯度按缩放比例下降**。

**原始测量：**

| zoom | 裁剪设备像素 | 中间灰阶占比 | 最大相邻梯度 | 墨迹占比 | 边缘像素占比 |
| ---- | ------------ | ------------ | ------------ | -------- | ------------ |
| 0.5  | 240 × 28     | 0.0765       | 255          | 0.1057   | 0.1970       |
| 1    | 480 × 56     | 0.0412       | 255          | 0.1005   | 0.1077       |
| 2    | 960 × 112    | **0.0208**   | **255**      | 0.0980   | 0.0538       |

比值：中间灰阶占比 2/1 = **0.5049**，最大梯度 2/1 = **1.0000**，墨迹占比 2/1 = **0.9751**。

**结论：go。文字在合成缩放下重新栅格化。** 中间灰阶占比几乎精确地减半（抗锯齿边保持约 1 设备像素宽，而字号翻倍），峰值梯度纹丝不动停在满量程 255（位图插值必然压低它），墨迹占比在 0.5–2 的四倍字号跨度里只变了 2.5%（形状不变，只是画得更大）。zoom = 2 下**不糊**；zoom = 0.5 下中间灰阶占比反而升到 0.0765，是缩小时抗锯齿吃掉更多笔画的正常表现，不是缺陷。
`guestZoomFactor` 全程为 1、guest 的 `devicePixelRatio` 全程为 2：**缩放没有以任何形式泄漏进 guest**，页面自己看不见画布缩放。

## 4. 页内滚动 / `<select>` / 右键菜单 / 文本选区 / IME

**原始测量（除右键菜单跑了三个缩放外，其余在 zoom = 1）：**

- **滚动**：在 `#scroller` 上合成两次 `deltaY = +240` 的滚轮 → `scrollTop` 由 `0` 到 **480**，guest 侧 `wheel` 事件计数 **2**。
- **`<select>`**：点击后 `document.activeElement.id === "sel"`（`opened: true`），整窗截图 `out/select-popup-open.png` 留证；随后合成 ArrowDown + Enter，`value` 仍为 `alpha`、`change` 事件 **0**。
- **右键菜单**：三个缩放下 guest 的 DOM `contextmenu` 全部触发，命中元素都是 `btn-c`、`clientX/Y` 都是 (260, 166)（zoom 0.5 下为 (261, 167)，1 px 取整）；主进程侧 guest `webContents` 的 `context-menu` 事件**三次全部到达**，`editFlags` 有值。
- **文本选区**：跨 `#seltext` 拖拽 → `window.getSelection()` 得到 `"ELECTABLE-TEXT-MARKE"`，是标记串的连续子串（起点落在首字符内部，少一个字符属正常）。
- **键盘 / IME**：点击后焦点落在 `#ime`；从宿主合成 `a`、`b`、`c` 三个按键 → guest 侧 `value === "abc"`、`keydown` 计数 6。guest 内派发 `compositionstart`/`compositionupdate`/`compositionend` + `execCommand('insertText')` → `value === "abc你好"`，两个 composition 事件各计 1。

**一个非显然的发现（对 W3.3/W3.4 直接有用）：** Electron 主进程 guest `context-menu` 事件里的 `params.x/y` 是**宿主窗口坐标，不是 guest 的 CSS 像素**。三个缩放下它与合成点的偏差都是 **0**（zoom 0.5 下 0.5 px 取整），而与 guest 自报坐标的偏差随缩放线性放大（−109 / +21 / +282）。

| zoom | 合成的宿主点 | guest 自报 `clientX/Y` | `params.x/y` | 对宿主点偏差 | 对 guest 坐标偏差 |
| ---- | ------------ | ---------------------- | ------------ | ------------ | ----------------- |
| 0.5  | (150.5, 117.5) | (261, 167)           | (151, 118)   | (0.5, 0.5)   | (−109, −48)       |
| 1    | (281, 215)     | (260, 166)           | (281, 215)   | (0, 0)       | (+21, +49)        |
| 2    | (542, 410)     | (260, 166)           | (542, 410)   | (0, 0)       | (+282, +244)      |

**结论：** 五项里四项完全可用，且这四项正是 screencast 方案最难做对的。`<select>` 的下拉能打开但**键盘操作不进去**——它是 OS 级控件，CDP 的按键注入被它吞掉；这不代表人操作不了，只代表**自动化测不到**（见未验证项）。右键菜单那条坐标事实必须写进 W3.3：把 `params.x/y` 当 guest 坐标传给 `contents.inspectElement(x, y)`，在 zoom ≠ 1 时会指到别的元素上。

## 5. 悬停在 webview 上时的滚轮 / Cmd + 滚轮

**步骤：** 同一个点连发三次 `deltaY = −240` 的滚轮，对比「落在 guest 上」与「落在空白画布上」两组；宿主侧在 window 捕获阶段数 wheel 事件，guest 侧数自己的 wheel 事件，前后读画布 viewport。

**原始测量：**

| 用例                         | 画布 zoom | 画布平移变化 | 宿主收到 wheel | guest 收到 wheel |
| ---------------------------- | --------- | ------------ | -------------- | ---------------- |
| 裸滚轮，落在 guest 上        | 1 → 1     | 否           | **0**          | 3                |
| Cmd + 滚轮，落在 guest 上    | 1 → 1     | 否           | **0**          | 3                |
| Ctrl + 滚轮，落在 guest 上   | 1 → 1     | 否           | **0**          | 3                |
| 裸滚轮，落在空白画布上（对照） | 1 → **2** | 是           | 3              | 0                |
| Cmd + 滚轮，落在空白画布上（对照） | 1 → **2** | 是           | 3              | 0                |

对照组确实会缩放，所以「画布没缩放」不是「合成滚轮根本没用」的伪结论。

**结论：** 指针在 webview 上时，**宿主一个 wheel 事件都收不到**（不是 0 个有效事件，是 0 个事件），guest 独吞全部三次。§2.1 推断 2 成立，且比预想的更彻底：**这不是 `nowheel` class 挡掉的**——`nowheel` 对 webview 节点根本无事可做，事件从未跨过进程边界。因此 Cmd + 滚轮缩放画布在 webview 上**失效且无法在宿主侧补救**；要改变只能在 guest 里注入脚本回传，而那正是能力表禁止的动词。nodeterm 接受这个代价，Armadra 也只能接受。

## 6. guest 生命周期 —— **no-go 闸门之二**

**步骤：** 先给两个 guest 各写入一段表单文本与一个滚动位置作为状态种子，然后依次做六步操作，每步之后读四个独立信号：`getWebContentsId()`、`sessionStorage` 加载计数、`localStorage` **累计**加载计数、以及表单文本与滚动位置。

> `sessionStorage` 计数**单独用是靠不住的**：guest 被替换后拿到全新的 storage namespace，计数从 1 重新开始，看起来和「从没重载过」一模一样。本条的判定以 `webContentsId` + `localStorage` 累计计数 + 页内状态三者为准。

**原始测量：**

| 步骤                              | DOM 顺序                        | `wv-1` [wcId, session, 累计, 表单, scrollTop] | `wv-2` 同项                        |
| --------------------------------- | ------------------------------- | --------------------------------------------- | ---------------------------------- |
| baseline                          | wv-1, wv-2, plain-1             | [2, 1, 1, `seed-wv-1`, 240]                   | [3, 1, 1, `seed-wv-2`, 240]        |
| 拖 header (+90, +60)              | wv-1, wv-2, plain-1             | [2, 1, 1, `seed-wv-1`, 240]                   | 同上                               |
| 缩放 1 → 0.25 → 2 → 1             | wv-1, wv-2, plain-1             | [2, 1, 1, `seed-wv-1`, 240]                   | 同上                               |
| 平移画布                          | wv-1, wv-2, plain-1             | [2, 1, 1, `seed-wv-1`, 240]                   | 同上                               |
| **在 nodes 数组最前面插入新节点** | **ins-1**, wv-1, wv-2, plain-1  | [2, 1, 1, `seed-wv-1`, 240]                   | 同上                               |
| **删除兄弟节点**                  | ins-1, wv-1, wv-2               | [2, 1, 1, `seed-wv-1`, 240]                   | 同上                               |
| **对调两个 webview 节点的顺序**   | ins-1, **wv-2, wv-1**           | [**4**, 1, **2**, **`""`**, **0**]            | [3, 1, 1, `seed-wv-2`, 240]        |

唯一一条重载记录：

```
step        swap the two webview nodes in the nodes array
node        wv-1
webContentsId        2 -> 4
persistentLoadCount  1 -> 2
sessionLoadCount     1 -> 1      <-- 单看这一项会得出「没重载」的错误结论
formText             "seed-wv-1" -> ""
scrollTop            240 -> 0
```

**结论：go，而且把 keep-alive 的起因精确定位到了「React 真的调用了 `insertBefore`」这一件事上。**

- 拖拽、缩放、平移**不触碰 DOM 结构**，guest 毫发无损；
- 在 nodes 数组**最前面插入**一个新节点：React 的 keyed 协调对 `[A,B,C] → [X,A,B,C]` 只插入 X、`lastPlacedIndex` 使 A/B/C 原地不动，**零重载**。「插到前面就会重排」是错的；
- **删除兄弟节点**同理，零重载；
- **对调顺序** `[wv-1, wv-2] → [wv-2, wv-1]`：`wv-2` 的旧索引 1 ≥ `lastPlacedIndex`，不动；`wv-1` 的旧索引 0 < 1，**被 `insertBefore` 移动** → 进程被杀、状态清零、拿到新的 `webContentsId`。**两个节点在同一次更新里一死一活**，正好把判据钉死在「这个节点有没有被移动」，而不是「数组有没有变」。

[浏览器节点](browser-node.md) §1.2 记录的 Electron 42.x 行为在 42.10.1 + React 19 上原样复现。

---

## 对 W3.1 – W3.2 的具体约束

1. **pool region 是必要的，但需要的不变量比「只追加/删除」更窄：webview 宿主节点在 `nodes` 数组里的相对顺序必须永不变化。** 第 6 条实测「在最前面插入」和「删除兄弟」都安全，所以 pool region 不必强求追加在数组尾部；真正致命的只有让 React 移动已挂载元素的更新（对调、排序、把节点在分组之间搬家、任何按 z-index/选中态重排 nodes 的逻辑）。W3.2 应当照此写守卫：对 webview 宿主节点做一次顺序稳定性断言（上一帧的相对顺序是这一帧的子序列），而不是笼统禁止插入。
2. **不需要任何缩放补偿，也不需要缩放阈值下的遮罩来「保证点得准」。** 第 1、2 条 20 + 25 次点击零偏差。如果 Armadra 仍要在 `zoom < 阈值` 时盖遮罩，理由只能是**可用性**（0.25 下 520×332 的页面缩成 130×83，人看不清也点不准）和**恢复画布手势**（见下条），不能写成「修正坐标」。建议把这层可选遮罩推迟到 W3.1 之后按真实反馈决定，第一版照 nodeterm 不盖。
3. **「悬停在网页上 Cmd+滚轮缩放画布」这个手势要在 W3.1 就明确记为已知缺失，不要当 bug 排查。** 第 5 条实测宿主收到 **0** 个 wheel 事件，`nowheel` 在 webview 节点上无事可做，宿主侧没有任何补救手段。若产品上不可接受，唯一干净的办法是那层**缩小时的遮罩**（遮罩在宿主 DOM 里，wheel 自然回到宿主），代价是遮罩期间页面不可交互——这恰好与「缩小时页面本来也没法用」重合，所以两条约束应当合并成同一个开关。
4. **`partition` 与 keep-alive 的关系不变，但状态判据要换。** W3.2 的验收（「`webContentsId` 不变、计数器 fixture 不重载」）必须**不能只用 `sessionStorage` 计数**：guest 被替换后它会从 1 重新开始，是一个静默的假阴性。照本探针用 `webContentsId` + `localStorage` 累计计数 + 一段页内状态三者取或。
5. **W3.1 的自动化测试只能用 CDP 注入输入。** 第 0 条实测 `webContents.sendInputEvent` 到不了 guest；用它写的 webview 交互测试会「全绿地什么都没测」。这条同样约束 W3.3 的验收闸门脚本。
6. **右键菜单的坐标空间要在 W3.3 之前定好。** 主进程 guest `context-menu` 的 `params.x/y` 实测是**宿主窗口坐标**；`contents.inspectElement(x, y)` 期望的是 guest 视口坐标，在 zoom ≠ 1 时直接传会指错元素。需要一次显式换算（除以画布缩放、减去 `<webview>` 的宿主矩形原点），并为此写一条带缩放的测试。
7. **文字清晰度不是引入 `zoomFactor` 补偿的理由。** 第 3 条证明缩放没有泄漏进 guest（`getZoomFactor()` 恒为 1、guest 的 `devicePixelRatio` 恒为 2），页面按合成缩放重新栅格化。W3.1 不要调 `setZoomFactor` 去「补偿画布缩放」——那会同时改变页面布局宽度，把一个不存在的问题换成一个真的问题。

## 未验证项

- **`<select>` 下拉的键盘操作没测到。** 弹出层是 OS 级控件，CDP 按键注入被它吞掉（`value` 未变、`change` 事件为 0）。已知的只有「点击能打开、焦点落在 `<select>` 上」（`out/select-popup-open.png` 留证）。人手是否能正常选项目**需要 W3.1 手工过一遍**。
- **没有驱动过真正的操作系统 IME。** 第 4 条的 composition 事件是在 guest 内部派发的，`insertText` 也是 `execCommand`。宿主合成的 ASCII 按键确实路由到了 guest（`value === "abc"`），但**中文/日文输入法在缩放画布上的候选窗定位没有验证**——候选窗由 OS 按 guest 报告的插入符位置摆放，而 guest 不知道自己被缩放了，这是一个**具名的未知风险**，应在 W3.1 手工验一次（尤其 zoom = 0.25 与 2）。
- **只在 macOS arm64 Retina 上跑过。** Windows / Linux、非 Retina（`dpr = 1`）、多显示器跨不同缩放因子拖动窗口，全部未验证。第 3 条的栅格化结论依赖 Chromium 的合成缩放策略，换平台前不应当外推。
- **没有测极端缩放。** 画布下限是 `minZoom 0.01`，本探针最低只到 0.25。0.01–0.1 区间的 guest 是否仍在栅格化、是否被降级成低分辨率 tile、乃至 Chromium 是否直接放弃绘制，未知。
- **没有测多 guest 的内存与帧率。** `BACKGROUND_WEBVIEW_MAX = 8` 这类上限的依据不在本探针里；两个 guest 时一切正常，20 个时如何未知。
- **没有测导航、`partition`、下载、弹窗。** 那些由 nodeterm 的探针 B/C（[浏览器节点](browser-node.md) §1.4）覆盖，本探针只管渲染与生命周期。
