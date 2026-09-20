import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

/**
 * 把服务器壳打成一个 `out/main.js`。
 *
 * 选型是 **esbuild**：core 与桌面壳共用的 electron-vite 底下也是它，同一个
 * bundler 意味着「什么该外部化」这条规则不会在两种壳之间分叉。输出是 CJS，因为
 * 入口用 `require.main === module` 判断自己是不是进程入口，而 core 的桌面产物
 * 也是 CJS。
 *
 * `--external` 的三类：
 *
 *   * **原生模块**（`node-pty`）。它按自己的相对路径找 `build/Release/*.node`，
 *     打进 bundle 之后那些路径就指向 `out/` 了。
 *   * **可选的原生加速**（`bufferutil`、`utf-8-validate`），`ws` 只在装了的时候
 *     才用它们。
 *   * **Electron**。core 一行都不 import 它（`core/no-electron.test.ts` 扫这件
 *     事），列在这里只是为了让误引入在构建期就炸，而不是在运行期。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "out/main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["node-pty", "bufferutil", "utf-8-validate", "electron"],
  /**
   * 这个进程的入口是服务器壳，不是 core。
   *
   * core 与壳各有一个 `require.main === module` 的入口判断，而 esbuild 把两
   * 个模块**内联进同一个 CommonJS 文件**：`module` 是同一个对象，于是两个判
   * 断同时成立。core 会去解析壳的命令行，在 `serve` 上失败并
   * `process.exit(1)`，壳一个请求都还没服务过。banner 在 bundle 正文之前执
   * 行，所以 core 的判断读到它时已经写好了。
   */
  banner: { js: 'globalThis.__armadraShellEntry = "server";' },
  logLevel: "info",
});
