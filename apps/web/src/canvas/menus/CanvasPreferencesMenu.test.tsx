import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DropdownMenu } from "@/ui/dropdown-menu";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import {
  storedWhiteboardPreferences,
  usePreferencesStore,
} from "@/app/preferences-store";
import {
  CANVAS_PREFERENCE_TOGGLES,
  CanvasPreferencesMenu,
} from "./CanvasPreferencesMenu";

/**
 * 画布偏好菜单（React Flow 计划 F31 / §2.10）。
 *
 * 换引擎删了四项（调试面板、增强辅助、缩放方向反转、手绘 / 整洁风格档），
 * 所以这里断言两件事：**删掉的键一个都不在**，留下的每一项改了就落进
 * `preferences-store`（唯一真相，`flow-options` 与设置页读的是同一份）。
 */

installDomPolyfills();
afterEach(cleanup);

/** 展开菜单：Radix 的 `<DropdownMenuContent>` 只有 open 时才挂进 DOM。 */
function open() {
  return render(
    <TestProviders>
      <DropdownMenu open>
        <CanvasPreferencesMenu />
      </DropdownMenu>
    </TestProviders>,
  );
}

describe("CanvasPreferencesMenu", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ whiteboard: storedWhiteboardPreferences() });
  });

  it("勾选组是八项，删掉的四项一个都不在", () => {
    const keys = CANVAS_PREFERENCE_TOGGLES.map((toggle) => toggle.key);
    expect(keys).toEqual([
      "snap",
      "toolLock",
      "grid",
      "wrap",
      "focus",
      "edgeScroll",
      "dynamicSize",
      "pasteAtCursor",
      "animation",
    ]);
    for (const gone of ["debug", "enhancedA11y", "zoomInverted", "style"]) {
      expect(keys).not.toContain(gone);
    }
  });

  it("勾一项就写进偏好，且菜单不收起（一次常要改好几项）", () => {
    open();
    const grid = screen.getByRole("menuitemcheckbox", { name: /显示网格/ });
    expect(grid.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(grid);
    expect(usePreferencesStore.getState().whiteboard.grid).toBe(false);
    expect(
      screen.getByRole("menuitemcheckbox", { name: /显示网格/ }),
    ).toBeTruthy();
  });

  it("输入设备是单选，选完写进 `inputMode`", () => {
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /输入设备/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "鼠标" }));
    expect(usePreferencesStore.getState().whiteboard.inputMode).toBe("mouse");
  });

  it("不再有辅助功能子菜单与缩放方向反转项", () => {
    open();
    expect(screen.queryByText("辅助功能")).toBeNull();
    expect(screen.queryByText("缩放方向反转")).toBeNull();
    expect(screen.queryByText("调试模式")).toBeNull();
    // 动画从子菜单挪到了勾选组里，仍然在。
    expect(screen.getByRole("menuitemcheckbox", { name: /动画/ })).toBeTruthy();
  });
});
