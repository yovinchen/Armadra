//! Reconnect policy for one execution host.
//!
//! An unreachable host must cost one attempt per request window rather than an
//! `ssh` storm: consecutive failures back off, and after the attempt budget the
//! host is parked for a cooldown during which connecting is refused outright.
//! A user-initiated probe clears the park, because "still parked" is a useless
//! answer to somebody who just pressed a button.

use std::time::{Duration, Instant};

use super::connection::Connection;

/// Consecutive connect failures before the host is parked.
pub const MAX_CONNECT_ATTEMPTS: u32 = 3;
/// Backoff between those attempts, and the park after the last one.
pub const RECONNECT_BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_millis(1_000),
    Duration::from_millis(4_000),
];
pub const COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct Supervisor {
    pub connection: Option<Connection>,
    /// Consecutive failed connects.
    pub failures: u32,
    /// When connecting is allowed again after the attempt budget ran out.
    pub parked_until: Option<Instant>,
    /// The Worker's own release when it differs from this build's, kept so the
    /// node badge survives between requests.
    pub version_badge: Option<String>,
}

impl Supervisor {
    /// Whether connecting is currently refused, and clears an expired park.
    pub fn parked(&mut self) -> bool {
        match self.parked_until {
            Some(until) if Instant::now() < until => true,
            Some(_) => {
                self.parked_until = None;
                self.failures = 0;
                false
            }
            None => false,
        }
    }

    /// How long to wait before the next attempt.
    ///
    /// Indexed by *failures so far*, so the first retry waits the table's first
    /// entry. The previous arithmetic indexed by the failure count itself,
    /// which skipped the 250 ms entry entirely and made the cheapest case — one
    /// dropped session, immediately reconnectable — wait a full second.
    pub fn backoff(&self) -> Option<Duration> {
        self.failures
            .checked_sub(1)
            .map(|index| RECONNECT_BACKOFF[index.min(MAX_CONNECT_ATTEMPTS - 1) as usize])
    }

    pub fn succeeded(&mut self, connection: Connection, version_badge: Option<String>) {
        self.connection = Some(connection);
        self.failures = 0;
        self.version_badge = version_badge;
    }

    pub fn failed(&mut self) {
        self.failures += 1;
        if self.failures >= MAX_CONNECT_ATTEMPTS {
            self.parked_until = Some(Instant::now() + COOLDOWN);
        }
    }

    /// A user asked directly. Forget the park and the failure count.
    pub fn resume(&mut self) {
        self.parked_until = None;
        self.failures = 0;
        self.connection = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The budget is what stops an unreachable host from becoming an `ssh`
    /// storm, so it has to park after exactly as many failures as it claims.
    #[test]
    fn the_attempt_budget_parks_the_host_and_a_probe_releases_it() {
        let mut supervisor = Supervisor::default();
        assert!(!supervisor.parked());
        assert!(supervisor.backoff().is_none());
        for _ in 0..MAX_CONNECT_ATTEMPTS {
            supervisor.failed();
        }
        assert!(supervisor.parked());
        supervisor.resume();
        assert!(!supervisor.parked());
        assert!(supervisor.backoff().is_none());
    }

    #[test]
    fn each_failure_waits_longer_than_the_last_up_to_the_budget() {
        let mut supervisor = Supervisor::default();
        let mut waits = Vec::new();
        for _ in 0..5 {
            supervisor.failed();
            waits.push(supervisor.backoff().unwrap());
        }
        assert_eq!(&waits[..3], &RECONNECT_BACKOFF[..]);
        // Past the budget the wait stops growing rather than overflowing the
        // table.
        assert_eq!(waits[3], RECONNECT_BACKOFF[2]);
        assert_eq!(waits[4], RECONNECT_BACKOFF[2]);
    }
}
