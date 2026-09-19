import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { GitCommitRecord } from "@armadra/shared";
import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { CommitGraphLanes, commitGraph, refBadges } from "./CommitGraph";

installDomPolyfills();

const oid = (char: string) => char.repeat(40);
const a = oid("a");
const b = oid("b");
const c = oid("c");
const d = oid("d");

const commit = (
  id: string,
  parents: string[],
  overrides: Partial<GitCommitRecord> = {},
): GitCommitRecord => ({
  oid: id,
  parents,
  subject: `commit ${id.slice(0, 4)}`,
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authorTime: "2026-09-01T00:00:00Z",
  committerTime: "2026-09-01T00:00:00Z",
  refs: [],
  ...overrides,
});

beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(cleanup);

describe("lane layout", () => {
  it("keeps the first parent in the same lane so the mainline is one column", () => {
    const graph = commitGraph([commit(a, [b]), commit(b, [c]), commit(c, [])]);
    expect([a, b, c].map((id) => graph.points.get(id)!.lane)).toEqual([
      0, 0, 0,
    ]);
    expect(graph.lanes).toBe(1);
  });

  it("gives a merge's second parent its own lane and recycles it at the merge", () => {
    // d --- merge of b (mainline) and c (side branch); c's lane must be free
    // again for the commit after the merge point rather than growing the graph.
    const graph = commitGraph([
      commit(d, [b, c]),
      commit(b, [a]),
      commit(c, [a]),
      commit(a, []),
    ]);
    expect(graph.points.get(d)!.lane).toBe(0);
    expect(graph.points.get(b)!.lane).toBe(0);
    expect(graph.points.get(c)!.lane).toBe(1);
    // Both branches land on the same root, which reclaims lane 0.
    expect(graph.points.get(a)!.lane).toBe(0);
    expect(graph.lanes).toBe(2);
  });

  it("keeps the mainline in its lane when a side tip is listed before it", () => {
    // d is a one-commit branch off b, dated between a and the mainline
    // commit c. d claims a lane for b first; c must still keep lane 0 and b
    // must land under it, with d's edge curving in — not the mainline
    // hopping over to d's lane for the rest of the page.
    const graph = commitGraph([
      commit(a, [c]),
      commit(d, [b]),
      commit(c, [b]),
      commit(b, []),
    ]);
    expect([a, d, c, b].map((id) => graph.points.get(id)!.lane)).toEqual([
      0, 1, 0, 0,
    ]);
    expect(graph.lanes).toBe(2);
  });

  it("never invents adjacency for a parent outside the page", () => {
    const graph = commitGraph([commit(a, [b, c])]);
    expect(graph.edges.map((edge) => [edge.child, edge.parent])).toEqual([
      [a, b],
      [a, c],
    ]);
    expect(graph.edges.every((edge) => edge.to === undefined)).toBe(true);
  });
});

describe("graph rendering", () => {
  it("draws a merge as a hollow point and an off-page parent as a dashed stub", () => {
    const { container } = render(
      <CommitGraphLanes
        commits={[commit(d, [b, c]), commit(b, []), commit(c, [])]}
        selected={null}
      />,
    );
    expect(
      container
        .querySelector(`circle[data-commit="${d}"]`)!
        .getAttribute("data-merge"),
    ).toBe("true");
    expect(
      container
        .querySelector(`circle[data-commit="${b}"]`)!
        .getAttribute("data-merge"),
    ).toBe("false");
    // Both parents are on the page here, so nothing is dashed.
    expect(container.querySelector("path[stroke-dasharray]")).toBeNull();

    cleanup();
    const { container: partial } = render(
      <CommitGraphLanes commits={[commit(d, [b])]} selected={null} />,
    );
    expect(
      partial
        .querySelector(`path[data-parent="${b}"]`)!
        .getAttribute("stroke-dasharray"),
    ).toBe("3 3");
  });
});

describe("ref badges", () => {
  it("separates tags from branches and keeps HEAD with the branch it points at", () => {
    expect(
      refBadges([
        "HEAD -> refs/heads/main",
        "refs/heads/main",
        "refs/tags/v1.0.0",
        "refs/remotes/origin/main",
      ]),
    ).toEqual([
      { label: "HEAD", kind: "head" },
      { label: "main", kind: "branch" },
      { label: "v1.0.0", kind: "tag" },
      { label: "origin/main", kind: "remote" },
    ]);
    expect(refBadges([" ", ""])).toEqual([]);
  });
});
