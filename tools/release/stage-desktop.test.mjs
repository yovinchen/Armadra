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
import { fileURLToPath } from "node:url";
import { TARGETS, desktopAssets } from "./artifacts.mjs";
import { zipCommand } from "./package-components.mjs";
import {
  BUNDLE_KINDS,
  findBundle,
  portableBinaries,
  stageDesktop,
  stagePortable,
} from "./stage-desktop.mjs";

const VERSION = "0.2.0";

function scratch() {
  return mkdtempSync(join(tmpdir(), "armadra-stage-test-"));
}

/** Bundler output under `bundle/<dir>/<name>`, with an optional signature. */
function writeBundle(bundle, kind, name, { signature = false } = {}) {
  const directory = join(bundle, BUNDLE_KINDS[kind].directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${name} bytes\n`);
  if (signature)
    writeFileSync(join(directory, `${name}.sig`), "tauri signature\n");
  return join(directory, name);
}

test("every bundle a target publishes is one this script knows how to find", () => {
  for (const target of TARGETS) {
    for (const asset of desktopAssets(VERSION, target)) {
      if (asset.kind === "portable") continue;
      assert.ok(
        BUNDLE_KINDS[asset.kind],
        `${asset.name} is a ${asset.kind}, which stage-desktop cannot locate`,
      );
    }
  }
});

// Tauri merges tauri.<platform>.conf.json on its own, so these three files are
// what actually decides which bundles a release job gets. Asserting them against
// desktopAssets() closes the loop: a target added on one side and not the other
// is a release that either misses a file or fails staging it.
const TAURI_TARGET_OF_KIND = {
  "app.tar.gz": "app",
  dmg: "dmg",
  nsis: "nsis",
  msi: "msi",
  appimage: "appimage",
  deb: "deb",
  rpm: "rpm",
};

const PLATFORM_CONFIGS = [
  { file: "tauri.macos.conf.json", prefix: "darwin-" },
  { file: "tauri.linux.conf.json", prefix: "linux-" },
  { file: "tauri.windows.conf.json", prefix: "windows-" },
];

test("each platform config asks Tauri for exactly the bundles a release publishes", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  for (const { file, prefix } of PLATFORM_CONFIGS) {
    const path = `${root}apps/desktop/src-tauri/${file}`;
    const config = JSON.parse(readFileSync(path, "utf8"));
    // tauri-build rejects every field it does not know, `$comment` included, so
    // a note here is not a note — it is a build that fails on that platform
    // only, which is the worst place to learn it.
    for (const key of Object.keys(config)) {
      assert.ok(
        key === "$schema" || key === "bundle" || key === "app",
        `${file} sets ${key}, which tauri-build does not accept`,
      );
    }
    for (const key of Object.keys(config.bundle ?? {})) {
      assert.ok(
        key !== "$comment",
        `${file} has a $comment in bundle; tauri-build refuses it`,
      );
    }
    const expected = new Set();
    for (const target of TARGETS.filter((name) => name.startsWith(prefix))) {
      for (const asset of desktopAssets(VERSION, target)) {
        if (asset.kind === "portable") continue;
        expected.add(TAURI_TARGET_OF_KIND[asset.kind]);
      }
    }
    assert.deepEqual(
      [...config.bundle.targets].sort(),
      [...expected].sort(),
      file,
    );
  }
});

test("a bundle is found by suffix, not by the bundler's own name", () => {
  const root = scratch();
  try {
    const bundle = join(root, "bundle");
    // The names Tauri actually writes: a locale on the MSI, a lower-cased
    // product name and a Debian architecture on the .deb.
    writeBundle(bundle, "msi", "Armadra_0.1.0_x64_en-US.msi");
    writeBundle(bundle, "deb", "armadra_0.1.0_amd64.deb");
    assert.match(findBundle({ bundle, kind: "msi" }), /_en-US\.msi$/);
    assert.match(findBundle({ bundle, kind: "deb" }), /_amd64\.deb$/);
    assert.equal(findBundle({ bundle, kind: "rpm" }), null);
    assert.equal(findBundle({ bundle, kind: "nonsense" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a signed Linux release is renamed and keeps its signature", () => {
  const root = scratch();
  try {
    const bundle = join(root, "bundle");
    writeBundle(bundle, "appimage", "armadra_0.1.0_amd64.AppImage", {
      signature: true,
    });
    writeBundle(bundle, "deb", "armadra_0.1.0_amd64.deb");
    writeBundle(bundle, "rpm", "armadra-0.1.0-1.x86_64.rpm");
    const out = join(root, "artifacts");
    const { staged, missing } = stageDesktop({
      target: "linux-x86_64",
      triple: "x86_64-unknown-linux-gnu",
      bundle,
      from: join(root, "release"),
      out,
      version: VERSION,
      requireUpdater: true,
    });
    assert.deepEqual(missing, []);
    assert.deepEqual(
      readdirSync(out).sort(),
      [
        `Armadra_${VERSION}_linux-x86_64.AppImage`,
        `Armadra_${VERSION}_linux-x86_64.AppImage.sig`,
        `Armadra_${VERSION}_linux-x86_64.deb`,
        `Armadra_${VERSION}_linux-x86_64.rpm`,
      ].sort(),
    );
    assert.equal(
      staged.find((item) => item.kind === "appimage").signature,
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Without a signing key `signing.mjs` turns createUpdaterArtifacts off, so the
// macOS .app.tar.gz is never produced. That is the ordinary unsigned build, not
// a broken one — but a release that claims to be signed and has no signature is
// the failure this pair of cases pins down.
test("a missing updater bundle is tolerated unsigned and refused when required", () => {
  const root = scratch();
  try {
    const bundle = join(root, "bundle");
    writeBundle(bundle, "dmg", "Armadra_0.1.0_aarch64.dmg");
    const tolerated = stageDesktop({
      target: "darwin-aarch64",
      triple: "aarch64-apple-darwin",
      bundle,
      from: join(root, "release"),
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
      triple: "aarch64-apple-darwin",
      bundle,
      from: join(root, "release"),
      out: join(root, "signed"),
      version: VERSION,
      requireUpdater: true,
    });
    assert.equal(refused.missing.length, 1);
    assert.match(refused.missing[0], /app\.tar\.gz/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an updater bundle without its signature is refused", () => {
  const root = scratch();
  try {
    const bundle = join(root, "bundle");
    writeBundle(bundle, "app.tar.gz", "Armadra.app.tar.gz");
    writeBundle(bundle, "dmg", "Armadra_0.1.0_aarch64.dmg");
    const { missing } = stageDesktop({
      target: "darwin-aarch64",
      triple: "aarch64-apple-darwin",
      bundle,
      from: join(root, "release"),
      out: join(root, "artifacts"),
      version: VERSION,
      requireUpdater: true,
    });
    assert.deepEqual(missing, [
      `Armadra_${VERSION}_darwin-aarch64.app.tar.gz.sig`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the portable zip carries the same sidecars the installer does", () => {
  assert.deepEqual(portableBinaries("x86_64-pc-windows-msvc"), [
    "armadra-runtime",
    "armadra-hook",
    "armadra-session-host",
    "armadra-host",
  ]);
  // Not a Windows concern only by accident: the session host exists nowhere
  // else, so a portable bundle for another platform would not carry one.
  assert.deepEqual(portableBinaries("x86_64-unknown-linux-gnu"), [
    "armadra-runtime",
    "armadra-hook",
    "armadra-host",
  ]);
});

// The shell resolves armadra-host next to its own executable in a production
// build, so a portable zip that silently shipped without one would install
// fine and then fail to start anything.
test("the portable zip refuses to be built without every sidecar", () => {
  const root = scratch();
  try {
    const from = join(root, "release");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "Armadra.exe"), "shell\n");
    assert.throws(
      () =>
        stagePortable({
          from,
          triple: "x86_64-pc-windows-msvc",
          out: join(root, "artifacts"),
          assetName: "Armadra_0.2.0_windows-x86_64-portable.zip",
        }),
      /armadra-runtime\.exe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the portable zip is flat and names its binaries without the triple", (t) => {
  try {
    zipCommand();
  } catch {
    t.skip("no zip archiver on this machine");
    return;
  }
  const root = scratch();
  try {
    const from = join(root, "release");
    mkdirSync(from, { recursive: true });
    const triple = "x86_64-pc-windows-msvc";
    writeFileSync(join(from, "Armadra.exe"), "shell\n");
    for (const binary of portableBinaries(triple))
      writeFileSync(join(from, `${binary}-${triple}.exe`), `${binary}\n`);
    const assetName = `Armadra_${VERSION}_windows-x86_64-portable.zip`;
    const output = stagePortable({
      from,
      triple,
      out: join(root, "artifacts"),
      assetName,
    });
    // Zip stores every entry's name uncompressed in its local header, so the
    // names can be read back without unpacking or a zip reader.
    const bytes = readFileSync(output).toString("latin1");
    for (const name of [
      "Armadra.exe",
      ...portableBinaries(triple).map((b) => `${b}.exe`),
    ])
      assert.ok(bytes.includes(name), `${name} is not in ${assetName}`);
    assert.ok(
      !bytes.includes(triple),
      "the portable zip still names a binary after its triple",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
