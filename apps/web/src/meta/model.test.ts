import { describe, expect, it } from "vitest";

import { MAX_LABELS, normaliseLabels } from "./model";

describe("标签归一", () => {
  it("去空白、去重、限长", () => {
    expect(normaliseLabels([" a ", "a", "", "b"])).toEqual(["a", "b"]);
    expect(normaliseLabels(["x".repeat(40)])[0]).toHaveLength(24);
  });

  it("最多保留 MAX_LABELS 个", () => {
    const many = Array.from({ length: MAX_LABELS + 3 }, (_, i) => `l${i}`);
    expect(normaliseLabels(many)).toHaveLength(MAX_LABELS);
  });
});
