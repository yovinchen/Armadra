import { describe, expect, it } from "vitest";

import {
  formatProgress,
  hostVerdictKind,
  mergeUpdatesState,
  reasonKey,
  shellReasonKey,
  type HostSide,
  type HostVerdictKind,
  type UpdatesViewState,
} from "./state";
import type { ShellOffer, ShellUpdateState } from "./shell-updater";

const offer: ShellOffer = {
  version: "0.2.0",
  target: "darwin-aarch64",
  manifestUrl: "https://releases.invalid/download/v0.2.0/latest.json",
  packageUrl:
    "https://releases.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
  sha256: "a".repeat(64),
  sizeBytes: 4096,
  signed: true,
  notesUrl: "https://releases.invalid/v0.2.0",
};

function answered(verdict: HostVerdictKind, reasonCode = ""): HostSide {
  return {
    kind: "answered",
    verdict,
    reasonCode,
    retryAfterMs: 0,
    checkedAtMs: 1_700_000_000_000,
    release: null,
  };
}

/** Every host side this build can be in. */
const HOST_SIDES: HostSide[] = [
  { kind: "notAsked" },
  { kind: "checking" },
  { kind: "blocked", reason: "signedOut" },
  { kind: "failed", messageKey: "updates.error.unauthenticated" },
  answered("upToDate"),
  answered("available"),
  answered("unsupported", "UPDATES_NOT_CONFIGURED"),
  answered("unavailable", "SOURCE_UNREACHABLE"),
  answered("unknown", "SOMETHING_NEW"),
];

/** Every shell side this build can be in. */
const SHELL_SIDES: ShellUpdateState[] = [
  { state: "notConfigured", missing: { pubkey: true, endpoints: true } },
  { state: "localBuild" },
  { state: "unsupported", reason: "notDesktop" },
  { state: "idle" },
  { state: "checking" },
  { state: "upToDate", checkedAtMs: 1_700_000_000_000 },
  {
    state: "unavailable",
    reason: "sourceUnreachable",
    retryAfterMs: 900_000,
    checkedAtMs: 1_700_000_000_000,
  },
  { state: "available", offer },
  { state: "downloading", offer, receivedBytes: 1024, totalBytes: 4096 },
  { state: "downloaded", offer, phase: "ready", problem: null },
  { state: "downloaded", offer, phase: "preparing", problem: null },
  { state: "downloaded", offer, phase: "installing", problem: null },
  { state: "failed", reason: "digestMismatch", offer },
  { state: "failed", reason: "updaterUnavailable", offer: null },
];

describe("mergeUpdatesState", () => {
  /**
   * The rule the whole section exists to keep. Not looking, failing to look,
   * and looking and finding nothing are three answers; only the third one may
   * be rendered as reassuring.
   */
  it("never reports up to date unless both sides said so", () => {
    for (const host of HOST_SIDES) {
      for (const shell of SHELL_SIDES) {
        const view = mergeUpdatesState(host, shell);
        if (view.state !== "upToDate") continue;
        expect(host).toMatchObject({ kind: "answered", verdict: "upToDate" });
        expect(shell.state).toBe("upToDate");
      }
    }
  });

  it("produces a state and a status key this build can render, for every pair", () => {
    const known: UpdatesViewState[] = [
      "notConfigured",
      "localBuild",
      "shellUnsupported",
      "idle",
      "checking",
      "upToDate",
      "unavailable",
      "available",
      "downloading",
      "downloaded",
      "failed",
    ];
    for (const host of HOST_SIDES) {
      for (const shell of SHELL_SIDES) {
        const view = mergeUpdatesState(host, shell);
        expect(known).toContain(view.state);
        expect(view.statusKey.startsWith("updates.")).toBe(true);
        for (const key of view.detailKeys) {
          expect(key.startsWith("updates.")).toBe(true);
        }
      }
    }
  });

  /** The three states that describe the build win over any answer. */
  it("lets what the build is override what a release says", () => {
    for (const host of HOST_SIDES) {
      expect(
        mergeUpdatesState(host, {
          state: "notConfigured",
          missing: { pubkey: true, endpoints: false },
        }).state,
      ).toBe("notConfigured");
      expect(mergeUpdatesState(host, { state: "localBuild" }).state).toBe(
        "localBuild",
      );
      expect(
        mergeUpdatesState(host, { state: "unsupported", reason: "remoteHost" })
          .state,
      ).toBe("shellUnsupported");
    }
  });

  it("says which half of the configuration is missing", () => {
    const view = mergeUpdatesState(answered("upToDate"), {
      state: "notConfigured",
      missing: { pubkey: true, endpoints: false },
    });
    expect(view.detailKeys).toContain("updates.missing.pubkey");
    expect(view.detailKeys).not.toContain("updates.missing.endpoints");
    expect(view.actions).toEqual(["openHostSettings"]);
  });

  it("shows the Host's answer and the manual route where nothing can install", () => {
    const view = mergeUpdatesState(answered("available"), {
      state: "unsupported",
      reason: "notDesktop",
    });
    expect(view.detailKeys).toContain("updates.unsupported.notDesktop");
    expect(view.detailKeys).toContain("updates.install.manual");
  });

  it("treats a session it could not open as not configured, never as fine", () => {
    const view = mergeUpdatesState(
      { kind: "blocked", reason: "signedOut" },
      {
        state: "idle",
      },
    );
    expect(view.state).toBe("notConfigured");
    expect(view.detailKeys).toEqual(["updates.blocked.signedOut"]);
  });

  it("labels an answer that only one side gave", () => {
    // The shell found nothing; the Host could not say. That is not "newest".
    const view = mergeUpdatesState(
      answered("unavailable", "SOURCE_UNREACHABLE"),
      { state: "upToDate", checkedAtMs: 1 },
    );
    expect(view.state).toBe("unavailable");
    expect(view.partial).toBe("hostNotChecked");
    expect(view.detailKeys).toContain("updates.reason.SOURCE_UNREACHABLE");
  });

  it("offers download and skip for an offer, and the notes when there are any", () => {
    const view = mergeUpdatesState(answered("available"), {
      state: "available",
      offer,
    });
    expect(view.state).toBe("available");
    expect(view.actions).toEqual(["download", "skip", "notes"]);
    expect(view.offer).toEqual(offer);
  });

  it("reports progress while transferring and offers nothing to press", () => {
    const view = mergeUpdatesState(answered("available"), {
      state: "downloading",
      offer,
      receivedBytes: 2048,
      totalBytes: 4096,
    });
    expect(view.progress).toEqual({ receivedBytes: 2048, totalBytes: 4096 });
    expect(view.actions).toEqual([]);
  });

  it("offers the restart only while it has not started", () => {
    const staged = mergeUpdatesState(answered("available"), {
      state: "downloaded",
      offer,
      phase: "ready",
      problem: null,
    });
    expect(staged.actions).toEqual(["restart"]);
    expect(staged.detailKeys).toContain("updates.downloaded.note");

    for (const phase of ["preparing", "installing"] as const) {
      const running = mergeUpdatesState(answered("available"), {
        state: "downloaded",
        offer,
        phase,
        problem: null,
      });
      expect(running.state).toBe("downloaded");
      expect(running.actions).toEqual([]);
    }
  });

  it("explains a restart that came back without installing", () => {
    const view = mergeUpdatesState(answered("available"), {
      state: "downloaded",
      offer,
      phase: "ready",
      problem: "hostStopFailed",
    });
    expect(view.detailKeys).toContain("updates.shellReason.hostStopFailed");
    expect(view.actions).toEqual(["restart"]);
  });

  it("keeps a failure retryable only while it still has an offer", () => {
    expect(
      mergeUpdatesState(answered("available"), {
        state: "failed",
        reason: "digestMismatch",
        offer,
      }).actions,
    ).toEqual(["retry", "notes"]);
    expect(
      mergeUpdatesState(answered("available"), {
        state: "failed",
        reason: "updaterUnavailable",
        offer: null,
      }).actions,
    ).toEqual(["check"]);
  });
});

describe("host verdicts", () => {
  it("maps the states this build knows and refuses to guess the rest", () => {
    expect(hostVerdictKind(1)).toBe("upToDate");
    expect(hostVerdictKind(2)).toBe("available");
    expect(hostVerdictKind(3)).toBe("unsupported");
    expect(hostVerdictKind(4)).toBe("unavailable");
    // UNSPECIFIED, and anything a newer Host might answer with.
    for (const state of [0, 5, 42, -1]) {
      expect(hostVerdictKind(state)).toBe("unknown");
    }
  });

  it("never prints a reason token this build does not have a sentence for", () => {
    expect(reasonKey("SOURCE_UNREACHABLE")).toBe(
      "updates.reason.SOURCE_UNREACHABLE",
    );
    expect(reasonKey("SOMETHING_NEW")).toBe("updates.reason.unknown");
    expect(reasonKey("")).toBe("updates.reason.unknown");
    expect(shellReasonKey("diskFull")).toBe("updates.shellReason.diskFull");
    expect(shellReasonKey(null)).toBeNull();
  });
});

describe("formatProgress", () => {
  it("never renders a fraction of an unknown total", () => {
    expect(formatProgress(1_048_576, 4_194_304)).toBe("1.0 MB / 4.0 MB");
    expect(formatProgress(1_048_576, 0)).toBe("1.0 MB");
  });
});
