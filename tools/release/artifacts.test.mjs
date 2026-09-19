import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMPONENTS,
  MANIFEST_ASSETS,
  TARGETS,
  assetComponent,
  assetTarget,
  componentAsset,
  componentAssets,
  desktopAssets,
  webAsset,
} from "./artifacts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("every published name is one the Host can place", () => {
  const names = [
    ...componentAssets("0.2.0").map((asset) => asset.name),
    ...TARGETS.flatMap((target) =>
      desktopAssets("0.2.0", target).map((asset) => asset.name),
    ),
    ...MANIFEST_ASSETS,
  ];
  for (const name of names) {
    const component = assetComponent(name);
    assert.notEqual(component, "", `${name} declares no component`);
    if (component === "manifest" || component === "web") {
      assert.equal(assetTarget(name), "", `${name} should have no target`);
      continue;
    }
    assert.notEqual(assetTarget(name), "", `${name} declares no target`);
  }
});

test("a target is read back out of every component archive name", () => {
  for (const entry of COMPONENTS) {
    for (const target of entry.targets) {
      const name = componentAsset({
        binary: entry.binary,
        version: "0.2.0",
        target,
      });
      assert.equal(assetTarget(name), target, name);
      assert.equal(assetComponent(name), entry.component, name);
    }
  }
  assert.equal(assetComponent(webAsset("0.2.0")), "web");
});

// The Host reads these names with its own code. Two readings that drift apart
// produce a release whose files nothing can match, so the prefixes are asserted
// against the Go source rather than against a copy of it.
test("the component prefixes match the ones the Host reads", () => {
  const source = readFileSync(
    root + "apps/host/internal/updates/source.go",
    "utf8",
  );
  const block =
    /var assetComponents = map\[string\]string\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "assetComponents is no longer a map literal in source.go");
  const goPrefixes = new Map(
    [...block[1].matchAll(/"([^"]+)":\s*Component(\w+),/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const expected = new Map([
    ["Armadra", "Desktop"],
    ["armadra-host", "Host"],
    ["armadra-runtime", "Worker"],
    ["armadra-worker", "Worker"],
    ["armadra-hook", "Hook"],
    ["armadra-session-host", "SessionHost"],
    ["armadra-web", "Web"],
  ]);
  assert.deepEqual([...goPrefixes].sort(), [...expected].sort());
  for (const prefix of goPrefixes.keys()) {
    assert.notEqual(
      assetComponent(`${prefix}_0.2.0_linux-x86_64.tar.gz`),
      "",
      prefix,
    );
  }
  const manifests = /var manifestAssets = map\[string\]bool\{([\s\S]*?)\}/.exec(
    source,
  );
  assert.ok(
    manifests,
    "manifestAssets is no longer a map literal in source.go",
  );
  for (const asset of MANIFEST_ASSETS) {
    assert.ok(
      manifests[1].includes(`"${asset}"`),
      `${asset} is not a manifest asset in Go`,
    );
  }
});

test("the session host is Windows-only and every other component is universal", () => {
  const sessionHost = COMPONENTS.find(
    (entry) => entry.component === "session-host",
  );
  assert.deepEqual(sessionHost.targets, ["windows-x86_64", "windows-aarch64"]);
  for (const entry of COMPONENTS) {
    if (entry.component === "session-host") continue;
    assert.deepEqual(entry.targets, TARGETS, entry.component);
  }
});

test("exactly one desktop bundle per target takes part in updates", () => {
  for (const target of TARGETS) {
    const updaters = desktopAssets("0.2.0", target).filter(
      (asset) => asset.updater,
    );
    assert.equal(updaters.length, 1, target);
  }
  // A package manager owns these; offering one through the updater would
  // promise an install the updater cannot perform.
  const linux = desktopAssets("0.2.0", "linux-x86_64");
  assert.deepEqual(
    linux
      .filter((asset) => !asset.updater)
      .map((asset) => asset.name.split(".").pop()),
    ["deb", "rpm"],
  );
});

// A portable zip is unpacked wherever its owner likes, so there is no
// installed location for the updater to replace. Listing it in latest.json
// would promise an update nothing can apply.
test("Windows publishes a portable zip and never offers it as an update", () => {
  for (const target of ["windows-x86_64", "windows-aarch64"]) {
    const assets = desktopAssets("0.2.0", target);
    const portable = assets.find((asset) => asset.name.endsWith("-portable.zip"));
    assert.ok(portable, `${target} publishes no portable bundle`);
    assert.equal(portable.updater, false);
    assert.equal(portable.name, `Armadra_0.2.0_${target}-portable.zip`);
    assert.equal(assetTarget(portable.name), target);
    assert.equal(assetComponent(portable.name), "desktop");
    // The installer is what updates in place; the zip records no location to
    // replace, so it is a first install only.
    assert.equal(
      assets.find((asset) => asset.updater).kind,
      "nsis",
      target,
    );
  }
  for (const target of TARGETS.filter((name) => !name.startsWith("windows-"))) {
    assert.equal(
      desktopAssets("0.2.0", target).some((asset) =>
        asset.name.endsWith("-portable.zip"),
      ),
      false,
      target,
    );
  }
});

// macOS is the one platform whose updater artifact and whose portable-looking
// artifact are both zips, and only one of them is a bundle at all: the `.dmg`
// is a disk image a person mounts, and electron-updater replaces an app
// bundle, so it is the zip that updates in place.
test("macOS updates from the zip and installs from the dmg", () => {
  for (const target of ["darwin-aarch64", "darwin-x86_64"]) {
    const assets = desktopAssets("0.2.0", target);
    assert.equal(assets.find((asset) => asset.updater).kind, "zip", target);
    assert.equal(
      assets.find((asset) => asset.kind === "dmg").updater,
      false,
      target,
    );
    for (const asset of assets) {
      assert.equal(assetTarget(asset.name), target, asset.name);
      assert.equal(assetComponent(asset.name), "desktop", asset.name);
    }
  }
});

test("a name that follows no convention declares nothing", () => {
  for (const name of [
    "notes.txt",
    "armadra-host-0.2.0.tar.gz",
    "surprise_0.2.0_linux-x86_64.zip",
  ]) {
    assert.equal(assetComponent(name), "", name);
  }
});
