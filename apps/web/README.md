# apps/web

唯一前端应用：tldraw 画布、七种节点、xterm.js 终端、代码编辑器、Git 差异、
设置与会话侧栏。桌面壳与浏览器加载的是同一份构建产物。

技术栈：React 19、TypeScript、Vite、tldraw 5、shadcn/ui（Radix）、Tailwind v4、
xterm.js、CodeMirror 6、Zustand、TanStack Query、zod。

```bash
pnpm --filter @armadra/web dev     # 127.0.0.1:1420
pnpm --filter @armadra/web build
pnpm --filter @armadra/web test
```

需要 Runtime 已在运行。默认连 `http://127.0.0.1:43120`，可用 `VITE_RUNTIME_URL` 覆盖。

## 目录

| 目录                             | 内容                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `src/canvas/`                    | tldraw 集成：自定义 shape 与 binding、与 Runtime 的双向同步、右键菜单、覆盖层、拖放     |
| `src/nodes/`                     | 七种节点的节点体：terminal、sticky、group、editor、diff、files、browser，以及子代理卡片 |
| `src/terminal/`                  | xterm.js 终端与 WebSocket 传输                                                          |
| `src/shell/`                     | 标签栏、Dock、左侧栏、用量球、窗口拖拽区                                                |
| `src/panels/`                    | 设置、命令面板、资源管理器抽屉、源代码管理抽屉、各类对话框                              |
| `src/sidebar/` / `src/sessions/` | 工作空间与看板树、会话列表                                                              |
| `src/store/`                     | `canvas-store`：画布动作的唯一入口，内部驱动 tldraw editor                              |
| `src/save/`                      | 自动保存与保存队列                                                                      |
| `src/api/`                       | Runtime HTTP / WebSocket 客户端                                                         |
| `src/i18n/`                      | 简体中文与英文文案                                                                      |
| `src/platform/`                  | Tauri 与浏览器的能力差异（目录选择器、外部链接、文件拖入）                              |

## 约定

- 界面文案只写在 `src/i18n/`，组件里用 `useT()` 取键，不硬编码字符串。
- 组件只用 shadcn CLI 装进来的那套，不自己造同名组件。
- 画布状态改动一律经 `canvas-store` 的动作，不直接改 tldraw store。
