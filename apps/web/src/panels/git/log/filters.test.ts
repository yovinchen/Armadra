import { describe, expect, it } from "vitest";

import {
  storedGitPreferences,
  type GitPreferences,
} from "@/app/preferences/git";
import { refKey } from "./build-tree";
import { filterKey, logRequestFromPreferences, referenceOf } from "./filters";

const NOW = Date.parse("2026-09-07T10:00:00Z");

function preferences(overrides: Partial<GitPreferences> = {}): GitPreferences {
  return { ...storedGitPreferences(), ...overrides };
}

describe("工具栏筛选 → 请求", () => {
  it("什么都没选时默认整张图（所有分支）与页大小，别的一项都不发", () => {
    const request = logRequestFromPreferences(preferences(), { now: NOW });
    expect(request).toEqual({ refs: { kind: "all" }, limit: 100 });
  });

  it("关掉「显示所有分支」且没选分支时只问 HEAD", () => {
    const request = logRequestFromPreferences(
      preferences({ showAllBranches: false }),
      { now: NOW },
    );
    expect(request.refs).toEqual({ kind: "head" });
  });

  it("选中的分支变成 named，跨仓库的同名分支只发一次", () => {
    const request = logRequestFromPreferences(
      preferences({
        selectedRefs: [
          refKey(".", "main"),
          refKey("packages/foo", "main"),
          refKey(".", "feat/x"),
        ],
      }),
      { now: NOW },
    );
    expect(request.refs).toEqual({
      kind: "named",
      names: ["main", "feat/x"],
    });
  });

  it("选中的分支压过「显示所有分支」", () => {
    const request = logRequestFromPreferences(
      preferences({
        showAllBranches: true,
        selectedRefs: [refKey(".", "main")],
      }),
      { now: NOW },
    );
    expect(request.refs).toEqual({ kind: "named", names: ["main"] });
  });

  it("日期档位落成绝对时刻，自定义档直接用两个日期", () => {
    expect(
      logRequestFromPreferences(preferences({ dateRange: "week" }), {
        now: NOW,
      }).since,
    ).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
    const custom = logRequestFromPreferences(
      preferences({
        dateRange: "custom",
        since: "2026-01-01",
        until: "2026-02-01",
      }),
      { now: NOW },
    );
    expect(custom.since).toBe("2026-01-01");
    expect(custom.until).toBe("2026-02-01");
    // 不限日期时整项不出现：服务端的 zod 收的是 optional，`null` 会被拒。
    const any = logRequestFromPreferences(preferences({ dateRange: "any" }), {
      now: NOW,
    });
    expect("since" in any).toBe(false);
    expect("until" in any).toBe(false);
  });

  it("自定义档里空着的那一头也整项省略", () => {
    const request = logRequestFromPreferences(
      preferences({ dateRange: "custom", since: "2026-01-01", until: "" }),
      { now: NOW },
    );
    expect(request.since).toBe("2026-01-01");
    expect("until" in request).toBe(false);
  });

  it("搜索框的两个开关原样进请求；空搜索整块不发", () => {
    const request = logRequestFromPreferences(
      preferences({
        searchText: "fix\\(.*\\)",
        searchRegex: true,
        searchMatchCase: true,
      }),
      { now: NOW },
    );
    expect(request.text).toEqual({
      query: "fix\\(.*\\)",
      regex: true,
      matchCase: true,
    });
    expect(
      "text" in
        logRequestFromPreferences(preferences({ searchText: "   " }), {
          now: NOW,
        }),
    ).toBe(false);
  });

  it("作者、仓库与路径原样带上，空集合一律略去", () => {
    const request = logRequestFromPreferences(
      preferences({
        authors: ["ada@example.invalid"],
        repositories: ["packages/foo"],
        paths: ["apps/web"],
      }),
      { now: NOW },
    );
    expect(request.authors).toEqual(["ada@example.invalid"]);
    expect(request.repositories).toEqual(["packages/foo"]);
    expect(request.paths).toEqual(["apps/web"]);
    const empty = logRequestFromPreferences(preferences(), { now: NOW });
    expect("authors" in empty).toBe(false);
    expect("repositories" in empty).toBe(false);
    expect("paths" in empty).toBe(false);
  });

  it("游标只在给了的时候出现", () => {
    expect(
      logRequestFromPreferences(preferences(), { now: NOW, cursor: "abc" })
        .cursor,
    ).toBe("abc");
    expect(
      "cursor" in
        logRequestFromPreferences(preferences(), { now: NOW, cursor: null }),
    ).toBe(false);
  });
});

describe("筛选键", () => {
  it("条件变了就是另一份列表", () => {
    expect(filterKey(preferences())).not.toBe(
      filterKey(preferences({ authors: ["ada@example.invalid"] })),
    );
  });

  it("同一个相对日期档位不会因为时间流逝而变", () => {
    expect(filterKey(preferences({ dateRange: "week" }))).toBe(
      filterKey(preferences({ dateRange: "week" })),
    );
  });
});

describe("引用键", () => {
  it("拆出引用名，分支名里的空格不影响仓库路径那一段", () => {
    expect(referenceOf(refKey("packages/foo", "feat/x"))).toBe("feat/x");
    expect(referenceOf(refKey("with space/repo", "feat/x"))).toBe("feat/x");
    expect(referenceOf("HEAD")).toBe("HEAD");
  });
});
