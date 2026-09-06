/**
 * The shell's update path, end to end, against a release nobody published.
 *
 * Installing a real bundle needs a signed build and a machine willing to be
 * replaced, so the closure that *can* be exercised here is the one that decides
 * whether an install would be allowed at all: check the release index, derive
 * the manifest, read it, fetch the bundle and verify both statements about the
 * bytes — the sha256 the release published and the minisign signature. Each of
 * those has a failing case too, because a check that only ever passes is not a
 * check.
 *
 * The rules asserted here are the ones `src-tauri/src/updates/offer.rs`
 * enforces at run time; the Rust tests cover the derivation, and this covers
 * the pipeline it derives from. The signing key is generated for this run and
 * discarded with it, and the server binds loopback on an ephemeral port, so
 * nothing reaches GitHub and no fixed port is taken.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  desktopAssets,
  assetComponent,
  assetTarget,
} from "../../../tools/release/artifacts.mjs";
import { writeChecksums } from "../../../tools/release/checksums.mjs";
import {
  generateKey,
  publicKeyFile,
  verifyDetached,
} from "../../../tools/release/minisign.mjs";
import { signDirectory } from "../../../tools/release/sign.mjs";
import { startMockReleaseServer } from "../../../tools/release/mock-release-server.mjs";
import { writeManifest } from "../../../tools/release/updater-manifest.mjs";

const VERSION = "0.2.0";
const TAG = `v${VERSION}`;
const TARGET = "darwin-aarch64";

function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The one desktop bundle a Tauri updater can actually apply for a target. */
function updaterAsset(target) {
  return desktopAssets(VERSION, target).find((asset) => asset.updater).name;
}

/**
 * The derivation `offer.rs` performs: the manifest and the bundle have to be
 * siblings of the same release, and the digest comes from the release index —
 * not from the manifest, which is served by whoever serves the bytes.
 */
function deriveOffer(release, target) {
  const manifest = release.assets.find(
    (asset) =>
      assetComponent(asset.name) === "manifest" && asset.name === "latest.json",
  );
  assert.ok(manifest, "the release publishes no updater manifest");
  const bundleName = updaterAsset(target);
  const bundle = release.assets.find(
    (asset) =>
      asset.name === bundleName &&
      assetComponent(asset.name) === "desktop" &&
      assetTarget(asset.name) === target,
  );
  assert.ok(bundle, `the release publishes no desktop bundle for ${target}`);
  const manifestUrl = new URL(manifest.browser_download_url);
  const bundleUrl = new URL(bundle.browser_download_url);
  const directory = (url) =>
    url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  assert.equal(manifestUrl.origin, bundleUrl.origin);
  assert.equal(directory(manifestUrl), directory(bundleUrl));
  return {
    manifestUrl: manifestUrl.href,
    bundleUrl: bundleUrl.href,
    sha256: bundle.digest.replace(/^sha256:/, ""),
    sizeBytes: bundle.size,
    signatureAsset: `${bundleName}.sig`,
  };
}

describe("desktop update closure against a mock release", () => {
  let directory;
  let server;
  let key;
  let publicKeyText;
  let bundleBytes;

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "armadra-updates-"));
    key = generateKey();
    publicKeyText = publicKeyFile(key);

    // A stand-in bundle: not empty, and distinct per name, so a checksum list
    // that mixed two files up would be caught.
    for (const target of [TARGET, "linux-x86_64"]) {
      for (const asset of desktopAssets(VERSION, target)) {
        writeFileSync(
          join(directory, asset.name),
          Buffer.from(`armadra updater bundle placeholder ${asset.name}\n`),
        );
      }
    }
    bundleBytes = readFileSync(join(directory, updaterAsset(TARGET)));

    // Sign the bundles first: the manifest embeds each `.sig`, so a manifest
    // built before signing would list nothing.
    signDirectory({ directory, key, version: VERSION });
    writeManifest({
      directory,
      version: VERSION,
      notes: "",
      targets: [TARGET, "linux-x86_64"],
      downloadUrl: (name) => `RELEASE/${name}`,
    });
    // The manifest is itself a published asset, so it is signed and checksummed
    // like the rest.
    signDirectory({ directory, key, version: VERSION });
    await writeChecksums(directory);
  });

  after(async () => {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("checks, downloads and verifies one release without reaching GitHub", async () => {
    server = await startMockReleaseServer({
      releases: [{ directory, tag: TAG, body: "" }],
    });
    const index = await fetch(`${server.source}/releases`).then((response) =>
      response.json(),
    );
    const release = index.find((entry) => entry.tag_name === TAG);
    assert.ok(release, "the mock release server published no release");

    const offer = deriveOffer(release, TARGET);
    assert.match(offer.sha256, /^[0-9a-f]{64}$/);

    // The manifest names the same release and the same version the index did.
    const manifest = await fetch(offer.manifestUrl).then((response) =>
      response.json(),
    );
    assert.equal(manifest.version, VERSION);
    const entry = manifest.platforms[TARGET];
    assert.ok(entry, `latest.json has no entry for ${TARGET}`);
    assert.ok(entry.signature.trim(), "a manifest entry without a signature");

    // The bundle, as the updater would fetch it.
    const bytes = Buffer.from(
      await fetch(offer.bundleUrl).then((response) => response.arrayBuffer()),
    );
    assert.equal(bytes.length, offer.sizeBytes);
    // Statement one: the digest the release published for these bytes.
    assert.equal(digestOf(bytes), offer.sha256);
    // Statement two: the signature, against the key this build carries.
    const verified = verifyDetached(publicKeyText, entry.signature, bytes);
    assert.equal(
      verified.ok,
      true,
      `the published signature did not verify: ${verified.reason}`,
    );
  });

  it("catches a replaced byte with the digest and with the signature", async () => {
    const bundleName = updaterAsset(TARGET);
    const corrupting = await startMockReleaseServer({
      releases: [{ directory, tag: TAG, body: "" }],
      faults: { corrupt: bundleName },
    });
    try {
      const index = await fetch(`${corrupting.source}/releases`).then(
        (response) => response.json(),
      );
      const offer = deriveOffer(
        index.find((entry) => entry.tag_name === TAG),
        TARGET,
      );
      const bytes = Buffer.from(
        await fetch(offer.bundleUrl).then((response) => response.arrayBuffer()),
      );
      // The size still matches — that is why the digest and the signature both
      // exist, and why the size alone is never treated as verification.
      assert.equal(bytes.length, offer.sizeBytes);
      assert.notEqual(digestOf(bytes), offer.sha256);
      const signature = readFileSync(
        join(directory, offer.signatureAsset),
        "utf8",
      );
      assert.deepEqual(verifyDetached(publicKeyText, signature, bytes), {
        ok: false,
        reason: "signatureMismatch",
      });
    } finally {
      await corrupting.close();
    }
  });

  it("refuses a signature made by another key", () => {
    const other = generateKey();
    const signature = readFileSync(
      join(directory, `${updaterAsset(TARGET)}.sig`),
      "utf8",
    );
    assert.deepEqual(
      verifyDetached(publicKeyFile(other), signature, bundleBytes),
      {
        ok: false,
        reason: "signatureKeyMismatch",
      },
    );
  });

  it("keeps the installers out of the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(directory, "latest.json"), "utf8"),
    );
    // A .dmg or .msi is installed by hand and updated by hand; offering one
    // through the updater would offer an update it cannot perform.
    for (const entry of Object.values(manifest.platforms)) {
      assert.doesNotMatch(entry.url, /\.(dmg|msi|deb|rpm)$/);
    }
  });
});
