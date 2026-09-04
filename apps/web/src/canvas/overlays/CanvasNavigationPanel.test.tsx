import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TestProviders } from "@/app/test-harness";
import { useMinimapPreferences } from "@/app/minimap-preferences";
import { usePreferencesStore } from "@/app/preferences-store";
import { CanvasNavigationPanel } from "./CanvasNavigationPanel";

vi.mock("./StatusMinimap", () => ({
  StatusMinimap: () => <canvas role="img" aria-label="缩略图" />,
}));
const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  storage.setItem.mockClear();
  usePreferencesStore.setState({ locale: "zh-CN" });
  useMinimapPreferences.getState().setCollapsed(false);
});

it("keeps an accessible restore control after collapsing and remembers the choice", () => {
  render(
    <TestProviders>
      <CanvasNavigationPanel />
    </TestProviders>,
  );
  expect(screen.getByRole("img", { name: "缩略图" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起缩略图" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "展开缩略图" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(storage.setItem).toHaveBeenLastCalledWith(
    "armadra.minimapCollapsed",
    "true",
  );
  cleanup();
  render(
    <TestProviders>
      <CanvasNavigationPanel />
    </TestProviders>,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开缩略图" }));
  expect(screen.getByRole("img", { name: "缩略图" })).toBeTruthy();
});
