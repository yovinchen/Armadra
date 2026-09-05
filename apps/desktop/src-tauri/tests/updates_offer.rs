//! Deriving one offer from the Host's answer and the release manifest
//! (docs/design/updates-and-service-install.md §2.2).
//!
//! The asset names below are the ones `tools/release/artifacts.mjs` produces,
//! so these tests describe a release this repository can actually publish
//! rather than a shape invented here.

use armadra_desktop::updates::machine::{Offer, Reason};
use armadra_desktop::updates::offer::{
    self, HostAnswer, HostArtifact, key_id_of_public_key, key_id_of_signature, platform_key,
};

const BASE: &str = "https://releases.invalid/yovinchen/Armadra/releases/download/v0.2.0";
const DIGEST: &str = "3b1f8c0d5e2a47698d0c1b3f5a7e9d2c4b6a8e0f1d3c5b7a9e1f3d5c7b9a1e3f";

fn bundle_url() -> String {
    format!("{BASE}/Armadra_0.2.0_darwin-aarch64.app.tar.gz")
}

fn answer() -> HostAnswer {
    HostAnswer {
        version: "0.2.0".into(),
        notes_url: "https://releases.invalid/v0.2.0".into(),
        artifacts: vec![
            HostArtifact {
                component: "manifest".into(),
                target: String::new(),
                url: format!("{BASE}/latest.json"),
                size_bytes: 900,
                sha256: "b".repeat(64),
                signed: true,
            },
            HostArtifact {
                component: "desktop".into(),
                target: "darwin-aarch64".into(),
                url: bundle_url(),
                size_bytes: 12_345,
                sha256: DIGEST.into(),
                signed: true,
            },
            // The .dmg carries the same component and target; only the manifest
            // says which of the two the updater applies.
            HostArtifact {
                component: "desktop".into(),
                target: "darwin-aarch64".into(),
                url: format!("{BASE}/Armadra_0.2.0_darwin-aarch64.dmg"),
                size_bytes: 20_000,
                sha256: "c".repeat(64),
                signed: false,
            },
            HostArtifact {
                component: "host".into(),
                target: "darwin-aarch64".into(),
                url: format!("{BASE}/armadra-host_0.2.0_darwin-aarch64.tar.gz"),
                size_bytes: 9_000,
                sha256: "d".repeat(64),
                signed: true,
            },
        ],
    }
}

fn manifest(url: &str, signature: &str) -> String {
    format!(
        r#"{{"version":"0.2.0","notes":"","pub_date":"1970-01-01T00:00:00Z",
            "platforms":{{"darwin-aarch64":{{"signature":"{signature}","url":"{url}"}}}}}}"#
    )
}

/// A well-formed minisign body: "Ed", an eight byte key id, then a payload of
/// the length the kind requires. No real key is needed to check that the shell
/// refuses a manifest signed by *another* key, which is what this guards.
fn minisign(kind: &str, key_id: [u8; 8]) -> String {
    use base64::Engine as _;
    let payload = if kind == "public" { 32 } else { 64 };
    let mut body = b"Ed".to_vec();
    body.extend_from_slice(&key_id);
    body.extend(std::iter::repeat_n(0x5a, payload));
    let encoded = base64::engine::general_purpose::STANDARD.encode(&body);
    format!("untrusted comment: minisign {kind}\n{encoded}\ntrusted comment: timestamp:0\nAAAA\n")
}

/// Tauri stores the public key base64-encoded in tauri.conf.json.
fn wrapped(text: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

fn resolve(answer: &HostAnswer, manifest_json: &str, pubkey: &str) -> Result<Offer, Reason> {
    let pointer = offer::pointer(answer, "darwin-aarch64", false)?;
    offer::resolve(answer, &pointer, manifest_json, pubkey, false)
}

#[test]
fn the_offer_is_the_bundle_the_manifest_names_with_the_digest_the_host_published() {
    let key = [1, 2, 3, 4, 5, 6, 7, 8];
    let offer = resolve(
        &answer(),
        &manifest(
            &bundle_url(),
            &minisign("signature", key).replace('\n', "\\n"),
        ),
        &wrapped(&minisign("public", key)),
    )
    .expect("the release describes this target");
    assert_eq!(offer.version, "0.2.0");
    assert_eq!(offer.target, "darwin-aarch64");
    assert_eq!(offer.package_url, bundle_url());
    // Not the .dmg's digest, and not one the manifest supplied: the digest has
    // to come from the Host's list or it proves nothing.
    assert_eq!(offer.sha256, DIGEST);
    assert_eq!(offer.size_bytes, 12_345);
    assert!(offer.signed);
    assert_eq!(offer.manifest_url, format!("{BASE}/latest.json"));
    assert_eq!(offer.notes_url, "https://releases.invalid/v0.2.0");
}

/// The whole point of reading the manifest from the Host's answer: an answer
/// cannot send the updater somewhere else.
#[test]
fn a_manifest_or_bundle_outside_the_release_is_refused() {
    let key = [9; 8];
    let signature = minisign("signature", key).replace('\n', "\\n");
    let pubkey = wrapped(&minisign("public", key));

    // A bundle on another host.
    assert_eq!(
        resolve(
            &answer(),
            &manifest(
                "https://elsewhere.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
                &signature
            ),
            &pubkey
        ),
        Err(Reason::SourceMalformed)
    );
    // A bundle in another release of the same host.
    assert_eq!(
        resolve(
            &answer(),
            &manifest(
                "https://releases.invalid/yovinchen/Armadra/releases/download/v9.9.9/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
                &signature
            ),
            &pubkey
        ),
        Err(Reason::SourceMalformed)
    );
    // Plain HTTP off loopback, whatever the rest of the answer says.
    assert_eq!(
        resolve(
            &answer(),
            &manifest(
                "http://releases.invalid/yovinchen/Armadra/releases/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
                &signature
            ),
            &pubkey
        ),
        Err(Reason::SourceMalformed)
    );
    // A manifest URL that is not https is refused before anything is fetched.
    let mut plain = answer();
    plain.artifacts[0].url = "http://releases.invalid/download/v0.2.0/latest.json".into();
    assert_eq!(
        offer::pointer(&plain, "darwin-aarch64", false).unwrap_err(),
        Reason::SourceMalformed
    );
    // …unless the caller explicitly allowed a loopback test server.
    let mut loopback = answer();
    loopback.artifacts[0].url = "http://127.0.0.1:8123/download/v0.2.0/latest.json".into();
    assert!(offer::pointer(&loopback, "darwin-aarch64", true).is_ok());
    assert_eq!(
        offer::pointer(&loopback, "darwin-aarch64", false).unwrap_err(),
        Reason::SourceMalformed
    );
}

#[test]
fn a_manifest_signed_by_another_key_is_refused_before_any_bytes_are_fetched() {
    let ours = [1; 8];
    let theirs = [2; 8];
    assert_eq!(
        resolve(
            &answer(),
            &manifest(
                &bundle_url(),
                &minisign("signature", theirs).replace('\n', "\\n")
            ),
            &wrapped(&minisign("public", ours))
        ),
        Err(Reason::SignatureMismatch)
    );
    // An entry with no signature at all is refused for the same reason: the
    // updater's only protection is that signature.
    assert_eq!(
        resolve(
            &answer(),
            &manifest(&bundle_url(), ""),
            &wrapped(&minisign("public", ours))
        ),
        Err(Reason::SignatureMismatch)
    );
}

/// A build with no key configured never gets this far in practice — it reports
/// "not configured" — but the derivation must not silently accept anything
/// either, so the key comparison is skipped and nothing else is.
#[test]
fn without_a_configured_key_the_rest_of_the_checks_still_apply() {
    let signature = minisign("signature", [7; 8]).replace('\n', "\\n");
    assert!(resolve(&answer(), &manifest(&bundle_url(), &signature), "").is_ok());
    assert_eq!(
        resolve(
            &answer(),
            &manifest("https://elsewhere.invalid/x/Armadra.app.tar.gz", &signature),
            ""
        ),
        Err(Reason::SourceMalformed)
    );
}

#[test]
fn the_manifest_has_to_describe_the_release_the_host_offered() {
    let signature = minisign("signature", [3; 8]).replace('\n', "\\n");
    let other_version = manifest(&bundle_url(), &signature).replace("0.2.0\"", "0.3.0\"");
    assert_eq!(
        resolve(&answer(), &other_version, ""),
        Err(Reason::SourceMalformed)
    );
    // A leading "v" on either side is spelling, not a different release.
    let mut tagged = answer();
    tagged.version = "v0.2.0".into();
    assert!(resolve(&tagged, &manifest(&bundle_url(), &signature), "").is_ok());
}

#[test]
fn a_release_without_this_target_is_never_turned_into_an_offer() {
    let signature = minisign("signature", [4; 8]).replace('\n', "\\n");
    // No desktop artifact for the target at all.
    let mut without = answer();
    without
        .artifacts
        .retain(|artifact| artifact.component != "desktop");
    assert_eq!(
        offer::pointer(&without, "darwin-aarch64", false).unwrap_err(),
        Reason::NoArtifactForTarget
    );
    // Listed by the Host, but absent from the manifest's platforms.
    let manifest =
        manifest(&bundle_url(), &signature).replace("darwin-aarch64\":{", "linux-x86_64\":{");
    assert_eq!(
        resolve(&answer(), &manifest, ""),
        Err(Reason::NoArtifactForTarget)
    );
    // A target this build cannot even spell.
    assert_eq!(
        offer::pointer(&answer(), "plan9-mips", false).unwrap_err(),
        Reason::NoArtifactForTarget
    );
}

/// A bundle the manifest points at that the Host never listed has no digest
/// this shell could trust, so it is refused rather than installed unverified.
#[test]
fn a_bundle_the_host_never_listed_has_no_trustworthy_digest() {
    let signature = minisign("signature", [5; 8]).replace('\n', "\\n");
    let unknown = format!("{BASE}/Armadra_0.2.0_darwin-aarch64.pkg");
    assert_eq!(
        resolve(&answer(), &manifest(&unknown, &signature), ""),
        Err(Reason::SourceMalformed)
    );
    // Listed, but with a digest that is not a sha256.
    let mut short = answer();
    short.artifacts[1].sha256 = "abc".into();
    assert_eq!(
        resolve(&short, &manifest(&bundle_url(), &signature), ""),
        Err(Reason::SourceMalformed)
    );
}

#[test]
fn a_malformed_version_or_an_oversized_manifest_is_refused() {
    for version in ["", "0.2", "0.2.0.1", "01.2.0", "0.2.0-", "hello"] {
        let mut broken = answer();
        broken.version = version.into();
        assert_eq!(
            offer::pointer(&broken, "darwin-aarch64", false).unwrap_err(),
            Reason::SourceMalformed,
            "version {version:?} was accepted"
        );
    }
    let pointer = offer::pointer(&answer(), "darwin-aarch64", false).unwrap();
    let huge = "x".repeat(offer::MANIFEST_LIMIT_BYTES + 1);
    assert_eq!(
        offer::resolve(&answer(), &pointer, &huge, "", false),
        Err(Reason::SourceMalformed)
    );
}

/// Release notes are shown to a person, so a non-https link is dropped rather
/// than rendered as something to click.
#[test]
fn release_notes_are_https_or_absent() {
    let signature = minisign("signature", [6; 8]).replace('\n', "\\n");
    for notes in ["", "javascript:alert(1)", "http://releases.invalid/v0.2.0"] {
        let mut answer = answer();
        answer.notes_url = notes.into();
        let offer = resolve(&answer, &manifest(&bundle_url(), &signature), "").unwrap();
        assert_eq!(offer.notes_url, "", "{notes} survived");
    }
}

#[test]
fn the_digest_is_checked_over_the_bytes_that_actually_arrived() {
    // sha256("armadra")
    let bytes = b"armadra";
    let expected = "a6b0b7ef1e1a2e3fb7f7ea6de8bd8cd1e19f9b18eb1f5d5c0f4bb3d2fbdc5f01";
    // A digest that does not describe these bytes is a mismatch even though it
    // is well formed.
    assert_eq!(
        offer::verify_digest(bytes, expected),
        Err(Reason::DigestMismatch)
    );
    let actual = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(bytes);
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    assert!(offer::verify_digest(bytes, &actual).is_ok());
    // Case is spelling, not a different digest.
    assert!(offer::verify_digest(bytes, &actual.to_uppercase()).is_ok());
    // A digest that is not a sha256 is a malformed release, not a mismatch.
    assert_eq!(
        offer::verify_digest(bytes, "not-a-digest"),
        Err(Reason::SourceMalformed)
    );
}

#[test]
fn minisign_key_ids_are_read_from_both_shapes_and_only_from_well_formed_ones() {
    let key = [10, 20, 30, 40, 50, 60, 70, 80];
    let public = minisign("public", key);
    assert_eq!(key_id_of_public_key(&public), Some(key));
    assert_eq!(key_id_of_public_key(&wrapped(&public)), Some(key));
    let signature = minisign("signature", key);
    assert_eq!(key_id_of_signature(&signature), Some(key));
    assert_eq!(key_id_of_signature(&wrapped(&signature)), Some(key));
    // A signature body is not a public key body and must not be read as one.
    assert_eq!(key_id_of_public_key(&signature), None);
    assert_eq!(key_id_of_signature(&public), None);
    for junk in ["", "   ", "not base64!!", "dW50cnVzdGVk"] {
        assert_eq!(key_id_of_public_key(junk), None, "{junk:?}");
        assert_eq!(key_id_of_signature(junk), None, "{junk:?}");
    }
}

#[test]
fn platform_keys_follow_the_release_targets() {
    assert_eq!(
        platform_key("darwin-aarch64").as_deref(),
        Some("darwin-aarch64")
    );
    assert_eq!(
        platform_key("windows-x86_64").as_deref(),
        Some("windows-x86_64")
    );
    assert_eq!(
        platform_key("linux-aarch64").as_deref(),
        Some("linux-aarch64")
    );
    for bad in ["", "darwin", "plan9-mips", "-x86_64", "darwin-"] {
        assert_eq!(platform_key(bad), None, "{bad:?}");
    }
}
