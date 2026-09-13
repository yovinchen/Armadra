/**
 * What `tauri build` should do about update signatures, decided **before** the
 * build starts (docs/design/updates-and-service-install.md §2.5).
 *
 * The problem this exists to prevent: `bundle.createUpdaterArtifacts` is true,
 * so the bundler produces an updater package and then signs it — and it does
 * that at the very end, after the Rust build, the frontend build and the
 * bundling have all run. Without `TAURI_SIGNING_PRIVATE_KEY` that last step
 * fails with `Missing comment in public key`, which is both a twenty-minute
 * wait for an error that was knowable at second zero and a message about a
 * public key when what is missing is the private one.
 *
 * So the decision is made here, from the environment and the checked-in
 * configuration, and it is one of three:
 *
 * | Private key | `pubkey` in the config | Plan                              |
 * | ----------- | ---------------------- | --------------------------------- |
 * | set         | set                    | sign — the ordinary release build |
 * | set         | empty                  | refuse, before anything is built  |
 * | unset       | anything               | skip — build without updater bits |
 *
 * "Refuse" rather than "sign anyway" for the middle row: a package signed with
 * a key whose public half is not in the build is a package this very shell
 * would reject at install time (`src/updates/offer.rs` compares key ids), so
 * producing one is producing a release nobody can take.
 *
 * "Skip" rather than "fail" for the last row: an unsigned local build is a
 * perfectly ordinary thing to want, and the shell already reports it honestly —
 * with no public key it says "not configured" and never claims to be up to
 * date. What must not happen is a build that *looks* like a release and is not,
 * which is why skipping also turns the updater artifacts off rather than
 * leaving unsigned ones lying next to the installers.
 */

/** The private key Tauri signs updater artifacts with. Never a file path. */
export const PRIVATE_KEY_ENV = "TAURI_SIGNING_PRIVATE_KEY";
/** Its passphrase, when the key was generated with one. */
export const PASSWORD_ENV = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
/** Set by CI to turn "skip" into a failure: a release must be signed. */
export const REQUIRE_ENV = "ARMADRA_REQUIRE_SIGNED_BUNDLE";

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Decides what this build does about signatures.
 *
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {object} [input.config] the parsed `tauri.conf.json`
 * @returns {{ mode: "sign" | "skip" | "refuse", reason: string,
 *   message: string, configOverride: object | null }}
 */
export function signingPlan({ env = {}, config = {} } = {}) {
  const updater = config?.plugins?.updater ?? {};
  const pubkey = present(updater.pubkey);
  const artifacts = config?.bundle?.createUpdaterArtifacts === true;
  const key = present(env[PRIVATE_KEY_ENV]);
  const required = present(env[REQUIRE_ENV]) && env[REQUIRE_ENV] !== "0";

  if (key && !pubkey) {
    return {
      mode: "refuse",
      reason: "pubkeyMissing",
      message:
        `${PRIVATE_KEY_ENV} is set but plugins.updater.pubkey in tauri.conf.json is empty.\n` +
        "The bundle would be signed with a key this build cannot verify, and the shell would refuse it at install time.\n" +
        "Put the public half of the same key pair in plugins.updater.pubkey (see docs/guides/development.md, 更新签名).",
      configOverride: null,
    };
  }
  if (key) {
    return {
      mode: "sign",
      reason: "keyPresent",
      message: `Signing updater artifacts with ${PRIVATE_KEY_ENV}.`,
      configOverride: null,
    };
  }
  if (required) {
    return {
      mode: "refuse",
      reason: "keyRequired",
      message:
        `${REQUIRE_ENV} is set, so this build must be signed, but ${PRIVATE_KEY_ENV} is empty.\n` +
        `Provide the key (and ${PASSWORD_ENV} if it has a passphrase) or unset ${REQUIRE_ENV}.`,
      configOverride: null,
    };
  }
  return {
    mode: "skip",
    reason: "keyMissing",
    message:
      `${PRIVATE_KEY_ENV} is not set, so this build produces installers only — no updater package and no signature.\n` +
      "Nothing published from it can be applied by the in-app updater. To make a signed build, see docs/guides/development.md, 更新签名.",
    // Turning the artifacts off is what keeps the failure from happening at the
    // end of the build instead of at the start of it.
    configOverride: artifacts
      ? { bundle: { createUpdaterArtifacts: false } }
      : null,
  };
}

/**
 * Where a built shell looks for the update manifest.
 *
 * `tauri.conf.json` keeps `endpoints` empty on purpose (see the `$comment`
 * there): at runtime the address comes from the Host, and a value baked into
 * the repository would send a beta build to the stable manifest. The release
 * workflow injects the published fallback through this variable instead, so
 * the address lives in exactly one place — the workflow that publishes to it.
 */
export const ENDPOINTS_ENV = "ARMADRA_UPDATER_ENDPOINTS";

/**
 * The single `--config` object a build needs, or `null`.
 *
 * `tauri build` takes one `--config`, so the signing decision and the injected
 * endpoints have to arrive merged rather than as two flags where the second
 * silently replaces the first.
 */
export function configOverride(plan, env = {}) {
  const endpoints = (env[ENDPOINTS_ENV] ?? "")
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  if (endpoints.length === 0) return plan.configOverride;
  return {
    ...(plan.configOverride ?? {}),
    plugins: { updater: { endpoints } },
  };
}

/** The extra `tauri build` arguments a plan implies. */
export function tauriArgs(plan, env = {}) {
  const override = configOverride(plan, env);
  return override ? ["--config", JSON.stringify(override)] : [];
}
