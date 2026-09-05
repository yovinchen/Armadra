/**
 * latest.json — the static manifest Tauri's updater reads.
 *
 * Only the desktop bundles that can actually be applied in place appear in it:
 * the macOS `.app.tar.gz`, the Windows NSIS installer and the Linux AppImage.
 * A `.deb`, `.rpm` or `.msi` is installed and updated by a package manager, and
 * listing one here would offer an update the updater cannot perform.
 *
 * Every platform entry needs a signature. An unsigned bundle is left out with
 * a stated reason rather than published without one: the updater's only
 * protection is that signature, and a manifest entry without it is an offer to
 * install whatever the endpoint happens to serve.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktopAssets } from "./artifacts.mjs";

/** Tauri names platforms "<os>-<arch>" with its own spelling of the OS. */
const PLATFORM_OS = { darwin: "darwin", linux: "linux", windows: "windows" };

/** The platform key Tauri's updater looks up, derived from a release target. */
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
      // Tauri stores the whole detached signature file, base64-encoded, in the
      // manifest rather than a path to it.
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
