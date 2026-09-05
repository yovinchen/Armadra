import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  CanvasOwnershipOwner,
  CanvasOwnershipPhase,
  GetOwnershipResponseSchema,
  ListOwnershipResponseSchema,
  OwnershipSwitchResponseSchema,
  RollbackOwnershipRequestSchema,
  SwitchOwnershipRequestSchema,
  WriteOwnershipDomain,
  WriteOwnershipSchema,
} from "@armadra/protocol";
import {
  HostOwnershipClient,
  OWNERSHIP_DOMAINS,
  isSettled,
} from "../src/ownership.js";
import { HostCanvasError } from "../src/canvas.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";

const hostId = "1".repeat(32);
/** 2^53 + 1: the first integer a JavaScript number cannot represent. */
const beyondDouble = 9_007_199_254_740_993n;

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
  return { api: new HostOwnershipClient({ session, hostId }), calls };
}

/** Only the fields these tests vary; everything else is the settled default. */
interface RecordOverrides {
  owner?: CanvasOwnershipOwner;
  epoch?: bigint;
  phase?: CanvasOwnershipPhase;
  reasonCode?: string;
  revision?: bigint;
}

function record(domain: WriteOwnershipDomain, overrides: RecordOverrides = {}) {
  return create(WriteOwnershipSchema, {
    domain,
    owner: CanvasOwnershipOwner.RUNTIME,
    epoch: 1n,
    phase: CanvasOwnershipPhase.SETTLED,
    reasonCode: "ownership.initial",
    revision: 1n,
    ...overrides,
  });
}

function everyDomain(): Uint8Array {
  return toBinary(
    ListOwnershipResponseSchema,
    create(ListOwnershipResponseSchema, {
      ownership: [
        record(WriteOwnershipDomain.CANVAS, {
          owner: CanvasOwnershipOwner.HOST,
          epoch: beyondDouble,
          reasonCode: "ownership.switch.verified",
        }),
        record(WriteOwnershipDomain.SETTINGS),
        record(WriteOwnershipDomain.FILESYSTEM),
        record(WriteOwnershipDomain.SESSION),
        record(WriteOwnershipDomain.AGENT),
        record(WriteOwnershipDomain.GIT),
      ],
    }),
  );
}

describe("HostOwnershipClient", () => {
  it("lists every domain in switch order and keeps epochs exact", async () => {
    const { api, calls } = client(() => everyDomain());
    const records = await api.list();
    expect(records.map((entry) => entry.domain)).toEqual([
      ...OWNERSHIP_DOMAINS,
    ]);
    expect(records.at(0)?.owner).toBe("host");
    // A Number would round this to an epoch one lower and compare equal.
    expect(records.at(0)?.epoch).toBe(beyondDouble);
    expect(records.every(isSettled)).toBe(true);
    expect(calls[0]).toMatchObject({
      service: "OwnershipService",
      action: "List",
      mutation: false,
    });
  });

  it("refuses a list that is missing a domain", async () => {
    const { api } = client(() =>
      toBinary(
        ListOwnershipResponseSchema,
        create(ListOwnershipResponseSchema, {
          ownership: [record(WriteOwnershipDomain.CANVAS)],
        }),
      ),
    );
    // Five missing domains would render as "nothing writes those", which is
    // never true; the caller has to see a failure instead.
    await expect(api.list()).rejects.toBeInstanceOf(HostCanvasError);
  });

  it("refuses a record that names no owner, phase or domain", async () => {
    for (const broken of [
      record(WriteOwnershipDomain.UNSPECIFIED),
      record(WriteOwnershipDomain.CANVAS, { epoch: 0n }),
      record(WriteOwnershipDomain.CANVAS, {
        owner: CanvasOwnershipOwner.UNSPECIFIED,
      }),
      record(WriteOwnershipDomain.CANVAS, {
        phase: CanvasOwnershipPhase.UNSPECIFIED,
      }),
    ]) {
      const { api } = client(() =>
        toBinary(
          GetOwnershipResponseSchema,
          create(GetOwnershipResponseSchema, { ownership: broken }),
        ),
      );
      await expect(api.get("canvas")).rejects.toBeInstanceOf(HostCanvasError);
    }
  });

  it("reports a transitional phase as itself, not as the named owner", async () => {
    const { api } = client(() =>
      toBinary(
        GetOwnershipResponseSchema,
        create(GetOwnershipResponseSchema, {
          ownership: record(WriteOwnershipDomain.SESSION, {
            owner: CanvasOwnershipOwner.HOST,
            phase: CanvasOwnershipPhase.SWITCHING,
            reasonCode: "ownership.switch.pending",
          }),
        }),
      ),
    );
    const entry = await api.get("session");
    expect(entry.owner).toBe("host");
    expect(entry.phase).toBe("switching");
    // Neither side is writing during a window, so "settled" is the question a
    // caller asks before it saves — not "who is named".
    expect(isSettled(entry)).toBe(false);
  });

  it("sends a switch as a mutation carrying the maintenance token", async () => {
    const { api, calls } = client(() =>
      toBinary(
        OwnershipSwitchResponseSchema,
        create(OwnershipSwitchResponseSchema, {
          ownership: record(WriteOwnershipDomain.CANVAS, {
            owner: CanvasOwnershipOwner.HOST,
            epoch: 2n,
          }),
        }),
      ),
    );
    await api.switchDomain({
      domain: "canvas",
      target: "host",
      expectedEpoch: 1n,
      importId: "import-1",
      maintenanceToken: "token-from-the-machine",
    });
    expect(calls[0]).toMatchObject({ action: "Switch", mutation: true });
    const sent = fromBinary(
      SwitchOwnershipRequestSchema,
      calls.at(0)?.body ?? new Uint8Array(),
    );
    expect(sent.plan?.maintenanceToken).toBe("token-from-the-machine");
    expect(sent.plan?.domain).toBe(WriteOwnershipDomain.CANVAS);
    expect(sent.plan?.targetOwner).toBe(CanvasOwnershipOwner.HOST);
    expect(sent.plan?.expectedEpoch).toBe(1n);
  });

  it("sends a rollback with the export-only acknowledgement", async () => {
    const { api, calls } = client(() =>
      toBinary(
        OwnershipSwitchResponseSchema,
        create(OwnershipSwitchResponseSchema, {
          ownership: record(WriteOwnershipDomain.CANVAS, { epoch: 3n }),
        }),
      ),
    );
    await api.switchDomain({
      domain: "canvas",
      target: "runtime",
      expectedEpoch: 2n,
      maintenanceToken: "token-from-the-machine",
      acceptExportOnly: true,
    });
    const call = calls.at(0);
    expect(call?.action).toBe("Rollback");
    const sent = fromBinary(
      RollbackOwnershipRequestSchema,
      call?.body ?? new Uint8Array(),
    );
    expect(sent.acceptExportOnly).toBe(true);
    expect(sent.plan?.targetOwner).toBe(CanvasOwnershipOwner.RUNTIME);
  });

  it("never sends a switch without a maintenance token", async () => {
    const { api, calls } = client(() => new Uint8Array());
    for (const input of [
      { maintenanceToken: "" },
      { maintenanceToken: "x".repeat(257) },
      { expectedEpoch: 0n },
    ]) {
      await expect(
        api.switchDomain({
          domain: "canvas",
          target: "host",
          expectedEpoch: 1n,
          maintenanceToken: "token",
          ...input,
        }),
      ).rejects.toBeInstanceOf(HostCanvasError);
    }
    // Nothing left the client: a switch that cannot work is never attempted.
    expect(calls).toHaveLength(0);
  });

  it("refuses an unusable session or host id", () => {
    const session: HostAuthenticatedTransport = {
      send: () => Promise.resolve(new Uint8Array()),
    };
    expect(() => new HostOwnershipClient({ session, hostId: "short" })).toThrow(
      HostCanvasError,
    );
    expect(
      () =>
        new HostOwnershipClient({
          session: undefined as unknown as HostAuthenticatedTransport,
          hostId,
        }),
    ).toThrow(HostCanvasError);
  });
});
