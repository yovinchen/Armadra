use std::fs;
use std::process::Command;

use tempfile::tempdir;

use super::super::clone::spawn_clone_job;
use super::super::*;
use super::support::commit_all;

#[test]
fn accepts_only_the_three_supported_url_shapes() {
    for good in [
        "https://github.com/octocat/Hello-World.git",
        "https://user@example.test/team/repo",
        "ssh://git@example.test/team/repo.git",
        "git@example.test:team/repo.git",
    ] {
        assert!(validate_clone_url(good).is_ok(), "{good} must be accepted");
    }
    for bad in [
        "",
        "   ",
        "http://example.test/repo.git",
        "file:///tmp/repo.git",
        "ext::sh -c whoami",
        "/tmp/repo.git",
        "--upload-pack=touch /tmp/pwned",
        "https://example.test/repo.git; rm -rf /",
        "https://example.test/repo.git\nhost: evil",
        "https://example.test",
        "git@example.test",
        "https:///repo.git",
    ] {
        assert!(
            matches!(validate_clone_url(bad), Err(AppError::BadRequest(_))),
            "{bad:?} must be refused"
        );
    }
}

#[test]
fn derives_the_folder_name_from_the_url() {
    for (url, expected) in [
        ("https://github.com/octocat/Hello-World.git", "Hello-World"),
        ("https://example.test/team/repo/", "repo"),
        ("git@example.test:team/repo.git", "repo"),
        ("ssh://git@example.test/team/deep/repo", "repo"),
    ] {
        assert_eq!(clone_directory_name(url).unwrap(), expected);
    }
}

#[test]
fn refuses_to_clone_over_an_existing_directory() {
    let parent = tempdir().unwrap();
    fs::create_dir(parent.path().join("Hello-World")).unwrap();
    assert!(matches!(
        start_clone(
            "https://github.com/octocat/Hello-World.git",
            parent.path().to_str().unwrap(),
            None,
        ),
        Err(AppError::Conflict(_))
    ));
    // A bad URL never reaches the filesystem either.
    assert!(matches!(
        start_clone(
            "file:///tmp/repo.git",
            parent.path().to_str().unwrap(),
            None
        ),
        Err(AppError::BadRequest(_))
    ));
}

#[test]
fn clones_a_local_bare_repository_end_to_end() {
    let source = tempdir().unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "canvas@example.test"],
        vec!["config", "user.name", "Canvas"],
    ] {
        Command::new("git")
            .args(&args)
            .current_dir(source.path())
            .status()
            .unwrap();
    }
    fs::write(source.path().join("README.md"), "hello\n").unwrap();
    commit_all(source.path(), "first");

    let bare = tempdir().unwrap();
    let bare_path = bare.path().join("fixture.git");
    Command::new("git")
        .args(["clone", "--bare", "-q"])
        .arg(source.path())
        .arg(&bare_path)
        .status()
        .unwrap();

    let destination = tempdir().unwrap();
    let target = prepare_new_directory(destination.path().to_str().unwrap(), "fixture").unwrap();
    let started = spawn_clone_job(bare_path.to_str().unwrap(), "fixture", target.clone()).unwrap();

    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        let status = clone_status(&started.job_id).unwrap();
        if status.state != CloneState::Running {
            break status;
        }
        assert!(Instant::now() < deadline, "clone did not finish");
        std::thread::sleep(Duration::from_millis(20));
    };

    assert_eq!(status.state, CloneState::Done, "{:?}", status.lines);
    assert_eq!(status.name, "fixture");
    assert!(target.join("README.md").exists());
    assert!(target.join(".git").is_dir());

    // An unknown job is a 404, and a finished one cannot be cancelled twice.
    assert!(matches!(clone_status("nope"), Err(AppError::NotFound(_))));
    assert!(cancel_clone(&started.job_id).is_ok());
}
