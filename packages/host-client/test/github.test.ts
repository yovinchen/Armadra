import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  GetGithubPullResponseSchema,
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubCredentialStatusSchema,
  GithubExternalReferenceSchema,
  GithubIssuePatchSchema,
  GithubIssueSchema,
  GithubReviewSchema,
  GithubIssueState,
  GithubMergeMethod,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubRepositoryRefSchema,
  GithubReviewState,
  GithubStatusMappingSchema,
  GithubStatusSource,
  ListGithubIssuesResponseSchema,
  ListGithubReferencesResponseSchema,
  MergeGithubPullRequestSchema,
  MergeGithubPullResponseSchema,
  MoveGithubIssueRequestSchema,
  MoveGithubIssueResponseSchema,
  ResolveGithubRepositoryResponseSchema,
  SubmitGithubReviewRequestSchema,
  UpdateGithubIssueRequestSchema,
  GithubWriteState,
} from "@armadra/protocol";
import {
  HostGithubClient,
  HostGithubError,
  classifyGithubFailure,
} from "../src/github/index.js";
import type { HostAuthenticatedTransport } from "../src/automation.js";
import { HostIdentityError } from "../src/identity.js";

const hostId = "1".repeat(32);
const workspaceId = "workspace-1";
const headSha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const repository = create(GithubRepositoryRefSchema, {
  owner: "owner",
  name: "repo",
  apiBase: "https://ghe.example.com/api/v3",
  host: "ghe.example.com",
});

interface Sent {
  service: string;
  action: string;
  body: Uint8Array;
  mutation: boolean;
}

function client(reply: (call: Sent) => Uint8Array | Promise<Uint8Array>) {
  const calls: Sent[] = [];
  const session: HostAuthenticatedTransport = {
    send: (service, action, body, mutation) => {
      const call = { service, action, body, mutation };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
  return { api: new HostGithubClient({ session, hostId, workspaceId }), calls };
}

function issueWire(overrides: Record<string, unknown> = {}): Uint8Array {
  return new Uint8Array(
    toBinary(
      GithubIssueSchema,
      create(GithubIssueSchema, {
        repository,
        number: 7n,
        title: "修复上传",
        state: GithubIssueState.OPEN,
        updatedAtUnixMs: 1788557900000n,
        ...overrides,
      }),
    ),
  );
}

describe("HostGithubClient", () => {
  it("refuses a repository this transport cannot safely address", () => {
    const { api } = client(() => new Uint8Array());
    for (const bad of [
      { ...repository, apiBase: "http://ghe.example.com/api/v3" },
      { ...repository, apiBase: "https://user:pw@ghe.example.com/api" },
      { ...repository, owner: "" },
      { ...repository, name: "../etc" },
      { ...repository, host: "" },
    ]) {
      expect(() => api.listIssues({ repository: bad })).toThrow(
        HostGithubError,
      );
    }
  });

  // The panel shows Issues under one repository's tab. Rendering another
  // repository's Issues there would be worse than an error.
  it("rejects a listing that answers about a different repository", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            ListGithubIssuesResponseSchema,
            create(ListGithubIssuesResponseSchema, {
              issues: [
                {
                  repository: { ...repository, name: "other" },
                  number: 7n,
                  title: "x",
                },
              ],
            }),
          ),
        ),
    );
    await expect(api.listIssues({ repository })).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("sends the displayed updatedAt and mapping revision with a move", async () => {
    const { api, calls } = client(
      () =>
        new Uint8Array(
          toBinary(
            MoveGithubIssueResponseSchema,
            create(MoveGithubIssueResponseSchema, {
              outcomes: [
                {
                  actionId: "labels",
                  target: "labels",
                  state: GithubWriteState.APPLIED,
                },
              ],
            }),
          ),
        ),
    );
    await api.moveIssue({
      repository,
      number: 7n,
      toGroupId: "done",
      fromGroupId: "todo",
      expectedUpdatedAtUnixMs: 1788557900000n,
      expectedMappingRevision: 4n,
    });
    const sent = fromBinary(MoveGithubIssueRequestSchema, calls[0]!.body);
    expect(calls[0]!.mutation).toBe(true);
    expect(sent.expectedUpdatedAtUnixMs).toBe(1788557900000n);
    expect(sent.expectedMappingRevision).toBe(4n);
    expect(sent.fromGroupId).toBe("todo");
  });

  // Every move writes something. A response with no outcomes would let the
  // panel show a silent success it has no evidence for.
  it("rejects a move that reports no outcome at all", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            MoveGithubIssueResponseSchema,
            create(MoveGithubIssueResponseSchema, {}),
          ),
        ),
    );
    await expect(
      api.moveIssue({
        repository,
        number: 7n,
        toGroupId: "done",
        expectedUpdatedAtUnixMs: 1n,
        expectedMappingRevision: 1n,
      }),
    ).rejects.toMatchObject({ failure: "response" });
  });

  it("binds a merge to the head SHA and the rollup the reader saw", async () => {
    const { api, calls } = client(
      () =>
        new Uint8Array(
          toBinary(
            MergeGithubPullResponseSchema,
            create(MergeGithubPullResponseSchema, {
              merged: true,
              mergeSha: "1".repeat(40),
            }),
          ),
        ),
    );
    await api.mergePull({
      repository,
      number: 9n,
      expectedHeadSha: headSha,
      method: GithubMergeMethod.SQUASH,
      expectedCheckRollup: GithubCheckConclusion.SUCCESS,
    });
    const sent = fromBinary(MergeGithubPullRequestSchema, calls[0]!.body);
    expect(sent.expectedHeadSha).toBe(headSha);
    expect(sent.expectedCheckRollup).toBe(GithubCheckConclusion.SUCCESS);
    // A short SHA would name something other than exactly the head displayed.
    expect(() =>
      api.mergePull({
        repository,
        number: 9n,
        expectedHeadSha: "9fceb02",
        method: GithubMergeMethod.SQUASH,
      }),
    ).toThrow(HostGithubError);
  });

  // "Not merged" must always say why, and a merge must produce a commit.
  it("rejects a merge result that is neither a success nor a reason", async () => {
    for (const value of [
      { merged: true },
      { merged: false, reasonCode: "" },
    ] as const) {
      const { api } = client(
        () =>
          new Uint8Array(
            toBinary(
              MergeGithubPullResponseSchema,
              create(MergeGithubPullResponseSchema, value),
            ),
          ),
      );
      await expect(
        api.mergePull({
          repository,
          number: 9n,
          expectedHeadSha: headSha,
          method: GithubMergeMethod.SQUASH,
        }),
      ).rejects.toMatchObject({ failure: "response" });
    }
  });

  // Checks for another commit answer a question nobody asked, and would sit
  // next to a merge button as though they described this head.
  it("rejects pull detail whose checks describe another commit", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            GetGithubPullResponseSchema,
            create(GetGithubPullResponseSchema, {
              pull: {
                repository,
                number: 9n,
                headSha,
                state: GithubPullState.OPEN,
              },
              checks: { headSha: "0".repeat(40) },
            }),
          ),
        ),
    );
    await expect(api.getPull({ repository, number: 9n })).rejects.toMatchObject(
      { failure: "response" },
    );
  });

  // A mismatch is an answer, not a repository: arriving with one would mean the
  // Host had asked some service about an enterprise repository.
  it("rejects a host mismatch that still carries a repository", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            ResolveGithubRepositoryResponseSchema,
            create(ResolveGithubRepositoryResponseSchema, {
              hostMismatch: true,
              repository: { ref: repository },
            }),
          ),
        ),
    );
    await expect(
      api.resolveRepository("https://github.com/owner/repo.git"),
    ).rejects.toMatchObject({ failure: "response" });
  });

  it("refuses a mapping whose groups collide or dangle", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            GithubStatusMappingSchema,
            create(GithubStatusMappingSchema, {
              repository,
              source: GithubStatusSource.LABEL,
              groups: [{ id: "todo", title: "待办", label: "status/todo" }],
              revision: 1n,
            }),
          ),
        ),
    );
    const base = { repository, source: GithubStatusSource.LABEL };
    for (const groups of [
      [
        { id: "a", label: "same" },
        { id: "b", label: "same" },
      ],
      [
        { id: "a", label: "x" },
        { id: "a", label: "y" },
      ],
    ]) {
      expect(() =>
        api.putStatusMapping({
          mapping: create(GithubStatusMappingSchema, {
            ...base,
            groups,
          }),
          expectedRevision: 0n,
        }),
      ).toThrow(HostGithubError);
    }
    // A coupling naming a group that does not exist cannot be acted on.
    expect(() =>
      api.putStatusMapping({
        mapping: create(GithubStatusMappingSchema, {
          ...base,
          groups: [{ id: "a", label: "x" }],
          stateGroups: [{ state: GithubIssueState.CLOSED, groupId: "missing" }],
        }),
        expectedRevision: 0n,
      }),
    ).toThrow(HostGithubError);
    // A well-formed mapping goes through.
    await expect(
      api.putStatusMapping({
        mapping: create(GithubStatusMappingSchema, {
          ...base,
          groups: [{ id: "todo", title: "待办", label: "status/todo" }],
        }),
        expectedRevision: 0n,
      }),
    ).resolves.toBeDefined();
  });

  // GitHub refuses an empty "request changes"; refusing here keeps the panel
  // from reporting a review it never submitted.
  it("requires a body when a review requests changes", async () => {
    const { api, calls } = client(
      () =>
        new Uint8Array(
          toBinary(GithubReviewSchema, create(GithubReviewSchema, { id: 1n })),
        ),
    );
    expect(() =>
      api.submitReview({
        repository,
        number: 9n,
        commitSha: headSha,
        state: GithubReviewState.CHANGES_REQUESTED,
        body: "   ",
      }),
    ).toThrow(HostGithubError);
    expect(calls.length).toBe(0);
  });

  it("only ever sends a token for the source that stores one", () => {
    const { api, calls } = client(() => new Uint8Array());
    expect(() =>
      api.configureCredential({
        source: GithubCredentialSource.GH_CLI,
        token: "gho_something",
        expectedRevision: 0n,
      }),
    ).toThrow(HostGithubError);
    expect(() =>
      api.configureCredential({
        source: GithubCredentialSource.TOKEN_REF,
        expectedRevision: 0n,
      }),
    ).toThrow(HostGithubError);
    // An http API base would put the token on the wire in clear text.
    expect(() =>
      api.configureCredential({
        source: GithubCredentialSource.TOKEN_REF,
        token: "gho_something",
        apiBase: "http://ghe.example.com/api/v3",
        expectedRevision: 0n,
      }),
    ).toThrow(HostGithubError);
    expect(calls.length).toBe(0);
  });

  // A status claiming to be usable with no source configured is a contradiction
  // the settings page must not repeat.
  it("rejects a self-contradicting credential status", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            GithubCredentialStatusSchema,
            create(GithubCredentialStatusSchema, {
              available: true,
              apiBase: "https://api.github.com",
              source: GithubCredentialSource.NONE,
            }),
          ),
        ),
    );
    await expect(api.getCredential()).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("keeps references inside this workspace", async () => {
    const { api } = client(
      () =>
        new Uint8Array(
          toBinary(
            ListGithubReferencesResponseSchema,
            create(ListGithubReferencesResponseSchema, {
              references: [
                {
                  referenceId: "r1",
                  workspaceId: "another-workspace",
                  repository,
                  kind: GithubReferenceKind.ISSUE,
                  number: 7n,
                  targetKind: GithubReferenceTargetKind.SESSION,
                  targetId: "node-1",
                  revision: 1n,
                },
              ],
            }),
          ),
        ),
    );
    await expect(api.listReferences()).rejects.toMatchObject({
      failure: "response",
    });
  });

  it("stamps this workspace onto every link it sends", async () => {
    const { api, calls } = client(
      () =>
        new Uint8Array(
          toBinary(
            GithubExternalReferenceSchema,
            create(GithubExternalReferenceSchema, {
              referenceId: "r1",
              workspaceId,
              repository,
              kind: GithubReferenceKind.PULL_REQUEST,
              number: 9n,
              targetKind: GithubReferenceTargetKind.WORKTREE,
              targetId: "worktree-1",
              revision: 1n,
            }),
          ),
        ),
    );
    const result = await api.linkReference({
      reference: create(GithubExternalReferenceSchema, {
        repository,
        workspaceId: "someone-elses",
        kind: GithubReferenceKind.PULL_REQUEST,
        number: 9n,
        targetKind: GithubReferenceTargetKind.WORKTREE,
        targetId: "worktree-1",
      }),
      expectedRevision: 0n,
    });
    expect(result.workspaceId).toBe(workspaceId);
    expect(calls[0]!.mutation).toBe(true);
  });

  // An update sends only what the caller actually changed.
  it("carries an absent patch field as absent, not as an empty string", async () => {
    const { api, calls } = client(() => issueWire());
    await api.updateIssue({
      repository,
      number: 7n,
      patch: create(GithubIssuePatchSchema, {
        replaceLabels: true,
        labels: ["status/done"],
      }),
      expectedUpdatedAtUnixMs: 1788557900000n,
    });
    const sent = fromBinary(UpdateGithubIssueRequestSchema, calls[0]!.body);
    expect(sent.patch?.body).toBeUndefined();
    expect(sent.patch?.replaceLabels).toBe(true);
    expect(sent.expectedUpdatedAtUnixMs).toBe(1788557900000n);
  });
});

describe("classifyGithubFailure", () => {
  // Waiting and re-authenticating are different repairs, so a rate limit is not
  // folded into a generic network failure.
  it("keeps each repair distinct", () => {
    const of = (hostCode: string) =>
      classifyGithubFailure(
        new HostIdentityError("REMOTE_ERROR", false, 400, hostCode),
      ).failure;
    expect(of("RESOURCE_EXHAUSTED")).toBe("rateLimited");
    expect(of("UNAUTHENTICATED")).toBe("unauthenticated");
    expect(of("PERMISSION_DENIED")).toBe("permission");
    expect(of("UNSUPPORTED")).toBe("unsupported");
    expect(of("CONFLICT")).toBe("conflict");
    expect(of("NOT_FOUND")).toBe("notFound");
    expect(of("INVALID_ARGUMENT")).toBe("invalid");
    // An unrecognised code is never softened into "invalid".
    expect(of("SOMETHING_NEW")).toBe("network");
  });

  // A write whose outcome was never read must make the caller reload.
  it("preserves an unknown outcome", () => {
    const error = classifyGithubFailure(
      new HostIdentityError("NETWORK_ERROR", true),
    );
    expect(error.outcomeUnknown).toBe(true);
    expect(error.failure).toBe("network");
  });
});
