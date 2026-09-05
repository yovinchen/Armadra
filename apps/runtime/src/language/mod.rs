//! Editor language services (LSP) —
//! [design](../../../../docs/design/language-service.md).
//!
//! ## What this is
//!
//! The execution host's side of LSP. A local workspace's servers run inside
//! this process; a remote workspace's run inside the remote Worker, from the
//! same code. The browser is never an LSP client: it holds a *session*, and
//! the [`Manager`] here answers `initialize` on the server's behalf so a
//! restart is invisible to the editor.
//!
//! ## What it refuses to be
//!
//! * **Not an installer.** Only programs the user already has are ever run,
//!   and only after `--version` exits 0 ([`discover`]). Nothing is downloaded.
//! * **Not a passthrough.** [`policy`] holds a closed method allowlist;
//!   `workspace/executeCommand` and every unknown method are refused on the
//!   execution host, not merely unsent by the controller.
//! * **Not a path leak.** The browser sees `armadra:///<rel>` and nothing
//!   else; [`uri`] rewrites in both directions and marks anything outside the
//!   workspace root as external ([`uri::EXTERNAL_SCHEME`]).
//!
//! ## What is never logged
//!
//! `payload_json` holds file text, completion bodies and paths. No layer —
//! including `debug` — writes it. Traces carry session id, server id, method,
//! JSON-RPC id, byte counts and state transitions, and that is all (§3.4).

pub mod discover;
pub mod documents;
pub mod edits;
pub mod jsonrpc;
pub mod lifecycle;
pub mod link;
pub mod mux;
pub mod policy;
pub mod registry;
pub mod routes;
pub mod server;
pub mod session;
pub mod settings;
pub mod uri;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

/// A language identifier as the LSP spec spells it (`rust`, `typescript`).
pub type LanguageId = &'static str;

/// Stable reason keys. The interface localises them; the runtime never invents
/// prose here, because a reason a client cannot match is a reason it cannot
/// explain.
pub mod reason {
    pub const SERVER_NOT_FOUND: &str = "server_not_found";
    pub const SERVER_PROBE_FAILED: &str = "server_probe_failed";
    pub const EXECUTION_NOT_GRANTED: &str = "execution_not_granted";
    pub const DISABLED: &str = "disabled";
    pub const LANGUAGE_UNKNOWN: &str = "language_unknown";
    pub const TOO_MANY_SERVERS: &str = "too_many_servers";
    pub const CONTAINMENT_UNAVAILABLE: &str = "containment_unavailable";
    pub const RESOURCE_EXHAUSTED: &str = "resource_exhausted";
    pub const IDLE: &str = "idle";
    pub const USER: &str = "user";
    pub const CRASHED: &str = "crashed";
    pub const RESTART_BUDGET_EXHAUSTED: &str = "restart_budget_exhausted";
    pub const WORKSPACE_CLOSED: &str = "workspace_closed";
}

/* --------------------------------- limits --------------------------------- */

/// Matches the editor's own preview ceiling: a file it will not open is a file
/// no session is opened for.
pub const MAX_DOCUMENT_BYTES: u32 = 1024 * 1024;
/// Per execution host.
pub const MAX_SESSIONS: u32 = 32;
/// One JSON-RPC message. Below the 1 MiB Worker frame so an envelope always
/// fits around it (§2.7).
pub const MAX_MESSAGE_BYTES: u32 = 960 * 1024;
/// In-flight requests per session; beyond this the session is told to slow
/// down (`-32803`) rather than being allowed to queue without bound.
pub const MAX_IN_FLIGHT: usize = 32;
/// One request. On expiry the server is sent `$/cancelRequest`.
pub const REQUEST_TIMEOUT_SECONDS: u64 = 30;
/// stderr kept per server, tail only, in memory.
pub const STDERR_TAIL_BYTES: usize = 64 * 1024;
/// Crashes tolerated inside [`RESTART_WINDOW_SECONDS`] before a server stops
/// being restarted and stays `crashed` with its stderr tail.
pub const MAX_RESTARTS: u32 = 3;
pub const RESTART_WINDOW_SECONDS: i64 = 600;
/// Back-off before each restart, in seconds.
pub const RESTART_BACKOFF_SECONDS: [u64; 3] = [1, 5, 20];

/* ---------------------------------- types --------------------------------- */

/// Where one server is in its life (design §1.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerState {
    /// Probed, not started. Discovery never starts anything.
    Available,
    /// `reason` says what is missing.
    Unsupported,
    Starting,
    Running,
    /// Stopped after an idle period. Sessions survive and the shadow documents
    /// are kept, so the next `didOpen` is a restart, not a reset.
    IdleStopped,
    Crashed,
    /// A person stopped it, or a ceiling did. Never restarted on its own.
    Stopped,
    /// The remote link went away; this runtime holds nothing current.
    Disconnected,
}

impl ServerState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unsupported => "unsupported",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::IdleStopped => "idleStopped",
            Self::Crashed => "crashed",
            Self::Stopped => "stopped",
            Self::Disconnected => "disconnected",
        }
    }

    pub fn to_proto(self) -> armadra_protocol::v1::LanguageServerState {
        use armadra_protocol::v1::LanguageServerState as Wire;
        match self {
            Self::Available => Wire::Available,
            Self::Unsupported => Wire::Unsupported,
            Self::Starting => Wire::Starting,
            Self::Running => Wire::Running,
            Self::IdleStopped => Wire::IdleStopped,
            Self::Crashed => Wire::Crashed,
            Self::Stopped => Wire::Stopped,
            Self::Disconnected => Wire::Disconnected,
        }
    }
}

/// What a server answers. A feature that is absent is absent: the editor
/// registers no affordance rather than one that returns nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    Completion,
    Diagnostics,
    Hover,
    Definition,
    References,
    Rename,
    Formatting,
    DocumentSymbol,
    WorkspaceSymbol,
    CodeAction,
    SignatureHelp,
}

impl Feature {
    pub fn to_proto(self) -> armadra_protocol::v1::LanguageFeature {
        use armadra_protocol::v1::LanguageFeature as Wire;
        match self {
            Self::Completion => Wire::Completion,
            Self::Diagnostics => Wire::Diagnostics,
            Self::Hover => Wire::Hover,
            Self::Definition => Wire::Definition,
            Self::References => Wire::References,
            Self::Rename => Wire::Rename,
            Self::Formatting => Wire::Formatting,
            Self::DocumentSymbol => Wire::DocumentSymbol,
            Self::WorkspaceSymbol => Wire::WorkspaceSymbol,
            Self::CodeAction => Wire::CodeAction,
            Self::SignatureHelp => Wire::SignatureHelp,
        }
    }

    /// The features an `InitializeResult.capabilities` object claims.
    ///
    /// A provider is present when its key is anything other than `false` or
    /// absent — the spec lets a server answer `true` or an options object, and
    /// both mean "yes".
    pub fn from_capabilities(capabilities: &serde_json::Value) -> Vec<Self> {
        const PROVIDERS: &[(&str, Feature)] = &[
            ("completionProvider", Feature::Completion),
            ("hoverProvider", Feature::Hover),
            ("definitionProvider", Feature::Definition),
            ("typeDefinitionProvider", Feature::Definition),
            ("implementationProvider", Feature::Definition),
            ("referencesProvider", Feature::References),
            ("renameProvider", Feature::Rename),
            ("documentFormattingProvider", Feature::Formatting),
            ("documentRangeFormattingProvider", Feature::Formatting),
            ("documentSymbolProvider", Feature::DocumentSymbol),
            ("workspaceSymbolProvider", Feature::WorkspaceSymbol),
            ("codeActionProvider", Feature::CodeAction),
            ("signatureHelpProvider", Feature::SignatureHelp),
            ("diagnosticProvider", Feature::Diagnostics),
        ];
        let mut features: Vec<Feature> = Vec::new();
        for (key, feature) in PROVIDERS {
            let present = capabilities
                .get(*key)
                .is_some_and(|value| value != &serde_json::Value::Bool(false) && !value.is_null());
            if present && !features.contains(feature) {
                features.push(*feature);
            }
        }
        // Push diagnostics are not advertised at all: a server that pushes
        // `textDocument/publishDiagnostics` says so by doing it. Every server
        // the registry knows either pushes or pulls, so the capability is
        // claimed unless the server explicitly opted out of both.
        if !features.contains(&Feature::Diagnostics) {
            features.push(Feature::Diagnostics);
        }
        features
    }
}

/// One candidate server for one language on this execution host. Mirrors
/// `LanguageServerDescriptor` in `language.proto` and
/// `languageServerDescriptorSchema` in `@armadra/shared`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDescriptor {
    pub server_id: String,
    pub language_id: String,
    pub file_extensions: Vec<String>,
    /// Absolute path on this host; empty when nothing was found.
    pub executable: String,
    pub version: String,
    pub state: ServerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub features: Vec<Feature>,
    pub restart_count: u32,
    /// Only while the process is running. `None` is not zero: a pid of 0 would
    /// be a process the resource panel could claim.
    pub pid: Option<i64>,
    pub start_time_unix_ms: Option<i64>,
    pub open_documents: u32,
    pub probed_at_unix_ms: i64,
}

impl ServerDescriptor {
    pub fn to_proto(&self) -> armadra_protocol::v1::LanguageServerDescriptor {
        armadra_protocol::v1::LanguageServerDescriptor {
            server_id: self.server_id.clone(),
            language_id: self.language_id.clone(),
            file_extensions: self.file_extensions.clone(),
            executable: self.executable.clone(),
            version: self.version.clone(),
            state: self.state.to_proto() as i32,
            reason: self.reason.clone().unwrap_or_default(),
            features: self
                .features
                .iter()
                .map(|feature| feature.to_proto() as i32)
                .collect(),
            restart_count: self.restart_count,
            pid: self.pid,
            start_time_unix_ms: self.start_time_unix_ms,
            open_documents: self.open_documents,
            probed_at_unix_ms: self.probed_at_unix_ms,
        }
    }
}

/// `GET /api/workspaces/{id}/language-service` (design §2.9).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServiceStatus {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub execution_host_id: String,
    pub servers: Vec<ServerDescriptor>,
}

/// The ceilings a client must respect, as `language.proto` states them.
pub fn capability_limits() -> (u32, u32, u32) {
    (MAX_DOCUMENT_BYTES, MAX_SESSIONS, MAX_MESSAGE_BYTES)
}

pub use lifecycle::Manager;
pub use link::{LanguageLink, LocalLink};
