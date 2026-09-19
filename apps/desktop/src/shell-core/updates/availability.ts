/**
 * What state a shell starts in, before anything is asked (design §2, §4.1).
 *
 * Ported from the Rust shell this one replaced, with the one substitution the
 * migration makes. Its rule was "no minisign public key configured = the
 * shell could verify nothing = `notConfigured`". electron-updater verifies the
 * platform code signature instead of a minisign detached signature, so the
 * same sentence becomes:
 *
 *   **A build that is not packaged, or packaged but not signed, could verify
 *   nothing, and says `notConfigured`.** It never says `upToDate`.
 *
 * That is the whole point of the substitution. "Not looking" and "looking and
 * finding nothing" are different answers (design §2.1 rule 1), and an unsigned
 * build cannot look: electron-updater will refuse the install at the last step
 * anyway, and a shell that reported "you are on the newest release" in the
 * meantime would have told the user something it had no way of knowing.
 *
 * The second half — `endpoints` — is where releases are published. Under
 * electron-builder that is the `publish` block, which lands in the packaged
 * app as `app-update.yml`; `ARMADRA_UPDATER_ENDPOINTS` overrides it, with the
 * comma-separated semantics `apps/desktop/scripts/signing.mjs:109-140` gave
 * the same variable.
 */

import type { MissingUpdaterConfig, UpdateState } from "./machine";

/**
 * Whether this package carries a platform signature that makes an update
 * trustworthy.
 *
 * `notApplicable` is Linux: an AppImage carries no code signature, and what
 * makes its bytes trustworthy is the sha512 in the feed plus the sha256 the
 * Host published — both of which are checked whether or not anything is
 * signed.
 *
 * `unknown` is refused rather than assumed. Windows is `unknown` until W2.3
 * wires Authenticode, which is the order the research doc states plainly:
 * **sign first, then turn on automatic updates**, because an unsigned
 * automatic update is a step backwards in trust
 * (`docs/research/nodeterm/process-model-and-platform.md` §4).
 */
export type SignatureState =
  | "signed"
  | "unsigned"
  | "notApplicable"
  | "unknown";

/**
 * The marker a LOCAL package carries in its packaged `package.json`, injected
 * by the `dist` script through electron-builder's `extraMetadata`. This is the
 * read side; W2.3 owns the write side.
 *
 * ### The contract W2.3 has to honour
 *
 * - key: `armadraUpdates`, value: the string `"disabled"`;
 * - injected by every local `dist*` script via `extraMetadata`, and by **no**
 *   release script, so a promoted build is untouched and keeps updating;
 * - read from `join(app.getAppPath(), "package.json")` at startup only.
 *
 * It exists for the reason nodeterm's `nodeTermUpdates` marker exists
 * (`src/main/updater.ts:24-37`): a locally packaged app is indistinguishable
 * from a release at runtime — `app.isPackaged` is true for both — so without
 * the marker it polls the production feed for a version that was never
 * published there and logs a `latest*.yml` 404 every check.
 *
 * The trade-off, stated plainly and the same one nodeterm wrote down: a `dist`
 * package can no longer smoke-test the updater wiring. Verifying the real feed
 * is the job of a release package, which carries no marker; verifying the
 * wiring is the job of a local release server (`ARMADRA_UPDATES_DEV=1` plus
 * `ARMADRA_UPDATER_ENDPOINTS`), which needs no package at all.
 */
export const LOCAL_PACKAGE_MARKER = "armadraUpdates";
export const LOCAL_PACKAGE_DISABLED = "disabled";

export interface UpdaterEnvironment {
  /** `app.isPackaged`. */
  packaged: boolean;
  /** The value of `armadraUpdates` in the packaged `package.json`, if any. */
  marker: unknown;
  /** Whether anything says where releases are published. */
  publishConfigured: boolean;
  signature: SignatureState;
  /** `ARMADRA_UPDATES_DEV=1`: a development escape hatch, and only that. */
  developmentOverride: boolean;
}

/**
 * Which half of the configuration is missing, in the wire shape the settings
 * page renders (`updates.missing.pubkey` / `updates.missing.endpoints`).
 */
export function missingUpdaterConfig(
  environment: UpdaterEnvironment,
): MissingUpdaterConfig {
  return {
    pubkey: !trustworthy(environment),
    endpoints: !environment.publishConfigured,
  };
}

/** Whether anything about this build could make an update trustworthy. */
function trustworthy(environment: UpdaterEnvironment): boolean {
  // The escape hatch does not relax this: it lets a development build talk to
  // a loopback release server, and electron-updater still refuses to install
  // an unsigned package at the last step. What it must not do is let the shell
  // claim it checked something it could not verify, so it is trustworthy only
  // in the sense that the operator asked for exactly this.
  if (environment.developmentOverride) return true;
  if (!environment.packaged) return false;
  return (
    environment.signature === "signed" ||
    environment.signature === "notApplicable"
  );
}

/** Whether the local-package marker turns the updater off. */
export function markerDisables(marker: unknown): boolean {
  return (
    typeof marker === "string" &&
    marker.trim().toLowerCase() === LOCAL_PACKAGE_DISABLED
  );
}

/**
 * The state a shell starts in.
 *
 * The order matters, and it is the Rust shell's order: a build that could
 * verify nothing is "not configured" even on a development channel, because
 * that is the thing a person can actually do something about.
 */
export function initialState(environment: UpdaterEnvironment): UpdateState {
  const missing = missingUpdaterConfig(environment);
  if (missing.pubkey) return { state: "notConfigured", missing };
  // A local package is a build that never went through CI, whatever
  // `app.isPackaged` says about it.
  if (markerDisables(environment.marker)) return { state: "localBuild" };
  if (!environment.packaged && !environment.developmentOverride) {
    return { state: "localBuild" };
  }
  if (missing.endpoints) return { state: "notConfigured", missing };
  return { state: "idle" };
}

/** Whether the updater should touch the network at all. */
export function shouldEnableUpdater(environment: UpdaterEnvironment): boolean {
  return initialState(environment).state === "idle";
}

/**
 * The endpoints `ARMADRA_UPDATER_ENDPOINTS` names, with the comma-separated
 * semantics of `apps/desktop/scripts/signing.mjs:109-140`. Empty when the
 * variable is unset, which is the ordinary case: the address then comes from
 * the Host's own artifact list at check time (design §2.2), and a value baked
 * into the repository would send a beta build to the stable manifest.
 */
export const ENDPOINTS_ENV = "ARMADRA_UPDATER_ENDPOINTS";

export function configuredEndpoints(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return (env[ENDPOINTS_ENV] ?? "")
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter((endpoint) => endpoint.length > 0);
}

/** `ARMADRA_UPDATES_DEV=1`, the same variable `updates/mod.rs:62-64` read. */
export function developmentOverride(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ARMADRA_UPDATES_DEV === "1";
}
