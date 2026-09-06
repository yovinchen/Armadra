//! Roots, directory listings, reads and writes on one execution host.

use armadra_protocol::v1;

use super::{RemoteWorker, remote_error};
use crate::{error::AppResult, remote::service::Replay};

impl RemoteWorker {
    /// Register a root on the execution host and return its canonical path
    /// there. Idempotent: the same id and path answer the same way.
    pub async fn register_root(&self, root_id: &str, path: &str) -> AppResult<String> {
        let mut state = self.state.lock().await;
        self.connect(&mut state).await?;
        let connection = state.connection.as_mut().expect("connected");
        match connection
            .call(
                &self.host_id,
                v1::worker_request::Action::RegisterRoot(v1::RegisterRootRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                }),
            )
            .await
        {
            Ok(v1::worker_response::Result::RegisteredRoot(root)) => {
                connection.roots.insert(root_id.to_owned());
                Ok(root.canonical_path)
            }
            Ok(v1::worker_response::Result::Error(error)) => {
                Err(remote_error(&self.host.name, &error))
            }
            Ok(_) => Err(self.wrong_answer()),
            Err(_) => {
                state.connection = None;
                Err(self.unavailable())
            }
        }
    }

    /// `GET .../files` on the execution host.
    pub async fn list_directory(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
    ) -> AppResult<v1::WorkerDirectory> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::ListDirectory(v1::WorkerListDirectoryRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                }),
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::Directory(directory) => Ok(directory),
            _ => Err(self.wrong_answer()),
        }
    }

    /// One chunk of a text file. The caller loops until `eof`, passing the
    /// digest of the first chunk back so a file that changed mid-read is a
    /// conflict rather than a splice of two versions.
    pub async fn read_file(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        offset: u64,
        expected_sha256: Option<Vec<u8>>,
    ) -> AppResult<v1::WorkerFileChunk> {
        self.read(root_id, root_path, path, offset, expected_sha256, false)
            .await
    }

    /// The same chunked read, asked for bytes instead of editor text. Used by
    /// downloads and by whiteboard assets, neither of which is text.
    pub async fn read_raw_file(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        offset: u64,
        expected_sha256: Option<Vec<u8>>,
    ) -> AppResult<v1::WorkerFileChunk> {
        self.read(root_id, root_path, path, offset, expected_sha256, true)
            .await
    }

    async fn read(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        offset: u64,
        expected_sha256: Option<Vec<u8>>,
        raw: bool,
    ) -> AppResult<v1::WorkerFileChunk> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::ReadFile(v1::WorkerReadFileRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                    offset,
                    max_bytes: crate::worker::MAX_CHUNK as u32,
                    expected_sha256,
                    raw,
                }),
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::FileChunk(chunk) => Ok(chunk),
            _ => Err(self.wrong_answer()),
        }
    }

    /// An editor save on the execution host. `expected_sha256` is the content
    /// version the editor read; `None` means the file must not exist yet.
    pub async fn write_file(
        &self,
        root_id: &str,
        root_path: &str,
        path: &str,
        content: String,
        expected_sha256: Option<String>,
        bom: bool,
    ) -> AppResult<v1::WorkerFileWritten> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::WriteFile(v1::WorkerWriteFileRequest {
                    root_id: root_id.to_owned(),
                    path: path.to_owned(),
                    content,
                    expected_sha256,
                    bom,
                }),
                Replay::Never,
            )
            .await?
        {
            v1::worker_response::Result::FileWritten(written) => Ok(written),
            _ => Err(self.wrong_answer()),
        }
    }
}
