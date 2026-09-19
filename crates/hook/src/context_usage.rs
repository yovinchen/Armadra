//! Claude status-line bridge. Only numeric context metadata leaves this process.
//! Sequence allocation happens before stdin consumption; network arrival order
//! and wall-clock adjustments cannot replace a newer observation with an old one.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::{
    endpoint::{env_var, is_valid_node_id},
    http::Request,
    Session, MAX_PAYLOAD_BYTES,
};
use serde_json::{json, Value};

const MAX_COUNT: u64 = 9_007_199_254_740_991;

pub fn run() -> i32 {
    // Always drain stdin, including outside Armadra and on any local failure.
    let binding = load_binding();
    let mut bytes = Vec::new();
    let mut input = io::stdin().lock();
    let read = (&mut input)
        .take(MAX_PAYLOAD_BYTES as u64 + 1)
        .read_to_end(&mut bytes);
    let _ = io::copy(&mut input, &mut io::sink());
    if read.is_err() || bytes.len() > MAX_PAYLOAD_BYTES {
        return 0;
    }
    let Some((session, session_id, generation, revision)) = binding else {
        return 0;
    };
    let Some(data) = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|input| filter_data(&input))
    else {
        return 0;
    };
    let body = json!({ "nodeId": session.node_id, "version": 1,
        "payload": { "armadraContextUsage": {
            "sessionId": session_id, "generation": generation,
            "sourceRevision": revision.to_string(), "data": data,
        }} });
    if let Ok(bytes) = serde_json::to_vec(&body) {
        let _ = session.send(|session, candidate| {
            Request::post_json(
                "/hook/claude",
                session.headers_for(candidate),
                bytes.clone(),
            )
        });
    }
    0
}

pub(crate) fn load_binding() -> Option<(Session, String, u64, u64)> {
    let session = Session::load().ok()?;
    // The sequence file has to live at one fixed path for the life of a
    // generation, so it is anchored to the first (preferred) candidate rather
    // than whichever one a later `send` happens to succeed through — the
    // ordering `discover_candidates` produces is itself stable across calls.
    let primary = session.candidates.first()?;
    primary.node_token(&session.node_id)?;
    let session_id = env_var("ARMADRA_SESSION_ID").filter(|id| is_valid_node_id(id))?;
    let generation = env_var("ARMADRA_SESSION_GENERATION")?
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_COUNT)?;
    let parent = primary.path.parent()?;
    let directory = parent.join("context-sequences");
    let metadata = fs::symlink_metadata(&directory).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return None;
        }
    }
    let revision = next_revision(&directory.join(format!("{session_id}-{generation}.seq"))).ok()?;
    Some((session, session_id, generation, revision))
}

/// OS locks release on process termination. Corrupt files are never reset to
/// zero: doing so could make delayed old reports look newer after a crash.
pub fn next_revision(path: &Path) -> io::Result<u64> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(io::Error::other("invalid context sequence file"));
        }
    }
    let mut options = OpenOptions::new();
    // Runtime initializes this exact generation once before spawning the PTY.
    // A removed file is not permission to reset an active generation to zero.
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // Bounded, so a hook never hangs a CLI on a stuck holder — but wide
    // enough for the holders that are merely slow: each one reads, writes and
    // syncs the file, and eight of them on a loaded host add up to more than
    // the first bound of 150 ms.
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5))
            }
            // Distinguishable, so a caller that can afford to try again knows
            // this was contention and not a broken file.
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "context sequence is held by another hook",
                ));
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
        }
    }
    let length = file.metadata()?.len();
    let previous = match length {
        16 => {
            let mut bytes = [0u8; 16];
            file.read_exact(&mut bytes)?;
            let count = u64::from_be_bytes(bytes[..8].try_into().unwrap());
            let inverse = u64::from_be_bytes(bytes[8..].try_into().unwrap());
            if count != !inverse {
                return Err(io::Error::other("corrupt context sequence"));
            }
            count
        }
        _ => return Err(io::Error::other("corrupt context sequence")),
    };
    let next = previous
        .checked_add(1)
        .ok_or_else(|| io::Error::other("context sequence exhausted"))?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&next.to_be_bytes())?;
    file.write_all(&(!next).to_be_bytes())?;
    file.sync_data()?;
    Ok(next)
}

/// Deliberately excludes transcript paths, workspace paths, costs, tools,
/// prompts and account limits. Missing current usage is forwarded as null.
pub fn filter_data(input: &Value) -> Option<Value> {
    let text = |value: &Value, key: &str| -> Option<String> {
        let text = value.get(key)?.as_str()?;
        (!text.is_empty() && text.len() <= 200 && !text.chars().any(char::is_control))
            .then(|| text.into())
    };
    let session = text(input, "session_id")?;
    let model = text(input.get("model")?, "id")?;
    let window = input.get("context_window")?;
    let current = window.get("current_usage").unwrap_or(&Value::Null);
    let usage = if current.is_null() {
        Value::Null
    } else {
        let count = |key| {
            current
                .get(key)?
                .as_u64()
                .filter(|value| *value <= MAX_COUNT)
        };
        json!({ "input_tokens": count("input_tokens")?,
            "cache_creation_input_tokens": count("cache_creation_input_tokens")?,
            "cache_read_input_tokens": count("cache_read_input_tokens")? })
    };
    let mut filtered = json!({ "session_id": session, "model": { "id": model },
        "context_window": { "context_window_size": window.get("context_window_size").and_then(Value::as_u64).filter(|value| *value > 0 && *value <= MAX_COUNT),
            "current_usage": usage } });
    if window.get("current_usage").is_none() {
        filtered["context_window"]
            .as_object_mut()?
            .remove("current_usage");
    }
    Some(filtered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    #[test]
    fn only_current_context_metadata_is_forwarded() {
        let input = json!({ "session_id":"s", "model":{"id":"m", "secret":"hidden"},
            "transcript_path":"private", "cost":{"total":500}, "prompt":"private",
            "context_window":{"total_input_tokens":99999999, "context_window_size":200000,
            "current_usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":90}}});
        let output = filter_data(&input).unwrap();
        assert_eq!(
            output["context_window"]["current_usage"]
                .as_object()
                .unwrap()
                .len(),
            3
        );
        assert!(!output.to_string().contains("private"));
        assert!(!output.to_string().contains("total_input"));
        assert!(!output.to_string().contains("output_tokens"));
        let mut compact = input;
        compact["context_window"]["current_usage"] = Value::Null;
        assert!(filter_data(&compact).unwrap()["context_window"]["current_usage"].is_null());
    }
    #[test]
    fn revisions_are_monotonic_across_parallel_invocations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.seq");
        fs::write(&path, [0u64.to_be_bytes(), u64::MAX.to_be_bytes()].concat()).unwrap();
        // The subject here is monotonicity, not the bounded wait (which has
        // its own test below): eight holders each sync the file, and on a
        // loaded host the last of them can legitimately be told to try again.
        let mut values = std::thread::scope(|scope| {
            (0..8)
                .map(|_| {
                    let path = &path;
                    scope.spawn(move || loop {
                        match next_revision(path) {
                            Ok(value) => break value,
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                            Err(error) => panic!("{error}"),
                        }
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|join| join.join().unwrap())
                .collect::<Vec<_>>()
        });
        values.sort();
        assert_eq!(values, (1..=8).collect::<Vec<_>>());
        assert_eq!(next_revision(&path).unwrap(), 9);
    }
    #[test]
    fn broken_sequence_is_not_reinitialized_and_lock_wait_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.seq");
        assert!(next_revision(&path).is_err());
        fs::write(&path, [1, 2, 3]).unwrap();
        assert!(next_revision(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), [1, 2, 3]);
        let file = File::options().read(true).write(true).open(&path).unwrap();
        file.lock().unwrap();
        let start = Instant::now();
        assert!(next_revision(&path).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
