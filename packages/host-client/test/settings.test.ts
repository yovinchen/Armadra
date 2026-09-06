import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  ExecutionHostKind,
  GetSettingsRequestSchema,
  GetSettingsResponseSchema,
  PutSettingsRequestSchema,
  PutSettingsResponseSchema,
  SettingsDocumentSchema,
  SettingsScope,
} from "@armadra/protocol";
import { HostSettingsClient } from "../src/settings.js";
import { HostCanvasError } from "../src/canvas.js";
import { HostIdentityError } from "../src/identity.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";

const hostId = "1".repeat(32);
const deviceId = "0123456789abcdef0123456789abcdef";
/** 2^53 + 1: the first integer a JavaScript number cannot represent. */
const beyondDouble = 9_007_199_254_740_993n;

const encoder = new TextEncoder();
/** Key order and spacing are part of the bytes, so the fixture keeps both. */
const stored = encoder.encode(
  '{"terminal":{"backend":"tmux"},"主题":"深色","usage":{"enabled":true}}',
);

interface Sent {
  service: string;
  action: string;
  body: Uint8Array;
  mutation: boolean;
}

function client(reply: (call: Sent) => Uint8Array | Promise<Uint8Array>) {
  const calls: Sent[] = [];
  const session: HostAuthenticatedTransport = {
    send: (service, action, body, mutation) => {
      const call = { service, action, body, mutation };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
  return { api: new HostSettingsClient({ session, hostId }), calls };
}

function failing(error: unknown) {
  const session: HostAuthenticatedTransport = {
    send: () => Promise.reject(error),
  };
  return new HostSettingsClient({ session, hostId });
}

interface DocumentOverrides {
  scope?: SettingsScope;
  deviceId?: string;
  document?: Uint8Array;
  revision?: bigint;
}

function document(overrides: DocumentOverrides = {}) {
  return create(SettingsDocumentSchema, {
    scope: SettingsScope.GLOBAL,
    document: stored,
    sha256: new Uint8Array(32).fill(7),
    schemaVersion: 1,
    updatedAtUnixMs: 1788557900000n,
    revision: beyondDouble,
    ...overrides,
  });
}

function getReply(overrides: DocumentOverrides = {}): Uint8Array {
  return toBinary(
    GetSettingsResponseSchema,
    create(GetSettingsResponseSchema, {
      document: document(overrides),
      executionHosts: [
        {
          executionHostId: "box-1",
          name: "build machine",
          kind: ExecutionHostKind.SSH,
          revision: 3n,
        },
      ],
      eventSequence: 41n,
    }),
  );
}

function putReply(revision: bigint, overrides: DocumentOverrides = {}) {
  return toBinary(
    PutSettingsResponseSchema,
    create(PutSettingsResponseSchema, {
      document: document({ revision, ...overrides }),
    }),
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned)));
}

describe("HostSettingsClient", () => {
  it("reads the document as bytes and as a decoded value", async () => {
    const { api, calls } = client(() => getReply());
    const snapshot = await api.get();

    // The bytes are the document: the digest a save is compared against is
    // over exactly these, so they are carried, not re-serialized.
    expect(snapshot.document).toEqual(stored);
    expect(snapshot.value).toEqual({
      terminal: { backend: "tmux" },
      主题: "深色",
      usage: { enabled: true },
    });
    // A Number would round this revision to one lower and compare equal.
    expect(snapshot.revision).toBe(beyondDouble);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.eventSequence).toBe(41n);
    expect(snapshot.executionHosts.at(0)?.executionHostId).toBe("box-1");
    expect(calls[0]).toMatchObject({
      service: "SettingsService",
      action: "Get",
      mutation: false,
    });
    const sent = fromBinary(
      GetSettingsRequestSchema,
      calls.at(0)?.body ?? new Uint8Array(),
    );
    expect(sent.scope).toBe(SettingsScope.GLOBAL);
    expect(sent.deviceId).toBe("");
  });

  it("addresses the device overlay as its own scope", async () => {
    const { api, calls } = client(() =>
      getReply({ scope: SettingsScope.DEVICE, deviceId }),
    );
    const snapshot = await api.get({ scope: "device", deviceId });
    expect(snapshot.scope).toBe("device");
    expect(snapshot.deviceId).toBe(deviceId);
    const sent = fromBinary(
      GetSettingsRequestSchema,
      calls.at(0)?.body ?? new Uint8Array(),
    );
    expect(sent.scope).toBe(SettingsScope.DEVICE);
    expect(sent.deviceId).toBe(deviceId);
  });

  it("never sends a device request with no device", async () => {
    const { api, calls } = client(() => new Uint8Array());
    await expect(api.get({ scope: "device" })).rejects.toBeInstanceOf(
      HostCanvasError,
    );
    // A request the Host is certain to refuse should not look like a network
    // failure, so nothing leaves the client.
    expect(calls).toHaveLength(0);
  });

  it("computes the digest from the payload it is about to send", async () => {
    const { api, calls } = client(() => putReply(beyondDouble + 1n));
    const payload = encoder.encode('{"terminal":{"backend":"none"}}');
    await api.put({
      document: payload,
      expectedRevision: beyondDouble,
      operationId: "settings/global/9007199254740993",
    });
    const sent = fromBinary(
      PutSettingsRequestSchema,
      calls.at(0)?.body ?? new Uint8Array(),
    );
    expect(calls[0]).toMatchObject({ action: "Put", mutation: true });
    expect(sent.document?.document).toEqual(payload);
    expect(sent.expectedRevision).toBe(beyondDouble);
    expect(sent.operationId).toBe("settings/global/9007199254740993");
    // The caller cannot hand in a digest that disagrees with its own bytes:
    // the client hashes what it is sending, not what it was told.
    expect(hex(sent.document?.sha256 ?? new Uint8Array())).toBe(
      await digestOf(payload),
    );
  });

  it("refuses a save whose revision did not move", async () => {
    const { api } = client(() => putReply(beyondDouble));
    const failure = await api
      .put({
        document: stored,
        expectedRevision: beyondDouble,
        operationId: "settings/global/1",
      })
      .catch((error: unknown) => error);
    // Remembering a revision that never moved would make the next
    // compare-and-set pass against a document this save never wrote.
    expect(failure).toBeInstanceOf(HostCanvasError);
    expect((failure as HostCanvasError).failure).toBe("response");
    expect((failure as HostCanvasError).outcomeUnknown).toBe(true);
  });

  it("refuses a response about a scope that was not asked for", async () => {
    const { api } = client(() =>
      getReply({ scope: SettingsScope.DEVICE, deviceId }),
    );
    await expect(api.get()).rejects.toMatchObject({ failure: "response" });
  });

  it("refuses a document that is not one JSON object", async () => {
    for (const broken of [
      new Uint8Array(),
      encoder.encode("[]"),
      encoder.encode("null"),
      encoder.encode('{"terminal":'),
      new Uint8Array([0xff, 0xfe, 0xfd]),
    ]) {
      const { api } = client(() => getReply({ document: broken }));
      // Reading a fragment as `{}` would render as "every key was deleted".
      await expect(api.get()).rejects.toMatchObject({ failure: "response" });
    }
  });

  it("refuses a save that comes back without its document", async () => {
    const { api } = client(() =>
      toBinary(
        PutSettingsResponseSchema,
        create(PutSettingsResponseSchema, {}),
      ),
    );
    await expect(
      api.put({
        document: stored,
        expectedRevision: 0n,
        operationId: "settings/global/0",
      }),
    ).rejects.toMatchObject({ failure: "response", outcomeUnknown: true });
  });

  it("maps a CONFLICT to a stale revision rather than a retry", async () => {
    const api = failing(
      new HostIdentityError("REMOTE_ERROR", false, 409, "CONFLICT"),
    );
    await expect(
      api.put({
        document: stored,
        expectedRevision: 2n,
        operationId: "settings/global/2",
      }),
    ).rejects.toMatchObject({ failure: "conflict" });
  });

  it("maps an expired session to unauthenticated", async () => {
    const api = failing(
      new HostIdentityError("REMOTE_ERROR", false, 401, "UNAUTHENTICATED"),
    );
    await expect(api.get()).rejects.toMatchObject({
      failure: "unauthenticated",
    });
  });

  it("maps undecodable bytes to a response failure", async () => {
    const { api } = client(() => new Uint8Array([0xff, 0xff, 0xff]));
    await expect(api.get()).rejects.toMatchObject({ failure: "response" });
  });

  it("never sends a payload that is empty or over the ceiling", async () => {
    const { api, calls } = client(() => new Uint8Array());
    for (const document of [
      new Uint8Array(),
      new Uint8Array(1024 * 1024 + 1).fill(0x20),
    ]) {
      await expect(
        api.put({
          document,
          expectedRevision: 0n,
          operationId: "settings/global/0",
        }),
      ).rejects.toBeInstanceOf(HostCanvasError);
    }
    await expect(
      api.put({
        document: stored,
        expectedRevision: 0n,
        operationId: "settings global 0",
      }),
    ).rejects.toBeInstanceOf(HostCanvasError);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unusable session or host id", () => {
    const session: HostAuthenticatedTransport = {
      send: () => Promise.resolve(new Uint8Array()),
    };
    expect(() => new HostSettingsClient({ session, hostId: "short" })).toThrow(
      HostCanvasError,
    );
    expect(
      () =>
        new HostSettingsClient({
          session: undefined as unknown as HostAuthenticatedTransport,
          hostId,
        }),
    ).toThrow(HostCanvasError);
  });
});
