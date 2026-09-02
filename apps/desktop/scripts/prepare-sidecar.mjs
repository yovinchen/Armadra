import { copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "../../..");

// Every Rust binary bundled next to the app. Keep in sync with
// `bundle.externalBin` in tauri.conf.json.
const sidecars = [
  { package: "ai-coding-canvas-runtime", binary: "ai-coding-canvas-runtime" },
  // Hook client injected into agent terminals; see docs/v3-agent-terminal-plan.md 5.3.
  { package: "aicc-hook", binary: "aicc-hook" },
];

const verbose = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = verbose.match(/^host:\s*(.+)$/m)?.[1];
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || host;
if (!target) throw new Error("Could not determine the Rust host target triple");

const explicitTarget =
  target !== host || Boolean(process.env.CARGO_BUILD_TARGET);
const buildArgs = ["build", "--release"];
for (const sidecar of sidecars) buildArgs.push("-p", sidecar.package);
if (explicitTarget) buildArgs.push("--target", target);
execFileSync("cargo", buildArgs, {
  cwd: repository,
  stdio: "inherit",
});

const extension = target.includes("windows") ? ".exe" : "";
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? resolve(repository, process.env.CARGO_TARGET_DIR)
  : resolve(repository, "target");

for (const sidecar of sidecars) {
  const source = resolve(
    targetDirectory,
    explicitTarget ? target : "",
    `release/${sidecar.binary}${extension}`,
  );
  const destination = resolve(
    repository,
    "target",
    `release/${sidecar.binary}-${target}${extension}`,
  );
  if (!existsSync(source))
    throw new Error(`Sidecar binary was not built: ${source}`);
  copyFileSync(source, destination);
  console.log(`Prepared Tauri sidecar: ${destination}`);
}
