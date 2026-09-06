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

/// The options are the whole mechanism: without them `ssh` consults its own
/// files and decides for itself, which is exactly what this module exists to
/// prevent.
#[test]
fn the_options_pin_strict_checking_and_name_armadras_own_file() {
    let options = options();
    assert!(
        options
            .windows(2)
            .any(|pair| pair == ["-o", "StrictHostKeyChecking=yes"])
    );
    let files = options
        .iter()
        .find(|option| option.starts_with("UserKnownHostsFile="))
        .expect("a known hosts file");
    assert!(
        files.contains("known_hosts"),
        "{files} does not name a known_hosts file"
    );
}

/// A non-default port is part of the identity of a host key. Writing the entry
/// without it would trust the same key on port 22, which is a different server.
#[test]
fn a_non_default_port_is_part_of_the_entry_name() {
    let mut host = host();
    assert_eq!(entry_host(&host), "example.com");
    host.port = Some(22);
    assert_eq!(entry_host(&host), "example.com");
    host.port = Some(2222);
    assert_eq!(entry_host(&host), "[example.com]:2222");
    host.host = "[fe80::1]".into();
    assert_eq!(entry_host(&host), "[fe80::1]:2222");
}

/// A client that echoed back a line for some other host must not be able to
/// append trust for it: the confirmation the person gave was about this host.
#[test]
fn a_line_that_names_a_different_host_is_refused() {
    assert!(
        trust(
            &host(),
            "other.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI",
            false
        )
        .is_err()
    );
    // And two lines at once, which would smuggle a second entry past one
    // confirmation.
    assert!(
        trust(
            &host(),
            "example.com ssh-ed25519 AAAA\nevil.example.com ssh-rsa AAAA",
            false
        )
        .is_err()
    );
}

/// OpenSSH's own wording for a changed key. Recognising it is what turns an
/// unreadable failure into the replace-or-refuse decision a person has to make.
#[test]
fn a_changed_identification_is_recognised_in_ssh_diagnostics() {
    assert!(identification_changed(
        "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n\
         @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n"
    ));
    assert!(!identification_changed(
        "ada@example.com: Permission denied (publickey)."
    ));
}

/// Only an absolute path with no whitespace replaces the program: a bare name
/// would resolve through `PATH`, and an argument smuggled through a space
/// would become part of the command line.
#[test]
fn the_keyscan_override_is_ignored_unless_it_is_an_absolute_program() {
    assert_eq!(accepted_override(None), None);
    assert_eq!(accepted_override(Some("ssh-keyscan")), None);
    assert_eq!(accepted_override(Some("/usr/bin/env ssh-keyscan")), None);
    assert_eq!(
        accepted_override(Some("/usr/bin/ssh-keyscan")).as_deref(),
        Some("/usr/bin/ssh-keyscan")
    );
}
