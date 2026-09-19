import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CreateGithubPullRequestSchema,
  DeleteGithubBranchRequestSchema,
  GetGithubPullRequestSchema,
  GithubCheckConclusion,
  GithubCheckRunSchema,
  GithubCheckSummarySchema,
  GithubMergeMethod,
  GithubRepositoryRefSchema,
  GithubReviewState,
  ListGithubPullsRequestSchema,
  MergeGithubPullRequestSchema,
  RerunGithubChecksRequestSchema,
  SubmitGithubReviewRequestSchema,
  create,
} from "@armadra/protocol";

import { deleteBranch, rerunChecks, rerunTargets } from "./cleanup";
import { githubError } from "./errors";
import { configureToken, githubFixture, type GithubFixture } from "./fixture";
import {
  createPull,
  getPull,
  listPulls,
  mergePull,
  submitReview,
  validRef,
} from "./pulls";

const REF = create(GithubRepositoryRefSchema, { owner: "octo", name: "repo" });
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function pullJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    node_id: "PR_1",
    number: 3,
    title: "A pull request",
    body: "pull body",
    state: "open",
    user: { login: "octocat", id: 5 },
    base: { ref: "main", sha: OTHER_SHA },
    head: { ref: "feature", sha: SHA, repo: { full_name: "octo/repo" } },
    mergeable: true,
    mergeable_state: "clean",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    html_url: "https://github.com/octo/repo/pull/3",
    ...overrides,
  };
}

function repositoryJson() {
  return {
    id: 1,
    full_name: "octo/repo",
    default_branch: "main",
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
    permissions: { push: true },
  };
}

/** 移植自 `apps/host/internal/githubhost/service_test.go` 的 PR 与清理部分。 */
describe("Pull request", () => {
  let fixture: GithubFixture;

  beforeEach(async () => {
    fixture = await githubFixture();
    await configureToken(fixture);
    fixture.github.route("GET /repos/octo/repo", { body: repositoryJson() });
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("列表把仓库真正允许的合并策略带上", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls", { body: [pullJson()] });
    const result = await listPulls(
      fixture.service,
      fixture.caller,
      create(ListGithubPullsRequestSchema, { repository: REF }),
    );
    expect(result.pulls).toHaveLength(1);
    expect(result.pulls[0]?.allowedMergeMethods).toEqual([
      GithubMergeMethod.MERGE,
    ]);
  });

  it("详情的检查永远对着这次响应报出来的那个 head 读", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    fixture.github.route("GET /repos/octo/repo/pulls/3/files", { body: [] });
    fixture.github.route("GET /repos/octo/repo/pulls/3/reviews", { body: [] });
    fixture.github.route("GET /repos/octo/repo/pulls/3/comments", { body: [] });
    fixture.github.route("GET /repos/octo/repo/issues/3/comments", { body: [] });
    fixture.github.route(`GET /repos/octo/repo/commits/${SHA}/check-runs`, {
      body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
    });
    fixture.github.route(`GET /repos/octo/repo/commits/${SHA}/status`, {
      body: { statuses: [] },
    });
    const result = await getPull(
      fixture.service,
      fixture.caller,
      create(GetGithubPullRequestSchema, { repository: REF, number: 3n }),
    );
    expect(result.checks?.headSha).toBe(SHA);
    expect(result.checks?.rollup).toBe(GithubCheckConclusion.SUCCESS);
  });

  it("head 动了就拒绝合并，而且不发 PUT", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    const result = await mergePull(
      fixture.service,
      fixture.caller,
      create(MergeGithubPullRequestSchema, {
        repository: REF,
        number: 3n,
        method: GithubMergeMethod.MERGE,
        expectedHeadSha: OTHER_SHA,
      }),
    );
    expect(result.merged).toBe(false);
    expect(result.reasonCode).toBe("HEAD_MOVED");
    expect(
      fixture.github.requests.filter((r) => r.method === "PUT"),
    ).toHaveLength(0);
  });

  it("仓库禁用的策略不会被送出去", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    const result = await mergePull(
      fixture.service,
      fixture.caller,
      create(MergeGithubPullRequestSchema, {
        repository: REF,
        number: 3n,
        method: GithubMergeMethod.SQUASH,
        expectedHeadSha: SHA,
      }),
    );
    expect(result.reasonCode).toBe("METHOD_NOT_ALLOWED");
  });

  it("检查汇总和读者看到的不一样就拒绝", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    fixture.github.route(`GET /repos/octo/repo/commits/${SHA}/check-runs`, {
      body: { check_runs: [{ name: "build", status: "completed", conclusion: "failure" }] },
    });
    fixture.github.route(`GET /repos/octo/repo/commits/${SHA}/status`, {
      body: { statuses: [] },
    });
    const result = await mergePull(
      fixture.service,
      fixture.caller,
      create(MergeGithubPullRequestSchema, {
        repository: REF,
        number: 3n,
        method: GithubMergeMethod.MERGE,
        expectedHeadSha: SHA,
        expectedCheckRollup: GithubCheckConclusion.SUCCESS,
      }),
    );
    expect(result.reasonCode).toBe("CHECKS_CHANGED");
    expect(result.checks?.rollup).toBe(GithubCheckConclusion.FAILURE);
  });

  it("被远端标成 blocked 的 PR 不硬试一次", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", {
      body: pullJson({ mergeable_state: "blocked" }),
    });
    const result = await mergePull(
      fixture.service,
      fixture.caller,
      create(MergeGithubPullRequestSchema, {
        repository: REF,
        number: 3n,
        method: GithubMergeMethod.MERGE,
        expectedHeadSha: SHA,
      }),
    );
    expect(result.reasonCode).toBe("BLOCKED");
  });

  it("一个说 merged:false 的 200 是拒绝，不是成功", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    fixture.github.route("PUT /repos/octo/repo/pulls/3/merge", {
      body: { merged: false },
    });
    const result = await mergePull(
      fixture.service,
      fixture.caller,
      create(MergeGithubPullRequestSchema, {
        repository: REF,
        number: 3n,
        method: GithubMergeMethod.MERGE,
        expectedHeadSha: SHA,
      }),
    );
    expect(result.merged).toBe(false);
    expect(result.reasonCode).toBe("NOT_MERGEABLE");
  });

  it("合并成功带回合并提交", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    fixture.github.route("PUT /repos/octo/repo/pulls/3/merge", {
      body: { merged: true, sha: OTHER_SHA },
    });
    const result = await mergePull(
      fixture.service,
      fixture.caller,
      create(MergeGithubPullRequestSchema, {
        repository: REF,
        number: 3n,
        method: GithubMergeMethod.MERGE,
        expectedHeadSha: SHA,
      }),
    );
    expect(result.merged).toBe(true);
    expect(result.mergeSha).toBe(OTHER_SHA);
  });

  it("从没推上去的 head 分支报 NOT_FOUND，而不是让远端给一句含糊话", async () => {
    await expect(
      createPull(
        fixture.service,
        fixture.caller,
        create(CreateGithubPullRequestSchema, {
          repository: REF,
          title: "x",
          baseRef: "main",
          headRef: "never-pushed",
        }),
      ),
    ).rejects.toThrow(githubError("notFound").message);
  });

  it("创建 PR 把 Closes # 写成远端看得懂的文本", async () => {
    fixture.github.route("GET /repos/octo/repo/git/ref/heads/feature", {
      body: { object: { sha: SHA } },
    });
    fixture.github.route("POST /repos/octo/repo/pulls", { body: pullJson() });
    await createPull(
      fixture.service,
      fixture.caller,
      create(CreateGithubPullRequestSchema, {
        repository: REF,
        title: "x",
        body: "描述",
        baseRef: "main",
        headRef: "feature",
        linkedIssueNumber: 7n,
        expectedHeadSha: SHA,
      }),
    );
    const post = fixture.github.requests.find(
      (request) => request.path === "/repos/octo/repo/pulls",
    );
    expect(JSON.parse(post?.body ?? "{}").body).toBe("描述\n\nCloses #7");
  });

  it("请求修改必须带正文", async () => {
    await expect(
      submitReview(
        fixture.service,
        fixture.caller,
        create(SubmitGithubReviewRequestSchema, {
          repository: REF,
          number: 3n,
          state: GithubReviewState.CHANGES_REQUESTED,
          body: "   ",
        }),
      ),
    ).rejects.toThrow(githubError("invalid").message);
  });

  it("分支名拒绝会被 git 当成模式或选项的东西", () => {
    expect(validRef("feature/x")).toBe(true);
    expect(validRef("-delete-everything")).toBe(false);
    expect(validRef("a..b")).toBe(false);
    // 空格也在 `<= 0x20` 里：git 允许，但这里没有任何东西需要带空格的 ref。
    expect(validRef("a b")).toBe(false);
    expect(validRef("a*b")).toBe(false);
    expect(validRef("")).toBe(false);
  });
});

describe("检查重跑与分支清理", () => {
  let fixture: GithubFixture;

  beforeEach(async () => {
    fixture = await githubFixture();
    await configureToken(fixture);
    fixture.github.route("GET /repos/octo/repo", { body: repositoryJson() });
  });

  afterEach(async () => {
    await fixture.close();
  });

  function summary(...runs: { name: string; conclusion: GithubCheckConclusion; id?: number }[]) {
    return create(GithubCheckSummarySchema, {
      headSha: SHA,
      runs: runs.map((run) =>
        create(GithubCheckRunSchema, {
          name: run.name,
          conclusion: run.conclusion,
          rerunnable: run.id !== undefined,
          workflowRunId: BigInt(run.id ?? 0),
        }),
      ),
    });
  }

  it("只重跑标着可重跑、而且没成功的那些", () => {
    const picked = rerunTargets(
      summary(
        { name: "build", conclusion: GithubCheckConclusion.FAILURE, id: 11 },
        { name: "lint", conclusion: GithubCheckConclusion.SUCCESS, id: 12 },
        { name: "slow", conclusion: GithubCheckConclusion.PENDING, id: 13 },
        { name: "extern", conclusion: GithubCheckConclusion.FAILURE },
        { name: "again", conclusion: GithubCheckConclusion.FAILURE, id: 11 },
      ),
      "",
    );
    expect(picked).toEqual([11n]);
  });

  it("指名一个检查把范围收到那一个运行", () => {
    const picked = rerunTargets(
      summary(
        { name: "build", conclusion: GithubCheckConclusion.FAILURE, id: 11 },
        { name: "test", conclusion: GithubCheckConclusion.FAILURE, id: 12 },
      ),
      "test",
    );
    expect(picked).toEqual([12n]);
  });

  it("head 动了的重跑不发任何 POST", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    const result = await rerunChecks(
      fixture.service,
      fixture.caller,
      create(RerunGithubChecksRequestSchema, {
        repository: REF,
        number: 3n,
        expectedHeadSha: OTHER_SHA,
      }),
    );
    expect(result.reasonCode).toBe("HEAD_MOVED");
    expect(
      fixture.github.requests.filter((r) => r.method === "POST"),
    ).toHaveLength(0);
  });

  it("没有可重跑的运行时说出来，而不是按了没反应", async () => {
    fixture.github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
    fixture.github.route(`GET /repos/octo/repo/commits/${SHA}/check-runs`, {
      body: { check_runs: [{ name: "build", status: "completed", conclusion: "failure" }] },
    });
    fixture.github.route(`GET /repos/octo/repo/commits/${SHA}/status`, {
      body: { statuses: [] },
    });
    const result = await rerunChecks(
      fixture.service,
      fixture.caller,
      create(RerunGithubChecksRequestSchema, { repository: REF, number: 3n }),
    );
    expect(result.reasonCode).toBe("NOT_RERUNNABLE");
  });

  it("已经不在的分支报 NOT_FOUND，而不是报成一次删除", async () => {
    const result = await deleteBranch(
      fixture.service,
      fixture.caller,
      create(DeleteGithubBranchRequestSchema, {
        repository: REF,
        branch: "feature",
        expectedSha: SHA,
      }),
    );
    expect(result.deleted).toBe(false);
    expect(result.reasonCode).toBe("NOT_FOUND");
  });

  it("往前走过的分支拒绝删，而且不发 DELETE", async () => {
    fixture.github.route("GET /repos/octo/repo/git/ref/heads/feature", {
      body: { object: { sha: OTHER_SHA } },
    });
    const result = await deleteBranch(
      fixture.service,
      fixture.caller,
      create(DeleteGithubBranchRequestSchema, {
        repository: REF,
        branch: "feature",
        expectedSha: SHA,
      }),
    );
    expect(result.reasonCode).toBe("REF_MOVED");
    expect(
      fixture.github.requests.filter((r) => r.method === "DELETE"),
    ).toHaveLength(0);
  });

  it("对得上的分支才真的删", async () => {
    fixture.github.route("GET /repos/octo/repo/git/ref/heads/feature", {
      body: { object: { sha: SHA } },
    });
    fixture.github.route("DELETE /repos/octo/repo/git/refs/heads/feature", {
      status: 204,
    });
    const result = await deleteBranch(
      fixture.service,
      fixture.caller,
      create(DeleteGithubBranchRequestSchema, {
        repository: REF,
        branch: "feature",
        expectedSha: SHA,
      }),
    );
    expect(result.deleted).toBe(true);
  });

  it("保护规则和缺少推送权限都报 PROTECTED", async () => {
    fixture.github.route("GET /repos/octo/repo/git/ref/heads/feature", {
      body: { object: { sha: SHA } },
    });
    fixture.github.route("DELETE /repos/octo/repo/git/refs/heads/feature", {
      status: 403,
      headers: { "x-ratelimit-remaining": "42", "x-ratelimit-limit": "60" },
    });
    const result = await deleteBranch(
      fixture.service,
      fixture.caller,
      create(DeleteGithubBranchRequestSchema, {
        repository: REF,
        branch: "feature",
        expectedSha: SHA,
      }),
    );
    expect(result.reasonCode).toBe("PROTECTED");
  });
});
