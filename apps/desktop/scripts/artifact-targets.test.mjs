import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { load } from "js-yaml";

import { TARGETS, desktopAssets } from "../../../tools/release/artifacts.mjs";

/**
 * `electron-builder.yml` and `tools/release/artifacts.mjs` describe the same
 * thing from two ends, and they have to agree on both halves of it:
 *
 * - the `<os>-<arch>` **matrix** — six entries, one archive-format ecosystem
 *   per OS. A release built for a target `artifacts.mjs` does not know about
 *   is a bundle no release job uploads; a target it declares that
 *   electron-builder never builds is an asset `stage-desktop.mjs` will fail
 *   looking for.
 * - the **bundle kinds**, and therefore the published file names.
 *   `desktopAssets()`'s `kind` is the electron-builder `target` value, and
 *   `stage-desktop.mjs` looks the built file up by it. A kind nobody builds
 *   is a release that stops at staging; a kind built and not published is a
 *   bundle that quietly never ships.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = load(
  readFileSync(join(here, "..", "electron-builder.yml"), "utf8"),
);

const OS_FROM_TARGET_PREFIX = { darwin: "mac", linux: "linux", windows: "win" };
const ARCH_FROM_SUFFIX = { aarch64: "arm64", x86_64: "x64" };

function archesBuilt(platformConfig) {
  const arches = new Set();
  for (const target of platformConfig.target ?? []) {
    for (const arch of target.arch ?? []) arches.add(arch);
  }
  return arches;
}

test("every TARGETS entry has a matching electron-builder platform and arch", () => {
  for (const target of TARGETS) {
    const [os, suffix] = target.split("-");
    const platformKey = OS_FROM_TARGET_PREFIX[os];
    assert.ok(platformKey, `${target}: unrecognised OS prefix`);
    const platformConfig = CONFIG[platformKey];
    assert.ok(
      platformConfig,
      `${target}: electron-builder.yml has no "${platformKey}" section`,
    );
    const arch = ARCH_FROM_SUFFIX[suffix];
    assert.ok(arch, `${target}: unrecognised arch suffix "${suffix}"`);
    const built = archesBuilt(platformConfig);
    assert.ok(
      built.has(arch),
      `${target}: electron-builder.yml's "${platformKey}.target" never builds arch "${arch}" (has: ${[...built].join(", ")})`,
    );
  }
});

test("electron-builder builds no platform or arch that TARGETS does not publish", () => {
  const declared = new Set(TARGETS);
  for (const [platformKey, os] of Object.entries({
    mac: "darwin",
    win: "windows",
    linux: "linux",
  })) {
    const platformConfig = CONFIG[platformKey];
    for (const arch of archesBuilt(platformConfig)) {
      const suffix = Object.entries(ARCH_FROM_SUFFIX).find(
        ([, v]) => v === arch,
      )?.[0];
      assert.ok(
        suffix,
        `${platformKey}: unrecognised electron-builder arch "${arch}"`,
      );
      const target = `${os}-${suffix}`;
      assert.ok(
        declared.has(target),
        `electron-builder.yml builds ${platformKey}/${arch} (${target}), which is not in artifacts.mjs's TARGETS`,
      );
    }
  }
});

test("every platform ships at least one updater-eligible and one plain-installer format", () => {
  // Sanity check on the shape of the config, independent of TARGETS: every
  // platform must produce more than a single archive format, matching
  // docs/design/electron-migration.md §2 (dmg+zip / nsis+zip / AppImage+deb+rpm).
  for (const platformKey of ["mac", "win", "linux"]) {
    const kinds = (CONFIG[platformKey].target ?? []).map((t) => t.target);
    assert.ok(
      kinds.length >= 2,
      `${platformKey}: expected at least two bundle kinds, got ${kinds.join(", ")}`,
    );
  }
});

/** The `target` values electron-builder is configured to build for one OS. */
function kindsBuilt(platformKey) {
  return new Set((CONFIG[platformKey].target ?? []).map((t) => t.target));
}

test("desktopAssets names one file per electron-builder target, and no other", () => {
  for (const target of TARGETS) {
    const platformKey = OS_FROM_TARGET_PREFIX[target.split("-")[0]];
    const built = kindsBuilt(platformKey);
    const published = desktopAssets("9.9.9", target);
    assert.deepEqual(
      new Set(published.map((asset) => asset.kind)),
      built,
      `${target}: desktopAssets() kinds and electron-builder.yml "${platformKey}.target" disagree`,
    );
    // Exactly one bundle per platform updates in place. Two would mean the
    // manifest has to choose; none would mean the platform silently never
    // receives an update.
    assert.equal(
      published.filter((asset) => asset.updater).length,
      1,
      `${target}: expected exactly one updater-eligible bundle`,
    );
  }
});

/**
 * The published names, pinned literally. These strings are the contract the
 * Host reads a component and a target back out of (`assetComponent` /
 * `assetTarget`), so a change here is a change a released client sees.
 */
test("the published desktop file names are the ones the Host can place", () => {
  const names = (target) =>
    desktopAssets("1.2.3", target).map((asset) => asset.name);
  assert.deepEqual(names("darwin-aarch64"), [
    "Armadra_1.2.3_darwin-aarch64.zip",
    "Armadra_1.2.3_darwin-aarch64.dmg",
  ]);
  assert.deepEqual(names("windows-x86_64"), [
    "Armadra_1.2.3_windows-x86_64-setup.exe",
    "Armadra_1.2.3_windows-x86_64-portable.zip",
  ]);
  assert.deepEqual(names("linux-aarch64"), [
    "Armadra_1.2.3_linux-aarch64.AppImage",
    "Armadra_1.2.3_linux-aarch64.deb",
    "Armadra_1.2.3_linux-aarch64.rpm",
  ]);
  // The two Windows bundles are both zip-family names; only the installer is
  // the updater's, and the suffix is what tells them apart.
  const windows = desktopAssets("1.2.3", "windows-aarch64");
  assert.equal(
    windows.find((asset) => asset.updater).name,
    "Armadra_1.2.3_windows-aarch64-setup.exe",
  );
});
