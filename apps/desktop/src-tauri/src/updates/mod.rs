//! Shell-side application updates (design docs/design/updates-and-service-install.md §2).
//!
//! The shell can only report what it could actually verify. Tauri's updater
//! refuses to install a package whose detached signature does not match the
//! configured public key — so with no key configured there is nothing this
//! shell could check, and it says exactly that. It never reports "up to date"
//! for a check it did not make, and it never installs anything on its own: the
//! commands below read, stage and, only after a person confirms, restart.
//!
//! The work is split so the rules can be tested without a window:
//!
//! - [`machine`] is the state machine, pure;
//! - [`offer`] turns the Host's answer plus the release manifest into one
//!   offer, pure;
//! - [`cancel`] is the only handle there is on a transfer already running;
//! - [`notify`] holds the two out-of-page announcements and their strings;
//! - [`coordinate`] decides what may be stopped and whether a restart worked;
//! - this file is the Tauri surface: the commands and one progress event.

pub mod cancel;
pub mod coordinate;
pub mod machine;
pub mod notify;
pub mod offer;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

pub use machine::{Event, Machine, MissingUpdaterConfig, Offer, Reason, RestartPhase, UpdateState};
use offer::{HostAnswer, ManifestPointer};

/// The channel this build was produced on. CI injects it; a build without one
/// was made on somebody's machine and never auto-updates (design §1.1).
pub const BUILD_CHANNEL: &str = match option_env!("ARMADRA_RELEASE_CHANNEL") {
    Some(channel) => channel,
    None => "development",
};

/// The event a downloading shell emits. One shape, so a page that missed the
/// first one can still render the bar from the next.
pub const PROGRESS_EVENT: &str = "updates://progress";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    received_bytes: u64,
    total_bytes: u64,
}

/// A development escape hatch, and only that.
///
/// With `ARMADRA_UPDATES_DEV=1` a local build may consult a loopback release
/// server over plain HTTP instead of refusing as a development build. It does
/// not relax the signature: Tauri still verifies the bundle against the
/// configured public key, and a build with no key still reports "not
/// configured".
fn development_override() -> bool {
    std::env::var("ARMADRA_UPDATES_DEV").as_deref() == Ok("1")
}

/// Reads the `plugins.updater` block the bundle was built with. Nothing is
/// inferred from the presence of the plugin itself: a registered plugin with an
/// empty key can check nothing.
pub fn missing_updater_config(config: Option<&serde_json::Value>) -> MissingUpdaterConfig {
    let Some(config) = config else {
        return MissingUpdaterConfig {
            pubkey: true,
            endpoints: true,
        };
    };
    let pubkey = config
        .get("pubkey")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|value| value.trim().is_empty());
    let endpoints = config
        .get("endpoints")
        .and_then(serde_json::Value::as_array)
        .is_none_or(|values| {
            values.iter().all(|value| {
                value
                    .as_str()
                    .is_none_or(|endpoint| endpoint.trim().is_empty())
            })
        });
    MissingUpdaterConfig { pubkey, endpoints }
}

/// The configured public key, or "" when the build carries none.
fn configured_pubkey(config: Option<&serde_json::Value>) -> String {
    config
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// The state a shell starts in, before anything is asked.
///
/// The order matters: a build with no key is "not configured" even on the
/// development channel, because the missing key is the thing a person can
/// actually do something about.
pub fn initial_state(
    missing: MissingUpdaterConfig,
    channel: &str,
    development_override: bool,
) -> UpdateState {
    // The endpoint half is supplied at check time from the Host's own artifact
    // list (design §2.2), so only the key makes a build unable to check.
    if missing.pubkey {
        return UpdateState::NotConfigured { missing };
    }
    if channel == "development" && !development_override {
        return UpdateState::LocalBuild;
    }
    UpdateState::Idle
}

/// The shell's update state, plus the bytes a confirmed restart will install.
#[derive(Default)]
pub struct UpdatesController {
    machine: Mutex<Option<Machine>>,
    /// The updater's own handle for the offer in hand. Kept so "restart and
    /// update" installs the bytes that were verified, not a second download.
    staged: Mutex<Option<(Update, Vec<u8>)>>,
    /// The token the transfer in flight selects on. See [`cancel`].
    cancellation: cancel::Cancellation,
}

impl UpdatesController {
    fn machine<'a>(&'a self, app: &AppHandle) -> std::sync::MutexGuard<'a, Option<Machine>> {
        let mut guard = self.machine.lock().expect("update state lock");
        if guard.is_none() {
            let updater = app.config().plugins.0.get("updater");
            let state = initial_state(
                missing_updater_config(updater),
                BUILD_CHANNEL,
                development_override(),
            );
            *guard = Some(match state {
                UpdateState::NotConfigured { missing } => Machine::not_configured(missing),
                UpdateState::LocalBuild => Machine::local_build(),
                _ => Machine::idle(),
            });
        }
        guard
    }

    fn snapshot(&self, app: &AppHandle) -> UpdateState {
        self.machine(app)
            .as_ref()
            .expect("initialized above")
            .state()
            .clone()
    }

    fn apply(&self, app: &AppHandle, event: Event) -> UpdateState {
        let mut guard = self.machine(app);
        let machine = guard.as_mut().expect("initialized above");
        machine.apply(event);
        machine.state().clone()
    }
}

/// What the page learned from the Host, handed over verbatim.
///
/// The shell does not speak the Host protocol; the settings page already holds
/// an authenticated session, so it asks and passes the answer along. Everything
/// here is still treated as untrusted input — see [`offer`].
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostVerdict {
    /// "available", "upToDate", "unavailable" or "unsupported". Anything else
    /// is an answer this build does not understand, and becomes "unavailable".
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub reason_code: String,
    #[serde(default)]
    pub retry_after_ms: i64,
    #[serde(default)]
    pub checked_at_ms: i64,
    /// The build target the Host answered about, "darwin-aarch64" and so on.
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub answer: HostAnswer,
}

/// The Host's reason code as a shell reason. An unrecognized token lands in
/// "could not be confirmed" — never in "up to date".
pub fn reason_for(code: &str) -> Reason {
    match code {
        "SOURCE_UNREACHABLE" | "UPDATES_NOT_CONFIGURED" => Reason::SourceUnreachable,
        "COMPATIBILITY_REFUSED" => Reason::CompatibilityRefused,
        "NO_ARTIFACT_FOR_TARGET" | "CHANNEL_NOT_UPDATABLE" => Reason::NoArtifactForTarget,
        _ => Reason::SourceMalformed,
    }
}

/* ------------------------------- 命令 ------------------------------------ */

/// The state as it stands. Reads nothing off the network.
#[tauri::command]
pub fn updates_state(app: AppHandle) -> UpdateState {
    app.state::<UpdatesController>().snapshot(&app)
}

/// Records the Host's answer and, when it is an offer, cross-checks it against
/// the release manifest before calling anything available (design §2.2).
#[tauri::command]
pub async fn updates_check(app: AppHandle, verdict: HostVerdict) -> UpdateState {
    let controller = app.state::<UpdatesController>();
    let started = controller.apply(&app, Event::CheckStarted);
    if !matches!(started, UpdateState::Checking) {
        return started;
    }
    let event = evaluate(&app, &verdict).await;
    app.state::<UpdatesController>().apply(&app, event)
}

async fn evaluate(app: &AppHandle, verdict: &HostVerdict) -> Event {
    let at_ms = verdict.checked_at_ms;
    match verdict.state.as_str() {
        "upToDate" => Event::CheckedUpToDate { at_ms },
        "available" => match resolve_offer(app, verdict).await {
            Ok(offer) => Event::CheckedAvailable {
                offer: Box::new(offer),
            },
            Err(reason) => Event::CheckRefused {
                reason,
                retry_after_ms: verdict.retry_after_ms,
                at_ms,
            },
        },
        // "unsupported", "unavailable" and anything this build has never heard
        // of are all "the check did not produce an answer".
        _ => Event::CheckRefused {
            reason: reason_for(&verdict.reason_code),
            retry_after_ms: verdict.retry_after_ms,
            at_ms,
        },
    }
}

/// "Skip this version": drops the offer without claiming anything about
/// whether a newer one exists.
#[tauri::command]
pub fn updates_dismiss(app: AppHandle) -> UpdateState {
    app.state::<UpdatesController>()
        .apply(&app, Event::OfferDismissed)
}

/// Stops what is in flight: a transfer, or a check.
///
/// A cancelled transfer discards its bytes and goes back to the offer
/// (design §2.1). Tauri cannot resume, so half a package is not something to
/// keep, and the shell says "available" again rather than pretending the
/// partial file is worth anything.
#[tauri::command]
pub fn updates_cancel(app: AppHandle) -> UpdateState {
    let controller = app.state::<UpdatesController>();
    match controller.snapshot(&app) {
        // The transfer future is dropped by the download command as soon as it
        // sees this token, which closes the response body.
        UpdateState::Downloading { .. } => {
            controller.cancellation.cancel();
            controller.apply(&app, Event::CheckCancelled)
        }
        // A check in flight is one await that cannot be interrupted; leaving
        // `Checking` is enough, because its answer is only accepted from
        // `Checking` and will be ignored when it lands.
        UpdateState::Checking => controller.apply(&app, Event::CheckCancelled),
        other => other,
    }
}

async fn resolve_offer(app: &AppHandle, verdict: &HostVerdict) -> Result<Offer, Reason> {
    let insecure = development_override();
    let pointer = offer::pointer(&verdict.answer, &verdict.target, insecure)?;
    let manifest = fetch_manifest(&pointer).await?;
    let pubkey = configured_pubkey(app.config().plugins.0.get("updater"));
    offer::resolve(&verdict.answer, &pointer, &manifest, &pubkey, insecure)
}

/// Reads `latest.json`, bounded. A body that claims to be larger than a
/// manifest ever is refused before it is read, not after.
async fn fetch_manifest(pointer: &ManifestPointer) -> Result<String, Reason> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| Reason::SourceUnreachable)?;
    let response = client
        .get(pointer.url.clone())
        .send()
        .await
        .map_err(|_| Reason::SourceUnreachable)?;
    if !response.status().is_success() {
        return Err(Reason::SourceUnreachable);
    }
    if response
        .content_length()
        .is_some_and(|length| length > offer::MANIFEST_LIMIT_BYTES as u64)
    {
        return Err(Reason::SourceMalformed);
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| Reason::SourceUnreachable)?;
    if body.len() > offer::MANIFEST_LIMIT_BYTES {
        return Err(Reason::SourceMalformed);
    }
    String::from_utf8(body.to_vec()).map_err(|_| Reason::SourceMalformed)
}

/// Downloads the offered bundle, verifies its signature (Tauri) and its digest
/// (here), and stages it. Nothing is installed.
#[tauri::command]
pub async fn updates_download(app: AppHandle) -> UpdateState {
    {
        // A failure that kept its offer is retried from the offer, so a person
        // pressing "try again" does not have to check first.
        let controller = app.state::<UpdatesController>();
        if matches!(controller.snapshot(&app), UpdateState::Failed { .. }) {
            controller.apply(&app, Event::Retry);
        }
    }
    let started = app
        .state::<UpdatesController>()
        .apply(&app, Event::DownloadStarted);
    let UpdateState::Downloading { offer, .. } = started else {
        return started;
    };
    // The transfer runs against a cancellation token rather than to completion:
    // dropping the future is the only way to stop the updater's download, so
    // whichever of the two finishes first decides what happens next.
    let token = app.state::<UpdatesController>().cancellation.arm();
    let outcome = tokio::select! {
        result = transfer(&app, &offer) => Some(result),
        () = token.notified() => None,
    };
    let controller = app.state::<UpdatesController>();
    controller.cancellation.finish(&token);
    let Some(result) = outcome else {
        // `updates_cancel` already moved the machine back to the offer; report
        // where things actually stand rather than a second, racing transition.
        return controller.snapshot(&app);
    };
    match result {
        Ok((update, bytes)) => {
            let state = controller.apply(&app, Event::DownloadFinished);
            // A transfer that finished *while* it was being cancelled is not a
            // staged update: the machine refused the event, and keeping the
            // bytes would let a later restart install something nobody chose.
            if !matches!(state, UpdateState::Downloaded { .. }) {
                return state;
            }
            *controller.staged.lock().expect("staged update lock") = Some((update, bytes));
            announce_staged(&app, &offer).await;
            state
        }
        Err(reason) => controller.apply(&app, Event::DownloadFailed { reason }),
    }
}

/// Tells the tray and the person that a restart is all that is left
/// (design §4.1, last rule).
///
/// Both announcements are best-effort: an update that is staged stays staged
/// whether or not the notification could be shown, and the settings page says
/// the same thing without either of them.
async fn announce_staged(app: &AppHandle, offer: &Offer) {
    let _ = app.emit(notify::STAGED_EVENT, notify::Staged::ready(&offer.version));
    let settings = crate::runtime_process::runtime_get(app, "/api/settings").await;
    if !notify::wants_notification(&settings) {
        return;
    }
    let locale = crate::usage::Locale::from_environment();
    let _ = app
        .notification()
        .builder()
        .title(notify::notification_title(locale))
        .body(notify::notification_body(locale, &offer.version))
        .show();
}

async fn transfer(app: &AppHandle, offer: &Offer) -> Result<(Update, Vec<u8>), Reason> {
    let manifest = Url::parse(&offer.manifest_url).map_err(|_| Reason::SourceMalformed)?;
    let updater = app
        .updater_builder()
        // The manifest of the release the Host offered, not the address this
        // bundle was built with: that is what lets a beta build update.
        .endpoints(vec![manifest])
        .map_err(|_| Reason::SourceMalformed)?
        .build()
        .map_err(|_| Reason::UpdaterUnavailable)?;
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        // The Host said there is one and the manifest agreed; the updater
        // disagreeing means the two documents describe different things.
        Ok(None) => return Err(Reason::SourceMalformed),
        Err(error) => return Err(transfer_reason(&error)),
    };
    if update.version.trim_start_matches('v') != offer.version {
        return Err(Reason::SourceMalformed);
    }
    let handle = app.clone();
    let total = offer.size_bytes;
    let mut received: u64 = 0;
    let bytes = update
        .download(
            move |chunk, content_length| {
                received += chunk as u64;
                let _ = handle.emit(
                    PROGRESS_EVENT,
                    Progress {
                        received_bytes: received,
                        total_bytes: content_length.unwrap_or(total),
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| transfer_reason(&error))?;
    // Tauri verified the signature. This is the second, independent statement:
    // the digest the *Host* published for these bytes (design §2.2).
    offer::verify_digest(&bytes, &offer.sha256)?;
    Ok((update, bytes))
}

/// A transfer error as one of the stable reason tokens. The error's own text is
/// never surfaced: it carries the endpoint, and an endpoint can carry a token.
fn transfer_reason(error: &tauri_plugin_updater::Error) -> Reason {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            Reason::SignatureMismatch
        }
        Error::Io(io) if io.raw_os_error() == Some(28) => Reason::DiskFull,
        Error::Io(_) | Error::Network(_) | Error::Reqwest(_) => Reason::DownloadInterrupted,
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => Reason::NoArtifactForTarget,
        Error::EmptyEndpoints => Reason::UpdaterUnavailable,
        _ => Reason::SourceMalformed,
    }
}

/// Stops what this shell owns, records the restart, and installs. On success
/// this call does not return: the process is replaced.
#[tauri::command]
pub async fn updates_install(app: AppHandle) -> UpdateState {
    let preparing = app
        .state::<UpdatesController>()
        .apply(&app, Event::RestartRequested);
    let UpdateState::Downloaded {
        offer,
        phase: RestartPhase::Preparing,
        ..
    } = preparing
    else {
        return preparing;
    };
    if let Err(reason) = stop_owned_background(&app).await {
        return app.state::<UpdatesController>().apply(
            &app,
            Event::RestartAbandoned {
                reason: Some(reason),
            },
        );
    }
    let pending = coordinate::PendingRestart {
        expected_version: offer.version.clone(),
        previous_version: app.package_info().version.to_string(),
        previous_package_url: String::new(),
        notes_url: offer.notes_url.clone(),
        started_at_ms: now_ms(),
    };
    if let Err(reason) = coordinate::write_pending(&crate::runtime_data_dir(), &pending) {
        return app.state::<UpdatesController>().apply(
            &app,
            Event::RestartAbandoned {
                reason: Some(reason),
            },
        );
    }
    app.state::<UpdatesController>()
        .apply(&app, Event::BackgroundStopped);
    let staged = app
        .state::<UpdatesController>()
        .staged
        .lock()
        .expect("staged update lock")
        .clone();
    let Some((update, bytes)) = staged else {
        return app.state::<UpdatesController>().apply(
            &app,
            Event::InstallFailed {
                reason: Reason::InstallFailed,
            },
        );
    };
    match update.install(bytes) {
        // Never returns: the installer replaces this process.
        Ok(()) => app.restart(),
        Err(error) => {
            // The install did not happen, so nothing should tell the next
            // start that it did — and the tray must stop offering a restart
            // that would only fail the same way.
            let _ = coordinate::clear_pending(&crate::runtime_data_dir());
            let _ = app.emit(notify::STAGED_EVENT, notify::Staged::cleared());
            app.state::<UpdatesController>().apply(
                &app,
                Event::InstallFailed {
                    reason: transfer_reason(&error),
                },
            )
        }
    }
}

/// Stops the background this shell started, and only that (design §2.3).
///
/// A Host that reports another launcher keeps running: it belongs to whoever
/// installed it, and its sessions are not this update's to end.
async fn stop_owned_background(app: &AppHandle) -> Result<(), Reason> {
    let lifecycle = app.state::<crate::lifecycle::DesktopLifecycle>();
    if let Some(config) = lifecycle.host_config() {
        let data_dir = coordinate::host_data_dir(config.data_dir.as_deref());
        if coordinate::host_is_ours(&data_dir, &config.binary)
            && lifecycle.stop_host().await.is_err()
        {
            return Err(Reason::HostStopFailed);
        }
    }
    let runtime_app = app.clone();
    let stopped = tauri::async_runtime::spawn_blocking(move || {
        runtime_app
            .state::<crate::runtime_process::RuntimeProcess>()
            .stop()
    })
    .await
    .unwrap_or_else(|_| Err("Runtime shutdown task failed".into()));
    stopped.map_err(|_| Reason::HostStopFailed)
}

/// Whether the last restart delivered what it promised (design §2.3, R6).
///
/// The page calls this once at startup. `None` means no update was pending,
/// which is the ordinary case and is not reported to anybody.
#[tauri::command]
pub async fn updates_restart_report(app: AppHandle) -> Option<coordinate::RestartOutcome> {
    let data_dir = crate::runtime_data_dir();
    let pending = coordinate::read_pending(&data_dir)?;
    let readings = coordinate::HealthReadings {
        shell: Some(app.package_info().version.to_string()),
        host: host_version(&app).await,
        runtime: runtime_version(&app).await,
    };
    let outcome = coordinate::verify_restart(&pending, &readings);
    if matches!(outcome, coordinate::RestartOutcome::Completed { .. }) {
        let _ = coordinate::clear_pending(&data_dir);
    }
    Some(outcome)
}

async fn host_version(app: &AppHandle) -> Option<String> {
    let config = app
        .state::<crate::lifecycle::DesktopLifecycle>()
        .host_config()?;
    coordinate::probe_host_version(&config.binary, config.data_dir.as_deref()).await
}

async fn runtime_version(app: &AppHandle) -> Option<String> {
    let transport = app
        .state::<crate::transport::RuntimeTransport>()
        .inner()
        .clone();
    crate::runtime_process::socket_health(&transport)
        .await
        .map(|health| health.version)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
