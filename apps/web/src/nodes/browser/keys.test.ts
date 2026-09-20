import { describe, expect, it } from "vitest";

import {
  BROWSER_NODE_COMMANDS,
  browserCommandFor,
  chordEvent,
  parseForwardedChord,
  replayChord,
} from "./keys";

describe("parseForwardedChord", () => {
  it("补齐四个修饰键，缺的当没按", () => {
    expect(parseForwardedChord({ key: "k", meta: true })).toEqual({
      key: "k",
      code: undefined,
      meta: true,
      control: false,
      shift: false,
      alt: false,
    });
  });

  it("不是 true 的修饰键一律当 false", () => {
    // 载荷过了一次 IPC，`"true"` / `1` 这种形状不该被当成按下了。
    const chord = parseForwardedChord({
      key: "k",
      meta: "yes",
      shift: 1,
    });
    expect(chord?.meta).toBe(false);
    expect(chord?.shift).toBe(false);
  });

  it("没有 key 的不重放", () => {
    expect(parseForwardedChord({ meta: true })).toBeNull();
    expect(parseForwardedChord({ key: "" })).toBeNull();
    expect(parseForwardedChord(null)).toBeNull();
    expect(parseForwardedChord("k")).toBeNull();
  });
});

describe("chordEvent", () => {
  it("造出的事件能被和弦匹配器看懂", () => {
    const event = chordEvent({
      key: "K",
      code: "KeyK",
      meta: true,
      shift: true,
    });
    expect(event.type).toBe("keydown");
    expect(event.key).toBe("K");
    expect(event.code).toBe("KeyK");
    expect(event.metaKey).toBe(true);
    expect(event.shiftKey).toBe(true);
    expect(event.ctrlKey).toBe(false);
    expect(event.altKey).toBe(false);
  });

  it("冒泡且可取消：应用那个捕获监听器要 preventDefault", () => {
    const event = chordEvent({ key: "k", meta: true });
    expect(event.bubbles).toBe(true);
    expect(event.cancelable).toBe(true);
  });
});

describe("replayChord", () => {
  it("派在给定元素上，window 的捕获监听器收得到", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event) => seen.push(event as KeyboardEvent);
    window.addEventListener("keydown", listener, true);
    try {
      expect(replayChord(root, { key: "k", meta: true })).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.key).toBe("k");
      expect(seen[0]!.target).toBe(root);
    } finally {
      window.removeEventListener("keydown", listener, true);
      root.remove();
    }
  });

  it("没有根就什么也不做", () => {
    expect(replayChord(null, { key: "k", meta: true })).toBe(false);
  });
});

describe("browserCommandFor", () => {
  /*
    jsdom 报的不是 mac，所以 `Mod` 在这里解析成 Ctrl，`browser.back` 是
    `Alt+ArrowLeft`——两个平台各自的写法，用例跟着运行环境走而不是硬写 ⌘。
  */
  const chord = (key: string, extra = {}) => ({
    key,
    meta: false,
    control: true,
    shift: false,
    alt: false,
    ...extra,
  });

  it("认出节点自己的那四条", () => {
    expect(browserCommandFor(chord("r"))).toBe("browser.reload");
    expect(browserCommandFor(chord("l"))).toBe("browser.focusAddress");
    expect(
      browserCommandFor(chord("ArrowLeft", { control: false, alt: true })),
    ).toBe("browser.back");
    expect(
      browserCommandFor(chord("ArrowRight", { control: false, alt: true })),
    ).toBe("browser.forward");
  });

  it("不是这四条的交回去重放", () => {
    // ⌘K / ⌘P / ⌘T 归应用与画布，走的是派发器那条路。
    expect(browserCommandFor(chord("k"))).toBeNull();
    expect(browserCommandFor(chord("p"))).toBeNull();
    expect(browserCommandFor(chord("t"))).toBeNull();
    expect(browserCommandFor(chord("r", { shift: true }))).toBeNull();
  });

  it("四条都在表里，改一条要动这张表", () => {
    expect([...BROWSER_NODE_COMMANDS]).toEqual([
      "browser.reload",
      "browser.back",
      "browser.forward",
      "browser.focusAddress",
    ]);
  });
});
