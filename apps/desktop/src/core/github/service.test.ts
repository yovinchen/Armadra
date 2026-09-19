import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CommentGithubIssueRequestSchema,
  CreateGithubIssueRequestSchema,
  GetGithubIssueRequestSchema,
  GithubIssueState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubRepositoryRefSchema,
  GithubExternalReferenceSchema,
  GithubStatusGroupSchema,
  GithubStatusMappingSchema,
  GithubStatusSource,
  GithubWriteState,
  LinkGithubReferenceRequestSchema,
  ListGithubIssuesRequestSchema,
  ListGithubReferencesRequestSchema,
  MoveGithubIssueRequestSchema,
  SetGithubIssueStateRequestSchema,
  UnlinkGithubReferenceRequestSchema,
  create,
} from "@armadra/protocol";

import { githubError } from "./errors";
import { configureToken, githubFixture, type GithubFixture } from "./fixture";
import {
  commentIssue,
  createIssue,
  getIssue,
  listIssues,
  moveIssue,
  resolveRepository,
  setIssueState,
} from "./issues";
import {
  linkReference,
  listReferences,
  unlinkReference,
} from "./references";
import { getStatusMapping, putStatusMapping } from "./status";
import { scope } from "../identity/scopes";
import { encodeMapping, referenceId } from "./service";

const REF = create(GithubRepositoryRefSchema, {
  owner: "octo",
  name: "repo",
});

function issueJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    node_id: "I_1",
    number: 7,
    title: "An issue",
    body: "body text",
    state: "open",
    user: { login: "octocat", id: 5 },
    labels: [{ name: "todo", color: "ffffff" }],
    comments: 2,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    html_url: "https://github.com/octo/repo/issues/7",
    ...overrides,
  };
}

/** 移植自 `apps/host/internal/githubhost/service_test.go`。 */
describe("GitHub 服务", () => {
  let fixture: GithubFixture;

  beforeEach(async () => {
    fixture = await githubFixture();
    await configureToken(fixture);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("没有 github:read 的会话读不到任何东西", async () => {
    const readOnlyOther = {
      ...fixture.caller,
      scopes: [scope("canvas:read", "ws-1", "host-1")],
    };
    await expect(
      listIssues(
        fixture.service,
        readOnlyOther,
        create(ListGithubIssuesRequestSchema, { repository: REF }),
      ),
    ).rejects.toThrow(githubError("permission").message);
  });

  it("另一个工作空间的授权不满足这个工作空间的请求", async () => {
    const elsewhere = {
      ...fixture.caller,
      scopes: [scope("github:read", "ws-2", "host-1")],
    };
    await expect(
      listIssues(
        fixture.service,
        elsewhere,
        create(ListGithubIssuesRequestSchema, { repository: REF }),
      ),
    ).rejects.toThrow(githubError("permission").message);
  });

  it("属于另一个服务的 remote 不发任何请求就报不匹配", async () => {
    const before = fixture.github.requests.length;
    const result = await resolveRepository(
      fixture.service,
      fixture.caller,
      "git@git.example.com:team/repo.git",
    );
    expect(result.hostMismatch).toBe(true);
    expect(result.reasonCode).toBe("REMOTE_HOST_NOT_CONFIGURED");
    // 刻意没有仓库：报一个出来就意味着已经拿它去问过某个服务了。
    expect(result.repository).toBeUndefined();
    expect(fixture.github.requests.length).toBe(before);
  });

  it("解析不了的 remote 报原因码，而不是抛错", async () => {
    const result = await resolveRepository(
      fixture.service,
      fixture.caller,
      "not a url",
    );
    expect(result.reasonCode).toBe("REMOTE_INVALID");
  });

  it("Issue 列表滤掉 PR，并按配置好的标签分组标注", async () => {
    fixture.service.store.putStatusMapping(
      {
        workspaceId: "ws-1",
        repository: {
          owner: "octo",
          name: "repo",
          apiBase: "https://api.github.com",
          webHost: "github.com",
        },
        mapping: encodeLabelMapping(),
        revision: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      0,
    );
    fixture.github.route("GET /repos/octo/repo/issues", {
      body: [
        issueJson(),
        issueJson({ number: 8, pull_request: { url: "..." } }),
      ],
      headers: {
        link: '<https://api.github.com/repos/octo/repo/issues?page=2>; rel="next"',
      },
    });
    const result = await listIssues(
      fixture.service,
      fixture.caller,
      create(ListGithubIssuesRequestSchema, { repository: REF }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.number).toBe(7n);
    expect(result.issues[0]?.statusGroupId).toBe("todo");
    expect(result.nextCursor).toBe("2");
    expect(result.hasMore).toBe(true);
    expect(result.pollIntervalMs).toBe(30_000n);
  });

  it("详情带上评论和指着它的本地连接", async () => {
    fixture.github.route("GET /repos/octo/repo/issues/7", {
      body: issueJson(),
    });
    fixture.github.route("GET /repos/octo/repo/issues/7/comments", {
      body: [
        {
          id: 11,
          user: { login: "reviewer", id: 6 },
          body: "a comment",
          created_at: "2026-09-02T01:00:00Z",
        },
      ],
    });
    linkReference(
      fixture.service,
      fixture.caller,
      create(LinkGithubReferenceRequestSchema, {
        reference: create(GithubExternalReferenceSchema, {
          repository: REF,
          kind: GithubReferenceKind.ISSUE,
          number: 7n,
          targetKind: GithubReferenceTargetKind.SESSION,
          targetId: "session-1",
          title: "working on it",
        }),
      }),
    );
    const result = await getIssue(
      fixture.service,
      fixture.caller,
      create(GetGithubIssueRequestSchema, { repository: REF, number: 7n }),
    );
    expect(result.comments).toHaveLength(1);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.targetId).toBe("session-1");
  });

  it("创建 Issue 会拒绝空标题与过长的正文", async () => {
    await expect(
      createIssue(
        fixture.service,
        fixture.caller,
        create(CreateGithubIssueRequestSchema, { repository: REF, title: "" }),
      ),
    ).rejects.toThrow(githubError("invalid").message);
    await expect(
      createIssue(
        fixture.service,
        fixture.caller,
        create(CreateGithubIssueRequestSchema, {
          repository: REF,
          title: "ok",
          body: "x".repeat(65_537),
        }),
      ),
    ).rejects.toThrow(githubError("invalid").message);
  });

  it("评论要非空正文", async () => {
    await expect(
      commentIssue(
        fixture.service,
        fixture.caller,
        create(CommentGithubIssueRequestSchema, {
          repository: REF,
          number: 7n,
          body: "",
        }),
      ),
    ).rejects.toThrow(githubError("invalid").message);
  });

  it("远端在写之前动过就冲突，一个字节都不写出去", async () => {
    fixture.github.route("GET /repos/octo/repo/issues/7", {
      body: issueJson({ updated_at: "2026-09-03T00:00:00Z" }),
    });
    await expect(
      setIssueState(
        fixture.service,
        fixture.caller,
        create(SetGithubIssueStateRequestSchema, {
          repository: REF,
          number: 7n,
          state: GithubIssueState.CLOSED,
          expectedUpdatedAtUnixMs: BigInt(
            Date.parse("2026-09-02T00:00:00Z"),
          ),
        }),
      ),
    ).rejects.toThrow(githubError("conflict").message);
    expect(
      fixture.github.requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(0);
  });

  it("关闭一条 Issue 会发 PATCH，并带上状态原因", async () => {
    fixture.github.route("GET /repos/octo/repo/issues/7", {
      body: issueJson(),
    });
    fixture.github.route("PATCH /repos/octo/repo/issues/7", {
      body: issueJson({ state: "closed", state_reason: "completed" }),
    });
    const issue = await setIssueState(
      fixture.service,
      fixture.caller,
      create(SetGithubIssueStateRequestSchema, {
        repository: REF,
        number: 7n,
        state: GithubIssueState.CLOSED,
        reason: 1, // COMPLETED
        expectedUpdatedAtUnixMs: BigInt(Date.parse("2026-09-02T00:00:00Z")),
      }),
    );
    expect(issue.state).toBe(GithubIssueState.CLOSED);
    const patch = fixture.github.requests.find((r) => r.method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({
      state: "closed",
      state_reason: "completed",
    });
  });

  it("分组移动只碰这份映射管着的标签", async () => {
    const stored = putStatusMapping(
      fixture.service,
      fixture.caller,
      labelMapping(),
      0n,
    );
    fixture.github.route("GET /repos/octo/repo/issues/7", {
      body: issueJson({ labels: [{ name: "todo" }, { name: "keep-me" }] }),
    });
    fixture.github.route("PATCH /repos/octo/repo/issues/7", {
      body: issueJson({ labels: [{ name: "doing" }, { name: "keep-me" }] }),
    });
    const result = await moveIssue(
      fixture.service,
      fixture.caller,
      create(MoveGithubIssueRequestSchema, {
        repository: REF,
        number: 7n,
        toGroupId: "doing",
        expectedMappingRevision: stored.revision,
        expectedUpdatedAtUnixMs: BigInt(Date.parse("2026-09-02T00:00:00Z")),
      }),
    );
    expect(result.outcomes[0]?.state).toBe(GithubWriteState.APPLIED);
    const patch = fixture.github.requests.find((r) => r.method === "PATCH");
    // `keep-me` 不归这份映射管，原样留着。
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({
      labels: ["keep-me", "doing"],
    });
  });

  it("面板底下被改掉的映射会停下这次移动", async () => {
    putStatusMapping(fixture.service, fixture.caller, labelMapping(), 0n);
    await expect(
      moveIssue(
        fixture.service,
        fixture.caller,
        create(MoveGithubIssueRequestSchema, {
          repository: REF,
          number: 7n,
          toGroupId: "doing",
          expectedMappingRevision: 99n,
        }),
      ),
    ).rejects.toThrow(githubError("conflict").message);
  });

  it("没配过的仓库读到一份 revision 为零的 NONE 映射", () => {
    const mapping = getStatusMapping(fixture.service, fixture.caller, REF);
    expect(mapping.source).toBe(GithubStatusSource.NONE);
    expect(mapping.revision).toBe(0n);
  });

  it("映射写回要 revision CAS", () => {
    const first = putStatusMapping(
      fixture.service,
      fixture.caller,
      labelMapping(),
      0n,
    );
    expect(first.revision).toBe(1n);
    expect(() =>
      putStatusMapping(fixture.service, fixture.caller, labelMapping(), 0n),
    ).toThrow(githubError("conflict").message);
  });

  it("把同一个 Issue 连到同一个目标两次是同一条记录", () => {
    const request = create(LinkGithubReferenceRequestSchema, {
      reference: create(GithubExternalReferenceSchema, {
        repository: REF,
        kind: GithubReferenceKind.ISSUE,
        number: 7n,
        targetKind: GithubReferenceTargetKind.BRANCH,
        targetId: "feature/x",
        title: "一",
      }),
    });
    const first = linkReference(fixture.service, fixture.caller, request);
    const second = create(LinkGithubReferenceRequestSchema, {
      reference: create(GithubExternalReferenceSchema, {
        repository: REF,
        kind: GithubReferenceKind.ISSUE,
        number: 7n,
        targetKind: GithubReferenceTargetKind.BRANCH,
        targetId: "feature/x",
        title: "二",
      }),
      expectedRevision: first.revision,
    });
    const updated = linkReference(fixture.service, fixture.caller, second);
    expect(updated.referenceId).toBe(first.referenceId);
    expect(updated.revision).toBe(2n);
    expect(updated.title).toBe("二");
    const listed = listReferences(
      fixture.service,
      fixture.caller,
      create(ListGithubReferencesRequestSchema, {}),
    );
    expect(listed.references).toHaveLength(1);
  });

  it("取消连接要 revision，删掉之后列表就空了", () => {
    const linked = linkReference(
      fixture.service,
      fixture.caller,
      create(LinkGithubReferenceRequestSchema, {
        reference: create(GithubExternalReferenceSchema, {
          repository: REF,
          kind: GithubReferenceKind.PULL_REQUEST,
          number: 3n,
          targetKind: GithubReferenceTargetKind.WORKTREE,
          targetId: "/tmp/wt",
        }),
      }),
    );
    expect(() =>
      unlinkReference(
        fixture.service,
        fixture.caller,
        create(UnlinkGithubReferenceRequestSchema, {
          referenceId: linked.referenceId,
          expectedRevision: 0n,
        }),
      ),
    ).toThrow(githubError("invalid").message);
    const result = unlinkReference(
      fixture.service,
      fixture.caller,
      create(UnlinkGithubReferenceRequestSchema, {
        referenceId: linked.referenceId,
        expectedRevision: linked.revision,
      }),
    );
    expect(result.unlinked).toBe(true);
    expect(
      listReferences(
        fixture.service,
        fixture.caller,
        create(ListGithubReferencesRequestSchema, {}),
      ).references,
    ).toHaveLength(0);
  });

  it("连接标识由含义导出，目标里的分隔符不会撞车", () => {
    const ref = create(GithubRepositoryRefSchema, {
      owner: "octo",
      name: "repo",
      apiBase: "https://api.github.com",
      host: "github.com",
    });
    const left = referenceId(
      "ws-1",
      ref,
      GithubReferenceKind.ISSUE,
      7n,
      GithubReferenceTargetKind.SESSION,
      "a b",
    );
    const right = referenceId(
      "ws-1",
      ref,
      GithubReferenceKind.ISSUE,
      7n,
      GithubReferenceTargetKind.SESSION,
      "a  b",
    );
    expect(left).not.toBe(right);
    expect(left).toHaveLength(32);
  });
});

function labelMapping() {
  return create(GithubStatusMappingSchema, {
    repository: REF,
    source: GithubStatusSource.LABEL,
    groups: [
      create(GithubStatusGroupSchema, {
        id: "todo",
        title: "待办",
        label: "todo",
      }),
      create(GithubStatusGroupSchema, {
        id: "doing",
        title: "进行中",
        label: "doing",
      }),
    ],
  });
}

function encodeLabelMapping(): Uint8Array {
  // 直接走域自己的编码，这样存进去的字节和 `putStatusMapping` 写的一样。
  return encodeMapping(labelMapping());
}
