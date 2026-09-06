//! The managed browser's verification chain. No browser is launched here: the
//! archive is a zip this test builds, served from a loopback listener, so the
//! digest, the switch and the layout checks are exercised without downloading
//! anything from anywhere.
//!
//! The manifest and the download permission are parameters, not process
//! state, which is why these tests can run beside each other.

use std::io::Write;

use super::support::*;

use crate::browser::launch::managed::{self, Manifest, Pin, Pins, Progress};

/// Every digest in the shipped manifest is one somebody observed by running
/// `tools/browser-manifest.mjs` on that platform — Chrome for Testing
/// publishes none — so an entry either carries a real 64-hex digest or is
/// absent. A guessed one would fail every install with `sha256_mismatch`,
/// which is worse than the platform simply not being pinned yet.
#[test]
fn the_shipped_manifest_carries_observed_digests_and_no_guessed_ones() {
    let manifest = Manifest::current().expect("the built-in manifest must parse");
    for (key, target) in &manifest.targets {
        assert!(
            target.sha256.len() == 64 && target.sha256.chars().all(|c| c.is_ascii_hexdigit()),
            "{key} has a digest that did not come from a real download"
        );
        assert!(target.bytes > 0, "{key} pins a digest but not a size");
        assert!(
            target.url.starts_with("https://"),
            "{key} would be fetched over something other than https"
        );
    }
    let directory = tempfile::tempdir().unwrap();
    let state = managed::state(directory.path(), &manifest);
    match manifest.target() {
        // This platform is pinned: nothing is installed yet, and the panel
        // offers the install rather than an explanation.
        Some(target) => {
            assert_eq!(state.state, "absent");
            assert!(state.supported);
            assert_eq!(state.total_bytes, target.bytes);
        }
        // A platform nobody has run the script on says so, and does not fall
        // back to downloading something else.
        None => {
            assert_eq!(state.state, "failed");
            assert_eq!(state.reason_code, "manifest_missing_target");
            assert!(!state.supported);
        }
    }
    assert!(managed::installed(directory.path(), &manifest).is_none());
}

/// The whole chain, four ways: no entry for this platform, the download left
/// switched off, a digest that does not match what arrived, and an archive
/// whose digest does match.
#[tokio::test]
async fn an_install_refuses_a_manifest_it_cannot_verify() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    let archive = build_archive(directory.path());
    let bytes = std::fs::metadata(&archive).unwrap().len();
    let digest = sha256_of(&archive);
    let serving = serve_archive(archive.clone()).await;

    // 1. A manifest with no entry for this OS and architecture. Nothing is
    //    substituted and nothing is fetched.
    let empty = manifest_from(r#"{ "version": "1.2.3", "targets": {} }"#);
    let progress = Progress::default();
    assert_eq!(
        managed::install(&data_dir, &empty, true, &progress)
            .await
            .unwrap_err(),
        "manifest_missing_target"
    );
    assert_eq!(progress.snapshot().reason_code, "manifest_missing_target");

    // 2. A usable manifest, but this build may not fetch anything.
    let good = manifest_from(&manifest_json(&serving.url(), &digest, bytes));
    let progress = Progress::default();
    assert_eq!(
        managed::install(&data_dir, &good, false, &progress)
            .await
            .unwrap_err(),
        "download_disabled",
        "the download half is off unless a build turns it on"
    );
    let state = managed::state(&data_dir, &good);
    assert_eq!(state.state, "absent");
    assert!(state.supported, "the manifest does describe this platform");
    assert_eq!(state.total_bytes, bytes);

    // 3. The bytes arrive, and they are not the bytes the manifest promised.
    let wrong = manifest_from(&manifest_json(&serving.url(), &"a".repeat(64), bytes));
    let progress = Progress::default();
    assert_eq!(
        managed::install(&data_dir, &wrong, true, &progress)
            .await
            .unwrap_err(),
        "sha256_mismatch"
    );
    assert_eq!(progress.snapshot().state, "failed");
    assert!(
        managed::installed(&data_dir, &wrong).is_none(),
        "a refused download installs nothing"
    );
    assert!(
        !managed::install_dir(&data_dir, "1.2.3").exists(),
        "and leaves no half-written directory behind"
    );

    // 4. The digest matches, so the bytes are unpacked and handed to the
    //    platform. macOS asks `codesign`, and an archive this test built is
    //    exactly what that check exists to refuse — a real install's signature
    //    comes from the publisher, not from here. Elsewhere the digest is the
    //    whole chain, which the design records as the open item it is
    //    (Windows Authenticode, and nothing equivalent on Linux).
    let progress = Progress::default();
    let outcome = managed::install(&data_dir, &good, true, &progress).await;
    if cfg!(target_os = "macos") {
        assert_eq!(
            outcome.unwrap_err(),
            "signature_invalid",
            "the digest passed and the layout was right, so this is the signature step"
        );
        assert!(
            managed::installed(&data_dir, &good).is_none(),
            "an unverified bundle is not installed"
        );
    } else {
        let installed = outcome.expect("a matching digest installs");
        assert!(installed.is_file());
        assert_eq!(managed::state(&data_dir, &good).state, "installed");
    }
}

/// A platform the manifest cannot pin still ends up with a digest — just a
/// weaker one. The first download is trusted and recorded; every one after it
/// is checked against what the first saw, so an archive that changed under the
/// same version and URL is refused (§2.1).
#[tokio::test]
async fn an_unpinned_target_is_trusted_once_and_held_to_it_afterwards() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    let archive = build_archive(directory.path());
    let digest = sha256_of(&archive);
    let bytes = std::fs::metadata(&archive).unwrap().len();
    let serving = serve_archive(archive.clone()).await;
    // No digest and no size: what a manifest entry looks like on a platform
    // nobody has run `tools/browser-manifest.mjs` on.
    let blank = manifest_from(&unpinned_json(&serving.url()));
    let key = managed::pin_key("1.2.3");
    assert!(Pins::load(&data_dir).get(&key).is_none());

    let progress = Progress::default();
    let first = managed::install(&data_dir, &blank, true, &progress).await;
    if cfg!(target_os = "macos") {
        // macOS still asks `codesign`, and an archive this test built is not
        // signed. What matters here is what did *not* happen: a failed install
        // pins nothing, so the next attempt is still a first use.
        assert_eq!(first.unwrap_err(), "signature_invalid");
        assert!(
            Pins::load(&data_dir).get(&key).is_none(),
            "an archive that failed the chain is not what this machine is held to"
        );
        return;
    }

    first.expect("a first download is trusted");
    let pin = Pins::load(&data_dir).get(&key).cloned().expect("pinned");
    assert_eq!(pin.sha256, digest);
    assert_eq!(pin.bytes, bytes);
    assert_eq!(pin.url, serving.url());

    // Same URL, different bytes. The manifest never had an opinion; the pin is
    // the whole reason this is caught at all.
    std::fs::remove_dir_all(managed::install_dir(&data_dir, "1.2.3")).unwrap();
    let tampered = directory.path().join("tampered.zip");
    std::fs::copy(&archive, &tampered).unwrap();
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&tampered)
            .unwrap();
        file.write_all(b"extra").unwrap();
    }
    serving.serve(tampered);
    let progress = Progress::default();
    assert_eq!(
        managed::install(&data_dir, &blank, true, &progress)
            .await
            .unwrap_err(),
        "sha256_mismatch"
    );
    assert_eq!(progress.snapshot().reason_code, "sha256_mismatch");
}

/// The same version served from somewhere else is not an archive this machine
/// has ever verified, so it says so rather than granting a second first use.
#[tokio::test]
async fn a_pinned_version_pointed_at_a_new_url_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let blank = manifest_from(&unpinned_json("http://127.0.0.1:1/other.zip"));

    Pins::record(
        &data_dir,
        &managed::pin_key("1.2.3"),
        Pin {
            sha256: "c".repeat(64),
            bytes: 4,
            url: "http://127.0.0.1:2/browser.zip".into(),
            pinned_at: "2026-09-07T00:00:00Z".into(),
        },
    );
    let progress = Progress::default();
    assert_eq!(
        managed::install(&data_dir, &blank, true, &progress)
            .await
            .unwrap_err(),
        "pin_url_changed",
        "nothing here can tell which of the two archives is the real one"
    );
    assert_eq!(progress.snapshot().reason_code, "pin_url_changed");
}

/// An installed managed browser is chosen over whatever the machine happens to
/// have: it is the pinned build this module's CDP adaptation was written
/// against, and the system Chrome updates itself on its own schedule (§2.1).
#[test]
fn a_managed_install_outranks_a_detected_browser() {
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().join("data");
    let manifest = manifest_json("http://127.0.0.1:1/browser.zip", &"b".repeat(64), 4);
    let settings = crate::settings::SettingsStore::in_memory(serde_json::json!({}));
    let read = || Manifest::current_from(&manifest);

    let before = crate::browser::launch::availability_with(&settings, &data_dir, read());
    assert_ne!(before.source, "managed");
    assert_eq!(before.managed.state, "absent");
    assert!(before.managed.supported);

    // Lay the install down the way a finished install leaves it.
    let executable = managed::install_dir(&data_dir, "1.2.3").join("chrome-test/browser");
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();

    let after = crate::browser::launch::availability_with(&settings, &data_dir, read());
    assert!(after.available);
    assert_eq!(after.source, "managed");
    assert_eq!(after.executable, executable.to_string_lossy());
    assert_eq!(after.managed.state, "installed");
    assert!(
        after.searched.iter().any(|path| path == &after.executable),
        "the panel can say what was found and where"
    );

    managed::remove(&data_dir, &read().unwrap()).unwrap();
    assert!(managed::installed(&data_dir, &read().unwrap()).is_none());
}

/// A manifest this build cannot read is reported as such, rather than as a
/// platform without a browser.
#[test]
fn an_unreadable_manifest_is_reported_and_not_guessed_at() {
    let directory = tempfile::tempdir().unwrap();
    let settings = crate::settings::SettingsStore::in_memory(serde_json::json!({}));
    let availability = crate::browser::launch::availability_with(
        &settings,
        directory.path(),
        Manifest::current_from("{ not json"),
    );
    assert_eq!(availability.managed.state, "failed");
    assert_eq!(availability.managed.reason_code, "manifest_invalid");
    assert!(!availability.managed.supported);
    assert!(availability.managed.version.is_empty());
}

/* --------------------------------- helpers -------------------------------- */

fn manifest_from(body: &str) -> Manifest {
    Manifest::current_from(body).expect("the test manifest must parse")
}

/// A zip laid out the way the manifest below says: one directory, one
/// executable inside it.
fn build_archive(directory: &std::path::Path) -> std::path::PathBuf {
    let path = directory.join("browser.zip");
    let file = std::fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().unix_permissions(0o755);
    zip.start_file("chrome-test/browser", options).unwrap();
    zip.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
    zip.finish().unwrap();
    path
}

fn sha256_of(path: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).unwrap();
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A manifest entry for a platform nobody has pinned: a URL and a layout, and
/// nothing yet to check the bytes against.
fn unpinned_json(url: &str) -> String {
    serde_json::json!({
        "version": "1.2.3",
        "targets": {
            managed::target_key(): {
                "url": url,
                "executable": "chrome-test/browser",
            }
        }
    })
    .to_string()
}

fn manifest_json(url: &str, sha256: &str, bytes: u64) -> String {
    serde_json::json!({
        "version": "1.2.3",
        "targets": {
            managed::target_key(): {
                "url": url,
                "sha256": sha256,
                "bytes": bytes,
                "executable": "chrome-test/browser",
            }
        }
    })
    .to_string()
}

struct Serving {
    address: SocketAddr,
    handle: tokio::task::JoinHandle<()>,
    /// What the one route reads. Shared rather than captured so a test can
    /// change what the *same* URL serves, which is the only way to ask whether
    /// a recorded digest is really what catches a swapped archive.
    served: std::sync::Arc<std::sync::Mutex<std::path::PathBuf>>,
}

impl Serving {
    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/browser.zip", self.address.port())
    }

    fn serve(&self, path: std::path::PathBuf) {
        *self
            .served
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = path;
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// The archive over loopback. Nothing in this suite reaches a public host, and
/// the ports Armadra itself uses are skipped.
async fn serve_archive(path: std::path::PathBuf) -> Serving {
    let served = std::sync::Arc::new(std::sync::Mutex::new(path));
    let route = served.clone();
    let router = Router::new().route(
        "/browser.zip",
        get(move || {
            let path = route
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            async move { std::fs::read(path).unwrap_or_default() }
        }),
    );
    let listener = loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        if ![43120_u16, 43121, 1420, 1421].contains(&port) {
            break listener;
        }
    };
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Serving {
        address,
        handle,
        served,
    }
}
