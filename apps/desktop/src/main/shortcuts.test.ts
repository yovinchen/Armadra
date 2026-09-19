import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * System-wide hotkeys, against a stand-in `globalShortcut`.
 *
 * The rules — nothing bound by default, only the known ids, a refusal
 * reported rather than swallowed — are pure and tested in
 * `shell-core/shortcut-rules.ts`. What only exists once they meet Electron is
 * what this file asserts: that `register` answering false becomes `taken`
 * rather than a silent success, that an apply RELEASES everything it held
 * first, and that a hotkey which fires does the shell's half here and hands
 * the canvas half to the page.
 */

const registered: string[] = [];
const unregistered: string[] = [];
/** Accelerators the OS refuses, as if something else already holds them. */
let held: string[] = [];
/** Accelerators for which `register` throws, as Electron does for junk. */
let throwing: string[] = [];
let allUnregistered = 0;
const callbacks = new Map<string, () => void>();

vi.mock("electron", () => ({
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (throwing.includes(accelerator)) throw new Error("bad accelerator");
      registered.push(accelerator);
      if (held.includes(accelerator)) return false;
      callbacks.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => {
      unregistered.push(accelerator);
    },
    unregisterAll: () => {
      allUnregistered += 1;
    },
  },
}));

const sent: { channel: string; args: unknown[] }[] = [];
const reveals: number[] = [];
let windowState: { visible: boolean; focused: boolean } | null = null;
const hides: number[] = [];

vi.mock("./window", () => ({
  getMainWindow: () =>
    windowState === null
      ? null
      : {
          isVisible: () => windowState?.visible ?? false,
          isFocused: () => windowState?.focused ?? false,
          hide: () => hides.push(1),
        },
  revealWindow: () => reveals.push(1),
  sendToWindow: (channel: string, ...args: unknown[]) =>
    sent.push({ channel, args }),
}));

import { IPC } from "../shared/ipc";
import { applyShortcuts, releaseShortcuts } from "./shortcuts";

beforeEach(() => {
  registered.length = 0;
  unregistered.length = 0;
  sent.length = 0;
  reveals.length = 0;
  hides.length = 0;
  callbacks.clear();
  held = [];
  throwing = [];
  allUnregistered = 0;
  windowState = null;
});

afterEach(() => {
  releaseShortcuts();
});

describe("applying a list of hotkeys", () => {
  it("reports one outcome per request, in the order they were given", () => {
    const outcomes = applyShortcuts([
      { id: "global.toggleWindow", accelerator: "Alt+Space" },
      { id: "global.newTerminal", accelerator: "Alt+T" },
    ]);
    expect(outcomes).toEqual([
      { id: "global.toggleWindow", state: "bound" },
      { id: "global.newTerminal", state: "bound" },
    ]);
  });

  it("says `taken` when the system already holds the combination", () => {
    // The OS does not distinguish the reasons, and "taken" is the only
    // explanation a user can act on.
    held = ["Alt+Space"];
    expect(
      applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Space" }]),
    ).toEqual([{ id: "global.toggleWindow", state: "taken" }]);
  });

  it("says `taken` rather than throwing when Electron rejects the syntax", () => {
    throwing = ["Alt+Space"];
    expect(
      applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Space" }]),
    ).toEqual([{ id: "global.toggleWindow", state: "taken" }]);
  });

  it("says `invalid` for an id this shell does not implement", () => {
    // Refused BEFORE the OS is asked: the shell would have nothing to do when
    // it fired.
    expect(
      applyShortcuts([{ id: "canvas.newTerminal", accelerator: "Alt+T" }]),
    ).toEqual([{ id: "canvas.newTerminal", state: "invalid" }]);
    expect(registered).toEqual([]);
  });

  it("says `unbound` for a line the user cleared", () => {
    expect(
      applyShortcuts([{ id: "global.toggleWindow", accelerator: "" }]),
    ).toEqual([{ id: "global.toggleWindow", state: "unbound" }]);
    expect(registered).toEqual([]);
  });

  it("releases everything it held before binding the new list", () => {
    applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Space" }]);
    applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Q" }]);
    // The live set is exactly the last list applied; there is no incremental
    // state that could drift out of sync with the settings document.
    expect(unregistered).toEqual(["Alt+Space"]);
  });

  it("does not keep holding a combination the OS refused", () => {
    held = ["Alt+Space"];
    applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Space" }]);
    applyShortcuts([]);
    expect(unregistered).toEqual([]);
  });
});

describe("releasing on quit", () => {
  it("drops everything, because a hotkey outlives the window", () => {
    applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Space" }]);
    releaseShortcuts();
    expect(allUnregistered).toBe(1);
    applyShortcuts([]);
    expect(unregistered).toEqual([]);
  });
});

describe("what a hotkey does when it fires", () => {
  it("hides a window that is visible and focused", () => {
    applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Space" }]);
    windowState = { visible: true, focused: true };
    callbacks.get("Alt+Space")?.();
    expect(hides).toEqual([1]);
    expect(reveals).toEqual([]);
  });

  it("brings back a window that is hidden or in the background", () => {
    applyShortcuts([{ id: "global.toggleWindow", accelerator: "Alt+Space" }]);
    windowState = { visible: true, focused: false };
    callbacks.get("Alt+Space")?.();
    expect(reveals).toEqual([1]);
    expect(hides).toEqual([]);
  });

  it("hands the canvas half to the page instead of doing it itself", () => {
    // The shell has no idea what a terminal node is; implementing one here
    // would be a second, divergent copy of a canvas command.
    applyShortcuts([{ id: "global.newTerminal", accelerator: "Alt+T" }]);
    callbacks.get("Alt+T")?.();
    expect(reveals).toEqual([1]);
    expect(sent).toEqual([
      { channel: IPC.shortcutsTriggered.channel, args: ["global.newTerminal"] },
    ]);
  });
});
