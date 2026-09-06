import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  GetWorkspaceRootResponseSchema,
  ListWorkspaceRootsResponseSchema,
  RegisterWorkspaceRootRequestSchema,
  RegisterWorkspaceRootResponseSchema,
  UnregisterWorkspaceRootResponseSchema,
  UpdateWorkspaceRootRequestSchema,
  UpdateWorkspaceRootResponseSchema,
  WorkspaceRootSchema,
} from "@armadra/protocol";
import { HostFilesystemClient } from "../src/filesystem.js";
import { HostCanvasError } from "../src/canvas.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";

const hostId = "1".repeat(32);
const workspaceId = "workspace-1";
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
  return {
    api: new HostFilesystemClient({ session, hostId, workspaceId }),
    calls,
  };
}

function root(overrides: Record<string, unknown> = {}) {
  return create(WorkspaceRootSchema, {
    workspaceId,
    canonicalPath: "/项目/一",
    permissions: { read: true, write: true, execute: false },
    registeredAtUnixMs: 1_788_557_000_000n,
    updatedAtUnixMs: 1_788_557_900_000n,
    revision: 1n,
    ...overrides,
  });
}

describe("HostFilesystemClient", () => {
  it("reads a root and keeps its revision exact past 2^53", async () => {
    const { api, calls } = client(() =>
      toBinary(
        GetWorkspaceRootResponseSchema,
        create(GetWorkspaceRootResponseSchema, {
          root: root({ revision: beyondDouble }),
        }),
      ),
    );
    const record = await api.getRoot();
    expect(record.canonicalPath).toBe("/项目/一");
    expect(record.revision).toBe(beyondDouble);
    expect(record.permissions).toEqual({
      read: true,
      write: true,
      execute: false,
    });
    expect(calls[0]!.service).toBe("FilesystemService");
    expect(calls[0]!.action).toBe("GetRoot");
    // A read is not a mutation, so it carries no CSRF requirement.
    expect(calls[0]!.mutation).toBe(false);
  });

  // "Nobody has decided yet" and "nothing is allowed" are different answers,
  // and a UI that drew the first as the second would hide a workspace the
  // device may actually open.
  it("refuses a record with no permission set rather than defaulting it", async () => {
    const { api } = client(() =>
      toBinary(
        GetWorkspaceRootResponseSchema,
        create(GetWorkspaceRootResponseSchema, {
          root: create(WorkspaceRootSchema, {
            workspaceId,
            canonicalPath: "/项目/一",
            revision: 1n,
          }),
        }),
      ),
    );
    await expect(api.getRoot()).rejects.toBeInstanceOf(HostCanvasError);
  });

  // A tombstone is not a root. Reading one as a record would show a workspace
  // pointing at an empty path.
  it("refuses a withdrawn registration", async () => {
    const { api } = client(() =>
      toBinary(
        GetWorkspaceRootResponseSchema,
        create(GetWorkspaceRootResponseSchema, {
          root: create(WorkspaceRootSchema, {
            workspaceId,
            revision: 2n,
            deleted: true,
          }),
        }),
      ),
    );
    await expect(api.getRoot()).rejects.toBeInstanceOf(HostCanvasError);
  });

  it("registers a root under the revision the caller read", async () => {
    const { api, calls } = client(() =>
      toBinary(
        RegisterWorkspaceRootResponseSchema,
        create(RegisterWorkspaceRootResponseSchema, { root: root() }),
      ),
    );
    const record = await api.registerRoot({
      operationId: "filesystem/workspace-1/register",
      canonicalPath: "/项目/一",
      permissions: { read: true, write: true, execute: false },
      expectedRevision: 0n,
    });
    expect(record.revision).toBe(1n);
    expect(calls[0]!.action).toBe("RegisterRoot");
    expect(calls[0]!.mutation).toBe(true);
    const sent = fromBinary(RegisterWorkspaceRootRequestSchema, calls[0]!.body);
    expect(sent.expectedRevision).toBe(0n);
    expect(sent.root?.workspaceId).toBe(workspaceId);
    // The scope comes from the client, never from the caller's input: a
    // request that could name another workspace would be a request that could
    // repoint somebody else's project.
    expect(sent.meta?.scope?.workspaceId).toBe(workspaceId);
  });

  // A root on another machine is proven by that machine. Sending one without
  // the proof would ask this Host to record a path it has never checked.
  it("refuses a remote registration with no proof", async () => {
    const { api, calls } = client(() => new Uint8Array());
    await expect(
      api.registerRoot({
        operationId: "filesystem/workspace-1/register",
        canonicalPath: "/srv/项目",
        executionHostId: "构建机",
        permissions: { read: true, write: false, execute: false },
        expectedRevision: 0n,
      }),
    ).rejects.toBeInstanceOf(HostCanvasError);
    expect(calls).toHaveLength(0);
  });

  it("changes permissions and never sends a path", async () => {
    const { api, calls } = client(() =>
      toBinary(
        UpdateWorkspaceRootResponseSchema,
        create(UpdateWorkspaceRootResponseSchema, {
          root: root({
            revision: 2n,
            permissions: { read: true, write: true, execute: true },
          }),
        }),
      ),
    );
    const record = await api.updateRoot({
      operationId: "filesystem/workspace-1/grant",
      permissions: { read: true, write: true, execute: true },
      expectedRevision: 1n,
    });
    expect(record.permissions.execute).toBe(true);
    const sent = fromBinary(UpdateWorkspaceRootRequestSchema, calls[0]!.body);
    expect(sent.expectedRevision).toBe(1n);
    expect(sent.workspaceId).toBe(workspaceId);
    expect(Object.keys(sent)).not.toContain("canonicalPath");
  });

  // The CAS token is what stops two clients from pointing one workspace at two
  // directories, so a call that names no revision never reaches the Host.
  it("refuses a change with no revision to compare", async () => {
    const { api, calls } = client(() => new Uint8Array());
    for (const call of [
      () =>
        api.updateRoot({
          operationId: "filesystem/workspace-1/grant",
          permissions: { read: true, write: true, execute: true },
          expectedRevision: 0n,
        }),
      () =>
        api.unregisterRoot({
          operationId: "filesystem/workspace-1/unregister",
          expectedRevision: 0n,
        }),
      () =>
        api.registerRoot({
          operationId: "",
          canonicalPath: "/项目/一",
          permissions: { read: true, write: true, execute: false },
          expectedRevision: 0n,
        }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(HostCanvasError);
    }
    expect(calls).toHaveLength(0);
  });

  it("withdraws a registration and checks the answer names this workspace", async () => {
    const { api } = client(() =>
      toBinary(
        UnregisterWorkspaceRootResponseSchema,
        create(UnregisterWorkspaceRootResponseSchema, { workspaceId }),
      ),
    );
    await expect(
      api.unregisterRoot({
        operationId: "filesystem/workspace-1/unregister",
        expectedRevision: 1n,
      }),
    ).resolves.toBe(workspaceId);

    const wrong = client(() =>
      toBinary(
        UnregisterWorkspaceRootResponseSchema,
        create(UnregisterWorkspaceRootResponseSchema, {
          workspaceId: "another",
        }),
      ),
    );
    await expect(
      wrong.api.unregisterRoot({
        operationId: "filesystem/workspace-1/unregister",
        expectedRevision: 1n,
      }),
    ).rejects.toBeInstanceOf(HostCanvasError);
  });

  it("lists the roots this session may see", async () => {
    const { api } = client(() =>
      toBinary(
        ListWorkspaceRootsResponseSchema,
        create(ListWorkspaceRootsResponseSchema, {
          roots: [
            root(),
            root({
              workspaceId: "workspace-2",
              executionHostId: "构建机",
              canonicalPath: "/srv/项目",
              permissions: { read: true, write: false, execute: false },
              revision: 3n,
            }),
          ],
        }),
      ),
    );
    const roots = await api.listRoots();
    expect(roots.map((entry) => entry.workspaceId)).toEqual([
      workspaceId,
      "workspace-2",
    ]);
    expect(roots[1]!.executionHostId).toBe("构建机");
    expect(roots[1]!.permissions.write).toBe(false);
  });

  it("refuses to be constructed without a host and a workspace", () => {
    const session: HostAuthenticatedTransport = {
      send: () => Promise.resolve(new Uint8Array()),
    };
    expect(
      () => new HostFilesystemClient({ session, hostId, workspaceId: "" }),
    ).toThrow(HostCanvasError);
    expect(
      () =>
        new HostFilesystemClient({
          session,
          hostId: "not-a-host",
          workspaceId,
        }),
    ).toThrow(HostCanvasError);
  });
});
