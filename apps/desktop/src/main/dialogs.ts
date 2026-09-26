import { dialog } from "electron";
import type { PickOptions } from "../shared/ipc";
import { getMainWindow } from "./window";

/**
 * The system folder picker.
 *
 * It returns ABSOLUTE PATHS rather than bytes: the page hands a path to the
 * Runtime, and the Runtime is the process allowed to read it. There is no file
 * picker here — files reach the canvas through the page's own file input, and
 * the browser node's file chooser is answered by the core over CDP.
 *
 * The dialog is attached to the window (`showOpenDialog(window, …)`) so it is
 * a sheet on macOS rather than a free-floating panel — a free panel can end
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
