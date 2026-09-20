import { describe, expect, it } from "vitest";

import {
  forwardedChord,
  guestKeyRoute,
  type GuestKeyInput,
} from "./guest-keys";

function key(k: string, modifiers: Partial<GuestKeyInput> = {}): GuestKeyInput {
  return {
    type: "keyDown",
    key: k,
    meta: false,
    control: false,
    shift: false,
    alt: false,
    ...modifiers,
  };
}

const MAC = "darwin";
const WIN = "win32";

describe("guestKeyRoute", () => {
  it("把 Armadra 的和弦送回宿主页面", () => {
    // 任务里点名的三条：guest 聚焦时它们以前在网页里石沉大海。
    for (const k of ["k", "p", "t"]) {
      expect(guestKeyRoute(key(k, { meta: true }), MAC)).toBe("host");
    }
  });

  it("浏览器节点自己的四条键也要回到宿主", () => {
    // 它们是 `commands.ts` 里 `scope: "browser"` 的命令，处理者在页面上。
    for (const k of ["r", "l", "[", "]"]) {
      expect(guestKeyRoute(key(k, { meta: true }), MAC)).toBe("host");
    }
  });

  it("⌘W 走的是壳的那条问答，不是重放", () => {
    expect(guestKeyRoute(key("w", { meta: true }), MAC)).toBe("intent");
    expect(guestKeyRoute(key("w", { control: true }), WIN)).toBe("intent");
  });

  it("⌘⇧W / ⌘⌥W 不是 ⌘W", () => {
    // 前者是「关闭所有窗口」，后者什么也不是；两条都不该被当成关窗意图。
    expect(guestKeyRoute(key("w", { meta: true, shift: true }), MAC)).toBe(
      "host",
    );
    expect(guestKeyRoute(key("w", { meta: true, alt: true }), MAC)).toBe(
      "host",
    );
  });

  it("网页自己的那几条一个都不抢", () => {
    const kept = [
      "c",
      "x",
      "v",
      "a",
      "z",
      "f",
      "g",
      "s",
      "0",
      "+",
      "-",
      "=",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ];
    for (const k of kept) {
      expect(guestKeyRoute(key(k, { meta: true }), MAC)).toBe("page");
    }
    // ⌘⇧Z（重做）与 ⌘Z 是同一条权利。
    expect(guestKeyRoute(key("z", { meta: true, shift: true }), MAC)).toBe(
      "page",
    );
  });

  it("⌘1 是标签键不是缩放键，所以转发", () => {
    expect(guestKeyRoute(key("1", { meta: true }), MAC)).toBe("host");
  });

  it("没有主修饰键的一律留给网页", () => {
    for (const k of ["a", "Escape", "Tab", "Enter", "ArrowDown", "F5"]) {
      expect(guestKeyRoute(key(k), MAC)).toBe("page");
      expect(guestKeyRoute(key(k, { shift: true }), MAC)).toBe("page");
    }
  });

  it("平台决定哪个是主修饰键", () => {
    // mac 上 Ctrl+K 是 Emacs 的「删到行尾」，绝不能当成 Armadra 的 ⌘K。
    expect(guestKeyRoute(key("k", { control: true }), MAC)).toBe("page");
    expect(guestKeyRoute(key("k", { meta: true }), WIN)).toBe("page");
    expect(guestKeyRoute(key("k", { control: true }), WIN)).toBe("host");
  });

  it("两个主修饰键一起按不属于任何一边", () => {
    expect(guestKeyRoute(key("k", { meta: true, control: true }), MAC)).toBe(
      "page",
    );
  });

  it("只看按下，不看抬起", () => {
    expect(
      guestKeyRoute({ ...key("k", { meta: true }), type: "keyUp" }, MAC),
    ).toBe("page");
  });
});

describe("forwardedChord", () => {
  it("带上 code：修饰键改过的 key 靠它匹配", () => {
    expect(
      forwardedChord(
        { ...key("K", { meta: true, shift: true }), code: "KeyK" },
        "node-1",
      ),
    ).toEqual({
      nodeId: "node-1",
      key: "K",
      code: "KeyK",
      meta: true,
      control: false,
      shift: true,
      alt: false,
    });
  });

  it("没有 code 时是空串，不是 undefined", () => {
    // 它要过一次 IPC 序列化；`undefined` 在那一侧会整个丢掉键名。
    expect(forwardedChord(key("k", { meta: true }), "n").code).toBe("");
  });
});
