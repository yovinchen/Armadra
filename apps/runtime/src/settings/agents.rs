//! `settings.agents.custom[]`: sanitising user-defined CLI entries and
//! expanding the `${env:…}` templates their environment may carry.

use serde_json::{Map, Value};

use crate::db;

use super::*;

/// `^[A-Z_][A-Z0-9_]*$`, minus the names the hook client owns: a custom agent
/// must not be able to redirect hook reports by shadowing `ARMADRA_*`.
pub fn valid_env_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 128 || key.starts_with("ARMADRA_") {
        return false;
    }
    let mut chars = key.chars();
    let first = chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_');
    first && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// One entry of the raw array → the normalized entry, or `None` to drop it.
fn sanitize_custom_agent(raw: &Value) -> Option<CustomAgent> {
    let entry = raw.as_object()?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::trim);

    let id = text("id")?.to_owned();
    if !id.starts_with("custom:") || !db::valid_agent_id(&id) {
        return None;
    }
    let label = text("label").filter(|label| !label.is_empty())?;
    if label.chars().count() > MAX_CUSTOM_LABEL {
        return None;
    }
    let launch_cmd = text("launchCmd").filter(|command| !command.is_empty())?;
    if launch_cmd.len() > MAX_CUSTOM_COMMAND || launch_cmd.contains(['\n', '\r', '\0']) {
        return None;
    }
    let base_agent = text("baseAgent").unwrap_or(DEFAULT_BASE_AGENT);
    crate::agent::definition(base_agent)?;
    let base_agent = base_agent.to_owned();
    let color = text("color")
        .filter(|color| !color.is_empty() && color.len() <= 32)
        .unwrap_or(DEFAULT_CUSTOM_COLOR)
        .to_owned();

    let args = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .filter(|arg| arg.len() <= MAX_CUSTOM_COMMAND && !arg.contains('\0'))
                .take(MAX_CUSTOM_ARGS)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    // An unusable key or an oversized value drops that variable, not the agent:
    // the CLI still starts, it just starts without that one setting.
    let mut env = Map::new();
    if let Some(raw_env) = entry.get("env").and_then(Value::as_object) {
        for (key, value) in raw_env {
            if env.len() >= MAX_CUSTOM_ENV_VARS {
                break;
            }
            let Some(value) = value.as_str() else {
                continue;
            };
            if valid_env_key(key) && value.len() <= MAX_CUSTOM_ENV_VALUE && !value.contains('\0') {
                env.insert(key.clone(), Value::String(value.to_owned()));
            }
        }
    }

    Some(CustomAgent {
        id,
        label: label.to_owned(),
        color,
        launch_cmd: launch_cmd.to_owned(),
        args,
        env,
        base_agent,
        disabled_capabilities: entry
            .get("disabledCapabilities")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|value| crate::agent::AGENT_CAPABILITIES.contains(value))
                    .map(str::to_owned)
                    .take(crate::agent::AGENT_CAPABILITIES.len())
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn parse_custom_agents(document: &Value) -> Vec<CustomAgent> {
    let Some(list) = document
        .get("agents")
        .and_then(|agents| agents.get("custom"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut agents: Vec<CustomAgent> = Vec::new();
    for raw in list {
        if agents.len() >= MAX_CUSTOM_AGENTS {
            break;
        }
        let Some(agent) = sanitize_custom_agent(raw) else {
            continue;
        };
        // Two entries with the same id would make `GET /api/agents` ambiguous
        // and the launch line non-deterministic; the first one wins.
        if agents.iter().all(|kept| kept.id != agent.id) {
            agents.push(agent);
        }
    }
    agents
}

pub(super) fn normalize_custom_agents(document: &mut Map<String, Value>) {
    if !document.contains_key("agents") {
        return;
    }
    let agents = parse_custom_agents(&Value::Object(document.clone()));
    let mut section = document
        .get("agents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    section.insert(
        "custom".into(),
        serde_json::to_value(&agents).unwrap_or(Value::Array(Vec::new())),
    );
    document.insert("agents".into(), Value::Object(section));
}

/// `${env:VAR}` / `${env:VAR:fallback}` against `lookup`.
///
/// An unset variable with no fallback expands to the empty string, and anything
/// that is not a well-formed reference is left exactly as written — a value like
/// `$HOME` or `${foo}` belongs to the CLI, not to us.
pub fn expand_env_value(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    const OPEN: &str = "${env:";
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(OPEN) {
        let (head, tail) = rest.split_at(start);
        out.push_str(head);
        let body = &tail[OPEN.len()..];
        let Some(end) = body.find('}') else {
            // Unterminated: the rest is literal.
            out.push_str(tail);
            return truncate_env_value(out);
        };
        let (reference, remainder) = body.split_at(end);
        let (name, fallback) = match reference.split_once(':') {
            Some((name, fallback)) => (name, fallback),
            None => (reference, ""),
        };
        if valid_env_key(name) {
            out.push_str(&lookup(name).unwrap_or_else(|| fallback.to_owned()));
        } else {
            out.push_str(&tail[..OPEN.len() + end + 1]);
        }
        rest = &remainder[1..];
    }
    out.push_str(rest);
    truncate_env_value(out)
}

fn truncate_env_value(value: String) -> String {
    match value.char_indices().nth(MAX_CUSTOM_ENV_VALUE) {
        Some((index, _)) => value[..index].to_owned(),
        None => value,
    }
}

/// The environment a custom agent contributes to its PTY, expanded against the
/// runtime's own environment.
pub fn custom_agent_env(agent: &CustomAgent) -> Vec<(String, String)> {
    agent
        .env
        .iter()
        .filter_map(|(key, value)| {
            let value = value.as_str()?;
            Some((
                key.clone(),
                expand_env_value(value, &|name| std::env::var(name).ok()),
            ))
        })
        .collect()
}
