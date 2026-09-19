import { globalShortcut } from "electron";
import { IPC } from "../shared/ipc";
import {
  precheck,
  readBindings,
  type BindingOutcome,
} from "../shell-core/shortcut-rules";
import { getMainWindow, revealWindow, sendToWindow } from "./window";

/**
 * System-wide hotkeys, the Electron half of `src-tauri/src/shortcuts.rs`. The
 * rules it follows — nothing bound by default, only the two known ids, a
 * refusal reported rather than swallowed — are written down (and tested) in
 * `shell-core/shortcut-rules.ts`.
 */

/** The accelerators this shell currently holds, so the next apply releases
 * them. The live set is exactly the last list applied; there is no incremental
 * state that could drift out of sync with the settings document. */
let held: string[] = [];

/**
 * Replaces every hotkey this shell holds with the requested list.
 *
 * Returns one outcome per request, in the order they were given, so the
 * settings page can say which line is the one the system refused.
 */
export function applyShortcuts(request: unknown): BindingOutcome[] {
  for (const accelerator of held.splice(0)) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Unregistering something the OS already dropped is not a failure worth
      // aborting the apply for — the goal is only that we no longer hold it.
    }
  }

  const outcomes: BindingOutcome[] = [];
  for (const binding of readBindings(request)) {
    const checked = precheck(binding);
    if (!checked.ok) {
      outcomes.push({ id: binding.id, state: checked.state });
      continue;
    }
    // `register` answers false when the combination is already held — the OS
    // does not distinguish the reasons, and "taken" is the only explanation a
    // user can act on.
    let bound = false;
    try {
      bound = globalShortcut.register(checked.accelerator, () =>
        perform(binding.id),
      );
    } catch {
      bound = false;
    }
    if (bound) held.push(checked.accelerator);
    outcomes.push({ id: binding.id, state: bound ? "bound" : "taken" });
  }
  return outcomes;
}

/** Called on quit: a global hotkey outlives the window, not the process. */
export function releaseShortcuts(): void {
  held = [];
  globalShortcut.unregisterAll();
}

/**
 * What a hotkey does when it fires.
 *
 * Showing and hiding the window is the shell's own business, so it happens
 * here. Anything that touches the canvas is the page's business and is handed
 * over as an event: the shell has no idea what a terminal node is, and giving
 * it one would be a second, divergent implementation of a canvas action
 * (`shortcuts.rs:143-148`).
 */
function perform(id: string): void {
  if (id === "global.toggleWindow") {
    const window = getMainWindow();
    if (window?.isVisible() && window.isFocused()) {
      window.hide();
      return;
    }
    revealWindow();
    return;
  }
  // 新建终端节点得先能看见画布。
  revealWindow();
  sendToWindow(IPC.shortcutsTriggered.channel, id);
}
