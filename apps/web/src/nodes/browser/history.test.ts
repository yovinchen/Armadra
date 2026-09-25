import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HISTORY_LIMIT,
  browserHistory,
  clearAllBrowserHistory,
  clearBrowserHistory,
  recordBrowserHistory,
  resetBrowserHistoryCache,
} from "./history";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  clearAllBrowserHistory();
  resetBrowserHistoryCache();
});

describe("项目内浏览历史", () => {
  it("最近的在前、去重，只记 http(s)", () => {
    recordBrowserHistory("a", "https://one.test/");
    recordBrowserHistory("a", "https://two.test/");
    recordBrowserHistory("a", "https://one.test/");
    recordBrowserHistory("a", "about:blank");
    recordBrowserHistory("a", "file:///etc/passwd");
    expect(browserHistory("a")).toEqual([
      "https://one.test/",
      "https://two.test/",
    ]);
  });

  it("按工作空间分开，重读存储后还在", () => {
    recordBrowserHistory("a", "https://a.test/");
    recordBrowserHistory("b", "https://b.test/");
    resetBrowserHistoryCache();
    expect(browserHistory("a")).toEqual(["https://a.test/"]);
    expect(browserHistory("b")).toEqual(["https://b.test/"]);
    clearBrowserHistory("a");
    expect(browserHistory("a")).toEqual([]);
    expect(browserHistory("b")).toEqual(["https://b.test/"]);
  });

  it("有上限", () => {
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      recordBrowserHistory("a", `https://site${index}.test/`);
    }
    expect(browserHistory("a")).toHaveLength(HISTORY_LIMIT);
    expect(browserHistory("a")[0]).toBe(
      `https://site${HISTORY_LIMIT + 4}.test/`,
    );
  });

  it("清理浏览数据清掉所有工作空间的历史", () => {
    recordBrowserHistory("a", "https://a.test/");
    recordBrowserHistory("b", "https://b.test/");
    clearAllBrowserHistory();
    resetBrowserHistoryCache();
    expect(browserHistory("a")).toEqual([]);
    expect(browserHistory("b")).toEqual([]);
  });
});
