//! Terminal manager tests, grouped by the behaviour under test.

mod batch;
#[cfg(unix)]
mod desktop_shutdown;
#[cfg(unix)]
mod dormancy;
#[cfg(unix)]
mod observed;
#[cfg(unix)]
mod sessions;
