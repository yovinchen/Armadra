import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Runtime 数据目录，与 apps/runtime/src/paths.rs 的 `data_dir` 一致。
 */
function runtimeDataDir(): string {
  const override = process.env.ARMADRA_DATA_DIR;
  if (override) return override;
  if (platform() === "darwin")
    return join(homedir(), "Library/Application Support/Armadra");
  if (platform() === "win32")
    return join(process.env.LOCALAPPDATA ?? homedir(), "Armadra");
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
    "armadra",
  );
}

/**
 * 开发服务器把 Runtime 请求转发到它这次实际监听的地址（roadmap §4.4）：
 * 端口默认由内核分配，只有 `<数据目录>/endpoints.json` 知道是哪个。
 *
 * 显式 `VITE_RUNTIME_URL` 优先——那时前端直连，不需要代理。文件缺失或损坏也
 * 不装代理：前端退回它自己的默认地址，行为和以前一样。
 */
function runtimeProxyTarget(): string | null {
  if (process.env.VITE_RUNTIME_URL !== undefined) return null;
  try {
    const document: unknown = JSON.parse(
      readFileSync(join(runtimeDataDir(), "endpoints.json"), "utf8"),
    );
    const http = (document as { runtime?: { http?: unknown } })?.runtime?.http;
    if (typeof http !== "string") return null;
    const url = new URL(http);
    // 只接受回环 HTTP：这里装的是本机开发代理，不是通用反向代理。
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

const runtimeTarget = runtimeProxyTarget();

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
    return (
      !rest.startsWith("@codemirror/lang-") &&
      !rest.startsWith("@codemirror/lsp-client")
    );
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
    name: "language",
    // 排在 `codemirror` 之后：`isCodeMirrorCore` 已经把 lsp-client 排除掉，
    // 所以这一组只收它自己和它渲染 hover 文档用的 `marked`。放在前面会让
    // 编辑器内核被吸进这一块，反过来变成「打开编辑器就加载 LSP 客户端」。
    // 语言服务设计 §2.4 的体积门槛量的就是这个 chunk。
    priority: 25,
    test: /[\\/]node_modules[\\/](@codemirror[\\/]lsp-client|marked)[\\/]/,
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
    name: "xyflow",
    priority: 30,
    // React Flow 与它的运行时依赖：`@xyflow/system`、d3 的三个手势包、
    // `classcat`、以及 RF 自带的 zustand 4（与应用的 zustand 5 各自独立）。
    test: /[\\/]node_modules[\\/](@xyflow|d3-drag|d3-selection|d3-zoom|d3-transition|d3-ease|d3-interpolate|d3-timer|d3-color|d3-dispatch|classcat|perfect-freehand)[\\/]/,
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

// 代理与 `VITE_RUNTIME_URL` 的覆盖只属于开发服务器：生产构建（打包桌面壳）
// 必须让页面在运行时按来源自己解析 Runtime 地址，否则本机碰巧在跑的一个
// 开发 Runtime 会把「空地址」烤进产物，壳里一启动就报错。
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn CLI 生成的组件用 `@/` 引用彼此，别名必须和
      // tsconfig.app.json 的 paths 保持一致。
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
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
  // 代理装上时前端用自己的源，请求由 Vite 转给 Runtime；没装就保持原来的默认。
  define:
    command === "serve" && runtimeTarget
      ? { "import.meta.env.VITE_RUNTIME_URL": '""' }
      : undefined,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy:
      command === "serve" && runtimeTarget
        ? {
            // `ws` 让终端与工作空间事件流也走同一条路。
            "/api": { target: runtimeTarget, ws: true, changeOrigin: false },
            "/health": { target: runtimeTarget, changeOrigin: false },
          }
        : undefined,
  },
}));
