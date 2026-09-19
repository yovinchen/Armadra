import { parseCustomAgents } from "../settings/custom-agents";
import { settingsDomain } from "../settings";
import {
  createControlDispatcher,
  setControlDispatcher,
} from "../collab/control";
import { runContextLink } from "../collab/context-link";
import type { Caller } from "../collab/nodes";
import { Args } from "../collab/refusals";
import {
  type CollabContext,
  type TerminalBridge,
  collabContext,
} from "../collab/service";
import { eventStream } from "../events";
import type { CoreContext } from "../main";
import { refresh as refreshConversations } from "../conversations";
import {
  authorizeMailboxAck,
  noteAcknowledged,
  readForCaller,
} from "../handoff/store";
import { ContextUsageCache } from "../usage/context-usage";
import { ORPHAN_MINUTES, pendingDir, sweepOrphans } from "./approvals";
import { installRoutes } from "./routes";
import { installHookBridge } from "./hook-bridge";

/**
 * The agent domain's assembly point — agent status, approvals, collaboration,
 * handoff, the conversations index and context usage.
 *
 * Three things are published from here rather than registered as routes,
 * because the Hook surface (its own domain, its own credentials, its own body
 * limit) is what receives them from an agent CLI and this is what decides what
 * they may do:
 *
 *   * {@link import("../collab/control").ControlDispatcher} — the thirteen
 *     canvas verbs;
 *   * {@link contextLinkReader} — `context list | summary | transcript |
 *     terminal`;
 *   * {@link contextUsageCache} — where a provider's live window report lands.
 *
 * The terminal bridge is the other direction: this domain needs a PTY for
 * `interrupt`, `close`, the terminal read and the title suggestion, and it
 * gets one from R2 through {@link setTerminalBridge} rather than by importing
 * the manager. A build with no terminal domain still answers every route; the
 * verbs that need a pane refuse with a sentence instead of throwing.
 */

let assembled: CollabContext | undefined;
const usage = new ContextUsageCache();

/** The collaboration context of the running core, for the Hook domain. */
export function collab(): CollabContext | undefined {
  return assembled;
}

/** Where a provider's live context-window report lands. */
export function contextUsageCache(): ContextUsageCache {
  return usage;
}

/**
 * Runs one context-link verb. The Hook surface authenticates, then calls this.
 *
 * Prose in, prose out: the client prints the body verbatim, so a refusal is
 * one readable sentence and nothing else.
 */
export async function contextLinkReader(
  caller: Caller,
  verb: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const context = assembled;
  if (context === undefined) throw new Error("agent domain is not assembled");
  return runContextLink(context, caller, verb, new Args(args));
}

/**
 * Hands the terminal domain's PTY operations to the collaboration verbs.
 *
 * Called by R2 after it builds its manager. Kept mutable rather than required
 * at install time because the two domains are installed in sequence and this
 * one is installed first — the routes have to exist before a terminal does.
 */
let terminals: TerminalBridge | undefined;

export function setTerminalBridge(bridge: TerminalBridge | undefined): void {
  terminals = bridge;
  if (assembled !== undefined) {
    assembled = { ...assembled, terminals: bridge };
    setControlDispatcher(createControlDispatcher(assembled));
  }
}

export function install(context: CoreContext): CollabContext {
  const collabState = collabContext({
    database: context.db.database,
    // Read through the settings store on every call rather than snapshotted:
    // a custom Agent whose `contextLink` the user just switched off must stop
    // being readable now, not at the next restart.
    settings: {
      customAgents: () =>
        parseCustomAgents(settingsDomain()?.settings.snapshot() ?? {}),
    },
    publish: (workspaceId, event) => {
      context.bus.emit("workspace.event", { workspaceId, event });
    },
    // `close` is the only verb that needs an audience count, and it needs the
    // real one: a dialog nobody can see is a two-minute wait for nothing.
    audience: (workspaceId) => eventStream()?.subscriberCount(workspaceId) ?? 0,
    terminals,
    dataDir: context.dataDir,
  });
  const withHandoff: CollabContext = {
    ...collabState,
    handoff: {
      authorizeMailboxAck: (caller, handoffId, sessionId, generation) =>
        authorizeMailboxAck(
          withHandoff,
          caller,
          handoffId,
          sessionId,
          generation,
        ),
      noteAcknowledged: (mailboxId) => noteAcknowledged(withHandoff, mailboxId),
    },
    handoffReader: (caller, handoffId, sessionId, generation) =>
      readForCaller(withHandoff, caller, handoffId, sessionId, generation),
  };
  assembled = withHandoff;
  setControlDispatcher(createControlDispatcher(withHandoff));
  installRoutes({ server: context.server, collab: withHandoff, usage });
  // The hook surface authenticates; these two families answer.
  installHookBridge(context.db.database, contextLinkReader);

  // The index is a convenience, so a provider directory that cannot be read is
  // a warning and an empty palette group, not a startup failure. One pass now;
  // the palette refreshes on demand through `POST /api/conversations/refresh`.
  try {
    const report = refreshConversations(context.db.database);
    if (report.indexed > 0 || report.removed > 0) {
      context.log.info("refreshed the conversations index", {
        scanned: report.scanned,
        indexed: report.indexed,
        removed: report.removed,
        total: report.total,
      });
    }
  } catch (error) {
    context.log.warn("could not refresh the conversations index", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // A client that was killed mid-wait leaves a pending request and its answer
  // behind, and they contain the tool call the agent wanted to make.
  const removed = sweepOrphans(
    pendingDir(withHandoff),
    ORPHAN_MINUTES * 60_000,
  );
  if (removed > 0) {
    context.log.info("cleared orphaned permission requests", { removed });
  }
  return withHandoff;
}

export { ContextUsageCache } from "../usage/context-usage";
export type { CollabContext } from "../collab/service";
