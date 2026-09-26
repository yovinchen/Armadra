import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

/**
 * 把 core 的真入口打成一个 CJS 包，用来在本机子进程里跑 `worker --stdio`。
 *
 * 打包而不是直接跑源码，是因为源码里有 Node 只剥类型时不认的语法（参数属性），
 * 而远端真正执行的本来就是 `out/core/main.js` 这样一份包——测的正是它。输出放在
 * 桌面包目录下，好让包里对 `node-pty` 这类外部依赖的 `require` 能解析到。
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "../../..");

let built: Promise<string> | undefined;
let output: string | undefined;

export function workerBundle(): Promise<string> {
  built ??= (async () => {
    const cache = join(desktop, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    const outDir = mkdtempSync(join(cache, "armadra-worker-"));
    output = outDir;
    await build({
      configFile: false,
      logLevel: "silent",
      root: desktop,
      build: {
        outDir,
        emptyOutDir: true,
        target: "node22",
        ssr: true,
        minify: false,
        rollupOptions: {
          input: { main: resolve(desktop, "src/core/main.ts") },
          external: ["electron", "node-pty"],
          output: { format: "cjs", entryFileNames: "[name].js" },
        },
      },
      ssr: { noExternal: true },
    });
    return join(outDir, "main.js");
  })();
  return built;
}

let builtHook: Promise<string> | undefined;
let hookOutput: string | undefined;

/**
 * Hook 客户端（`armadra-hook.js`）的包：远端画布注入把它同步到执行主机上，由那边
 * 的 node 跑。与 `electron.vite.config.ts` 里的第五个目标同一个入口与格式。
 */
export function hookClientBundle(): Promise<string> {
  builtHook ??= (async () => {
    const cache = join(desktop, "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    const outDir = mkdtempSync(join(cache, "armadra-hook-"));
    hookOutput = outDir;
    await build({
      configFile: false,
      logLevel: "silent",
      root: desktop,
      build: {
        outDir,
        emptyOutDir: true,
        target: "node22",
        ssr: true,
        minify: false,
        rollupOptions: {
          input: {
            "armadra-hook": resolve(desktop, "src/cli/armadra-hook/main.ts"),
          },
          external: ["electron", "node-pty"],
          output: { format: "cjs", entryFileNames: "[name].js" },
        },
      },
      ssr: { noExternal: true },
    });
    return join(outDir, "armadra-hook.js");
  })();
  return builtHook;
}

/**
 * 起一个真 Worker 子进程；stdio 就是控制端与它之间的整条连接。`extra` 追加在
 * `worker --stdio` 之后，例如语言连接的 `--language-link`。
 */
export async function spawnWorker(
  extra: readonly string[] = [],
): Promise<() => ChildProcess> {
  const bundle = await workerBundle();
  return () =>
    spawn(process.execPath, [bundle, "worker", "--stdio", ...extra], {
      stdio: ["pipe", "pipe", "inherit"],
    });
}

/** 删掉打出来的包；每个用到它的测试文件在 `afterAll` 里调。 */
export function disposeWorkerBundle(): void {
  if (output !== undefined) rmSync(output, { recursive: true, force: true });
  output = undefined;
  built = undefined;
  if (hookOutput !== undefined) {
    rmSync(hookOutput, { recursive: true, force: true });
  }
  hookOutput = undefined;
  builtHook = undefined;
}
