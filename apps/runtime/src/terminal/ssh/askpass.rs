//! The `SSH_ASKPASS` helper: `armadra-runtime ssh-askpass` (design §3.6).
//!
//! `ssh` runs this program with the prompt as argv[1] and reads one line from
//! its stdout. The helper is this same binary in a different mode, so there is
//! nothing extra to install and nothing on `PATH` to hijack.
//!
//! The trust chain is the token. The Runtime mints a one-time token per
//! connection attempt, hands it to the child through the environment, and only
//! answers a prompt request that presents it. That matters because the endpoint
//! is a loopback HTTP route: without the token, any local process could open a
//! dialog on the user's screen and read what they typed into it.
//!
//! The helper prints the answer and exits 0, or exits 1 with nothing on stdout.
//! Exiting 1 is what makes `ssh` fail cleanly; printing a guess would make it
//! fail as an authentication error, which is a different and more confusing
//! thing to debug.

use std::time::Duration;

/// The endpoint the helper posts to, and the token it must present.
pub const ENDPOINT_ENV: &str = "ARMADRA_ASKPASS_ENDPOINT";
pub const TOKEN_ENV: &str = "ARMADRA_ASKPASS_TOKEN";
/// Which host the prompt belongs to, so the dialog can name it.
pub const HOST_ENV: &str = "ARMADRA_ASKPASS_HOST";

/// How long the helper waits for a person before giving up. One second under
/// the Runtime's own expiry, so the helper is the one that gives up first and
/// `ssh` sees a clean failure rather than a truncated read.
const WAIT: Duration = Duration::from_secs(119);
const POLL: Duration = Duration::from_millis(250);

/// Where the helper reaches this Runtime, and what proves it may.
///
/// A process-global because the port is only known once the server is bound,
/// while `ssh` children are started from wherever a workspace needs one. Absent
/// until then, and absent forever on a desktop install with no port — in which
/// case the helper exits non-zero and `ssh` fails cleanly rather than hanging.
type Reachable = (String, std::sync::Arc<crate::api::ssh::AskpassTokens>);

static ENDPOINT: std::sync::LazyLock<std::sync::Mutex<Option<Reachable>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// Called once the Runtime knows its own address.
pub fn publish(endpoint: String, tokens: std::sync::Arc<crate::api::ssh::AskpassTokens>) {
    if let Ok(mut current) = ENDPOINT.lock() {
        *current = Some((endpoint, tokens));
    }
}

/// The environment for one `ssh` child, or `None` when prompts are not
/// available. A fresh token each time: it authorizes one connection attempt's
/// helper and nothing else.
pub fn child_environment(host_id: &str) -> Option<Vec<(String, String)>> {
    let (endpoint, tokens) = ENDPOINT.lock().ok()?.clone()?;
    Some(environment(
        helper_script().ok()?.to_str()?,
        &endpoint,
        &tokens.mint(),
        host_id,
    ))
}

/// `ssh` runs `$SSH_ASKPASS <prompt>` with no way to pass a subcommand, so the
/// helper is a two-line wrapper that execs this binary in askpass mode.
///
/// Written into the data directory at 0700 rather than shipped as a separate
/// file: it has to name the *running* executable, which is only known here,
/// and a stale wrapper pointing at an old install would silently stop working.
fn helper_script() -> std::io::Result<std::path::PathBuf> {
    let directory = crate::paths::data_dir().join("ssh");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("askpass");
    let executable = std::env::current_exe()?;
    let script = format!(
        "#!/bin/sh\nexec {} ssh-askpass \"$@\"\n",
        shell_quote(&executable.to_string_lossy())
    );
    // Rewritten every time: the path to the executable can change between
    // installs, and a wrapper is cheap.
    write_executable(&path, &script)?;
    Ok(path)
}

/// Single-quoted for `/bin/sh`, with embedded quotes broken out. The path
/// comes from the OS rather than from a user, but this file is a shell script
/// and quoting it correctly costs one function.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_executable(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o700);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()
}

/// The environment an `ssh` child needs to reach this helper.
///
/// `SSH_ASKPASS_REQUIRE=force` is what makes OpenSSH 8.4+ use the helper even
/// with no `DISPLAY`; older versions only consult `SSH_ASKPASS` when `DISPLAY`
/// is set, so a placeholder is provided for them. Neither is a display anybody
/// draws on — the dialog is in the Armadra client.
pub fn environment(
    program: &str,
    endpoint: &str,
    token: &str,
    host_id: &str,
) -> Vec<(String, String)> {
    vec![
        ("SSH_ASKPASS".to_owned(), program.to_owned()),
        ("SSH_ASKPASS_REQUIRE".to_owned(), "force".to_owned()),
        ("DISPLAY".to_owned(), ":0".to_owned()),
        (ENDPOINT_ENV.to_owned(), endpoint.to_owned()),
        (TOKEN_ENV.to_owned(), token.to_owned()),
        (HOST_ENV.to_owned(), host_id.to_owned()),
    ]
}

/// The `-o` options that let `ssh` ask at all.
///
/// `BatchMode=no` re-enables prompting, and `NumberOfPasswordPrompts=1` keeps
/// a wrong answer from becoming three dialogs: one refusal is an answer, three
/// is an interrogation.
pub fn options() -> Vec<String> {
    vec![
        "-o".to_owned(),
        "BatchMode=no".to_owned(),
        "-o".to_owned(),
        "NumberOfPasswordPrompts=1".to_owned(),
    ]
}

/// Run as the helper. Returns the process exit code.
///
/// Deliberately not async and deliberately dependency-light: this runs as a
/// short-lived child of `ssh`, and everything it needs is one HTTP request in a
/// loop.
pub fn run(prompt: &str) -> i32 {
    let Some((endpoint, token, host)) = helper_context(
        std::env::var(ENDPOINT_ENV).ok(),
        std::env::var(TOKEN_ENV).ok(),
        std::env::var(HOST_ENV).ok(),
    ) else {
        // Not started by Armadra. Refusing is the only safe answer: this
        // program must never prompt on its own.
        return 1;
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return 1,
    };
    match runtime.block_on(ask(&endpoint, &token, &host, prompt)) {
        Some(answer) => {
            // One line, exactly as `ssh` expects. The secret is on stdout and
            // nowhere else — not argv, not a file, not a log.
            println!("{answer}");
            0
        }
        None => 1,
    }
}

/// All three or none. Split out as a pure function so the refusal can be
/// tested without writing to the process environment, which is not something a
/// test may do while other threads are building command environments.
fn helper_context(
    endpoint: Option<String>,
    token: Option<String>,
    host: Option<String>,
) -> Option<(String, String, String)> {
    match (endpoint, token, host) {
        (Some(endpoint), Some(token), Some(host))
            if !endpoint.is_empty() && !token.is_empty() && !host.is_empty() =>
        {
            Some((endpoint, token, host))
        }
        _ => None,
    }
}

async fn ask(endpoint: &str, token: &str, host_id: &str, prompt: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let opened: serde_json::Value = client
        .post(format!("{endpoint}/api/ssh/askpass/prompts"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "hostId": host_id, "prompt": prompt }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let prompt_id = opened["promptId"].as_str()?.to_owned();

    let deadline = std::time::Instant::now() + WAIT;
    while std::time::Instant::now() < deadline {
        let response = client
            .get(format!("{endpoint}/api/ssh/askpass/prompts/{prompt_id}"))
            .bearer_auth(token)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            // The prompt is gone: cancelled, expired, or the Runtime restarted.
            return None;
        }
        let body: serde_json::Value = response.json().await.ok()?;
        if let Some(answer) = body["answer"].as_str() {
            return Some(answer.to_owned());
        }
        tokio::time::sleep(POLL).await;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The forced require is what makes this work without a display; the
    /// `DISPLAY` placeholder is the fallback for OpenSSH before 8.4, which
    /// ignores `SSH_ASKPASS` entirely without one.
    #[test]
    fn the_environment_forces_the_helper_on_both_old_and_new_openssh() {
        let environment = environment(
            "/opt/armadra/armadra-runtime",
            "http://127.0.0.1:1",
            "t",
            "box",
        );
        let lookup = |name: &str| {
            environment
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(lookup("SSH_ASKPASS_REQUIRE").as_deref(), Some("force"));
        assert!(lookup("DISPLAY").is_some());
        assert_eq!(
            lookup("SSH_ASKPASS").as_deref(),
            Some("/opt/armadra/armadra-runtime")
        );
        assert_eq!(lookup(TOKEN_ENV).as_deref(), Some("t"));
    }

    /// Prompting has to be re-enabled for the helper to be consulted at all,
    /// and a wrong answer must cost one dialog rather than three.
    #[test]
    fn the_options_enable_exactly_one_prompt() {
        let options = options();
        assert!(
            options
                .windows(2)
                .any(|pair| pair == ["-o", "BatchMode=no"])
        );
        assert!(
            options
                .windows(2)
                .any(|pair| pair == ["-o", "NumberOfPasswordPrompts=1"])
        );
    }

    /// Without the environment the Runtime sets, the helper is some other
    /// program's child and must not open a dialog. All three values are
    /// required: a token without an endpoint is as meaningless as neither.
    #[test]
    fn the_helper_refuses_when_it_was_not_started_by_this_runtime() {
        let some = || Some("value".to_owned());
        assert!(helper_context(None, None, None).is_none());
        assert!(helper_context(some(), None, some()).is_none());
        assert!(helper_context(some(), some(), None).is_none());
        assert!(helper_context(Some(String::new()), some(), some()).is_none());
        assert!(helper_context(some(), some(), some()).is_some());
    }
}
