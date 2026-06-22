# apps/web

唯一前端应用，包含 Workspace 授权、资源浏览、React Flow 语义画板、xterm.js 终端、Agent 上下文和 Git Diff 审查。

目标技术栈：React、TypeScript、Vite、React Flow、xterm.js、Monaco Editor、Zustand 和 TanStack Query。

```bash
pnpm --filter @ai-coding-canvas/web dev
pnpm --filter @ai-coding-canvas/web build
```

Runtime 默认地址为 `http://127.0.0.1:43120`，可用 `VITE_RUNTIME_URL` 覆盖。
