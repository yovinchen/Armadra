//! The closed candidate table — language service design §1.2.
//!
//! Everything here is a constant. There is no discovery by scanning the
//! machine for things that look like language servers, no download and no
//! install: a server is a program the user already has, named here or named in
//! their settings, and nothing else is ever started.
//!
//! Candidates are ordered, and the first one that probes successfully wins.
//! The order is a statement about capability, not preference — `pyright` before
//! `ruff` because falling back to `ruff` narrows the answer to diagnostics,
//! formatting and code actions, which [`ServerCandidate::features`] says out
//! loud rather than letting the editor discover it by asking and getting
//! nothing.

use super::{Feature, LanguageId};

/// One program that can serve one language.
#[derive(Debug, Clone, Copy)]
pub struct ServerCandidate {
    /// Stable id; also the settings key under `language.servers.<serverId>`.
    pub server_id: &'static str,
    /// The program name looked up on the execution host's PATH, or the
    /// absolute path a user pinned in settings.
    pub program: &'static str,
    /// Launch arguments. A fixed array, never assembled from user text.
    pub args: &'static [&'static str],
    /// What this server is expected to answer before it has been started.
    /// A running server replaces this with its own `InitializeResult`.
    pub features: &'static [Feature],
}

/// One language: what files it covers and who can serve it.
#[derive(Debug, Clone, Copy)]
pub struct LanguageEntry {
    pub language_id: LanguageId,
    /// Lowercase, without the dot. `go.mod` is matched by file name below.
    pub extensions: &'static [&'static str],
    pub candidates: &'static [ServerCandidate],
}

/// Everything a full server is expected to answer.
const FULL: &[Feature] = &[
    Feature::Completion,
    Feature::Diagnostics,
    Feature::Hover,
    Feature::Definition,
    Feature::References,
    Feature::Rename,
    Feature::Formatting,
    Feature::DocumentSymbol,
    Feature::WorkspaceSymbol,
    Feature::CodeAction,
    Feature::SignatureHelp,
];

/// `ruff server` is a linter with an LSP face. Claiming completion or rename
/// for it would put affordances in the editor that answer nothing.
const LINT_ONLY: &[Feature] = &[
    Feature::Diagnostics,
    Feature::Formatting,
    Feature::CodeAction,
];

/// `marksman` does links, headings and symbols; preview stays with the
/// renderer the editor already has.
const MARKDOWN: &[Feature] = &[
    Feature::Completion,
    Feature::Definition,
    Feature::References,
    Feature::DocumentSymbol,
    Feature::WorkspaceSymbol,
    Feature::Diagnostics,
];

/// Structural formats: diagnostics, completion and hover from a schema.
const STRUCTURED: &[Feature] = &[
    Feature::Completion,
    Feature::Diagnostics,
    Feature::Hover,
    Feature::Formatting,
    Feature::DocumentSymbol,
];

pub const LANGUAGES: &[LanguageEntry] = &[
    LanguageEntry {
        language_id: "typescript",
        extensions: &["ts", "tsx", "mts", "cts"],
        candidates: &[ServerCandidate {
            server_id: "typescript-language-server",
            program: "typescript-language-server",
            args: &["--stdio"],
            features: FULL,
        }],
    },
    LanguageEntry {
        language_id: "javascript",
        extensions: &["js", "jsx", "mjs", "cjs"],
        candidates: &[ServerCandidate {
            server_id: "typescript-language-server",
            program: "typescript-language-server",
            args: &["--stdio"],
            features: FULL,
        }],
    },
    LanguageEntry {
        language_id: "rust",
        extensions: &["rs"],
        candidates: &[ServerCandidate {
            server_id: "rust-analyzer",
            program: "rust-analyzer",
            args: &[],
            features: FULL,
        }],
    },
    LanguageEntry {
        language_id: "go",
        extensions: &["go"],
        candidates: &[ServerCandidate {
            server_id: "gopls",
            program: "gopls",
            args: &[],
            features: FULL,
        }],
    },
    LanguageEntry {
        language_id: "python",
        extensions: &["py", "pyi"],
        candidates: &[
            ServerCandidate {
                server_id: "pyright",
                program: "pyright-langserver",
                args: &["--stdio"],
                features: FULL,
            },
            ServerCandidate {
                server_id: "basedpyright",
                program: "basedpyright-langserver",
                args: &["--stdio"],
                features: FULL,
            },
            ServerCandidate {
                server_id: "ruff",
                program: "ruff",
                args: &["server"],
                features: LINT_ONLY,
            },
        ],
    },
    LanguageEntry {
        language_id: "json",
        extensions: &["json", "jsonc"],
        candidates: &[ServerCandidate {
            server_id: "vscode-json-language-server",
            program: "vscode-json-language-server",
            args: &["--stdio"],
            features: STRUCTURED,
        }],
    },
    LanguageEntry {
        language_id: "yaml",
        extensions: &["yaml", "yml"],
        candidates: &[ServerCandidate {
            server_id: "yaml-language-server",
            program: "yaml-language-server",
            args: &["--stdio"],
            features: STRUCTURED,
        }],
    },
    LanguageEntry {
        language_id: "markdown",
        extensions: &["md", "markdown"],
        candidates: &[ServerCandidate {
            server_id: "marksman",
            program: "marksman",
            args: &["server"],
            features: MARKDOWN,
        }],
    },
];

/// Whole file names that name a language on their own. Without these, `go.mod`
/// would be read as the extension `mod` and get no language at all.
const FILE_NAMES: &[(&str, LanguageId)] = &[("go.mod", "go"), ("go.sum", "go"), ("go.work", "go")];

pub fn languages() -> &'static [LanguageEntry] {
    LANGUAGES
}

pub fn language(language_id: &str) -> Option<&'static LanguageEntry> {
    LANGUAGES
        .iter()
        .find(|entry| entry.language_id == language_id)
}

/// The language of a workspace-relative path, or `None` when nothing here
/// covers it. `None` is an answer: the editor opens the file with no session
/// rather than starting a server that would not understand it.
pub fn language_id_for(path: &str) -> Option<LanguageId> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    if let Some((_, language_id)) = FILE_NAMES.iter().find(|(file, _)| *file == name) {
        return Some(language_id);
    }
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    let extension = name[dot + 1..].to_ascii_lowercase();
    LANGUAGES
        .iter()
        .find(|entry| entry.extensions.contains(&extension.as_str()))
        .map(|entry| entry.language_id)
}

/// The candidate a server id belongs to, with the language that offers it.
pub fn candidate(server_id: &str) -> Option<(&'static LanguageEntry, &'static ServerCandidate)> {
    LANGUAGES.iter().find_map(|entry| {
        entry
            .candidates
            .iter()
            .find(|candidate| candidate.server_id == server_id)
            .map(|candidate| (entry, candidate))
    })
}
