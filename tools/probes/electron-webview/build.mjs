// Bundles the renderer (React 19 + React Flow 12) into renderer/dist/.
// Kept deliberately tiny: the probe is not a product, it only needs a real canvas.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, "renderer/app.jsx")],
  bundle: true,
  outfile: join(here, "renderer/dist/app.js"),
  format: "iife",
  platform: "browser",
  target: ["chrome130"],
  jsx: "automatic",
  loader: { ".js": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
