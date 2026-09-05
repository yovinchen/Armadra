import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitRepositoryRecord } from "@armadra/shared";
import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import {
  ALL_REPOSITORIES,
  RepositoryList,
  RepositorySwitcher,
  groupRepositories,
} from "./Repositories";

installDomPolyfills();

const ROOT_ID = "a".repeat(64);
const NESTED_ID = "b".repeat(64);
const SUBMODULE_ID = "c".repeat(64);

const record = (
  overrides: Partial<GitRepositoryRecord> & { repositoryPath: string },
): GitRepositoryRecord => ({
  repositoryId: ROOT_ID,
  name: overrides.repositoryPath.split("/").pop()!,
  kind: "nested",
  parentRepositoryId: ROOT_ID,
  headBranch: "main",
  dirtyCount: 0,
  ...overrides,
});

const workspace = (): GitRepositoryRecord[] => [
  record({
    repositoryPath: ".",
    name: "workspace",
    kind: "root",
    parentRepositoryId: null,
    dirtyCount: 3,
  }),
  record({
    repositoryPath: "apps/inner",
    repositoryId: NESTED_ID,
    kind: "nested",
    headBranch: "develop",
    dirtyCount: 1,
  }),
  record({
    repositoryPath: "libs/dep",
    repositoryId: SUBMODULE_ID,
    kind: "submodule",
    dirtyCount: null,
  }),
  // A linked worktree is the same repository as the root, so it carries the
  // root's id; only its path tells the two checkouts apart.
  record({
    repositoryPath: "trees/feature",
    repositoryId: ROOT_ID,
    kind: "worktree",
    headBranch: "feature",
    dirtyCount: 0,
  }),
];

beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("repository grouping", () => {
  it("nests children under their parent without letting a worktree nest in itself", () => {
    const grouped = groupRepositories(workspace());
    expect(
      grouped.map(({ record, depth }) => [record.repositoryPath, depth]),
    ).toEqual([
      [".", 0],
      ["apps/inner", 1],
      ["libs/dep", 1],
      // The worktree shares the root's id, so a naive parent lookup would make
      // it its own child and loop; it is listed once, under the root.
      ["trees/feature", 1],
    ]);
  });

  it("still lists a repository whose parent is not in the result", () => {
    const orphan = record({
      repositoryPath: "vendor/lib",
      repositoryId: NESTED_ID,
      parentRepositoryId: "d".repeat(64),
    });
    expect(
      groupRepositories([orphan]).map(({ record }) => record.repositoryPath),
    ).toEqual(["vendor/lib"]);
  });
});

describe("repository list", () => {
  it("shows an unknown change count differently from a clean repository", () => {
    render(
      <RepositoryList
        repositories={workspace()}
        value="."
        allowAll={false}
        onChange={() => {}}
      />,
    );
    const rows = screen.getAllByRole("button");
    // A repository with no execution grant reports no count at all. Rendering
    // it as 0 would read as "nothing to commit here".
    expect(rows[2]!.textContent).toContain("—");
    expect(rows[2]!.textContent).not.toContain("0");
    expect(rows[3]!.textContent).toContain("0");
    expect(rows[0]!.textContent).toContain("3");
    expect(rows[1]!.textContent).toContain("develop");
  });

  it("selects by path so two checkouts of one repository stay distinct", () => {
    const onChange = vi.fn();
    render(
      <RepositoryList
        repositories={workspace()}
        value="."
        allowAll
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /feature/ }));
    expect(onChange).toHaveBeenCalledWith("trees/feature");
    fireEvent.click(screen.getByRole("button", { name: /All repositories/ }));
    expect(onChange).toHaveBeenLastCalledWith(ALL_REPOSITORIES);
  });
});

describe("repository switcher", () => {
  it("stays out of the way when the workspace holds one repository", () => {
    const { container } = render(
      <RepositorySwitcher
        repositories={[workspace()[0]!]}
        value="."
        allowAll
        pending={false}
        onChange={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("offers the aggregate view only when the caller allows it", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RepositorySwitcher
        repositories={workspace()}
        value="."
        allowAll={false}
        pending={false}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Switch repository" });
    expect(
      [...select.querySelectorAll("option")].map((option) => option.value),
    ).toEqual([".", "apps/inner", "libs/dep", "trees/feature"]);
    rerender(
      <RepositorySwitcher
        repositories={workspace()}
        value="."
        allowAll
        pending={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Switch repository" }),
      { target: { value: ALL_REPOSITORIES } },
    );
    expect(onChange).toHaveBeenCalledWith(ALL_REPOSITORIES);
  });
});
