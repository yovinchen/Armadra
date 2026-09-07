import { describe, expect, it } from "vitest";
import type { GitCommitFile } from "@armadra/shared";

import { buildFileRows, splitRename } from "./file-tree";

const file = (path: string, status = "M"): GitCommitFile => ({
  status,
  path,
  additions: 1,
  deletions: 0,
});

describe("变更文件树", () => {
  it("平铺时每个文件一行，路径完整", () => {
    const rows = buildFileRows([file("apps/web/src/a.ts")], true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "file",
      label: "apps/web/src/a.ts",
      depth: 0,
    });
  });

  it("只有一条路可走的目录段合并成一行", () => {
    const rows = buildFileRows(
      [file("apps/web/src/a.ts"), file("apps/web/src/b.ts")],
      false,
    );
    const directories = rows.filter((row) => row.kind === "directory");
    expect(directories).toHaveLength(1);
    expect(directories[0]!.label).toBe("apps/web/src");
    expect(directories[0]!.count).toBe(2);
    expect(
      rows.filter((row) => row.kind === "file").map((row) => row.label),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("分叉的地方才多出一层", () => {
    const rows = buildFileRows(
      [file("apps/web/a.ts"), file("apps/host/b.go")],
      false,
    );
    const directories = rows
      .filter((row) => row.kind === "directory")
      .map((row) => `${row.depth}:${row.label}`);
    expect(directories).toEqual(["0:apps", "1:host", "1:web"]);
  });

  it("文件行的完整路径带上它的目录前缀", () => {
    const rows = buildFileRows([file("apps/web/a.ts")], false);
    const entry = rows.find((row) => row.kind === "file")!;
    expect(entry.path).toBe("apps/web/a.ts");
    expect(entry.label).toBe("a.ts");
  });

  it("重命名的两端都留着", () => {
    expect(splitRename("old/a.ts -> new/b.ts")).toEqual({
      path: "new/b.ts",
      renamedFrom: "old/a.ts",
    });
    const rows = buildFileRows([file("old/a.ts -> new/b.ts", "R")], true);
    expect(rows[0]!.label).toBe("new/b.ts");
    expect(rows[0]!.renamedFrom).toBe("old/a.ts");
  });

  it("根目录下的文件不生出目录行", () => {
    const rows = buildFileRows([file("README.md")], false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("file");
  });
});
