/**
 * Which shell the page asks, and what it says when there is none.
 *
 * `state.ts` is where the answers are merged and it is tested exhaustively
 * next door; this file only guards the transport, and the one rule it can
 * break: a page with no desktop shell must report "there is nothing here that
 * an installer could replace" — never "up to date", and never a stale answer
 * from a shell that has gone away.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  UNSUPPORTED_HERE,
  hasShellUpdater,
  onShellProgress,
  onShellStaged,
  shellCancel,
  shellCheck,
  shellDismiss,
  shellDownload,
  shellInstall,
  shellRestartReport,
  shellState,
  type ShellHostVerdict,
} from "./shell-updater";

function verdict(): ShellHostVerdict {
  return {
    state: "available",
    reasonCode: "",
    retryAfterMs: 0,
    checkedAtMs: 1_700_000_000_000,
    target: "darwin-aarch64",
    answer: { version: "0.2.0", notesUrl: "", artifacts: [] },
  };
}

const calls: [string, unknown][] = [];
let progressListener: ((progress: unknown) => void) | null = null;
let unsubscribed = 0;

function bridge(answer: unknown = { state: "idle" }): ArmadraUpdatesBridge {
  const record = (name: string) => async (argument?: unknown) => {
    calls.push([name, argument]);
    return answer;
  };
  return {
    state: record("state"),
    check: record("check"),
    dismiss: record("dismiss"),
    cancel: record("cancel"),
    download: record("download"),
    install: record("install"),
    restartReport: record("restartReport"),
    onProgress: (listener) => {
      progressListener = listener;
      return () => {
        unsubscribed += 1;
        progressListener = null;
      };
    },
  };
}

function expose(updates: ArmadraUpdatesBridge | null): void {
  if (updates === null) {
    Reflect.deleteProperty(globalThis as object, "armadra");
    return;
  }
  Object.defineProperty(globalThis, "armadra", {
    value: { updates },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  calls.length = 0;
  progressListener = null;
  unsubscribed = 0;
  expose(null);
  // No Tauri either, unless a test says otherwise.
  Reflect.deleteProperty(globalThis as object, "__TAURI_INTERNALS__");
});

afterEach(() => {
  expose(null);
  Reflect.deleteProperty(globalThis as object, "__TAURI_INTERNALS__");
  vi.restoreAllMocks();
});

it("a browser with no desktop shell says so and claims nothing else", async () => {
  expect(hasShellUpdater()).toBe(false);
  for (const ask of [
    shellState,
    shellDismiss,
    shellCancel,
    shellDownload,
    shellInstall,
  ]) {
    expect(await ask()).toEqual(UNSUPPORTED_HERE);
  }
  expect(await shellCheck(verdict())).toEqual(UNSUPPORTED_HERE);
  // "Nothing was pending" is the honest answer for a page that has no shell
  // to have restarted.
  expect(await shellRestartReport()).toBeNull();
  // And subscribing costs nothing rather than throwing.
  expect(onShellProgress(() => undefined)()).toBeUndefined();
  expect(onShellStaged(() => undefined)()).toBeUndefined();
});

it("the electron shell answers all seven commands through window.armadra", async () => {
  expose(bridge({ state: "upToDate", checkedAtMs: 7 }));
  expect(hasShellUpdater()).toBe(true);

  expect(await shellState()).toEqual({ state: "upToDate", checkedAtMs: 7 });
  await shellCheck(verdict());
  await shellDismiss();
  await shellCancel();
  await shellDownload();
  await shellInstall();
  await shellRestartReport();

  expect(calls.map(([name]) => name)).toEqual([
    "state",
    "check",
    "dismiss",
    "cancel",
    "download",
    "install",
    "restartReport",
  ]);
  // The verdict travels as one argument, not as Tauri's `{ verdict }` wrapper.
  expect(calls[1]?.[1]).toEqual(verdict());
});

it("a shell that rejects is reported as unsupported, never as an answer", async () => {
  const failing = bridge();
  failing.state = () => Promise.reject(new Error("ipc is gone"));
  expose(failing);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const state = await shellState();

  expect(state).toEqual(UNSUPPORTED_HERE);
  expect(state.state).not.toBe("upToDate");
});

it("transfer progress arrives through the bridge and unsubscribes", () => {
  expose(bridge());
  const seen: unknown[] = [];
  const stop = onShellProgress((progress) => seen.push(progress));

  progressListener?.({ receivedBytes: 4, totalBytes: 9 });
  expect(seen).toEqual([{ receivedBytes: 4, totalBytes: 9 }]);

  stop();
  expect(unsubscribed).toBe(1);
});

/**
 * The Electron shell keeps `autoDownload` off, so no transfer finishes that
 * the page did not ask for; the IPC table declares no `updates:staged`, and
 * this subscription is a no-op rather than a channel invented to fill it.
 */
it("the staged announcement is not a renderer channel in electron", () => {
  expose(bridge());
  const stop = onShellStaged(() => {
    throw new Error("nothing should announce here");
  });
  expect(stop()).toBeUndefined();
});

it("tauri is still asked by command name when there is no bridge", async () => {
  Object.defineProperty(globalThis, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
    writable: true,
  });
  const invoked: [string, unknown][] = [];
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: async (command: string, args: unknown) => {
      invoked.push([command, args]);
      return { state: "idle" };
    },
  }));

  expect(hasShellUpdater()).toBe(true);
  expect(await shellCheck(verdict())).toEqual({ state: "idle" });
  expect(invoked).toEqual([["updates_check", { verdict: verdict() }]]);
  vi.doUnmock("@tauri-apps/api/core");
});
