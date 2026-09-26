import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 被动旁听（`./observe`）：浏览器节点被 Agent 连着时，壳只订阅三路事件，
 * 不驱动任何东西；控制台在第一次驱动之前就进缓冲；人收回页面之后整个摘掉
 * 再重新旁听；最后一条连线断开就摘掉。调试器是记录式的替身，页面是
 * `core/browser/cdp/fake-page.ts`，中间的白名单与会话是真的。
 */

import { FakePage } from "../../core/browser/cdp/fake-page";

interface Sent {
  guest: number;
  method: string;
}

const sent: Sent[] = [];
const pages = new Map<number, FakePage>();
const attached = new Map<number, number>();
const attachCalls = new Map<number, number>();
const listeners = new Map<
  number,
  Map<string, Array<(...args: unknown[]) => void>>
>();

function emit(guest: number, event: string, ...args: unknown[]): void {
  for (const listener of listeners.get(guest)?.get(event) ?? [])
    listener(...args);
}

function fakeContents(id: number) {
  return {
    id,
    debugger: {
      isAttached: () => (attached.get(id) ?? 0) > 0,
      attach: () => {
        attached.set(id, 1);
        attachCalls.set(id, (attachCalls.get(id) ?? 0) + 1);
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
        sent.push({ guest: id, method });
        return pages.get(id)!.dispatch(method, params, sessionId);
      },
    },
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => pages.get(id)!.url,
    getTitle: () => pages.get(id)!.title,
    session: { on: () => undefined },
    on: () => undefined,
    once: () => undefined,
  };
}

const contents = new Map<number, ReturnType<typeof fakeContents>>();

vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => contents.get(id) },
  session: { fromPartition: () => ({ on: () => undefined }) },
}));

vi.mock("./renderer", () => ({
  askRenderer: vi.fn(async () => undefined),
  tellRenderer: vi.fn(),
}));

import {
  observeNode,
  parseObserved,
  resetObserved,
  setObservedNodes,
} from "./observe";
import { guestsOfNode, registerGuest, resetRegistry } from "./registry";
import { resetTransfers } from "./transfers";
import { runVerb } from "./verbs";

function register(id: number, nodeId: string, tabId: string): void {
  pages.set(id, new FakePage());
  contents.set(id, fakeContents(id));
  registerGuest({
    webContentsId: id,
    nodeId,
    tabId,
    surface: "canvas",
    active: true,
  });
}

function methodsOf(guest: number): string[] {
  return sent.filter((each) => each.guest === guest).map((each) => each.method);
}

async function settle(): Promise<void> {
  await new Promise((done) => setTimeout(done, 0));
}

beforeEach(() => {
  sent.length = 0;
  attached.clear();
  attachCalls.clear();
  listeners.clear();
  pages.clear();
  contents.clear();
  resetRegistry();
  resetTransfers();
  resetObserved();
  register(7, "browser-1", "tab-1");
});

afterEach(() => {
  resetObserved();
  resetRegistry();
  resetTransfers();
});

describe("passive observation", () => {
  it("subscribes to three event streams and drives nothing", async () => {
    setObservedNodes(["browser-1"]);
    await settle();
    expect(attached.get(7)).toBe(1);
    expect(methodsOf(7)).toEqual([
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
    ]);
    const session = guestsOfNode("browser-1")[0]!.session!;
    // Not the lease: downloads stay the person's, and no dialog is taken.
    expect(session.isAttached()).toBe(false);
    expect(session.isObserving()).toBe(true);
    // The whole set again (every link change resends it): nothing new.
    setObservedNodes(["browser-1"]);
    await settle();
    expect(methodsOf(7)).toHaveLength(3);
    expect(attachCalls.get(7)).toBe(1);
  });

  it("buffers the console before the first verb, and the first verb reads it", async () => {
    setObservedNodes(["browser-1"]);
    await settle();
    emit(7, "message", {}, "Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "连线之后、驱动之前" }],
      timestamp: 1,
    });
    const read = (await runVerb({
      id: "r1",
      nodeId: "browser-1",
      verb: "read",
      args: { mode: "console" },
    })) as { entries?: Array<{ text: string }> };
    expect(read.entries?.map((entry) => entry.text)).toContain(
      "连线之后、驱动之前",
    );
    // The first verb completed the attach on the same debugger.
    expect(attachCalls.get(7)).toBe(1);
    expect(methodsOf(7)).toContain("Page.enable");
  });

  it("detaches wholly when the lease ends, then listens again", async () => {
    setObservedNodes(["browser-1"]);
    await settle();
    await runVerb({ id: "r1", nodeId: "browser-1", verb: "read", args: {} });
    const session = guestsOfNode("browser-1")[0]!.session!;
    expect(session.isAttached()).toBe(true);
    sent.length = 0;
    session.detach("the user took this browser back");
    await settle();
    // A new debugger session: device metrics and dialog routing went with
    // the old one; the new one only listens.
    expect(attachCalls.get(7)).toBe(2);
    expect(methodsOf(7)).toEqual([
      "Runtime.enable",
      "Log.enable",
      "Network.enable",
    ]);
    expect(session.isAttached()).toBe(false);
    expect(session.revokedReason()).toBe("the user took this browser back");
  });

  it("detaches when the last link goes, and not while an agent is driving", async () => {
    setObservedNodes(["browser-1"]);
    await settle();
    setObservedNodes([]);
    expect(attached.get(7)).toBe(0);

    setObservedNodes(["browser-1"]);
    await settle();
    await runVerb({ id: "r1", nodeId: "browser-1", verb: "read", args: {} });
    setObservedNodes([]);
    // Driving: the lease ending is what detaches, not the link.
    expect(attached.get(7)).toBe(1);
    guestsOfNode("browser-1")[0]!.session!.detach("lease ended");
    await settle();
    expect(attached.get(7)).toBe(0);
  });

  it("covers a tab registered after the link, and never an unlinked node", async () => {
    setObservedNodes(["browser-1"]);
    await settle();
    register(8, "browser-1", "tab-2");
    register(9, "browser-2", "tab-1");
    observeNode("browser-1");
    observeNode("browser-2");
    await settle();
    expect(attached.get(8)).toBe(1);
    expect(attached.get(9) ?? 0).toBe(0);
  });

  it("reads the node list from the notice defensively", () => {
    expect(parseObserved({ nodeIds: ["a", "", 3, "b"] })).toEqual(["a", "b"]);
    expect(parseObserved(null)).toEqual([]);
    expect(parseObserved({ nodeIds: "a" })).toEqual([]);
  });
});
