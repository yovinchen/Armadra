import { dialog } from "electron";
import type { PickOptions } from "../shared/ipc";
import { getMainWindow } from "./window";

/**
 * The two system pickers.
 *
 * Both return ABSOLUTE PATHS rather than bytes, which is the rule the Rust
 * shell also kept (`platform/index.ts:46-56`): the page hands a path to the
 * Runtime, and the Runtime is the process allowed to read it. Handing the page
 * bytes would mean copying every picked file through the renderer, and for the
 * browser node's file chooser it would mean writing a copy into the project
 * before the page could see it.
 *
 * The dialogs are attached to the window (`showOpenDialog(window, …)`) so they
 * are sheets on macOS rather than free-floating panels — a free panel can end
 * up behind the window it belongs to, with no way back to it.
 */

/** A cancelled dialog is an empty list, never a rejection: cancelling is the
 * ordinary outcome and every caller already treats "nothing picked" as one. */
async function show(
  properties: Electron.OpenDialogOptions["properties"],
  options: PickOptions | undefined,
): Promise<string[]> {
  const window = getMainWindow();
  const request: Electron.OpenDialogOptions = {
    properties,
    ...(options?.defaultPath ? { defaultPath: options.defaultPath } : {}),
  };
  const result = window
    ? await dialog.showOpenDialog(window, request)
    : await dialog.showOpenDialog(request);
  return result.canceled ? [] : result.filePaths;
}

/**
 * The folder picker. `createDirectory` is macOS-only and on by default, but it
 * is spelled out because the New folder flow leans on it: the panel's own "New
 * Folder" button is how the user creates the directory they are about to open.
 * It is Electron's spelling of the Rust shell's `canCreateDirectories`.
 */
export function pickDirectory(options?: PickOptions): Promise<string[]> {
  return show(["openDirectory", "createDirectory"], options);
}

export function pickFiles(options?: PickOptions): Promise<string[]> {
  return show(
    options?.multiple ? ["openFile", "multiSelections"] : ["openFile"],
    options,
  );
}
