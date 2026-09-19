/**
 * What a shipped build is allowed to claim about updates
 * (docs/design/updates-and-service-install.md §2.5).
 *
 * Ported from the Rust shell's updater-config suite. Three of its six tests
 * carried over as rules: an unusable configuration is not configured, a
 * complete one is, and the trustworthy half — not the endpoint half — is what
 * makes a build unable to update. The other three asserted the contents of
 * the packaged configuration itself (no committed endpoint, updater off,
 * `createUpdaterArtifacts: true`); their electron-builder equivalents live in
 * the packaging configuration W2.3 owns, and are noted at the end of this file
 * so the handover is written down rather than remembered.
 */
import { expect, it } from "vitest";

import {
  configuredEndpoints,
  developmentOverride,
  initialState,
  markerDisables,
  missingUpdaterConfig,
  shouldEnableUpdater,
  type UpdaterEnvironment,
} from "./availability";

function environment(
  overrides: Partial<UpdaterEnvironment> = {},
): UpdaterEnvironment {
  return {
    packaged: true,
    marker: undefined,
    publishConfigured: true,
    signature: "signed",
    developmentOverride: false,
    ...overrides,
  };
}

it("an unusable updater configuration is not configured", () => {
  const unusable: Partial<UpdaterEnvironment>[] = [
    // Development: nothing is packaged, so nothing is signed.
    { packaged: false, signature: "unsigned" },
    // Packaged but unsigned — the case the acceptance calls out by name.
    { signature: "unsigned" },
    // Packaged, signature unknown. Windows is here until W2.3 wires
    // Authenticode: "sign first, then turn on automatic updates".
    { signature: "unknown" },
    // Signed, but nothing says where releases are published.
    { publishConfigured: false },
  ];
  for (const overrides of unusable) {
    const state = initialState(environment(overrides));
    expect(
      state.state,
      `${JSON.stringify(overrides)} was treated as configured`,
    ).not.toBe("idle");
    // The rule the whole feature rests on: never "up to date" for a check
    // nobody made.
    expect(state.state).not.toBe("upToDate");
    expect(shouldEnableUpdater(environment(overrides))).toBe(false);
  }
});

it("a complete configuration is configured", () => {
  expect(missingUpdaterConfig(environment())).toEqual({
    pubkey: false,
    endpoints: false,
  });
  expect(initialState(environment())).toEqual({ state: "idle" });
  expect(shouldEnableUpdater(environment())).toBe(true);
  // Linux packages carry no code signature; the feed's own digest plus the
  // Host's sha256 are what make their bytes trustworthy.
  expect(initialState(environment({ signature: "notApplicable" }))).toEqual({
    state: "idle",
  });
});

/**
 * The trustworthy half is what makes a check mean anything, so its absence —
 * and only its absence — is what a person is told about first. A missing
 * endpoint is the intended shape of the source tree, not a fault.
 */
it("an unsigned build reports not configured, never up to date", () => {
  const unsigned = initialState(environment({ signature: "unsigned" }));
  expect(unsigned).toEqual({
    state: "notConfigured",
    missing: { pubkey: true, endpoints: false },
  });
  // Even with no endpoint either: the signature is the thing a person can do
  // something about, so it is what they are told, exactly as the Rust shell
  // told them about the missing key.
  expect(
    initialState(
      environment({ signature: "unsigned", publishConfigured: false }),
    ),
  ).toEqual({
    state: "notConfigured",
    missing: { pubkey: true, endpoints: true },
  });
  expect(JSON.stringify(unsigned)).toContain("notConfigured");
  expect(JSON.stringify(unsigned)).not.toContain("upToDate");
});

/**
 * The local-package marker. See `availability.ts` for the contract W2.3 has to
 * honour when it writes it.
 */
it("a local package marker turns the updater off without lying about a check", () => {
  expect(markerDisables("disabled")).toBe(true);
  expect(markerDisables(" Disabled ")).toBe(true);
  for (const marker of [undefined, "", "enabled", 1, null, {}]) {
    expect(markerDisables(marker), JSON.stringify(marker)).toBe(false);
  }
  const local = initialState(environment({ marker: "disabled" }));
  // `localBuild`, not `upToDate`: the build never went through CI, and a
  // manual check there must not answer as though it had consulted the feed.
  expect(local).toEqual({ state: "localBuild" });
  expect(shouldEnableUpdater(environment({ marker: "disabled" }))).toBe(false);
  // A release package carries no marker and keeps updating itself.
  expect(initialState(environment({ marker: undefined }))).toEqual({
    state: "idle",
  });
});

/**
 * The development escape hatch, and only that: `ARMADRA_UPDATES_DEV=1` lets an
 * unpackaged build talk to a loopback release server so the wiring can be
 * exercised at all. It does not relax the install — electron-updater still
 * refuses an unsigned package — and that refusal is the expected end of the
 * local walkthrough.
 */
it("the development override opens the wiring and nothing else", () => {
  const dev = environment({
    packaged: false,
    signature: "unsigned",
    developmentOverride: true,
  });
  expect(initialState(dev)).toEqual({ state: "idle" });
  expect(shouldEnableUpdater(dev)).toBe(true);
  // Without an endpoint there is still nowhere to look.
  expect(initialState({ ...dev, publishConfigured: false })).toEqual({
    state: "notConfigured",
    missing: { pubkey: false, endpoints: true },
  });
  expect(developmentOverride({ ARMADRA_UPDATES_DEV: "1" })).toBe(true);
  for (const value of [undefined, "", "0", "true", "yes"]) {
    expect(developmentOverride({ ARMADRA_UPDATES_DEV: value })).toBe(false);
  }
});

/**
 * Design §2.5, step 3: the release address is never committed. It is injected
 * by CI as a fallback and, at run time, taken from the release the Host
 * described — so a beta build reads the beta release's manifest. The variable
 * and its comma-separated spelling are the ones
 * `apps/desktop/scripts/signing.mjs:109-140` already defined.
 */
it("the release address comes from the environment, comma separated", () => {
  expect(configuredEndpoints({})).toEqual([]);
  expect(configuredEndpoints({ ARMADRA_UPDATER_ENDPOINTS: "  ,  ," })).toEqual(
    [],
  );
  expect(
    configuredEndpoints({
      ARMADRA_UPDATER_ENDPOINTS:
        " http://127.0.0.1:8123/v0.2.0 , https://releases.invalid/latest ",
    }),
  ).toEqual([
    "http://127.0.0.1:8123/v0.2.0",
    "https://releases.invalid/latest",
  ]);
});
