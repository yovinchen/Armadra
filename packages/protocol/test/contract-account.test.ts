import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  AcquireWriterLeaseRequestSchema,
  BindNodeAccountRequestSchema,
  CredentialBindingSchema,
  CredentialScope,
  MutationKind,
  MutationSchema,
  NodeAccountBindingSchema,
  PresenceState,
  SubscribePresenceResponseSchema,
} from "../src/index.js";

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

const maxUint64 = 18_446_744_073_709_551_615n;

describe("reserved account and presence contracts", () => {
  it("carries an account reference and a credential name, never a secret", () => {
    check("account_bind_request", BindNodeAccountRequestSchema, {
      meta: {
        requestId: "绑定-1",
        scope: { hostId: "host-1", workspaceId: "workspace-1" },
        expectedRevision: 0n,
      },
      nodeId: "node-1",
      account: {
        accountId: "default",
        providerId: "claude",
        label: "工作账号📇",
      },
      credential: {
        credentialRef: "keychain://armadra/claude/default",
        scope: CredentialScope.EXECUTION_HOST,
        authorizationId: "grant-1",
      },
    });
    // The schema has no field a secret could travel in.
    expect(Object.keys(CredentialBindingSchema.field).sort()).toEqual([
      "authorizationId",
      "credentialRef",
      "scope",
    ]);
  });

  it("keeps an unknown credential scope instead of decoding it to zero", () => {
    check("account_binding", NodeAccountBindingSchema, {
      nodeId: "node-1",
      account: { accountId: "default" },
      credential: {
        credentialRef: "keychain://armadra/claude/default",
        scope: 999 as CredentialScope,
      },
      revision: maxUint64,
      boundAtUnixMs: 9007199254740993n,
    });
  });

  it("separates an absent last-seen time from a zero one", () => {
    check("presence_snapshot", SubscribePresenceResponseSchema, {
      participants: [
        {
          participantId: "principal-1",
          deviceId: "device-1",
          displayName: "手机📱",
          canvasId: "canvas-1",
          focusNodeId: "node-1",
          state: PresenceState.ACTIVE,
          observedAtUnixMs: 1788557900000n,
        },
        {
          participantId: "principal-2",
          state: PresenceState.DISCONNECTED,
          lastSeenUnixMs: 0n,
        },
      ],
      lease: {
        leaseId: "lease-1",
        canvasId: "canvas-1",
        holderParticipantId: "principal-1",
        revision: 9007199254740993n,
        expiresAtUnixMs: 1788557900000n,
      },
      revision: maxUint64,
    });
    const decoded = fromBinary(
      SubscribePresenceResponseSchema,
      fixture("presence_snapshot"),
    );
    expect(decoded.participants[0]?.lastSeenUnixMs).toBeUndefined();
    expect(decoded.participants[1]?.lastSeenUnixMs).toBe(0n);
  });

  it("keeps a mutation payload opaque and its CAS expectation explicit", () => {
    check("presence_mutation", MutationSchema, {
      mutationId: "mutation-1",
      canvasId: "canvas-1",
      actorId: "principal-1",
      leaseId: "lease-1",
      expectedRevision: 0n,
      revision: 9007199254740993n,
      kind: MutationKind.WHITEBOARD_BLOB,
      payloadType: "armadra-flow/snapshot",
      payload: new Uint8Array([0, 255, 27, 10]),
      observedAtUnixMs: -9223372036854775808n,
    });
    check("presence_acquire", AcquireWriterLeaseRequestSchema, {
      meta: { requestId: "租约-1" },
      canvasId: "canvas-1",
      requestedTtlMs: 300000,
    });
    expect(
      fromBinary(AcquireWriterLeaseRequestSchema, fixture("presence_acquire"))
        .expectedRevision,
    ).toBeUndefined();
  });
});
