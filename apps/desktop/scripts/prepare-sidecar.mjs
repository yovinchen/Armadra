import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { prepareHost, repository, rustHost } from "./prepare-host.mjs";
import { selectTarget, sidecarPaths } from "./sidecar-targets.mjs";

// Rust sidecars retain their existing cargo release build and target behavior.
const sidecars = [
  { package: "armadra-runtime", binary: "armadra-runtime" },
  { package: "armadra-hook", binary: "armadra-hook" },
];

export function main() {
  const target = selectTarget({ host: rustHost(), env: process.env });
  const buildArgs = ["build", "--release"];
  for (const sidecar of sidecars) buildArgs.push("-p", sidecar.package);
  if (target.explicitTarget) buildArgs.push("--target", target.triple);
  execFileSync("cargo", buildArgs, { cwd: repository, stdio: "inherit" });

  for (const sidecar of sidecars) {
    const { source, destination } = sidecarPaths({
      repository,
      env: process.env,
      target,
      binary: sidecar.binary,
    });
    if (!existsSync(source))
      throw new Error(`Sidecar binary was not built: ${source}`);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    console.log(`Prepared Tauri sidecar: ${destination}`);
  }
  prepareHost({ target, release: true });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
