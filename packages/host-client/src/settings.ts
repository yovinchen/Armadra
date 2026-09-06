import {
  create,
  fromBinary,
  toBinary,
  GetSettingsRequestSchema,
  GetSettingsResponseSchema,
  PutSettingsRequestSchema,
  PutSettingsResponseSchema,
  SettingsScope,
  type ExecutionHost,
  type SettingsDocument,
} from "@armadra/protocol";
import type { HostAuthenticatedTransport } from "./automation.js";
import { classifyCanvasFailure, HostCanvasError } from "./canvas.js";

export type {
  ExecutionHost,
  SettingsDocument,
  SshExecutionHost,
} from "@armadra/protocol";
export { ExecutionHostKind, SettingsScope } from "@armadra/protocol";

const SERVICE = "SettingsService";

/** One MiB, the ceiling `settings.proto` puts on `SettingsDocument.document`. */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * The document's own shape version, independent of the protocol's. A caller
 * that has not been told otherwise writes the version it was built against;
 * writing zero would tell a Host "this document has no shape", and a Host that
 * does not recognise a version stores it untouched rather than guessing.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** `global` follows the account; `device` is the per-device overlay. */
export type SettingsScopeName = "global" | "device";

/**
 * Which document is being addressed.
 *
 * A DEVICE scope with no device is refused here rather than sent: the Host
 * would refuse it too, and a request that cannot succeed should not leave the
 * client looking like a network problem.
 */
export interface SettingsScopeRef {
  scope: SettingsScopeName;
  /** Required for `device`, and empty for `global`. */
  deviceId?: string;
}

const GLOBAL: SettingsScopeRef = { scope: "global" };

const SCOPE_BY_NAME: Record<SettingsScopeName, SettingsScope> = {
  global: SettingsScope.GLOBAL,
  device: SettingsScope.DEVICE,
};

const NAME_BY_SCOPE = new Map<SettingsScope, SettingsScopeName>([
  [SettingsScope.GLOBAL, "global"],
  [SettingsScope.DEVICE, "device"],
]);

/**
 * One settings document as it was read.
 *
 * `document` is kept as bytes and `value` is only a decoding of them. The
 * digest a later save is compared against is over exactly these bytes, so
 * re-encoding `value` before saving would produce different bytes — key order,
 * number formatting and escaping all differ between the writer and us — and
 * every consistency check across a switch would then fail for a reason that
 * has nothing to do with the settings. A caller that changes something edits
 * the decoded value, serializes once, and sends those new bytes.
 */
export interface SettingsRecord {
  scope: SettingsScopeName;
  /** Empty for `global`. */
  deviceId: string;
  /** The bytes exactly as they were stored. Never re-serialized here. */
  document: Uint8Array;
  /** `document` parsed as JSON. Always an object; never a fragment. */
  value: Record<string, unknown>;
  /** The Host's digest over `document`, carried through unchanged. */
  sha256: Uint8Array;
  schemaVersion: number;
  updatedAtUnixMs: bigint;
  /** u64. Compared as BigInt; a Number would stop being exact above 2^53. */
  revision: bigint;
}

/**
 * A read: the document plus the two things only a read can report.
 *
 * `executionHosts` is a projection of `settings.ssh.hosts[]` taken in the same
 * read, so it always belongs to the revision beside it. `eventSequence` is
 * where a subscription to the settings domain continues from; starting at zero
 * would replay the document's whole history as fresh changes.
 */
export interface SettingsSnapshot extends SettingsRecord {
  executionHosts: ExecutionHost[];
  eventSequence: bigint;
}

export interface HostSettingsClientOptions {
  session: HostAuthenticatedTransport;
  /** This Host's id. Settings are host-wide, so no workspace is named. */
  hostId: string;
}

export interface PutSettingsInput {
  /**
   * The whole document to store, already serialized. A partial document would
   * read as "these keys were deleted", so the caller merges before it calls.
   */
  document: Uint8Array;
  /**
   * The revision the caller read. Zero means "this document has never been
   * written", so a first write cannot silently replace one that already exists.
   */
  expectedRevision: bigint;
  /** Replay key. The same id with the same document replays the first result. */
  operationId: string;
  scope?: SettingsScopeRef;
  schemaVersion?: number;
}

const idPattern = /^[0-9a-f]{32}$/;
/**
 * Operation ids are path-shaped (`settings/<scope>/<n>`) so a replay is
 * recognisable by a human reading a log, hence the extra `/`.
 */
const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `settings-${Date.now().toString(36)}-${counter}`;
}

/**
 * A fatal decoder: bytes that are not valid UTF-8 are a failure rather than a
 * string full of replacement characters, which would parse into a document
 * that never existed.
 */
const decoder = new TextDecoder("utf-8", { fatal: true });

function scopeRef(ref: SettingsScopeRef | undefined): {
  scope: SettingsScopeName;
  deviceId: string;
} {
  const value = ref ?? GLOBAL;
  const deviceId = value.deviceId ?? "";
  if (value.scope === "device") {
    if (!idPattern.test(deviceId)) throw new HostCanvasError("invalid");
    return { scope: "device", deviceId };
  }
  // A global document that names a device is two addresses at once; refusing
  // is better than picking one of them.
  if (value.scope !== "global" || deviceId !== "")
    throw new HostCanvasError("invalid");
  return { scope: "global", deviceId: "" };
}

/**
 * SHA-256 over the bytes that are actually being sent.
 *
 * The client computes it rather than accepting one from the caller: a digest
 * that disagrees with its own payload would be rejected by the Host as a
 * corrupt write, and the caller would have no way to tell which of the two it
 * got wrong.
 */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into an exclusive ArrayBuffer: protobuf `bytes` may be a view onto a
  // shared buffer, which WebCrypto refuses to hash.
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
}

function decodeDocument(
  document: SettingsDocument | undefined,
  expected: { scope: SettingsScopeName; deviceId: string },
  mutation: boolean,
): SettingsRecord {
  const scope = document ? NAME_BY_SCOPE.get(document.scope) : undefined;
  // A response that names no scope, or a different one from the request, is
  // about a document the caller never asked for. Storing it under the asked-for
  // scope would put a device overlay where the account document belongs.
  if (
    !document ||
    !scope ||
    scope !== expected.scope ||
    document.deviceId !== expected.deviceId
  )
    throw new HostCanvasError("response", mutation);
  let text: string;
  try {
    text = decoder.decode(document.document);
  } catch {
    throw new HostCanvasError("response", mutation);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HostCanvasError("response", mutation);
  }
  // The document is one object. An array, a scalar or `null` is not a settings
  // document, and treating one as `{}` would read as "every key was deleted".
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new HostCanvasError("response", mutation);
  return {
    scope,
    deviceId: document.deviceId,
    document: document.document,
    value: parsed as Record<string, unknown>,
    sha256: document.sha256,
    schemaVersion: document.schemaVersion,
    updatedAtUnixMs: document.updatedAtUnixMs,
    revision: document.revision,
  };
}

/**
 * The settings document, read and written whole (Go Host 业务所有权迁移 §2.4).
 *
 * Host-wide, so nothing here names a workspace. There is no `subscribe`: a
 * settings change travels on the shared event stream under the settings
 * domain, continuing from the `eventSequence` a read reports. A second,
 * settings-only stream would be a second ordering to keep in agreement with
 * the first.
 */
export class HostSettingsClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;

  constructor(options: HostSettingsClientOptions) {
    if (
      !options ||
      typeof options.session?.send !== "function" ||
      !idPattern.test(options.hostId ?? "")
    )
      throw new HostCanvasError("invalid");
    this.#session = options.session;
    this.#hostId = options.hostId;
  }

  get hostId(): string {
    return this.#hostId;
  }

  #meta() {
    return {
      requestId: requestId(),
      scope: { hostId: this.#hostId, executionHostId: this.#hostId },
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

  /** The document, its projected execution hosts, and where to subscribe. */
  async get(scope?: SettingsScopeRef): Promise<SettingsSnapshot> {
    const asked = scopeRef(scope);
    const request = create(GetSettingsRequestSchema, {
      meta: this.#meta(),
      scope: SCOPE_BY_NAME[asked.scope],
      deviceId: asked.deviceId,
    });
    return this.#call(
      "Get",
      toBinary(GetSettingsRequestSchema, request),
      false,
      (wire) => {
        const response = fromBinary(GetSettingsResponseSchema, wire);
        return {
          ...decodeDocument(response.document, asked, false),
          executionHosts: response.executionHosts,
          eventSequence: response.eventSequence,
        };
      },
    );
  }

  /** A whole-document write under compare-and-set. */
  async put(input: PutSettingsInput): Promise<SettingsRecord> {
    const asked = scopeRef(input?.scope);
    const document = input?.document;
    if (
      !(document instanceof Uint8Array) ||
      document.byteLength === 0 ||
      document.byteLength > MAX_SETTINGS_BYTES ||
      typeof input.expectedRevision !== "bigint" ||
      input.expectedRevision < 0n ||
      !operationIdPattern.test(input.operationId ?? "")
    )
      throw new HostCanvasError("invalid");
    const request = create(PutSettingsRequestSchema, {
      meta: this.#meta(),
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      document: {
        scope: SCOPE_BY_NAME[asked.scope],
        deviceId: asked.deviceId,
        document,
        sha256: await sha256(document),
        schemaVersion: input.schemaVersion ?? SETTINGS_SCHEMA_VERSION,
      },
    });
    return this.#call(
      "Put",
      toBinary(PutSettingsRequestSchema, request),
      true,
      (wire) => {
        const response = fromBinary(PutSettingsResponseSchema, wire);
        const saved = decodeDocument(response.document, asked, true);
        // A save that reports the revision it was given never happened, or
        // happened to something else. Remembering it would make the next
        // compare-and-set pass against a document this one never wrote.
        if (saved.revision <= input.expectedRevision)
          throw new HostCanvasError("response", true);
        return saved;
      },
    );
  }
}
