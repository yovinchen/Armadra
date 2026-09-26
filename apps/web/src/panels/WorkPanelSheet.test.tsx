import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const compact = vi.hoisted(() => ({ value: false }));
vi.mock("../platform/layout", () => ({
  useCompactLayout: () => compact.value,
  isCompactLayout: () => compact.value,
}));

import { initialPanels } from "../store/canvas/internal";
import { useCanvasStore } from "../store/canvas-store";
import { WorkPanelSheet, rightPanelInset } from "./WorkPanelSheet";

/**
 * The docked panel must be carved out of the window-drag strip: its header
 * lives in the top 44px, and a real click there dragged the window instead
 * of pressing the close button.
 */
describe("WorkPanelSheet inside the desktop shell", () => {
  afterEach(() => {
    cleanup();
    delete (window as { armadra?: unknown }).armadra;
  });

  it("declares itself a no-drag region when the shell bridge is present", () => {
    (window as { armadra?: unknown }).armadra = {};
    render(
      <WorkPanelSheet panel="explorer" open onClose={() => {}} label="面板">
        <p>内容</p>
      </WorkPanelSheet>,
    );
    expect(
      screen
        .getByRole("dialog", { name: "面板" })
        .getAttribute("data-app-region"),
    ).toBe("no-drag");
  });

  it("leaves the attribute off in a plain browser", () => {
    render(
      <WorkPanelSheet panel="explorer" open onClose={() => {}} label="面板">
        <p>内容</p>
      </WorkPanelSheet>,
    );
    expect(
      screen
        .getByRole("dialog", { name: "面板" })
        .getAttribute("data-app-region"),
    ).toBeNull();
  });
});

/** §58：手机上的右侧抽屉铺满宽度，底边停在底部导航上方。 */
describe("WorkPanelSheet on a phone", () => {
  afterEach(() => {
    cleanup();
    compact.value = false;
    useCanvasStore.setState({ focusNodeId: null });
  });

  const dialog = () => screen.getByRole("dialog", { name: "面板" });

  it("keeps the drawer width on a wide window", () => {
    render(
      <WorkPanelSheet panel="explorer" open onClose={() => {}} label="面板">
        <p>内容</p>
      </WorkPanelSheet>,
    );
    expect(dialog().style.width).toBe("min(100vw, var(--drawer-w))");
    expect(dialog().style.bottom).toBe("");
  });

  it("fills the width and stops above the bottom navigation", () => {
    compact.value = true;
    render(
      <WorkPanelSheet panel="explorer" open onClose={() => {}} label="面板">
        <p>内容</p>
      </WorkPanelSheet>,
    );
    expect(dialog().style.width).toBe("100vw");
    expect(dialog().style.height).toBe("auto");
    expect(dialog().style.bottom).toContain("--mobile-nav-h");
  });

  it("takes the whole height when the focus page has hidden the navigation", () => {
    compact.value = true;
    useCanvasStore.setState({ focusNodeId: "n-1" });
    render(
      <WorkPanelSheet panel="resources" open onClose={() => {}} label="面板">
        <p>内容</p>
      </WorkPanelSheet>,
    );
    expect(dialog().style.width).toBe("100vw");
    expect(dialog().style.bottom).toBe("");
  });

  it("a maximized bottom window stops above the navigation too", () => {
    compact.value = true;
    render(
      <WorkPanelSheet
        panel="scm"
        side="bottom"
        maximized
        open
        onClose={() => {}}
        label="面板"
      >
        <p>内容</p>
      </WorkPanelSheet>,
    );
    expect(dialog().style.bottom).toContain("--mobile-nav-h");
    expect(dialog().style.height).toContain("100dvh -");
  });
});

describe("rightPanelInset", () => {
  it("is the drawer width, the pinned card plus its margin, or nothing", () => {
    expect(rightPanelInset(initialPanels)).toBeNull();
    expect(rightPanelInset({ ...initialPanels, explorer: "drawer" })).toBe(
      "min(100vw, var(--drawer-w))",
    );
    expect(rightPanelInset({ ...initialPanels, automation: "drawer" })).toBe(
      "min(100vw, var(--scm-w))",
    );
    expect(rightPanelInset({ ...initialPanels, explorer: "pinned" })).toBe(
      "calc(320px + 14px)",
    );
    // 底部停靠的窗口横向不占右边。
    expect(rightPanelInset({ ...initialPanels, scm: "bottom" })).toBeNull();
  });
});
