import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The notifications the MAIN process sends, against a stand-in `Notification`.
 *
 * The bug this wiring exists to prevent is not visible in any pure test:
 * Electron garbage-collects a `Notification` nothing references
 * (electron/electron#16922), and the notification still SHOWS — only its
 * click handler is quietly gone. So what is asserted here is that every shown
 * notification is retained, that the retention is bounded, and that a click
 * brings the window back and hands the `nodeId` to the page rather than the
 * shell trying to act on a canvas it knows nothing about.
 */

class FakeNotification {
  shown = 0;
  /** A LIST per event, not one listener: `retainUntilDismissed` adds its own
   * release on the same three events the module's own handler uses, and a map
   * of single listeners would silently drop one of them. */
  readonly handlers = new Map<string, (() => void)[]>();
  constructor(readonly options: { title: string; body: string }) {
    made.push(this);
  }
  on(event: string, listener: () => void) {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(listener);
    this.handlers.set(event, listeners);
  }
  show() {
    this.shown += 1;
  }
  private emit(event: string) {
    for (const listener of this.handlers.get(event) ?? []) listener();
  }
  click() {
    this.emit("click");
  }
  dismiss() {
    this.emit("close");
  }
}

const made: FakeNotification[] = [];
let supported = true;

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return supported;
    }
    constructor(options: { title: string; body: string }) {
      return new FakeNotification(options) as unknown as object;
    }
  },
}));

const reveals: number[] = [];
const sent: { channel: string; args: unknown[] }[] = [];
vi.mock("./window", () => ({
  revealWindow: () => reveals.push(1),
  sendToWindow: (channel: string, ...args: unknown[]) =>
    sent.push({ channel, args }),
}));

import { IPC } from "../shared/ipc";
import {
  MAX_RETAINED,
  clearRetained,
  retainedCount,
} from "../shell-core/notification-retain";
import { notify } from "./notifications";

beforeEach(() => {
  made.length = 0;
  reveals.length = 0;
  sent.length = 0;
  supported = true;
  clearRetained();
});

describe("sending one", () => {
  it("shows it with the title and body it was given", () => {
    notify({ title: "Done", body: "agent finished" });
    expect(made).toHaveLength(1);
    expect(made[0]?.options).toEqual({ title: "Done", body: "agent finished" });
    expect(made[0]?.shown).toBe(1);
  });

  it("does nothing where the OS has no notification service", () => {
    supported = false;
    notify({ title: "Done", body: "agent finished" });
    expect(made).toEqual([]);
  });
});

describe("keeping the click handler alive", () => {
  it("retains every shown notification", () => {
    notify({ title: "a", body: "a" });
    notify({ title: "b", body: "b" });
    expect(retainedCount()).toBe(2);
  });

  it("releases one the OS reported dismissed", () => {
    notify({ title: "a", body: "a" });
    made[0]?.dismiss();
    expect(retainedCount()).toBe(0);
  });

  it("holds at most fifty, so Notification Center cannot grow it forever", () => {
    // Beyond the cap the OLDEST is dropped: its click stops working, which is
    // only the pre-fix behaviour, while anything recent keeps its handler.
    for (let index = 0; index < MAX_RETAINED + 12; index += 1)
      notify({ title: `n${index}`, body: "b" });
    expect(retainedCount()).toBe(MAX_RETAINED);
  });
});

describe("clicking one", () => {
  it("brings the window back", () => {
    notify({ title: "a", body: "a" });
    made[0]?.click();
    expect(reveals).toEqual([1]);
  });

  it("hands the nodeId to the page rather than acting on it", () => {
    // The shell has no idea what a canvas node is and must not try to be the
    // second implementation of selecting one.
    notify({ title: "a", body: "a", nodeId: "node-7" });
    made[0]?.click();
    expect(sent).toEqual([
      {
        channel: IPC.windowNotificationClick.channel,
        args: [{ nodeId: "node-7" }],
      },
    ]);
  });

  it("sends nothing when the notification was about no node in particular", () => {
    notify({ title: "a", body: "a" });
    made[0]?.click();
    expect(sent).toEqual([]);
  });
});
