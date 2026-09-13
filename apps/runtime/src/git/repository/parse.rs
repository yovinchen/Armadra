//! Parsers for the machine-readable Git output the service reads.

use super::*;

pub(super) fn fields_with_lf(bytes: &[u8], width: usize) -> AppResult<Vec<Vec<String>>> {
    let mut records = Vec::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        let mut fields = Vec::with_capacity(width);
        for _ in 0..width {
            let end = rest
                .iter()
                .position(|byte| *byte == 0)
                .ok_or_else(malformed)?;
            fields.push(text(&rest[..end])?.to_owned());
            rest = &rest[end + 1..];
        }
        rest = rest.strip_prefix(b"\n").ok_or_else(malformed)?;
        records.push(fields);
    }
    Ok(records)
}

/// `git log -z --format=…%x00…` output: every field and every record end is a
/// NUL, so the whole answer is one flat NUL-separated list whose length is a
/// multiple of the record width.
///
/// It is separate from [`fields_with_lf`] because that one reads `for-each-ref`
/// output, where a record ends with a newline. Reading one with the other's
/// rule turns a subject containing a newline — which a reflog message may — into
/// a malformed record.
pub(super) fn fields_with_nul(bytes: &[u8], width: usize) -> AppResult<Vec<Vec<String>>> {
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    let mut fields: Vec<_> = bytes.split(|byte| *byte == 0).collect();
    if fields.last() == Some(&b"".as_slice()) {
        fields.pop();
    }
    if width == 0 || fields.len() % width != 0 {
        return Err(malformed());
    }
    fields
        .chunks_exact(width)
        .map(|row| {
            row.iter()
                .map(|value| text(value).map(str::to_owned))
                .collect::<AppResult<Vec<String>>>()
        })
        .collect()
}

pub(super) fn parse_tracking(track: &str) -> AppResult<(Option<u64>, Option<u64>, bool)> {
    if track == "gone" {
        return Ok((None, None, true));
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(", ").filter(|part| !part.is_empty()) {
        let (direction, count) = part.split_once(' ').ok_or_else(malformed)?;
        let count = count.parse().map_err(|_| malformed())?;
        match direction {
            "ahead" => ahead = count,
            "behind" => behind = count,
            _ => return Err(malformed()),
        }
    }
    Ok((Some(ahead), Some(behind), false))
}

pub(super) fn parse_history(
    bytes: &[u8],
    refs: &HashMap<String, Vec<String>>,
) -> AppResult<Vec<CommitRecord>> {
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    let mut fields: Vec<_> = bytes.split(|byte| *byte == 0).collect();
    if fields.last() == Some(&b"".as_slice()) {
        fields.pop();
    }
    if fields.len() % 7 != 0 {
        return Err(malformed());
    }
    fields
        .as_chunks::<7>()
        .0
        .iter()
        .map(|row| {
            let oid = text(row[0])?.to_owned();
            let parents: Vec<String> = text(row[1])?
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            if !valid_oid(&oid) || parents.iter().any(|oid| !valid_oid(oid)) {
                return Err(malformed());
            }
            Ok(CommitRecord {
                refs: refs.get(&oid).cloned().unwrap_or_default(),
                oid,
                parents,
                subject: text(row[6])?.into(),
                author_name: text(row[2])?.into(),
                author_email: text(row[3])?.into(),
                author_time: text(row[4])?.into(),
                committer_time: text(row[5])?.into(),
            })
        })
        .collect()
}

pub(super) fn parse_worktrees(bytes: &[u8]) -> AppResult<Vec<WorktreeRecord>> {
    let mut records = Vec::new();
    let mut current: Option<WorktreeRecord> = None;
    for field in bytes.split(|byte| *byte == 0) {
        let line = text(field)?;
        if line.is_empty() {
            if let Some(record) = current.take() {
                records.push(record);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if current.is_some() {
                return Err(malformed());
            }
            current = Some(WorktreeRecord {
                path: path.into(),
                head_oid: None,
                branch: None,
                detached: false,
                bare: false,
                is_main: records.is_empty(),
                locked: false,
                lock_reason: None,
                prunable: false,
                prune_reason: None,
                accessible: false,
                dirty: None,
            });
        } else {
            let record = current.as_mut().ok_or_else(malformed)?;
            if let Some(oid) = line.strip_prefix("HEAD ") {
                if !valid_oid(oid) {
                    return Err(malformed());
                }
                record.head_oid = (!oid.bytes().all(|byte| byte == b'0')).then(|| oid.into());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                record.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).into());
            } else if line == "detached" {
                record.detached = true;
            } else if line == "bare" {
                record.bare = true;
            } else if line == "locked" || line.starts_with("locked ") {
                record.locked = true;
                record.lock_reason = line.strip_prefix("locked ").map(str::to_owned);
            } else if line == "prunable" || line.starts_with("prunable ") {
                record.prunable = true;
                record.prune_reason = line.strip_prefix("prunable ").map(str::to_owned);
            } else {
                return Err(malformed());
            }
        }
    }
    if let Some(record) = current {
        records.push(record);
    }
    Ok(records)
}
