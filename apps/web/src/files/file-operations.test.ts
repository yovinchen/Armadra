import { beforeEach, describe, expect, it } from "vitest";
import type { BoardDocument, CanvasNode } from "@armadra/shared";

import { useCanvasStore } from "../store/canvas-store";
import {
  basename,
  followRename,
  renamedNode,
  rewritePath,
} from "./file-operations";

const timestamp = "2026-09-05T00:00:00.000Z";
const boardId = "019ff7d1-7419-74df-89e2-b1619d36ea7d";

function node(id: string, data: CanvasNode["data"], title: string): CanvasNode {
  return {
    id,
    boardId,
    type: data.kind,
    title,
    color: "#0a84ff",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as CanvasNode;
}

function seed(nodes: CanvasNode[]) {
  useCanvasStore.setState({
    document: {
      board: {
        id: boardId,
        workspaceId: "w1",
        name: "board",
        sortOrder: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      nodes,
      edges: [],
    } as unknown as BoardDocument,
  });
}

describe("rewritePath", () => {
  it("follows the renamed file and everything under a renamed folder", () => {
    expect(rewritePath("a.txt", "a.txt", "b.txt")).toBe("b.txt");
    expect(rewritePath("src/a.ts", "src", "lib")).toBe("lib/a.ts");
    expect(rewritePath("src/deep/a.ts", "src", "lib")).toBe("lib/deep/a.ts");
  });

  it("does not touch a sibling that merely shares a prefix", () => {
    expect(rewritePath("srcery/a.ts", "src", "lib")).toBeNull();
    expect(rewritePath("other.txt", "a.txt", "b.txt")).toBeNull();
  });
});

describe("renamedNode", () => {
  it("only rewrites nodes that point at a file", () => {
    const editor = node("1", { kind: "editor", path: "src/a.ts" }, "a.ts");
    expect(renamedNode(editor, "src", "lib")).toEqual({
      path: "lib/a.ts",
      title: "a.ts",
    });
    const sticky = node("2", { kind: "sticky", content: "" }, "note");
    expect(renamedNode(sticky, "src", "lib")).toBeNull();
  });
});

describe("followRename", () => {
  beforeEach(() => {
    seed([
      node(
        "00000000-0000-4000-8000-000000000001",
        { kind: "editor", path: "src/a.ts" },
        "a.ts",
      ),
      node(
        "00000000-0000-4000-8000-000000000002",
        { kind: "files", path: "src" },
        "src",
      ),
      node(
        "00000000-0000-4000-8000-000000000003",
        { kind: "editor", path: "other.ts" },
        "renamed by hand",
      ),
    ]);
  });

  it("moves editors and file browsers with the folder they showed", () => {
    expect(followRename("src", "lib")).toBe(2);
    const nodes = useCanvasStore.getState().document!.nodes;
    const paths = nodes.map((entry) =>
      entry.data.kind === "editor" || entry.data.kind === "files"
        ? entry.data.path
        : null,
    );
    expect(paths).toEqual(["lib/a.ts", "lib", "other.ts"]);
    expect(nodes[0]!.title).toBe("a.ts");
    expect(nodes[1]!.title).toBe("lib");
  });

  it("keeps a title the user chose instead of the file name", () => {
    followRename("other.ts", "renamed.ts");
    const changed = useCanvasStore
      .getState()
      .document!.nodes.find(
        (entry) => entry.id === "00000000-0000-4000-8000-000000000003",
      )!;
    expect(changed.data.kind === "editor" && changed.data.path).toBe(
      "renamed.ts",
    );
    expect(changed.title).toBe("renamed by hand");
  });

  it("leaves everything alone when nothing matches", () => {
    expect(followRename("nothing", "else")).toBe(0);
  });
});

describe("basename", () => {
  it("takes the last segment", () => {
    expect(basename("a/b/c.ts")).toBe("c.ts");
    expect(basename("c.ts")).toBe("c.ts");
    expect(basename("a/b/")).toBe("b");
  });
});
