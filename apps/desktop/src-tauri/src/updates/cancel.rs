//! Stopping a transfer that is already running (design §2.1 `Downloading →
//! Available`).
//!
//! Tauri's updater hands out no abort handle: `Update::download` is one future
//! that either resolves or does not. So the shell keeps the only handle there
//! is — the ability to stop awaiting it — and pairs each transfer with a token
//! it also selects on. Dropping the transfer future closes the response body,
//! which is what actually stops the bytes arriving.
//!
//! Two races decide the shape of this type, and both are resolved in favour of
//! "never act on a transfer that is no longer the current one":
//!
//! 1. **A late finish must not disarm the next transfer.** [`finish`] only
//!    clears the slot when the token it is handed is still the armed one, so a
//!    transfer that was cancelled and then completed anyway leaves the token of
//!    the download started afterwards alone.
//! 2. **Two transfers must not run at once.** [`arm`] cancels whatever it
//!    replaces rather than leaving it orphaned with nobody able to stop it.
//!
//! [`Notify::notify_one`] rather than `notify_waiters` is deliberate: it stores
//! a permit when nobody is waiting yet, so a cancel that arrives between arming
//! and the first poll still stops the transfer instead of being lost.
//!
//! [`finish`]: Cancellation::finish
//! [`arm`]: Cancellation::arm

use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// The transfer in flight, and the one way to stop it.
#[derive(Default)]
pub struct Cancellation {
    armed: Mutex<Option<Arc<Notify>>>,
}

impl Cancellation {
    /// Registers a transfer and returns the token it must select on.
    ///
    /// Anything already armed is cancelled: the state machine only models one
    /// transfer, and an orphaned one would keep writing progress for an offer
    /// nobody is waiting for.
    pub fn arm(&self) -> Arc<Notify> {
        let token = Arc::new(Notify::new());
        let previous = self
            .armed
            .lock()
            .expect("cancel lock")
            .replace(Arc::clone(&token));
        if let Some(previous) = previous {
            previous.notify_one();
        }
        token
    }

    /// Stops the transfer in flight. `false` when there was none, which is how
    /// the command tells "cancelled" from "there was nothing to cancel".
    pub fn cancel(&self) -> bool {
        let Some(token) = self.armed.lock().expect("cancel lock").take() else {
            return false;
        };
        token.notify_one();
        true
    }

    /// Retires a token whose transfer ended on its own.
    ///
    /// A token that is no longer the armed one is ignored — see the race note
    /// on the type.
    pub fn finish(&self, token: &Arc<Notify>) {
        let mut armed = self.armed.lock().expect("cancel lock");
        if armed
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, token))
        {
            *armed = None;
        }
    }

    /// Whether a transfer is registered right now.
    pub fn is_armed(&self) -> bool {
        self.armed.lock().expect("cancel lock").is_some()
    }
}
