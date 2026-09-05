//! Background `git clone` jobs: validation, progress and cancellation.

use super::*;

/* --------------------------------- clone ---------------------------------- */

/// A clone may not run forever: the job is killed and marked failed after this.
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Only the tail of `git clone --progress` is kept; the dialog shows one line.
const CLONE_MAX_LINES: usize = 20;
/// Finished jobs are dropped this long after they stop, so a dialog that is
/// still polling keeps getting an answer while the map does not grow forever.
const CLONE_RETENTION: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloneState {
    Running,
    Done,
    Error,
}

/// A snapshot of one clone job, handed to `GET /api/git/clone/{jobId}`.
#[derive(Debug, Clone)]
pub struct CloneStatus {
    pub state: CloneState,
    pub lines: Vec<String>,
    pub error: Option<String>,
    /// Where the repository landed; the workspace is created from it.
    pub target: PathBuf,
    /// The directory name, which becomes the workspace name.
    pub name: String,
}

struct CloneJob {
    state: CloneState,
    lines: VecDeque<String>,
    error: Option<String>,
    target: PathBuf,
    name: String,
    control: Arc<command::Control>,
    /// Set by `cancel_clone` so the reader thread reports a cancel, not a crash.
    cancelled: bool,
    finished_at: Option<Instant>,
}

/// Process-wide registry. Clone jobs exist before any workspace does, so they
/// cannot hang off the per-workspace event hub; the dialog polls instead.
static CLONE_JOBS: LazyLock<Mutex<HashMap<String, CloneJob>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn jobs() -> std::sync::MutexGuard<'static, HashMap<String, CloneJob>> {
    CLONE_JOBS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Characters a repository URL may contain. Git never sees a shell here, but
/// the allowlist also rules out the argument- and CRLF-injection shapes.
fn clone_url_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || "-._~:/@%+=,".contains(character)
}

/// Accept `https://host/path`, `ssh://[user@]host/path` and `user@host:path`
/// only. Anything else — `file://`, `http://`, `ext::`, a local path, a leading
/// dash — is refused (plan §20).
pub fn validate_clone_url(raw: &str) -> AppResult<String> {
    let url = raw.trim();
    let invalid = || AppError::BadRequest("Repository URL is invalid".into());
    if url.is_empty() || url.len() > 2_048 || !url.chars().all(clone_url_char) {
        return Err(invalid());
    }

    let rest = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        rest
    } else {
        // scp-like `user@host:path`; the `@` must come before the first `:`.
        let (user, remainder) = url.split_once('@').ok_or_else(invalid)?;
        let (host, path) = remainder.split_once(':').ok_or_else(invalid)?;
        if user.is_empty() || host.is_empty() || path.is_empty() || host.contains('/') {
            return Err(invalid());
        }
        return Ok(url.to_owned());
    };

    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => return Err(invalid()),
    };
    let host = authority.rsplit('@').next().unwrap_or_default();
    if host.is_empty() || path.is_empty() {
        return Err(invalid());
    }
    Ok(url.to_owned())
}

/// `https://host/o/repo.git` → `repo`. Used when the dialog leaves the folder
/// name empty.
pub fn clone_directory_name(url: &str) -> AppResult<String> {
    let tail = url.trim_end_matches('/');
    let tail = tail.rsplit(['/', ':']).next().unwrap_or_default();
    let name = tail.strip_suffix(".git").unwrap_or(tail);
    Ok(valid_directory_name(name)?.to_owned())
}

#[derive(Debug, Clone)]
pub struct CloneStarted {
    pub job_id: String,
    pub target: PathBuf,
}

/// Validate the request and spawn `git clone --progress` in the background.
///
/// Returns as soon as the child is running: the caller polls [`clone_status`]
/// and creates the workspace once the job reports `Done`.
pub fn start_clone(url: &str, parent: &str, name: Option<&str>) -> AppResult<CloneStarted> {
    let url = validate_clone_url(url)?;
    let name = match name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => valid_directory_name(name)?.to_owned(),
        None => clone_directory_name(&url)?,
    };
    let target = prepare_new_directory(parent, &name)?;
    spawn_clone_job(&url, &name, target)
}

/// The half that actually runs Git, split out so tests can point it at a local
/// bare repository without loosening [`validate_clone_url`].
pub(super) fn spawn_clone_job(url: &str, name: &str, target: PathBuf) -> AppResult<CloneStarted> {
    let mut process = command::git_command();
    process
        .args(["clone", "--progress", "--"])
        .arg(url)
        .arg(&target);
    spawn_clone_process(process, name, target)
}

pub(super) fn spawn_clone_process(
    process: std::process::Command,
    name: &str,
    target: PathBuf,
) -> AppResult<CloneStarted> {
    let registration = command::register()?;
    let control = registration.control.clone();
    let job_id = Uuid::now_v7().to_string();
    {
        let mut registry = jobs();
        registry.retain(|_, job| {
            job.finished_at
                .is_none_or(|at| at.elapsed() < CLONE_RETENTION)
        });
        if registry
            .values()
            .filter(|job| job.state == CloneState::Running)
            .count()
            >= 16
        {
            return Err(AppError::Conflict("Too many active clone jobs".into()));
        }
        registry.insert(
            job_id.clone(),
            CloneJob {
                state: CloneState::Running,
                lines: VecDeque::new(),
                error: None,
                target: target.clone(),
                name: name.to_owned(),
                control,
                cancelled: false,
                finished_at: None,
            },
        );
    }
    let id = job_id.clone();
    let spawned = std::thread::Builder::new()
        .name("armadra-clone".into())
        .spawn(move || {
            let mut progress = CloneProgress {
                job_id: id.clone(),
                buffer: Vec::new(),
            };
            let output = command::run_registered(
                process,
                CLONE_TIMEOUT,
                &registration,
                Some(Box::new(move |chunk| progress.push(chunk))),
            );
            let mut registry = jobs();
            let Some(job) = registry.get_mut(&id) else {
                return;
            };
            job.finished_at = Some(Instant::now());
            if job.cancelled || registration.control.is_cancelled() {
                job.state = CloneState::Error;
                job.error = Some(
                    "Git clone cancelled; any partial destination was kept for inspection".into(),
                );
            } else {
                match output {
                    Ok(output) if output.status.success() => job.state = CloneState::Done,
                    Ok(_) => {
                        job.state = CloneState::Error;
                        job.error = Some(
                            job.lines
                                .back()
                                .cloned()
                                .unwrap_or_else(|| "Git clone failed".into()),
                        );
                    }
                    Err(error) => {
                        job.state = CloneState::Error;
                        job.error = Some(command::sanitize(&error.to_string()));
                    }
                }
            }
        });
    if spawned.is_err() {
        jobs().remove(&job_id);
        return Err(AppError::Internal(
            "Could not start the clone process monitor".into(),
        ));
    }
    Ok(CloneStarted { job_id, target })
}

/// NUL-free display lines stay bounded even when a remote never writes a newline.
/// Sanitizing at most 20 completed lines per chunk also bounds callback work.
struct CloneProgress {
    job_id: String,
    buffer: Vec<u8>,
}
impl CloneProgress {
    fn push(&mut self, bytes: &[u8]) {
        let mut completed = VecDeque::new();
        for byte in bytes {
            if matches!(*byte, b'\r' | b'\n') {
                if !self.buffer.is_empty() {
                    if completed.len() == CLONE_MAX_LINES {
                        completed.pop_front();
                    }
                    completed.push_back(std::mem::take(&mut self.buffer));
                }
            } else if self.buffer.len() < 4096 {
                self.buffer.push(*byte);
            }
        }
        for mut line in completed {
            push_clone_line(&self.job_id, &mut line);
        }
    }
}
impl Drop for CloneProgress {
    fn drop(&mut self) {
        push_clone_line(&self.job_id, &mut self.buffer);
    }
}

fn push_clone_line(job_id: &str, buffer: &mut Vec<u8>) {
    if buffer.is_empty() {
        return;
    }
    let line = String::from_utf8_lossy(buffer).trim().to_owned();
    buffer.clear();
    if line.is_empty() {
        return;
    }
    let line = command::sanitize(&line);
    let mut registry = jobs();
    if let Some(job) = registry.get_mut(job_id) {
        if job.lines.len() == CLONE_MAX_LINES {
            job.lines.pop_front();
        }
        job.lines.push_back(line);
    }
}

pub fn clone_status(job_id: &str) -> AppResult<CloneStatus> {
    let registry = jobs();
    let job = registry
        .get(job_id)
        .ok_or_else(|| AppError::NotFound("That clone job is unknown".into()))?;
    Ok(CloneStatus {
        state: job.state,
        lines: job.lines.iter().cloned().collect(),
        error: job.error.clone(),
        target: job.target.clone(),
        name: job.name.clone(),
    })
}

/// Request cancellation of exactly this clone's child. A final destination is
/// user-visible and may have changed, so cancellation never recursively deletes
/// it. The actor confirms process completion before changing the job state.
pub fn cancel_clone(job_id: &str) -> AppResult<()> {
    let control = {
        let mut registry = jobs();
        let job = registry
            .get_mut(job_id)
            .ok_or_else(|| AppError::NotFound("That clone job is unknown".into()))?;
        if job.state != CloneState::Running {
            return Ok(());
        }
        job.cancelled = true;
        job.error = Some(
            "Git clone cancellation requested; any partial destination will be preserved".into(),
        );
        job.control.clone()
    };
    control.cancel();
    Ok(())
}
