import { describe, expect, it } from "vitest";

import { absolutePath } from "./use-file-actions";

describe("absolutePath", () => {
  it("joins with the separator the root uses", () => {
    expect(absolutePath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(absolutePath("/repo/", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(absolutePath("C:\\work\\repo", "src/a.ts")).toBe(
      "C:\\work\\repo\\src\\a.ts",
    );
    expect(absolutePath("\\\\server\\share", "a.ts")).toBe(
      "\\\\server\\share\\a.ts",
    );
  });

  it("answers the root itself for `.`", () => {
    expect(absolutePath("/repo", ".")).toBe("/repo");
    expect(absolutePath("/", ".")).toBe("/");
  });
});
