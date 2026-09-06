import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  GetGithubPullResponseSchema,
  GithubCheckConclusion,
  GithubCredentialSource,
  GithubCredentialStatusSchema,
  GithubExternalReferenceSchema,
  GithubIssueSchema,
  GithubIssueState,
  GithubIssueStateReason,
  GithubMergeableState,
  GithubMergeMethod,
  GithubPullState,
  GithubReferenceKind,
  GithubReferenceTargetKind,
  GithubSecretStore,
  GithubStatusMappingSchema,
  GithubStatusSource,
  GithubWriteState,
  MergeGithubPullRequestSchema,
  MoveGithubIssueResponseSchema,
  UpdateGithubIssueRequestSchema,
} from "../src/index.js";

function fixture(name: string): Uint8Array {
  const hex = readFileSync(
    new URL(`../../../proto/fixtures/${name}.hex`, import.meta.url),
    "utf8",
  ).trim();
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function check<T extends DescMessage>(
  name: string,
  schema: T,
  init: MessageInitShape<T>,
) {
  const expected = create(schema, init);
  const wire = fixture(name);
  expect(fromBinary(schema, wire)).toEqual(expected);
  expect(toBinary(schema, expected)).toEqual(wire);
}

describe("GitHub Issues and Pull requests", () => {
  const enterprise = {
    owner: "组织",
    name: "仓库-x",
    apiBase: "https://ghe.example.com/api/v3",
    host: "ghe.example.com",
  };

  it("carries a credential status that can never hold a token", () => {
    check("github_credential_status", GithubCredentialStatusSchema, {
      source: GithubCredentialSource.TOKEN_REF,
      store: GithubSecretStore.FILE_FALLBACK,
      available: false,
      apiBase: "https://ghe.example.com/api/v3",
      enterprise: true,
      accountLogin: "octo-用户",
      tokenScopes: ["repo", "read:org"],
      checkedAtUnixMs: 1788557900000n,
      reasonCode: "TOKEN_REJECTED",
      revision: 9007199254740993n,
    });
  });

  it("keeps external Issue content, mapping and conflict flags byte-identical", () => {
    check("github_issue_mapped", GithubIssueSchema, {
      repository: enterprise,
      number: 4321n,
      id: 9223372036854775807n,
      title: "修复 📦 上传",
      body: "外部内容\n<script>",
      state: GithubIssueState.OPEN,
      stateReason: GithubIssueStateReason.REOPENED,
      author: { login: "作者", id: 7n },
      assignees: [{ login: "负责人", id: 8n }],
      labels: [
        { name: "status/in progress", color: "ededed" },
        { name: "bug", color: "d73a4a" },
      ],
      milestone: { number: 3n, title: "M5" },
      commentCount: 12n,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
      htmlUrl: "https://ghe.example.com/组织/仓库-x/issues/4321",
      statusGroupId: "in-progress",
      statusConflict: true,
      observedAtUnixMs: 1788557900001n,
    });
    check("github_status_mapping", GithubStatusMappingSchema, {
      repository: enterprise,
      source: GithubStatusSource.PROJECT_FIELD,
      projectId: "PVT_kwDO",
      projectFieldId: "PVTSSF_lADO",
      groups: [
        {
          id: "todo",
          title: "待办",
          label: "status/todo",
          projectOptionId: "f75ad846",
        },
        {
          id: "done",
          title: "完成",
          label: "status/done",
          projectOptionId: "98236657",
          couplesIssueState: GithubIssueState.CLOSED,
        },
      ],
      stateGroups: [{ state: GithubIssueState.CLOSED, groupId: "done" }],
      revision: 9007199254740993n,
      updatedAtUnixMs: 1788557900000n,
    });
  });

  it("reports each write of a partly applied move on its own", () => {
    check("github_move_outcomes", MoveGithubIssueResponseSchema, {
      outcomes: [
        {
          actionId: "action-1",
          target: "labels",
          state: GithubWriteState.APPLIED,
          previousValue: "status/todo",
          requestedValue: "status/done",
        },
        {
          actionId: "action-2",
          target: "project_field",
          state: GithubWriteState.PENDING,
          reasonCode: "UNKNOWN_OUTCOME",
        },
        {
          actionId: "action-3",
          target: "issue_state",
          state: GithubWriteState.CONFLICTED,
          reasonCode: "REMOTE_CHANGED",
        },
      ],
      rateLimit: {
        limit: 5000n,
        remaining: 0n,
        resetsAtUnixMs: 1788558000000n,
        throttled: true,
        retryAfterUnixMs: 1788557960000n,
      },
    });
  });

  it("binds a merge to the head SHA and check rollup the reader saw", () => {
    check("github_merge_request", MergeGithubPullRequestSchema, {
      meta: {
        requestId: "merge-1",
        scope: {
          hostId: "0123456789abcdef0123456789abcdef",
          workspaceId: "workspace-1",
          executionHostId: "0123456789abcdef0123456789abcdef",
        },
      },
      repository: enterprise,
      number: 99n,
      expectedHeadSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
      method: GithubMergeMethod.SQUASH,
      commitTitle: "feat: 合并 📦",
      commitMessage: "正文",
      expectedCheckRollup: GithubCheckConclusion.SUCCESS,
    });
    check("github_pull_checks", GetGithubPullResponseSchema, {
      pull: {
        repository: enterprise,
        number: 99n,
        title: "合并请求",
        state: GithubPullState.OPEN,
        draft: true,
        baseRef: "main",
        headRef: "feature/上传",
        headSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
        headRepoFullName: "fork-owner/仓库-x",
        fromFork: true,
        mergeable: GithubMergeableState.BLOCKED,
        allowedMergeMethods: [
          GithubMergeMethod.SQUASH,
          GithubMergeMethod.REBASE,
        ],
        changedFiles: 3n,
        observedAtUnixMs: 1788557900000n,
      },
      checks: {
        headSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
        runs: [
          {
            name: "build",
            app: "GitHub Actions",
            conclusion: GithubCheckConclusion.FAILURE,
            detailsUrl: "https://ghe.example.com/runs/1",
            rerunnable: true,
            workflowRunId: 4242n,
          },
          {
            name: "外部检查",
            conclusion: GithubCheckConclusion.PENDING,
          },
        ],
        rollup: GithubCheckConclusion.FAILURE,
        observedAtUnixMs: 1788557900000n,
      },
      pollIntervalMs: 30000n,
    });
  });

  it("links an Issue or Pull request to one local target", () => {
    check("github_reference", GithubExternalReferenceSchema, {
      referenceId: "0123456789abcdef0123456789abcdef",
      workspaceId: "workspace-1",
      repository: enterprise,
      kind: GithubReferenceKind.PULL_REQUEST,
      number: 99n,
      targetKind: GithubReferenceTargetKind.WORKTREE,
      targetId: "worktree-上传",
      title: "合并请求",
      revision: 9007199254740993n,
      createdAtUnixMs: 1788557000000n,
      updatedAtUnixMs: 1788557900000n,
    });
  });

  // Leaving a field alone and clearing it are different edits, so an absent
  // optional must not decode as an empty string.
  it("distinguishes an absent patch field from a present empty one", () => {
    check("github_issue_patch_absent", UpdateGithubIssueRequestSchema, {
      repository: enterprise,
      number: 4321n,
      patch: { replaceLabels: true, labels: ["status/done"] },
      expectedUpdatedAtUnixMs: 1788557900000n,
    });
    check("github_issue_patch_empty_body", UpdateGithubIssueRequestSchema, {
      repository: enterprise,
      number: 4321n,
      patch: { body: "" },
      expectedUpdatedAtUnixMs: 1788557900000n,
    });
    expect(
      fromBinary(
        UpdateGithubIssueRequestSchema,
        fixture("github_issue_patch_absent"),
      ).patch?.body,
    ).toBeUndefined();
    expect(
      fromBinary(
        UpdateGithubIssueRequestSchema,
        fixture("github_issue_patch_empty_body"),
      ).patch?.body,
    ).toBe("");
  });
});
