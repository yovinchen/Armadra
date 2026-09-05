//! `<data_dir>/endpoints.json` — roadmap §4.4.
//!
//! Once the Runtime's TCP port is handed out by the kernel, nothing can hard
//! code it any more. This file is how a browser front end, `armadra.sh` and the
//! Go Host find each other: one 0600 JSON document per data directory, holding
//! one record per service.
//!
//! Two properties matter more than the shape:
//!
//!   * **Writing one service never disturbs the other.** The Runtime and the
//!     Host publish independently and in any order, so a publish is
//!     read-modify-write and an unparsable file is replaced rather than merged
//!     into (a half-written file must not permanently wedge start-up).
//!   * **A record is only ever as good as its process.** `processId`,
//!     `instanceId` and `writtenAt` are there so a reader can tell a live
//!     endpoint from one left behind by a crash; nothing here is trusted as
//!     proof that a service is up, which is why every reader still probes.
//!
//! JSON is camelCase, like every other Runtime document.

use std::{
    io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::hook::auth::write_private_atomically;

/// Bumped when a reader that understands version N can no longer make sense of
/// the file. Adding an optional field does not bump it.
pub const ENDPOINTS_VERSION: u32 = 1;

/// The service keys this file uses.
pub const RUNTIME_SERVICE: &str = "runtime";
pub const HOST_SERVICE: &str = "host";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEndpoint {
    /// Identifies this *run* of the service; it changes on every restart.
    pub instance_id: String,
    /// RFC 3339, UTC.
    pub written_at: String,
    pub process_id: u32,
    /// `http://127.0.0.1:PORT`, absent when the service listens on no port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<String>,
    /// `ws://127.0.0.1:PORT`, when WebSockets are reachable somewhere other
    /// than `http` (the desktop shell's loopback forwarder).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket: Option<String>,
    /// Absolute Unix domain socket path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
    /// Windows named pipe, `\\.\pipe\NAME`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipe: Option<String>,
}

impl ServiceEndpoint {
    /// A record for this process, stamped now.
    pub fn now(instance_id: impl Into<String>) -> Self {
        Self {
            instance_id: instance_id.into(),
            written_at: chrono::Utc::now().to_rfc3339(),
            process_id: std::process::id(),
            http: None,
            websocket: None,
            socket: None,
            pipe: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointsDocument {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<ServiceEndpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<ServiceEndpoint>,
}

impl EndpointsDocument {
    pub fn service(&self, name: &str) -> Option<&ServiceEndpoint> {
        match name {
            RUNTIME_SERVICE => self.runtime.as_ref(),
            HOST_SERVICE => self.host.as_ref(),
            _ => None,
        }
    }

    fn set(&mut self, name: &str, endpoint: Option<ServiceEndpoint>) {
        match name {
            RUNTIME_SERVICE => self.runtime = endpoint,
            HOST_SERVICE => self.host = endpoint,
            _ => {}
        }
    }
}

/// `<data_dir>/endpoints.json`.
pub fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("endpoints.json")
}

/// The process-wide default location.
pub fn default_file() -> PathBuf {
    file(&crate::paths::data_dir())
}

/// Reads the file. A missing, unreadable, unparsable or future-version document
/// yields an empty one: this is a discovery hint, never a source of truth, and
/// a corrupt hint must not stop anything from starting.
pub fn read(path: &Path) -> EndpointsDocument {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return EndpointsDocument::default();
    };
    match serde_json::from_str::<EndpointsDocument>(&contents) {
        Ok(document) if document.version <= ENDPOINTS_VERSION => document,
        Ok(document) => {
            tracing::warn!(
                version = document.version,
                supported = ENDPOINTS_VERSION,
                path = %path.display(),
                "ignoring an endpoints file written by a newer Armadra"
            );
            EndpointsDocument::default()
        }
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "ignoring an unreadable endpoints file");
            EndpointsDocument::default()
        }
    }
}

/// Replaces one service's record, leaving every other service untouched.
/// Written 0600 in a 0700 directory, tmp + rename, so a concurrent reader sees
/// either the old document or the new one.
pub fn publish(path: &Path, service: &str, endpoint: ServiceEndpoint) -> io::Result<()> {
    write_service(path, service, Some(endpoint))
}

/// Removes one service's record on a clean shutdown, so a stale address does not
/// outlive the process that owned it.
pub fn withdraw(path: &Path, service: &str) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    write_service(path, service, None)
}

fn write_service(path: &Path, service: &str, endpoint: Option<ServiceEndpoint>) -> io::Result<()> {
    let mut document = read(path);
    document.version = ENDPOINTS_VERSION;
    document.set(service, endpoint);
    let mut body = serde_json::to_string_pretty(&document)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    body.push('\n');
    write_private_atomically(path, body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn runtime_record() -> ServiceEndpoint {
        ServiceEndpoint {
            http: Some("http://127.0.0.1:53211".into()),
            socket: Some("/tmp/armadra/runtime.sock".into()),
            ..ServiceEndpoint::now("runtime-instance")
        }
    }

    #[test]
    fn a_publish_keeps_the_other_service_and_stays_camel_case() {
        let directory = tempdir().unwrap();
        let path = file(directory.path());
        publish(&path, RUNTIME_SERVICE, runtime_record()).unwrap();
        publish(
            &path,
            HOST_SERVICE,
            ServiceEndpoint {
                http: Some("http://127.0.0.1:53212".into()),
                ..ServiceEndpoint::now("host-instance")
            },
        )
        .unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"instanceId\""), "{raw}");
        assert!(raw.contains("\"writtenAt\""), "{raw}");
        assert!(raw.contains("\"processId\""), "{raw}");
        // Absent transports are omitted rather than written as null.
        assert!(!raw.contains("null"), "{raw}");

        let document = read(&path);
        assert_eq!(document.version, ENDPOINTS_VERSION);
        assert_eq!(
            document.service(RUNTIME_SERVICE).unwrap().http.as_deref(),
            Some("http://127.0.0.1:53211")
        );
        assert_eq!(
            document.service(HOST_SERVICE).unwrap().http.as_deref(),
            Some("http://127.0.0.1:53212")
        );
        assert_eq!(
            document.service(RUNTIME_SERVICE).unwrap().process_id,
            std::process::id()
        );
    }

    #[test]
    fn withdrawing_one_service_does_not_remove_the_file_or_the_other_record() {
        let directory = tempdir().unwrap();
        let path = file(directory.path());
        publish(&path, RUNTIME_SERVICE, runtime_record()).unwrap();
        publish(&path, HOST_SERVICE, ServiceEndpoint::now("host")).unwrap();
        withdraw(&path, RUNTIME_SERVICE).unwrap();
        let document = read(&path);
        assert!(document.service(RUNTIME_SERVICE).is_none());
        assert!(document.service(HOST_SERVICE).is_some());
        // Withdrawing from a file that was never written is not an error.
        withdraw(&file(directory.path().join("gone").as_path()), HOST_SERVICE).unwrap();
    }

    #[test]
    fn a_corrupt_or_newer_file_reads_as_empty_and_is_rewritten() {
        let directory = tempdir().unwrap();
        let path = file(directory.path());
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(read(&path), EndpointsDocument::default());
        std::fs::write(&path, br#"{"version":99,"runtime":{}}"#).unwrap();
        assert_eq!(read(&path), EndpointsDocument::default());
        publish(&path, RUNTIME_SERVICE, runtime_record()).unwrap();
        assert!(read(&path).runtime.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_and_its_directory_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempdir().unwrap();
        let nested = directory.path().join("data");
        let path = file(&nested);
        publish(&path, RUNTIME_SERVICE, runtime_record()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&nested).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn the_default_location_sits_in_the_data_directory() {
        assert!(default_file().starts_with(crate::paths::data_dir()));
        assert_eq!(
            default_file().file_name().and_then(|name| name.to_str()),
            Some("endpoints.json")
        );
    }
}
