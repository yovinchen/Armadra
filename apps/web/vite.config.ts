import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 手工分组（§17「代码分割」）。Vite 8 用 rolldown，Rollup 的
 * `output.manualChunks` 已经弃用，等价物是
 * `build.rolldownOptions.output.codeSplitting.groups`。
 *
 * 目标只有一个：让入口 chunk 里只剩应用自己的主链路代码，几个大依赖各自成块，
 * 浏览器可以并行取、缓存也不会因为改一行业务代码就全失效。
 * 顺序即优先级（`priority` 越大越先匹配），路径匹配的是 pnpm 的实际磁盘路径。
 */
/** CodeMirror 内核（不含语言包与其语法包）。 */
function isCodeMirrorCore(id: string): boolean {
  const marker = id.lastIndexOf("node_modules");
  if (marker < 0) return false;
  const rest = id.slice(marker + "node_modules".length + 1).replace(/\\/g, "/");
  if (rest.startsWith("@codemirror/"))
    return !rest.startsWith("@codemirror/lang-");
  if (rest.startsWith("@lezer/")) {
    const name = rest.split("/")[1];
    return name === "common" || name === "highlight" || name === "lr";
  }
  return (
    rest.startsWith("codemirror/") ||
    rest.startsWith("style-mod/") ||
    rest.startsWith("w3c-keyname/") ||
    rest.startsWith("crelt/")
  );
}

const vendorGroups = [
  {
    name: "react-vendor",
    priority: 40,
    test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
  },
  {
    name: "codemirror",
    priority: 30,
    // 只收编辑器内核：`@codemirror/lang-*` 与对应的 `@lezer` 语法包是
    // EditorNode 按扩展名动态 `import()` 的，划进组里就等于又变回静态加载了。
    test: isCodeMirrorCore,
  },
  {
    name: "xterm",
    priority: 30,
    // 只收内核与两个必须在 `open` 之前就位的插件。webgl / search / clipboard /
    // web-links 是 TerminalSurface（terminal-compat 归属）动态 `import()` 的，
    // 划进组里就等于把它们又静态化了——实测差 152.8 kB。
    test: /[\\/]node_modules[\\/]@xterm[\\/](xterm|addon-fit|addon-unicode11)[\\/]/,
  },
  {
    name: "tldraw",
    priority: 30,
    // tldraw 5.4 的全部子包 + 它自带的运行时依赖（编辑器内核、状态、校验、
    // 富文本）。`@tldraw/assets` 只是一堆 `?url` 导入，不进 JS 组。
    test: /[\\/]node_modules[\\/](tldraw|@tldraw|@tiptap|prosemirror-.*|@use-gesture|classnames|hotkeys-js|idb|lodash\.isequal|nanoid|core-js|canvas-size)[\\/]/,
  },
  {
    name: "radix",
    priority: 20,
    test: /[\\/]node_modules[\\/](radix-ui|@radix-ui|@floating-ui|aria-hidden|react-remove-scroll|react-remove-scroll-bar|use-callback-ref|use-sidecar|get-nonce)[\\/]/,
  },
  {
    name: "markdown",
    priority: 20,
    test: /[\\/]node_modules[\\/](react-markdown|remark-.*|rehype-.*|micromark.*|mdast-.*|hast-.*|unified|unist-.*|vfile.*|bail|trough|devlop|decode-named-character-reference|character-entities.*|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|estree-util-is-identifier-name|ccount|markdown-table|longest-streak|zwitch|escape-string-regexp)[\\/]/,
  },
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn CLI 生成的组件用 `@/` 引用彼此，别名必须和
      // tsconfig.app.json 的 paths 保持一致。
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    // `@tldraw/assets/imports.vite` 全是 `./fonts/x.woff2?url` 这样的导入，
    // 依赖预打包（rolldown）不认 `?url` 后缀，会以 UNLOADABLE_DEPENDENCY 报错。
    // 排除掉，交给 vite 正常的资源管线处理，字体图标照样自托管。
    exclude: ["@tldraw/assets"],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: vendorGroups,
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
