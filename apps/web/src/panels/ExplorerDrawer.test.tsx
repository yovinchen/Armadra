import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferencesStore } from "../app/preferences-store";
import { TestProviders, installDomPolyfills } from "../app/test-harness";
import { ExplorerDrawer } from "./ExplorerDrawer";

vi.mock("./FileTree", () => ({
  FileTree: () => <button draggable>file fixture</button>,
}));
installDomPolyfills();
beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.getState().setPanel("explorer", "drawer");
});
afterEach(() => {
  cleanup();
  useCanvasStore.getState().setPanel("explorer", "closed");
});

function view() {
  return render(
    <TestProviders>
      <button>canvas target</button>
      <ExplorerDrawer />
    </TestProviders>,
  );
}

describe("ExplorerDrawer canvas interaction", () => {
  it("leaves canvas input and keyboard focus reachable", async () => {
    view();
    await screen.findByRole("dialog");
    const target = screen.getByRole("button", { name: "canvas target" });
    expect(target.closest('[aria-hidden="true"]')).toBeNull();
    expect(getComputedStyle(document.body).pointerEvents).not.toBe("none");
    // Radix installs outside-pointer detection on the next event-loop tick.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(target);
    act(() => target.focus());
    expect(document.activeElement).toBe(target);
    expect(getComputedStyle(document.body).pointerEvents).not.toBe("none");
  });

  it("keeps pin/unpin and explicit close usable", async () => {
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Pin" }));
    expect(useCanvasStore.getState().panels.explorer).toBe("pinned");
    expect(
      screen.getByRole("complementary", { name: "Explorer" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
    expect(useCanvasStore.getState().panels.explorer).toBe("drawer");
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(useCanvasStore.getState().panels.explorer).toBe("closed");
    expect(getComputedStyle(document.body).pointerEvents).not.toBe("none");
  });
});
