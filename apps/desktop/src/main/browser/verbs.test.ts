import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The desktop shell's half of the verbs, against RECORDING debuggers.
 *
 * What a verb does to a page is tested once, for both backends, in
 * `core/browser/cdp/verbs.test.ts`. What is left here is what only this shell
 * does: which `<webview>` guest a verb reaches (`--tab` included), attaching
 * lazily and once, the debugger's events — a dialog, a cross-origin iframe's
 * child session — reaching the session, and printing through Electron.
 *
 * The page behind each debugger is `core/browser/cdp/fake-page.ts`; the
 * allowlist, the ref table and the frozen script table in between are the real
 * ones, and the trace at the bottom is checked for page-side evaluation.
 */

/* ------------------------------ the stub guests ---------------------------- */

import { FakePage } from "../../core/browser/cdp/fake-page";

interface Sent {
  guest: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const sent: Sent[] = [];
const pages = new Map<number, FakePage>();
const attached = new Map<number, number>();
const listeners = new Map<
  number,
  Map<string, Array<(...args: unknown[]) => void>>
>();
let printed = 0;

function emit(guest: number, event: string, ...args: unknown[]): void {
  for (const listener of listeners.get(guest)?.get(event) ?? [])
    listener(...args);
}

function listenerCount(guest: number, event: string): number {
  return listeners.get(guest)?.get(event)?.length ?? 0;
}

function fakeContents(id: number) {
  const debuggerStub = {
    isAttached: () => (attached.get(id) ?? 0) > 0,
    attach: () => {
      attached.set(id, (attached.get(id) ?? 0) + 1);
    },
    detach: () => {
      attached.set(id, 0);
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const own = listeners.get(id) ?? new Map();
      own.set(event, [...(own.get(event) ?? []), listener]);
      listeners.set(id, own);
    },
    sendCommand: async (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => {
      sent.push({
        guest: id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      });
      return pages.get(id)!.dispatch(method, params, sessionId);
    },
  };
  return {
    id,
    debugger: debuggerStub,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => pages.get(id)!.url,
    getTitle: () => pages.get(id)!.title,
    session: { on: () => undefined },
    on: () => undefined,
    once: () => undefined,
    setWindowOpenHandler: () => undefined,
    printToPDF: async () => {
      printed += 1;
      return Buffer.from("%PDF-1.7\n<< /Type /Page >>\n%%EOF");
    },
  };
}

const contents = new Map<number, ReturnType<typeof fakeContents>>();

vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => contents.get(id) },
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

function page(guest: number, title: string): FakePage {
  const fake = new FakePage();
  fake.title = title;
  fake.url = `https://example.test/${guest}`;
  fake.elements = [
    {
      id: 11,
      role: "button",
      name: `${title}按钮`,
      box: { x: 10, y: 10, w: 80, h: 20 },
    },
  ];
  return fake;
}

beforeEach(() => {
  sent.length = 0;
  attached.clear();
  listeners.clear();
  pages.clear();
  contents.clear();
  printed = 0;
  for (const [id, title] of [
    [7, "一"],
    [8, "二"],
  ] as const) {
    pages.set(id, page(id, title));
    contents.set(id, fakeContents(id));
  }
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "armadra-verbs-")));
  workspace = join(temporary, "proj");
  mkdirSync(workspace, { recursive: true });
  resetRegistry();
  resetTransfers();
  registerGuest({
    webContentsId: 7,
    nodeId: "browser-1",
    tabId: "tab-1",
    surface: "canvas",
    active: true,
  });
  registerGuest({
    webContentsId: 8,
    nodeId: "browser-1",
    tabId: "tab-2",
    surface: "canvas",
    active: false,
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
  return runVerb({
    id: "r1",
    nodeId: "browser-1",
    verb,
    args: { workspaceRoot: workspace, ...args },
  });
}

/* ------------------------------- lazy attach ------------------------------- */

describe("attach", () => {
  it("has not happened before a verb asks for one", () => {
    // The whole reason attach is lazy. A guest nobody drives never has a
    // debugger on it, so "the capability is off" is a statement about a
    // counter rather than about intent.
    expect(attached.get(7) ?? 0).toBe(0);
    expect(sent).toEqual([]);
  });

  it("happens once, however many verbs follow, and prepares the page", async () => {
    const before = attachCount();
    await run("read", { mode: "title" });
    await run("read", { mode: "snapshot" });
    expect(attachCount()).toBe(before + 1);
    const methods = sent.map((each) => each.method);
    for (const method of [
      "Page.enable",
      "Runtime.enable",
      "Page.setInterceptFileChooserDialog",
      "Log.enable",
      "Network.enable",
      "Target.setAutoAttach",
    ]) {
      expect(methods, method).toContain(method);
    }
  });

  it("subscribes to the debugger once, even across a revocation and a re-attach", async () => {
    await run("read", { mode: "title" });
    const { revokeNode } = await import("./index");
    revokeNode("browser-1", "the user took this browser back");
    await run("read", { mode: "title" });
    expect(listenerCount(7, "message")).toBe(1);
  });

  it("does not happen for a node that cannot be driven, and says so in one sentence", async () => {
    await expect(
      runVerb({ id: "r", nodeId: "browser-9", verb: "read", args: {} }),
    ).rejects.toThrow('no drivable browser node "browser-9"');
    expect(sent).toEqual([]);
  });
});

/* ---------------------------------- --tab ---------------------------------- */

describe("--tab", () => {
  it("drives the named tab's guest, leaving the active one alone", async () => {
    const answer = (await run("read", { mode: "title", tab: "tab-2" })) as {
      title: string;
    };
    expect(answer.title).toBe("二");
    expect(sent.every((each) => each.guest === 8)).toBe(true);
    expect(attached.get(7) ?? 0).toBe(0);
  });

  it("refuses a tab this node does not have", async () => {
    await expect(run("read", { tab: "tab-9" })).rejects.toThrow(
      "这个节点没有标签页 tab-9",
    );
  });

  it("close --tab names the tab to close, and keeps the last one", async () => {
    const list = (await run("tabs")) as {
      activeTabId: string;
      tabs: unknown[];
    };
    expect(list.activeTabId).toBe("tab-1");
    expect(list.tabs).toHaveLength(2);
    await expect(run("close", { tab: "tab-9" })).rejects.toThrow(
      "没有标签页 tab-9",
    );
    const { askRenderer } = await import("./renderer");
    await run("close", { tab: "tab-2" });
    expect(askRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tabs",
        action: "close",
        tabId: "tab-2",
      }),
    );
  });
});

/* ------------------------------ debugger events ----------------------------- */

describe("what the debugger reports", () => {
  it("a dialog blocks other verbs until `dialog` answers it", async () => {
    await expect(run("dialog", { accept: true })).rejects.toThrow(
      "没有打开的对话框",
    );
    await run("read", { mode: "title" });
    emit(7, "message", {}, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "删除？",
    });
    await expect(run("read")).rejects.toThrow("删除？");
    const answer = (await run("dialog", { accept: false })) as {
      accepted: boolean;
    };
    expect(answer.accepted).toBe(false);
    expect(sent.map((each) => each.method)).toContain(
      "Page.handleJavaScriptDialog",
    );
  });

  it("a cross-origin iframe's child session is read through its own session id", async () => {
    await run("read", { mode: "title" });
    const fake = pages.get(7)!;
    fake.elements.push(
      {
        id: 20,
        role: "Iframe",
        name: "",
        box: { x: 100, y: 100, w: 200, h: 100 },
      },
      {
        id: 21,
        role: "button",
        name: "里面",
        frame: "child-1",
        box: { x: 5, y: 5, w: 40, h: 20 },
      },
    );
    fake.children.set("child-1", {
      targetId: "F2",
      owner: 20,
      url: "https://other.test/",
    });
    emit(7, "message", {}, "Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: {
        type: "iframe",
        targetId: "F2",
        url: "https://other.test/",
      },
    });
    emit(
      7,
      "message",
      {},
      "Runtime.consoleAPICalled",
      { type: "log", args: [{ type: "string", value: "来自 iframe" }] },
      "child-1",
    );
    const snapshot = (await run("read", {})) as { lines: string[] };
    expect(snapshot.lines.join("\n")).toContain('button "里面"');
    expect(sent.some((each) => each.sessionId === "child-1")).toBe(true);
    const log = (await run("read", { mode: "console" })) as {
      entries: Array<{ text: string; frame: string }>;
    };
    expect(log.entries).toEqual([
      expect.objectContaining({ text: "来自 iframe", frame: "iframe" }),
    ]);
  });
});

/* ---------------------------------- pdf ------------------------------------ */

describe("pdf", () => {
  it("prints through Electron, which a headed guest needs, into the workspace", async () => {
    const answer = (await run("pdf", { path: "out/page.pdf" })) as {
      path: string;
    };
    expect(printed).toBe(1);
    expect(sent.map((each) => each.method)).not.toContain("Page.printToPDF");
    expect(readFileSync(answer.path).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

/* ------------------------------ the CDP trace ------------------------------ */

describe("the trace over every verb", () => {
  it("carries no page-side evaluation, no Debugger domain and no expression", async () => {
    writeFileSync(join(workspace, "ok.txt"), "x");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["navigate", { url: "https://example.test/c", action: "goto" }],
      ["read", { mode: "title" }],
      ["read", { mode: "snapshot" }],
      ["read", { mode: "console" }],
      ["read", { mode: "network" }],
      ["click", { role: "button", name: "一按钮" }],
      ["hover", { role: "button", name: "一按钮" }],
      ["wait", { selector: "#ok", timeoutMs: 0 }],
      ["capture", { path: ".armadra/browser/t.png" }],
      ["press", { key: "Tab" }],
      ["scroll", { direction: "down" }],
      ["resize", { width: 800, height: 600 }],
      ["download", {}],
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
      expect(call.method, call.method).not.toBe("Runtime.evaluate");
      expect(call.method, call.method).not.toBe("DOM.getOuterHTML");
      expect(call.method, call.method).not.toBe("Network.getResponseBody");
      expect("expression" in call.params, call.method).toBe(false);
    }
    const declarations = sent
      .filter((each) => each.method === "Runtime.callFunctionOn")
      .map((each) => each.params.functionDeclaration);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(Object.values(SCRIPTS)).toContain(declaration);
    }
  });
});
