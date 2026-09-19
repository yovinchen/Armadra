import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { type Plugin, type UserConfig, build } from "vite";
import webConfig from "../web/vite.config";

const here = __dirname;
const web = resolve(here, "../web");

/**
 * Two rules for the main and preload bundles, both learned the hard way:
 *
 *   1. `electron` is a devDependency, so `externalizeDepsPlugin` — which reads
 *      `dependencies` — does not externalize it. Left alone, the npm wrapper
 *      at `node_modules/electron/index.js` gets bundled in and the app tries
 *      to download Electron at runtime. It has to be listed explicitly.
 *   2. Native modules' internal `require()` calls use relative paths that
 *      break once bundled, so they stay external too. `node-pty` is the first
 *      one (R2, the terminal domain): it resolves `build/Release/pty.node` and
 *      `build/Release/spawn-helper` relative to its own file, and a bundled
 *      copy would look for both next to `out/core/main.js`. It is therefore
 *      external here **and** unpacked from the asar in
 *      `electron-builder.yml` — the two have to move together.
 */
const EXTERNAL = ["electron", "node-pty"];

/**
 * Workspace packages go the other way: they must be BUNDLED. A packaged app
 * has no `node_modules/@armadra/*` to require, and `@armadra/protocol` is
 * ESM-only — its `exports` declares no `require` condition, so a CJS main
 * process cannot load it at runtime even in development.
 */
const BUNDLED_WORKSPACE_PACKAGES = ["@armadra/protocol"];

/**
 * CJS output for both. electron-vite defaults to ESM (`.mjs`), and an
 * asar-packaged Electron app needs a CJS entry point for the main process and
 * for the preload script.
 */
const cjs = {
  format: "cjs" as const,
  entryFileNames: "[name].js",
};

/**
 * The renderer is `apps/web`, verbatim. Its config is imported and called
 * rather than re-declared: it owns the React and Tailwind plugins, the `@`
 * alias, the rolldown chunk groups, and the dev-server proxy that finds the
 * Runtime through `endpoints.json`. A second copy of any of that here would
 * drift, and the shell is not allowed to change how the front end builds.
 *
 * In dev this serves apps/web on 127.0.0.1:1420 and electron-vite hands the
 * URL to the main process as `ELECTRON_RENDERER_URL`. In a build it produces
 * the same artifacts `pnpm --filter @armadra/web build` would, into
 * `out/renderer`, which the packaged window loads from disk.
 *
 * `ARMADRA_DESKTOP_EXTERNAL_RENDERER=1` drops the renderer target entirely,
 * for the flow where `pnpm --filter @armadra/web dev` is already running on
 * 1420 — apps/web pins `strictPort`, so two servers cannot share it.
 */
const externalRenderer = process.env.ARMADRA_DESKTOP_EXTERNAL_RENDERER === "1";

function renderer(command: "serve" | "build", mode: string): UserConfig {
  const base = webConfig({ command, mode }) as UserConfig;
  const build = base.build ?? {};
  return {
    ...base,
    root: web,
    build: {
      ...build,
      outDir: resolve(here, "out/renderer"),
      emptyOutDir: true,
      // Vite 8 builds with rolldown, so the entry belongs in
      // `rolldownOptions` — `rollupOptions` is the deprecated spelling and
      // electron-vite would report the input as missing. apps/web's own
      // `codeSplitting.groups` live on the same object and must survive.
      rolldownOptions: {
        ...build.rolldownOptions,
        input: { index: resolve(web, "index.html") },
      },
    },
  };
}

/**
 * The fourth target: the Electron-free core.
 *
 * It is built here rather than in its own tool because it shares this shell's
 * `node_modules` and, from R2, this shell's native-module rebuild. But it is
 * emitted as its own entry so that `node out/core/main.js` runs it directly —
 * which is both how the server shell will start it and how a developer can
 * exercise it without a window.
 *
 * `electron` stays external even though the core never imports it: if a stray
 * import ever appears, an external reference fails loudly at require time
 * instead of quietly bundling the npm wrapper. The real guard is the source
 * scan in `shell-core/no-electron.test.ts`, which covers `src/core/**`.
 *
 * `ws` and `node:sqlite` need nothing here: `ws` is pure JavaScript and is
 * bundled, and `node:sqlite` is built into Node, which is the whole reason it
 * was chosen. `node-pty` is the one exception and is in `EXTERNAL` above,
 * with the matching `asarUnpack` entry in `electron-builder.yml`.
 *
 * electron-vite itself only knows three targets, so the core rides along as a
 * plugin on the main build: one extra `vite build` after the main bundle
 * closes, in both `build` and `dev` (where the main target is a watcher, so the
 * core rebuilds with it).
 */
const coreConfig: UserConfig = {
  // The core is not a renderer and must not inherit a web target's defaults.
  build: {
    outDir: resolve(here, "out/core"),
    emptyOutDir: true,
    target: "node22",
    ssr: true,
    rollupOptions: {
      input: { main: resolve(here, "src/core/main.ts") },
      external: EXTERNAL,
      output: cjs,
    },
  },
  ssr: { noExternal: true },
};

function buildCore(): Plugin {
  return {
    name: "armadra-core-bundle",
    apply: "build",
    async closeBundle() {
      await build(coreConfig);
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES }),
      buildCore(),
    ],
    build: {
      rollupOptions: {
        input: { index: resolve(here, "src/main/index.ts") },
        external: EXTERNAL,
        output: cjs,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES })],
    build: {
      rollupOptions: {
        input: { index: resolve(here, "src/preload/index.ts") },
        external: EXTERNAL,
        output: cjs,
      },
    },
  },
  ...(externalRenderer ? {} : { renderer: renderer(command, mode) }),
}));
