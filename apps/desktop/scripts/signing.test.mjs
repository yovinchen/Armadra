import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ENDPOINTS_ENV,
  PRIVATE_KEY_ENV,
  REQUIRE_ENV,
  configOverride,
  signingPlan,
  tauriArgs,
} from "./signing.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The configuration as it is actually checked in. */
function repositoryConfig() {
  return JSON.parse(
    readFileSync(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"),
  );
}

function config({ pubkey = "", artifacts = true } = {}) {
  return {
    plugins: { updater: { pubkey } },
    bundle: { createUpdaterArtifacts: artifacts },
  };
}

test("a key and a matching public half is an ordinary signed build", () => {
  const plan = signingPlan({
    env: { [PRIVATE_KEY_ENV]: "dW50cnVzdGVk" },
    config: config({ pubkey: "dW50cnVzdGVkIGNvbW1lbnQ=" }),
  });
  assert.equal(plan.mode, "sign");
  // Nothing is overridden: the checked-in configuration is the release one.
  assert.deepEqual(tauriArgs(plan), []);
});

test("a private key with no public key is refused before anything is built", () => {
  const plan = signingPlan({
    env: { [PRIVATE_KEY_ENV]: "dW50cnVzdGVk" },
    config: config({ pubkey: "   " }),
  });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "pubkeyMissing");
  // The message has to name the field, because "Missing comment in public key"
  // — what Tauri says at the end of the build — does not.
  assert.match(plan.message, /plugins\.updater\.pubkey/);
});

test("no key skips signing and turns the updater artifacts off", () => {
  const plan = signingPlan({ env: {}, config: config({ pubkey: "" }) });
  assert.equal(plan.mode, "skip");
  assert.equal(plan.reason, "keyMissing");
  // This is the whole point: without the override the bundler would build for
  // twenty minutes and then fail on the signing step.
  assert.deepEqual(tauriArgs(plan), [
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  ]);
  assert.match(plan.message, /no updater package and no signature/);
});

test("nothing is overridden when the config never asked for updater artifacts", () => {
  const plan = signingPlan({
    env: {},
    config: config({ artifacts: false }),
  });
  assert.equal(plan.mode, "skip");
  assert.deepEqual(tauriArgs(plan), []);
});

test("a release build refuses to be unsigned", () => {
  const plan = signingPlan({
    env: { [REQUIRE_ENV]: "1" },
    config: config(),
  });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "keyRequired");

  // "0" is how a workflow turns the requirement off without unsetting it.
  assert.equal(
    signingPlan({ env: { [REQUIRE_ENV]: "0" }, config: config() }).mode,
    "skip",
  );
});

test("an empty or whitespace key counts as no key", () => {
  for (const value of ["", "   ", undefined]) {
    const plan = signingPlan({
      env: { [PRIVATE_KEY_ENV]: value },
      config: config({ pubkey: "dW50cnVzdGVk" }),
    });
    assert.equal(plan.mode, "skip", JSON.stringify(value));
  }
});

test("a missing plugins or bundle section does not throw", () => {
  for (const broken of [{}, { plugins: {} }, { bundle: {} }, null]) {
    const plan = signingPlan({ env: {}, config: broken });
    assert.equal(plan.mode, "skip");
    assert.deepEqual(tauriArgs(plan), []);
  }
});

test("the checked-in configuration builds without a key today", () => {
  // The repository ships no public key yet (design §2.5), so a developer
  // running `pnpm --filter @armadra/desktop build` must get installers, a
  // warning, and no signing step at all.
  const plan = signingPlan({ env: {}, config: repositoryConfig() });
  assert.equal(plan.mode, "skip");

  // And once a key does arrive, that same configuration must not be one that
  // silently produces unverifiable bundles.
  const signed = signingPlan({
    env: { [PRIVATE_KEY_ENV]: "dW50cnVzdGVk" },
    config: repositoryConfig(),
  });
  assert.equal(
    signed.mode,
    repositoryConfig().plugins.updater.pubkey.trim() === "" ? "refuse" : "sign",
  );
});

test("the injected endpoints and the signing decision arrive as one --config", () => {
  // `tauri build` keeps only the last --config, so a release build that both
  // skips signing and needs a fallback manifest address must not send two.
  const skipped = signingPlan({ env: {}, config: config({ pubkey: "" }) });
  const env = { [ENDPOINTS_ENV]: " https://example.invalid/latest.json , " };
  assert.deepEqual(configOverride(skipped, env), {
    bundle: { createUpdaterArtifacts: false },
    plugins: {
      updater: { endpoints: ["https://example.invalid/latest.json"] },
    },
  });
  const args = tauriArgs(skipped, env);
  assert.equal(args.length, 2);
  assert.equal(args[0], "--config");
  assert.deepEqual(JSON.parse(args[1]), configOverride(skipped, env));
});

test("no endpoint variable leaves the checked-in empty endpoints alone", () => {
  const signed = signingPlan({
    env: { [PRIVATE_KEY_ENV]: "dW50cnVzdGVk" },
    config: config({ pubkey: "dW50cnVzdGVk" }),
  });
  assert.equal(signed.mode, "sign");
  for (const env of [{}, { [ENDPOINTS_ENV]: "" }, { [ENDPOINTS_ENV]: " , " }]) {
    assert.equal(configOverride(signed, env), null);
    assert.deepEqual(tauriArgs(signed, env), []);
  }
});
