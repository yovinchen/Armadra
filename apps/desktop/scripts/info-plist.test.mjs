import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { load } from "js-yaml";

/**
 * Release guard for the macOS Info.plist usage descriptions the production
 * build ships (`electron-builder.yml`'s `mac.extendInfo`, merged into
 * Info.plist by electron-builder). Armadra's bundle config lives in
 * `electron-builder.yml`; this allowlist is checked under `node:test`,
 * following the package's script-test convention (`scripts/*.test.mjs`).
 *
 * WHY NSLocalNetworkUsageDescription EXISTS
 * On macOS 15+ a connection to an address on the user's own subnet is
 * gated by Local Network privacy, and access is attributed to the
 * RESPONSIBLE PROCESS — which for everything Armadra spawns (the Rust
 * Runtime, the Go Host, an agent CLI) is Armadra.app, not the child.
 * Apple-signed binaries such as `/usr/bin/curl` are exempt; a Homebrew `node`
 * or an agent's own binary is not. Without this key there is no usage string
 * to show, so the system does not prompt and no row appears under System
 * Settings → Privacy & Security → Local Network: the denial is SILENT and
 * ungrantable, surfacing to the user as `EHOSTUNREACH` from inside an agent
 * session or from the Runtime reaching a LAN host, while `curl` to the same
 * host at the same moment succeeds. The key is what turns an invisible denial
 * into a permission the user can grant.
 *
 * WHAT THIS KEY IS NOT: it is not a claim that this fixes anyone's LAN access,
 * and it is not the sandbox lever — the app is not sandboxed (no
 * `com.apple.security.app-sandbox` in build/entitlements.mac.plist), so
 * `com.apple.security.network.client` means nothing here and is deliberately
 * absent from the entitlements.
 */
const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "..", "electron-builder.yml");

/**
 * Every `NS*UsageDescription` the production build is allowed to declare,
 * with the capability it is paired to. A usage description is a sentence the
 * OS shows the user in a permission prompt, so it is reviewed like an
 * entitlement.
 */
const REVIEWED_USAGE_DESCRIPTIONS = {
  NSLocalNetworkUsageDescription:
    "the Runtime and connected agent CLIs reach hosts on the local subnet; " +
    "macOS attributes that to Armadra.app as the responsible process",
};

/**
 * Keys that must not appear, with what declaring them would cost.
 * `NSBonjourServices` is the trap that comes attached to the local-network
 * key: it is required only to BROWSE Bonjour/mDNS services, and Armadra does
 * none of that — the Runtime and Host bind fixed loopback addresses and are
 * discovered through `endpoints.json`, never through mDNS. Declaring service
 * types nothing here browses would put a false claim in front of the user and
 * App Review, and it does not widen the unicast local-network access this app
 * actually makes.
 */
const FORBIDDEN_INFO_KEYS = {
  NSBonjourServices:
    "declares Bonjour service types the app browses — Armadra browses none; a unicast " +
    "connection to a LAN address needs NSLocalNetworkUsageDescription only",
};

function extendInfo() {
  const config = load(readFileSync(CONFIG, "utf8"));
  return config?.mac?.extendInfo ?? {};
}

test("declares a local-network usage description", () => {
  const text = extendInfo().NSLocalNetworkUsageDescription;
  assert.ok(
    typeof text === "string" && text.trim().length > 0,
    "NSLocalNetworkUsageDescription is missing or empty. Without it macOS 15+ denies " +
      "local-subnet access to everything Armadra spawns SILENTLY — no prompt, and no row " +
      "in System Settings → Privacy & Security → Local Network for the user to grant.",
  );
});

test("declares only reviewed usage descriptions, each with a non-empty string", () => {
  const keys = Object.keys(extendInfo());
  const usage = keys.filter((k) => k.endsWith("UsageDescription"));
  const unreviewed = usage.filter((k) => !(k in REVIEWED_USAGE_DESCRIPTIONS));
  assert.deepEqual(
    unreviewed,
    [],
    "Unreviewed macOS usage description(s) in the production build. The string is shown to " +
      "the user in a system permission prompt — add it to REVIEWED_USAGE_DESCRIPTIONS with " +
      "the capability it is paired to, after deciding the app genuinely needs that access.",
  );
  const info = extendInfo();
  for (const key of usage) {
    const text = info[key];
    assert.ok(
      typeof text === "string" && text.trim().length > 0,
      `${key} must be a non-empty string`,
    );
  }
});

test("claims no capability it does not use", () => {
  const keys = Object.keys(extendInfo());
  for (const [key, why] of Object.entries(FORBIDDEN_INFO_KEYS)) {
    assert.ok(
      !keys.includes(key),
      `${key} is declared in mac.extendInfo: ${why}`,
    );
  }
});
