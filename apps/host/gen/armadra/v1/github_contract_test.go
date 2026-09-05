package v1_test

import (
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The Github surface carries external content, an expected head SHA and a
// status mapping. Each of those is only safe if every runtime reads exactly the
// same bytes, so the fixtures pin them rather than trusting three encoders.
func TestGithubWireContract(t *testing.T) {
	enterprise := &pb.GithubRepositoryRef{Owner: "组织", Name: "仓库-x", ApiBase: "https://ghe.example.com/api/v3", Host: "ghe.example.com"}
	for name, message := range map[string]proto.Message{
		// A credential status must be transportable without ever carrying a token.
		"github_credential_status": &pb.GithubCredentialStatus{
			Source: pb.GithubCredentialSource_GITHUB_CREDENTIAL_SOURCE_TOKEN_REF,
			Store:  pb.GithubSecretStore_GITHUB_SECRET_STORE_FILE_FALLBACK,
			// Deliberately unavailable with a machine reason: a status that says
			// "configured" is never the same as "a token can be produced".
			Available:       false,
			ApiBase:         "https://ghe.example.com/api/v3",
			Enterprise:      true,
			AccountLogin:    "octo-用户",
			TokenScopes:     []string{"repo", "read:org"},
			CheckedAtUnixMs: 1788557900000,
			ReasonCode:      "TOKEN_REJECTED",
			Revision:        9007199254740993,
		},
		"github_issue_mapped": &pb.GithubIssue{
			Repository:       enterprise,
			Number:           4321,
			Id:               math.MaxInt64,
			Title:            "修复 📦 上传",
			Body:             "外部内容\n<script>",
			State:            pb.GithubIssueState_GITHUB_ISSUE_STATE_OPEN,
			StateReason:      pb.GithubIssueStateReason_GITHUB_ISSUE_STATE_REASON_REOPENED,
			Author:           &pb.GithubUser{Login: "作者", Id: 7},
			Assignees:        []*pb.GithubUser{{Login: "负责人", Id: 8}},
			Labels:           []*pb.GithubLabel{{Name: "status/in progress", Color: "ededed"}, {Name: "bug", Color: "d73a4a"}},
			Milestone:        &pb.GithubMilestone{Number: 3, Title: "M5"},
			CommentCount:     12,
			CreatedAtUnixMs:  1788557000000,
			UpdatedAtUnixMs:  1788557900000,
			HtmlUrl:          "https://ghe.example.com/组织/仓库-x/issues/4321",
			StatusGroupId:    "in-progress",
			StatusConflict:   true,
			ObservedAtUnixMs: 1788557900001,
		},
		// Both coupling directions present: the shape a cycle check has to read.
		"github_status_mapping": &pb.GithubStatusMapping{
			Repository:      enterprise,
			Source:          pb.GithubStatusSource_GITHUB_STATUS_SOURCE_PROJECT_FIELD,
			ProjectId:       "PVT_kwDO",
			ProjectFieldId:  "PVTSSF_lADO",
			Groups:          []*pb.GithubStatusGroup{{Id: "todo", Title: "待办", Label: "status/todo", ProjectOptionId: "f75ad846"}, {Id: "done", Title: "完成", Label: "status/done", ProjectOptionId: "98236657", CouplesIssueState: pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED}},
			StateGroups:     []*pb.GithubStateCoupling{{State: pb.GithubIssueState_GITHUB_ISSUE_STATE_CLOSED, GroupId: "done"}},
			Revision:        9007199254740993,
			UpdatedAtUnixMs: 1788557900000,
		},
		// A partly applied move: each write keeps its own outcome.
		"github_move_outcomes": &pb.MoveGithubIssueResponse{
			Outcomes: []*pb.GithubWriteOutcome{
				{ActionId: "action-1", Target: "labels", State: pb.GithubWriteState_GITHUB_WRITE_STATE_APPLIED, PreviousValue: "status/todo", RequestedValue: "status/done"},
				{ActionId: "action-2", Target: "project_field", State: pb.GithubWriteState_GITHUB_WRITE_STATE_PENDING, ReasonCode: "UNKNOWN_OUTCOME"},
				{ActionId: "action-3", Target: "issue_state", State: pb.GithubWriteState_GITHUB_WRITE_STATE_CONFLICTED, ReasonCode: "REMOTE_CHANGED"},
			},
			RateLimit: &pb.GithubRateLimit{Limit: 5000, Remaining: 0, ResetsAtUnixMs: 1788558000000, Throttled: true, RetryAfterUnixMs: 1788557960000},
		},
		// The merge request is the reason expected_head_sha exists at all.
		"github_merge_request": &pb.MergeGithubPullRequest{
			Meta:                &pb.CommandMeta{RequestId: "merge-1", Scope: &pb.Scope{HostId: "0123456789abcdef0123456789abcdef", WorkspaceId: "workspace-1", ExecutionHostId: "0123456789abcdef0123456789abcdef"}},
			Repository:          enterprise,
			Number:              99,
			ExpectedHeadSha:     "9fceb02d0ae598e95dc970b74767f19372d61af8",
			Method:              pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH,
			CommitTitle:         "feat: 合并 📦",
			CommitMessage:       "正文",
			ExpectedCheckRollup: pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_SUCCESS,
		},
		"github_pull_checks": &pb.GetGithubPullResponse{
			Pull: &pb.GithubPullRequest{
				Repository:          enterprise,
				Number:              99,
				Title:               "合并请求",
				State:               pb.GithubPullState_GITHUB_PULL_STATE_OPEN,
				Draft:               true,
				BaseRef:             "main",
				HeadRef:             "feature/上传",
				HeadSha:             "9fceb02d0ae598e95dc970b74767f19372d61af8",
				HeadRepoFullName:    "fork-owner/仓库-x",
				FromFork:            true,
				Mergeable:           pb.GithubMergeableState_GITHUB_MERGEABLE_STATE_BLOCKED,
				AllowedMergeMethods: []pb.GithubMergeMethod{pb.GithubMergeMethod_GITHUB_MERGE_METHOD_SQUASH, pb.GithubMergeMethod_GITHUB_MERGE_METHOD_REBASE},
				ChangedFiles:        3,
				ObservedAtUnixMs:    1788557900000,
			},
			Checks: &pb.GithubCheckSummary{
				HeadSha:          "9fceb02d0ae598e95dc970b74767f19372d61af8",
				Runs:             []*pb.GithubCheckRun{{Name: "build", App: "GitHub Actions", Conclusion: pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_FAILURE, DetailsUrl: "https://ghe.example.com/runs/1", Rerunnable: true, WorkflowRunId: 4242}, {Name: "外部检查", Conclusion: pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_PENDING}},
				Rollup:           pb.GithubCheckConclusion_GITHUB_CHECK_CONCLUSION_FAILURE,
				ObservedAtUnixMs: 1788557900000,
			},
			PollIntervalMs: 30000,
		},
		"github_reference": &pb.GithubExternalReference{
			ReferenceId:     "0123456789abcdef0123456789abcdef",
			WorkspaceId:     "workspace-1",
			Repository:      enterprise,
			Kind:            pb.GithubReferenceKind_GITHUB_REFERENCE_KIND_PULL_REQUEST,
			Number:          99,
			TargetKind:      pb.GithubReferenceTargetKind_GITHUB_REFERENCE_TARGET_KIND_WORKTREE,
			TargetId:        "worktree-上传",
			Title:           "合并请求",
			Revision:        9007199254740993,
			CreatedAtUnixMs: 1788557000000,
			UpdatedAtUnixMs: 1788557900000,
		},
		// Optional patch fields must survive as "absent" rather than as "".
		"github_issue_patch_absent": &pb.UpdateGithubIssueRequest{
			Repository:              enterprise,
			Number:                  4321,
			Patch:                   &pb.GithubIssuePatch{ReplaceLabels: true, Labels: []string{"status/done"}},
			ExpectedUpdatedAtUnixMs: 1788557900000,
		},
		"github_issue_patch_empty_body": &pb.UpdateGithubIssueRequest{
			Repository:              enterprise,
			Number:                  4321,
			Patch:                   &pb.GithubIssuePatch{Body: proto.String("")},
			ExpectedUpdatedAtUnixMs: 1788557900000,
		},
	} {
		wire, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		encoded := fixture(t, name, wire)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(encoded, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("%s contract changed", name)
		}
	}
}
