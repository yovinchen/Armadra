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
  EventDomain,
  EventEnvelopeSchema,
  FilesystemWorkerResponseSchema,
  RegisterWorkspaceRootRequestSchema,
  ReverseExportRecordSchema,
  UnregisterWorkspaceRootResponseSchema,
  UpdateWorkspaceRootRequestSchema,
  WorkerRequestSchema,
  WorkspaceRootSchema,
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

const beyondDouble = 9_007_199_254_740_993n;
const maxUint64 = 18_446_744_073_709_551_615n;

// The filesystem domain's registration record (Go Host 业务所有权迁移 §2.5).
//
// The browser is the side that decides whether to offer a save button at all,
// so it reads the same fixtures the Go and Rust sides do. Revisions are BigInt
// for the same reason epochs are: a revision past 2^53 that arrived as a
// JavaScript number would compare equal to the one before it, and the CAS that
// protects somebody's project directory would stop protecting it.
describe("workspace roots", () => {
  it("keeps a remote root's host, frozen path and proof", () => {
    check("filesystem_remote_root", WorkspaceRootSchema, {
      workspaceId: "0123456789abcdef0123456789abcdef",
      executionHostId: "构建机",
      canonicalPath: "/srv/项目/armadra",
      proofSha256: new Uint8Array(32).fill(5),
      permissions: { read: true, write: true, execute: false },
      registeredAtUnixMs: 1_788_557_000_000n,
      updatedAtUnixMs: 1_788_557_900_000n,
      revision: beyondDouble,
    });
  });

  it("carries a permission change under its own CAS token", () => {
    check("filesystem_update_root", UpdateWorkspaceRootRequestSchema, {
      meta: {
        requestId: "filesystem-1",
        scope: { workspaceId: "0123456789abcdef0123456789abcdef" },
      },
      operationId: "filesystem/0123456789abcdef0123456789abcdef/permissions-1",
      expectedRevision: maxUint64,
      workspaceId: "0123456789abcdef0123456789abcdef",
      permissions: { read: true, write: true, execute: true },
    });
  });

  it("keeps the revision on a tombstone", () => {
    check("filesystem_root_tombstone", WorkspaceRootSchema, {
      workspaceId: "0123456789abcdef0123456789abcdef",
      updatedAtUnixMs: 1_788_557_900_000n,
      revision: 4n,
      deleted: true,
    });
  });

  it("reads the Worker's own listing of its roots", () => {
    check("filesystem_worker_roots", FilesystemWorkerResponseSchema, {
      result: {
        case: "roots",
        value: {
          roots: [
            {
              workspaceId: "0123456789abcdef0123456789abcdef",
              canonicalPath: "/home/用户/项目",
              permissions: { read: true, write: true, execute: false },
            },
            {
              workspaceId: "abcdef0123456789abcdef0123456789",
              executionHostId: "构建机",
              canonicalPath: "/srv/项目/armadra",
              permissions: { read: true, write: false, execute: false },
            },
          ],
        },
      },
    });
  });

  // "Not allowed" and "not decided" are different answers, and a UI that read
  // them alike would either hide a workspace it may open or offer one it may
  // not.
  it("distinguishes an absent permission set from a denied one", () => {
    const denied = create(WorkspaceRootSchema, {
      workspaceId: "w",
      permissions: { read: false, write: false, execute: false },
    });
    const absent = create(WorkspaceRootSchema, { workspaceId: "w" });
    expect(toBinary(WorkspaceRootSchema, denied)).not.toEqual(
      toBinary(WorkspaceRootSchema, absent),
    );
    expect(
      fromBinary(WorkspaceRootSchema, toBinary(WorkspaceRootSchema, absent))
        .permissions,
    ).toBeUndefined();
    expect(
      fromBinary(WorkspaceRootSchema, toBinary(WorkspaceRootSchema, denied))
        .permissions,
    ).toBeDefined();
  });

  it("keeps the CAS token separate from the record's own revision", () => {
    const request = create(RegisterWorkspaceRootRequestSchema, {
      meta: { requestId: "register-1" },
      operationId: "filesystem/w/register-1",
      expectedRevision: 0n,
      root: {
        workspaceId: "0123456789abcdef0123456789abcdef",
        canonicalPath: "/home/用户/项目",
        permissions: { read: true, write: true, execute: false },
        revision: 7n,
      },
    });
    const decoded = fromBinary(
      RegisterWorkspaceRootRequestSchema,
      toBinary(RegisterWorkspaceRootRequestSchema, request),
    );
    expect(decoded.expectedRevision).toBe(0n);
    expect(decoded.root?.revision).toBe(7n);
    // Unregistering answers with the identifier and the receipt, never with a
    // root: a caller that got an empty record back would read it as a
    // registration that was cleared rather than one that is gone.
    const removed = create(UnregisterWorkspaceRootResponseSchema, {
      workspaceId: "0123456789abcdef0123456789abcdef",
      receipt: {
        operationId: "filesystem/w/unregister-1",
        transactionId: 4n,
        firstSequence: 9n,
        lastSequence: 9n,
      },
    });
    expect(Object.keys(removed)).not.toContain("root");
    expect(removed.receipt?.lastSequence).toBe(9n);
  });

  it("travels on worker action 26 and event envelope member 140", () => {
    const request = create(WorkerRequestSchema, {
      requestId: "h-filesystem-1",
      hostId: "0123456789abcdef0123456789abcdef",
      action: {
        case: "filesystem",
        value: { action: { case: "listRoots", value: {} } },
      },
    });
    expect(
      WorkerRequestSchema.fields.find((field) => field.name === "filesystem")
        ?.number,
    ).toBe(26);
    expect(
      fromBinary(WorkerRequestSchema, toBinary(WorkerRequestSchema, request)),
    ).toEqual(request);

    const envelope = create(EventEnvelopeSchema, {
      sequence: 12n,
      domain: EventDomain.FILESYSTEM,
      kind: "root",
      entityId: "0123456789abcdef0123456789abcdef",
      workspaceId: "0123456789abcdef0123456789abcdef",
      revision: 3n,
      entity: {
        case: "filesystemRoot",
        value: {
          workspaceId: "0123456789abcdef0123456789abcdef",
          canonicalPath: "/home/用户/项目",
          revision: 3n,
        },
      },
    });
    expect(
      EventEnvelopeSchema.fields.find(
        (field) => field.name === "filesystem_root",
      )?.number,
    ).toBe(140);
    expect(
      fromBinary(EventEnvelopeSchema, toBinary(EventEnvelopeSchema, envelope)),
    ).toEqual(envelope);

    const record = create(ReverseExportRecordSchema, {
      entity: {
        case: "workspaceRoot",
        value: { workspaceId: "w", canonicalPath: "/项目" },
      },
    });
    expect(
      fromBinary(
        ReverseExportRecordSchema,
        toBinary(ReverseExportRecordSchema, record),
      ),
    ).toEqual(record);
  });
});
