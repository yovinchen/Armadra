/**
 * What `electron-builder` should do about signing and notarization, decided
 * **before** the build starts. Same problem and the same fix as the
 * Tauri-era `scripts/signing.mjs` (docs/guides/ci-release.md §2.6,
 * docs/design/updates-and-service-install.md §2.5): electron-builder's own
 * `hardenedRuntime` + `notarize: true` in `electron-builder.yml` sign and
 * notarize unconditionally once the packaging step runs, and notarization in
 * particular is a network round-trip at the very end of a multi-minute
 * build. Deciding here, from the environment, means a build that cannot be
 * signed says so in the first second instead of the last one — and the
 * `signingPlan()` shape below (`sign` / `skip` / `refuse`, each with a
 * `reason` and a `message`) is kept the same as `signing.mjs` on purpose, so
 * `scripts/dist.mjs` reads both plans the same way.
 *
 * The key material is a different system from Tauri's (minisign key pair for
 * updater artifacts): electron-builder signs and notarizes macOS bundles with
 * Apple's own tools, driven by these environment variables —
 *
 *   CSC_LINK / CSC_KEY_PASSWORD              base64 (or file path) .p12 + its password
 *   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD   notarytool credentials
 *   APPLE_TEAM_ID                            notarytool team
 *
 * — which is also why this is a second script rather than a rewrite of
 * `signing.mjs`: the two key systems, and the two sets of environment
 * variables, do not merge into one meaningful "have a key or not" check.
 * `signing.mjs` still decides for the Tauri shell, which keeps shipping until
 * W5.
 */

/** The p12 certificate (base64 or a file path) electron-builder signs macOS builds with. */
export const CERT_ENV = "CSC_LINK";
/** Its password. */
export const CERT_PASSWORD_ENV = "CSC_KEY_PASSWORD";
/** notarytool credentials — all three are required together, or notarization is skipped. */
export const APPLE_ID_ENV = "APPLE_ID";
export const APPLE_PASSWORD_ENV = "APPLE_APP_SPECIFIC_PASSWORD";
export const APPLE_TEAM_ENV = "APPLE_TEAM_ID";
/** Set by CI to turn "skip" into a failure: a release must be signed. */
export const REQUIRE_ENV = "ARMADRA_REQUIRE_SIGNED_BUNDLE";
/** Where a *published* release's updater manifest lives; never baked into a local build. */
export const ENDPOINTS_ENV = "ARMADRA_UPDATER_ENDPOINTS";

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Decides what this build does about code signing and notarization.
 *
 * Unlike the Tauri plan there is no "refuse" case driven by the checked-in
 * configuration: electron-builder does not embed a public key the shell
 * verifies against (that is electron-updater's job, landing in W2.2), so
 * there is nothing here a mismatched key could be rejected by at install
 * time. "refuse" still exists for `ARMADRA_REQUIRE_SIGNED_BUNDLE=1` without a
 * certificate, and for a certificate present without its password (an
 * electron-builder run in that state fails at the signing step with a
 * keychain-import error that names neither environment variable).
 *
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @returns {{ mode: "sign" | "skip" | "refuse", reason: string, message: string,
 *   notarize: boolean, configOverride: object | null }}
 */
export function signingPlan({ env = {} } = {}) {
  const cert = present(env[CERT_ENV]);
  const certPassword = present(env[CERT_PASSWORD_ENV]);
  const required = present(env[REQUIRE_ENV]) && env[REQUIRE_ENV] !== "0";
  const appleId = present(env[APPLE_ID_ENV]);
  const applePassword = present(env[APPLE_PASSWORD_ENV]);
  const appleTeam = present(env[APPLE_TEAM_ENV]);
  const notarizeFields = [appleId, applePassword, appleTeam];
  const notarizeComplete = notarizeFields.every(Boolean);
  const notarizePartial = notarizeFields.some(Boolean) && !notarizeComplete;

  if (cert && !certPassword) {
    return {
      mode: "refuse",
      reason: "certPasswordMissing",
      message:
        `${CERT_ENV} is set but ${CERT_PASSWORD_ENV} is empty.\n` +
        "electron-builder cannot import a password-protected .p12 without its password, " +
        "and fails at the signing step with a keychain error that names neither variable.",
      notarize: false,
      configOverride: null,
    };
  }
  if (cert && notarizePartial) {
    return {
      mode: "refuse",
      reason: "notarizeCredentialsPartial",
      message:
        `${APPLE_ID_ENV} / ${APPLE_PASSWORD_ENV} / ${APPLE_TEAM_ENV} must be set together or not at all ` +
        `(got ${notarizeFields.filter(Boolean).length} of 3). A signed-but-not-notarized build ` +
        "is a Gatekeeper warning on every first launch, which is worse than an honest failure here.",
      notarize: false,
      configOverride: null,
    };
  }
  if (cert) {
    return {
      mode: "sign",
      reason: "certificatePresent",
      message: notarizeComplete
        ? `Signing with ${CERT_ENV} and notarizing with ${APPLE_ID_ENV}.`
        : `Signing with ${CERT_ENV}; ${APPLE_ID_ENV}/${APPLE_PASSWORD_ENV}/${APPLE_TEAM_ENV} are ` +
          "not set, so the build will not be notarized.",
      notarize: notarizeComplete,
      configOverride: notarizeComplete ? null : { mac: { notarize: false } },
    };
  }
  if (required) {
    return {
      mode: "refuse",
      reason: "certRequired",
      message:
        `${REQUIRE_ENV} is set, so this build must be signed, but ${CERT_ENV} is empty.\n` +
        `Provide the certificate (base64 .p12) and ${CERT_PASSWORD_ENV}, or unset ${REQUIRE_ENV}.`,
      notarize: false,
      configOverride: null,
    };
  }
  return {
    mode: "skip",
    reason: "certMissing",
    message:
      `${CERT_ENV} is not set, so this build produces an unsigned, unnotarized bundle. ` +
      "Gatekeeper will warn on first launch. To make a signed build, set " +
      `${CERT_ENV}/${CERT_PASSWORD_ENV} (and ${APPLE_ID_ENV}/${APPLE_PASSWORD_ENV}/${APPLE_TEAM_ENV} to notarize).`,
    notarize: false,
    // hardenedRuntime + notarize: true in electron-builder.yml both require a
    // signing identity to be meaningful; turning notarize off is what keeps an
    // unsigned local build from failing inside electron-builder's own
    // signing step instead of never reaching it.
    configOverride: { mac: { notarize: false } },
  };
}

/**
 * The `--config` object electron-builder's CLI accepts for this plan, merged
 * with the updater endpoints a *published* release injects.
 *
 * `ARMADRA_UPDATER_ENDPOINTS` is comma-separated, mirroring the Tauri-era
 * `signing.mjs`: the address a real release polls must arrive from the
 * workflow that publishes to it, never from `electron-builder.yml`, whose
 * `publish.url` is the placeholder every build — signed or not — otherwise
 * shares.
 */
export function configOverride(plan, env = {}) {
  const endpoints = (env[ENDPOINTS_ENV] ?? "")
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  if (endpoints.length === 0) return plan.configOverride;
  return {
    ...(plan.configOverride ?? {}),
    publish: { provider: "generic", url: endpoints[0] },
  };
}

/** The extra `electron-builder` CLI arguments a plan implies. */
export function builderArgs(plan, env = {}) {
  const override = configOverride(plan, env);
  return override ? ["-c", JSON.stringify(override)] : [];
}
