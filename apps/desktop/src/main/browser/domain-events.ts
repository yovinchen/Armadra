import { publishEvent } from "./bus";
import { noteChooser } from "./transfers";
import { openDialogs } from "./verbs";

/**
 * What the shell does with the three debugger events it subscribes to.
 *
 * All three only exist while a debugger is attached, which is only while an
 * agent is driving. A dialog a person raised on their own page is answered by
 * Chromium's own modal, as it should be.
 */
export function onDomainEvent(nodeId: string, method: string, params: unknown): void {
  if (method === "Page.javascriptDialogOpening") {
    const dialog = params as { type?: string; message?: string; defaultPrompt?: string };
    const record = {
      id: `dialog-${Date.now()}`,
      kind: dialog.type ?? "alert",
      // A dialog's text is a page's text. It is carried, bounded, and never
      // interpreted.
      message: (dialog.message ?? "").slice(0, 2_000),
      defaultPrompt: (dialog.defaultPrompt ?? "").slice(0, 2_000),
    };
    openDialogs.set(nodeId, record);
    publishEvent({ type: "event", event: "dialog", nodeId, ...record });
    return;
  }
  if (method === "Page.javascriptDialogClosed") {
    openDialogs.delete(nodeId);
    publishEvent({ type: "event", event: "dialogClosed", nodeId });
    return;
  }
  if (method === "Page.fileChooserOpened") {
    const chooser = params as { backendNodeId?: number; mode?: string };
    if (typeof chooser.backendNodeId === "number") {
      noteChooser(nodeId, chooser.backendNodeId, chooser.mode ?? "selectSingle");
      publishEvent({ type: "event", event: "fileChooser", nodeId, mode: chooser.mode ?? "" });
    }
  }
}
