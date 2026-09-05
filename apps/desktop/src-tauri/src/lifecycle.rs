//! Closing the foreground keeps its document and services alive. Explicit quit
//! serializes with Host startup, stops the configured Host, then our Runtime.
use std::{
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Duration,
};

use armadra_protocol::{Message, v1};
use tokio::{io::AsyncReadExt, process::Command};

use crate::host::{self, HostLaunchConfig};

const RUNNING: u8 = 0;
const STOPPING: u8 = 1;
const STOPPED: u8 = 2;

#[derive(Default)]
pub struct DesktopLifecycle {
    phase: AtomicU8,
    hidden: AtomicBool,
    host_config: Mutex<Option<Arc<HostLaunchConfig>>>,
    host_operation: tokio::sync::Mutex<()>,
}

impl DesktopLifecycle {
    pub fn configure_host(&self, config: HostLaunchConfig) {
        *self.host_config.lock().expect("Host configuration lock") = Some(Arc::new(config));
    }

    pub fn hide(&self) {
        self.hidden.store(true, Ordering::SeqCst);
    }
    pub fn reveal(&self) -> bool {
        if self.is_quitting() {
            return false;
        }
        self.hidden.store(false, Ordering::SeqCst);
        true
    }
    pub fn should_show(&self) -> bool {
        !self.hidden.load(Ordering::SeqCst) && !self.is_quitting()
    }
    pub fn is_quitting(&self) -> bool {
        self.phase.load(Ordering::SeqCst) != RUNNING
    }
    pub fn begin_quit(&self) -> bool {
        self.phase
            .compare_exchange(RUNNING, STOPPING, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    pub fn quit_failed(&self) {
        self.phase.store(RUNNING, Ordering::SeqCst);
    }
    pub fn quit_completed(&self) {
        self.phase.store(STOPPED, Ordering::SeqCst);
    }
    pub fn can_exit(&self) -> bool {
        self.phase.load(Ordering::SeqCst) == STOPPED
    }

    fn config(&self) -> Option<Arc<HostLaunchConfig>> {
        self.host_config
            .lock()
            .expect("Host configuration lock")
            .clone()
    }

    pub async fn start_host(&self) -> Result<(), host::HostLaunchError> {
        let _operation = self.host_operation.lock().await;
        // Quit may have won before this startup task was first polled.
        if self.is_quitting() {
            return Ok(());
        }
        if let Some(config) = self.config() {
            host::ensure_host(&config).await?;
        }
        Ok(())
    }

    pub async fn stop_host(&self) -> Result<(), String> {
        let _operation = self.host_operation.lock().await;
        if let Some(config) = self.config() {
            stop_host_cli(&config).await?;
        }
        Ok(())
    }
}

async fn stop_host_cli(config: &HostLaunchConfig) -> Result<(), String> {
    let mut command = Command::new(&config.binary);
    command.args(["stop", "--output", "protobuf"]);
    if let Some(directory) = &config.data_dir {
        command.arg("--data-dir").arg(directory);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the trusted Host stop command")?;
    let stdout = child.stdout.take().ok_or("Host stop output unavailable")?;
    let execution = async {
        let read = async {
            let mut bytes = Vec::new();
            stdout
                .take(4097)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "Could not read Host stop result")?;
            if bytes.len() > 4096 {
                return Err("Host stop result exceeded its limit");
            }
            Ok(bytes)
        };
        let (bytes, status) = tokio::try_join!(read, async {
            child
                .wait()
                .await
                .map_err(|_| "Could not wait for Host stop command")
        })?;
        if !status.success() {
            return Err("Host did not confirm complete shutdown");
        }
        let result = v1::HostManagementResult::decode(bytes.as_slice())
            .map_err(|_| "Invalid Host stop result")?;
        if !matches!(
            result.state,
            Some(v1::host_management_result::State::Stopped(_))
        ) {
            return Err("Host is still running");
        }
        Ok(())
    };
    let result = tokio::time::timeout(Duration::from_secs(13), execution)
        .await
        .unwrap_or(Err("Host shutdown timed out"));
    if result.is_err() {
        // Only reap this command's process handle. Never signal a reported PID.
        let _ = child.start_kill();
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            return Err("Host stop command cleanup timed out".into());
        }
    }
    result.map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_close_never_requests_service_shutdown() {
        let state = DesktopLifecycle::default();
        state.hide();
        assert!(!state.should_show());
        assert!(!state.is_quitting());
        assert!(!state.can_exit());
        assert!(state.reveal());
        assert!(state.should_show());
    }

    #[test]
    fn quit_is_single_flight_and_only_completion_permits_exit() {
        let state = DesktopLifecycle::default();
        assert!(state.begin_quit());
        assert!(!state.begin_quit());
        assert!(!state.reveal());
        assert!(!state.can_exit());
        state.quit_failed();
        assert!(state.begin_quit());
        state.quit_completed();
        assert!(state.can_exit());
        assert!(!state.should_show());
    }

    #[tokio::test]
    async fn quit_before_startup_prevents_a_late_host_launch() {
        let state = DesktopLifecycle::default();
        state.configure_host(HostLaunchConfig {
            binary: std::env::temp_dir().join("missing-host-that-must-not-launch"),
            data_dir: None,
            browser_origin: "tauri://localhost".into(),
            cli_timeout: Duration::from_secs(1),
            expected_http_endpoint: host::HOST_ENDPOINT.into(),
        });
        assert!(state.begin_quit());
        state.start_host().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_stop_cli_requires_stopped_protobuf_and_does_not_echo_errors() {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!(
            "armadra-stop-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let binary = directory.join("host");
        let config = HostLaunchConfig {
            binary: binary.clone(),
            data_dir: Some(directory.clone()),
            browser_origin: "tauri://localhost".into(),
            cli_timeout: Duration::from_secs(1),
            expected_http_endpoint: host::HOST_ENDPOINT.into(),
        };
        for (body, success) in [
            (
                "test \"$1 $2 $3 $4\" = 'stop --output protobuf --data-dir' || exit 8\nprintf '\\022\\000'",
                true,
            ),
            ("printf '\\012\\000'", false),
            ("printf 'private-token' >&2; exit 7", false),
            ("head -c 4097 /dev/zero", false),
        ] {
            std::fs::write(&binary, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result = stop_host_cli(&config).await;
            assert_eq!(result.is_ok(), success);
            if let Err(error) = result {
                assert!(!error.contains("private-token"));
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
