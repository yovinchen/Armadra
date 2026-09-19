/**
 * Rename electron-builder's output to the names a release publishes.
 *
 *   node tools/release/stage-desktop.mjs --target <os>-<arch> \
 *     --from <release dir> --out <dir> [--version X.Y.Z] [--require-updater]
 *
 * electron-builder names files after each platform's own conventions —
 * `Armadra-0.1.0-arm64.dmg`, `Armadra Setup 0.1.0.exe`,
 * `armadra_0.1.0_amd64.deb` — and none of those spellings contains a target
 * the Host can read: `assetTarget` finds nothing in `arm64` or `amd64`, and
 * one of them has a space in it. Uploading them as they come off the packager
 * produces a release whose desktop assets the Host will never offer, which is
 * a failure that only shows up in a client weeks later. So every bundle is
 * looked up by kind and copied to the one name `artifacts.mjs` declares, and
 * anything expected but absent stops the job here instead.
 *
 * Unlike the packager this replaced, everything lands in ONE flat directory
 * (`electron-builder.yml`'s `directories.output`), beside files that are not
 * release assets at all: `latest*.yml`, `*.blockmap`, `builder-*.yml` and the
 * `*-unpacked` directories. Matching is therefore by extension AND an explicit
 * ignore list, not by "the only file in its own folder".
 *
 * Nothing here handles signatures. electron-builder signs the bundle itself
 * with the platform's own code signature; the detached minisign signature the
 * updater manifest carries is produced later, over the whole staged directory,
 * by `assemble.mjs` (`sign.mjs`) — one key system for the release rather than
 * two.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopAssets } from "./artifacts.mjs";
import { workspaceVersion } from "./version.mjs";

/**
 * How each electron-builder target's file is recognised in the output
 * directory. The keys are the `kind` values `desktopAssets()` declares, which
 * are themselves the `target` values in `electron-builder.yml`.
 *
 * Matching on an extension rather than a full name is deliberate: the
 * packager's names carry a product name cased its own way, an architecture
 * spelling of its own and sometimes a space, and pinning any of those would
 * break the release the next time electron-builder changes one.
 *
 * `zip` is ambiguous by extension alone only across platforms, and a release
 * job builds one platform, so the target being staged settles it.
 */
export const BUNDLE_KINDS = {
  zip: { suffix: ".zip" },
  dmg: { suffix: ".dmg" },
  nsis: { suffix: ".exe" },
  AppImage: { suffix: ".AppImage" },
  deb: { suffix: ".deb" },
  rpm: { suffix: ".rpm" },
};

/**
 * Files in the output directory that are not release assets.
 *
 * `latest*.yml` is electron-updater's own manifest, which this release does
 * not publish (it publishes `latest.json`, written by `updater-manifest.mjs`);
 * `.blockmap` is its differential-download index, useless without that
 * manifest; `builder-*.yml` and `builder-debug.yml` are packaging debris.
 * Staging any of them would put a file in the release the Host cannot place.
 */
export function isReleaseAsset(name) {
  if (name.endsWith(".blockmap")) return false;
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return false;
  if (name.endsWith(".unpacked") || name.includes("-unpacked")) return false;
  return true;
}

/** The one file of this kind in the output directory, or null. */
export function findBundle({ bundle, kind }) {
  const spec = BUNDLE_KINDS[kind];
  if (!spec || !existsSync(bundle)) return null;
  const matches = readdirSync(bundle)
    .filter((name) => isReleaseAsset(name) && name.endsWith(spec.suffix))
    .sort();
  return matches.length === 0 ? null : join(bundle, matches[0]);
}

/**
 * Copy every desktop bundle this target publishes into `out` under its
 * published name.
 *
 * `requireUpdater` is false for an unsigned build. It no longer changes which
 * bundles the packager produces — electron-builder writes the zip, the
 * installer and the AppImage whether or not a certificate was available — so
 * it only decides whether a MISSING updater bundle is tolerated, which is the
 * case where packaging half-finished rather than the case where signing was
 * skipped.
 */
export function stageDesktop({
  target,
  bundle,
  out,
  version,
  requireUpdater = false,
}) {
  mkdirSync(out, { recursive: true });
  const staged = [];
  const missing = [];
  for (const asset of desktopAssets(version, target)) {
    const source = findBundle({ bundle, kind: asset.kind });
    if (!source) {
      if (asset.updater && !requireUpdater) continue;
      missing.push(`${asset.kind} (for ${asset.name})`);
      continue;
    }
    const destination = join(out, asset.name);
    copyFileSync(source, destination);
    staged.push({ kind: asset.kind, name: asset.name, path: destination });
  }
  return { staged, missing };
}

function flag(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

function main(argv) {
  const target = flag(argv, "target");
  const from = flag(argv, "from") || "apps/desktop/release";
  const out = flag(argv, "out");
  if (!target || !out) {
    console.error(
      "usage: node tools/release/stage-desktop.mjs --target <os>-<arch> --out <dir> [--from <output dir>] [--version X.Y.Z] [--require-updater]",
    );
    return 2;
  }
  const { staged, missing } = stageDesktop({
    target,
    bundle: resolve(from),
    out: resolve(out),
    version: flag(argv, "version") || workspaceVersion(),
    requireUpdater: argv.includes("--require-updater"),
  });
  for (const item of staged) console.log(`Staged ${item.kind}: ${item.name}`);
  if (missing.length > 0) {
    console.error(`✗ not produced for ${target}: ${missing.join(", ")}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
