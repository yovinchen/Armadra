//! Method → required grant (design §3.1).
//!
//! The list is closed. A method that is not named here is refused with
//! `-32601`, which means a server that grows a new capability cannot be driven
//! through this proxy until somebody adds it deliberately. That is the point:
//! an allowlist that falls through to "allow" is a passthrough with extra
//! steps, and a passthrough would let a browser ask a language server to run
//! `workspace/executeCommand`.
//!
//! The check runs on the **execution host**, not only in the controller, for
//! the same reason `WorkerServiceRequest` re-checks its grants there: the
//! machine that would do the thing is the machine that must refuse.

/// What a method needs before it may reach the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requirement {
    /// The workspace's `execute` grant, which every session already has —
    /// without it no server was started at all.
    Execute,
    /// `execute` and `write`. These either change the buffer or change files.
    Write,
    /// Never allowed, whatever the workspace grants.
    Never,
}

/// Read-only traffic: it asks the server questions about text it already has.
const READ_METHODS: &[&str] = &[
    "initialized",
    "exit",
    "shutdown",
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didClose",
    "textDocument/didSave",
    "textDocument/completion",
    "completionItem/resolve",
    "textDocument/hover",
    "textDocument/signatureHelp",
    "textDocument/definition",
    "textDocument/typeDefinition",
    "textDocument/implementation",
    "textDocument/declaration",
    "textDocument/references",
    "textDocument/documentSymbol",
    "textDocument/documentHighlight",
    "textDocument/codeAction",
    "textDocument/foldingRange",
    "workspace/symbol",
    "workspaceSymbol/resolve",
    "$/cancelRequest",
    "$/setTrace",
];

/// Traffic that produces an edit. The editor is read-only without the write
/// grant anyway, so refusing these keeps the two consistent instead of
/// offering a rename that could never be applied.
const WRITE_METHODS: &[&str] = &[
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "textDocument/onTypeFormatting",
    "textDocument/prepareRename",
    "textDocument/rename",
    "codeAction/resolve",
];

/// Refused in every workspace. `executeCommand` runs whatever the server feels
/// like on the execution host, and a code action carrying a `command` is the
/// same thing wearing a different hat (design §6.2).
const NEVER_METHODS: &[&str] = &[
    "workspace/executeCommand",
    "window/showDocument",
    "workspace/applyEdit",
    // `initialize` is answered by the Manager from its cached result; a
    // session that sends its own would re-handshake a shared server.
    "initialize",
];

pub fn requirement(method: &str) -> Requirement {
    if NEVER_METHODS.contains(&method) {
        return Requirement::Never;
    }
    if WRITE_METHODS.contains(&method) {
        return Requirement::Write;
    }
    if READ_METHODS.contains(&method) {
        return Requirement::Execute;
    }
    // Unknown is refused, not allowed. Nothing falls through.
    Requirement::Never
}

/// Whether one session may send one method, and why not when it may not.
pub fn check(method: &str, allow_write: bool) -> Result<(), Denial> {
    match requirement(method) {
        Requirement::Execute => Ok(()),
        Requirement::Write if allow_write => Ok(()),
        Requirement::Write => Err(Denial::ReadOnly),
        Requirement::Never => Err(Denial::NotAllowed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denial {
    /// The workspace is open read-only.
    ReadOnly,
    /// The method is off the list entirely.
    NotAllowed,
}

impl Denial {
    pub fn code(self) -> i64 {
        super::jsonrpc::METHOD_NOT_FOUND
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::ReadOnly => "This workspace is opened read-only",
            Self::NotAllowed => "This language method is not available",
        }
    }
}

/// Server-initiated requests the Manager answers itself, so they never reach
/// the browser (design §2.2 `mux`).
pub const SERVER_REQUESTS: &[&str] = &[
    "workspace/configuration",
    "client/registerCapability",
    "client/unregisterCapability",
    "window/workDoneProgress/create",
    "workspace/workspaceFolders",
    "workspace/applyEdit",
];

/// A code action that carries a `command` is not applied in the first version:
/// running it would be `workspace/executeCommand` by another route. Actions
/// that carry only an `edit` are kept.
pub fn code_action_is_offered(action: &serde_json::Value) -> bool {
    action.get("command").is_none() || action.get("edit").is_some()
}

/// The gate a server's own `workspace/applyEdit` passes.
///
/// It is the same gate a client-initiated rename passes, and it is spelled
/// through the same table so the two cannot drift: whatever
/// `textDocument/rename` requires is what an edit the server asks for
/// requires. `workspace/applyEdit` also appears in [`NEVER_METHODS`], and that
/// is not a contradiction: a *session* may not send one — a browser must not
/// be able to forge an edit in the server's name — while a server may ask for
/// one and be answered honestly. Direction, not rule.
pub fn server_edit_allowed(allow_write: bool) -> Result<(), Denial> {
    check("textDocument/rename", allow_write)
}
