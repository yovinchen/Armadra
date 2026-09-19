import { strict as assert } from "node:assert";
import test from "node:test";

import {
  APPLE_ID_ENV,
  APPLE_PASSWORD_ENV,
  APPLE_TEAM_ENV,
  CERT_ENV,
  CERT_PASSWORD_ENV,
  ENDPOINTS_ENV,
  REQUIRE_ENV,
  builderArgs,
  configOverride,
  signingPlan,
} from "./signing-electron.mjs";

function notarizeEnv() {
  return {
    [APPLE_ID_ENV]: "dev@example.com",
    [APPLE_PASSWORD_ENV]: "app-specific-password",
    [APPLE_TEAM_ENV]: "TEAMID1234",
  };
}

test("a certificate and full notarize credentials sign and notarize", () => {
  const plan = signingPlan({
    env: {
      [CERT_ENV]: "base64cert",
      [CERT_PASSWORD_ENV]: "secret",
      ...notarizeEnv(),
    },
  });
  assert.equal(plan.mode, "sign");
  assert.equal(plan.notarize, true);
  assert.deepEqual(builderArgs(plan), []);
});

test("a certificate with no notarize credentials signs without notarizing", () => {
  const plan = signingPlan({
    env: { [CERT_ENV]: "base64cert", [CERT_PASSWORD_ENV]: "secret" },
  });
  assert.equal(plan.mode, "sign");
  assert.equal(plan.notarize, false);
  assert.deepEqual(builderArgs(plan), [
    "-c",
    JSON.stringify({ mac: { notarize: false } }),
  ]);
});

test("a certificate with no password is refused before packaging", () => {
  const plan = signingPlan({ env: { [CERT_ENV]: "base64cert" } });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "certPasswordMissing");
  assert.match(plan.message, new RegExp(CERT_PASSWORD_ENV));
});

test("partial notarize credentials are refused rather than silently skipped", () => {
  const plan = signingPlan({
    env: {
      [CERT_ENV]: "base64cert",
      [CERT_PASSWORD_ENV]: "secret",
      [APPLE_ID_ENV]: "dev@example.com",
      // APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID missing.
    },
  });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "notarizeCredentialsPartial");
});

test("no certificate skips signing and turns notarization off", () => {
  const plan = signingPlan({ env: {} });
  assert.equal(plan.mode, "skip");
  assert.equal(plan.reason, "certMissing");
  assert.deepEqual(builderArgs(plan), [
    "-c",
    JSON.stringify({ mac: { notarize: false } }),
  ]);
  assert.match(plan.message, /Gatekeeper will warn/);
});

test("a release build refuses to be unsigned", () => {
  const plan = signingPlan({ env: { [REQUIRE_ENV]: "1" } });
  assert.equal(plan.mode, "refuse");
  assert.equal(plan.reason, "certRequired");
});

test("ARMADRA_REQUIRE_SIGNED_BUNDLE=0 does not count as required", () => {
  const plan = signingPlan({ env: { [REQUIRE_ENV]: "0" } });
  assert.equal(plan.mode, "skip");
});

test("ARMADRA_UPDATER_ENDPOINTS overrides publish.url, merged with the signing override", () => {
  const plan = signingPlan({ env: {} });
  const override = configOverride(plan, {
    [ENDPOINTS_ENV]:
      "https://updates.armadra.dev/stable, https://updates.armadra.dev/mirror",
  });
  assert.deepEqual(override, {
    mac: { notarize: false },
    publish: { provider: "generic", url: "https://updates.armadra.dev/stable" },
  });
});

test("no ARMADRA_UPDATER_ENDPOINTS leaves the plan's own override untouched", () => {
  const plan = signingPlan({
    env: {
      [CERT_ENV]: "base64cert",
      [CERT_PASSWORD_ENV]: "secret",
      ...notarizeEnv(),
    },
  });
  assert.equal(configOverride(plan, {}), null);
  assert.deepEqual(builderArgs(plan, {}), []);
});
