import { describe, expect, it } from "vitest";
import {
  buildChangeTree,
  flattenFiles,
  insideRepository,
  type ChangeDirectoryNode,
  type ChangeInput,
  type RepositoryChanges,
} from "./build-change-tree";

const file = (
  path: string,
  overrides: Partial<ChangeInput> = {},
): ChangeInput => ({
  path,
  status: "M",
  staged: false,
  unstaged: true,
  ...overrides,
});

const repository = (
  overrides: Partial<RepositoryChanges> = {},
): RepositoryChanges => ({
  repositoryPath: ".",
  name: "project",
  files: [],
  conflicts: [],
  ...overrides,
});

const sectionOf = (
  tree: ReturnType<typeof buildChangeTree>,
  group: string,
  index = 0,
) => tree[index]!.sections.find((section) => section.group === group)!;

describe("buildChangeTree grouping", () => {
  it("keeps a file that is both staged and modified in two sections", () => {
    const tree = buildChangeTree(
      [
        repository({
          files: [file("src/a.ts", { staged: true, unstaged: true })],
        }),
      ],
      { layout: "flat" },
    );
    expect(sectionOf(tree, "staged").files.map((row) => row.path)).toEqual([
      "src/a.ts",
    ]);
    expect(sectionOf(tree, "staged").files[0]!.staged).toBe(true);
    expect(sectionOf(tree, "changes").files.map((row) => row.path)).toEqual([
      "src/a.ts",
    ]);
    expect(sectionOf(tree, "changes").files[0]!.staged).toBe(false);
  });

  it("puts untracked files in their own section, never in changes", () => {
    const tree = buildChangeTree(
      [repository({ files: [file("new.txt", { status: "?" })] })],
      { layout: "flat" },
    );
    expect(sectionOf(tree, "untracked").count).toBe(1);
    expect(sectionOf(tree, "changes").count).toBe(0);
  });

  it("moves a conflicted path into the conflict section only, unchecked", () => {
    // porcelain 把 `UU` 归一化成 `M` 且两列都非空，所以不先摘出去它会带着
    // 一个勾出现在「已暂存」里。
    const tree = buildChangeTree(
      [
        repository({
          files: [file("src/a.ts", { staged: true, unstaged: true })],
          conflicts: ["src/a.ts"],
        }),
      ],
      { layout: "flat" },
    );
    expect(sectionOf(tree, "conflicts").files).toHaveLength(1);
    expect(sectionOf(tree, "conflicts").files[0]!.staged).toBe(false);
    expect(sectionOf(tree, "staged").count).toBe(0);
    expect(sectionOf(tree, "changes").count).toBe(0);
  });

  it("lists a conflict that status never reported", () => {
    const tree = buildChangeTree([repository({ conflicts: ["gone.txt"] })], {
      layout: "flat",
    });
    expect(sectionOf(tree, "conflicts").files.map((row) => row.path)).toEqual([
      "gone.txt",
    ]);
  });

  it("keeps every repository, in the order it was given", () => {
    const tree = buildChangeTree(
      [
        repository({ repositoryPath: ".", files: [file("a.ts")] }),
        repository({
          repositoryPath: "packages/foo",
          name: "foo",
          files: [file("b.ts"), file("c.ts")],
        }),
      ],
      { layout: "flat" },
    );
    expect(tree.map((entry) => entry.repositoryPath)).toEqual([
      ".",
      "packages/foo",
    ]);
    expect(tree.map((entry) => entry.count)).toEqual([1, 2]);
  });

  it("gives rows from different repositories different identities", () => {
    const tree = buildChangeTree(
      [
        repository({ files: [file("src/a.ts")] }),
        repository({
          repositoryPath: "packages/foo",
          name: "foo",
          files: [file("src/a.ts")],
        }),
      ],
      { layout: "flat" },
    );
    const first = sectionOf(tree, "changes", 0).files[0]!;
    const second = sectionOf(tree, "changes", 1).files[0]!;
    expect(first.id).not.toBe(second.id);
  });
});

describe("buildChangeTree layout", () => {
  const files = [
    file("apps/web/src/a.ts"),
    file("apps/web/src/b.ts"),
    file("docs/readme.md"),
    file("root.txt"),
  ];

  it("collapses single-child directory chains and sorts directories first", () => {
    const tree = buildChangeTree([repository({ files })], { layout: "tree" });
    const nodes = sectionOf(tree, "changes").nodes;
    expect(nodes.map((node) => node.label)).toEqual([
      "apps/web/src",
      "docs",
      "root.txt",
    ]);
    const collapsed = nodes[0]! as ChangeDirectoryNode;
    expect(collapsed.path).toBe("apps/web/src");
    expect(collapsed.children.map((child) => child.label)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("flat layout shows the whole repository-relative path on one level", () => {
    const tree = buildChangeTree([repository({ files })], { layout: "flat" });
    const nodes = sectionOf(tree, "changes").nodes;
    expect(nodes.every((node) => node.kind === "file")).toBe(true);
    expect(nodes.map((node) => node.label)).toEqual([
      "apps/web/src/a.ts",
      "apps/web/src/b.ts",
      "docs/readme.md",
      "root.txt",
    ]);
  });

  it("both layouts describe the same set of files", () => {
    const asTree = buildChangeTree([repository({ files })], {
      layout: "tree",
    });
    const asFlat = buildChangeTree([repository({ files })], {
      layout: "flat",
    });
    expect(
      flattenFiles(sectionOf(asTree, "changes").nodes)
        .map((row) => row.path)
        .sort(),
    ).toEqual(
      flattenFiles(sectionOf(asFlat, "changes").nodes)
        .map((row) => row.path)
        .sort(),
    );
  });
});

describe("directory checkbox state", () => {
  it("is checked only when every descendant is staged, partial in between", () => {
    const tree = buildChangeTree(
      [
        repository({
          files: [
            file("src/a.ts", { staged: true, unstaged: false }),
            file("src/b.ts", { staged: true, unstaged: false }),
            file("docs/c.md", { staged: true, unstaged: false }),
          ],
        }),
      ],
      { layout: "tree" },
    );
    const staged = sectionOf(tree, "staged").nodes as ChangeDirectoryNode[];
    expect(
      staged.map((node) => [node.label, node.staged, node.partial]),
    ).toEqual([
      ["docs", true, false],
      ["src", true, false],
    ]);
    // 「变更」分区里同一批文件是未勾选的，目录也一样。
    const mixed = buildChangeTree(
      [
        repository({
          files: [
            file("src/a.ts", { staged: true, unstaged: true }),
            file("src/b.ts"),
          ],
        }),
      ],
      { layout: "tree" },
    );
    const changes = sectionOf(mixed, "changes")
      .nodes[0]! as ChangeDirectoryNode;
    expect(changes.staged).toBe(false);
    expect(changes.partial).toBe(false);
    expect(changes.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("carries every descendant path so one click stages the whole directory", () => {
    const tree = buildChangeTree(
      [
        repository({
          files: [file("apps/web/a.ts"), file("apps/host/b.go")],
        }),
      ],
      { layout: "tree" },
    );
    const directory = sectionOf(tree, "changes")
      .nodes[0]! as ChangeDirectoryNode;
    expect(directory.label).toBe("apps");
    expect(directory.files.sort()).toEqual(["apps/host/b.go", "apps/web/a.ts"]);
  });
});

describe("nested checkouts", () => {
  it("keeps a nested repository out of its parent's untracked section", () => {
    // Git 把一个嵌套仓库报成 `packages/foo/`：一整个未跟踪目录。在父仓库里勾
    // 上它就是把整个子仓库加进父仓库的索引。
    const tree = buildChangeTree(
      [
        repository({
          files: [
            file("packages/foo/", { status: "?", staged: false }),
            file("notes.txt", { status: "?", staged: false }),
          ],
          nested: ["packages/foo"],
        }),
      ],
      { layout: "flat" },
    );
    expect(sectionOf(tree, "untracked").files.map((row) => row.path)).toEqual([
      "notes.txt",
    ]);
  });

  it("names an untracked directory instead of showing an empty row", () => {
    const tree = buildChangeTree(
      [repository({ files: [file("build/", { status: "?" })] })],
      { layout: "tree" },
    );
    expect(sectionOf(tree, "untracked").files[0]!.label).toBe("build");
    expect(sectionOf(tree, "untracked").files[0]!.path).toBe("build");
  });

  it("reports where one checkout sits inside another", () => {
    expect(insideRepository(".", "packages/foo")).toBe("packages/foo");
    expect(insideRepository("packages/foo", "packages/foo/bar")).toBe("bar");
    expect(insideRepository("packages/foo", "packages/other")).toBeNull();
    expect(insideRepository("packages/foo", "packages/foo")).toBeNull();
    // 前缀相同但不是同一个目录：`packages/foobar` 不在 `packages/foo` 里。
    expect(insideRepository("packages/foo", "packages/foobar")).toBeNull();
  });
});

describe("rename", () => {
  it("keeps both ends when the source path is known", () => {
    const tree = buildChangeTree(
      [
        repository({
          files: [
            file("new/name.ts", {
              status: "R",
              staged: true,
              unstaged: false,
              originPath: "old/name.ts",
            }),
          ],
        }),
      ],
      { layout: "flat" },
    );
    const row = sectionOf(tree, "staged").files[0]!;
    expect(row.status).toBe("R");
    expect(row.originPath).toBe("old/name.ts");
  });

  it("reports no source when the runtime did not send one", () => {
    const tree = buildChangeTree(
      [repository({ files: [file("a.ts", { status: "R" })] })],
      { layout: "flat" },
    );
    expect(sectionOf(tree, "changes").files[0]!.originPath).toBeNull();
  });
});
