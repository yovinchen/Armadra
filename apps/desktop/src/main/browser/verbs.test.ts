import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every verb, against a RECORDING debugger.
 *
 * The guest is a stub, but nothing between the verb and `sendCommand` is: the
 * allowlist, the frozen script table, the ref generations, the coordinate
 * bounds and the capture jail are all the real ones. What the stub replaces is
 * Chromium, and what it gives back is the trace — the exact list of methods
 * that reached the wire, which is the evidence the acceptance gate asks for and
 * the one thing a live run produces that a unit test usually cannot.
 *
 * Three assertions run over that trace for EVERY verb, at the bottom of this
 * file: no page-side evaluation in any spelling, no `Debugger` domain, and no
 * command carrying an `expression` field.
 */

/* ------------------------------ the stub guest ----------------------------- */

interface Sent {
  method: string;
  params: Record<string, unknown>;
}

const sent: Sent[] = [];
let attached = 0;
/** What the page "returns" for each script, by name. */
let scriptAnswers: Record<string, unknown> = {};
let navigationHistory = {
  currentIndex: 1,
  entries: [
    { id: 10, url: "https://example.test/a" },
    { id: 11, url: "https://example.test/b" },
    { id: 12, url: "https://example.test/c" },
  ],
};

const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function emit(event: string, ...args: unknown[]): void {
  for (const listener of listeners.get(event) ?? []) listener(...args);
}

const fakeDebugger = {
  isAttached: () => attached > 0,
  attach: () => {
    attached += 1;
  },
  detach: () => {
    attached = 0;
  },
  on: (event: string, listener: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  },
  sendCommand: async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    return respond(method, params);
  },
};

/** What Chromium would have answered. */
function respond(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "DOM.getDocument":
      return { root: { nodeId: 1 } };
    case "DOM.resolveNode":
      return { object: { objectId: "obj-1" } };
    case "Runtime.callFunctionOn": {
      const declaration = String(params.functionDeclaration);
      const name = nameOfScript(declaration);
      const answer = scriptAnswers[name];
      // An array is a QUEUE: successive calls to the same reader get
      // successive answers, which is how a scroll that actually moved is
      // told apart from one that did not.
      if (Array.isArray(answer)) return { result: { value: answer.shift() } };
      return { result: { value: answer } };
    }
    case "Page.getLayoutMetrics":
      return {
        cssLayoutViewport: { clientWidth: 520, clientHeight: 332 },
        cssContentSize: { width: 520, height: 4_400 },
        cssVisualViewport: { pageX: 0, pageY: 0 },
      };
    case "Page.getNavigationHistory":
      return navigationHistory;
    case "Page.captureScreenshot":
      // A one-pixel PNG, so the write is a real write of real bytes.
      return {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      };
    default:
      return {};
  }
}

function nameOfScript(declaration: string): string {
  for (const [name, body] of Object.entries(SCRIPTS)) {
    if (body === declaration) return name;
  }
  throw new Error(
    "a declaration that is not in the frozen table reached the page",
  );
}

const fakeContents = {
  id: 7,
  debugger: fakeDebugger,
  isDestroyed: () => false,
  getType: () => "webview",
  getURL: () => "https://example.test/c",
  getTitle: () => "Example",
  session: { on: () => undefined },
  on: () => undefined,
  once: () => undefined,
  setWindowOpenHandler: () => undefined,
};

vi.mock("electron", () => ({
  webContents: { fromId: () => fakeContents },
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  clipboard: { writeText: () => undefined },
  session: { fromPartition: () => ({ on: () => undefined }) },
}));

vi.mock("./renderer", () => ({
  askRenderer: vi.fn(async () => undefined),
  tellRenderer: vi.fn(),
}));

import { SCRIPTS } from "../../core/browser/cdp/scripts";
import { attachCount } from "./cdp";
import { registerGuest, resetRegistry } from "./registry";
import { runVerb } from "./verbs";
import { resetTransfers } from "./transfers";

/* --------------------------------- fixtures -------------------------------- */

let workspace = "";
let temporary = "";

/** The six-element fixture, as the frozen reader would have filtered it.
 *
 * Only three survive: the password element (its STATE, never its value), the
 * filled text input and the empty one. `hidden`, `aria-hidden` and
 * `display:none` never leave the page at all — the filtering is inside the
 * script, which is why no caller here can turn it off. */
const SIX_ELEMENT_FIXTURE = {
  elements: [
    { index: 2, role: "input", name: "", detail: "password, filled" },
    { index: 4, role: "input", name: "Email", detail: "email, filled" },
    { index: 5, role: "input", name: "Note", detail: "text, empty" },
  ],
  title: "Sign in",
  url: "https://example.test/in",
};

function defaults(): Record<string, unknown> {
  return {
    readTitle: { title: "Example", url: "https://example.test/c" },
    readText: {
      text: "hello",
      total: 5,
      truncated: false,
      title: "Example",
      url: "https://example.test/c",
    },
    readLinks: {
      links: [{ name: "Next", href: "https://example.test/n" }],
      title: "",
      url: "",
    },
    readMap: SIX_ELEMENT_FIXTURE,
    resolveRef: {
      found: true,
      role: "input",
      name: "Email",
      x: 10,
      y: 20,
      w: 100,
      h: 24,
      visible: true,
      disabled: false,
    },
    resolveSelector: {
      found: true,
      role: "button",
      name: "Sign in",
      x: 10,
      y: 200,
      w: 80,
      h: 24,
      visible: true,
      disabled: false,
    },
    describeElement: {
      found: true,
      tag: "select",
      type: "",
      filled: false,
      multiple: false,
      options: [
        { value: "a", label: "Alpha", selected: true },
        { value: "b", label: "Beta", selected: false },
      ],
      accepts: false,
    },
    isVisible: { found: true, visible: true, x: 10, y: 20, w: 100, h: 24 },
    waitProbe: {
      invalid: false,
      present: true,
      visible: true,
      title: "Example",
      url: "https://example.test/c",
      ready: "complete",
    },
    activeField: {
      found: true,
      tag: "input",
      type: "email",
      editable: true,
      filled: true,
    },
    scrollPosition: {
      top: 0,
      left: 0,
      height: 4_400,
      width: 520,
      viewportWidth: 520,
      viewportHeight: 332,
    },
  };
}

beforeEach(() => {
  sent.length = 0;
  attached = 0;
  listeners.clear();
  scriptAnswers = defaults();
  navigationHistory = {
    currentIndex: 1,
    entries: [
      { id: 10, url: "https://example.test/a" },
      { id: 11, url: "https://example.test/b" },
      { id: 12, url: "https://example.test/c" },
    ],
  };
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "armadra-verbs-")));
  workspace = join(temporary, "proj");
  mkdirSync(join(workspace, ".armadra", "browser"), { recursive: true });
  mkdirSync(join(temporary, "outside"), { recursive: true });
  writeFileSync(join(temporary, "outside", "secret.txt"), "s");
  symlinkSync(join(temporary, "outside"), join(workspace, "escape"));
  resetRegistry();
  resetTransfers();
  registerGuest({
    webContentsId: 7,
    nodeId: "browser-1",
    tabId: "tab-1",
    surface: "canvas",
    active: true,
  });
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
  resetRegistry();
  resetTransfers();
});

function run(
  verb: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return runVerb({ id: "r1", nodeId: "browser-1", verb, args });
}

function methods(): string[] {
  return sent.map((each) => each.method);
}

/* ------------------------------- lazy attach ------------------------------- */

describe("attach", () => {
  it("has not happened before a verb asks for one", () => {
    // The whole reason attach is lazy. A guest nobody drives never has a
    // debugger on it, so "the capability is off" is a statement about a
    // counter rather than about intent.
    expect(attached).toBe(0);
    expect(methods()).toEqual([]);
  });

  it("happens once, however many verbs follow", async () => {
    const before = attachCount();
    await run("read", { mode: "title" });
    await run("read", { mode: "text" });
    expect(attachCount()).toBe(before + 1);
    expect(attached).toBe(1);
  });

  it("does not happen for a node that cannot be driven, and says so in one sentence", async () => {
    const before = attachCount();
    // A node that was never registered, and a node id nothing has ever had:
    // byte-for-byte the same refusal but for the name the caller gave.
    const missing = await run("read").catch((error: Error) => error.message);
    await expect(
      runVerb({ id: "r", nodeId: "browser-9", verb: "read", args: {} }),
    ).rejects.toThrow('no drivable browser node "browser-9"');
    expect(missing).not.toContain("permission");
    expect(attachCount()).toBe(before + 1);
  });
});

/* ------------------------------ the seventeen ------------------------------ */

describe("the verbs", () => {
  it("navigate refuses anything that is not http(s), before it reaches the page", async () => {
    await expect(
      run("navigate", { url: "file:///etc/passwd", action: "goto" }),
    ).rejects.toThrow(/http and https/);
    expect(methods()).not.toContain("Page.navigate");
  });

  it("navigate goes, and reports the address it re-read afterwards", async () => {
    const answer = (await run("navigate", {
      url: "https://example.test/c",
      action: "goto",
    })) as { url: string };
    expect(methods()).toContain("Page.navigate");
    expect(answer.url).toBe("https://example.test/c");
  });

  it("back and forward walk the history entries rather than guessing", async () => {
    await run("back");
    const back = sent.find(
      (each) => each.method === "Page.navigateToHistoryEntry",
    );
    expect(back?.params.entryId).toBe(10);
    sent.length = 0;
    await run("forward");
    const forward = sent.find(
      (each) => each.method === "Page.navigateToHistoryEntry",
    );
    expect(forward?.params.entryId).toBe(12);
  });

  it("back refuses at the start of the history", async () => {
    navigationHistory = {
      currentIndex: 0,
      entries: [{ id: 10, url: "https://example.test/a" }],
    };
    await expect(run("back")).rejects.toThrow(/nothing to go back to/);
  });

  it("read --map mints refs and reports only what the reader let through", async () => {
    const answer = (await run("read", { mode: "map", limit: 40 })) as {
      elements: Array<{ ref: string; detail: string }>;
    };
    // Three of six. The password element is here as a STATE; the hidden,
    // aria-hidden and display:none ones never left the page.
    expect(answer.elements).toHaveLength(3);
    expect(answer.elements.map((each) => each.ref)).toEqual(["@1", "@2", "@3"]);
    expect(answer.elements[0]!.detail).toBe("password, filled");
    expect(JSON.stringify(answer)).not.toContain("hunter2");
  });

  it("click takes a ref, and refuses one the page has navigated away from", async () => {
    await run("read", { mode: "map" });
    await run("click", { ref: "@2" });
    expect(methods()).toContain("Input.dispatchMouseEvent");

    // A main-frame navigation. Every @N the page handed out is now dead.
    emit("message", {}, "Page.frameNavigated", { frame: { id: "main" } });
    await expect(run("click", { ref: "@2" })).rejects.toThrow(
      /no longer on this page/,
    );
  });

  it("click refuses a ref whose element is no longer the element it described", async () => {
    await run("read", { mode: "map" });
    // Same position, different control. This is the "Next page" that became
    // "Delete account" — and it is refused rather than clicked.
    scriptAnswers.resolveRef = {
      found: true,
      role: "button",
      name: "Delete account",
      x: 10,
      y: 20,
      w: 100,
      h: 24,
      visible: true,
      disabled: false,
    };
    await expect(run("click", { ref: "@2" })).rejects.toThrow(
      /no longer on this page/,
    );
  });

  it("click refuses a point outside the measured viewport", async () => {
    await expect(run("click", { x: 9_000, y: 9_000 })).rejects.toThrow(
      /outside the visible page/,
    );
  });

  it("type inserts text and reports a count", async () => {
    const answer = (await run("type", {
      selector: "#email",
      text: "a@b.test",
      replace: true,
    })) as {
      chars: number;
    };
    expect(answer.chars).toBe(8);
    const insert = sent.find((each) => each.method === "Input.insertText");
    expect(insert?.params.text).toBe("a@b.test");
    // Clearing is two editing commands, not a key event carrying text.
    const keys = sent.filter(
      (each) => each.method === "Input.dispatchKeyEvent",
    );
    expect(keys.every((each) => !("text" in each.params))).toBe(true);
  });

  it("type refuses a target that is not a field", async () => {
    scriptAnswers.activeField = {
      found: true,
      tag: "div",
      type: "",
      editable: false,
    };
    await expect(run("type", { selector: "#nope", text: "x" })).rejects.toThrow(
      /not a field text can be typed into/,
    );
  });

  it("press only takes keys from the closed list", async () => {
    await run("press", { key: "Enter", repeat: 2 });
    expect(
      sent.filter((each) => each.method === "Input.dispatchKeyEvent"),
    ).toHaveLength(4);
    await expect(run("press", { key: "F12" })).rejects.toThrow(
      /press takes one of/,
    );
  });

  it("select steps a dropdown with real key events and never assigns a value", async () => {
    scriptAnswers.resolveSelector = {
      found: true,
      role: "select",
      name: "Pick",
      x: 10,
      y: 40,
      w: 100,
      h: 24,
      visible: true,
      disabled: false,
    };
    const answer = (await run("select", {
      selector: "#pick",
      values: ["a"],
    })) as {
      chosen: string[];
    };
    expect(answer.chosen).toEqual(["Alpha"]);
    // Nothing wrote to the page: every script that ran is a reader.
    for (const call of sent.filter(
      (each) => each.method === "Runtime.callFunctionOn",
    )) {
      expect(Object.values(SCRIPTS)).toContain(call.params.functionDeclaration);
    }
  });

  it("scroll reports the measured displacement, not the requested one", async () => {
    const at = (top: number) => ({
      top,
      left: 0,
      height: 4_400,
      viewportHeight: 332,
    });
    scriptAnswers.scrollPosition = [at(0), at(480)];
    const answer = (await run("scroll", {
      direction: "down",
      amount: 600,
    })) as {
      moved: number;
      position: number;
    };
    expect(answer.moved).toBe(480);
    expect(answer.position).toBe(480);
    expect(methods()).toContain("Input.dispatchMouseEvent");
  });

  it("wait polls a probe and reports a timeout as a fact rather than an error", async () => {
    scriptAnswers.waitProbe = {
      invalid: false,
      present: false,
      visible: false,
      title: "",
      url: "https://example.test/c",
      ready: "complete",
    };
    const answer = (await run("wait", { selector: "#late", timeoutMs: 0 })) as {
      matched: boolean;
    };
    expect(answer.matched).toBe(false);
  });

  it("capture writes a file inside the workspace and reports a digest, not bytes", async () => {
    const answer = (await run("capture", {
      workspaceRoot: workspace,
      path: ".armadra/browser/shot.png",
    })) as { path: string; sha256: string; bytes: number };
    expect(answer.path).toBe(join(workspace, ".armadra/browser/shot.png"));
    expect(answer.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain("iVBORw0");
  });

  it("capture refuses a path that climbs out, and one that is a symlink out", async () => {
    await expect(
      run("capture", { workspaceRoot: workspace, path: "../outside/shot.png" }),
    ).rejects.toThrow(/outside the workspace/);
    await expect(
      run("capture", { workspaceRoot: workspace, path: "escape/shot.png" }),
    ).rejects.toThrow(/outside the workspace/);
    // The final segment as a symlink: the one hop realpath of the parent does
    // not cover.
    symlinkSync(
      join(temporary, "outside", "secret.txt"),
      join(workspace, "link.png"),
    );
    await expect(
      run("capture", { workspaceRoot: workspace, path: "link.png" }),
    ).rejects.toThrow(/symbolic link/);
  });

  it("capture --full-page clips to OUR measurement", async () => {
    await run("capture", {
      workspaceRoot: workspace,
      path: ".armadra/browser/full.png",
      fullPage: true,
      // A caller's idea of the page size, which must be ignored.
      width: 99_999,
    });
    const shot = sent.find((each) => each.method === "Page.captureScreenshot");
    expect(shot?.params.clip).toMatchObject({ width: 520, height: 4_400 });
  });

  it("upload refuses the whole batch when one file is outside the workspace", async () => {
    writeFileSync(join(workspace, "ok.txt"), "x");
    await expect(
      run("upload", {
        workspaceRoot: workspace,
        selector: "#file",
        paths: ["ok.txt", "../outside/secret.txt"],
      }),
    ).rejects.toThrow(/outside the workspace/);
    // Nothing was handed to the page: a partial upload is a form somebody
    // submits believing it carries what they named.
    expect(methods()).not.toContain("DOM.setFileInputFiles");
  });

  it("download lists an empty queue rather than inventing one", async () => {
    const answer = (await run("download", { workspaceRoot: workspace })) as {
      downloads: unknown[];
    };
    expect(answer.downloads).toEqual([]);
  });

  it("tabs lists what is registered, and close keeps the last tab", async () => {
    const list = (await run("tabs")) as {
      tabs: unknown[];
      activeTabId: string;
    };
    expect(list.activeTabId).toBe("tab-1");
    await expect(run("close", { tab: "tab-1" })).rejects.toThrow(
      /last tab stays open/,
    );
    await expect(run("close", { tab: "tab-9" })).rejects.toThrow(
      /no tab tab-9/,
    );
  });

  it("dialog refuses when no dialog is open, and answers the one that is", async () => {
    await expect(run("dialog", { accept: true })).rejects.toThrow(
      /no dialog is open/,
    );
    // One verb first, so the session exists and its listener is installed.
    await run("read", { mode: "title" });
    emit("message", {}, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Delete?",
    });
    const answer = (await run("dialog", { accept: false })) as {
      accepted: boolean;
    };
    expect(answer.accepted).toBe(false);
    expect(methods()).toContain("Page.handleJavaScriptDialog");
  });

  it("lease is not a shell verb", async () => {
    await expect(run("lease")).rejects.toThrow(/not a shell verb/);
  });
});

/* ------------------------------ the CDP trace ------------------------------ */

describe("the trace over every verb", () => {
  it("carries no page-side evaluation, no Debugger domain and no expression", async () => {
    writeFileSync(join(workspace, "ok.txt"), "x");
    // Every verb that reaches a page, run once. `lease` stays in the Runtime.
    const calls: Array<[string, Record<string, unknown>]> = [
      ["navigate", { url: "https://example.test/c", action: "goto" }],
      ["read", { mode: "title" }],
      ["read", { mode: "text" }],
      ["read", { mode: "links" }],
      ["read", { mode: "map" }],
      ["click", { ref: "@2" }],
      ["type", { selector: "#email", text: "a@b.test" }],
      ["wait", { selector: "#ok", timeoutMs: 0 }],
      ["capture", { workspaceRoot: workspace, path: ".armadra/browser/t.png" }],
      ["press", { key: "Tab" }],
      ["scroll", { direction: "down" }],
      ["download", { workspaceRoot: workspace }],
      ["tabs", {}],
      ["back", {}],
      ["forward", {}],
    ];
    for (const [verb, args] of calls) {
      await run(verb, args).catch(() => undefined);
    }
    expect(sent.length).toBeGreaterThan(30);

    for (const call of sent) {
      expect(call.method.startsWith("Debugger."), call.method).toBe(false);
      expect(call.method.startsWith("Fetch."), call.method).toBe(false);
      expect(call.method.startsWith("Storage."), call.method).toBe(false);
      expect(call.method.startsWith("Network."), call.method).toBe(false);
      expect(call.method, call.method).not.toBe("Runtime.evaluate");
      expect(call.method, call.method).not.toBe("DOM.getOuterHTML");
      expect("expression" in call.params, call.method).toBe(false);
    }
    // And every declaration that reached a page is a member of the frozen
    // table, byte for byte — checked by the stub itself, which throws on a
    // stranger.
    const declarations = sent
      .filter((each) => each.method === "Runtime.callFunctionOn")
      .map((each) => each.params.functionDeclaration);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(Object.values(SCRIPTS)).toContain(declaration);
    }
  });
});
