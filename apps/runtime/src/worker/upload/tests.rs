use super::*;

fn digest_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn stream(uploads: &mut Uploads, root: &Path, path: &str, bytes: &[u8]) -> AppResult<Receipt> {
    let opened = uploads.begin(root, path, bytes.len() as u64, &digest_of(bytes), None)?;
    for (index, chunk) in bytes.chunks(4).enumerate() {
        uploads.chunk(&opened.upload_id, (index * 4) as u64, chunk)?;
    }
    uploads.commit(&opened.upload_id)
}

#[test]
fn a_streamed_file_is_published_whole() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    let bytes = b"hello remote world".to_vec();
    let receipt = stream(&mut uploads, root.path(), "notes/a.txt", &bytes).unwrap();
    assert_eq!(receipt.sha256, digest_of(&bytes));
    assert_eq!(receipt.path, "notes/a.txt");
    assert_eq!(
        std::fs::read(root.path().join("notes/a.txt")).unwrap(),
        bytes
    );
}

/// The digest is the whole safety argument for streaming in pieces. Bytes that
/// do not hash to what the caller promised must never reach the destination.
#[test]
fn bytes_that_do_not_match_the_promised_digest_never_reach_the_destination() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    let opened = uploads
        .begin(root.path(), "a.bin", 4, &digest_of(b"good"), None)
        .unwrap();
    uploads.chunk(&opened.upload_id, 0, b"evil").unwrap();
    assert!(uploads.commit(&opened.upload_id).is_err());
    assert!(!root.path().join("a.bin").exists());
    // And the temporary file is gone rather than left behind.
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

/// A stream that stops early leaves nothing: an incomplete upload is not a
/// truncated file.
#[test]
fn an_upload_that_ends_early_publishes_nothing() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    let opened = uploads
        .begin(root.path(), "a.bin", 8, &digest_of(b"12345678"), None)
        .unwrap();
    uploads.chunk(&opened.upload_id, 0, b"1234").unwrap();
    assert!(uploads.commit(&opened.upload_id).is_err());
    assert!(!root.path().join("a.bin").exists());
}

/// Chunks are positions in a file, not a sequence of arbitrary appends. A gap
/// is refused when it happens rather than at the digest check, so the caller
/// learns which chunk went missing.
#[test]
fn a_chunk_at_the_wrong_offset_is_refused_immediately() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    let opened = uploads
        .begin(root.path(), "a.bin", 8, &digest_of(b"12345678"), None)
        .unwrap();
    uploads.chunk(&opened.upload_id, 0, b"1234").unwrap();
    assert!(uploads.chunk(&opened.upload_id, 8, b"5678").is_err());
}

#[test]
fn an_upload_longer_than_it_declared_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    let opened = uploads
        .begin(root.path(), "a.bin", 4, &digest_of(b"1234"), None)
        .unwrap();
    assert!(uploads.chunk(&opened.upload_id, 0, b"12345").is_err());
}

/// Create-only is the default, exactly as it is for an editor save: an upload
/// that names no content version must not replace a file.
#[test]
fn create_only_refuses_an_existing_destination() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.bin"), b"old").unwrap();
    let mut uploads = Uploads::default();
    assert!(
        uploads
            .begin(root.path(), "a.bin", 3, &digest_of(b"new"), None)
            .is_err()
    );
    assert_eq!(std::fs::read(root.path().join("a.bin")).unwrap(), b"old");
}

#[test]
fn an_overwrite_needs_the_version_that_is_actually_there() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.bin"), b"old").unwrap();
    let mut uploads = Uploads::default();
    assert!(
        uploads
            .begin(
                root.path(),
                "a.bin",
                3,
                &digest_of(b"new"),
                Some(digest_of(b"stale")),
            )
            .is_err()
    );
    let opened = uploads
        .begin(
            root.path(),
            "a.bin",
            3,
            &digest_of(b"new"),
            Some(digest_of(b"old")),
        )
        .unwrap();
    uploads.chunk(&opened.upload_id, 0, b"new").unwrap();
    uploads.commit(&opened.upload_id).unwrap();
    assert_eq!(std::fs::read(root.path().join("a.bin")).unwrap(), b"new");
}

/// A file replaced while the bytes were in flight is a conflict, not a race
/// the last writer wins.
#[test]
fn a_destination_that_changed_mid_upload_is_a_conflict() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.bin"), b"old").unwrap();
    let mut uploads = Uploads::default();
    let opened = uploads
        .begin(
            root.path(),
            "a.bin",
            3,
            &digest_of(b"new"),
            Some(digest_of(b"old")),
        )
        .unwrap();
    uploads.chunk(&opened.upload_id, 0, b"new").unwrap();
    std::fs::write(root.path().join("a.bin"), b"her").unwrap();
    assert!(uploads.commit(&opened.upload_id).is_err());
    assert_eq!(std::fs::read(root.path().join("a.bin")).unwrap(), b"her");
}

/// The trash holds bytes waiting to be restored. An upload landing in it would
/// replace a deletion with something else and call it a restore.
#[test]
fn the_trash_is_not_an_upload_destination() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    for path in [".armadra/trash", ".armadra/trash/abc/file.txt"] {
        assert!(
            uploads
                .begin(root.path(), path, 1, &digest_of(b"x"), None)
                .is_err(),
            "{path}"
        );
    }
}

#[test]
fn a_path_that_leaves_the_root_is_refused_before_anything_is_created() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    for path in ["../escape.txt", "/etc/passwd", "a/../../b"] {
        assert!(
            uploads
                .begin(root.path(), path, 1, &digest_of(b"x"), None)
                .is_err(),
            "{path}"
        );
    }
}

#[test]
fn an_upload_larger_than_the_limit_is_refused_before_a_byte_arrives() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    assert!(
        uploads
            .begin(
                root.path(),
                "a.bin",
                MAX_UPLOAD_BYTES + 1,
                &digest_of(b"x"),
                None,
            )
            .is_err()
    );
}

/// An abort removes what was written; a Worker must not accumulate temporary
/// files for uploads nobody finished.
#[test]
fn aborting_removes_the_temporary_file() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    let opened = uploads
        .begin(root.path(), "a.bin", 4, &digest_of(b"1234"), None)
        .unwrap();
    uploads.chunk(&opened.upload_id, 0, b"12").unwrap();
    uploads.abort(&opened.upload_id).unwrap();
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    // And the id is gone, so a late chunk cannot resurrect it.
    assert!(uploads.chunk(&opened.upload_id, 2, b"34").is_err());
}

/// Dropping the Worker is what happens when the connection dies; nothing
/// half written may survive it.
#[test]
fn dropping_the_registry_removes_every_temporary_file() {
    let root = tempfile::tempdir().unwrap();
    {
        let mut uploads = Uploads::default();
        let opened = uploads
            .begin(root.path(), "a.bin", 4, &digest_of(b"1234"), None)
            .unwrap();
        uploads.chunk(&opened.upload_id, 0, b"12").unwrap();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn only_a_real_digest_opens_an_upload() {
    let root = tempfile::tempdir().unwrap();
    let mut uploads = Uploads::default();
    for digest in ["", "abc", &"z".repeat(64)] {
        assert!(
            uploads
                .begin(root.path(), "a.bin", 1, digest, None)
                .is_err(),
            "{digest}"
        );
    }
}
