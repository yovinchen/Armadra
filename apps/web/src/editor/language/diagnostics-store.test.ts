import { beforeEach, describe, expect, it } from "vitest";

import {
  countDiagnostics,
  groupDiagnostics,
  severityOf,
  useDiagnosticsStore,
  type Diagnostic,
} from "./diagnostics-store";

function at(line: number, message: string, severity?: number): Diagnostic {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    severity,
    message,
  };
}

beforeEach(() => useDiagnosticsStore.setState({ byUri: {} }));

describe("workspace diagnostics", () => {
  it("treats an empty publish as 'this file is clean now'", () => {
    const store = useDiagnosticsStore.getState();
    store.publish("armadra:///a.py", [at(0, "bad")]);
    expect(Object.keys(useDiagnosticsStore.getState().byUri)).toEqual([
      "armadra:///a.py",
    ]);
    // 留一个空条目会让面板显示一个永远为 0 的文件行。
    store.publish("armadra:///a.py", []);
    expect(useDiagnosticsStore.getState().byUri).toEqual({});
  });

  it("clears only the uris it is told about, or everything", () => {
    const store = useDiagnosticsStore.getState();
    store.publish("armadra:///a.py", [at(0, "a")]);
    store.publish("armadra:///b.py", [at(0, "b")]);
    store.clear(["armadra:///a.py"]);
    expect(Object.keys(useDiagnosticsStore.getState().byUri)).toEqual([
      "armadra:///b.py",
    ]);
    store.clear();
    expect(useDiagnosticsStore.getState().byUri).toEqual({});
  });

  it("reads a missing severity as an error, the way LSP does", () => {
    expect(severityOf(at(0, "x"))).toBe("error");
    expect(severityOf(at(0, "x", 2))).toBe("warning");
    expect(severityOf(at(0, "x", 3))).toBe("info");
    expect(severityOf(at(0, "x", 4))).toBe("hint");
  });

  it("puts files with errors first and orders each file by severity then line", () => {
    const groups = groupDiagnostics({
      "armadra:///z.py": [at(5, "warn", 2), at(1, "boom", 1)],
      "armadra:///a.py": [at(3, "hint", 4), at(2, "note", 3)],
    });
    expect(groups.map((group) => group.uri)).toEqual([
      "armadra:///z.py",
      "armadra:///a.py",
    ]);
    expect(groups[0]!.diagnostics.map((entry) => entry.message)).toEqual([
      "boom",
      "warn",
    ]);
    expect(groups[0]!.errors).toBe(1);
    expect(groups[0]!.warnings).toBe(1);
  });

  it("counts errors and warnings across the workspace", () => {
    expect(
      countDiagnostics({
        "armadra:///a.py": [at(0, "e"), at(1, "w", 2)],
        "armadra:///b.py": [at(0, "e2"), at(1, "h", 4)],
      }),
    ).toEqual({ errors: 2, warnings: 1 });
  });
});
