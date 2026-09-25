import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RECENT_FILES,
  parseLocationQuery,
  recentFiles,
  rememberRecentFile,
} from "./recent-files";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("recent files", () => {
  it("keeps the latest first, once each, per workspace, and bounded", () => {
    rememberRecentFile("w1", "a.ts");
    rememberRecentFile("w1", "b.ts");
    rememberRecentFile("w1", "a.ts");
    rememberRecentFile("w2", "c.ts");
    expect(recentFiles("w1")).toEqual(["a.ts", "b.ts"]);
    expect(recentFiles("w2")).toEqual(["c.ts"]);

    for (let index = 0; index < MAX_RECENT_FILES + 5; index += 1)
      rememberRecentFile("w1", `f${index}.ts`);
    expect(recentFiles("w1")).toHaveLength(MAX_RECENT_FILES);
  });

  it("ignores whatever else is stored under the key", () => {
    localStorage.setItem("armadra.recentFiles.w1", "{not json");
    expect(recentFiles("w1")).toEqual([]);
    localStorage.setItem("armadra.recentFiles.w1", '["a.ts", 3, null]');
    expect(recentFiles("w1")).toEqual(["a.ts"]);
  });
});

describe("parseLocationQuery", () => {
  it("reads path, line and column", () => {
    expect(parseLocationQuery("src/a.ts:12:4")).toEqual({
      path: "src/a.ts",
      line: 12,
      column: 4,
    });
    expect(parseLocationQuery("src/a.ts:12")).toEqual({
      path: "src/a.ts",
      line: 12,
    });
    expect(parseLocationQuery(":7")).toEqual({ path: "", line: 7 });
  });

  it("leaves plain names and non-positions alone", () => {
    expect(parseLocationQuery("client")).toBeNull();
    expect(parseLocationQuery(":")).toBeNull();
    expect(parseLocationQuery("a.ts:0")).toBeNull();
    expect(parseLocationQuery("a.ts:3:0")).toBeNull();
  });
});
