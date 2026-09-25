import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  GithubApiError,
  GithubCheckConclusion,
  GithubIssueState,
  GithubMergeMethod,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubReviewState,
  GithubStatusSource,
  GithubWriteState,
  githubCheckRun,
  githubCheckSummary,
  githubExternalReference,
  githubIssue,
  githubPullRequest,
  githubRepository,
  githubStatusGroup,
  githubStatusMapping,
  resolveGithubRepositoryResponse,
} from "../../api/github";

const store = vi.hoisted(() => ({
  panels: { github: "drawer" as "drawer" | "closed" },
  workspace: { id: "workspace-1", rootPath: "/tmp" },
  document: {
    nodes: [{ id: "node-1", type: "terminal", title: "claude · api" }],
  },
  setPanel: vi.fn(),
}));

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toasts }));

const session = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
  client: null as unknown,
  connect: vi.fn(async () => {}),
  reset: vi.fn(),
}));

vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("@/host/github-session", () => {
  const useGithubSession = <T,>(selector: (state: typeof session) => T) =>
    selector(session);
  useGithubSession.getState = () => session;
  return { useGithubSession, GITHUB_CAPABILITY: "github.issues.v1" };
});

vi.mock("@/api/client", () => ({
  runtimeApi: {
    gitRepositoryBranches: vi.fn(async () => ({
      repositoryId: "repo",
      repositoryPath: ".",
      head: { headOid: "a".repeat(40), branch: "main" },
      branches: [],
      remotes: ["origin"],
      observedAt: "2026-09-06T00:00:00Z",
    })),
    gitRepositoryOperate: vi.fn(async () => ({ id: "operation-1" })),
    gitRepositoryWorktrees: vi.fn(async () => []),
  },
}));

import { runtimeApi } from "@/api/client";
import { GithubDrawer } from "./GithubDrawer";
import { useGithubFocus } from "./open";

const repository = {
  owner: "armadra",
  name: "armadra",
  apiBase: "https://api.github.com",
  host: "github.com",
};

const HEAD_SHA = "b".repeat(40);

const resolved = resolveGithubRepositoryResponse({
  repository: githubRepository({
    ref: repository,
    defaultBranch: "main",
    permission: "write",
  }),
});

/** The exact ref the client hands back, message identity included. */
const ref = resolved.repository!.ref!;

const mapping = githubStatusMapping({
  repository,
  revision: 7n,
  groups: [
    githubStatusGroup({ id: "todo", title: "Todo" }),
    githubStatusGroup({ id: "done", title: "Done" }),
  ],
});

const issue = githubIssue({
  repository,
  number: 12n,
  title: "Broken import",
  state: GithubIssueState.OPEN,
  statusGroupId: "todo",
  updatedAtUnixMs: 1_788_557_900_000n,
});

const pull = githubPullRequest({
  repository,
  number: 34n,
  title: "Fix the import",
  state: GithubPullState.OPEN,
  baseRef: "main",
  headRef: "fix/import",
  headSha: HEAD_SHA,
  allowedMergeMethods: [GithubMergeMethod.SQUASH],
  additions: 4n,
  deletions: 1n,
  changedFiles: 1n,
});

const reference = githubExternalReference({
  referenceId: "reference-1",
  workspaceId: "workspace-1",
  repository,
  kind: GithubReferenceKind.ISSUE,
  number: 12n,
  targetKind: GithubReferenceTargetKind.SESSION,
  targetId: "node-1",
  title: "Broken import",
  revision: 2n,
});

const checks = githubCheckSummary({
  headSha: HEAD_SHA,
  rollup: GithubCheckConclusion.SUCCESS,
  runs: [
    githubCheckRun({
      name: "build",
      app: "actions",
      conclusion: GithubCheckConclusion.SUCCESS,
    }),
  ],
});

function client(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-1",
    resolveRepository: vi.fn(async () => resolved),
    getStatusMapping: vi.fn(async () => mapping),
    listIssues: vi.fn(async () => ({
      issues: [issue],
      nextCursor: "",
      hasMore: false,
      fromCache: false,
      observedAtUnixMs: 1_788_557_900_000n,
      pollIntervalMs: 60_000n,
    })),
    listPulls: vi.fn(async () => ({
      pulls: [pull],
      nextCursor: "",
      hasMore: false,
      fromCache: false,
      observedAtUnixMs: 1_788_557_900_000n,
      pollIntervalMs: 60_000n,
    })),
    getPull: vi.fn(async () => ({
      pull,
      files: [],
      reviews: [],
      reviewComments: [],
      comments: [],
      checks,
      references: [],
      pollIntervalMs: 60_000n,
    })),
    getIssue: vi.fn(async () => ({
      issue,
      comments: [],
      references: [],
      pollIntervalMs: 60_000n,
    })),
    moveIssue: vi.fn(async () => ({
      issue,
      outcomes: [
        {
          actionId: "a",
          target: "labels",
          state: GithubWriteState.APPLIED,
          reasonCode: "",
        },
      ],
    })),
    setIssueState: vi.fn(async () => issue),
    mergePull: vi.fn(async () => ({ merged: true, mergeSha: "c".repeat(40) })),
    submitReview: vi.fn(async () => ({
      id: 21n,
      state: GithubReviewState.COMMENTED,
    })),
    rerunChecks: vi.fn(async () => ({
      outcomes: [],
      reasonCode: "NOT_RERUNNABLE",
      checks,
    })),
    deleteBranch: vi.fn(async () => ({ deleted: true, reasonCode: "" })),
    listReferences: vi.fn(async () => ({
      references: [],
      nextId: "",
      hasMore: false,
    })),
    putStatusMapping: vi.fn(async () => mapping),
    linkReference: vi.fn(async () => reference),
    unlinkReference: vi.fn(async () => {}),
    ...overrides,
  };
}

function ready(api: ReturnType<typeof client>, canWrite = true) {
  session.state = {
    status: "ready",
    client: api,
    canWrite,
    session: { scopes: [] },
    hello: { hostId: "a".repeat(32) },
    credential: { available: true },
  };
  session.client = api;
}

function renderDrawer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GithubDrawer />
    </QueryClientProvider>,
  );
}

/** The first argument one mocked method was called with. */
function firstCall<T>(fn: unknown): T {
  return (fn as { mock: { calls: [T][] } }).mock.calls[0]![0];
}

/** Radix 的下拉是 pointerdown 触发的，`click` 打不开。 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(
    trigger,
    new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
}

/** Radix 的页签在 mousedown 上换页，不是 click。 */
function selectTab(label: string) {
  fireEvent.mouseDown(screen.getByText(label), { button: 0 });
}

/** Resolves the repository the way a person would, then waits for the rows. */
async function resolveRepository() {
  const input = document.querySelector("input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { value: "https://github.com/armadra/armadra.git" },
  });
  fireEvent.click(screen.getByText("解析仓库"));
}

beforeEach(() => {
  store.panels.github = "drawer";
  store.setPanel.mockClear();
  toasts.success.mockClear();
  toasts.error.mockClear();
  toasts.message.mockClear();
  session.connect.mockClear();
  session.state = { status: "idle" };
  session.client = null;
  useGithubFocus.setState({ tab: "issues", number: null, reveal: 0 });
  vi.mocked(runtimeApi.gitRepositoryWorktrees).mockReset();
  vi.mocked(runtimeApi.gitRepositoryWorktrees).mockResolvedValue([]);
  vi.mocked(runtimeApi.gitRepositoryOperate).mockClear();
});
afterEach(cleanup);

describe("GitHub page availability", () => {
  it("names why the page cannot be used and offers the settings entry", async () => {
    session.state = { status: "blocked", reason: "signedOut" };
    renderDrawer();
    expect(await screen.findByText("这台设备还没有与 Host 配对")).toBeTruthy();
    // No pretend actions while the Host is unusable.
    expect(screen.queryByText("解析仓库")).toBeNull();
    expect(screen.queryByText("移动到…")).toBeNull();
    expect(screen.queryByText("新建 Issue")).toBeNull();
    fireEvent.click(screen.getByText("前往设置 → 连接"));
    expect(store.setPanel).toHaveBeenCalledWith("settings", true);
  });

  it("sends a missing credential to the GitHub settings section, not to Host", async () => {
    session.state = { status: "blocked", reason: "noCredential" };
    renderDrawer();
    expect(
      await screen.findByText("Host 现在拿不到可用的 GitHub 凭据"),
    ).toBeTruthy();
    expect(screen.getByText("前往设置 → GitHub")).toBeTruthy();
  });

  it("says a Host with no GitHub service cannot be used for this", async () => {
    session.state = { status: "blocked", reason: "unsupported" };
    renderDrawer();
    expect(await screen.findByText("这个 Host 没有 GitHub 服务")).toBeTruthy();
  });

  it("stops at a host mismatch instead of trying the public service", async () => {
    const api = client({
      resolveRepository: vi.fn(async () =>
        resolveGithubRepositoryResponse({
          hostMismatch: true,
          reasonCode: "HOST_MISMATCH",
        }),
      ),
    });
    ready(api);
    renderDrawer();
    await resolveRepository();
    expect(await screen.findByText(/HOST_MISMATCH/)).toBeTruthy();
    expect(api.listIssues).not.toHaveBeenCalled();
  });
});

describe("issue actions", () => {
  it("groups issues under the configured status groups", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    await resolveRepository();
    expect(await screen.findByText("Broken import")).toBeTruthy();
    expect(screen.getByText("Todo")).toBeTruthy();
    expect(
      document.querySelector('[data-slot="github-status-partial"]'),
    ).toBeNull();
  });

  it("marks the grouping as incomplete when Projects statuses were partly read", async () => {
    const api = client({
      listIssues: vi.fn(async () => ({
        issues: [issue],
        nextCursor: "",
        hasMore: false,
        fromCache: false,
        observedAtUnixMs: 1_788_557_900_000n,
        pollIntervalMs: 60_000n,
        statusGroupsPartial: true,
      })),
    });
    ready(api);
    renderDrawer();
    await resolveRepository();
    expect(await screen.findByText("Broken import")).toBeTruthy();
    expect(
      document.querySelector('[data-slot="github-status-partial"]'),
    ).not.toBeNull();
  });

  it("moves against the updatedAt and mapping revision it displayed", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    await resolveRepository();
    openMenu(await screen.findByText("移动到…"));
    fireEvent.click(await screen.findByText("Done"));
    await waitFor(() =>
      expect(api.moveIssue).toHaveBeenCalledWith({
        repository: ref,
        number: 12n,
        toGroupId: "done",
        fromGroupId: "todo",
        expectedUpdatedAtUnixMs: 1_788_557_900_000n,
        expectedMappingRevision: 7n,
      }),
    );
  });

  it("keeps closing and moving to Done as two separate actions", async () => {
    const api = client();
    ready(api);
    renderDrawer();
    await resolveRepository();
    fireEvent.click(await screen.findByText("关闭"));
    await waitFor(() =>
      expect(api.setIssueState).toHaveBeenCalledWith({
        repository: ref,
        number: 12n,
        state: GithubIssueState.CLOSED,
        expectedUpdatedAtUnixMs: 1_788_557_900_000n,
      }),
    );
    expect(api.moveIssue).not.toHaveBeenCalled();
  });

  it("gives a read-only device no write controls at all", async () => {
    const api = client();
    ready(api, false);
    renderDrawer();
    await resolveRepository();
    expect(await screen.findByText("Broken import")).toBeTruthy();
    expect(screen.queryByText("移动到…")).toBeNull();
    expect(screen.queryByText("关闭")).toBeNull();
    expect(screen.queryByText("新建 Issue")).toBeNull();
    expect(screen.getAllByText(/只读权限/).length).toBeGreaterThan(0);
  });
});

describe("configuring the status mapping", () => {
  async function openEditor(api: ReturnType<typeof client>, canWrite = true) {
    ready(api, canWrite);
    renderDrawer();
    await resolveRepository();
    // The dialog opens on the mapping the Host answered with, so the rows have
    // to be on screen before it is opened.
    await screen.findByText("Broken import");
    fireEvent.click(screen.getByText("状态映射"));
    return screen.findByText("配置状态映射");
  }

  it("refuses to save two groups that claim the same label", async () => {
    const api = client();
    await openEditor(api);
    // 枚举在线上是名字，下拉框的 value 就是那个名字。
    fireEvent.change(screen.getByLabelText("主来源"), {
      target: { value: GithubStatusSource.LABEL },
    });
    const labels = await screen.findAllByLabelText("精确标签名");
    expect(labels.length).toBe(2);
    for (const field of labels)
      fireEvent.change(field, { target: { value: "bug" } });
    fireEvent.click(screen.getByText("保存映射"));
    expect(await screen.findByText("有两个分组用了同一个标签名")).toBeTruthy();
    // Nothing was sent: the mapping would have made every Issue's group
    // ambiguous.
    expect(api.putStatusMapping).not.toHaveBeenCalled();
  });

  it("saves against the revision it read", async () => {
    const api = client();
    await openEditor(api);
    // 枚举在线上是名字，下拉框的 value 就是那个名字。
    fireEvent.change(screen.getByLabelText("主来源"), {
      target: { value: GithubStatusSource.LABEL },
    });
    const labels = await screen.findAllByLabelText("精确标签名");
    fireEvent.change(labels[0]!, { target: { value: "todo" } });
    fireEvent.change(labels[1]!, { target: { value: "done" } });
    fireEvent.click(screen.getByText("保存映射"));
    await waitFor(() => expect(api.putStatusMapping).toHaveBeenCalled());
    const sent = firstCall<{
      expectedRevision: bigint;
      mapping: { source: string; groups: { label: string }[] };
    }>(api.putStatusMapping);
    expect(sent.expectedRevision).toBe(7n);
    expect(sent.mapping.source).toBe(GithubStatusSource.LABEL);
    expect(sent.mapping.groups.map((group) => group.label)).toEqual([
      "todo",
      "done",
    ]);
  });

  it("lists the Host's own refusal codes when it rejects the configuration", async () => {
    const api = client({
      putStatusMapping: vi.fn(async () => {
        throw new GithubApiError("invalid");
      }),
    });
    await openEditor(api);
    // 枚举在线上是名字，下拉框的 value 就是那个名字。
    fireEvent.change(screen.getByLabelText("主来源"), {
      target: { value: GithubStatusSource.LABEL },
    });
    const labels = await screen.findAllByLabelText("精确标签名");
    fireEvent.change(labels[0]!, { target: { value: "todo" } });
    fireEvent.change(labels[1]!, { target: { value: "done" } });
    fireEvent.click(screen.getByText("保存映射"));
    // The code does not survive the transport, so every documented reason is
    // shown verbatim rather than one of them being guessed at.
    expect(await screen.findByText("MAPPING_CYCLE")).toBeTruthy();
    expect(screen.getByText("GROUP_LABEL_DUPLICATE")).toBeTruthy();
  });

  it("shows a read-only device the configuration and no save control", async () => {
    const api = client();
    await openEditor(api, false);
    expect(screen.getByText("这台设备只读，可以看配置，不能保存")).toBeTruthy();
    expect(screen.queryByText("保存映射")).toBeNull();
    expect(screen.queryByText("添加分组")).toBeNull();
  });
});

describe("linking an issue to a session", () => {
  async function openIssue(api: ReturnType<typeof client>, canWrite = true) {
    ready(api, canWrite);
    renderDrawer();
    await resolveRepository();
    fireEvent.click(await screen.findByText("打开详情"));
    return screen.findByText("关联");
  }

  it("links the issue to the session that was chosen", async () => {
    const api = client();
    await openIssue(api);
    fireEvent.change(screen.getByLabelText("关联目标"), {
      target: { value: "session:node-1" },
    });
    fireEvent.click(screen.getByText("建立关联"));
    await waitFor(() => expect(api.linkReference).toHaveBeenCalled());
    const sent = firstCall<{
      expectedRevision: bigint;
      reference: {
        kind: number;
        number: bigint;
        targetKind: number;
        targetId: string;
        title: string;
      };
    }>(api.linkReference);
    expect(sent.expectedRevision).toBe(0n);
    // The remote title travels with the link so the badge reads offline.
    expect(sent.reference).toMatchObject({
      kind: GithubReferenceKind.ISSUE,
      number: 12n,
      targetKind: GithubReferenceTargetKind.SESSION,
      targetId: "node-1",
      title: "Broken import",
    });
  });

  it("reports a second link of the same pair as already linked", async () => {
    const api = client({
      linkReference: vi.fn(async () => {
        throw new GithubApiError("conflict");
      }),
    });
    await openIssue(api);
    fireEvent.change(screen.getByLabelText("关联目标"), {
      target: { value: "session:node-1" },
    });
    fireEvent.click(screen.getByText("建立关联"));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("这个目标已经关联过了"),
    );
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("unlinks against the revision it displayed", async () => {
    const api = client({
      getIssue: vi.fn(async () => ({
        issue,
        comments: [],
        references: [reference],
        pollIntervalMs: 60_000n,
      })),
    });
    await openIssue(api);
    fireEvent.click(await screen.findByText("取消关联"));
    await waitFor(() =>
      expect(api.unlinkReference).toHaveBeenCalledWith({
        referenceId: "reference-1",
        expectedRevision: 2n,
      }),
    );
  });

  it("gives a read-only device no link or unlink control", async () => {
    const api = client({
      getIssue: vi.fn(async () => ({
        issue,
        comments: [],
        references: [reference],
        pollIntervalMs: 60_000n,
      })),
    });
    await openIssue(api, false);
    expect(await screen.findByText("node-1")).toBeTruthy();
    expect(screen.queryByText("建立关联")).toBeNull();
    expect(screen.queryByText("取消关联")).toBeNull();
    expect(screen.queryByLabelText("关联目标")).toBeNull();
  });
});

describe("merging a pull request", () => {
  async function openPull(api: ReturnType<typeof client>) {
    ready(api);
    renderDrawer();
    await resolveRepository();
    selectTab("Pull requests");
    fireEvent.click(await screen.findByText("打开详情"));
  }

  it("names the exact head it will merge and passes it with the rollup", async () => {
    const api = client();
    await openPull(api);
    // The button itself carries the head, so nobody merges "whatever is newest".
    expect(
      await screen.findByText(`合并 · ${HEAD_SHA.slice(0, 12)}`),
    ).toBeTruthy();
    fireEvent.click(screen.getByText(`合并 · ${HEAD_SHA.slice(0, 12)}`));
    expect(await screen.findByText("按这个 head 合并？")).toBeTruthy();
    expect(api.mergePull).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByText("合并").at(-1)!);
    await waitFor(() =>
      expect(api.mergePull).toHaveBeenCalledWith({
        repository: ref,
        number: 34n,
        expectedHeadSha: HEAD_SHA,
        method: GithubMergeMethod.SQUASH,
        expectedCheckRollup: GithubCheckConclusion.SUCCESS,
      }),
    );
  });

  it("reports a refusal with the Host's own code instead of a success", async () => {
    const api = client({
      mergePull: vi.fn(async () => ({
        merged: false,
        mergeSha: "",
        reasonCode: "HEAD_MOVED",
      })),
    });
    await openPull(api);
    fireEvent.click(await screen.findByText(`合并 · ${HEAD_SHA.slice(0, 12)}`));
    fireEvent.click(screen.getAllByText("合并").at(-1)!);
    expect(await screen.findByText(/HEAD_MOVED/)).toBeTruthy();
    expect(screen.queryByText(/^已合并/)).toBeNull();
  });

  it("offers no merge or review controls to a read-only device", async () => {
    const api = client();
    ready(api, false);
    renderDrawer();
    await resolveRepository();
    selectTab("Pull requests");
    fireEvent.click(await screen.findByText("打开详情"));
    expect(await screen.findByText("Fix the import")).toBeTruthy();
    expect(screen.queryByText(/^合并/)).toBeNull();
    expect(screen.queryByText("Approve")).toBeNull();
  });
});

const PATCH = [
  "@@ -10,3 +10,3 @@",
  " \tsetup()",
  "-\told()",
  "+\tfresh()",
].join("\n");

const changedFile = {
  $typeName: "armadra.v1.GithubPullFile" as const,
  path: "api.go",
  previousPath: "",
  status: "modified",
  additions: 1n,
  deletions: 1n,
  binary: false,
  patch: PATCH,
};

async function openPullDetail(api: ReturnType<typeof client>, write = true) {
  ready(api, write);
  renderDrawer();
  await resolveRepository();
  selectTab("Pull requests");
  fireEvent.click(await screen.findByText("打开详情"));
  await screen.findByText("Fix the import");
}

describe("inline review comments", () => {
  const detail = (overrides: Record<string, unknown> = {}) => ({
    pull,
    files: [changedFile],
    reviews: [],
    reviewComments: [],
    comments: [],
    checks,
    references: [],
    pollIntervalMs: 60_000n,
    ...overrides,
  });

  it("submits a line comment with the path, line and side the reviewer clicked", async () => {
    const api = client({ getPull: vi.fn(async () => detail()) });
    await openPullDetail(api);
    fireEvent.click(screen.getByText("api.go"));
    // The added line is line 11 on the head side, per the hunk header.
    const entry = await waitFor(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-line="11"][data-side="RIGHT"] [data-slot="github-inline-comment"]',
      );
      if (!row) throw new Error("no inline entry yet");
      return row;
    });
    fireEvent.click(entry);
    const editor = await screen.findByLabelText("行内评论内容");
    fireEvent.change(editor, { target: { value: "这里要判空" } });
    fireEvent.click(screen.getByText("Comment"));
    await waitFor(() =>
      expect(api.submitReview).toHaveBeenCalledWith(
        expect.objectContaining({
          commitSha: HEAD_SHA,
          comments: [
            expect.objectContaining({
              path: "api.go",
              line: 11n,
              side: "RIGHT",
              body: "这里要判空",
            }),
          ],
        }),
      ),
    );
  });

  it("anchors a comment on a removed line to the base side", async () => {
    const api = client({ getPull: vi.fn(async () => detail()) });
    await openPullDetail(api);
    fireEvent.click(screen.getByText("api.go"));
    const entry = await waitFor(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-line="11"][data-side="LEFT"] [data-slot="github-inline-comment"]',
      );
      if (!row) throw new Error("no inline entry yet");
      return row;
    });
    fireEvent.click(entry);
    expect(
      document.querySelector(
        '[data-slot="github-inline-draft"][data-side="LEFT"]',
      ),
    ).toBeTruthy();
  });

  it("never draws an outdated comment on a line of the current diff", async () => {
    const api = client({
      getPull: vi.fn(async () =>
        detail({
          reviewComments: [
            {
              $typeName: "armadra.v1.GithubReviewComment" as const,
              id: 5n,
              body: "旧位置的意见",
              path: "api.go",
              commitSha: "d".repeat(40),
              line: 11n,
              side: "RIGHT",
              outdated: true,
              createdAtUnixMs: 0n,
            },
          ],
        }),
      ),
    });
    await openPullDetail(api);
    fireEvent.click(
      document.querySelector<HTMLElement>('[data-path="api.go"] button')!,
    );
    expect(await screen.findByText(/位置已经对不上/)).toBeTruthy();
    // It is listed once, in the outdated block, and never inside the diff.
    expect(
      document.querySelector('[data-slot="github-diff"] table')?.textContent,
    ).not.toContain("旧位置的意见");
  });

  it("offers no inline entry where there is no patch to anchor to", async () => {
    const api = client({
      getPull: vi.fn(async () =>
        detail({ files: [{ ...changedFile, patch: "" }] }),
      ),
    });
    await openPullDetail(api);
    expect(await screen.findByText(/因此没有行内入口/)).toBeTruthy();
    expect(
      document.querySelector('[data-slot="github-inline-comment"]'),
    ).toBeNull();
  });
});

describe("re-running checks", () => {
  const failing = githubCheckSummary({
    headSha: HEAD_SHA,
    rollup: GithubCheckConclusion.FAILURE,
    runs: [
      githubCheckRun({
        name: "build",
        app: "GitHub Actions",
        conclusion: GithubCheckConclusion.FAILURE,
        rerunnable: true,
        workflowRunId: 77n,
      }),
      githubCheckRun({
        name: "lint",
        app: "other",
        conclusion: GithubCheckConclusion.FAILURE,
        rerunnable: false,
      }),
    ],
  });

  it("sends the head on screen and only for a run the remote can restart", async () => {
    const api = client({
      getPull: vi.fn(async () => ({
        pull,
        files: [],
        reviews: [],
        reviewComments: [],
        comments: [],
        checks: failing,
        references: [],
        pollIntervalMs: 60_000n,
      })),
      rerunChecks: vi.fn(async () => ({
        outcomes: [
          {
            actionId: "rerun:77",
            target: "workflow_run",
            state: GithubWriteState.APPLIED,
          },
        ],
        reasonCode: "",
        checks: failing,
      })),
    });
    await openPullDetail(api);
    // Only the Actions run gets a button; the other producer has no endpoint.
    const buttons = document.querySelectorAll('[data-slot="github-rerun"]');
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.getAttribute("data-check")).toBe("build");
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(api.rerunChecks).toHaveBeenCalledWith({
        repository: ref,
        number: 34n,
        expectedHeadSha: HEAD_SHA,
        checkName: "build",
        failedOnly: true,
      }),
    );
    expect(await screen.findByText(/已请求重跑 1 个/)).toBeTruthy();
  });

  it("says nothing was restarted rather than implying it was", async () => {
    const api = client({
      getPull: vi.fn(async () => ({
        pull,
        files: [],
        reviews: [],
        reviewComments: [],
        comments: [],
        checks: failing,
        references: [],
        pollIntervalMs: 60_000n,
      })),
      rerunChecks: vi.fn(async () => ({
        outcomes: [],
        reasonCode: "HEAD_MOVED",
        checks: failing,
      })),
    });
    await openPullDetail(api);
    fireEvent.click(document.querySelector('[data-slot="github-rerun"]')!);
    expect(await screen.findByText(/HEAD_MOVED/)).toBeTruthy();
  });

  it("shows no rerun affordance at all when nothing exposes one", async () => {
    const api = client();
    await openPullDetail(api);
    await screen.findByText("Fix the import");
    expect(document.querySelector('[data-slot="github-rerun"]')).toBeNull();
  });
});

describe("cleaning up after a merge", () => {
  const merged = githubPullRequest({
    ...pull,
    state: GithubPullState.MERGED,
    mergedAtUnixMs: 1_788_557_900_000n,
  });
  const mergedDetail = {
    pull: merged,
    files: [],
    reviews: [],
    reviewComments: [],
    comments: [],
    checks,
    references: [],
    pollIntervalMs: 60_000n,
  };

  it("is not offered before the pull request is actually merged", async () => {
    const api = client();
    await openPullDetail(api);
    expect(document.querySelector('[data-slot="github-cleanup"]')).toBeNull();
  });

  it("deletes the remote branch under the exact SHA on screen, after a confirmation", async () => {
    const api = client({
      getPull: vi.fn(async () => mergedDetail),
      deleteBranch: vi.fn(async () => ({ deleted: true, reasonCode: "" })),
    });
    await openPullDetail(api);
    fireEvent.click(
      await screen.findByText(`删除远端分支 · ${merged.headRef}`),
    );
    expect(await screen.findByText("删除远端分支？")).toBeTruthy();
    expect(api.deleteBranch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认"));
    await waitFor(() =>
      expect(api.deleteBranch).toHaveBeenCalledWith({
        repository: ref,
        branch: "fix/import",
        expectedSha: HEAD_SHA,
      }),
    );
    expect(await screen.findByText("远端分支已删除")).toBeTruthy();
  });

  it("reports the Host's refusal instead of claiming a deletion", async () => {
    const api = client({
      getPull: vi.fn(async () => mergedDetail),
      deleteBranch: vi.fn(async () => ({
        deleted: false,
        reasonCode: "REF_MOVED",
      })),
    });
    await openPullDetail(api);
    fireEvent.click(
      await screen.findByText(`删除远端分支 · ${merged.headRef}`),
    );
    fireEvent.click(screen.getByText("确认"));
    expect(await screen.findByText(/REF_MOVED/)).toBeTruthy();
    expect(screen.queryByText("远端分支已删除")).toBeNull();
  });

  it("does not offer to delete a fork's branch", async () => {
    const fork = githubPullRequest({
      ...merged,
      fromFork: true,
      headRepoFullName: "someone/armadra",
    });
    const api = client({
      getPull: vi.fn(async () => ({ ...mergedDetail, pull: fork })),
    });
    await openPullDetail(api);
    expect(await screen.findByText(/head 分支在 fork 仓库里/)).toBeTruthy();
    expect(
      document.querySelector('[data-slot="github-delete-branch"]'),
    ).toBeNull();
  });

  it("keeps removing the checkout separate, and refuses a dirty one", async () => {
    vi.mocked(runtimeApi.gitRepositoryWorktrees).mockResolvedValue([
      {
        path: "/tmp/fix-import",
        branch: "fix/import",
        headOid: "e".repeat(40),
        isMain: false,
        bare: false,
        locked: false,
        prunable: false,
        accessible: true,
        dirty: true,
        lockReason: null,
        pruneReason: null,
      },
    ] as never);
    const api = client({ getPull: vi.fn(async () => mergedDetail) });
    await openPullDetail(api);
    const remove = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-slot="github-remove-worktree"]',
      );
      if (!button) throw new Error("no removal button yet");
      return button;
    });
    // A checkout with uncommitted work is never removed from here.
    expect(remove.disabled).toBe(true);
    expect(await screen.findByText(/不能安全移除/)).toBeTruthy();
    expect(runtimeApi.gitRepositoryOperate).not.toHaveBeenCalled();
  });
});
