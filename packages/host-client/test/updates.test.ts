import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  CheckForUpdateRequestSchema,
  CheckForUpdateResponseSchema,
  ReleaseChannel,
  UpdateCheckState,
  UpdateSignatureState,
} from "@armadra/protocol";
import {
  HostUpdatesClient,
  UPDATE_COMPONENTS,
  formatVersion,
  offeredSignature,
  parseVersion,
} from "../src/updates.js";
import { HostAutomationError } from "../src/automation.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";

const hostId = "2".repeat(32);

interface Sent {
  service: string;
  action: string;
  body: Uint8Array;
  mutation: boolean;
}

function client(reply: (call: Sent) => Uint8Array) {
  const calls: Sent[] = [];
  const session: HostAuthenticatedTransport = {
    send: (service, action, body, mutation) => {
      const call = { service, action, body, mutation };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
  return { api: new HostUpdatesClient({ session, hostId }), calls };
}

function answer(overrides: Record<string, unknown>) {
  return toBinary(
    CheckForUpdateResponseSchema,
    create(CheckForUpdateResponseSchema, {
      installedVersion: { major: 0, minor: 1, patch: 0, prerelease: "" },
      channel: ReleaseChannel.STABLE,
      ...overrides,
    }),
  );
}

const input = {
  channel: ReleaseChannel.STABLE,
  installedVersion: parseVersion("0.1.0")!,
  target: "darwin-aarch64",
};

describe("HostUpdatesClient", () => {
  it("asks about one component, and about the desktop when none is named", async () => {
    const { api, calls } = client(() =>
      answer({ state: UpdateCheckState.UP_TO_DATE }),
    );
    await api.check(input);
    await api.check({ ...input, component: "host" });
    const asked = calls.map(
      (call) => fromBinary(CheckForUpdateRequestSchema, call.body).component,
    );
    // An older client sent no component and meant "desktop"; the empty string
    // has to keep meaning that, or an old caller starts getting a new answer.
    expect(asked).toEqual(["", "host"]);
    expect(calls[0]!.service).toBe("UpdateService");
    expect(calls[0]!.action).toBe("CheckForUpdate");
    // A check reads; it must never be sent as a mutation.
    expect(calls.every((call) => call.mutation === false)).toBe(true);
  });

  it("refuses a component this build does not know before sending anything", async () => {
    const { api, calls } = client(() =>
      answer({ state: UpdateCheckState.UP_TO_DATE }),
    );
    await expect(
      api.check({
        ...input,
        component: "firmware" as (typeof UPDATE_COMPONENTS)[number],
      }),
    ).rejects.toThrow(HostAutomationError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed target or an unknown channel before sending anything", async () => {
    const { api, calls } = client(() =>
      answer({ state: UpdateCheckState.UP_TO_DATE }),
    );
    for (const target of ["", "darwin", "plan9-mips", "DARWIN-aarch64"]) {
      await expect(api.check({ ...input, target })).rejects.toThrow(
        HostAutomationError,
      );
    }
    await expect(
      api.check({ ...input, channel: 99 as ReleaseChannel }),
    ).rejects.toThrow(HostAutomationError);
    expect(calls).toHaveLength(0);
  });

  it("returns an offer with every artifact the release published for it", async () => {
    const artifacts = [
      {
        component: "manifest",
        target: "",
        url: "https://releases.invalid/download/v0.2.0/latest.json",
        sizeBytes: 900n,
        signature: { state: UpdateSignatureState.PRESENT, value: "", keyId: "" },
      },
      {
        component: "desktop",
        target: "darwin-aarch64",
        url: "https://releases.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
        sizeBytes: 2048n,
        signature: { state: UpdateSignatureState.PRESENT, value: "", keyId: "" },
      },
    ];
    const { api } = client(() =>
      answer({
        state: UpdateCheckState.AVAILABLE,
        release: {
          version: { major: 0, minor: 2, patch: 0, prerelease: "" },
          channel: ReleaseChannel.STABLE,
          notesUrl: "https://releases.invalid/v0.2.0",
          artifacts,
        },
      }),
    );
    const response = await api.check(input);
    expect(formatVersion(response.release?.version)).toBe("0.2.0");
    // The manifest is what the shell reads to find the bundle it may apply, so
    // it has to survive the round trip beside the desktop artifact.
    expect(response.release?.artifacts.map((one) => one.component)).toEqual([
      "manifest",
      "desktop",
    ]);
    expect(offeredSignature(response)).toBe(UpdateSignatureState.PRESENT);
  });

  it("refuses an answer that is not one of the shapes a check can have", async () => {
    const incoherent = [
      // "There is an update" with nothing to update to.
      { state: UpdateCheckState.AVAILABLE },
      // A refusal with no reason is a refusal a person cannot be told about.
      { state: UpdateCheckState.UNAVAILABLE, reasonCode: "" },
      { state: UpdateCheckState.UNSUPPORTED, reasonCode: "" },
      // A state this build has never heard of is never rendered as anything.
      { state: 42 as UpdateCheckState, reasonCode: "SOMETHING_NEW" },
    ];
    for (const overrides of incoherent) {
      const { api } = client(() => answer(overrides));
      await expect(api.check(input)).rejects.toMatchObject({
        failure: "response",
      });
    }
  });

  it("never turns an unusable answer into an up-to-date one", async () => {
    const { api } = client(() =>
      answer({
        state: UpdateCheckState.UNAVAILABLE,
        reasonCode: "SOURCE_UNREACHABLE",
        retryAfterMs: 900_000n,
      }),
    );
    const response = await api.check(input);
    expect(response.state).toBe(UpdateCheckState.UNAVAILABLE);
    expect(response.state).not.toBe(UpdateCheckState.UP_TO_DATE);
    expect(response.release).toBeUndefined();
  });
});

describe("version parsing", () => {
  it("keeps ordering out of string comparison", () => {
    expect(parseVersion("1.10.0")).toEqual(
      expect.objectContaining({ major: 1, minor: 10, patch: 0 }),
    );
    expect(parseVersion("v0.2.0-beta.1")).toEqual(
      expect.objectContaining({ patch: 0, prerelease: "beta.1" }),
    );
    for (const bad of ["", "0.2", "01.2.0", "0.2.0-", "hello", "0.2.0.1"]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  it("renders a version for display and nothing for an absent one", () => {
    expect(formatVersion(parseVersion("0.2.0-beta.1")!)).toBe("0.2.0-beta.1");
    expect(formatVersion(undefined)).toBe("");
  });
});
