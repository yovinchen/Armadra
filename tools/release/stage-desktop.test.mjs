import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TARGETS, desktopAssets } from "./artifacts.mjs";
import {
  BUNDLE_KINDS,
  findBundle,
  isReleaseAsset,
  matchesArch,
  stageDesktop,
} from "./stage-desktop.mjs";

const VERSION = "0.2.0";

function scratch() {
  return mkdtempSync(join(tmpdir(), "armadra-stage-test-"));
}

/** A file in electron-builder's flat output directory. */
function writeOutput(bundle, name) {
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, name), `${name} bytes\n`);
  return join(bundle, name);
}

test("every bundle a target publishes is one this script knows how to find", () => {
  for (const target of TARGETS) {
    for (const asset of desktopAssets(VERSION, target)) {
      assert.ok(
        BUNDLE_KINDS[asset.kind],
        `${asset.name} is a ${asset.kind}, which stage-desktop cannot locate`,
      );
    }
  }
});

test("a bundle is found by extension, not by the packager's own name", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    // The names electron-builder actually writes: its own casing, its own
    // architecture spelling, and a space in the Windows installer.
    writeOutput(bundle, "Armadra Setup 0.1.0.exe");
    writeOutput(bundle, "armadra_0.1.0_amd64.deb");
    assert.match(findBundle({ bundle, kind: "nsis" }), /Setup 0\.1\.0\.exe$/);
    assert.match(findBundle({ bundle, kind: "deb" }), /_amd64\.deb$/);
    assert.equal(findBundle({ bundle, kind: "rpm" }), null);
    assert.equal(findBundle({ bundle, kind: "nonsense" }), null);
    assert.equal(
      findBundle({ bundle: join(root, "nowhere"), kind: "deb" }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * electron-builder writes its own updater manifest and a differential-download
 * index beside the bundles. Neither is a release asset here — this release
 * publishes `latest.json` — and staging one would put a file in the release
 * that `assemble.mjs`'s name check refuses.
 */
test("the packager's own manifests and debris are never staged", () => {
  for (const name of [
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
    "builder-debug.yml",
    "builder-effective-config.yaml",
    "Armadra-0.1.0-arm64.dmg.blockmap",
    "mac-arm64-unpacked",
  ])
    assert.equal(isReleaseAsset(name), false, name);
  for (const name of [
    "Armadra-0.1.0-arm64.dmg",
    "Armadra-0.1.0-arm64-mac.zip",
    "Armadra Setup 0.1.0.exe",
    "Armadra-0.1.0.AppImage",
  ])
    assert.equal(isReleaseAsset(name), true, name);
});

/**
 * One local `dist` produces both architectures into one directory. The names
 * sort with arm64 first, so before this the x64 target was published with the
 * arm64 bundle under its name.
 */
test("two architectures in one directory do not get crossed", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    // Exactly what electron-builder wrote here: x64 carries no arch token.
    for (const name of [
      "Armadra-0.1.0-arm64.dmg",
      "Armadra-0.1.0-arm64-mac.zip",
      "Armadra-0.1.0.dmg",
      "Armadra-0.1.0-mac.zip",
    ])
      writeOutput(bundle, name);

    const arm = join(root, "arm");
    stageDesktop({
      target: "darwin-aarch64",
      bundle,
      out: arm,
      version: VERSION,
      requireUpdater: true,
    });
    const intel = join(root, "intel");
    stageDesktop({
      target: "darwin-x86_64",
      bundle,
      out: intel,
      version: VERSION,
      requireUpdater: true,
    });

    assert.equal(
      readFileSync(join(arm, `Armadra_${VERSION}_darwin-aarch64.dmg`), "utf8"),
      "Armadra-0.1.0-arm64.dmg bytes\n",
    );
    assert.equal(
      readFileSync(join(intel, `Armadra_${VERSION}_darwin-x86_64.dmg`), "utf8"),
      "Armadra-0.1.0.dmg bytes\n",
    );
    assert.equal(
      readFileSync(join(intel, `Armadra_${VERSION}_darwin-x86_64.zip`), "utf8"),
      "Armadra-0.1.0-mac.zip bytes\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the architecture token is matched as a whole word", () => {
  // `aarch64` is the rpm spelling, `arm64` everyone else's; neither may be
  // found inside a longer run of characters.
  for (const [name, target] of [
    ["armadra-0.1.0.aarch64.rpm", "linux-aarch64"],
    ["armadra_0.1.0_arm64.deb", "linux-aarch64"],
    ["Armadra-0.1.0-arm64-win.zip", "windows-aarch64"],
    ["armadra-0.1.0.x86_64.rpm", "linux-x86_64"],
    ["armadra_0.1.0_amd64.deb", "linux-x86_64"],
    ["Armadra Setup 0.1.0.exe", "windows-x86_64"],
  ])
    assert.equal(matchesArch(name, target), true, `${name} / ${target}`);
  for (const [name, target] of [
    ["armadra-0.1.0.aarch64.rpm", "linux-x86_64"],
    ["Armadra-0.1.0-arm64.dmg", "darwin-x86_64"],
    ["Armadra-0.1.0.dmg", "darwin-aarch64"],
  ])
    assert.equal(matchesArch(name, target), false, `${name} / ${target}`);
});

test("a blockmap never stands in for the bundle it indexes", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    // Sorted first by name, so a filter that only looked at the extension
    // would return this one.
    writeOutput(bundle, "Armadra-0.1.0-arm64.dmg.blockmap");
    writeOutput(bundle, "Armadra-0.1.0-arm64.dmg");
    assert.match(findBundle({ bundle, kind: "dmg" }), /arm64\.dmg$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Linux release is renamed to the three names it publishes", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    writeOutput(bundle, "Armadra-0.1.0.AppImage");
    writeOutput(bundle, "armadra_0.1.0_amd64.deb");
    writeOutput(bundle, "armadra-0.1.0.x86_64.rpm");
    writeOutput(bundle, "latest-linux.yml");
    const out = join(root, "artifacts");
    const { staged, missing } = stageDesktop({
      target: "linux-x86_64",
      bundle,
      out,
      version: VERSION,
      requireUpdater: true,
    });
    assert.deepEqual(missing, []);
    assert.deepEqual(
      readdirSync(out).sort(),
      [
        `Armadra_${VERSION}_linux-x86_64.AppImage`,
        `Armadra_${VERSION}_linux-x86_64.deb`,
        `Armadra_${VERSION}_linux-x86_64.rpm`,
      ].sort(),
    );
    assert.deepEqual(staged.map((item) => item.kind).sort(), [
      "AppImage",
      "deb",
      "rpm",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS publishes the zip the updater applies and the dmg a person mounts", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    writeOutput(bundle, "Armadra-0.1.0-arm64.dmg");
    writeOutput(bundle, "Armadra-0.1.0-arm64-mac.zip");
    const out = join(root, "artifacts");
    const { missing } = stageDesktop({
      target: "darwin-aarch64",
      bundle,
      out,
      version: VERSION,
      requireUpdater: true,
    });
    assert.deepEqual(missing, []);
    assert.deepEqual(readdirSync(out).sort(), [
      `Armadra_${VERSION}_darwin-aarch64.dmg`,
      `Armadra_${VERSION}_darwin-aarch64.zip`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows publishes the installer the updater runs and the portable zip", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    writeOutput(bundle, "Armadra Setup 0.1.0.exe");
    writeOutput(bundle, "Armadra-0.1.0-x64-win.zip");
    const out = join(root, "artifacts");
    const { missing } = stageDesktop({
      target: "windows-x86_64",
      bundle,
      out,
      version: VERSION,
      requireUpdater: true,
    });
    assert.deepEqual(missing, []);
    assert.deepEqual(readdirSync(out).sort(), [
      `Armadra_${VERSION}_windows-x86_64-portable.zip`,
      `Armadra_${VERSION}_windows-x86_64-setup.exe`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A bundle that is simply absent means packaging stopped half-way. That is
// tolerated on an unsigned build, where the release is assembled and says it
// cannot update itself, and refused when the release claims to be complete.
test("a missing updater bundle is tolerated unsigned and refused when required", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    writeOutput(bundle, "Armadra-0.1.0-arm64.dmg");
    const tolerated = stageDesktop({
      target: "darwin-aarch64",
      bundle,
      out: join(root, "unsigned"),
      version: VERSION,
      requireUpdater: false,
    });
    assert.deepEqual(tolerated.missing, []);
    assert.deepEqual(
      tolerated.staged.map((item) => item.kind),
      ["dmg"],
    );

    const refused = stageDesktop({
      target: "darwin-aarch64",
      bundle,
      out: join(root, "signed"),
      version: VERSION,
      requireUpdater: true,
    });
    assert.equal(refused.missing.length, 1);
    assert.match(refused.missing[0], /zip/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A non-updater bundle is never optional: a release that quietly shipped
// without its .deb is a platform nobody can install on for the first time.
test("a missing plain installer is a failure whether or not updates are required", () => {
  const root = scratch();
  try {
    const bundle = join(root, "release");
    writeOutput(bundle, "Armadra-0.1.0.AppImage");
    writeOutput(bundle, "armadra_0.1.0_amd64.deb");
    const { missing } = stageDesktop({
      target: "linux-x86_64",
      bundle,
      out: join(root, "artifacts"),
      version: VERSION,
      requireUpdater: false,
    });
    assert.equal(missing.length, 1);
    assert.match(missing[0], /rpm/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
