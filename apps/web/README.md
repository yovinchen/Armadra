# Web 前端

React / TypeScript / Vite 应用，桌面与浏览器共用同一份产物。
画布使用 React Flow（白板层自写），终端使用 xterm.js，编辑器使用 CodeMirror；UI 使用 shadcn/ui 与 Tailwind。

```sh
pnpm --filter @armadra/web dev
pnpm --filter @armadra/web build
pnpm --filter @armadra/web test
pnpm --filter @armadra/web typecheck
```

默认页面 `http://127.0.0.1:1420`，需 Runtime 已在运行。`VITE_RUNTIME_URL` 可覆盖默认连接 `http://127.0.0.1:43120`。
`dev` / `build` 自动构建 shared 与 HostClient 依赖。

| 目录                          | 职责                                |
| ----------------------------- | ----------------------------------- |
| `src/canvas`、`src/nodes`     | 画布投影、节点 / 边、白板层与覆盖层 |
| `src/store`、`src/save`       | 画布动作、保存队列                  |
| `src/terminal`、`src/api`     | 终端与 Runtime 通信                 |
| `src/shell`、`src/panels`     | 应用壳、设置、文件与 Git 面板       |
| `src/sidebar`、`src/sessions` | 工作空间与会话                      |
| `src/i18n`、`src/platform`    | 双语文案、桌面壳 / 浏览器适配       |

画布写入经 `canvas-store`；文案使用 `useT()`，组件复用现有 shadcn 实现。
完整边界见[项目约定](../../AGENTS.md)。
