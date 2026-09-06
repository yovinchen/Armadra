//! What may be re-sent, what a Worker must advertise before it is asked, and
//! the version that ties the two ends' JSON payloads together (design §3.5).

use armadra_protocol::v1::WorkerServiceOperation;

/// The version of the version-locked service payloads.
///
/// Both ends of a proxied `WorkerServiceRequest` serialize the same Rust
/// types, and nothing negotiates their shape. Before this constant existed the
/// guarantee came from `runtime_version` being *identical*, which made every
/// patch release of the controller reject every patch release of the Worker.
/// The constant replaces that with the thing actually being asserted: the
/// payload shapes are the same. Bump it whenever a request or response type
/// behind any `WorkerServiceOperation` changes in a way an older peer would
/// misread — `apps/runtime/tests/remote_contract.rs` fails until you do.
pub const CONTRACT_VERSION: u32 = 1;

/// Capabilities a Worker advertises per group of operations. A Worker that
/// omits one answers that group with 501 naming the capability, and keeps
/// serving the rest: a remote workspace whose Worker predates the repository
/// panel should still open files.
pub const GIT_PANEL_CAPABILITY: &str = "remote.git.panel.v1";
pub const FILES_MANAGE_CAPABILITY: &str = "remote.files.manage.v1";
pub const UPLOAD_CAPABILITY: &str = "remote.upload.v1";
pub const WATCH_CAPABILITY: &str = "remote.watch.v1";

/// Whether an operation may be replayed on a fresh connection after a
/// transport failure. `Never` is the default for anything with an effect: a
/// request that was already written is reported as an unknown outcome, never
/// re-sent (design §3.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replay {
    Safe,
    Never,
}

/// Read-only operations may be retried once; everything that writes may not.
pub fn replay(operation: WorkerServiceOperation) -> Replay {
    use WorkerServiceOperation as Operation;
    match operation {
        Operation::FileRead
        | Operation::FileVersion
        | Operation::SearchContent
        | Operation::SearchIndex
        | Operation::WatchPoll
        | Operation::GitStatus
        | Operation::GitHeadCommit
        | Operation::GitDiff
        | Operation::GitRepositories
        | Operation::GitBranches
        | Operation::GitHistory
        | Operation::GitCommitDetail
        | Operation::GitCommitFileDiff
        | Operation::GitWorktrees
        | Operation::GitRebaseTodo
        | Operation::GitTags
        | Operation::GitRemotes
        | Operation::GitStashes
        | Operation::GitStashDetail
        | Operation::GitIntegration
        | Operation::GitCherryPickPreview
        | Operation::GitHunks
        | Operation::GitMessageSource
        | Operation::GitOperations
        | Operation::GitOperationGet
        | Operation::FileInfo
        | Operation::FileEntryTrashList
        | Operation::WatchSubscribe
        | Operation::WatchUnsubscribe => Replay::Safe,
        Operation::GitStage
        | Operation::GitUnstage
        | Operation::GitRevert
        | Operation::GitResolve
        | Operation::GitCommit
        | Operation::GitInit
        | Operation::GitOperationStart
        | Operation::GitOperationCancel
        | Operation::GitApplyHunk
        | Operation::FileEntryCreate
        | Operation::FileEntryRename
        | Operation::FileEntryMove
        | Operation::FileEntryDelete
        | Operation::FileEntryRestore
        | Operation::AssetImport
        | Operation::Unspecified => Replay::Never,
    }
}

/// The capability a Worker must advertise to serve `operation`, or `None` when
/// it is part of the base `remote.execution.v1` surface every Worker that
/// answers the handshake already has.
pub fn capability(operation: WorkerServiceOperation) -> Option<&'static str> {
    use WorkerServiceOperation as Operation;
    match operation {
        Operation::GitRepositories
        | Operation::GitBranches
        | Operation::GitHistory
        | Operation::GitCommitDetail
        | Operation::GitCommitFileDiff
        | Operation::GitWorktrees
        | Operation::GitRebaseTodo
        | Operation::GitTags
        | Operation::GitRemotes
        | Operation::GitStashes
        | Operation::GitStashDetail
        | Operation::GitIntegration
        | Operation::GitCherryPickPreview
        | Operation::GitHunks
        | Operation::GitMessageSource
        | Operation::GitOperations
        | Operation::GitOperationGet
        | Operation::GitOperationStart
        | Operation::GitOperationCancel
        | Operation::GitApplyHunk => Some(GIT_PANEL_CAPABILITY),
        Operation::FileInfo
        | Operation::FileEntryTrashList
        | Operation::FileEntryCreate
        | Operation::FileEntryRename
        | Operation::FileEntryMove
        | Operation::FileEntryDelete
        | Operation::FileEntryRestore
        | Operation::AssetImport => Some(FILES_MANAGE_CAPABILITY),
        Operation::WatchSubscribe | Operation::WatchUnsubscribe => Some(WATCH_CAPABILITY),
        _ => None,
    }
}

/// Every operation this build knows how to send or serve, in wire order. The
/// contract snapshot walks it, so an operation added to the enum without an
/// entry here is caught by `apps/runtime/tests/remote_contract.rs` rather than
/// shipping unserved.
pub const ALL: &[WorkerServiceOperation] = {
    use WorkerServiceOperation as Operation;
    &[
        Operation::FileVersion,
        Operation::SearchContent,
        Operation::SearchIndex,
        Operation::WatchPoll,
        Operation::FileRead,
        Operation::GitStatus,
        Operation::GitHeadCommit,
        Operation::GitDiff,
        Operation::GitStage,
        Operation::GitUnstage,
        Operation::GitRevert,
        Operation::GitResolve,
        Operation::GitCommit,
        Operation::GitInit,
        Operation::GitRepositories,
        Operation::GitBranches,
        Operation::GitHistory,
        Operation::GitCommitDetail,
        Operation::GitCommitFileDiff,
        Operation::GitWorktrees,
        Operation::GitRebaseTodo,
        Operation::GitTags,
        Operation::GitRemotes,
        Operation::GitStashes,
        Operation::GitStashDetail,
        Operation::GitIntegration,
        Operation::GitCherryPickPreview,
        Operation::GitHunks,
        Operation::GitMessageSource,
        Operation::GitOperations,
        Operation::GitOperationGet,
        Operation::GitOperationStart,
        Operation::GitOperationCancel,
        Operation::GitApplyHunk,
        Operation::FileEntryTrashList,
        Operation::FileInfo,
        Operation::FileEntryCreate,
        Operation::FileEntryRename,
        Operation::FileEntryMove,
        Operation::FileEntryDelete,
        Operation::FileEntryRestore,
        Operation::AssetImport,
        Operation::WatchSubscribe,
        Operation::WatchUnsubscribe,
    ]
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_that_writes_is_marked_unreplayable() {
        use WorkerServiceOperation as Operation;
        for operation in [
            Operation::GitStage,
            Operation::GitUnstage,
            Operation::GitRevert,
            Operation::GitResolve,
            Operation::GitCommit,
            Operation::GitInit,
            Operation::GitOperationStart,
            Operation::GitOperationCancel,
            Operation::GitApplyHunk,
            Operation::FileEntryCreate,
            Operation::FileEntryRename,
            Operation::FileEntryMove,
            Operation::FileEntryDelete,
            Operation::FileEntryRestore,
            Operation::AssetImport,
        ] {
            assert_eq!(replay(operation), Replay::Never, "{operation:?}");
        }
        for operation in [
            Operation::FileVersion,
            Operation::SearchContent,
            Operation::SearchIndex,
            Operation::WatchPoll,
            Operation::GitStatus,
            Operation::GitHeadCommit,
            Operation::GitDiff,
            Operation::GitBranches,
            Operation::GitHistory,
            Operation::GitStashes,
            Operation::GitWorktrees,
            Operation::GitOperations,
            Operation::FileInfo,
            Operation::FileEntryTrashList,
        ] {
            assert_eq!(replay(operation), Replay::Safe, "{operation:?}");
        }
    }

    /// Listing the trash and restoring from it are opposite kinds of request,
    /// which is why they cannot share one operation number: a lost listing is
    /// retried, a lost restore is reported as an unknown outcome.
    #[test]
    fn listing_the_trash_and_restoring_from_it_replay_differently() {
        assert_eq!(
            replay(WorkerServiceOperation::FileEntryTrashList),
            Replay::Safe
        );
        assert_eq!(
            replay(WorkerServiceOperation::FileEntryRestore),
            Replay::Never
        );
    }

    #[test]
    fn every_listed_operation_has_a_replay_rule_and_a_capability_group() {
        for operation in ALL {
            // `Unspecified` is the only value with no rule, and it is not listed.
            assert_ne!(*operation, WorkerServiceOperation::Unspecified);
            let _ = replay(*operation);
            let _ = capability(*operation);
        }
        assert_eq!(ALL.len(), 44, "an operation was added without a snapshot");
    }
}
