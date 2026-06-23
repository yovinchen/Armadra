import { copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "../../..");

const verbose = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = verbose.match(/^host:\s*(.+)$/m)?.[1];
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || host;
if (!target) throw new Error("Could not determine the Rust host target triple");

const explicitTarget =
  target !== host || Boolean(process.env.CARGO_BUILD_TARGET);
const buildArgs = ["build", "--release", "-p", "ai-coding-canvas-runtime"];
if (explicitTarget) buildArgs.push("--target", target);
execFileSync("cargo", buildArgs, {
  cwd: repository,
  stdio: "inherit",
});

const extension = target.includes("windows") ? ".exe" : "";
const targetDirectory = process.env.CARGO_TARGET_DIR
  ? resolve(repository, process.env.CARGO_TARGET_DIR)
  : resolve(repository, "target");
const source = resolve(
  targetDirectory,
  explicitTarget ? target : "",
  `release/ai-coding-canvas-runtime${extension}`,
);
const destination = resolve(
  repository,
  "target",
  `release/ai-coding-canvas-runtime-${target}${extension}`,
);
if (!existsSync(source))
  throw new Error(`Runtime binary was not built: ${source}`);
copyFileSync(source, destination);
console.log(`Prepared Tauri sidecar: ${destination}`);
