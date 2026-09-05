import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { runtimeApi } from "../../api/client";
import { commitGraph } from "./History";
import {
  a,
  b,
  c,
  commit,
  confirm,
  integrationState,
  operation,
  setupGitRepositoryPanelTests,
  tree,
  view,
} from "./GitRepositoryPanel.test-harness";

setupGitRepositoryPanelTests();

describe("worktrees and history", () => {
  it("binds an existing worktree branch to its observed object ID", async () => {
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(async (_workspace, action) => operation(action));
    view("worktrees");
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Worktree path (inside workspace)",
      }),
      { target: { value: ".armadra/worktrees/feature" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Create a new branch" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Branch name" }), {
      target: { value: "feature" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain(b);
    await confirm();
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "createWorktree",
          path: ".armadra/worktrees/feature",
          branch: "feature",
          createBranch: false,
          startPoint: null,
          expectedOid: b,
        },
        { headOid: a, branch: "main" },
        ".",
      ),
    );
  });
  it("disables dirty/outside/main removals and never sends force permission", async () => {
    vi.mocked(runtimeApi.gitRepositoryWorktrees).mockResolvedValue([
      tree({ path: "/project/dirty", dirty: true }),
      tree({ path: "/outside", accessible: false, dirty: null }),
      tree({ path: "/project", isMain: true }),
      tree(),
    ]);
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(async (_ws, action) => ({
        ...operation(action, "failed"),
        message: "Worktree has unpublished commits",
      }));
    view("worktrees");
    const removes = await screen.findAllByRole("button", {
      name: "Remove worktree",
    });
    expect(
      removes.map((button) => (button as HTMLButtonElement).disabled),
    ).toEqual([true, true, true, false]);
    fireEvent.click(removes[3]!);
    await confirm();
    await screen.findByText("Worktree has unpublished commits");
    expect(submit).toHaveBeenCalledWith(
      "workspace-one",
      {
        kind: "removeWorktree",
        path: "/project/trees/feature",
        expectedOid: b,
        allowUnpublished: false,
      },
      { headOid: a, branch: "main" },
      ".",
    );
  });

  it("paginates by the returned cursor and shows real parents in graph and details", async () => {
    const read = vi
      .spyOn(runtimeApi, "gitRepositoryHistory")
      .mockImplementation(async (_ws, _ref, cursor) =>
        cursor
          ? {
              reference: "HEAD",
              anchorOid: a,
              commits: [commit(c, [], "Root")],
              nextCursor: null,
              shallow: false,
            }
          : {
              reference: "HEAD",
              anchorOid: a,
              commits: [commit(a, [c], "Newest"), commit(b, [], "Unrelated")],
              nextCursor: "opaque-cursor",
              shallow: false,
            },
      );
    view("history");
    fireEvent.click(await screen.findByRole("button", { name: /Newest/ }));
    expect(
      within(screen.getByRole("region", { name: "Commit details" })).getByText(
        c,
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(`path[data-child="${a}"][data-parent="${b}"]`),
    ).toBeNull();
    const missing = document.querySelector(`path[data-parent="${c}"]`)!;
    expect(missing.getAttribute("stroke-dasharray")).toBe("3 3");
    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier commits" }),
    );
    await screen.findByRole("button", { name: /Root/ });
    // The page carries the checkout it is reading and the graph's page size.
    expect(read).toHaveBeenCalledWith(
      "workspace-one",
      "HEAD",
      "opaque-cursor",
      expect.any(AbortSignal),
      ".",
      100,
    );
    expect(
      document
        .querySelector(`path[data-parent="${c}"]`)!
        .getAttribute("stroke-dasharray"),
    ).toBeNull();
  });

  it("acts on a history row with that row's own object ID", async () => {
    vi.spyOn(runtimeApi, "gitRepositoryHistory").mockResolvedValue({
      reference: "HEAD",
      anchorOid: a,
      commits: [commit(b, [c], "Older")],
      nextCursor: null,
      shallow: false,
    });
    vi.spyOn(runtimeApi, "gitRepositoryIntegration").mockResolvedValue({
      ...integrationState(),
      kind: "none",
      owned: false,
      sessionId: null,
      canContinue: false,
      dirty: false,
      message: null,
      targetOid: null,
      originalHead: null,
      originalBranch: null,
    });
    // Each request settles immediately so the next row action is not blocked
    // by a still-running operation.
    const operate = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(async (_workspace, action) =>
        operation(action, "succeeded"),
      );
    view("history");
    fireEvent.click(await screen.findByRole("button", { name: /Older/ }));

    // A detached checkout says so before it runs, and names the row's OID.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Check out this commit (detached HEAD)",
      }),
    );
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "detaches HEAD",
    );
    await confirm();
    await waitFor(() =>
      expect(operate).toHaveBeenCalledWith(
        "workspace-one",
        { kind: "checkoutCommit", targetOid: b },
        { headOid: a, branch: "main" },
        ".",
      ),
    );

    // Revert carries the observed state token from the integration read.
    operate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Revert this commit" }));
    await confirm();
    await waitFor(() =>
      expect(operate).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "revert",
          targetOid: b,
          mainline: null,
          expectedStateToken: "d".repeat(64),
        },
        { headOid: a, branch: "main" },
        ".",
      ),
    );

    // Branching from the row pins the start point to that commit.
    operate.mockClear();
    fireEvent.change(screen.getByLabelText("Branch from this commit"), {
      target: { value: "rescue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await confirm();
    await waitFor(() =>
      expect(operate).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "createBranch",
          name: "rescue",
          startPoint: b,
          switch: false,
        },
        { headOid: a, branch: "main" },
        ".",
      ),
    );
  });

  it("refuses cherry-pick and revert while another integration is in progress", async () => {
    vi.spyOn(runtimeApi, "gitRepositoryHistory").mockResolvedValue({
      reference: "HEAD",
      anchorOid: a,
      commits: [commit(b, [c], "Older")],
      nextCursor: null,
      shallow: false,
    });
    // A merge is already paused, so the sequence actions must stay disabled.
    vi.spyOn(runtimeApi, "gitRepositoryIntegration").mockResolvedValue(
      integrationState(),
    );
    const operate = vi.spyOn(runtimeApi, "gitRepositoryOperate");
    view("history");
    fireEvent.click(await screen.findByRole("button", { name: /Older/ }));
    const revert = await screen.findByRole("button", {
      name: "Revert this commit",
    });
    await waitFor(() =>
      expect((revert as HTMLButtonElement).disabled).toBe(true),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Cherry-pick commit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(revert);
    expect(operate).not.toHaveBeenCalled();
  });

  it("gates a hard reset on discarding uncommitted work and names the recovery stash", async () => {
    vi.spyOn(runtimeApi, "gitRepositoryHistory").mockResolvedValue({
      reference: "HEAD",
      anchorOid: a,
      commits: [commit(b, [c], "Older")],
      nextCursor: null,
      shallow: false,
    });
    vi.spyOn(runtimeApi, "gitRepositoryIntegration").mockResolvedValue({
      ...integrationState(),
      kind: "none",
      owned: false,
      sessionId: null,
      canContinue: false,
      // Uncommitted work is present, which is exactly what hard would lose.
      dirty: true,
      message: null,
      targetOid: null,
      originalHead: null,
      originalBranch: null,
    });
    const operate = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(async (_workspace, action) =>
        operation(action, "succeeded"),
      );
    view("history");
    fireEvent.click(await screen.findByRole("button", { name: /Older/ }));

    // Soft is available on a dirty worktree because it loses nothing.
    const submit = await screen.findByRole("button", {
      name: "Reset to this commit",
    });
    await waitFor(() =>
      expect((submit as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("Reset mode"), {
      target: { value: "hard" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I want to discard the uncommitted changes",
      }),
    );
    await waitFor(() =>
      expect((submit as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(submit);
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "stashed first",
    );
    await confirm();
    await waitFor(() =>
      expect(operate).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "reset",
          mode: "hard",
          targetOid: b,
          expectedStateToken: "d".repeat(64),
          discardChanges: true,
        },
        { headOid: a, branch: "main" },
        ".",
      ),
    );
  });

  it("builds merge edges from OIDs and never invents adjacency", () => {
    const graph = commitGraph([
      commit(a, [b, c], "merge"),
      commit(b, [], "left"),
      commit(c, [], "right"),
    ]);
    expect(graph.edges.map((edge) => [edge.child, edge.parent])).toEqual([
      [a, b],
      [a, c],
    ]);
    expect(graph.edges.every((edge) => edge.to !== undefined)).toBe(true);
    expect(graph.points.get(b)?.lane).not.toBe(graph.points.get(c)?.lane);
  });
});
