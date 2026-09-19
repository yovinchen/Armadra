/**
 * What makes a remote Worker usable, and what only makes it different.
 *
 * Ported from `apps/runtime/src/remote/client/handshake.rs`.
 *
 * Compatibility is three separate questions, and each one fails for its own
 * reason:
 *
 *  1. **Protocol.** The major must match. This is the envelope; every 1.x
 *     Worker carries the messages a controller needs, so there is nothing to
 *     compare in the minor yet.
 *  2. **Service contract.** {@link CONTRACT_VERSION} must match exactly,
 *     because nothing negotiates the JSON payload shapes. A Worker reporting
 *     zero predates the field and falls back to the old exact-version rule, so
 *     an old Worker is never *less* strictly checked than before.
 *  3. **Capabilities.** Checked per operation, at call time, not here. A
 *     Worker that lacks one group answers that group with 501 naming the
 *     capability and serves everything else — losing the repository panel
 *     should not close the files.
 *
 * A differing `runtimeVersion` that passes all three is a badge on the node,
 * not a refusal.
 */

/**
 * The version of the JSON payload shapes this build speaks.
 *
 * It starts at 1 for the TypeScript core rather than continuing the Rust
 * Runtime's numbering, because the payloads are not the same payloads: the
 * Rust contract's shapes are one build's serde derives over Protobuf
 * envelopes. Two cores of different implementations must refuse each other,
 * and the cleanest way to say so is a protocol major they do not share.
 */
export const CONTRACT_VERSION = 1;

/**
 * The envelope major. Deliberately **2**, not 1: a TypeScript controller and a
 * Rust Worker must not appear compatible to one another, and the protocol
 * major is the one field both implementations read before anything else.
 */
export const PROTOCOL_MAJOR = 2;

/** Capability the remote Worker must advertise before anything is proxied. */
export const REMOTE_CAPABILITY = "remote.execution.v1";

/** What a Worker says about itself when its stdin first carries a frame. */
export interface WorkerHello {
  readonly protocol?: { readonly major: number; readonly minor: number };
  readonly instanceId: string;
  readonly runtimeVersion: string;
  readonly serviceContractVersion: number;
  readonly capabilities: readonly string[];
  readonly platform: string;
  readonly architecture: string;
}

/** What a usable handshake told us. */
export interface Accepted {
  readonly instanceId: string;
  readonly capabilities: ReadonlySet<string>;
  /**
   * The Worker's own release, when it differs from this build's. `undefined`
   * means the two match and there is nothing to show.
   */
  readonly versionBadge?: string;
}

/** Refused, with the reason a person can act on. */
export class HandshakeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeRefused";
  }
}

/** Decide whether `hello` may be talked to, and what to say about it. */
export function accept(
  hostName: string,
  expectedVersion: string,
  hello: WorkerHello,
): Accepted {
  if (hello.protocol?.major !== PROTOCOL_MAJOR) {
    throw new HandshakeRefused(
      `执行主机 ${hostName} 说的 Worker 协议这个控制端读不了`,
    );
  }
  if (hello.serviceContractVersion === 0) {
    // Predates the contract version. The only thing that ever guaranteed
    // payload compatibility for such a Worker is an identical build, so that
    // is still what is required of it.
    if (hello.runtimeVersion !== expectedVersion) {
      const found =
        hello.runtimeVersion === "" ? "一个更旧的构建" : hello.runtimeVersion;
      throw new HandshakeRefused(
        `执行主机 ${hostName} 跑的是 Armadra ${found}，早于远端服务契约；` +
          `这个控制端是 ${expectedVersion}，请装一份匹配的远端 Worker`,
      );
    }
  } else if (hello.serviceContractVersion !== CONTRACT_VERSION) {
    throw new HandshakeRefused(
      `执行主机 ${hostName} 说的远端服务契约是 ${hello.serviceContractVersion}，` +
        `这个控制端说 ${CONTRACT_VERSION}；升级更旧的那一端`,
    );
  }
  const capabilities = new Set(hello.capabilities);
  if (!capabilities.has(REMOTE_CAPABILITY)) {
    throw new HandshakeRefused(`执行主机 ${hostName} 不提供远端执行`);
  }
  const badge =
    hello.runtimeVersion !== expectedVersion && hello.runtimeVersion !== ""
      ? hello.runtimeVersion
      : undefined;
  return {
    instanceId: hello.instanceId,
    capabilities,
    ...(badge === undefined ? {} : { versionBadge: badge }),
  };
}

/**
 * The 501 a missing capability produces. It names the capability so that an
 * operator reading it knows what to upgrade, rather than being told only that
 * something is unsupported.
 */
export function missingCapability(
  hostName: string,
  capability: string,
): string {
  return `执行主机 ${hostName} 不提供 ${capability}；升级它的 Armadra Worker`;
}

/** Whether a value read off the wire is a hello at all. */
export function parseHello(value: unknown): WorkerHello | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.instanceId !== "string" ||
    typeof raw.runtimeVersion !== "string" ||
    typeof raw.serviceContractVersion !== "number"
  ) {
    return undefined;
  }
  const protocol = raw.protocol as WorkerHello["protocol"];
  return {
    ...(protocol === undefined ? {} : { protocol }),
    instanceId: raw.instanceId,
    runtimeVersion: raw.runtimeVersion,
    serviceContractVersion: raw.serviceContractVersion,
    capabilities: Array.isArray(raw.capabilities)
      ? raw.capabilities.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    platform: typeof raw.platform === "string" ? raw.platform : "",
    architecture: typeof raw.architecture === "string" ? raw.architecture : "",
  };
}
