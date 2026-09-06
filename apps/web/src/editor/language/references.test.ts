import { describe, expect, it } from "vitest";

import { groupLocations } from "./references";

const at = (line: number, character = 0) => ({
  start: { line, character },
  end: { line, character: character + 1 },
});

describe("groupLocations", () => {
  it("groups by file and orders each file by position", () => {
    const { groups } = groupLocations([
      { uri: "armadra:///src/b.ts", range: at(9) },
      { uri: "armadra:///src/a.ts", range: at(4) },
      { uri: "armadra:///src/a.ts", range: at(1) },
    ]);
    expect(groups.map((group) => group.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(groups[0]!.locations.map((location) => location.line)).toEqual([
      1, 4,
    ]);
  });

  // 工作空间之外的位置只有一个不透明 id：既没有路径也打不开。列在表里就是
  // 一堆点不动的行，所以只报数量。
  it("counts locations outside the workspace instead of listing them", () => {
    const { groups, external } = groupLocations([
      { uri: "armadra:///src/a.ts", range: at(0) },
      { uri: "armadra-external:///9f2c1ab4", range: at(0) },
    ]);
    expect(groups).toHaveLength(1);
    expect(external).toBe(1);
  });

  // 规范允许 server 回 `LocationLink`，字段名完全不同；接不住就是一个空面板。
  it("reads a LocationLink as well as a Location", () => {
    const { groups } = groupLocations([
      {
        targetUri: "armadra:///src/a.ts",
        targetSelectionRange: at(7),
        targetRange: at(6),
      },
    ]);
    expect(groups[0]?.path).toBe("src/a.ts");
    // `targetSelectionRange` 是符号本身，`targetRange` 是包含它的整块。
    expect(groups[0]?.locations[0]?.line).toBe(7);
  });
});
