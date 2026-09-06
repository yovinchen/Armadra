import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitBranchSnapshot,
  GitCommitRecord,
  GitIntegrationSnapshot,
  GitRepositoryAction,
  GitRepositoryOperation,
  GitWorktreeRecord,
} from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import { usePreferencesStore } from "../../app/preferences-store";
import { installDomPolyfills } from "../../app/test-harness";
import { OWNERSHIP_DOMAINS, useOwnership } from "../../ownership/store";
import { GitRepositoryPanel } from "./GitRepositoryPanel";

installDomPolyfills();

export const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40);

export function snapshot(id = "repo-one"): GitBranchSnapshot {
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
export function operation(
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
    progress: 0,
    createdAt: "now",
    finishedAt: null,
    message: null,
  };
}
export function commit(
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
export function tree(
  overrides: Partial<GitWorktreeRecord> = {},
): GitWorktreeRecord {
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

export function view(
  tab: "branches" | "history" | "worktrees" | "integration" = "branches",
): RenderResult & {
  client: QueryClient;
  ui: (workspaceId?: string, visible?: boolean) => ReactElement;
} {
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

/** 四个页签的测试共用同一套 Runtime 桩与查询客户端清理。 */
export function setupGitRepositoryPanelTests(): void {
  beforeEach(() => {
    usePreferencesStore.setState({ locale: "en" });
    // 写要先知道谁在写，所以网关会去探一次归属。这里摆的是**产品自己的初
    // 始状态**——`ownership.initial` 就是第一次迁移写进去的那一行——而不是
    // 为测试编的一档；验 Host 那侧的用例自己改成 `host`。
    useOwnership.setState({
      domains: OWNERSHIP_DOMAINS.map((domain) => ({
        domain,
        status: "runtime" as const,
        epoch: 1n,
        reasonCode: "ownership.initial",
        updatedAt: "1970-01-01T00:00:00Z",
      })),
      failed: false,
    });
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
}

export async function confirm() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm operation" }),
  );
}

export const mergeId = "11111111-1111-4111-8111-111111111111";
export const waitingMerge = (): GitRepositoryOperation => ({
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
export const integrationState = (): GitIntegrationSnapshot => ({
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
export const cachedOperationKey = (id: string) => [
  "git-repository-operation",
  "workspace-one",
  "repo-one",
  "/project",
  id,
];
