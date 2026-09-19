import {
  BootstrapTicketResponseSchema,
  type HostStatus,
  fromBinary,
} from "@armadra/protocol";
import { type HostLaunchConfig, nativeOrigin } from "./config";
import type { HostLaunchError } from "./errors";

/**
 * The native session ticket, minus the process that fetches it
 * (docs/design/host-native-session.md §4.4, ported from
 * `src-tauri/src/host/native.rs`).
 *
 * The shell and the Host share an OS user, and the Host's private control
 * channel is what `armadra-host pair` speaks. Running that command mints a
 * one-time ticket bound to the Host observed at startup, to the page's own
 * origin and to a fixed device name; the page trades it for a bearer session
 * over the loopback listener.
 *
 * Nothing about the process, its path or its flags crosses into the page:
 * only the ticket, and only a stable reason when there is none.
 */

/** A ticket is a few hundred bytes; anything approaching this is not one. */
export const TICKET_OUTPUT_LIMIT = 65_536;

/**
 * Exactly the shape `armadra-host pair` prints as JSON, which is also the
 * material `HostIdentityClient.pair()` accepts verbatim.
 */
export interface NativeTicket {
  readonly hostId: string;
  readonly hostInstanceId: string;
  readonly origin: string;
  readonly ticket: string;
  /** Milliseconds as a decimal string: the page compares it as a bigint. */
  readonly expiresAtUnixMs: string;
}

/**
 * Why no ticket could be issued. Each value is a stable token the page maps to
 * its own sentence; none carries a path, an exit code or subprocess output.
 * The set is the one `apps/web/src/host/native-session.ts` already knows, so
 * the i18n keys (`hostNative.blocked.*`) are unchanged by the port.
 */
export type NativeTicketReason =
  /** The shell has not observed a running Host with a loopback listener. */
  | "hostUnavailable"
  /** The page is not loaded from an origin a shell can present. */
  | "originUnsupported"
  /** The Host CLI could not be run or refused to mint a ticket. */
  | "cliFailed"
  | "timeout"
  /** The CLI answered with something that is not a ticket for this Host. */
  | "malformed";

export class NativeTicketError extends Error {
  readonly name = "NativeTicketError";
  constructor(readonly reason: NativeTicketReason) {
    super(`Native session ticket unavailable (${reason})`);
  }
}

/** The reason a failed Host CLI call maps to. Mirrors native.rs:72-83. */
export function reasonFor(
  error: HostLaunchError | undefined,
): NativeTicketReason {
  switch (error?.kind) {
    case "cliTimeout":
    case "cliCleanupTimeout":
      return "timeout";
    case "cliOutputLimit":
    case "malformedResult":
      return "malformed";
    case "invalidConfiguration":
    case "binaryUnavailable":
      return "hostUnavailable";
    default:
      return "cliFailed";
  }
}

/**
 * The exact `pair` line. The origin is the page's, never one the page named,
 * and the device name is the shell's fixed label for this machine.
 */
export function pairArguments(
  config: HostLaunchConfig,
  deviceName: string,
): string[] {
  const args = [
    "pair",
    "--output",
    "protobuf",
    "--origin",
    config.browserOrigin,
    "--device-name",
    deviceName,
  ];
  if (config.dataDir !== undefined) args.push("--data-dir", config.dataDir);
  return args;
}

/** `<32 lowercase hex>.<43 base64url>` and nothing else. */
export function ticketShape(value: string): boolean {
  return /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Checks a `pair` answer against the Host the shell actually observed: the
 * same persistent ID, the same process instance, the page's origin and an
 * expiry still ahead. A ticket for any other Host is not a bonus, it is a sign
 * the CLI talked to a different data directory.
 */
export function decodeTicket(
  wire: Uint8Array,
  status: HostStatus,
  origin: string,
  nowUnixMs: number,
): NativeTicket {
  let ticket;
  try {
    ticket = fromBinary(BootstrapTicketResponseSchema, wire);
  } catch {
    throw new NativeTicketError("malformed");
  }
  if (
    ticket.hostId !== status.hostId ||
    ticket.hostInstanceId !== status.hostInstanceId ||
    ticket.origin !== origin ||
    !ticketShape(ticket.ticket) ||
    ticket.expiresAtUnixMs <= BigInt(nowUnixMs)
  ) {
    throw new NativeTicketError("malformed");
  }
  return {
    hostId: ticket.hostId,
    hostInstanceId: ticket.hostInstanceId,
    origin: ticket.origin,
    ticket: ticket.ticket,
    expiresAtUnixMs: ticket.expiresAtUnixMs.toString(),
  };
}

/**
 * Whether this configuration and this observed Host could produce a ticket at
 * all, without running anything. Mirrors `issue_native_ticket`'s three guards
 * (native.rs:157-162), which is where `originUnsupported` comes from: a page
 * on an origin no shell can present has no native session to offer.
 */
export function ticketPrecondition(
  config: HostLaunchConfig,
  status: HostStatus | null,
  deviceName: string,
): NativeTicketReason | undefined {
  if (!nativeOrigin(config.browserOrigin)) return "originUnsupported";
  if (status === null || status.httpEndpoint === "" || deviceName.trim() === "")
    return "hostUnavailable";
  return undefined;
}
