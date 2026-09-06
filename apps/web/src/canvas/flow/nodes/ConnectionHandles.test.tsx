import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { renderFlow } from "@/canvas/test-support";
import { ConnectionHandles } from "./ConnectionHandles";

/**
 * 节点的连线端口（React Flow 计划 §2.5 / F06）。
 *
 * 重写自旧引擎的 `shapes/ConnectionHandles.test.tsx`（9 项）：那一版测的是
 * 「pointerdown 时切到箭头工具再放行事件」的那套手工起笔，整段被 React Flow
 * 的原生把手手势取代了。剩下要守住的是端口的形状与可达性。
 */

beforeAll(installDomPolyfills);
afterEach(cleanup);

function handles(container: HTMLElement) {
  return {
    sources: [
      ...container.querySelectorAll<HTMLElement>(
        '[data-slot="connection-handle"]',
      ),
    ],
    drop: container.querySelector<HTMLElement>('[data-slot="connection-drop"]'),
    anchor: container.querySelector<HTMLElement>(
      '[data-slot="connection-anchor"]',
    ),
  };
}

describe("起笔把手", () => {
  it("左右各一个 source 把手，命中区样式来自 `styles/nodes.css`", () => {
    const { container } = renderFlow(<ConnectionHandles />);
    const { sources } = handles(container);
    expect(sources.map((node) => node.dataset.side)).toEqual(["left", "right"]);
    for (const handle of sources) {
      expect(handle.classList.contains("node-connection-handle")).toBe(true);
      expect(handle.classList.contains("source")).toBe(true);
    }
  });

  it("把手只起笔不落点：线要落在节点体上，不是落在圆点上", () => {
    const { container } = renderFlow(<ConnectionHandles />);
    for (const handle of handles(container).sources) {
      expect(handle.classList.contains("connectablestart")).toBe(true);
      expect(handle.classList.contains("connectableend")).toBe(false);
    }
  });

  it("两个把手都有无障碍名字（键盘与读屏能分清进 / 出）", () => {
    const { container } = renderFlow(<ConnectionHandles />);
    const labels = handles(container).sources.map((handle) =>
      handle.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["接收上下文", "发出上下文"]);
  });
});

describe("落点", () => {
  it("铺满整个节点，而不是 6px 的圆点", () => {
    const { container } = renderFlow(<ConnectionHandles />);
    const drop = handles(container).drop!;
    expect(drop.style.inset).toBe("0px");
    expect(drop.style.width).toBe("100%");
    expect(drop.style.height).toBe("100%");
    expect(drop.classList.contains("target")).toBe(true);
  });

  it("没有连线在进行时不接指针事件（终端的点击照常）", () => {
    const { container } = renderFlow(<ConnectionHandles />);
    expect(handles(container).drop!.style.pointerEvents).toBe("none");
  });

  it("落点自己不能起笔", () => {
    const { container } = renderFlow(<ConnectionHandles />);
    expect(
      handles(container).drop!.classList.contains("connectablestart"),
    ).toBe(false);
  });
});

describe("分组（只有落点）", () => {
  it("不画左右圆点，但仍然可以作为一条连线的落点", () => {
    const { container } = renderFlow(<ConnectionHandles dropOnly />);
    const { sources, drop } = handles(container);
    expect(sources).toHaveLength(0);
    expect(drop).not.toBeNull();
    expect(drop!.classList.contains("connectable")).toBe(true);
  });

  it("补一个从不参与交互的 source 锚点，否则整条边都画不出来", () => {
    const { container } = renderFlow(<ConnectionHandles dropOnly />);
    const anchor = handles(container).anchor!;
    expect(anchor.classList.contains("source")).toBe(true);
    expect(anchor.style.pointerEvents).toBe("none");
    expect(anchor.classList.contains("connectablestart")).toBe(false);
    expect(anchor.classList.contains("connectableend")).toBe(false);
  });
});
