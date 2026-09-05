//! The method allowlist, the write gate, discovery and settings.

use crate::language::{
    Feature, ServerState,
    policy::{self, Denial, Requirement},
    registry,
    settings::LanguageSettings,
};

#[test]
fn an_unknown_method_is_refused_rather_than_forwarded() {
    // The whole point of an allowlist: a method nobody vetted does not reach a
    // language server just because it exists.
    assert_eq!(
        policy::requirement("textDocument/inlayHint"),
        Requirement::Never
    );
    assert_eq!(policy::requirement("$/somethingNew"), Requirement::Never);
    assert_eq!(
        policy::check("workspace/executeCommand", true),
        Err(Denial::NotAllowed)
    );
    // Even with every grant. `executeCommand` runs whatever the server likes
    // on the execution host, and no workspace permission covers that.
    assert_eq!(
        policy::check("window/showDocument", true),
        Err(Denial::NotAllowed)
    );
}

#[test]
fn the_write_gate_matches_the_editors_own_read_only_state() {
    for method in [
        "textDocument/rename",
        "textDocument/prepareRename",
        "textDocument/formatting",
        "textDocument/rangeFormatting",
        "codeAction/resolve",
    ] {
        assert_eq!(
            policy::check(method, false),
            Err(Denial::ReadOnly),
            "{method}"
        );
        assert_eq!(policy::check(method, true), Ok(()), "{method}");
    }
    for method in [
        "textDocument/hover",
        "textDocument/completion",
        "textDocument/definition",
        "textDocument/references",
        "textDocument/codeAction",
        "workspace/symbol",
        "$/cancelRequest",
    ] {
        assert_eq!(policy::check(method, false), Ok(()), "{method}");
    }
}

#[test]
fn a_code_action_that_only_runs_a_command_is_not_offered() {
    let with_edit = serde_json::json!({ "title": "fix", "edit": { "changes": {} } });
    let command_only = serde_json::json!({ "title": "run", "command": { "command": "x" } });
    let both = serde_json::json!({ "title": "both", "edit": {}, "command": { "command": "x" } });
    assert!(policy::code_action_is_offered(&with_edit));
    assert!(!policy::code_action_is_offered(&command_only));
    // An action with both is applied by its edit; the command is never run.
    assert!(policy::code_action_is_offered(&both));
}

#[test]
fn the_registry_answers_a_language_only_for_files_it_covers() {
    assert_eq!(registry::language_id_for("src/main.rs"), Some("rust"));
    assert_eq!(registry::language_id_for("src/App.tsx"), Some("typescript"));
    assert_eq!(registry::language_id_for("script.MJS"), Some("javascript"));
    // A whole file name, because `go.mod`'s extension is `mod`.
    assert_eq!(registry::language_id_for("go.mod"), Some("go"));
    assert_eq!(registry::language_id_for("nested/dir/go.sum"), Some("go"));
    // No language is an answer: the editor opens the file with no session
    // rather than starting a server that would not understand it.
    assert_eq!(registry::language_id_for("notes.txt"), None);
    assert_eq!(registry::language_id_for(".gitignore"), None);
    assert_eq!(registry::language_id_for("Makefile"), None);
}

#[test]
fn falling_back_to_a_linter_narrows_what_is_claimed() {
    let python = registry::language("python").expect("python is in the registry");
    let ruff = python
        .candidates
        .iter()
        .find(|candidate| candidate.server_id == "ruff")
        .expect("ruff is the python fallback");
    // `ruff server` is a linter. Claiming completion or rename for it would
    // put affordances in the editor that answer nothing.
    assert!(!ruff.features.contains(&Feature::Completion));
    assert!(!ruff.features.contains(&Feature::Rename));
    assert!(ruff.features.contains(&Feature::Diagnostics));
    // And it is the last resort, after the two full servers.
    assert_eq!(python.candidates.last().unwrap().server_id, "ruff");
}

#[test]
fn features_come_from_what_the_server_said_it_can_do() {
    let capabilities = serde_json::json!({
        "hoverProvider": true,
        "renameProvider": { "prepareProvider": true },
        // Explicitly false is explicitly absent.
        "completionProvider": false,
        "documentFormattingProvider": true,
    });
    let features = Feature::from_capabilities(&capabilities);
    assert!(features.contains(&Feature::Hover));
    assert!(features.contains(&Feature::Rename));
    assert!(features.contains(&Feature::Formatting));
    assert!(!features.contains(&Feature::Completion));
    // Push diagnostics are not advertised; a server that pushes says so by
    // pushing, so the capability is claimed unless the server opted out.
    assert!(features.contains(&Feature::Diagnostics));
}

#[test]
fn the_language_section_clamps_what_a_hand_edited_file_can_ask_for() {
    let document = serde_json::json!({
        "language": {
            "idleStopSeconds": 999_999,
            "maxServers": 0,
            "maxRssBytes": 1,
            "formatOnSave": true,
            "servers": {
                "ruff": { "path": "/usr/local/bin/ruff", "args": ["server", "--preview"] },
                "gopls": { "enabled": false }
            }
        }
    });
    let settings = LanguageSettings::from_document(&document);
    // Out of range snaps back to the default rather than being rejected, so a
    // hand-edited file still loads.
    assert_eq!(settings.idle_stop_seconds, 600);
    assert_eq!(settings.max_servers, 1);
    // A ceiling too small to hold any real server is raised, not honoured:
    // honouring it would be an instant kill loop.
    assert!(settings.max_rss_bytes >= 128 * 1024 * 1024);
    assert!(settings.format_on_save);
    let ruff = settings.server("ruff");
    assert_eq!(ruff.path, "/usr/local/bin/ruff");
    assert_eq!(ruff.args, vec!["server", "--preview"]);
    assert!(ruff.enabled);
    assert!(!settings.server("gopls").enabled);
    // A server nobody configured is enabled with the registry's own program.
    assert!(settings.server("rust-analyzer").enabled);
    assert!(settings.server("rust-analyzer").path.is_empty());
}

#[test]
fn a_zero_idle_stop_means_never_rather_than_immediately() {
    let document = serde_json::json!({ "language": { "idleStopSeconds": 0 } });
    assert_eq!(
        LanguageSettings::from_document(&document).idle_stop_seconds,
        0
    );
    let document = serde_json::json!({ "language": { "maxRssBytes": 0 } });
    assert_eq!(LanguageSettings::from_document(&document).max_rss_bytes, 0);
}

#[test]
fn normalising_settings_fills_defaults_without_touching_the_users_map() {
    let mut document = serde_json::json!({
        "language": { "servers": { "unknown-server": { "path": "/x" } } }
    })
    .as_object()
    .unwrap()
    .clone();
    crate::language::settings::normalize(&mut document);
    let language = &document["language"];
    assert_eq!(language["idleStopSeconds"], 600);
    assert_eq!(language["maxServers"], 6);
    assert_eq!(language["formatOnSave"], false);
    // An id this build has never heard of survives: a newer build may know it.
    assert_eq!(language["servers"]["unknown-server"]["path"], "/x");
}

#[test]
fn every_state_has_one_stable_name_on_the_wire() {
    for (state, name) in [
        (ServerState::Available, "available"),
        (ServerState::Unsupported, "unsupported"),
        (ServerState::IdleStopped, "idleStopped"),
        (ServerState::Crashed, "crashed"),
        (ServerState::Disconnected, "disconnected"),
    ] {
        assert_eq!(state.as_str(), name);
        assert_eq!(serde_json::to_value(state).unwrap(), name);
    }
}
