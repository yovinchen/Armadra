import { DRIVE_CODES, refuse } from "../../core/browser/cdp/codes";
import {
  isVerb,
  runVerbOnHost,
  type VerbHost,
  type VerbTab,
} from "../../core/browser/cdp/verbs";
import type { DriveRequest } from "../../shell-core/browser/drive";
import {
  discardedMessage,
  notDrivableMessage,
} from "../../shell-core/browser/registration";
import type { GuestSession } from "./cdp";
import { drivableSession, guestsOfNode } from "./registry";
import {
  acceptStagedDownload,
  clearChooser,
  pendingChooser,
  rejectStagedDownload,
  stagedDownloads,
} from "./transfers";
import { askRenderer } from "./renderer";
import { onDomainEvent } from "./domain-events";

/**
 * The Electron half of the seventeen verbs.
 *
 * The verbs themselves are `core/browser/cdp/verbs.ts` — a CDP call sequence
 * is the same sequence whichever Chromium runs it. What this file supplies is
 * the part of a verb that is NOT a CDP command and that only a desktop shell
 * can answer: which `<webview>` guests are this node's tabs, what the renderer
 * must be asked to do about them, which downloads a page staged, and which
 * dialog it is holding open.
 */

/** Open JavaScript dialogs, one per node. Filled by the drive assembly's
 * `Page.javascriptDialogOpening` subscription. */
export const openDialogs = new Map<
  string,
  { id: string; kind: string; message: string; defaultPrompt: string }
>();

export interface VerbContext {
  readonly nodeId: string;
  readonly tabId: string;
  readonly session: GuestSession;
}

/** The shell's {@link VerbHost}: one node, for the length of one verb. */
function shellHost(context: VerbContext): VerbHost {
  const { nodeId } = context;
  return {
    nodeId,
    tabId: context.tabId,
    session: context.session,
    listTabs: (): VerbTab[] =>
      guestsOfNode(nodeId)
        .filter((guest) => guest.surface === "canvas")
        .map((guest) => ({
          id: guest.tabId,
          active: guest.active,
          url: guest.contents.isDestroyed() ? "" : guest.contents.getURL(),
          title: guest.contents.isDestroyed() ? "" : guest.contents.getTitle(),
        })),
    requestTab: async (action, tabId, url) => {
      await askRenderer({ kind: "tabs", nodeId, action, tabId, url });
    },
    listDownloads: () => stagedDownloads(nodeId),
    acceptDownload: (id, workspaceRoot) =>
      acceptStagedDownload(nodeId, id, workspaceRoot),
    rejectDownload: (id) => rejectStagedDownload(nodeId, id),
    pendingChooser: () => pendingChooser(nodeId),
    clearChooser: () => clearChooser(nodeId),
    openDialog: () => openDialogs.get(nodeId),
    clearDialog: () => {
      openDialogs.delete(nodeId);
    },
  };
}

/**
 * Runs one verb. Every refusal from here is `{ code, message }`, and the two
 * "you cannot drive this" cases produce the SAME sentence on purpose.
 */
export async function runVerb(request: DriveRequest): Promise<unknown> {
  // The verb name is checked before the node is looked up, and that order is
  // deliberate: a name nobody implements is a fact about the request, and
  // answering it with "no such node" would make the reply depend on somebody
  // else's canvas.
  if (!isVerb(request.verb))
    refuse(DRIVE_CODES.unknownVerb, "that is not a browser verb");
  const found = drivableSession(request.nodeId);
  if (!found)
    refuse(DRIVE_CODES.notDrivable, notDrivableMessage(request.nodeId));
  const { entry, session } = found;
  if (entry.contents.isDestroyed()) {
    refuse(DRIVE_CODES.discarded, discardedMessage(request.nodeId));
  }
  session.clearRevocation();
  if (session.listener === null) {
    session.listener = (method, params) =>
      onDomainEvent(entry.nodeId, method, params);
  }
  await session.attach();
  return runVerbOnHost(
    shellHost({ nodeId: entry.nodeId, tabId: entry.tabId, session }),
    request.verb,
    request.args,
  );
}
