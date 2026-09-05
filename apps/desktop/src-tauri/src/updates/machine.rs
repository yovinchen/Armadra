//! The desktop update state machine (design §2.1).
//!
//! It is deliberately free of Tauri, of the network and of the clock: every
//! transition is a pure function of the current state and one event, so the
//! table below is the whole contract and a test can walk all of it.
//!
//! Two rules matter more than the rest, and the transition function is written
//! so they cannot be broken by adding a case:
//!
//! 1. **Nothing becomes `UpToDate` except a check that came back saying so.**
//!    Not looking, failing to look, and looking and finding nothing are three
//!    different answers, and only the third one is "you are on the newest
//!    release".
//! 2. **An event a state does not accept changes nothing.** There is no
//!    fallthrough that lands somewhere plausible; an unexpected event is
//!    ignored and the state stays what it was.
//!
//! `Preparing` and `Installing` from the design's diagram are modelled as
//! phases of `Downloaded` rather than as separate reported states: what the
//! settings page and the tray have to say is still "downloaded, waiting for a
//! restart", and folding them in keeps the reported set to the eleven states of
//! design §4.1 while preserving every transition of §2.1.

use serde::{Deserialize, Serialize};

/// Why something could not be done, as a stable machine token.
///
/// Never a URL, a response body or a transport message: an endpoint can carry a
/// token, and a reason a person reads is rendered from this word by the front
/// end, in their language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// The release source could not be reached or read.
    SourceUnreachable,
    /// The source answered, but not with something this build can parse.
    SourceMalformed,
    /// A newer release exists and refuses this installed version.
    CompatibilityRefused,
    /// The release publishes nothing for this target.
    NoArtifactForTarget,
    /// The manifest entry is signed by a key this build does not carry.
    SignatureMismatch,
    /// The bytes that arrived are not the bytes the release described.
    DigestMismatch,
    /// The transfer stopped before it finished. Tauri cannot resume, so the
    /// bytes are discarded rather than kept as a half download.
    DownloadInterrupted,
    /// There was not enough room to stage the update.
    DiskFull,
    /// The desktop-owned Host would not stop, so the install never started.
    HostStopFailed,
    /// The installer itself failed; the running version was not replaced.
    InstallFailed,
    /// The updater plugin is present but unusable in this build.
    UpdaterUnavailable,
}

/// Which half of the updater configuration is still missing. Both are needed
/// before a check means anything: an endpoint says where releases are
/// published, and a public key is what makes one trustworthy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingUpdaterConfig {
    pub pubkey: bool,
    pub endpoints: bool,
}

impl MissingUpdaterConfig {
    pub fn any(self) -> bool {
        self.pubkey || self.endpoints
    }
}

/// Why this shell cannot update itself at all, beyond configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unsupported {
    /// The page is running in a browser, not in the desktop shell.
    NotDesktop,
    /// The Host answering is not on this machine, so replacing this shell would
    /// not be an update of anything the operator asked about.
    RemoteHost,
    /// The package manager that installed this build owns its updates.
    ManagedPackage,
}

/// What a release offers this target, once the Host's answer and the updater
/// manifest agree about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub version: String,
    pub target: String,
    /// The `latest.json` of the same release, which is what the updater reads.
    pub manifest_url: String,
    /// The bundle the manifest points at, which is what actually gets applied.
    pub package_url: String,
    /// Lowercase hex, 64 characters, as published for `package_url`.
    pub sha256: String,
    pub size_bytes: u64,
    /// The release published a detached signature for this bundle. It is a
    /// property of the release, not a claim that anything was verified.
    pub signed: bool,
    pub notes_url: String,
}

/// Where in the restart a `Downloaded` update is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestartPhase {
    /// Staged and idle; a person has not asked for the restart yet.
    #[default]
    Ready,
    /// Stopping the background this shell owns (design §2.3).
    Preparing,
    /// Handed to the installer. The process is expected to be replaced.
    Installing,
}

/// The eleven states the shell reports (design §4.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum UpdateState {
    /// No public key, no endpoint, or both. Nothing was consulted.
    NotConfigured {
        missing: MissingUpdaterConfig,
    },
    /// A build that never went through CI. It never auto-updates.
    LocalBuild,
    /// A shell that could not apply an update even if one existed.
    Unsupported {
        reason: Unsupported,
    },
    /// Configured, and nothing has been asked yet.
    Idle,
    Checking,
    UpToDate {
        checked_at_ms: i64,
    },
    /// The check was made and did not produce an answer. Never "up to date".
    Unavailable {
        reason: Reason,
        retry_after_ms: i64,
        checked_at_ms: i64,
    },
    Available {
        offer: Offer,
    },
    Downloading {
        offer: Offer,
        received_bytes: u64,
        total_bytes: u64,
    },
    Downloaded {
        offer: Offer,
        phase: RestartPhase,
        /// A restart that was started and did not get as far as installing.
        /// Kept beside the offer so the page can explain why it came back.
        problem: Option<Reason>,
    },
    Failed {
        reason: Reason,
        /// Retained so "retry" has something to retry. The bytes are gone; the
        /// offer is only a description of what to fetch again.
        offer: Option<Offer>,
    },
}

/// Everything that can happen to an update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A person pressed check, or the periodic timer fired.
    CheckStarted,
    /// A check in flight was abandoned.
    CheckCancelled,
    CheckedUpToDate {
        at_ms: i64,
    },
    CheckedAvailable {
        offer: Box<Offer>,
    },
    /// The Host or the manifest refused, with a reason and a retry hint.
    CheckRefused {
        reason: Reason,
        retry_after_ms: i64,
        at_ms: i64,
    },
    /// "Skip this version": the offer is dropped without claiming anything
    /// about whether a newer one exists.
    OfferDismissed,
    DownloadStarted,
    DownloadProgressed {
        received_bytes: u64,
        total_bytes: u64,
    },
    /// Signature and digest both passed; the bytes are on disk.
    DownloadFinished,
    DownloadFailed {
        reason: Reason,
    },
    /// A person confirmed "restart and update".
    RestartRequested,
    /// The desktop-owned background is stopped; the installer may run.
    BackgroundStopped,
    /// Stopping failed, or the person cancelled at the confirmation.
    RestartAbandoned {
        reason: Option<Reason>,
    },
    InstallFailed {
        reason: Reason,
    },
    /// "Try again" from a failure.
    Retry,
}

/// The state plus the transition table. Holding it rather than a bare enum
/// keeps `apply` the only way the state changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    state: UpdateState,
}

impl Machine {
    /// A shell that has everything it needs and has not been asked yet.
    pub fn idle() -> Self {
        Self {
            state: UpdateState::Idle,
        }
    }

    /// A shell that was never given a key or an endpoint.
    pub fn not_configured(missing: MissingUpdaterConfig) -> Self {
        Self {
            state: UpdateState::NotConfigured { missing },
        }
    }

    pub fn local_build() -> Self {
        Self {
            state: UpdateState::LocalBuild,
        }
    }

    pub fn unsupported(reason: Unsupported) -> Self {
        Self {
            state: UpdateState::Unsupported { reason },
        }
    }

    pub fn state(&self) -> &UpdateState {
        &self.state
    }

    /// True while nothing about this build can ever change: these three states
    /// describe the build, not a check, so no event moves out of them.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            UpdateState::NotConfigured { .. }
                | UpdateState::LocalBuild
                | UpdateState::Unsupported { .. }
        )
    }

    /// Whether a check may start right now. A download or a pending restart is
    /// not interrupted by one: the offer in hand is what the person acted on.
    pub fn may_check(&self) -> bool {
        matches!(
            self.state,
            UpdateState::Idle
                | UpdateState::UpToDate { .. }
                | UpdateState::Unavailable { .. }
                | UpdateState::Available { .. }
                | UpdateState::Failed { .. }
        )
    }

    /// The offer this state is about, if any.
    pub fn offer(&self) -> Option<&Offer> {
        match &self.state {
            UpdateState::Available { offer }
            | UpdateState::Downloading { offer, .. }
            | UpdateState::Downloaded { offer, .. } => Some(offer),
            UpdateState::Failed { offer, .. } => offer.as_ref(),
            _ => None,
        }
    }

    /// Applies one event. Returns whether the state changed.
    ///
    /// Every arm is written out; there is no catch-all that guesses. An event
    /// arriving in a state that does not list it is a race the caller lost —
    /// a progress callback landing after a cancel, say — and losing a race must
    /// never invent an answer.
    pub fn apply(&mut self, event: Event) -> bool {
        let next = self.next(event);
        match next {
            Some(state) if state != self.state => {
                self.state = state;
                true
            }
            _ => false,
        }
    }

    fn next(&self, event: Event) -> Option<UpdateState> {
        if self.is_terminal() {
            return None;
        }
        match (&self.state, event) {
            // ---- checking -------------------------------------------------
            (_, Event::CheckStarted) if self.may_check() => Some(UpdateState::Checking),
            (UpdateState::Checking, Event::CheckCancelled) => Some(UpdateState::Idle),
            (UpdateState::Checking, Event::CheckedUpToDate { at_ms }) => {
                Some(UpdateState::UpToDate {
                    checked_at_ms: at_ms,
                })
            }
            (UpdateState::Checking, Event::CheckedAvailable { offer }) => {
                Some(UpdateState::Available { offer: *offer })
            }
            (
                UpdateState::Checking,
                Event::CheckRefused {
                    reason,
                    retry_after_ms,
                    at_ms,
                },
            ) => Some(UpdateState::Unavailable {
                reason,
                retry_after_ms: retry_after_ms.max(0),
                checked_at_ms: at_ms,
            }),

            // ---- the offer ------------------------------------------------
            (UpdateState::Available { .. }, Event::OfferDismissed) => Some(UpdateState::Idle),
            (UpdateState::Available { offer }, Event::DownloadStarted) => {
                Some(UpdateState::Downloading {
                    offer: offer.clone(),
                    received_bytes: 0,
                    total_bytes: offer.size_bytes,
                })
            }
            (
                UpdateState::Failed {
                    offer: Some(offer), ..
                },
                Event::Retry,
            ) => Some(UpdateState::Available {
                offer: offer.clone(),
            }),
            (UpdateState::Failed { offer: None, .. }, Event::Retry) => Some(UpdateState::Idle),

            // ---- the transfer ---------------------------------------------
            (
                UpdateState::Downloading { offer, .. },
                Event::DownloadProgressed {
                    received_bytes,
                    total_bytes,
                },
            ) => Some(UpdateState::Downloading {
                offer: offer.clone(),
                received_bytes,
                // A server that reports no length leaves the offer's own size
                // as the best number there is; zero would render as a finished
                // bar the moment anything arrived.
                total_bytes: if total_bytes == 0 {
                    offer.size_bytes
                } else {
                    total_bytes
                },
            }),
            (UpdateState::Downloading { offer, .. }, Event::DownloadFinished) => {
                Some(UpdateState::Downloaded {
                    offer: offer.clone(),
                    phase: RestartPhase::Ready,
                    problem: None,
                })
            }
            (UpdateState::Downloading { offer, .. }, Event::DownloadFailed { reason }) => {
                Some(UpdateState::Failed {
                    reason,
                    offer: Some(offer.clone()),
                })
            }
            (UpdateState::Downloading { offer, .. }, Event::CheckCancelled) => {
                // Cancelling a download discards the bytes and keeps the offer:
                // a partial file is not something to resume from.
                Some(UpdateState::Available {
                    offer: offer.clone(),
                })
            }

            // ---- the restart ----------------------------------------------
            (
                UpdateState::Downloaded {
                    offer,
                    phase: RestartPhase::Ready,
                    ..
                },
                Event::RestartRequested,
            ) => Some(UpdateState::Downloaded {
                offer: offer.clone(),
                phase: RestartPhase::Preparing,
                problem: None,
            }),
            (
                UpdateState::Downloaded {
                    offer,
                    phase: RestartPhase::Preparing,
                    ..
                },
                Event::BackgroundStopped,
            ) => Some(UpdateState::Downloaded {
                offer: offer.clone(),
                phase: RestartPhase::Installing,
                problem: None,
            }),
            (
                UpdateState::Downloaded {
                    offer,
                    phase: RestartPhase::Preparing,
                    ..
                },
                Event::RestartAbandoned { reason },
            ) => Some(UpdateState::Downloaded {
                offer: offer.clone(),
                phase: RestartPhase::Ready,
                problem: reason,
            }),
            (
                UpdateState::Downloaded {
                    offer,
                    phase: RestartPhase::Installing,
                    ..
                },
                Event::InstallFailed { reason },
            ) => Some(UpdateState::Failed {
                reason,
                offer: Some(offer.clone()),
            }),

            _ => None,
        }
    }
}

impl Default for Machine {
    fn default() -> Self {
        Self::idle()
    }
}
