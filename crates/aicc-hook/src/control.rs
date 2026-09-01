//! The `context` and `canvas` subcommands.
//!
//! Unlike hook mode these are invoked deliberately by an agent, so they are
//! loud: the runtime's prose goes to stdout and any failure goes to stderr with
//! exit code 1.

use std::io::Write;

use serde_json::{json, Map, Value};

use crate::hook::percent_encode_segment;
use crate::http::{self, Request};
use crate::Session;

/// The context-link verbs the runtime exposes.
const CONTEXT_VERBS: [&str; 4] = ["list", "summary", "transcript", "terminal"];

/// `aicc-hook context <verb> [--node <id|title>] [-n N]`
pub fn run_context(args: &[String]) -> i32 {
    let Some(verb) = args.first() else {
        return fail("usage: aicc-hook context <list|summary|transcript|terminal> [--node <id|title>] [-n N]");
    };
    if !CONTEXT_VERBS.contains(&verb.as_str()) {
        return fail(&format!(
            "unknown context verb `{verb}`; expected one of {}",
            CONTEXT_VERBS.join(", ")
        ));
    }

    let mut node: Option<String> = None;
    let mut lines: Option<i64> = None;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_str();
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with('-') => (flag, Some(value.to_string())),
            _ => (arg, None),
        };
        match flag {
            "--node" => match take_value(args, &mut index, inline) {
                Some(value) => node = Some(value),
                None => return fail("--node needs a node id or title"),
            },
            "-n" | "--lines" => match take_value(args, &mut index, inline) {
                Some(value) => match value.trim().parse::<i64>() {
                    Ok(parsed) => lines = Some(parsed),
                    Err(_) => return fail(&format!("-n needs a number, got `{value}`")),
                },
                None => return fail("-n needs a number"),
            },
            other => return fail(&format!("unknown option `{other}` for `context {verb}`")),
        }
        index += 1;
    }

    let mut map = Map::new();
    if let Some(node) = node {
        map.insert("node".to_string(), json!(node));
    }
    if let Some(lines) = lines {
        map.insert("n".to_string(), json!(lines));
    }
    request(
        &format!("/context-link/{}", percent_encode_segment(verb)),
        map,
    )
}

/// `aicc-hook canvas <verb> [--flag value | --flag=value | --flag]...`
pub fn run_canvas(args: &[String]) -> i32 {
    let Some(verb) = args.first() else {
        return fail("usage: aicc-hook canvas <verb> [--flag value]...");
    };
    if verb.starts_with('-') {
        return fail(&format!("expected a canvas verb, got `{verb}`"));
    }
    let map = match parse_flags(&args[1..]) {
        Ok(map) => map,
        Err(error) => return fail(&error),
    };
    request(&format!("/control/{}", percent_encode_segment(verb)), map)
}

/// Turns `--flag value`, `--flag=value` and bare `--flag` into an args object.
///
/// A flag repeated more than once collects into an array so verbs such as
/// `link --to a --to b` work without special casing.
pub fn parse_flags(args: &[String]) -> Result<Map<String, Value>, String> {
    let mut map: Map<String, Value> = Map::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if !arg.starts_with("--") {
            return Err(format!("expected a --flag, got `{arg}`"));
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_string())),
            None => (arg, None),
        };
        let name = flag.trim_start_matches('-');
        if name.is_empty() {
            return Err("`--` is not a flag name".to_string());
        }
        // A flag whose next token is another flag (or nothing) is a boolean.
        let value = match inline {
            Some(value) => Value::String(value),
            None => match args.get(index + 1) {
                Some(next) if !next.starts_with("--") => {
                    index += 1;
                    Value::String(next.clone())
                }
                _ => Value::Bool(true),
            },
        };
        insert_or_append(&mut map, name, value);
        index += 1;
    }
    Ok(map)
}

fn insert_or_append(map: &mut Map<String, Value>, name: &str, value: Value) {
    match map.remove(name) {
        Some(Value::Array(mut existing)) => {
            existing.push(value);
            map.insert(name.to_string(), Value::Array(existing));
        }
        Some(previous) => {
            map.insert(name.to_string(), Value::Array(vec![previous, value]));
        }
        None => {
            map.insert(name.to_string(), value);
        }
    }
}

fn take_value(args: &[String], index: &mut usize, inline: Option<String>) -> Option<String> {
    if let Some(value) = inline {
        return Some(value);
    }
    let next = args.get(*index + 1)?;
    if next.starts_with('-') {
        return None;
    }
    *index += 1;
    Some(next.clone())
}

/// Builds the `{nodeId, args}` body every control route takes.
pub fn control_body(node_id: &str, args: Map<String, Value>) -> Vec<u8> {
    let mut body = Map::new();
    body.insert("nodeId".to_string(), json!(node_id));
    body.insert("args".to_string(), Value::Object(args));
    serde_json::to_vec(&Value::Object(body)).unwrap_or_else(|_| b"{}".to_vec())
}

fn request(path: &str, args: Map<String, Value>) -> i32 {
    let session = match Session::load() {
        Ok(session) => session,
        Err(error) => return fail(&error),
    };
    let body = control_body(&session.node_id, args);
    let request = Request::post_json(path.to_string(), session.headers(), body);
    match http::send(&session.endpoint, &request) {
        Ok(response) if response.is_success() => {
            let text = render(&response);
            if !text.is_empty() {
                let mut stdout = std::io::stdout().lock();
                let _ = stdout.write_all(text.as_bytes());
                if !text.ends_with('\n') {
                    let _ = stdout.write_all(b"\n");
                }
                let _ = stdout.flush();
            }
            0
        }
        Ok(response) => fail(&render_error(&response)),
        Err(error) => fail(&error),
    }
}

/// Renders a successful response: prose is printed as-is, JSON is reduced to
/// its human readable field.
pub fn render(response: &http::Response) -> String {
    if !is_json(response) {
        return response.body.clone();
    }
    let Ok(value) = serde_json::from_str::<Value>(&response.body) else {
        return response.body.clone();
    };
    for key in ["message", "result", "text"] {
        match value.get(key) {
            Some(Value::String(text)) => return text.clone(),
            Some(other) => return other.to_string(),
            None => {}
        }
    }
    response.body.clone()
}

/// Renders a failure response into a single stderr line.
pub fn render_error(response: &http::Response) -> String {
    let fallback = || {
        let body = response.body.trim();
        if body.is_empty() {
            format!("hook endpoint answered {}", response.status)
        } else {
            format!("{} ({})", body, response.status)
        }
    };
    if !is_json(response) {
        return fallback();
    }
    let Ok(value) = serde_json::from_str::<Value>(&response.body) else {
        return fallback();
    };
    for key in ["error", "message"] {
        if let Some(Value::String(text)) = value.get(key) {
            return format!("{text} ({})", response.status);
        }
    }
    fallback()
}

fn is_json(response: &http::Response) -> bool {
    response
        .content_type
        .as_deref()
        .map(|value| value.to_ascii_lowercase().contains("json"))
        .unwrap_or(false)
}

fn fail(message: &str) -> i32 {
    let _ = writeln!(std::io::stderr(), "aicc-hook: {message}");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(input: &[&str]) -> Map<String, Value> {
        let owned: Vec<String> = input.iter().map(|s| s.to_string()).collect();
        parse_flags(&owned).unwrap()
    }

    #[test]
    fn bare_flags_become_true() {
        let map = flags(&["--dry-run"]);
        assert_eq!(map["dry-run"], Value::Bool(true));
    }

    #[test]
    fn both_flag_spellings_agree() {
        assert_eq!(flags(&["--title", "Build"]), flags(&["--title=Build"]));
    }

    #[test]
    fn repeated_flags_collect_into_an_array() {
        let map = flags(&["--after", "a", "--after", "b", "--after=c"]);
        assert_eq!(map["after"], json!(["a", "b", "c"]));
    }

    #[test]
    fn a_flag_followed_by_a_flag_is_boolean() {
        let map = flags(&["--dry-run", "--title", "x"]);
        assert_eq!(map["dry-run"], Value::Bool(true));
        assert_eq!(map["title"], json!("x"));
    }

    #[test]
    fn values_may_look_like_short_options() {
        // Only `--` prefixed tokens end a value, so a title of "-5" survives.
        let map = flags(&["--title=-5"]);
        assert_eq!(map["title"], json!("-5"));
    }

    #[test]
    fn positional_arguments_are_rejected() {
        let owned = vec!["oops".to_string()];
        assert!(parse_flags(&owned).is_err());
    }

    #[test]
    fn control_body_shape() {
        // `serde_json` maps are ordered, so the bytes are reproducible; the
        // runtime only cares about the field names.
        let body = control_body("n1", flags(&["--dry-run"]));
        assert_eq!(
            String::from_utf8(body).unwrap(),
            r#"{"args":{"dry-run":true},"nodeId":"n1"}"#
        );
    }

    #[test]
    fn control_body_keeps_an_empty_args_object() {
        let body = control_body("n1", Map::new());
        assert_eq!(
            String::from_utf8(body).unwrap(),
            r#"{"args":{},"nodeId":"n1"}"#
        );
    }

    #[test]
    fn json_responses_are_reduced_to_their_message() {
        let response = http::Response {
            status: 200,
            content_type: Some("application/json".to_string()),
            body: r#"{"ok":true,"message":"opened 2 nodes"}"#.to_string(),
        };
        assert_eq!(render(&response), "opened 2 nodes");
    }

    #[test]
    fn plain_text_responses_pass_through() {
        let response = http::Response {
            status: 200,
            content_type: Some("text/plain; charset=utf-8".to_string()),
            body: "linked nodes:\n- api (n2)\n".to_string(),
        };
        assert_eq!(render(&response), "linked nodes:\n- api (n2)\n");
    }

    #[test]
    fn errors_carry_the_status() {
        let json = http::Response {
            status: 403,
            content_type: Some("application/json".to_string()),
            body: r#"{"error":"node is not linked"}"#.to_string(),
        };
        assert_eq!(render_error(&json), "node is not linked (403)");

        let plain = http::Response {
            status: 500,
            content_type: Some("text/plain".to_string()),
            body: "boom".to_string(),
        };
        assert_eq!(render_error(&plain), "boom (500)");

        let empty = http::Response {
            status: 502,
            content_type: None,
            body: String::new(),
        };
        assert_eq!(render_error(&empty), "hook endpoint answered 502");
    }
}
