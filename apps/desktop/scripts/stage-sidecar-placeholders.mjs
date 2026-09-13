/**
 * Empty stand-ins for the Tauri `externalBin` entries.
 *
 *   node apps/desktop/scripts/stage-sidecar-placeholders.mjs
 *
 * `tauri-build` refuses to run when a configured sidecar is missing, so even
 * `cargo check -p armadra-desktop` needs the four files to exist. Building them
 * for real costs a full `--release` compile of the Runtime, the hook client and
 * the Go Host, which is the wrong price for a type check: CI runs this instead
 * and keeps `prepare:sidecar` for the jobs that actually produce a bundle.
 *
 * The files are deliberately empty. Anything that packages them would ship a
 * broken application, so never run this before `tauri build`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repository, rustHost } from "./prepare-host.mjs";
import {
  rustSidecars,
  selectTarget,
  sidecarPaths,
} from "./sidecar-targets.mjs";

/** Stage one empty file per sidecar the given target ships. */
export function stagePlaceholders({
  root = repository,
  env = process.env,
  host = rustHost(),
  target,
} = {}) {
  const selected = target ?? selectTarget({ host, env });
  const binaries = [
    ...rustSidecars(selected.triple).map((sidecar) => sidecar.binary),
    "armadra-host",
  ];
  const staged = [];
  for (const binary of binaries) {
    const { destination } = sidecarPaths({
      repository: root,
      env,
      target: selected,
      binary,
    });
    mkdirSync(dirname(destination), { recursive: true });
    // A real binary from an earlier build is worth more than an empty file.
    if (!existsSync(destination)) writeFileSync(destination, "");
    staged.push(destination);
  }
  return staged;
}

export function main() {
  for (const path of stagePlaceholders())
    console.log(`Staged empty Tauri sidecar placeholder: ${path}`);
  console.warn(
    "These placeholders are empty: use prepare:sidecar before packaging.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
