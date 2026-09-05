import {
  create,
  fromBinary,
  toBinary,
  CanvasOwnershipOwner,
  CanvasOwnershipPhase,
  GetOwnershipRequestSchema,
  GetOwnershipResponseSchema,
  ListOwnershipRequestSchema,
  ListOwnershipResponseSchema,
  OwnershipSwitchResponseSchema,
  RollbackOwnershipRequestSchema,
  SwitchOwnershipRequestSchema,
  WriteOwnershipDomain,
  type OwnershipSwitchResponse,
  type WriteOwnership,
} from "@armadra/protocol";
import type { HostAuthenticatedTransport } from "./automation.js";
import { classifyCanvasFailure, HostCanvasError } from "./canvas.js";

export type {
  WriteOwnership,
  OwnershipSwitchResponse,
} from "@armadra/protocol";
export { WriteOwnershipDomain } from "@armadra/protocol";

const SERVICE = "OwnershipService";

/**
 * Which process may write each business domain (Go Host 业务所有权迁移 §2.11).
 *
 * A client reads this before it decides where to save. There is no dual-write
 * mode and no "probably still the Runtime": a domain the Host cannot report is
 * a domain nothing may be written to, which is why every failure here is an
 * error and never an empty list.
 *
 * Moving a domain is possible only with a maintenance token issued at the
 * machine over the local control channel. A browser cannot obtain one, so
 * `switchDomain` exists for the surfaces that can (the desktop shell, an
 * operator pasting a token) and refuses without one rather than pretending.
 */
export type OwnershipDomainName =
  | "canvas"
  | "settings"
  | "filesystem"
  | "session"
  | "agent"
  | "git";

/** Switch order, which is also the dependency order (§1.2). */
export const OWNERSHIP_DOMAINS: readonly OwnershipDomainName[] = [
  "canvas",
  "settings",
  "filesystem",
  "session",
  "agent",
  "git",
];

const DOMAIN_BY_NAME: Record<OwnershipDomainName, WriteOwnershipDomain> = {
  canvas: WriteOwnershipDomain.CANVAS,
  settings: WriteOwnershipDomain.SETTINGS,
  filesystem: WriteOwnershipDomain.FILESYSTEM,
  session: WriteOwnershipDomain.SESSION,
  agent: WriteOwnershipDomain.AGENT,
  git: WriteOwnershipDomain.GIT,
};

const NAME_BY_DOMAIN = new Map<WriteOwnershipDomain, OwnershipDomainName>(
  OWNERSHIP_DOMAINS.map((name) => [DOMAIN_BY_NAME[name], name]),
);

/**
 * One domain's record, in the shape a caller renders.
 *
 * `owner` and `phase` are separate on purpose. A domain in a transitional phase
 * has an owner named in the record, but neither side is writing it: the phase
 * is what says "read only right now", and collapsing the two would show a
 * maintenance window as a working canvas.
 */
export interface OwnershipRecord {
  domain: OwnershipDomainName;
  owner: "runtime" | "host";
  /** u64. Compared as BigInt; a Number would stop being exact above 2^53. */
  epoch: bigint;
  phase: "settled" | "switching" | "rollingBack";
  importId: string;
  /** Stable localizable key, e.g. `ownership.switch.verified`. Never a path. */
  reasonCode: string;
  eventSequence: bigint;
  updatedAtUnixMs: bigint;
  revision: bigint;
}

/** True only while the named owner is actually the one writing. */
export function isSettled(record: OwnershipRecord): boolean {
  return record.phase === "settled";
}

function decodeRecord(record: WriteOwnership | undefined): OwnershipRecord {
  const domain = record ? NAME_BY_DOMAIN.get(record.domain) : undefined;
  // An unnamed domain, an unnamed owner or a zero epoch names no writer at all.
  // Acting on any of them would pick a side by accident.
  if (!record || !domain || record.epoch <= 0n)
    throw new HostCanvasError("response");
  let owner: OwnershipRecord["owner"];
  switch (record.owner) {
    case CanvasOwnershipOwner.RUNTIME:
      owner = "runtime";
      break;
    case CanvasOwnershipOwner.HOST:
      owner = "host";
      break;
    default:
      throw new HostCanvasError("response");
  }
  let phase: OwnershipRecord["phase"];
  switch (record.phase) {
    case CanvasOwnershipPhase.SETTLED:
      phase = "settled";
      break;
    case CanvasOwnershipPhase.SWITCHING:
      phase = "switching";
      break;
    case CanvasOwnershipPhase.ROLLING_BACK:
      phase = "rollingBack";
      break;
    default:
      throw new HostCanvasError("response");
  }
  return {
    domain,
    owner,
    epoch: record.epoch,
    phase,
    importId: record.importId,
    reasonCode: record.reasonCode,
    eventSequence: record.eventSequence,
    updatedAtUnixMs: record.updatedAtUnixMs,
    revision: record.revision,
  };
}

export interface HostOwnershipClientOptions {
  session: HostAuthenticatedTransport;
  /** This Host's id. The record is host-wide, so no workspace is named. */
  hostId: string;
}

export interface SwitchOwnershipInput {
  domain: OwnershipDomainName;
  /** The side the domain is moving to. */
  target: "runtime" | "host";
  /** The epoch the caller read. A mismatch is a CONFLICT, never a retry. */
  expectedEpoch: bigint;
  /** Required. Issued at the machine, spent once, valid two minutes. */
  maintenanceToken: string;
  /** The verified import a move to the Host rests on. */
  importId?: string;
  /**
   * Only for a rollback: accepts that changes made while the Host owned the
   * domain will exist solely in the reverse export package.
   */
  acceptExportOnly?: boolean;
}

const idPattern = /^[0-9a-f]{32}$/;

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `ownership-${Date.now().toString(36)}-${counter}`;
}

export class HostOwnershipClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;

  constructor(options: HostOwnershipClientOptions) {
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

  /** One domain's record. */
  async get(domain: OwnershipDomainName): Promise<OwnershipRecord> {
    const value = DOMAIN_BY_NAME[domain];
    if (value === undefined) throw new HostCanvasError("invalid");
    const request = create(GetOwnershipRequestSchema, {
      meta: this.#meta(),
      domain: value,
    });
    return this.#call(
      "Get",
      toBinary(GetOwnershipRequestSchema, request),
      false,
      (wire) =>
        decodeRecord(fromBinary(GetOwnershipResponseSchema, wire).ownership),
    );
  }

  /**
   * Every domain, in switch order. A short answer is a failure rather than a
   * partial list: a missing domain would read as "nothing writes that", which
   * is never true.
   */
  async list(): Promise<OwnershipRecord[]> {
    const request = create(ListOwnershipRequestSchema, { meta: this.#meta() });
    return this.#call(
      "List",
      toBinary(ListOwnershipRequestSchema, request),
      false,
      (wire) => {
        const value = fromBinary(ListOwnershipResponseSchema, wire);
        const records = value.ownership.map(decodeRecord);
        const seen = new Set(records.map((record) => record.domain));
        if (seen.size !== records.length) throw new HostCanvasError("response");
        for (const domain of OWNERSHIP_DOMAINS) {
          if (!seen.has(domain)) throw new HostCanvasError("response");
        }
        return OWNERSHIP_DOMAINS.map(
          (domain) => records.find((record) => record.domain === domain)!,
        );
      },
    );
  }

  /**
   * Moves one domain. The maintenance token is not optional: without one the
   * Host refuses, and asking without one would be a button that cannot work.
   */
  async switchDomain(
    input: SwitchOwnershipInput,
  ): Promise<OwnershipSwitchResponse> {
    const domain = DOMAIN_BY_NAME[input?.domain];
    if (
      domain === undefined ||
      typeof input.maintenanceToken !== "string" ||
      input.maintenanceToken.length === 0 ||
      input.maintenanceToken.length > 256 ||
      typeof input.expectedEpoch !== "bigint" ||
      input.expectedEpoch <= 0n
    )
      throw new HostCanvasError("invalid");
    const rollback = input.target === "runtime";
    const plan = {
      domain,
      targetOwner: rollback
        ? CanvasOwnershipOwner.RUNTIME
        : CanvasOwnershipOwner.HOST,
      expectedEpoch: input.expectedEpoch,
      importId: input.importId ?? "",
      maintenanceToken: input.maintenanceToken,
    };
    const body = rollback
      ? toBinary(
          RollbackOwnershipRequestSchema,
          create(RollbackOwnershipRequestSchema, {
            meta: this.#meta(),
            plan,
            acceptExportOnly: input.acceptExportOnly === true,
          }),
        )
      : toBinary(
          SwitchOwnershipRequestSchema,
          create(SwitchOwnershipRequestSchema, { meta: this.#meta(), plan }),
        );
    return this.#call(rollback ? "Rollback" : "Switch", body, true, (wire) => {
      const value = fromBinary(OwnershipSwitchResponseSchema, wire);
      // The answer has to name the state that now holds; a switch that
      // reported nothing would leave the caller guessing which side writes.
      decodeRecord(value.ownership);
      return value;
    });
  }
}
