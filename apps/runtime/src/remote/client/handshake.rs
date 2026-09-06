//! What makes a remote Worker usable, and what only makes it different
//! (design §3.5).
//!
//! The first version of remote execution required `runtime_version` to be
//! *identical*. That was the honest guarantee available at the time — the
//! service payloads are one build's serde derives — but it also meant that
//! upgrading the controller broke every host until each one was upgraded in
//! lockstep, which is not how anybody administers a fleet of machines.
//!
//! Compatibility is now three separate questions, and each one fails for its
//! own reason:
//!
//! 1. **Protocol.** The major must match. This is the envelope, and it has
//!    always been typed; every 1.x Worker carries the messages a controller
//!    needs, so there is nothing to compare in the minor yet.
//! 2. **Service contract.** [`CONTRACT_VERSION`] must match exactly, because
//!    nothing negotiates the JSON payload shapes. A Worker reporting zero
//!    predates the field and falls back to the old exact-version rule, so an
//!    old Worker is never *less* strictly checked than before.
//! 3. **Capabilities.** Checked per operation, at call time, not here. A
//!    Worker that lacks one group answers that group with 501 naming the
//!    capability and serves everything else — losing the repository panel
//!    should not close the files.
//!
//! A differing `runtime_version` that passes all three is a badge on the node,
//! not a refusal.

use std::collections::HashSet;

use armadra_protocol::v1;

use crate::{
    error::{AppError, AppResult},
    remote::service::replay::CONTRACT_VERSION,
};

/// Capability the remote Worker must advertise before anything is proxied.
pub const REMOTE_CAPABILITY: &str = "remote.execution.v1";

/// What a usable handshake told us.
#[derive(Debug)]
pub struct Accepted {
    pub instance_id: String,
    pub capabilities: HashSet<String>,
    /// The Worker's own release, when it differs from this build's. `None`
    /// means the two match and there is nothing to show.
    pub version_badge: Option<String>,
}

/// Decide whether `hello` may be talked to, and what to say about it.
pub fn accept(host_name: &str, hello: &v1::WorkerHelloResponse) -> AppResult<Accepted> {
    let protocol = hello.protocol.as_ref();
    if protocol.is_none_or(|version| version.major != 1) {
        return Err(AppError::Unsupported(format!(
            "Execution host {host_name} speaks a Worker protocol this controller cannot use"
        )));
    }
    let expected = env!("CARGO_PKG_VERSION");
    if hello.service_contract_version == 0 {
        // Predates the contract version. The only thing that ever guaranteed
        // payload compatibility for such a Worker is an identical build, so
        // that is still what is required of it.
        if hello.runtime_version != expected {
            return Err(AppError::Unsupported(format!(
                "Execution host {host_name} runs Armadra {}, which predates the remote service \
                 contract; this controller is {expected}, so install a matching remote Worker",
                if hello.runtime_version.is_empty() {
                    "an older build"
                } else {
                    &hello.runtime_version
                },
            )));
        }
    } else if hello.service_contract_version != CONTRACT_VERSION {
        return Err(AppError::Unsupported(format!(
            "Execution host {host_name} speaks remote service contract {}, this controller speaks \
             {CONTRACT_VERSION}; upgrade whichever end is older",
            hello.service_contract_version
        )));
    }
    let capabilities: HashSet<String> = hello.capabilities.iter().cloned().collect();
    if !capabilities.contains(REMOTE_CAPABILITY) {
        return Err(AppError::Unsupported(format!(
            "Execution host {host_name} does not offer remote execution"
        )));
    }
    Ok(Accepted {
        instance_id: hello.instance_id.clone(),
        capabilities,
        version_badge: (hello.runtime_version != expected)
            .then(|| hello.runtime_version.clone())
            .filter(|version| !version.is_empty()),
    })
}

/// The 501 a missing capability produces. It names the capability so that an
/// operator reading it knows what to upgrade, rather than being told only that
/// something is unsupported.
pub fn missing_capability(host_name: &str, capability: &str) -> AppError {
    AppError::Unsupported(format!(
        "Execution host {host_name} does not offer {capability}; upgrade its Armadra Worker"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> v1::WorkerHelloResponse {
        v1::WorkerHelloResponse {
            protocol: Some(v1::ProtocolVersion { major: 1, minor: 0 }),
            instance_id: "abcdef0123456789abcdef0123456789".into(),
            runtime_version: env!("CARGO_PKG_VERSION").into(),
            service_contract_version: CONTRACT_VERSION,
            capabilities: vec![REMOTE_CAPABILITY.into()],
            ..Default::default()
        }
    }

    /// The point of the contract version: two patch releases that agree about
    /// the payloads may talk, and the difference becomes a badge.
    #[test]
    fn a_different_patch_release_with_the_same_contract_is_accepted_with_a_badge() {
        let mut hello = hello();
        hello.runtime_version = "99.99.99".into();
        let accepted = accept("Box", &hello).unwrap();
        assert_eq!(accepted.version_badge.as_deref(), Some("99.99.99"));
    }

    #[test]
    fn a_matching_build_shows_no_badge() {
        assert!(accept("Box", &hello()).unwrap().version_badge.is_none());
    }

    /// Nothing negotiates the JSON payloads, so a contract mismatch is not a
    /// degraded mode; it is a refusal.
    #[test]
    fn a_different_service_contract_is_unsupported() {
        let mut hello = hello();
        hello.service_contract_version = CONTRACT_VERSION + 1;
        let error = accept("Box", &hello).unwrap_err();
        assert!(matches!(error, AppError::Unsupported(_)));
    }

    /// A Worker from before the field must not become *more* permissive by
    /// reporting zero: it keeps the exact-version rule it was built under.
    #[test]
    fn a_worker_that_predates_the_contract_still_needs_an_identical_build() {
        let mut hello = hello();
        hello.service_contract_version = 0;
        assert!(accept("Box", &hello).is_ok());
        hello.runtime_version = "0.0.1".into();
        assert!(accept("Box", &hello).is_err());
    }

    #[test]
    fn a_worker_without_remote_execution_is_refused_whatever_its_version() {
        let mut hello = hello();
        hello.capabilities.clear();
        assert!(accept("Box", &hello).is_err());
    }

    #[test]
    fn a_foreign_protocol_major_is_refused_before_anything_else_is_read() {
        let mut hello = hello();
        hello.protocol = Some(v1::ProtocolVersion { major: 2, minor: 0 });
        assert!(accept("Box", &hello).is_err());
    }
}
