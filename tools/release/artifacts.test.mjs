import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MANIFEST_ASSETS,
  TARGETS,
  assetComponent,
  assetTarget,
  desktopAssets,
  webAsset,
} from "./artifacts.mjs";

test("every published name is one the updater can place", () => {
  const names = [
    webAsset("0.2.0"),
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
    const portable = assets.find((asset) =>
      asset.name.endsWith("-portable.zip"),
    );
    assert.ok(portable, `${target} publishes no portable bundle`);
    assert.equal(portable.updater, false);
    assert.equal(portable.name, `Armadra_0.2.0_${target}-portable.zip`);
    assert.equal(assetTarget(portable.name), target);
    assert.equal(assetComponent(portable.name), "desktop");
    // The installer is what updates in place; the zip records no location to
    // replace, so it is a first install only.
    assert.equal(assets.find((asset) => asset.updater).kind, "nsis", target);
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
    "armadra-web-0.2.0.tar.gz",
    "surprise_0.2.0_linux-x86_64.zip",
    // The component archives a release used to carry. Publishing one again
    // would be publishing a program nothing builds.
    "armadra-host_0.2.0_linux-x86_64.tar.gz",
    "armadra-runtime_0.2.0_linux-x86_64.tar.gz",
    "armadra-session-host_0.2.0_windows-x86_64.zip",
  ]) {
    assert.equal(assetComponent(name), "", name);
  }
});

test("the web bundle is the one published artifact with no target", () => {
  const name = webAsset("0.2.0");
  assert.equal(name, "armadra-web_0.2.0.tar.gz");
  assert.equal(assetComponent(name), "web");
  assert.equal(assetTarget(name), "");
});
