# W3.0 探针 — 缩放画布上的 `<webview>`

[Electron 迁移设计](../../../docs/design/electron-migration.md) W3.0 的 go/no-go 实验：一个独立的最小 Electron 工程，`webviewTag: true` + React Flow 12，两个节点各挂一个裸 `<webview>` 指向本地 fixture，全自动跑完六条验收并写出 `out/result.json`。

不属于根 pnpm workspace，不引用 Armadra 任何代码，**跑它不会改动仓库任何现有文件**。结论与原始测量见 [webview 探针记录](../../../docs/research/nodeterm/webview-probe.md)。

## 跑

```sh
cd tools/probes/electron-webview
npm install          # electron 42.10.1 + @xyflow/react 12.11.6 + react 19.2.8 + esbuild
npm run probe        # = node build.mjs && electron . --probe
```

`npm install` 若因 `allowScripts` 拦下 postinstall（没有 `node_modules/electron/dist`、没有 `node_modules/.bin/esbuild` 可执行），补跑两条安装脚本：

```sh
node node_modules/esbuild/install.js
node node_modules/electron/install.js
```

会打开一个 1500×1000 的窗口跑约 90 秒，全程由主进程合成输入，**不需要人操作**，结束自动退出。六条里第 3 或第 6 条失败时退出码非零。

`npm run watch` 跑完同样的流程但保留窗口，用来手工复看。

## 产物

`out/`（已在 `.gitignore` 里，**不提交**）：

- `result.json` —— 全部原始测量与判定；
- `raster-zoom-0_5.png` / `raster-zoom-1.png` / `raster-zoom-2.png` —— 第 3 条的同一块 guest 文字在三个缩放下的裁剪；
- `select-popup-open.png` —— 第 4 条点开 `<select>` 时的整窗截图。

## 结构

| 文件                 | 作用                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `main.cjs`           | 起静态服务与窗口，按顺序跑第 0–6 条，写 `out/result.json`，按第 3/6 条定退出码                       |
| `lib/http.cjs`       | 回环随机端口静态服务（fixture 需要真 http origin，`sessionStorage` 才有稳定 origin）                 |
| `lib/driver.cjs`     | 合成输入与截图。输入走宿主窗口的 **CDP `Input.*`**，不走 `sendInputEvent`——原因见下                  |
| `lib/metrics.cjs`    | 第 3 条的像素统计（中间灰阶占比、最大相邻梯度），判据写在文件头、先于测量                            |
| `lib/steps-a.cjs`    | 第 0（输入路由）、1（缩放命中）、2（平移命中）、3（栅格化）条                                        |
| `lib/steps-b.cjs`    | 第 4（页内交互）、5（滚轮归属）、6（guest 生命周期）条                                               |
| `renderer/app.jsx`   | 最小 React Flow 画布，`minZoom 0.01` / `maxZoom 2`，`<webview>` 装在 `nodrag nowheel` 容器里、无遮罩 |
| `fixture/index.html` | guest 页面：四角+中心按钮自报 `clientX/Y`、可滚动区、`<select>`、IME 输入框、两个加载计数器          |

## 两条实现上的坑（都是被测出来的，不是设计出来的）

- **`webContents.sendInputEvent` 到不了 guest。** 它直接注入宿主 RenderWidget，不经浏览器进程的命中测试路由，所以瞄准 webview 的点击只会落在宿主 document 上（第 0 条：`sendInputEventReachedGuest: false` / `cdpInputReachedGuest: true`）。因此驱动一律走 `webContents.debugger` 的 `Input.*`。**实验工程可以这么做，生产照 nodeterm 的姿态仍然禁止 `Runtime.evaluate` 一类动词。**
- **React Flow 的 `preventScrolling: false` 会让它自己的 `wheel.zoom` 对非 ctrl 滚轮直接返回**，第 5 条的对照组会因此静默失效（看起来像「画布本来就不缩放」）。这里保持默认 `true`。

`guestEval`（渲染进程里对 guest 调 `executeJavaScript`）**只在这个实验工程里允许**，它是读回 guest 自报坐标与计数器的唯一手段；生产路径按 nodeterm 的能力表禁止。
