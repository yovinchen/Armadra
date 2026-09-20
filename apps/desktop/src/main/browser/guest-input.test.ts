import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * guest 的 `before-input-event` 真的被接上了吗。
 *
 * `guest-keys.test.ts` 钉的是判断本身；这一份钉的是**接线**——判断算出
 * `host` 之后有没有真的 `preventDefault` 并把和弦送回页面，算出 `intent`
 * 之后有没有走壳那条问答。两者分开是因为它们各自坏掉的样子完全不同：判断
 * 错了是「某个键跑错了地方」，接线错了是「所有键都还在网页里」。
 */

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Listener[]>();

const fakeContents = {
  id: 11,
  debugger: {
    isAttached: () => false,
    attach: () => undefined,
    detach: () => undefined,
    on: () => undefined,
    sendCommand: async () => ({}),
  },
  isDestroyed: () => false,
  getType: () => "webview",
  getURL: () => "https://example.test/",
  getTitle: () => "Example",
  session: { on: () => undefined },
  on: (event: string, listener: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  },
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

vi.mock("../menu", () => ({
  claimKeyIntent: vi.fn(),
}));

vi.mock("./bus", () => ({
  publishEvent: vi.fn(),
  setPublisher: vi.fn(),
}));

import { claimKeyIntent } from "../menu";
import { publishEvent } from "./bus";
import { handleRegister } from "./index";
import { tellRenderer } from "./renderer";
import { resetRegistry } from "./registry";

function fire(input: Record<string, unknown>): { prevented: boolean } {
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  };
  for (const listener of listeners.get("before-input-event") ?? []) {
    listener(event, {
      type: "keyDown",
      key: "k",
      code: "KeyK",
      meta: false,
      control: false,
      shift: false,
      alt: false,
      ...input,
    });
  }
  return { prevented };
}

/*
  接线只发生一次：`wireGuest` 用一个 `WeakSet` 挡住重复装监听器，所以每个
  用例重新注册一遍并不会再装一个——把注册放进 `beforeEach` 的写法只有第一
  个用例是真的在测东西。
*/
beforeAll(() => {
  resetRegistry();
  handleRegister({
    webContentsId: 11,
    nodeId: "browser-1",
    tabId: "wv-1",
    surface: "canvas",
    active: true,
  });
  expect(listeners.get("before-input-event") ?? []).toHaveLength(1);
});

beforeEach(() => {
  vi.mocked(tellRenderer).mockClear();
  vi.mocked(claimKeyIntent).mockClear();
  vi.mocked(publishEvent).mockClear();
});

describe("guest 的 before-input-event", () => {
  it("应用和弦：拦下来，并按节点送回页面", () => {
    const platform = process.platform;
    const meta = platform === "darwin";
    const { prevented } = fire(meta ? { meta: true } : { control: true });
    expect(prevented).toBe(true);
    const sent = vi
      .mocked(tellRenderer)
      .mock.calls.map(([command]) => command)
      .filter((command) => command.kind === "key");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "key",
      nodeId: "browser-1",
      key: "k",
      code: "KeyK",
    });
  });

  it("⌘W 走壳那条问答，不当成一次重放", () => {
    const meta = process.platform === "darwin";
    fire(meta ? { key: "w", meta: true } : { key: "w", control: true });
    expect(vi.mocked(claimKeyIntent)).toHaveBeenCalledWith("close-window");
    expect(
      vi
        .mocked(tellRenderer)
        .mock.calls.filter(([command]) => command.kind === "key"),
    ).toHaveLength(0);
  });

  it("网页自己的键：不拦、不转发", () => {
    const meta = process.platform === "darwin";
    const { prevented } = fire(
      meta ? { key: "c", meta: true } : { key: "c", control: true },
    );
    expect(prevented).toBe(false);
    expect(
      vi
        .mocked(tellRenderer)
        .mock.calls.filter(([command]) => command.kind === "key"),
    ).toHaveLength(0);
  });

  it("普通打字一个都不动", () => {
    const { prevented } = fire({ key: "a" });
    expect(prevented).toBe(false);
    expect(vi.mocked(claimKeyIntent)).not.toHaveBeenCalled();
  });

  it("转发过的和弦仍然算一次人的输入（抢回租约的依据）", () => {
    // Agent 在驱动时人敲了 ⌘K：那既是一条要送回宿主的和弦，也是一次「人
    // 来了」。转发的分支提前 return 就会把后者吃掉，而那是一条 Critical
    // 级的静默失效——Agent 会继续开着租约驱动一个人已经接管的页面。
    const meta = process.platform === "darwin";
    fire(meta ? { meta: true } : { control: true });
    expect(
      vi
        .mocked(publishEvent)
        .mock.calls.filter(
          ([event]) => (event as { event?: string }).event === "humanInput",
        ),
    ).toHaveLength(1);
  });
});
