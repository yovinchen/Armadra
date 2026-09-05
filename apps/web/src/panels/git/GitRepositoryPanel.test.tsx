import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitBranchSnapshot,
  GitCommitRecord,
  GitRepositoryAction,
  GitRepositoryOperation,
  GitWorktreeRecord,
} from "@armadra/shared";
import { runtimeApi, RuntimeConnectionError } from "../../api/client";
import { usePreferencesStore } from "../../app/preferences-store";
import { installDomPolyfills } from "../../app/test-harness";
import { GitRepositoryPanel } from "./GitRepositoryPanel";
import { commitGraph } from "./History";

installDomPolyfills();
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40);
function snapshot(id = "repo-one"): GitBranchSnapshot {
  return {
    repositoryId: id,
    repositoryPath: "/project",
    head: { headOid: a, branch: "main" },
    observedAt: "now",
    remotes: ["origin"],
    branches: [
      {
        name: "main",
        fullRef: "refs/heads/main",
        oid: a,
        remote: false,
        current: true,
        upstream: "origin/main",
        ahead: 2,
        behind: 1,
        upstreamMissing: false,
        symbolicTarget: null,
      },
      {
        name: "feature",
        fullRef: "refs/heads/feature",
        oid: b,
        remote: false,
        current: false,
        upstream: null,
        ahead: null,
        behind: null,
        upstreamMissing: false,
        symbolicTarget: null,
      },
    ],
  };
}
function operation(
  action: GitRepositoryAction,
  state: GitRepositoryOperation["state"] = "queued",
): GitRepositoryOperation {
  return {
    id: "operation-1",
    repositoryId: "repo-one",
    repositoryPath: "/project",
    workspaceRoot: "/project",
    action,
    state,
    cancellationRequested: false,
    createdAt: "now",
    finishedAt: null,
    message: null,
  };
}
function commit(
  oid: string,
  parents: string[],
  subject: string,
): GitCommitRecord {
  return {
    oid,
    parents,
    subject,
    authorName: "作者",
    authorEmail: "author@example.test",
    authorTime: "2026-01-01T00:00:00Z",
    committerTime: "2026-01-01T00:00:00Z",
    refs: [],
  };
}
function tree(overrides: Partial<GitWorktreeRecord> = {}): GitWorktreeRecord {
  return {
    path: "/project/trees/feature",
    headOid: b,
    branch: "refs/heads/feature",
    detached: false,
    bare: false,
    isMain: false,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    accessible: true,
    dirty: false,
    ...overrides,
  };
}
const clients: QueryClient[] = [];
function view(tab: "branches" | "history" | "worktrees" = "branches") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const ui = (workspaceId = "workspace-one", visible = true) => (
    <QueryClientProvider client={client}>
      {visible && <GitRepositoryPanel workspaceId={workspaceId} tab={tab} />}
    </QueryClientProvider>
  );
  return { ...render(ui()), client, ui };
}
beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  vi.spyOn(runtimeApi, "gitRepositoryBranches").mockResolvedValue(snapshot());
  vi.spyOn(runtimeApi, "gitRepositoryOperations").mockResolvedValue([]);
  vi.spyOn(runtimeApi, "gitRepositoryOperation").mockImplementation(
    () => new Promise(() => {}),
  );
  vi.spyOn(runtimeApi, "gitRepositoryWorktrees").mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

async function confirm() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm operation" }),
  );
}

describe("repository operations", () => {
  it("restores a running operation from the Runtime after a fresh page query cache", async () => {
    const restored = operation(
      { kind: "fetch", remote: "origin", prune: false },
      "running",
    );
    vi.mocked(runtimeApi.gitRepositoryOperations).mockResolvedValue([restored]);
    const cancel = vi
      .spyOn(runtimeApi, "gitRepositoryCancel")
      .mockResolvedValue({ ...restored, state: "cancelled" });
    view();
    const region = await screen.findByRole("region", {
      name: "Operation status",
    });
    expect(region.textContent).toContain("origin");
    fireEvent.click(
      within(region).getByRole("button", { name: "Request cancellation" }),
    );
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith("workspace-one", restored.id),
    );
  });
  it("confirms the branch and observed HEAD, then waits for the actual result and supports cancellation", async () => {
    const action: GitRepositoryAction = {
      kind: "createBranch",
      name: "feature/new",
      startPoint: null,
      switch: false,
    };
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockResolvedValue(operation(action));
    vi.spyOn(runtimeApi, "gitRepositoryCancel").mockResolvedValue({
      ...operation(action, "unknownOutcome"),
      cancellationRequested: true,
      message: "Inspect remote before retrying",
    });
    view();
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Branch name" }),
      { target: { value: "feature/new" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    expect(submit).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("/project");
    expect(dialog.textContent).toContain(a);
    await confirm();
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith("workspace-one", action, {
        headOid: a,
        branch: "main",
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Operation status" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Completed/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Request cancellation" }),
    );
    await screen.findByText(/Outcome unknown/);
    expect(screen.queryByText(/Completed/)).toBeNull();
    expect(screen.getByText(/It will not retry automatically/)).toBeTruthy();
  });

  it("keeps a pending submission across panel close/reopen and scopes its late response to its workspace", async () => {
    let resolve!: (value: GitRepositoryOperation) => void;
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    const rendered = view();
    fireEvent.click(await screen.findByRole("button", { name: "Fetch" }));
    await confirm();
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    rendered.rerender(rendered.ui("workspace-one", false));
    rendered.rerender(rendered.ui());
    const fetch = await screen.findByRole("button", { name: "Fetch" });
    expect(fetch.closest("fieldset")?.disabled).toBe(true);
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(
      snapshot("repo-two"),
    );
    rendered.rerender(rendered.ui("workspace-two"));
    await waitFor(() =>
      expect(vi.mocked(runtimeApi.gitRepositoryBranches)).toHaveBeenCalledWith(
        "workspace-two",
        expect.any(AbortSignal),
      ),
    );
    await act(async () =>
      resolve(
        operation(
          { kind: "fetch", remote: "origin", prune: false },
          "succeeded",
        ),
      ),
    );
    expect(
      screen.queryByRole("region", { name: "Operation status" }),
    ).toBeNull();
    expect(screen.queryByText(/Completed/)).toBeNull();
  });

  it("never retries an uncertain write and keeps it blocked until explicit inspection", async () => {
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockRejectedValue(new RuntimeConnectionError("http://fixture.invalid"));
    const rendered = view();
    fireEvent.click(
      await screen.findByRole("button", { name: "Push current branch" }),
    );
    expect((await screen.findByRole("alertdialog")).textContent).toContain(
      "origin / main",
    );
    await confirm();
    await screen.findByText(/It will not retry automatically/);
    expect(submit).toHaveBeenCalledTimes(1);
    rendered.rerender(rendered.ui("workspace-one", false));
    rendered.rerender(rendered.ui());
    const fetch = await screen.findByRole("button", { name: "Fetch" });
    expect(fetch.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "I checked the state; enable operations",
      }),
    );
    await waitFor(() =>
      expect(fetch.closest("fieldset")?.disabled).toBe(false),
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("shows failed reads rather than a clean or empty repository", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockRejectedValue(
      new Error("Repository unavailable"),
    );
    view();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No branches yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create branch" })).toBeNull();
  });

  it("stops polling after a read error and resumes only on explicit check", async () => {
    const action: GitRepositoryAction = {
      kind: "fetch",
      remote: "origin",
      prune: false,
    };
    vi.spyOn(runtimeApi, "gitRepositoryOperate").mockResolvedValue(
      operation(action),
    );
    vi.mocked(runtimeApi.gitRepositoryOperation).mockRejectedValue(
      new Error("lost connection"),
    );
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Fetch" }));
    await confirm();
    await screen.findByText(/cannot be read right now/);
    expect(vi.mocked(runtimeApi.gitRepositoryOperation)).toHaveBeenCalledTimes(
      1,
    );
    vi.mocked(runtimeApi.gitRepositoryOperation).mockResolvedValue(
      operation(action, "succeeded"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check result again" }));
    await screen.findByText(/Completed/);
    expect(vi.mocked(runtimeApi.gitRepositoryOperation)).toHaveBeenCalledTimes(
      2,
    );
  });
});

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
    expect(read).toHaveBeenCalledWith(
      "workspace-one",
      "HEAD",
      "opaque-cursor",
      expect.any(AbortSignal),
    );
    expect(
      document
        .querySelector(`path[data-parent="${c}"]`)!
        .getAttribute("stroke-dasharray"),
    ).toBeNull();
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
