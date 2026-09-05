import {
  create,
  fromBinary,
  toBinary,
  CheckForUpdateRequestSchema,
  CheckForUpdateResponseSchema,
  ReleaseChannel,
  SemanticVersionSchema,
  UpdateCheckState,
  UpdateSignatureState,
  type CheckForUpdateResponse,
  type SemanticVersion,
} from "@armadra/protocol";
import { HostIdentityError } from "./identity.js";
import {
  classifyAutomationFailure,
  HostAutomationError,
  type HostAuthenticatedTransport,
} from "./automation.js";

export type {
  CheckForUpdateResponse,
  ReleaseInfo,
  SemanticVersion,
  UpdateArtifact,
} from "@armadra/protocol";
export {
  ReleaseChannel,
  UpdateCheckState,
  UpdateSignatureState,
} from "@armadra/protocol";

const SERVICE = "UpdateService";
const idPattern = /^[0-9a-f]{32}$/;
/** "<os>-<arch>", the same shape the Host validates (§3 S03). */
const targetPattern = /^(darwin|linux|windows)-[a-z0-9_]+$/;

/**
 * The same failure vocabulary the automation client uses, so a panel that
 * already knows how to explain "signed out" or "this Host cannot" does not
 * learn a second one.
 */
export { HostAutomationError as HostUpdatesError };
export type { HostAutomationFailure as HostUpdatesFailure } from "./automation.js";

export interface HostUpdatesClientOptions {
  session: HostAuthenticatedTransport;
  /** This Host's id. It is the only Host a check may be addressed to. */
  hostId: string;
}

export interface CheckForUpdateInput {
  channel: ReleaseChannel;
  installedVersion: SemanticVersion;
  /** The caller's own build target, so the Host answers about one artifact. */
  target: string;
}

let counter = 0;
function requestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  counter = (counter + 1) % 1_000_000;
  return random ?? `updates-${Date.now().toString(36)}-${counter}`;
}

function reject(): never {
  throw new HostAutomationError("invalid");
}

/**
 * Parses "1.2.3" / "v1.2.3-beta.1" into the structured version the contract
 * carries. Ordering is never left to string comparison, so nothing downstream
 * can mistake 1.10.0 for older than 1.9.0.
 */
export function parseVersion(value: string): SemanticVersion | null {
  const match =
    /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/.exec(
      (value ?? "").trim(),
    );
  if (!match) return null;
  const [major, minor, patch] = [match[1]!, match[2]!, match[3]!];
  if ([major, minor, patch].some((part) => part.length > 1 && part[0] === "0"))
    return null;
  return create(SemanticVersionSchema, {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: match[4] ?? "",
  });
}

/** Renders a structured version for display only; never for comparison. */
export function formatVersion(version?: SemanticVersion): string {
  if (!version) return "";
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

/**
 * Typed access to the Host's authenticated update surface.
 *
 * The client validates the answer before a panel renders it: a response whose
 * state is AVAILABLE but that carries no release is treated as a malformed
 * response, not as an update — showing an offer nothing described would be
 * claiming the Host said something it did not.
 */
export class HostUpdatesClient {
  readonly #session: HostAuthenticatedTransport;
  readonly #hostId: string;

  constructor(options: HostUpdatesClientOptions) {
    if (
      !options ||
      typeof options.session?.send !== "function" ||
      !idPattern.test(options.hostId ?? "")
    )
      reject();
    this.#session = options.session;
    this.#hostId = options.hostId;
  }

  get hostId(): string {
    return this.#hostId;
  }

  /** Reads whether a newer release exists. It downloads and installs nothing. */
  async check(input: CheckForUpdateInput): Promise<CheckForUpdateResponse> {
    if (
      !input ||
      !input.installedVersion ||
      typeof input.target !== "string" ||
      !targetPattern.test(input.target) ||
      !Object.values(ReleaseChannel).includes(input.channel)
    )
      reject();
    const request = create(CheckForUpdateRequestSchema, {
      meta: { requestId: requestId(), scope: { hostId: this.#hostId } },
      channel: input.channel,
      installedVersion: input.installedVersion,
      target: input.target,
    });
    let wire: Uint8Array;
    try {
      wire = await this.#session.send(
        SERVICE,
        "CheckForUpdate",
        new Uint8Array(toBinary(CheckForUpdateRequestSchema, request)),
        false,
      );
    } catch (error) {
      throw classifyUpdatesFailure(error);
    }
    let response: CheckForUpdateResponse;
    try {
      response = fromBinary(CheckForUpdateResponseSchema, wire);
    } catch {
      throw new HostAutomationError("response");
    }
    if (!isCoherent(response)) throw new HostAutomationError("response");
    return response;
  }
}

/** Reuses the automation classifier; the repairs are the same set. */
export function classifyUpdatesFailure(error: unknown): HostAutomationError {
  if (error instanceof HostAutomationError) return error;
  if (!(error instanceof HostIdentityError))
    return new HostAutomationError("network");
  return classifyAutomationFailure(error);
}

/**
 * A response only makes sense in a few shapes. Anything else is refused rather
 * than half-rendered: "available" with nothing to offer, or a state this build
 * has never heard of, must not reach a person as an update.
 */
function isCoherent(response: CheckForUpdateResponse): boolean {
  if (!response.installedVersion) return false;
  switch (response.state) {
    case UpdateCheckState.AVAILABLE:
      return (
        Boolean(response.release?.version) &&
        response.release!.artifacts.length > 0
      );
    case UpdateCheckState.UP_TO_DATE:
      return !response.release;
    case UpdateCheckState.UNSUPPORTED:
    case UpdateCheckState.UNAVAILABLE:
      return !response.release && response.reasonCode.length > 0;
    default:
      return false;
  }
}

/**
 * Whether the offered artifact carries a signature the installer could check.
 * The Host never verifies one, so this is a property of the release, not a
 * claim that anything was verified.
 */
export function offeredSignature(
  response: CheckForUpdateResponse,
): UpdateSignatureState {
  const artifact = response.release?.artifacts[0];
  return artifact?.signature?.state ?? UpdateSignatureState.UNSPECIFIED;
}
