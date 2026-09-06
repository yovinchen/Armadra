import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_PREFERENCE_TOGGLES,
  CanvasPreferencesMenu,
} from "./CanvasPreferencesMenu";
import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { messages } from "@/i18n";
import { DropdownMenu } from "@/ui/dropdown-menu";

/**
 * 画布偏好菜单（2026-09-05 用户反馈）。
 *
 * 只验一件事：**勾选状态来自 store**。真正推给 tldraw 的那一段是
 * `use-tldraw-preferences` 的映射函数，那边单独有测。
 */

installDomPolyfills();

function renderMenu() {
  render(
    <TestProviders>
      <DropdownMenu open>
        <CanvasPreferencesMenu />
      </DropdownMenu>
    </TestProviders>,
  );
}

/**
 * 按文案取一条勾选项。
 *
 * 不能用 `getByRole(..., { name })`：可访问名把右边的键位提示也算进去，
 * 「工具锁定」那条的名字其实是「工具锁定 Q」。子菜单默认不展开，所以
 * 页面上的 `menuitemcheckbox` 就是这九条。
 */
function itemFor(labelKey: string): HTMLElement {
  const label = messages["zh-CN"][labelKey];
  const item = screen
    .getAllByRole("menuitemcheckbox")
    .find((element) =>
      [...element.querySelectorAll("span")].some(
        (span) => span.textContent === label,
      ),
    );
  if (!item) throw new Error(labelKey);
  return item;
}

const DEFAULTS = usePreferencesStore.getState().whiteboard;

describe("画布偏好菜单", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ whiteboard: { ...DEFAULTS } });
  });

  afterEach(cleanup);

  it("九个勾选项按 tldraw 偏好子菜单的顺序排", () => {
    expect(CANVAS_PREFERENCE_TOGGLES.map((toggle) => toggle.key)).toEqual([
      "snap",
      "toolLock",
      "grid",
      "wrap",
      "focus",
      "edgeScroll",
      "dynamicSize",
      "pasteAtCursor",
      "debug",
    ]);
  });

  it("勾选状态来自 store", () => {
    usePreferencesStore.setState({
      whiteboard: { ...DEFAULTS, snap: true, grid: false, debug: true },
    });
    renderMenu();

    expect(itemFor("wb.snap").getAttribute("aria-checked")).toBe("true");
    expect(itemFor("wb.grid").getAttribute("aria-checked")).toBe("false");
    expect(itemFor("wb.debug").getAttribute("aria-checked")).toBe("true");
    expect(itemFor("wb.wrap").getAttribute("aria-checked")).toBe("false");
  });

  it("点一下写回 store（菜单不收起，可以连着改）", () => {
    renderMenu();
    itemFor("wb.snap").click();
    expect(usePreferencesStore.getState().whiteboard.snap).toBe(true);

    itemFor("wb.pasteAtCursor").click();
    expect(usePreferencesStore.getState().whiteboard.pasteAtCursor).toBe(true);
  });

  it("绑了键的三条才显示键位提示", () => {
    renderMenu();
    // Q / ⌘' / ⌘. 来自 `keybindings.ts`，不是写死在菜单里的。
    const bound = CANVAS_PREFERENCE_TOGGLES.filter((toggle) => toggle.command);
    expect(bound.map((toggle) => toggle.key)).toEqual([
      "toolLock",
      "grid",
      "focus",
    ]);
    for (const toggle of CANVAS_PREFERENCE_TOGGLES) {
      const shortcut = itemFor(toggle.labelKey).querySelector(
        '[data-slot="dropdown-menu-shortcut"]',
      );
      expect(Boolean(shortcut), toggle.key).toBe(Boolean(toggle.command));
    }
  });
});
