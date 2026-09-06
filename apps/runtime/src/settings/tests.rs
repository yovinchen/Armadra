//! Tests for the settings document: defaults, per-section normalisation,
//! custom agents and the patch/persist round trip.

use super::*;

#[test]
fn defaults_fill_in_and_unknown_keys_survive() {
    let document = normalize(&serde_json::json!({ "editor": { "fontSize": 13 } }));
    assert_eq!(document["terminal"]["backend"], "auto");
    assert_eq!(document["terminal"]["detachedGraceMinutes"], 1440);
    assert_eq!(document["usage"]["enabled"], true);
    assert_eq!(document["editor"]["fontSize"], 13);
}

#[test]
fn usage_can_be_switched_off() {
    let store = SettingsStore::in_memory(serde_json::json!({}));
    assert!(store.usage_enabled());
    store
        .patch(&serde_json::json!({ "usage": { "enabled": false } }))
        .unwrap();
    assert!(!store.usage_enabled());
}

/// S03 §4.1: the channel and the two switches are part of the document, so
/// a reload and a second client see the same answer.
#[test]
fn update_preferences_default_to_checking_but_not_downloading() {
    let document = normalize(&serde_json::json!({}));
    assert_eq!(document["updates"]["channel"], "stable");
    assert_eq!(document["updates"]["autoCheck"], true);
    // Spending somebody's bandwidth is a choice they make, not one they
    // discover (design §2.4).
    assert_eq!(document["updates"]["autoDownload"], false);
    // The notification and the tray item are the only two ways of learning a
    // restart is waiting without opening this page, so it starts on.
    assert_eq!(document["updates"]["notify"], true);

    let chosen = normalize(&serde_json::json!({
        "updates": {
            "channel": "beta", "autoCheck": false, "autoDownload": true, "notify": false
        }
    }));
    assert_eq!(chosen["updates"]["channel"], "beta");
    assert_eq!(chosen["updates"]["autoCheck"], false);
    assert_eq!(chosen["updates"]["autoDownload"], true);
    assert_eq!(chosen["updates"]["notify"], false);
}

/// A channel nobody offers — including "development", which describes a
/// build rather than a preference — reads back as stable.
#[test]
fn an_unknown_update_channel_snaps_back_to_stable() {
    for channel in serde_json::json!(["development", "nightly", "", "Stable", 7, null])
        .as_array()
        .unwrap()
    {
        let document = normalize(&serde_json::json!({ "updates": { "channel": channel } }));
        assert_eq!(document["updates"]["channel"], "stable", "{channel}");
    }
    let broken = normalize(&serde_json::json!({
        "updates": { "autoCheck": "yes", "autoDownload": 1, "notify": "off" }
    }));
    assert_eq!(broken["updates"]["autoCheck"], true);
    assert_eq!(broken["updates"]["autoDownload"], false);
    assert_eq!(broken["updates"]["notify"], true);
}

#[test]
fn invalid_values_fall_back_to_the_defaults() {
    let document = normalize(&serde_json::json!({
        "terminal": { "backend": "screen", "detachedGraceMinutes": 0 }
    }));
    assert_eq!(document["terminal"]["backend"], "auto");
    assert_eq!(document["terminal"]["detachedGraceMinutes"], 1440);
}

#[test]
fn ssh_hosts_round_trip_and_the_invalid_ones_never_come_back() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    let store = SettingsStore::load_from(&path);
    assert!(store.ssh_hosts().is_empty());

    let document = store
        .patch(&serde_json::json!({
            "ssh": { "hosts": [
                { "id": "box", "name": "Box", "host": "example.com",
                  "user": "ada", "port": 2222 },
                { "id": "evil", "name": "Evil", "host": "a;rm -rf /" },
            ] }
        }))
        .unwrap();
    assert_eq!(document["ssh"]["hosts"].as_array().unwrap().len(), 1);

    let hosts = SettingsStore::load_from(&path).ssh_hosts();
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0].host, "example.com");
    assert_eq!(hosts[0].user.as_deref(), Some("ada"));
    assert_eq!(hosts[0].port, Some(2222));
    assert!(store.ssh_host("box").is_some());
    assert!(store.ssh_host("nope").is_none());

    // A patch replaces the array wholesale, so deleting is `hosts: []`.
    let document = store
        .patch(&serde_json::json!({ "ssh": { "hosts": [] } }))
        .unwrap();
    assert_eq!(document["ssh"]["hosts"].as_array().unwrap().len(), 0);
}

/* ---------------------------- custom agents --------------------------- */

fn custom_document(entries: Value) -> Value {
    normalize(&serde_json::json!({ "agents": { "custom": entries } }))
}

#[test]
fn a_custom_agent_round_trips_with_its_defaults_filled_in() {
    let document = custom_document(serde_json::json!([
        { "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
          "args": ["hello"], "baseAgent": "codex" },
        { "id": "custom:bare", "label": "Bare", "launchCmd": "wrapper" },
    ]));
    let agents = parse_custom_agents(&document);
    assert_eq!(agents.len(), 2);
    assert_eq!(agents[0].id, "custom:echo");
    assert_eq!(agents[0].args, vec!["hello".to_owned()]);
    assert_eq!(agents[0].base_agent, "codex");
    // Absent optionals get the documented defaults, not a missing key.
    assert_eq!(agents[1].base_agent, "claude");
    assert_eq!(agents[1].color, "#a78bfa");
    assert!(agents[1].args.is_empty());
    assert_eq!(document["agents"]["custom"][1]["baseAgent"], "claude");

    // A file that never had custom agents does not grow the section.
    assert!(normalize(&serde_json::json!({})).get("agents").is_none());
}

#[test]
fn unusable_custom_agents_are_dropped_and_duplicates_collapse() {
    let document = custom_document(serde_json::json!([
        { "id": "claude", "label": "Not custom", "launchCmd": "claude" },
        { "id": "custom:ok", "label": "First", "launchCmd": "a" },
        { "id": "custom:ok", "label": "Duplicate", "launchCmd": "b" },
        { "id": "custom:no-name", "label": "   ", "launchCmd": "a" },
        { "id": "custom:no-command", "label": "Nameless", "launchCmd": "" },
        { "id": "custom:newline", "label": "Sneaky", "launchCmd": "a\nrm -rf /" },
        { "id": "custom:bad id!", "label": "Bad", "launchCmd": "a" },
        "not an object",
    ]));
    let agents = parse_custom_agents(&document);
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].label, "First");
    assert_eq!(document["agents"]["custom"].as_array().unwrap().len(), 1);
}

#[test]
fn env_keys_are_validated_and_the_hook_names_cannot_be_shadowed() {
    assert!(valid_env_key("API_KEY"));
    assert!(valid_env_key("_PRIVATE9"));
    assert!(!valid_env_key("9LIVES"));
    assert!(!valid_env_key("lower"));
    assert!(!valid_env_key("HAS-DASH"));
    assert!(!valid_env_key(""));
    // The hook client's own addressing is off limits (plan §5.3).
    assert!(!valid_env_key("ARMADRA_NODE_ID"));

    let long = "x".repeat(MAX_CUSTOM_ENV_VALUE + 1);
    let document = custom_document(serde_json::json!([{
        "id": "custom:echo", "label": "Echo", "launchCmd": "e",
        "env": {
            "API_KEY": "k",
            "ARMADRA_NODE_ID": "spoofed",
            "bad key": "x",
            "TOO_LONG": long,
            "NOT_A_STRING": 7,
        },
    }]));
    let agents = parse_custom_agents(&document);
    let env = &agents[0].env;
    assert_eq!(env.len(), 1);
    assert_eq!(env["API_KEY"], "k");
    assert!(!env.contains_key("ARMADRA_NODE_ID"));
}

#[test]
fn env_values_expand_against_the_runtime_environment() {
    let lookup = |name: &str| match name {
        "TOKEN" => Some("secret".to_owned()),
        _ => None,
    };
    let expand = |value: &str| expand_env_value(value, &lookup);
    assert_eq!(expand("${env:TOKEN}"), "secret");
    assert_eq!(expand("Bearer ${env:TOKEN}!"), "Bearer secret!");
    assert_eq!(expand("${env:MISSING}"), "");
    assert_eq!(expand("${env:MISSING:fallback}"), "fallback");
    assert_eq!(expand("${env:TOKEN:ignored}"), "secret");
    assert_eq!(expand("${env:TOKEN}/${env:TOKEN}"), "secret/secret");
    // Anything that is not a well-formed reference stays literal.
    assert_eq!(
        expand("$HOME ${plain} ${env:lower}"),
        "$HOME ${plain} ${env:lower}"
    );
    assert_eq!(expand("${env:TOKEN"), "${env:TOKEN");
    assert_eq!(expand("plain"), "plain");

    // And the expansion itself is capped.
    let huge = format!("${{env:BIG:{}}}", "y".repeat(MAX_CUSTOM_ENV_VALUE + 10));
    assert_eq!(expand(&huge).len(), MAX_CUSTOM_ENV_VALUE);
}

#[test]
fn the_store_answers_which_built_in_agent_a_custom_one_borrows() {
    let store = SettingsStore::in_memory(serde_json::json!({
        "agents": { "custom": [
            { "id": "custom:echo", "label": "Echo", "launchCmd": "/bin/echo",
              "baseAgent": "gemini", "env": { "GREETING": "hi" } },
        ] }
    }));
    assert_eq!(store.custom_agents().len(), 1);
    assert_eq!(store.custom_agent("custom:echo").unwrap().label, "Echo");
    assert!(store.custom_agent("custom:nope").is_none());
    assert_eq!(store.base_agent("custom:echo"), "gemini");
    // Built-ins are their own base; an unknown custom id falls back.
    assert_eq!(store.base_agent("codex"), "codex");
    assert_eq!(store.base_agent("custom:nope"), "claude");

    let env = custom_agent_env(&store.custom_agent("custom:echo").unwrap());
    assert_eq!(env, vec![("GREETING".to_owned(), "hi".to_owned())]);
}

#[test]
fn patching_one_key_keeps_the_others() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    std::fs::write(
        &path,
        r#"{"terminal":{"detachedGraceMinutes":30},"theme":"dark"}"#,
    )
    .unwrap();
    let store = SettingsStore::load_from(&path);
    let document = store
        .patch(&serde_json::json!({ "terminal": { "backend": "direct" } }))
        .unwrap();
    assert_eq!(document["terminal"]["backend"], "direct");
    assert_eq!(document["terminal"]["detachedGraceMinutes"], 30);
    assert_eq!(document["theme"], "dark");
    let settings = store.terminal();
    assert_eq!(settings.backend, BackendChoice::Direct);
    assert_eq!(settings.detached_grace_minutes, 30);

    // And it is on disk for the next runtime start.
    let reloaded = SettingsStore::load_from(&path).terminal();
    assert_eq!(reloaded.backend, BackendChoice::Direct);
}

/* ------------------------- the local settings split ----------------------- */

/// A patch that touches both halves writes both files, and each file holds
/// only its own keys — a `worker-settings.json` carrying the account's
/// preferences would send them nowhere, and a `settings.json` carrying the
/// machine's would send them everywhere.
#[test]
fn a_patch_lands_in_the_file_the_key_belongs_to() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    let store = SettingsStore::load_from(&path);
    store
        .patch(&serde_json::json!({
            "terminal": { "backend": "tmux", "detachedGraceMinutes": 30 },
            "power": { "policy": "never" },
        }))
        .unwrap();

    let shared: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(shared["terminal"]["detachedGraceMinutes"], 30);
    assert!(shared["terminal"].get("backend").is_none());
    assert!(shared.get("power").is_none());

    let local: Value = serde_json::from_slice(
        &std::fs::read(directory.path().join("worker-settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(local["terminal"]["backend"], "tmux");
    assert_eq!(local["power"]["policy"], "never");
    assert!(local.get("usage").is_none());

    // And the two are one document again on the next start.
    let reloaded = SettingsStore::load_from(&path);
    assert_eq!(reloaded.terminal().backend, BackendChoice::Tmux);
    assert_eq!(reloaded.terminal().detached_grace_minutes, 30);
    assert_eq!(reloaded.power_policy(), PowerPolicy::Never);
}

/// The product has not shipped, so no compatibility with the old shape is
/// owed — but a settings file somebody already configured must not lose its
/// terminal backend just because this build reads two files instead of one.
#[test]
fn a_settings_file_written_before_the_split_moves_its_local_keys_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    let local_path = directory.path().join("worker-settings.json");
    std::fs::write(
        &path,
        r#"{"terminal":{"backend":"tmux","detachedGraceMinutes":30},
            "browser":{"executablePath":"/opt/chrome"},"theme":"dark"}"#,
    )
    .unwrap();

    let store = SettingsStore::load_from(&path);
    assert_eq!(store.terminal().backend, BackendChoice::Tmux);
    assert_eq!(store.browser_executable().as_deref(), Some("/opt/chrome"));

    // The move happens on load, not on the next patch: an export taken before
    // anybody changes a setting must already show the split.
    let shared: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(shared["terminal"].get("backend").is_none());
    // `browser` survives because `keepAlive` and `headful` are preferences
    // about the node, not about the machine; only the binary's path moves.
    assert!(shared["browser"].get("executablePath").is_none());
    assert_eq!(shared["theme"], "dark");
    let local: Value = serde_json::from_slice(&std::fs::read(&local_path).unwrap()).unwrap();
    assert_eq!(local["terminal"]["backend"], "tmux");
    assert_eq!(local["browser"]["executablePath"], "/opt/chrome");

    let reloaded = SettingsStore::load_from(&path);
    assert_eq!(reloaded.terminal().backend, BackendChoice::Tmux);
    assert_eq!(reloaded.terminal().detached_grace_minutes, 30);
}

/// Once both files exist the local one decides. A `settings.json` that arrived
/// from the Host still carrying a `terminal.backend` — one exported by an
/// older build — must not change which backend this machine uses.
#[test]
fn a_shared_document_cannot_reintroduce_a_local_key() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.json");
    std::fs::write(&path, r#"{"terminal":{"backend":"direct"}}"#).unwrap();
    std::fs::write(
        directory.path().join("worker-settings.json"),
        r#"{"terminal":{"backend":"tmux"}}"#,
    )
    .unwrap();
    assert_eq!(
        SettingsStore::load_from(&path).terminal().backend,
        BackendChoice::Tmux
    );
}
