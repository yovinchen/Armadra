/**
 * Rename Tauri's bundler output to the names a release publishes.
 *
 *   node tools/release/stage-desktop.mjs --target <os>-<arch> --triple <triple> \
 *     --from <release dir> --out <dir> [--version X.Y.Z] [--require-updater]
 *
 * The bundler names files after the platform's own conventions —
 * `Armadra_0.1.0_x64_en-US.msi`, `armadra_0.1.0_amd64.deb`,
 * `Armadra_0.1.0_aarch64.dmg` — and none of those spellings contain a target
 * the Host can read: `assetTarget` finds nothing in `x64`, `amd64` or a bare
 * `aarch64`. Uploading them as they come off the bundler produces a release
 * whose desktop assets the Host will never offer, which is a failure that only
 * shows up in a client weeks later. So every bundle is looked up by kind and
 * copied to the one name `artifacts.mjs` declares, and anything expected but
 * absent stops the job here instead.
 *
 * The Windows portable zip has no bundler output behind it. It is the plain
 * `release/` executable plus its sidecars, because the shell resolves
 * `armadra-host` (and the Worker, the hook and the session host) *next to its
 * own executable* in a production build — a zip holding only `Armadra.exe`
 * would start and then fail to find anything it needs.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rustSidecars } from "../../apps/desktop/scripts/sidecar-targets.mjs";
import { desktopAssets } from "./artifacts.mjs";
import { zipCommand } from "./package-components.mjs";
import { workspaceVersion } from "./version.mjs";

/**
 * Where the bundler writes each kind, and how its file is recognised there.
 *
 * Matching on a suffix rather than a full name is deliberate: the bundler's
 * names carry a locale (`_en-US.msi`), a lower-cased product name (`.deb`) and
 * an architecture spelling of its own, and pinning any of those would make the
 * release break the next time Tauri changes one.
 */
export const BUNDLE_KINDS = {
  "app.tar.gz": { directory: "macos", suffix: ".app.tar.gz" },
  dmg: { directory: "dmg", suffix: ".dmg" },
  nsis: { directory: "nsis", suffix: "-setup.exe" },
  msi: { directory: "msi", suffix: ".msi" },
  appimage: { directory: "appimage", suffix: ".AppImage" },
  deb: { directory: "deb", suffix: ".deb" },
  rpm: { directory: "rpm", suffix: ".rpm" },
};

/** The one file of this kind under `bundle/`, or null when nothing matched. */
export function findBundle({ bundle, kind }) {
  const spec = BUNDLE_KINDS[kind];
  if (!spec) return null;
  const directory = join(bundle, spec.directory);
  if (!existsSync(directory)) return null;
  const matches = readdirSync(directory)
    .filter((name) => name.endsWith(spec.suffix))
    .sort();
  return matches.length === 0 ? null : join(directory, matches[0]);
}

/**
 * The binaries a Windows portable zip carries beside the main executable.
 *
 * The same list the installer bundles, from the same place: `rustSidecars`
 * decides which Rust sidecars a triple ships, and the Go Host is always one.
 */
export function portableBinaries(triple) {
  return [...rustSidecars(triple).map((entry) => entry.binary), "armadra-host"];
}

/**
 * Build the portable zip. `from` is the cargo release directory, where the
 * sidecars are staged with their triple suffix and the shell without one.
 */
export function stagePortable({ from, triple, out, assetName }) {
  const staging = mkdtempSync(join(tmpdir(), "armadra-portable-"));
  try {
    const missing = [];
    const names = [];
    const main = join(from, "Armadra.exe");
    if (existsSync(main)) {
      copyFileSync(main, join(staging, "Armadra.exe"));
      names.push("Armadra.exe");
    } else missing.push("Armadra.exe");
    for (const binary of portableBinaries(triple)) {
      // Tauri's externalBin staging writes `<binary>-<triple>.exe`; next to the
      // installed shell the same file is named without the triple, and that is
      // the name the shell looks for.
      const source = join(from, `${binary}-${triple}.exe`);
      const fallback = join(from, `${binary}.exe`);
      const found = existsSync(source)
        ? source
        : existsSync(fallback)
          ? fallback
          : null;
      if (!found) {
        missing.push(`${binary}.exe`);
        continue;
      }
      copyFileSync(found, join(staging, `${binary}.exe`));
      names.push(`${binary}.exe`);
    }
    if (missing.length > 0)
      throw new Error(
        `portable zip is missing ${missing.join(", ")} in ${from}; build the desktop bundle first`,
      );
    mkdirSync(out, { recursive: true });
    const output = resolve(out, assetName);
    rmSync(output, { force: true });
    const zip = zipCommand();
    // Relative names from the staging directory keep the archive flat: every
    // entry sits at the top level, which is where the shell expects to find
    // its neighbours.
    execFileSync(zip.command, zip.argv(output, ...names.sort()), {
      stdio: "inherit",
      cwd: staging,
    });
    return output;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Copy every desktop bundle this target publishes into `out` under its
 * published name, with the detached Tauri signature beside it when there is one.
 *
 * `requireUpdater` is false for an unsigned build: `signing.mjs` turns
 * `createUpdaterArtifacts` off when there is no key, so the macOS
 * `.app.tar.gz` is not produced at all and its absence is expected rather than
 * a failure.
 */
export function stageDesktop({
  target,
  triple,
  bundle,
  from,
  out,
  version,
  requireUpdater = false,
}) {
  mkdirSync(out, { recursive: true });
  const staged = [];
  const missing = [];
  for (const asset of desktopAssets(version, target)) {
    if (asset.kind === "portable") {
      staged.push({
        kind: asset.kind,
        name: asset.name,
        path: stagePortable({ from, triple, out, assetName: asset.name }),
        signature: false,
      });
      continue;
    }
    const source = findBundle({ bundle, kind: asset.kind });
    if (!source) {
      if (asset.updater && !requireUpdater) continue;
      missing.push(`${asset.kind} (for ${asset.name})`);
      continue;
    }
    const destination = join(out, asset.name);
    copyFileSync(source, destination);
    // Tauri writes the updater signature next to the bundle. It is a release
    // asset in its own right: `updater-manifest.mjs` reads it back to build
    // latest.json, and a bundle whose signature did not travel with it is one
    // the updater will refuse.
    const signature = existsSync(`${source}.sig`);
    if (signature) copyFileSync(`${source}.sig`, `${destination}.sig`);
    else if (asset.updater && requireUpdater) missing.push(`${asset.name}.sig`);
    staged.push({
      kind: asset.kind,
      name: asset.name,
      path: destination,
      signature,
    });
  }
  return { staged, missing };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function main(argv) {
  const target = flag(argv, "target");
  const triple = flag(argv, "triple");
  const from = flag(argv, "from") || "target/release";
  const out = flag(argv, "out");
  if (!target || !triple || !out) {
    console.error(
      "usage: node tools/release/stage-desktop.mjs --target <os>-<arch> --triple <triple> --out <dir> [--from <release dir>] [--bundle <dir>] [--version X.Y.Z] [--require-updater]",
    );
    return 2;
  }
  const { staged, missing } = stageDesktop({
    target,
    triple,
    bundle: resolve(flag(argv, "bundle") || join(from, "bundle")),
    from: resolve(from),
    out: resolve(out),
    version: flag(argv, "version") || workspaceVersion(),
    requireUpdater: argv.includes("--require-updater"),
  });
  for (const item of staged)
    console.log(
      `Staged ${item.kind}: ${item.name}${item.signature ? " (+ .sig)" : ""}`,
    );
  if (missing.length > 0) {
    console.error(`✗ not produced for ${target}: ${missing.join(", ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
