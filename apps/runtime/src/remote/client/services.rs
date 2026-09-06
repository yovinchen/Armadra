//! Language-server discovery, service control and watches on one execution
//! host, all over the serial connection.

use armadra_protocol::v1;

use super::RemoteWorker;
use crate::{
    error::AppResult,
    remote::service::{Replay, capability, replay},
};

impl RemoteWorker {
    /// Server discovery on the execution host, over the serial connection.
    ///
    /// Discovery starts nothing: it runs each candidate's `--version` and
    /// caches the answer. That is why it does not need the language link, and
    /// why a settings page can list a host's servers before anybody opens an
    /// editor on it.
    pub async fn language_capabilities(
        &self,
        root_id: &str,
        root_path: &str,
        refresh: bool,
    ) -> AppResult<v1::LanguageCapabilities> {
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::LanguageCapabilities(v1::LanguageCapabilitiesRequest {
                    root_id: root_id.to_owned(),
                    refresh,
                }),
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::LanguageCapabilities(capabilities) => Ok(capabilities),
            _ => Err(self.wrong_answer()),
        }
    }

    /// One proxied operation. The answer is the execution host's own status
    /// and JSON body, forwarded to the client unchanged.
    ///
    /// An operation whose capability this Worker does not advertise is refused
    /// here rather than sent: the Worker would answer `UNSUPPORTED` anyway, and
    /// naming the capability is more useful than relaying that.
    pub async fn service(
        &self,
        root_id: &str,
        root_path: &str,
        operation: v1::WorkerServiceOperation,
        request_json: Vec<u8>,
        allow_write: bool,
        allow_execute: bool,
    ) -> AppResult<(u16, Vec<u8>)> {
        if let Some(capability) = capability(operation) {
            self.require_capability(capability).await?;
        }
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::Service(v1::WorkerServiceRequest {
                    root_id: root_id.to_owned(),
                    operation: operation as i32,
                    request_json,
                    allow_write,
                    allow_execute,
                }),
                replay(operation),
            )
            .await?
        {
            v1::worker_response::Result::Service(response) => Ok((
                u16::try_from(response.http_status).unwrap_or(500),
                response.response_json,
            )),
            _ => Err(self.wrong_answer()),
        }
    }

    /// Subscribe to filesystem events for `paths`, or unsubscribe from them.
    ///
    /// A Worker without `remote.watch.v1` refuses here, and the caller falls
    /// back to polling rather than waiting for events that never come.
    pub async fn watch(
        &self,
        root_id: &str,
        root_path: &str,
        operation: v1::WorkerServiceOperation,
        paths: Vec<String>,
    ) -> AppResult<v1::WorkerWatchSubscription> {
        self.require_capability(crate::remote::service::replay::WATCH_CAPABILITY)
            .await?;
        match self
            .send(
                root_id,
                root_path,
                v1::worker_request::Action::Watch(v1::WorkerWatchRequest {
                    root_id: root_id.to_owned(),
                    operation: operation as i32,
                    paths,
                }),
                // A subscription has no effect to duplicate: re-subscribing the
                // same path re-baselines it.
                Replay::Safe,
            )
            .await?
        {
            v1::worker_response::Result::Watch(subscription) => Ok(subscription),
            _ => Err(self.wrong_answer()),
        }
    }
}
