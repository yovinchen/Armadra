import type { HostStatus } from "@armadra/protocol";
import type { HostLaunchConfig } from "../../shell-core/host/config";
import { hostErrorOf } from "../../shell-core/host/errors";
import {
  type NativeTicket,
  NativeTicketError,
  TICKET_OUTPUT_LIMIT,
  decodeTicket,
  pairArguments,
  reasonFor,
  ticketPrecondition,
} from "../../shell-core/host/ticket";
import { runCli } from "./launch";

/**
 * Minting one native session ticket for the page — the one thing the page may
 * ask the shell for (docs/design/host-native-session.md §4.4).
 *
 * The rules are in `shell-core/host/ticket.ts`; this file is only the CLI call
 * that feeds them, the same division the rest of `host/` uses. Ported from
 * `src-tauri/src/host/native.rs:152-170`.
 */

/** The device label the Host records for this machine's shell. */
export function deviceName(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "本机桌面" : "This desktop";
}

/**
 * Mints one ticket. `status` is what `ensureHost` reported; a Host without a
 * loopback listener has nowhere the ticket could be spent, and an origin no
 * shell can present has no native session to offer.
 */
export async function issueNativeTicket(
  config: HostLaunchConfig,
  status: HostStatus | null,
  name: string,
): Promise<NativeTicket> {
  const blocked = ticketPrecondition(config, status, name);
  if (blocked) throw new NativeTicketError(blocked);
  let wire: Uint8Array;
  try {
    wire = await runCli(
      config,
      pairArguments(config, name),
      TICKET_OUTPUT_LIMIT,
    );
  } catch (thrown) {
    // Whatever the CLI wrote is dropped here: stderr is the one stream that
    // could carry a credential the Host printed while refusing.
    throw new NativeTicketError(reasonFor(hostErrorOf(thrown)));
  }
  return decodeTicket(
    wire,
    status as HostStatus,
    config.browserOrigin,
    Date.now(),
  );
}
