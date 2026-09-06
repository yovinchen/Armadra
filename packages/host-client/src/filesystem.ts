import {
  create,
  fromBinary,
  toBinary,
  GetWorkspaceRootRequestSchema,
  GetWorkspaceRootResponseSchema,
  ListWorkspaceRootsRequestSchema,
  ListWorkspaceRootsResponseSchema,
  RegisterWorkspaceRootRequestSchema,
  RegisterWorkspaceRootResponseSchema,
  UnregisterWorkspaceRootRequestSchema,
  UnregisterWorkspaceRootResponseSchema,
  UpdateWorkspaceRootRequestSchema,
  UpdateWorkspaceRootResponseSchema,
  type WorkspaceRoot,
} from "@armadra/protocol";
import type { HostAuthenticatedTransport } from "./automation.js";
import { classifyCanvasFailure, HostCanvasError } from "./canvas.js";

const SERVICE = "FilesystemService";

/**
 * Where a workspace's files are, and who may touch them
 * (Go Host 业务所有权迁移 §2.5).
 *
 * This client carries no bytes. Reading and writing files, watching, searching
 * and every Git command keep going to the execution host through the Runtime
 * proxy whichever side owns this record — what moves is the decision, not the
 * machine. So the surface here is small on purpose: register a root, change
 * what is allowed, withdraw it, read it back.
 *
 * Everything that changes something takes the revision the caller read.
 * Pointing one workspace at two directories is exactly what that refusal
 * prevents, and it is why `expectedRevision` is required rather than optional.
 */

/** Read, write and execute for one workspace. */
export interface WorkspaceAccess {
  read: boolean;
  write: boolean;
  execute: boolean;
}

/**
 * One registered root, in the shape a caller renders.
 *
 * `permissions` is never absent here: a record that arrived without one says
 * "nobody has decided yet", which a UI must not draw as "nothing is allowed",
 * so it is refused at the boundary instead of being defaulted.
 */
export interface WorkspaceRootRecord {
  workspaceId: string;
  /** Empty means this machine; anything else is a `settings.ssh.hosts[].id`. */
  executionHostId: string;
  /** Frozen at registration. A workspace whose files moved is a new one. */
  canonicalPath: string;
  permissions: WorkspaceAccess;
  registeredAtUnixMs: bigint;
  updatedAtUnixMs: bigint;
  /** u64. Compared as BigInt; a Number would stop being exact above 2^53. */
  revision: bigint;
}

function decodeRoot(root: WorkspaceRoot | undefined): WorkspaceRootRecord {
  if (
    !root ||
    root.workspaceId === "" ||
    root.deleted ||
    root.canonicalPath === "" ||
    !root.permissions ||
    root.revision <= 0n
  )
    throw new HostCanvasError("response");
  return {
    workspaceId: root.workspaceId,
    executionHostId: root.executionHostId,
    canonicalPath: root.canonicalPath,
    permissions: {
      read: root.permissions.read,
      write: root.permissions.write,
      execute: root.permissions.execute,
    },
    registeredAtUnixMs: root.registeredAtUnixMs,
    updatedAtUnixMs: root.updatedAtUnixMs,
    revision: root.revision,
  };
}

export interface HostFilesystemClientOptions {
  session: HostAuthenticatedTransport;
  hostId: string;
  /** The workspace this client speaks for. The surface is workspace-scoped. */
  workspaceId: string;
}

export interface RegisterRootInput {
  operationId: string;
  canonicalPath: string;
  permissions: WorkspaceAccess;
  executionHostId?: string;
  /** The remote Worker's registration proof; required for a remote root. */
  proofSha256?: Uint8Array;
  /** The revision the caller read. 0 means "never registered". */
  expectedRevision: bigint;
}

export interface UpdateRootInput {
  operationId: string;
  permissions: WorkspaceAccess;
  expectedRevision: bigint;
}

const idPattern = /^[0-9a-f]{32}$/;

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `filesystem-${Date.now().toString(36)}-${counter}`;
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validAccess(value: unknown): value is WorkspaceAccess {
  if (!value || typeof value !== "object") return false;
  const access = value as Record<string, unknown>;
  return (
    typeof access.read === "boolean" &&
    typeof access.write === "boolean" &&
    typeof access.execute === "boolean"
  );
}

export class HostFilesystemClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;
  readonly #workspaceId: string;

  constructor(options: HostFilesystemClientOptions) {
    if (
      !options ||
      typeof options.session?.send !== "function" ||
      !idPattern.test(options.hostId ?? "") ||
      typeof options.workspaceId !== "string" ||
      options.workspaceId.length === 0
    )
      throw new HostCanvasError("invalid");
    this.#session = options.session;
    this.#hostId = options.hostId;
    this.#workspaceId = options.workspaceId;
  }

  get workspaceId(): string {
    return this.#workspaceId;
  }

  #meta() {
    return {
      requestId: requestId(),
      scope: {
        hostId: this.#hostId,
        workspaceId: this.#workspaceId,
        executionHostId: this.#hostId,
      },
    };
  }

  async #call<T>(
    action: string,
    body: Uint8Array,
    mutation: boolean,
    decode: (wire: Uint8Array) => T,
  ): Promise<T> {
    let wire: Uint8Array;
    try {
      wire = await this.#session.send(SERVICE, action, body, mutation);
    } catch (error) {
      throw classifyCanvasFailure(error);
    }
    try {
      return decode(wire);
    } catch (error) {
      if (error instanceof HostCanvasError) throw error;
      throw new HostCanvasError("response", mutation);
    }
  }

  /** This workspace's registration. */
  async getRoot(): Promise<WorkspaceRootRecord> {
    const request = create(GetWorkspaceRootRequestSchema, {
      meta: this.#meta(),
      workspaceId: this.#workspaceId,
    });
    return this.#call(
      "GetRoot",
      toBinary(GetWorkspaceRootRequestSchema, request),
      false,
      (wire) =>
        decodeRoot(fromBinary(GetWorkspaceRootResponseSchema, wire).root),
    );
  }

  /**
   * Every root this session may see. It is a list because a device granted
   * several workspaces has several, and an empty one means this session's
   * workspaces have no registration — not that they have no files.
   */
  async listRoots(): Promise<WorkspaceRootRecord[]> {
    const request = create(ListWorkspaceRootsRequestSchema, {
      meta: this.#meta(),
    });
    return this.#call(
      "ListRoots",
      toBinary(ListWorkspaceRootsRequestSchema, request),
      false,
      (wire) =>
        fromBinary(ListWorkspaceRootsResponseSchema, wire).roots.map(
          decodeRoot,
        ),
    );
  }

  /** Freezes where this workspace's files are. */
  async registerRoot(input: RegisterRootInput): Promise<WorkspaceRootRecord> {
    if (
      !input ||
      !validOperationId(input.operationId) ||
      typeof input.canonicalPath !== "string" ||
      input.canonicalPath.length === 0 ||
      !validAccess(input.permissions) ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n
    )
      throw new HostCanvasError("invalid");
    // A root on another machine is proven by that machine. Registering one
    // without the proof would record a path this Host has never checked.
    if (
      typeof input.executionHostId === "string" &&
      input.executionHostId.length > 0 &&
      input.proofSha256?.length !== 32
    )
      throw new HostCanvasError("invalid");
    const request = create(RegisterWorkspaceRootRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      root: {
        workspaceId: this.#workspaceId,
        executionHostId: input.executionHostId ?? "",
        canonicalPath: input.canonicalPath,
        proofSha256: input.proofSha256 ?? new Uint8Array(),
        permissions: input.permissions,
      },
    });
    return this.#call(
      "RegisterRoot",
      toBinary(RegisterWorkspaceRootRequestSchema, request),
      true,
      (wire) =>
        decodeRoot(fromBinary(RegisterWorkspaceRootResponseSchema, wire).root),
    );
  }

  /**
   * Changes what is allowed. There is no path here on purpose: everything the
   * workspace holds is addressed relative to the path that was frozen, so
   * repointing a root is a new registration rather than an edit.
   */
  async updateRoot(input: UpdateRootInput): Promise<WorkspaceRootRecord> {
    if (
      !input ||
      !validOperationId(input.operationId) ||
      !validAccess(input.permissions) ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    )
      throw new HostCanvasError("invalid");
    const request = create(UpdateWorkspaceRootRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      workspaceId: this.#workspaceId,
      permissions: input.permissions,
    });
    return this.#call(
      "UpdateRoot",
      toBinary(UpdateWorkspaceRootRequestSchema, request),
      true,
      (wire) =>
        decodeRoot(fromBinary(UpdateWorkspaceRootResponseSchema, wire).root),
    );
  }

  /**
   * Withdraws the registration. Nothing under the directory is read, moved or
   * deleted — this removes the entry that says the workspace has a root.
   */
  async unregisterRoot(input: {
    operationId: string;
    expectedRevision: bigint;
  }): Promise<string> {
    if (
      !input ||
      !validOperationId(input.operationId) ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision <= 0n
    )
      throw new HostCanvasError("invalid");
    const request = create(UnregisterWorkspaceRootRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      workspaceId: this.#workspaceId,
    });
    return this.#call(
      "UnregisterRoot",
      toBinary(UnregisterWorkspaceRootRequestSchema, request),
      true,
      (wire) => {
        const value = fromBinary(UnregisterWorkspaceRootResponseSchema, wire);
        if (value.workspaceId !== this.#workspaceId)
          throw new HostCanvasError("response", true);
        return value.workspaceId;
      },
    );
  }
}
