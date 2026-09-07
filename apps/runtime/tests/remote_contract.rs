//! The service contract snapshot (design §3.5).
//!
//! Relaxing the version lock from "identical `runtime_version`" to "same
//! `service_contract_version`" only holds if the constant actually tracks the
//! payload shapes. Nothing in the type system enforces that, so this test does:
//! every operation's request payload is serialized from a fixed example and
//! compared against `tests/fixtures/service/<operation>.json`. A field renamed,
//! added, removed or retyped changes the snapshot, the test fails, and the
//! message says to bump `CONTRACT_VERSION`.
//!
//! Regenerate deliberately with `ARMADRA_UPDATE_SERVICE_FIXTURES=1`, after
//! bumping the constant.
//!
//! **What this covers and what it does not.** The request direction is the
//! safety-critical one: the Worker decodes those bytes and acts on them, and a
//! controller and a Worker that disagree about a request would run the wrong
//! operation. Response types are covered only by their name, recorded in each
//! snapshot — the controller reads responses with serde's default tolerance
//! for unknown fields, so a response that gains a field is readable by an older
//! controller, while a response type that is *replaced* changes the recorded
//! name and fails here.

use std::{collections::BTreeMap, path::PathBuf};

use armadra_protocol::v1::WorkerServiceOperation;
use armadra_runtime::remote::service::{
    self,
    replay::{ALL, CONTRACT_VERSION, capability, replay},
};
use serde_json::{Value, json};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("service")
}

fn snake(operation: WorkerServiceOperation) -> String {
    let name = format!("{operation:?}");
    let mut out = String::new();
    for (index, character) in name.chars().enumerate() {
        if character.is_uppercase() && index > 0 {
            out.push('_');
        }
        out.extend(character.to_lowercase());
    }
    out
}

/// One example request per operation, and the type name of its answer.
///
/// Written out by hand rather than derived, because the point is to notice
/// when the *shape* changes: a generated example would change with the shape
/// and notice nothing.
fn examples() -> BTreeMap<WorkerServiceOperation, (Value, &'static str)> {
    use WorkerServiceOperation as Operation;

    let path = || json!({ "path": "src/main.rs" });
    let mut examples: BTreeMap<WorkerServiceOperation, (Value, &'static str)> = BTreeMap::new();
    examples.insert(Operation::FileRead, (path(), "files::FileContent"));
    examples.insert(Operation::FileVersion, (path(), "file_watch::FileVersion"));
    examples.insert(
        Operation::SearchContent,
        (
            json!({ "query": "needle", "caseSensitive": false, "regex": false, "wholeWord": false, "includeGlobs": [], "excludeGlobs": [], "maxResults": 200 }),
            "file_search::SearchResults",
        ),
    );
    examples.insert(
        Operation::SearchIndex,
        (
            json!({ "query": "main", "limit": 50 }),
            "file_search::IndexedFiles",
        ),
    );
    examples.insert(
        Operation::WatchPoll,
        (
            json!({ "paths": ["src/main.rs"] }),
            "service::WatchPollResult",
        ),
    );
    examples.insert(Operation::GitStatus, (path(), "git::RepositoryStatus"));
    examples.insert(Operation::GitHeadCommit, (path(), "git::HeadCommit"));
    examples.insert(
        Operation::GitDiff,
        (
            json!({ "path": ".", "scope": "worktree", "paths": ["a.txt"], "ignoreWhitespace": false }),
            "git::DiffResult",
        ),
    );
    for operation in [
        Operation::GitStage,
        Operation::GitUnstage,
        Operation::GitResolve,
    ] {
        examples.insert(
            operation,
            (
                json!({ "path": ".", "paths": ["a.txt"] }),
                "git::RepositoryStatus",
            ),
        );
    }
    examples.insert(
        Operation::GitRevert,
        (
            json!({ "path": ".", "paths": ["a.txt"], "source": "index" }),
            "git::RepositoryStatus",
        ),
    );
    examples.insert(
        Operation::GitCommit,
        (
            json!({ "path": ".", "message": "subject", "paths": ["a.txt"], "amend": null }),
            "git::CommitResult",
        ),
    );
    examples.insert(Operation::GitInit, (json!({}), "git::RepositoryStatus"));

    /* ------------------------- repository panel ------------------------- */
    examples.insert(
        Operation::GitRepositories,
        (
            json!({ "maxDepth": 3, "refresh": false }),
            "git_discovery::GitRepositoryList",
        ),
    );
    let repository = || json!({ "path": "." });
    examples.insert(
        Operation::GitBranches,
        (repository(), "git_repository::BranchSnapshot"),
    );
    examples.insert(
        Operation::GitHistory,
        (
            json!({
                "path": ".",
                "reference": "HEAD",
                "limit": 50,
                "cursor": null,
                "paths": ["src"],
            }),
            "git_repository::HistoryPage",
        ),
    );
    examples.insert(
        Operation::GitReflog,
        (
            json!({ "path": ".", "reference": "HEAD", "limit": 50, "cursor": null }),
            "git_repository::ReflogPage",
        ),
    );
    // The Git window's two workspace-level reads. The log's whole filter record
    // travels as one field, because the page cursor is bound to its identity.
    examples.insert(
        Operation::GitLog,
        (
            json!({
                "request": {
                    "repositories": [".", "packages/web"],
                    "refs": { "kind": "named", "names": ["main"] },
                    "authors": ["yovinchen"],
                    "since": "2026-01-01",
                    "until": null,
                    "paths": ["apps/web"],
                    "text": { "query": "fix", "regex": false, "matchCase": false },
                    "cursor": null,
                    "limit": 100,
                },
            }),
            "git_repository::LogPage",
        ),
    );
    examples.insert(
        Operation::GitRefs,
        (json!({}), "Vec<git_repository::RefsSnapshot>"),
    );
    examples.insert(
        Operation::GitIdentity,
        (repository(), "git_repository::IdentityRecord"),
    );
    examples.insert(
        Operation::GitStatusBatch,
        (
            json!({ "paths": [".", "packages/web"], "pathspecs": ["src"] }),
            "git::StatusBatchResponse",
        ),
    );
    examples.insert(
        Operation::GitWorktreeBinding,
        (
            json!({
                "worktreePath": "worktrees/feature",
                "branch": "feature/login",
                "repositoryId": null,
            }),
            "git_repository::WorktreeBindingVerdict",
        ),
    );
    examples.insert(
        Operation::GitCommitDetail,
        (
            json!({ "path": ".", "oid": "abc", "base": null }),
            "git_repository::CommitDetail",
        ),
    );
    examples.insert(
        Operation::GitCommitFileDiff,
        (
            json!({ "path": ".", "oid": "abc", "base": null, "file": "a.txt" }),
            "git_repository::CommitFileDiff",
        ),
    );
    examples.insert(
        Operation::GitWorktrees,
        (repository(), "Vec<git_repository::WorktreeRecord>"),
    );
    examples.insert(
        Operation::GitRebaseTodo,
        (
            json!({ "path": ".", "onto": "main" }),
            "git_repository::RebaseTodoPreview",
        ),
    );
    examples.insert(
        Operation::GitTags,
        (repository(), "git_repository::TagSnapshot"),
    );
    examples.insert(
        Operation::GitRemotes,
        (repository(), "Vec<git_repository::RemoteRecord>"),
    );
    examples.insert(
        Operation::GitStashes,
        (repository(), "git_repository::StashSnapshot"),
    );
    examples.insert(
        Operation::GitStashDetail,
        (
            json!({ "path": ".", "oid": "abc" }),
            "git_repository::StashDetail",
        ),
    );
    examples.insert(
        Operation::GitIntegration,
        (repository(), "git_repository::IntegrationSnapshot"),
    );
    examples.insert(
        Operation::GitCherryPickPreview,
        (
            json!({ "path": ".", "oid": "abc", "mainline": null }),
            "git_repository::CherryPickPreview",
        ),
    );
    // Both hunk payloads name the checkout. Without it a nested repository's
    // hunk was read from — and applied to — the workspace root's index.
    examples.insert(
        Operation::GitHunks,
        (
            json!({ "path": "packages/web", "file": "a.txt", "scope": "worktree" }),
            "git_hunks::GitHunkDiff",
        ),
    );
    examples.insert(
        Operation::GitApplyHunk,
        (
            json!({ "path": "packages/web", "file": "a.txt", "scope": "worktree", "diffDigest": "abc", "hunkId": "h1", "action": "stage" }),
            "git_hunks::GitHunkResult",
        ),
    );
    examples.insert(
        Operation::GitMessageSource,
        (json!({}), "git_message::GitMessageSource"),
    );
    // Same empty request as the source read, a different answer: this one
    // carries the prompt as well, because the model runs on the controller
    // while the diff is captured on the host that owns the repository.
    examples.insert(
        Operation::GitMessageCapture,
        (json!({}), "git_message::GitMessageCapture"),
    );
    examples.insert(
        Operation::GitOperations,
        (repository(), "Vec<git_repository::OperationSnapshot>"),
    );
    for operation in [Operation::GitOperationGet, Operation::GitOperationCancel] {
        examples.insert(
            operation,
            (json!({ "id": "op-1" }), "git_repository::OperationSnapshot"),
        );
    }
    examples.insert(
        Operation::GitOperationStart,
        (
            json!({
                "path": ".",
                "action": { "kind": "fetch", "remote": "origin", "prune": false },
                "expected": { "headOid": "abc", "branch": "main" },
            }),
            "git_repository::OperationSnapshot",
        ),
    );

    /* -------------------------- file management ------------------------- */
    examples.insert(Operation::FileInfo, (path(), "imports::FileInfo"));
    examples.insert(
        Operation::FileEntryTrashList,
        (json!({}), "Vec<file_ops::TrashEntry>"),
    );
    examples.insert(
        Operation::FileEntryCreate,
        (
            json!({ "path": "notes/a.md", "kind": "file" }),
            "file_ops::EntryResult",
        ),
    );
    for operation in [Operation::FileEntryRename, Operation::FileEntryMove] {
        examples.insert(
            operation,
            (
                json!({ "from": "a.txt", "to": "b.txt" }),
                "file_ops::EntryResult",
            ),
        );
    }
    examples.insert(Operation::FileEntryDelete, (path(), "file_ops::TrashEntry"));
    examples.insert(
        Operation::FileEntryRestore,
        (json!({ "id": "0123456789abcdef" }), "file_ops::EntryResult"),
    );
    examples.insert(
        Operation::AssetImport,
        (
            json!({ "path": "photo.png", "workspaceId": "workspace-1" }),
            "api::assets::UploadAssetResponse",
        ),
    );

    /* ------------------------------ watching ---------------------------- */
    for operation in [Operation::WatchSubscribe, Operation::WatchUnsubscribe] {
        examples.insert(
            operation,
            (
                json!({ "paths": ["src/main.rs"] }),
                "v1::WorkerWatchSubscription",
            ),
        );
    }
    examples
}

/// The snapshot one operation produces: what a controller sends, and what the
/// two ends agreed the answer's type is.
fn snapshot(operation: WorkerServiceOperation, request: &Value, response: &str) -> Value {
    json!({
        "operation": operation as i32,
        "capability": capability(operation),
        "replay": format!("{:?}", replay(operation)).to_lowercase(),
        "request": request,
        "responseType": response,
    })
}

#[test]
fn the_service_contract_version_tracks_every_operation_payload() {
    let directory = fixtures();
    std::fs::create_dir_all(&directory).unwrap();
    let update = std::env::var("ARMADRA_UPDATE_SERVICE_FIXTURES").is_ok();
    let examples = examples();
    let mut differing = Vec::new();

    for operation in ALL {
        let (request, response) = examples
            .get(operation)
            .unwrap_or_else(|| panic!("{operation:?} has no contract example"));
        let current = snapshot(*operation, request, response);
        let path = directory.join(format!("{}.json", snake(*operation)));
        let serialized = format!("{}\n", serde_json::to_string_pretty(&current).unwrap());
        if update {
            std::fs::write(&path, &serialized).unwrap();
            continue;
        }
        let stored = std::fs::read_to_string(&path).unwrap_or_default();
        if stored != serialized {
            differing.push(snake(*operation));
        }
    }

    assert!(
        differing.is_empty(),
        "the service payloads changed for {differing:?} while CONTRACT_VERSION is still \
         {CONTRACT_VERSION}. Bump `remote::service::replay::CONTRACT_VERSION`, then regenerate \
         with ARMADRA_UPDATE_SERVICE_FIXTURES=1."
    );
}

/// The examples are the snapshot's whole content, so an example that no longer
/// deserializes into the type the Worker decodes would freeze a shape nothing
/// actually uses.
#[test]
fn every_request_example_still_deserializes_into_the_type_the_worker_decodes() {
    use WorkerServiceOperation as Operation;

    let examples = examples();
    let decode = |operation: Operation| -> Value { examples[&operation].0.clone() };

    serde_json::from_value::<service::PathPayload>(decode(Operation::FileRead)).unwrap();
    serde_json::from_value::<service::PathsPayload>(decode(Operation::GitStage)).unwrap();
    serde_json::from_value::<service::RevertPayload>(decode(Operation::GitRevert)).unwrap();
    serde_json::from_value::<service::CommitPayload>(decode(Operation::GitCommit)).unwrap();
    serde_json::from_value::<service::DiffPayload>(decode(Operation::GitDiff)).unwrap();
    serde_json::from_value::<service::IndexPayload>(decode(Operation::SearchIndex)).unwrap();
    serde_json::from_value::<service::WatchPollPayload>(decode(Operation::WatchPoll)).unwrap();
    serde_json::from_value::<service::git::RepositoriesPayload>(decode(Operation::GitRepositories))
        .unwrap();
    serde_json::from_value::<service::git::HistoryPayload>(decode(Operation::GitHistory)).unwrap();
    serde_json::from_value::<service::git::ReflogPayload>(decode(Operation::GitReflog)).unwrap();
    serde_json::from_value::<service::git::StatusBatchPayload>(decode(Operation::GitStatusBatch))
        .unwrap();
    serde_json::from_value::<service::git::LogPayload>(decode(Operation::GitLog)).unwrap();
    serde_json::from_value::<service::git::RootPayload>(decode(Operation::GitRefs)).unwrap();
    serde_json::from_value::<service::git::WorktreeBindingPayload>(decode(
        Operation::GitWorktreeBinding,
    ))
    .unwrap();
    serde_json::from_value::<service::git::CommitPayload>(decode(Operation::GitCommitDetail))
        .unwrap();
    serde_json::from_value::<service::git::CommitFilePayload>(decode(Operation::GitCommitFileDiff))
        .unwrap();
    serde_json::from_value::<service::git::RebaseTodoPayload>(decode(Operation::GitRebaseTodo))
        .unwrap();
    serde_json::from_value::<service::git::StashDetailPayload>(decode(Operation::GitStashDetail))
        .unwrap();
    serde_json::from_value::<service::git::CherryPickPayload>(decode(
        Operation::GitCherryPickPreview,
    ))
    .unwrap();
    serde_json::from_value::<service::git::HunksPayload>(decode(Operation::GitHunks)).unwrap();
    serde_json::from_value::<service::git::StartOperationPayload>(decode(
        Operation::GitOperationStart,
    ))
    .unwrap();
    serde_json::from_value::<service::git::OperationPayload>(decode(Operation::GitOperationGet))
        .unwrap();
    serde_json::from_value::<service::files::CreateEntryPayload>(decode(
        Operation::FileEntryCreate,
    ))
    .unwrap();
    serde_json::from_value::<service::files::RenameEntryPayload>(decode(
        Operation::FileEntryRename,
    ))
    .unwrap();
    serde_json::from_value::<service::files::RestoreEntryPayload>(decode(
        Operation::FileEntryRestore,
    ))
    .unwrap();
    serde_json::from_value::<service::assets::ImportAssetPayload>(decode(Operation::AssetImport))
        .unwrap();
}
