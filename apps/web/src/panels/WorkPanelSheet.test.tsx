import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkPanelSheet } from "./WorkPanelSheet";

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
