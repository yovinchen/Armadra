/**
 * What a release publishes, and what each file is called.
 *
 * The names are load-bearing. The Host reads a component out of the prefix
 * before the first "_" and a target out of the "<os>-<arch>" segment after the
 * version, and it matches a detached signature by name plus ".sig". A file
 * named a little differently is not a slightly wrong download — it is an
 * artifact the Host cannot place, and it will refuse rather than guess.
 *
 * Keep this in step with updates.assetComponents and updates.assetTarget in
 * apps/host/internal/updates/source.go; artifacts.test.mjs asserts both ends.
 */

/** Every target a release builds for, in the contract's "<os>-<arch>" form. */
export const TARGETS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
  "windows-x86_64",
  "windows-aarch64",
];

/** Components published as a compressed archive of one program. */
export const COMPONENTS = [
  { component: "host", binary: "armadra-host", targets: TARGETS },
  { component: "worker", binary: "armadra-runtime", targets: TARGETS },
  { component: "hook", binary: "armadra-hook", targets: TARGETS },
  {
    component: "session-host",
    binary: "armadra-session-host",
    // Windows only: elsewhere tmux already owns sessions that outlive a shell,
    // and shipping a binary whose main refuses to run helps nobody.
    targets: TARGETS.filter((target) => target.startsWith("windows-")),
  },
];

/** The two files that describe a release rather than carry a program. */
export const MANIFEST_ASSETS = ["latest.json", "SHA256SUMS"];

/** The archive extension a target uses. */
export function archiveExtension(target) {
  return target.startsWith("windows-") ? ".zip" : ".tar.gz";
}

/** The executable name inside an archive. */
export function binaryName(binary, target) {
  return target.startsWith("windows-") ? `${binary}.exe` : binary;
}

/** The published name of one component archive. */
export function componentAsset({ binary, version, target }) {
  return `${binary}_${version}_${target}${archiveExtension(target)}`;
}

/** The published name of the built web bundle, which has no target. */
export function webAsset(version) {
  return `armadra-web_${version}.tar.gz`;
}

/**
 * Every component archive a release publishes, with the component the Host
 * will read back out of each name.
 */
export function componentAssets(version) {
  const assets = [];
  for (const entry of COMPONENTS) {
    for (const target of entry.targets) {
      assets.push({
        component: entry.component,
        binary: entry.binary,
        target,
        name: componentAsset({ binary: entry.binary, version, target }),
      });
    }
  }
  assets.push({
    component: "web",
    binary: "armadra-web",
    target: "",
    name: webAsset(version),
  });
  return assets;
}

/**
 * The component a published name declares, mirroring the Host's own reading.
 * A name that follows no convention declares none, and nothing matches it.
 */
export function assetComponent(name) {
  if (MANIFEST_ASSETS.includes(name)) return "manifest";
  const separator = name.indexOf("_");
  if (separator < 0) return "";
  const prefixes = {
    Armadra: "desktop",
    "armadra-host": "host",
    "armadra-runtime": "worker",
    "armadra-worker": "worker",
    "armadra-hook": "hook",
    "armadra-session-host": "session-host",
    "armadra-web": "web",
  };
  return prefixes[name.slice(0, separator)] ?? "";
}

/** The target a published name declares, mirroring updates.assetTarget. */
export function assetTarget(name) {
  const lower = name.toLowerCase();
  for (const system of ["darwin", "linux", "windows"]) {
    const index = lower.indexOf(`${system}-`);
    if (index < 0) continue;
    if (index > 0 && /[a-z0-9]/.test(lower[index - 1])) continue;
    const rest = lower.slice(index + system.length + 1);
    const match = /^[a-z0-9_]+/.exec(rest);
    if (!match) continue;
    return `${system}-${match[0]}`;
  }
  return "";
}

/**
 * The desktop bundles a target produces. Exactly one per platform takes part
 * in automatic updates; the rest exist so a first install is possible.
 *
 * `kind` names the electron-builder target each one comes from, and it is
 * one-for-one with `apps/desktop/electron-builder.yml`'s per-platform `target`
 * lists — `apps/desktop/scripts/artifact-targets.test.mjs` fails if the two
 * drift apart.
 *
 * The names below are NOT electron-builder's own. It writes
 * `Armadra-0.1.0-arm64.dmg`, `Armadra Setup 0.1.0.exe` and
 * `armadra_0.1.0_amd64.deb`, and none of those declares a target the Host can
 * read (`assetTarget` finds nothing in `arm64` or `amd64`, and a space in a
 * name is its own problem). `stage-desktop.mjs` looks each bundle up by `kind`
 * and renames it to the name here, so the rename is stated once rather than
 * repeated as a `find` in every release job.
 *
 * Which one updates in place is electron-updater's rule, not a choice:
 *
 * - macOS updates from the **zip**, never the `.dmg` — a dmg is a disk image
 *   a person mounts, and the updater replaces an app bundle.
 * - Windows updates from the **NSIS installer**, run with its silent flags.
 *   The zip is the portable copy for machines where an installer cannot run;
 *   it is not an updater target, because nothing records where it was
 *   unpacked to.
 * - Linux updates from the **AppImage**, which is one self-contained file.
 *   A `.deb` or `.rpm` belongs to a package manager, and offering to replace
 *   one behind the package manager's back is how a system ends up with two
 *   disagreeing records of what is installed.
 */
export function desktopAssets(version, target) {
  if (target.startsWith("darwin-"))
    return [
      { name: `Armadra_${version}_${target}.zip`, updater: true, kind: "zip" },
      { name: `Armadra_${version}_${target}.dmg`, updater: false, kind: "dmg" },
    ];
  if (target.startsWith("windows-"))
    return [
      {
        name: `Armadra_${version}_${target}-setup.exe`,
        updater: true,
        kind: "nsis",
      },
      {
        name: `Armadra_${version}_${target}-portable.zip`,
        updater: false,
        kind: "zip",
      },
    ];
  return [
    {
      name: `Armadra_${version}_${target}.AppImage`,
      updater: true,
      kind: "AppImage",
    },
    { name: `Armadra_${version}_${target}.deb`, updater: false, kind: "deb" },
    { name: `Armadra_${version}_${target}.rpm`, updater: false, kind: "rpm" },
  ];
}
