/**
 * latest.json — the static manifest the desktop updater reads.
 *
 * Only the desktop bundles that can actually be applied in place appear in it:
 * the macOS zip, the Windows NSIS installer and the Linux AppImage
 * (`artifacts.mjs`'s `desktopAssets()` marks exactly one per platform). A
 * `.deb` or `.rpm` is installed and updated by a package manager, a `.dmg` is
 * a disk image and the Windows zip records no install location — listing any
 * of them would offer an update the updater cannot perform.
 *
 * Every platform entry needs a signature, which `assemble.mjs` produces over
 * the staged directory before it calls this. An unsigned bundle is left out
 * with a stated reason rather than published without one: a manifest entry
 * without a signature is an offer to install whatever the endpoint serves.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopAssets } from "./artifacts.mjs";

/** Platforms are named "<os>-<arch>", the same spelling the Host uses. */
const PLATFORM_OS = { darwin: "darwin", linux: "linux", windows: "windows" };

/** The platform key the updater looks up, derived from a release target. */
export function platformKey(target) {
  const [system, arch] = target.split("-");
  const os = PLATFORM_OS[system];
  if (!os) throw new Error(`no updater platform for target ${target}`);
  return `${os}-${arch}`;
}

/**
 * Build the manifest from a directory of release assets.
 *
 * `downloadUrl` turns an asset name into the URL clients fetch; the caller
 * supplies it because the release URL is not knowable from the files.
 */
export function buildManifest({
  directory,
  version,
  notes,
  downloadUrl,
  targets,
  pub = "",
}) {
  const platforms = {};
  const skipped = [];
  for (const target of targets) {
    const updater = desktopAssets(version, target).find(
      (asset) => asset.updater,
    );
    if (!updater) continue;
    const bundle = join(directory, updater.name);
    let signature;
    try {
      // The whole detached signature file goes into the manifest, not a path
      // to it: a client that has the manifest has everything it needs to
      // verify, without a second fetch that could be answered differently.
      signature = readFileSync(
        join(directory, `${updater.name}.sig`),
        "utf8",
      ).trim();
    } catch {
      skipped.push({ target, asset: updater.name, reason: "signatureMissing" });
      continue;
    }
    try {
      readFileSync(bundle);
    } catch {
      skipped.push({ target, asset: updater.name, reason: "bundleMissing" });
      continue;
    }
    platforms[platformKey(target)] = {
      signature,
      url: downloadUrl(updater.name),
    };
  }
  const manifest = {
    version,
    notes: String(notes ?? "").trim(),
    pub_date: new Date(0).toISOString(),
    platforms,
  };
  if (pub) manifest.pub_date = pub;
  return { manifest, skipped };
}

/** Write latest.json, sorted so two runs of one release produce one file. */
export function writeManifest(options) {
  const { manifest, skipped } = buildManifest(options);
  const ordered = {
    version: manifest.version,
    notes: manifest.notes,
    pub_date: manifest.pub_date,
    platforms: Object.fromEntries(
      Object.keys(manifest.platforms)
        .sort()
        .map((key) => [key, manifest.platforms[key]]),
    ),
  };
  const path = join(options.directory, "latest.json");
  writeFileSync(path, JSON.stringify(ordered, null, 2) + "\n");
  return { path, manifest: ordered, skipped };
}
