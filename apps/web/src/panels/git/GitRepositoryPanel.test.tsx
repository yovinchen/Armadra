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
  GitIntegrationSnapshot,
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
function view(
  tab: "branches" | "history" | "worktrees" | "integration" = "branches",
) {
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

describe("remote synchronization", () => {
  function tracked(): GitBranchSnapshot {
    const base = snapshot();
    return {
      ...base,
      branches: [
        ...base.branches,
        {
          name: "origin/main",
          fullRef: "refs/remotes/origin/main",
          oid: c,
          remote: true,
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
  it("binds sync to the remote OID this view observed and names its steps", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(tracked());
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(() => new Promise(() => {}));
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(c);
    expect(dialog.textContent).toContain("fast-forward-only pull");
    await confirm();
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "sync",
          remote: "origin",
          branch: "main",
          expectedRemoteOid: c,
        },
        { headOid: a, branch: "main" },
      ),
    );
  });
  it("pushes without a lease unless one is chosen, and never offers a bare force", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(tracked());
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(() => new Promise(() => {}));
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: "Push current branch" }),
    );
    await confirm();
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "push",
          remote: "origin",
          branch: "main",
          setUpstream: false,
          forceWithLease: null,
        },
        { headOid: a, branch: "main" },
      ),
    );
    expect(screen.queryByRole("button", { name: /^Force push$/ })).toBeNull();
  });
  it("requires a second acknowledgement of the remote commit a lease replaces", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(tracked());
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(() => new Promise(() => {}));
    view();
    fireEvent.click(
      await screen.findByLabelText("Push with a force lease instead"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Force push (with lease)" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Remote commit this replaces");
    expect(dialog.textContent).toContain(c);
    const action = within(dialog).getByRole("button", {
      name: "Confirm force push",
    });
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(action);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByLabelText(
        "I want to rewrite the remote commit above",
      ),
    );
    fireEvent.click(action);
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "push",
          remote: "origin",
          branch: "main",
          setUpstream: false,
          forceWithLease: { expectedRemoteOid: c },
        },
        { headOid: a, branch: "main" },
      ),
    );
  });
  it("offers no lease while the remote position is unknown", async () => {
    view();
    fireEvent.click(
      await screen.findByLabelText("Push with a force lease instead"),
    );
    expect(
      screen.getByText(/No remote OID has been observed for this branch/),
    ).toBeTruthy();
    const push = screen.getByRole("button", { name: "Push current branch" });
    expect(push.hasAttribute("disabled")).toBe(true);
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

const mergeId = "11111111-1111-4111-8111-111111111111";
const waitingMerge = (): GitRepositoryOperation => ({
  ...operation(
    {
      kind: "startMerge",
      targetOid: b,
      message: "Review merge",
      expectedStateToken: "d".repeat(64),
    },
    "awaitingResolution",
  ),
  id: mergeId,
  createdAt: "2026-09-05T00:00:00Z",
  finishedAt: "2026-09-05T00:00:01Z",
});
const integrationState = (): GitIntegrationSnapshot => ({
  repositoryId: "repo-one",
  repositoryPath: "/project",
  head: snapshot().head,
  stateToken: "d".repeat(64),
  kind: "merge",
  owned: true,
  sessionId: mergeId,
  originalHead: a,
  originalBranch: "main",
  targetOid: b,
  message: "Review merge",
  dirty: true,
  canContinue: true,
  mainline: null,
  empty: false,
  canSkip: false,
  conflicts: [],
});
const cachedOperationKey = (id: string) => [
  "git-repository-operation",
  "workspace-one",
  "repo-one",
  "/project",
  id,
];

describe("integration operation reconciliation", () => {
  it("rechecks external completion, updates old waiting history to unknown, and stops invalidating once reconciled", async () => {
    let history = [waitingMerge()];
    let external = false;
    const list = vi
      .mocked(runtimeApi.gitRepositoryOperations)
      .mockImplementation(async () => history);
    const read = vi
      .spyOn(runtimeApi, "gitRepositoryIntegration")
      .mockImplementation(async () => {
        if (!external) return integrationState();
        history = [
          {
            ...waitingMerge(),
            state: "unknownOutcome",
            finishedAt: "2026-09-05T00:00:02Z",
            message: "External completion released ownership",
          },
        ];
        return {
          ...integrationState(),
          kind: "none",
          owned: false,
          sessionId: null,
          canContinue: false,
          mainline: null,
          empty: false,
          canSkip: false,
          dirty: false,
          message: null,
        };
      });
    const { client } = view("integration");
    const region = await screen.findByRole("region", {
      name: "Operation status",
    });
    await waitFor(() =>
      expect(region.textContent).toContain("Awaiting resolution"),
    );
    await screen.findByText(
      "The merge is ready and still awaits your commit confirmation.",
    );
    external = true;
    // The second Refresh belongs to the integration view, not the global button.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh repository" })[1]!,
    );
    await waitFor(() =>
      expect(region.textContent).toContain("Outcome unknown"),
    );
    expect(region.textContent).not.toContain("Awaiting resolution");
    expect(
      client.getQueryData<GitRepositoryOperation>(cachedOperationKey(mergeId))
        ?.state,
    ).toBe("unknownOutcome");
    const tracked = client.getQueryData<{ operation: GitRepositoryOperation }>([
      "git-repository-active-operation",
      "workspace-one",
      "repo-one",
      "/project",
    ]);
    expect(tracked?.operation.state).toBe("unknownOutcome");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const counts = [read.mock.calls.length, list.mock.calls.length];
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    expect([read.mock.calls.length, list.mock.calls.length]).toEqual(counts);
    expect(counts[0]).toBeLessThan(8);
  });

  it.each([false, true])(
    "refreshes the original start record after explicit recovery (abort=%s)",
    async (abort) => {
      let history = [waitingMerge()];
      let active = true;
      vi.mocked(runtimeApi.gitRepositoryOperations).mockImplementation(
        async () => history,
      );
      vi.spyOn(runtimeApi, "gitRepositoryIntegration").mockImplementation(
        async () =>
          active
            ? integrationState()
            : {
                ...integrationState(),
                kind: "none",
                owned: false,
                sessionId: null,
                canContinue: false,
                mainline: null,
                empty: false,
                canSkip: false,
                dirty: false,
                message: null,
              },
      );
      const newId = "22222222-2222-4222-8222-222222222222";
      let recovery!: GitRepositoryOperation;
      vi.spyOn(runtimeApi, "gitRepositoryOperate").mockImplementation(
        async (_workspace, action) => {
          recovery = { ...operation(action), id: newId };
          return recovery;
        },
      );
      vi.mocked(runtimeApi.gitRepositoryOperation).mockImplementation(
        async (_workspace, id) => {
          expect(id).toBe(newId);
          active = false;
          const complete = {
            ...recovery,
            state: "succeeded" as const,
            finishedAt: "2026-09-05T00:00:03Z",
          };
          history = [
            complete,
            {
              ...waitingMerge(),
              state: abort ? "cancelled" : "succeeded",
              finishedAt: "2026-09-05T00:00:03Z",
            },
          ];
          return complete;
        },
      );
      const { client } = view("integration");
      fireEvent.click(
        await screen.findByRole("button", {
          name: abort ? "Abort merge" : "Continue and commit merge",
        }),
      );
      await confirm();
      await waitFor(() =>
        expect(
          client.getQueryData<GitRepositoryOperation>(
            cachedOperationKey(mergeId),
          )?.state,
        ).toBe(abort ? "cancelled" : "succeeded"),
      );
      fireEvent.click(screen.getByText("Operations in this Runtime session"));
      fireEvent.click(
        await screen.findByRole("button", {
          name: new RegExp(
            `Start merge · ${abort ? "Cancelled" : "Completed"}`,
          ),
        }),
      );
      const region = screen.getByRole("region", { name: "Operation status" });
      await waitFor(() =>
        expect(region.textContent).toContain(abort ? "Cancelled" : "Completed"),
      );
      // A stale list must not restore this original merge's waiting state.
      history = [waitingMerge()];
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ["git-repository-operations", "workspace-one"],
        });
      });
      expect(
        client.getQueryData<GitRepositoryOperation>(cachedOperationKey(mergeId))
          ?.state,
      ).toBe(abort ? "cancelled" : "succeeded");
      expect(region.textContent).not.toContain("Awaiting resolution");
    },
  );

  it.each(["queued", "running", "awaitingResolution"] as const)(
    "ignores a late %s poll after the same operation was confirmed complete",
    async (lateState) => {
      let history: GitRepositoryOperation[] = [
        {
          ...waitingMerge(),
          state: "running" as GitRepositoryOperation["state"],
          finishedAt: null,
        },
      ];
      let completePoll!: (result: GitRepositoryOperation) => void;
      vi.mocked(runtimeApi.gitRepositoryOperations).mockImplementation(
        async () => history,
      );
      vi.mocked(runtimeApi.gitRepositoryOperation).mockImplementation(
        () =>
          new Promise((resolve) => {
            completePoll = resolve;
          }),
      );
      const { client } = view();
      const region = await screen.findByRole("region", {
        name: "Operation status",
      });
      await waitFor(() => expect(completePoll).toBeTypeOf("function"));
      history = [
        {
          ...waitingMerge(),
          state: "succeeded",
          finishedAt: "2026-09-05T00:00:03Z",
        },
      ];
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ["git-repository-operations", "workspace-one"],
        });
      });
      await waitFor(() => expect(region.textContent).toContain("Completed"));
      await act(async () =>
        completePoll({ ...waitingMerge(), state: lateState }),
      );
      await waitFor(() =>
        expect(
          client.getQueryData<GitRepositoryOperation>(
            cachedOperationKey(mergeId),
          )?.state,
        ).toBe("succeeded"),
      );
      expect(region.textContent).toContain("Completed");
      expect(region.textContent).not.toContain("Awaiting resolution");
    },
  );
});
