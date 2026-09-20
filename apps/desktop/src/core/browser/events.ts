import type { BrowserContext } from "./context";
import { localHuman } from "./verbs";
import { parseDialogKind } from "./model";
import { rfc3339 } from "./lease";

/**
 * What the shell tells this process about, and what each fact changes.
 *
 * Ported from `on_event` in the pre-merge implementation. Only two
 * of them change state. A navigation writes `active_tab_url`, which is the one
 * column a restart needs. Human input takes the lease, which is what preempts
 * an agent — and it arrives here because the guest's own `before-input-event`
 * fires in the shell's main process, not because anything re-routes a person's
 * keystrokes through this one.
 */

export function onShellEvent(
  context: BrowserContext,
  event: Record<string, unknown>,
): void {
  const name = typeof event.event === "string" ? event.event : "";
  const nodeId = event.nodeId;
  if (typeof nodeId !== "string") return;
  const session = context.sessions.get(nodeId);
  // A node nobody has driven yet has no session here, and creating one from an
  // event would mean a row per guest the user merely opened.
  if (session === undefined) return;
  switch (name) {
    case "navigated": {
      const url = event.url;
      if (typeof url === "string") session.rememberUrl(url);
      return;
    }
    case "humanInput":
    case "humanFocus": {
      if (session.humanActivity("local") !== undefined) {
        // The lease left the agent. Every debugger attached to this node goes
        // with it: a lease that ends without a detach is the failure the whole
        // ownership design is written against.
        detach(context, nodeId, "the user took this browser back");
      }
      return;
    }
    case "control": {
      const action = typeof event.action === "string" ? event.action : "";
      if (action === "takeover") {
        session.takeover("local", "");
        detach(context, nodeId, "the user stopped agent control of this node");
        return;
      }
      if (action === "release") {
        release(context, nodeId);
      }
      return;
    }
    case "guestLost":
      // A guest that went away takes the lease with it, and the badge has to
      // stop claiming somebody is driving a page that is gone.
      release(context, nodeId);
      return;
    // Both prompts ride the events the canvas already draws. Nothing here
    // reads a page's text for meaning; it is carried, bounded, and shown to a
    // person.
    case "dialog":
      context.publish(session.workspaceId, {
        type: "browser.dialog",
        sessionId: session.sessionId,
        dialog: {
          dialogId: stringOf(event, "id"),
          tabId: stringOf(event, "tabId"),
          kind: parseDialogKind(stringOf(event, "kind")),
          message: stringOf(event, "message"),
          defaultPrompt: stringOf(event, "defaultPrompt"),
          url: session.activeTabUrl(),
          openedAt: rfc3339(new Date()),
        },
      });
      return;
    case "dialogClosed":
      context.publish(session.workspaceId, {
        type: "browser.dialog",
        sessionId: session.sessionId,
      });
      return;
    case "fileChooser":
      context.publish(session.workspaceId, {
        type: "browser.fileChooser",
        sessionId: session.sessionId,
        chooser: {
          chooserId: stringOf(event, "id"),
          tabId: stringOf(event, "tabId"),
          frameId: "",
          multiple: stringOf(event, "mode") === "selectMultiple",
          accept: "",
          openedAt: rfc3339(new Date()),
        },
      });
      return;
    default:
  }
}

/**
 * Hands the page back to nobody.
 *
 * A release that is not ours to make is not an error here: the shell reports
 * what happened to a guest, and "the lease was already somebody else's" is an
 * ordinary answer to that, not a failure to report to anyone.
 */
function release(context: BrowserContext, nodeId: string): void {
  const session = context.sessions.get(nodeId);
  if (session === undefined) return;
  try {
    session.release(localHuman());
  } catch {
    // Not the holder. Nothing to do and nobody to tell.
  }
}

function detach(context: BrowserContext, nodeId: string, reason: string): void {
  context.notify?.(nodeId, "revoke", { reason });
}

function stringOf(event: Record<string, unknown>, field: string): string {
  const value = event[field];
  return typeof value === "string" ? value : "";
}
