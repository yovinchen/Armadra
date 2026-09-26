import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";

import { WebviewGuest } from "./WebviewGuest";
import { newTab } from "./webview-tabs";

/**
 * 关标签页时的 `Invalid guestInstanceId`（§52.4 → §58）。
 *
 * jsdom 里没有 Electron，`webview` 也不是合法的自定义元素名（Electron 走的是
 * 内部开的后门），所以这里在 `removeChild` 上补出真机的那一段：元素离开文档
 * 之后、`removeChild` 返回之前，同步把 `disconnectedCallback` 抛的那句话按
 * 浏览器「报告异常」的规矩派发成 window 上一个可取消的 `error` 事件，没被取消
 * 才打到控制台。顺序与真机一致（`./guest-teardown` 的注释写了来龙去脉）。
 */

let throwOnDisconnect = true;
let reported: string[] = [];

beforeAll(() => {
  const removeChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T) {
    const removed = removeChild.call(this, child) as T;
    const guests =
      child instanceof Element
        ? (child.localName === "webview" ? 1 : 0) +
          child.querySelectorAll("webview").length
        : 0;
    for (let guest = 0; guest < guests; guest += 1) {
      if (!throwOnDisconnect) continue;
      const error = new Error("Invalid guestInstanceId: 7");
      const event = new ErrorEvent("error", {
        error,
        message: `Uncaught Error: ${error.message}`,
        cancelable: true,
      });
      if (window.dispatchEvent(event)) reported.push(event.message);
    }
    return removed;
  };
});

afterEach(() => {
  cleanup();
  throwOnDisconnect = true;
  reported = [];
});

/** 收集这一段里派发到 window 上的 error 事件，派发结束后再看有没有被拦下。 */
function collectErrors(): { events: ErrorEvent[]; stop: () => void } {
  const events: ErrorEvent[] = [];
  const listen = (event: ErrorEvent) => events.push(event);
  window.addEventListener("error", listen);
  return { events, stop: () => window.removeEventListener("error", listen) };
}

function Tabs({ open }: { open: boolean }) {
  const tab = React.useMemo(() => newTab("https://example.test/"), []);
  return open ? (
    <WebviewGuest
      nodeId="b1"
      zoom={1}
      tab={tab}
      partition="persist:test"
      hidden={false}
      ghost={false}
      driven={false}
      onElement={() => {}}
      onPatch={() => {}}
      onNavigate={() => {}}
      onOpenTab={() => {}}
    />
  ) : null;
}

describe("卸载 <webview>", () => {
  it("关掉标签时 Electron 抛的那一句不再作为未捕获错误报出", () => {
    const { rerender } = render(<Tabs open />);
    expect(document.querySelector("webview")).not.toBeNull();
    const errors = collectErrors();
    act(() => rerender(<Tabs open={false} />));
    errors.stop();
    expect(document.querySelector("webview")).toBeNull();
    expect(errors.events.map((event) => event.error?.message)).toEqual([
      "Invalid guestInstanceId: 7",
    ]);
    expect(errors.events.every((event) => event.defaultPrevented)).toBe(true);
    expect(reported).toEqual([]);
  });

  it("只认卸载那一刻：窗口之外的同一句话照常报", async () => {
    const { rerender } = render(<Tabs open />);
    act(() => rerender(<Tabs open={false} />));
    await Promise.resolve();
    const errors = collectErrors();
    const stray = new ErrorEvent("error", {
      error: new Error("Invalid guestInstanceId: 9"),
      message: "Uncaught Error: Invalid guestInstanceId: 9",
      cancelable: true,
    });
    window.dispatchEvent(stray);
    errors.stop();
    expect(stray.defaultPrevented).toBe(false);
  });

  it("卸载那一刻的别的错误照常报", () => {
    throwOnDisconnect = false;
    const { rerender } = render(<Tabs open />);
    const errors = collectErrors();
    let other: ErrorEvent | undefined;
    act(() => {
      rerender(<Tabs open={false} />);
      other = new ErrorEvent("error", {
        error: new Error("something else"),
        message: "Uncaught Error: something else",
        cancelable: true,
      });
      window.dispatchEvent(other);
    });
    errors.stop();
    expect(other?.defaultPrevented).toBe(false);
  });
});
