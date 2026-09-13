//! The Github surface (`github.proto`): external content, an expected head
//! SHA and the status mapping.

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn check<M: Message + Default + PartialEq + std::fmt::Debug>(name: &str, expected: M) {
    let wire = fixture(name);
    assert_eq!(M::decode(wire.as_slice()).unwrap(), expected);
    assert_eq!(
        expected.encode_to_vec(),
        wire,
        "{name} differs across runtimes"
    );
}

/// The Github surface: external content, an expected head SHA and a status
/// mapping. Rust decodes the Go-produced fixtures and re-encodes them, so a
/// field renumbered on one side cannot pass unnoticed on another.
#[test]
fn github_issue_and_pull_contracts() {
    let enterprise = || GithubRepositoryRef {
        owner: "组织".into(),
        name: "仓库-x".into(),
        api_base: "https://ghe.example.com/api/v3".into(),
        host: "ghe.example.com".into(),
    };
    check(
        "github_credential_status",
        GithubCredentialStatus {
            source: GithubCredentialSource::TokenRef as i32,
            store: GithubSecretStore::FileFallback as i32,
            available: false,
            api_base: "https://ghe.example.com/api/v3".into(),
            enterprise: true,
            account_login: "octo-用户".into(),
            token_scopes: vec!["repo".into(), "read:org".into()],
            checked_at_unix_ms: 1_788_557_900_000,
            reason_code: "TOKEN_REJECTED".into(),
            revision: 9_007_199_254_740_993,
        },
    );
    check(
        "github_issue_mapped",
        GithubIssue {
            repository: Some(enterprise()),
            number: 4321,
            id: i64::MAX,
            title: "修复 📦 上传".into(),
            body: "外部内容\n<script>".into(),
            state: GithubIssueState::Open as i32,
            state_reason: GithubIssueStateReason::Reopened as i32,
            author: Some(GithubUser {
                login: "作者".into(),
                id: 7,
            }),
            assignees: vec![GithubUser {
                login: "负责人".into(),
                id: 8,
            }],
            labels: vec![
                GithubLabel {
                    name: "status/in progress".into(),
                    color: "ededed".into(),
                },
                GithubLabel {
                    name: "bug".into(),
                    color: "d73a4a".into(),
                },
            ],
            milestone: Some(GithubMilestone {
                number: 3,
                title: "M5".into(),
            }),
            comment_count: 12,
            created_at_unix_ms: 1_788_557_000_000,
            updated_at_unix_ms: 1_788_557_900_000,
            closed_at_unix_ms: 0,
            html_url: "https://ghe.example.com/组织/仓库-x/issues/4321".into(),
            status_group_id: "in-progress".into(),
            status_conflict: true,
            observed_at_unix_ms: 1_788_557_900_001,
        },
    );
    check(
        "github_status_mapping",
        GithubStatusMapping {
            repository: Some(enterprise()),
            source: GithubStatusSource::ProjectField as i32,
            project_id: "PVT_kwDO".into(),
            project_field_id: "PVTSSF_lADO".into(),
            groups: vec![
                GithubStatusGroup {
                    id: "todo".into(),
                    title: "待办".into(),
                    label: "status/todo".into(),
                    project_option_id: "f75ad846".into(),
                    couples_issue_state: 0,
                },
                GithubStatusGroup {
                    id: "done".into(),
                    title: "完成".into(),
                    label: "status/done".into(),
                    project_option_id: "98236657".into(),
                    couples_issue_state: GithubIssueState::Closed as i32,
                },
            ],
            state_groups: vec![GithubStateCoupling {
                state: GithubIssueState::Closed as i32,
                group_id: "done".into(),
            }],
            revision: 9_007_199_254_740_993,
            updated_at_unix_ms: 1_788_557_900_000,
        },
    );
    check(
        "github_move_outcomes",
        MoveGithubIssueResponse {
            issue: None,
            outcomes: vec![
                GithubWriteOutcome {
                    action_id: "action-1".into(),
                    target: "labels".into(),
                    state: GithubWriteState::Applied as i32,
                    reason_code: String::new(),
                    previous_value: "status/todo".into(),
                    requested_value: "status/done".into(),
                },
                GithubWriteOutcome {
                    action_id: "action-2".into(),
                    target: "project_field".into(),
                    state: GithubWriteState::Pending as i32,
                    reason_code: "UNKNOWN_OUTCOME".into(),
                    previous_value: String::new(),
                    requested_value: String::new(),
                },
                GithubWriteOutcome {
                    action_id: "action-3".into(),
                    target: "issue_state".into(),
                    state: GithubWriteState::Conflicted as i32,
                    reason_code: "REMOTE_CHANGED".into(),
                    previous_value: String::new(),
                    requested_value: String::new(),
                },
            ],
            rate_limit: Some(GithubRateLimit {
                limit: 5000,
                remaining: 0,
                resets_at_unix_ms: 1_788_558_000_000,
                throttled: true,
                retry_after_unix_ms: 1_788_557_960_000,
            }),
        },
    );
    check(
        "github_merge_request",
        MergeGithubPullRequest {
            meta: Some(CommandMeta {
                request_id: "merge-1".into(),
                scope: Some(Scope {
                    host_id: "0123456789abcdef0123456789abcdef".into(),
                    workspace_id: "workspace-1".into(),
                    execution_host_id: "0123456789abcdef0123456789abcdef".into(),
                }),
                idempotency_key: String::new(),
                expected_revision: None,
                deadline_unix_ms: 0,
            }),
            repository: Some(enterprise()),
            number: 99,
            expected_head_sha: "9fceb02d0ae598e95dc970b74767f19372d61af8".into(),
            method: GithubMergeMethod::Squash as i32,
            commit_title: "feat: 合并 📦".into(),
            commit_message: "正文".into(),
            expected_check_rollup: GithubCheckConclusion::Success as i32,
        },
    );
    check(
        "github_pull_checks",
        GetGithubPullResponse {
            pull: Some(GithubPullRequest {
                repository: Some(enterprise()),
                number: 99,
                title: "合并请求".into(),
                state: GithubPullState::Open as i32,
                draft: true,
                base_ref: "main".into(),
                head_ref: "feature/上传".into(),
                head_sha: "9fceb02d0ae598e95dc970b74767f19372d61af8".into(),
                head_repo_full_name: "fork-owner/仓库-x".into(),
                from_fork: true,
                mergeable: GithubMergeableState::Blocked as i32,
                allowed_merge_methods: vec![
                    GithubMergeMethod::Squash as i32,
                    GithubMergeMethod::Rebase as i32,
                ],
                changed_files: 3,
                observed_at_unix_ms: 1_788_557_900_000,
                ..Default::default()
            }),
            checks: Some(GithubCheckSummary {
                head_sha: "9fceb02d0ae598e95dc970b74767f19372d61af8".into(),
                runs: vec![
                    GithubCheckRun {
                        name: "build".into(),
                        app: "GitHub Actions".into(),
                        conclusion: GithubCheckConclusion::Failure as i32,
                        details_url: "https://ghe.example.com/runs/1".into(),
                        started_at_unix_ms: 0,
                        completed_at_unix_ms: 0,
                        rerunnable: true,
                        workflow_run_id: 4242,
                    },
                    GithubCheckRun {
                        name: "外部检查".into(),
                        conclusion: GithubCheckConclusion::Pending as i32,
                        ..Default::default()
                    },
                ],
                rollup: GithubCheckConclusion::Failure as i32,
                observed_at_unix_ms: 1_788_557_900_000,
            }),
            poll_interval_ms: 30_000,
            ..Default::default()
        },
    );
    check(
        "github_reference",
        GithubExternalReference {
            reference_id: "0123456789abcdef0123456789abcdef".into(),
            workspace_id: "workspace-1".into(),
            repository: Some(enterprise()),
            kind: GithubReferenceKind::PullRequest as i32,
            number: 99,
            target_kind: GithubReferenceTargetKind::Worktree as i32,
            target_id: "worktree-上传".into(),
            title: "合并请求".into(),
            revision: 9_007_199_254_740_993,
            created_at_unix_ms: 1_788_557_000_000,
            updated_at_unix_ms: 1_788_557_900_000,
        },
    );
    // An absent optional and a present empty string are different requests: one
    // leaves the body alone, the other clears it.
    check(
        "github_issue_patch_absent",
        UpdateGithubIssueRequest {
            meta: None,
            repository: Some(enterprise()),
            number: 4321,
            patch: Some(GithubIssuePatch {
                replace_labels: true,
                labels: vec!["status/done".into()],
                ..Default::default()
            }),
            expected_updated_at_unix_ms: 1_788_557_900_000,
        },
    );
    check(
        "github_issue_patch_empty_body",
        UpdateGithubIssueRequest {
            meta: None,
            repository: Some(enterprise()),
            number: 4321,
            patch: Some(GithubIssuePatch {
                body: Some(String::new()),
                ..Default::default()
            }),
            expected_updated_at_unix_ms: 1_788_557_900_000,
        },
    );
}
