//! The six business domains write ownership is recorded for
//! (Go Host 业务所有权迁移 §2.2).
//!
//! A domain is a closed set, not a free-form string. The Runtime creates no
//! row it was not migrated with, and refuses a handoff naming anything it does
//! not know: a peer that invented a domain must not be able to make this
//! Runtime stop writing something, nor to have it record ownership of a domain
//! whose guard does not exist here.
//!
//! The order below is the order the domains are switched in, and it is also
//! their dependency order. Only the canvas domain is actually moveable today;
//! the other five rows exist so the record answers "the Runtime writes this"
//! explicitly rather than by the absence of a row.

use armadra_protocol::v1::WriteOwnershipDomain;
use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnershipDomain {
    Canvas,
    Settings,
    Filesystem,
    Session,
    Agent,
    Git,
}

impl OwnershipDomain {
    /// Every domain, in switch order. Reads that list ownership walk this, so a
    /// domain added here without a stored row surfaces as damage rather than as
    /// a silently shorter answer.
    pub const ALL: [Self; 6] = [
        Self::Canvas,
        Self::Settings,
        Self::Filesystem,
        Self::Session,
        Self::Agent,
        Self::Git,
    ];

    /// The stored and on-the-wire name. `worker.proto` carries the domain as a
    /// string on already-released field numbers, so this spelling is contract.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Canvas => "canvas",
            Self::Settings => "settings",
            Self::Filesystem => "filesystem",
            Self::Session => "session",
            Self::Agent => "agent",
            Self::Git => "git",
        }
    }

    /// Parses a domain named by a peer. An unknown name is a refusal, never a
    /// new row: the guard for a domain this build has never heard of does not
    /// exist, so recording ownership of it would mean recording something this
    /// Runtime cannot then enforce.
    pub fn parse(value: &str) -> AppResult<Self> {
        Self::ALL
            .into_iter()
            .find(|domain| domain.as_str() == value)
            .ok_or_else(|| AppError::BadRequest("Write ownership names an unknown domain".into()))
    }

    /// The same refusal for a domain read back out of this Runtime's own
    /// database. A row that is there but unreadable is damage, not a request
    /// error, and it must not be reported as "the Runtime owns it".
    pub fn parse_stored(value: &str) -> AppResult<Self> {
        Self::ALL
            .into_iter()
            .find(|domain| domain.as_str() == value)
            .ok_or_else(|| {
                AppError::Internal("Stored write ownership names an unknown domain".into())
            })
    }

    /// `WriteOwnershipDomain` as it arrives on the wire. Zero is unspecified
    /// and stays refused: reading it as the canvas would hand the busiest
    /// domain to whichever caller left the field empty.
    pub fn from_wire(value: i32) -> AppResult<Self> {
        match WriteOwnershipDomain::try_from(value) {
            Ok(WriteOwnershipDomain::Canvas) => Ok(Self::Canvas),
            Ok(WriteOwnershipDomain::Settings) => Ok(Self::Settings),
            Ok(WriteOwnershipDomain::Filesystem) => Ok(Self::Filesystem),
            Ok(WriteOwnershipDomain::Session) => Ok(Self::Session),
            Ok(WriteOwnershipDomain::Agent) => Ok(Self::Agent),
            Ok(WriteOwnershipDomain::Git) => Ok(Self::Git),
            _ => Err(AppError::BadRequest(
                "Write ownership domain is unspecified or unknown".into(),
            )),
        }
    }

    /// The `WriteOwnershipDomain` number for this domain.
    pub fn to_wire(self) -> i32 {
        match self {
            Self::Canvas => WriteOwnershipDomain::Canvas as i32,
            Self::Settings => WriteOwnershipDomain::Settings as i32,
            Self::Filesystem => WriteOwnershipDomain::Filesystem as i32,
            Self::Session => WriteOwnershipDomain::Session as i32,
            Self::Agent => WriteOwnershipDomain::Agent as i32,
            Self::Git => WriteOwnershipDomain::Git as i32,
        }
    }
}
