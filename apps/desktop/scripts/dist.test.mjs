import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import test from "node:test";

import { electronViteEntry, mergeConfig, resolveConfig } from "./dist.mjs";
import { CERT_ENV, CERT_PASSWORD_ENV } from "./signing-electron.mjs";

test("electron-vite is resolved as JavaScript, not through a shell wrapper", () => {
  const entry = electronViteEntry();
  assert.match(entry, /electron-vite[\\/]bin[\\/]electron-vite\.js$/);
  assert.ok(existsSync(entry), entry);
});

test("mergeConfig replaces arrays and scalars, but merges nested objects", () => {
  const base = {
    mac: { notarize: true, target: ["dmg", "zip"] },
    appId: "dev.armadra.desktop",
  };
  const merged = mergeConfig(base, { mac: { notarize: false } });
  assert.deepEqual(merged, {
    mac: { notarize: false, target: ["dmg", "zip"] },
    appId: "dev.armadra.desktop",
  });
  // base is untouched
  assert.equal(base.mac.notarize, true);
});

test("mergeConfig with no override returns the base unchanged", () => {
  const base = { a: 1 };
  assert.equal(mergeConfig(base, null), base);
  assert.equal(mergeConfig(base, undefined), base);
});

test("a local build turns notarization off (no certificate) and disables the updater feed", () => {
  const { config, plan } = resolveConfig({ env: {}, local: true });
  assert.equal(plan.mode, "skip");
  assert.equal(config.mac.notarize, false);
  assert.equal(config.extraMetadata.armadraUpdates, "disabled");
  // Everything else from the checked-in file survives the merge.
  assert.equal(config.appId, "dev.armadra.desktop");
  assert.ok(Array.isArray(config.mac.target) && config.mac.target.length > 0);
});

test("a signed local build still disables the updater feed", () => {
  const { config, plan } = resolveConfig({
    env: { [CERT_ENV]: "cert", [CERT_PASSWORD_ENV]: "secret" },
    local: true,
  });
  assert.equal(plan.mode, "sign");
  assert.equal(config.extraMetadata.armadraUpdates, "disabled");
  // No certificate override needed to notarize=false here since notarize
  // credentials were not supplied either, but the mac.notarize key set by the
  // plan (false) is still what a CI *release* build (local: false) would omit.
});

test("a non-local (release) resolution does not inject the disabled-updates marker", () => {
  const { config } = resolveConfig({ env: {}, local: false });
  assert.equal(config.extraMetadata, undefined);
});
