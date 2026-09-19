import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { load } from "js-yaml";

/**
 * Release guard for the packaged build's product identity — the fields a
 * user sees before the app has even opened: the installer name, the Dock/
 * taskbar icon, and (macOS) the name shown under it. `src/main/branding.test.ts`
 * covers the same identity at runtime (`app.setName`, the About panel); this
 * file covers what `electron-builder.yml` bakes into the bundle itself, the
 * same split `info-plist.test.mjs` draws for the usage-description keys.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "..", "electron-builder.yml");

function config() {
  return load(readFileSync(CONFIG, "utf8"));
}

test("the installer and bundle carry the product name", () => {
  assert.equal(config().productName, "Armadra");
});

test("every platform points its icon at the shared build/icons/ set", () => {
  const built = config();
  assert.equal(built.mac.icon, "build/icons/icon.icns");
  assert.equal(built.win.icon, "build/icons/icon.ico");
  assert.equal(built.linux.icon, "build/icons/icon.png");
});

test("macOS declares the display name Finder and Spotlight show", () => {
  const displayName = config().mac?.extendInfo?.CFBundleDisplayName;
  assert.equal(
    displayName,
    "Armadra",
    "mac.extendInfo.CFBundleDisplayName is missing or wrong — without it macOS falls back " +
      "to the shorter internal name (from productName) in the Dock, Spotlight and the Force " +
      "Quit list.",
  );
});
