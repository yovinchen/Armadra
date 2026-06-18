import { describe, expect, it } from "vitest";
import { fuzzyScore, matchScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches everything on an empty query", () => {
    expect(fuzzyScore("新建任务节点", "")).toBe(0);
  });

  it("matches a subsequence, not just a substring", () => {
    expect(fuzzyScore("src/auth/login.ts", "slogin")).not.toBeNull();
    expect(fuzzyScore("src/auth/login.ts", "zzz")).toBeNull();
  });

  it("is case insensitive", () => {
    expect(fuzzyScore("Claude Code", "claude")).not.toBeNull();
    expect(fuzzyScore("claude code", "CODE")).not.toBeNull();
  });

  it("matches Chinese substrings without pinyin", () => {
    expect(fuzzyScore("一键整理画布", "整理")).not.toBeNull();
    expect(fuzzyScore("一键整理画布", "画面")).toBeNull();
  });

  it("scores contiguous prefixes above scattered matches", () => {
    const prefix = fuzzyScore("login handler", "log")!;
    const scattered = fuzzyScore("a long green log", "log")!;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("falls back to the hint at a lower weight", () => {
    const onLabel = matchScore({ label: "login.ts", hint: "docs" }, "login")!;
    const onHint = matchScore(
      { label: "readme", hint: "src/login.ts" },
      "login",
    )!;
    expect(onLabel).toBeGreaterThan(onHint);
    expect(matchScore({ label: "readme", hint: "docs" }, "login")).toBeNull();
  });
});
