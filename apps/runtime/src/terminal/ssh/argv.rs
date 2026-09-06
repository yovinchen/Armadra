//! The `ssh` command lines Armadra builds (plan section 21, and remote
//! completion design section 3.6).
//!
//! One rule governs the whole file: **argv, never a shell string.** Each option
//! is its own element, so a host called `a;rm -rf /` could at worst become one
//! meaningless `ssh` argument -- and it never gets that far, because
//! `validate_host` refuses it first.
//!
//! Every line here carries the two host-key options from
//! [`known_hosts::options`]. That is not decoration: without them `ssh` falls
//! back to its own known_hosts handling, and an unknown key becomes either a
//! prompt on a TTY nobody is watching or an entry written to the user's file
//! without being asked.

use super::{SshHost, SshWorker, known_hosts};

/// The argv that starts the Worker on `host` over SSH (H02):
/// `ssh -o BatchMode=no … destination <remote binary> worker --stdio …`.
///
/// No `-t`: stdin and stdout carry length-prefixed Protobuf frames, and a TTY
/// would translate them. Prompting stays on, but only because it is routed to
/// the askpass helper below — a prompt with nowhere to go would swallow the
/// stream, and an unreachable host has to fail rather than hang.
pub fn worker_argv(host: &SshHost, worker: &SshWorker) -> Vec<String> {
    argv_for(host, worker, false)
}

/// The same launch line with `--language-link`, for the second connection an
/// execution host gets while an editor has a language session on it (language
/// service design §2.7).
///
/// Everything about it — the options, the askpass helper, the host-key file,
/// the destination, the remote binary, the state directory — is the first
/// connection's line. Only the one flag differs, so a host that can run a
/// Worker at all can run this without further setup.
pub fn language_link_argv(host: &SshHost, worker: &SshWorker) -> Vec<String> {
    argv_for(host, worker, true)
}

fn argv_for(host: &SshHost, worker: &SshWorker, language_link: bool) -> Vec<String> {
    let mut argv = vec![
        "ssh".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=10".to_owned(),
        "-o".to_owned(),
        "ServerAliveInterval=30".to_owned(),
    ];
    // Prompting is on, but it goes to the askpass helper rather than to a TTY
    // this connection does not have. `BatchMode=yes` used to be here and made
    // any host needing a password simply unusable.
    argv.extend(super::askpass::options());
    argv.extend(known_hosts::options());
    if let Some(port) = host.port {
        argv.push("-p".to_owned());
        argv.push(port.to_string());
    }
    if let Some(identity) = host.identity_file.as_deref() {
        argv.push("-i".to_owned());
        argv.push(identity.to_owned());
    }
    argv.extend(host.extra_args.iter().cloned());
    argv.push(destination(host));
    argv.push(worker.path.clone());
    argv.push("worker".to_owned());
    argv.push("--stdio".to_owned());
    if language_link {
        argv.push("--language-link".to_owned());
    }
    if let Some(directory) = worker.state_dir.as_deref() {
        argv.push("--state-dir".to_owned());
        argv.push(directory.to_owned());
    }
    argv
}

/// `user@host`, with the brackets of an IPv6 literal removed — `ssh` takes a
/// bare address as its destination, brackets are URI syntax.
fn destination(host: &SshHost) -> String {
    let address = host
        .host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(&host.host);
    match host.user.as_deref() {
        Some(user) => format!("{user}@{address}"),
        None => address.to_owned(),
    }
}

/// The argv of the session's command, program included:
/// `ssh -t -o ServerAliveInterval=30 [-p PORT] [-i FILE] [extra…] user@host`.
pub fn ssh_argv(host: &SshHost) -> Vec<String> {
    let mut argv = vec![
        "ssh".to_owned(),
        "-t".to_owned(),
        "-o".to_owned(),
        "ServerAliveInterval=30".to_owned(),
    ];
    // A terminal node has a real TTY, so `ssh` prompts there itself. Only the
    // host-key options are added, so that an unknown key behaves the same way
    // it does everywhere else in Armadra.
    argv.extend(known_hosts::options());
    if let Some(port) = host.port {
        argv.push("-p".to_owned());
        argv.push(port.to_string());
    }
    if let Some(identity) = host.identity_file.as_deref() {
        argv.push("-i".to_owned());
        argv.push(identity.to_owned());
    }
    argv.extend(host.extra_args.iter().cloned());
    argv.push(destination(host));
    argv
}

/// The reachability probe: no TTY, no password prompt, five seconds, `true` as
/// the remote command.
pub fn probe_argv(host: &SshHost) -> Vec<String> {
    let mut argv = vec![
        "ssh".to_owned(),
        "-o".to_owned(),
        // The probe stays batch: it answers "is this host reachable with the
        // credentials already available", and a dialog would turn a reachability
        // check into an authentication attempt nobody asked for.
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=5".to_owned(),
    ];
    argv.extend(known_hosts::options());
    if let Some(port) = host.port {
        argv.push("-p".to_owned());
        argv.push(port.to_string());
    }
    if let Some(identity) = host.identity_file.as_deref() {
        argv.push("-i".to_owned());
        argv.push(identity.to_owned());
    }
    argv.extend(host.extra_args.iter().cloned());
    argv.push(destination(host));
    argv.push("true".to_owned());
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> SshHost {
        SshHost {
            id: "box".into(),
            name: "Box".into(),
            host: "example.com".into(),
            user: Some("ada".into()),
            port: None,
            identity_file: None,
            extra_args: Vec::new(),
            worker: None,
        }
    }

    fn worker() -> SshWorker {
        SshWorker {
            path: "/opt/armadra/armadra-runtime".into(),
            state_dir: None,
        }
    }

    /// The one assertion that matters for every line Armadra builds: `ssh` is
    /// told to refuse an unknown key rather than prompt for it or accept it,
    /// and to look for trust in the file Armadra owns.
    #[test]
    fn every_command_line_pins_strict_host_key_checking() {
        for argv in [
            ssh_argv(&host()),
            probe_argv(&host()),
            worker_argv(&host(), &worker()),
        ] {
            assert!(
                argv.windows(2)
                    .any(|pair| pair == ["-o", "StrictHostKeyChecking=yes"]),
                "{argv:?}"
            );
            assert!(
                argv.iter()
                    .any(|argument| argument.starts_with("UserKnownHostsFile=")),
                "{argv:?}"
            );
        }
    }

    #[test]
    fn a_terminal_session_gets_a_tty_and_the_worker_does_not() {
        assert!(ssh_argv(&host()).contains(&"-t".to_owned()));
        assert!(!worker_argv(&host(), &worker()).contains(&"-t".to_owned()));
        assert!(!probe_argv(&host()).contains(&"-t".to_owned()));
    }

    /// The Worker connection has no TTY, so prompting has to reach the askpass
    /// helper. `BatchMode=yes` here would make every password-authenticated
    /// host unusable rather than merely awkward.
    #[test]
    fn the_worker_prompts_through_the_helper_while_the_probe_stays_batch() {
        let argv = worker_argv(&host(), &worker());
        assert!(argv.windows(2).any(|pair| pair == ["-o", "BatchMode=no"]));
        assert!(
            argv.windows(2)
                .any(|pair| pair == ["-o", "NumberOfPasswordPrompts=1"])
        );
        // A reachability check must not open a dialog: it answers whether the
        // host is there with what is already available.
        assert!(
            probe_argv(&host())
                .windows(2)
                .any(|pair| pair == ["-o", "BatchMode=yes"])
        );
    }

    #[test]
    fn port_identity_and_extra_arguments_are_separate_elements() {
        let mut host = host();
        host.port = Some(2222);
        host.identity_file = Some("/home/ada/.ssh/id_ed25519".into());
        host.extra_args = vec!["-4".into()];
        let argv = ssh_argv(&host);
        assert!(argv.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(
            argv.windows(2)
                .any(|pair| pair == ["-i", "/home/ada/.ssh/id_ed25519"])
        );
        assert!(argv.contains(&"-4".to_owned()));
        assert_eq!(argv.last().unwrap(), "ada@example.com");
    }

    #[test]
    fn ipv6_loses_its_brackets_in_the_destination() {
        let mut host = host();
        host.host = "[fe80::1]".into();
        host.user = None;
        assert_eq!(ssh_argv(&host).last().unwrap(), "fe80::1");
    }

    #[test]
    fn the_worker_command_ends_in_the_remote_binary_and_its_mode() {
        let mut host = host();
        host.port = Some(2222);
        let worker = SshWorker {
            path: "/opt/armadra/armadra-runtime".into(),
            state_dir: Some("/var/lib/armadra/worker".into()),
        };
        let argv = worker_argv(&host, &worker);
        assert_eq!(
            argv[argv.len() - 8..],
            [
                "-p",
                "2222",
                "ada@example.com",
                "/opt/armadra/armadra-runtime",
                "worker",
                "--stdio",
                "--state-dir",
                "/var/lib/armadra/worker",
            ]
        );
    }

    #[test]
    fn the_state_directory_is_two_arguments_and_only_when_configured() {
        let host = host();
        let argv = worker_argv(&host, &worker());
        assert_eq!(argv.last().unwrap(), "--stdio");
        let argv = worker_argv(
            &host,
            &SshWorker {
                path: "/opt/armadra/armadra-runtime".into(),
                state_dir: Some("/var/lib/armadra/worker".into()),
            },
        );
        assert_eq!(
            &argv[argv.len() - 2..],
            ["--state-dir", "/var/lib/armadra/worker"]
        );
    }

    /// The language link is the Worker line plus one flag, and nothing else.
    /// It is the same kind of connection — no TTY, frames on stdio — so it has
    /// to carry the same host-key options and the same askpass helper; a link
    /// that still said `BatchMode=yes` would leave a password-authenticated
    /// host able to run a Worker but never a language server.
    #[test]
    fn the_language_link_is_the_worker_line_plus_one_flag() {
        let worker = SshWorker {
            path: "/opt/armadra/armadra-runtime".into(),
            state_dir: Some("/var/lib/armadra/worker".into()),
        };
        let base = worker_argv(&host(), &worker);
        let link = language_link_argv(&host(), &worker);
        assert_eq!(
            link.iter()
                .filter(|argument| *argument != "--language-link")
                .cloned()
                .collect::<Vec<_>>(),
            base
        );
        // Directly after `--stdio`, so the state directory still trails the
        // line the way `worker_argv` promises.
        let stdio = link.iter().position(|argument| argument == "--stdio");
        assert_eq!(
            link.get(stdio.unwrap() + 1).map(String::as_str),
            Some("--language-link")
        );
        assert_eq!(
            &link[link.len() - 2..],
            ["--state-dir", "/var/lib/armadra/worker"]
        );
    }

    #[test]
    fn the_probe_ends_in_true() {
        let argv = probe_argv(&host());
        assert!(
            argv.windows(2)
                .any(|pair| pair == ["-o", "ConnectTimeout=5"])
        );
        assert_eq!(argv.last().unwrap(), "true");
    }
}
