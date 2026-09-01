import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 与 vite.config.ts / tsconfig.app.json 的 paths 保持一致：
      // src/ui 下 shadcn 生成的组件之间用 `@/` 互相引用。
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    // import 会被提升，tldraw 在模块顶层就读 `matchMedia`，所以这一类补丁
    // 必须在 setupFiles 里打，测试文件内的 `installDomPolyfills()` 太晚了。
    setupFiles: ["./src/app/test-setup.ts"],
  },
});
