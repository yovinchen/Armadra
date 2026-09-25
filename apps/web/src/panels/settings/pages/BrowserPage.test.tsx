import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as renderPlain,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { usePreferencesStore } from "../../../app/preferences-store";
import { visibleSettingsSections } from "../nav";
import { BrowserPage } from "./BrowserPage";
import {
  browserHistory,
  recordBrowserHistory,
  resetBrowserHistoryCache,
} from "@/nodes/browser/history";

function render(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["workspaces"], [{ id: "ws-1" }]);
  return renderPlain(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
}

/**
 * 设置 → 浏览器（复查 §5.2「设置页的隐藏回收开关」）。
 *
 * 这一页的三项过去是三个硬编码常量，所以这里钉的是「改了真的存下去」，
 * 以及「壳不在时这一页根本不出现」——一页永远无效的设置比不列更糟。
 */

beforeEach(() => {
  usePreferencesStore.setState({
    browser: {
      discard: true,
      discardMinutes: 5,
      backgroundMax: 8,
      startPage: "",
    },
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).armadra;
});

describe("设置 → 浏览器", () => {
  it("回收开关默认开，关掉之后偏好里就是关的", () => {
    render(<BrowserPage />);
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("data-state")).toBe("checked");

    fireEvent.click(toggle);
    expect(usePreferencesStore.getState().browser.discard).toBe(false);
  });

  it("分钟数与后台上限写进偏好，越界的值被收进范围", () => {
    render(<BrowserPage />);
    const minutes = screen.getByLabelText("隐藏多少分钟后回收");
    fireEvent.change(minutes, { target: { value: "20" } });
    expect(usePreferencesStore.getState().browser.discardMinutes).toBe(20);

    // 数字框里能打出任何东西：超上限的收到 60，负数收到 1。
    fireEvent.change(minutes, { target: { value: "900" } });
    expect(usePreferencesStore.getState().browser.discardMinutes).toBe(60);
    fireEvent.change(minutes, { target: { value: "-4" } });
    expect(usePreferencesStore.getState().browser.discardMinutes).toBe(1);

    const max = screen.getByLabelText("后台页面上限");
    fireEvent.change(max, { target: { value: "2" } });
    expect(usePreferencesStore.getState().browser.backgroundMax).toBe(2);
    fireEvent.change(max, { target: { value: "99" } });
    expect(usePreferencesStore.getState().browser.backgroundMax).toBe(16);
  });
});

describe("起始页与清理浏览数据", () => {
  it("起始页按地址栏的规则补全后存进偏好，清空就回到默认", () => {
    render(<BrowserPage />);
    const input = screen.getByLabelText("新节点起始页");
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.blur(input);
    expect(usePreferencesStore.getState().browser.startPage).toBe(
      "https://example.com",
    );
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(usePreferencesStore.getState().browser.startPage).toBe("");
  });

  it("确认之后经壳清掉 partition，并清掉地址历史", async () => {
    const clearData = vi.fn().mockResolvedValue({ ok: true, cleared: 2 });
    (window as unknown as Record<string, unknown>).armadra = {
      browser: { clearData },
    };
    resetBrowserHistoryCache();
    recordBrowserHistory("ws-1", "https://example.com/");
    render(<BrowserPage />);
    fireEvent.click(screen.getByRole("button", { name: "清理" }));
    // 确认框里的那一个。
    const buttons = await screen.findAllByRole("button", { name: "清理" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(clearData).toHaveBeenCalledWith({ workspaceIds: ["ws-1"] }),
    );
    expect(browserHistory("ws-1")).toEqual([]);
  });
});

describe("这一页什么时候出现", () => {
  it("壳不在时不列这一行", () => {
    expect(
      visibleSettingsSections().some((section) => section.id === "browser"),
    ).toBe(false);
  });

  it("壳在时和终端排在同一组里", () => {
    (window as unknown as Record<string, unknown>).armadra = {};
    const ids = visibleSettingsSections().map((section) => section.id);
    expect(ids).toContain("browser");
    expect(ids.indexOf("browser")).toBe(ids.indexOf("terminal") + 1);
  });
});
