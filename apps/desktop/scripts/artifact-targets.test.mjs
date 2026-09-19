import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { load } from "js-yaml";

import { TARGETS } from "../../../tools/release/artifacts.mjs";

/**
 * `electron-builder.yml`'s per-platform `target` arch lists have to cover the
 * same `<os>-<arch>` matrix as `tools/release/artifacts.mjs`'s `TARGETS` —
 * six entries, one archive format ecosystem per OS. A release built for a
 * target `artifacts.mjs` does not know electron-builder can produce is a
 * release whose component names (`stage-desktop.mjs`, W2.2) nothing can
 * assemble; a target electron-builder builds that is not in `TARGETS` is a
 * bundle no release job ever uploads.
 *
 * This checks the matrix, not individual bundle *kinds* — whether the mac
 * updater artifact ends up `.zip` (electron-updater) or something else is
 * `tools/release/artifacts.mjs`'s `desktopAssets()` to decide once W2.2 wires
 * electron-updater, and belongs to that batch, not this one.
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
