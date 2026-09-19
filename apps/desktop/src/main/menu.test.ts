import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The application menu and the chord it claims, against a stand-in Electron.
 *
 * Two things are worth asserting here and nowhere else, because both only
 * exist once the pure rules are joined to Electron:
 *
 *   1. **⌘W asks the page first.** The shell used to send the intent and close
 *      the window in the same breath, so the page's half — close the selected
 *      node — could never run.
 *   2. **⌘W still always does something.** A page that answers nothing gets
 *      its window closed by the timeout.
 */

const menus: unknown[][] = [];

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: unknown[]) => {
      menus.push(template);
      return { template };
    },
    setApplicationMenu: (menu: unknown) => {
      applied.push(menu);
    },
  },
  app: {
    name: "Armadra",
    getLocale: () => locale,
    quit: () => quits.push(true),
  },
}));

const applied: unknown[] = [];
const quits: boolean[] = [];
let locale = "zh-CN";

const closes: string[] = [];
const sent: { channel: string; args: unknown[] }[] = [];
vi.mock("./window", () => ({
  closeWindow: () => closes.push("close"),
  revealWindow: () => closes.push("reveal"),
  sendToWindow: (channel: string, ...args: unknown[]) =>
    sent.push({ channel, args }),
}));

import { IPC } from "../shared/ipc";
import { KEY_INTENT_REPLY_TIMEOUT_MS } from "../shell-core/key-intent";
import {
  installApplicationMenu,
  installKeydownIntercept,
  settleKeyIntent,
} from "./menu";

/* ------------------------------- stand-ins -------------------------------- */

interface Input {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
}

class FakeWindow {
  private listener:
    | ((event: { preventDefault: () => void }, input: Input) => void)
    | null = null;
  readonly webContents = {
    on: (
      event: string,
      listener: (event: { preventDefault: () => void }, input: Input) => void,
    ) => {
      if (event === "before-input-event") this.listener = listener;
    },
  };

  /** Presses a chord; returns whether the shell claimed it. */
  press(input: Partial<Input> = {}): boolean {
    let prevented = false;
    this.listener?.(
      { preventDefault: () => (prevented = true) },
      {
        type: "keyDown",
        key: "w",
        meta: process.platform === "darwin",
        control: process.platform !== "darwin",
        shift: false,
        alt: false,
        ...input,
      },
    );
    return prevented;
  }
}

function lastToken(): string {
  const last = sent.at(-1);
  expect(last?.channel).toBe(IPC.windowKeyIntent.channel);
  return String(last?.args[1]);
}

beforeEach(() => {
  vi.useFakeTimers();
  menus.length = 0;
  applied.length = 0;
  quits.length = 0;
  closes.length = 0;
  sent.length = 0;
  locale = "zh-CN";
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------------------------- tests --------------------------------- */

describe("the claimed chord", () => {
  it("is handed to the page instead of closing the window on the spot", () => {
    const window = new FakeWindow();
    installKeydownIntercept(window as never);

    expect(window.press()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe(IPC.windowKeyIntent.channel);
    expect(sent[0]?.args[0]).toBe("close-window");
    // The regression: nothing closed yet. The page gets to close a node first.
    expect(closes).toEqual([]);
  });

  it("leaves the window alone when the page says it closed a node", () => {
    const window = new FakeWindow();
    installKeydownIntercept(window as never);
    window.press();

    settleKeyIntent(lastToken(), true);
    vi.advanceTimersByTime(KEY_INTENT_REPLY_TIMEOUT_MS * 4);
    expect(closes).toEqual([]);
  });

  it("closes the window when the page had nothing to close", () => {
    const window = new FakeWindow();
    installKeydownIntercept(window as never);
    window.press();

    settleKeyIntent(lastToken(), false);
    expect(closes).toEqual(["close"]);
  });

  it("closes the window anyway when the page never answers", () => {
    // ⌘W must never become a key that does nothing — a page that crashed, or
    // an older build that never subscribed, still gets its window closed.
    const window = new FakeWindow();
    installKeydownIntercept(window as never);
    window.press();

    expect(closes).toEqual([]);
    vi.advanceTimersByTime(KEY_INTENT_REPLY_TIMEOUT_MS);
    expect(closes).toEqual(["close"]);
  });

  it("closes once, whichever of the page and the timer is first", () => {
    const window = new FakeWindow();
    installKeydownIntercept(window as never);
    window.press();

    settleKeyIntent(lastToken(), false);
    vi.advanceTimersByTime(KEY_INTENT_REPLY_TIMEOUT_MS * 4);
    expect(closes).toEqual(["close"]);
  });

  it("ignores an answer to a chord nobody claimed", () => {
    settleKeyIntent("intent-999", false);
    expect(closes).toEqual([]);
  });

  it("leaves every other key completely alone", () => {
    const window = new FakeWindow();
    installKeydownIntercept(window as never);

    // Plain `w`, ⌘⇧W ("Close All Windows") and a key-up are all not ours.
    expect(window.press({ meta: false, control: false })).toBe(false);
    expect(window.press({ shift: true })).toBe(false);
    expect(window.press({ type: "keyUp" })).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("the application menu", () => {
  it("is built and applied once", () => {
    installApplicationMenu();
    expect(menus).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });

  it("carries no File menu on macOS, because ⌘W is claimed", () => {
    if (process.platform !== "darwin") return;
    installApplicationMenu();
    const roles = (menus[0] as { role?: string }[]).map((item) => item.role);
    expect(roles).toEqual(["appMenu", "editMenu", "windowMenu"]);
  });

  it("takes its wording from the locale Electron reports", () => {
    if (process.platform === "darwin") return;
    locale = "en";
    installApplicationMenu();
    const labels = (menus[0] as { label?: string }[]).map((item) => item.label);
    expect(labels).toContain("File");
  });
});
