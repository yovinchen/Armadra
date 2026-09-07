//! `/api/execution-hosts` — the machines a workspace may run on
//! (Go Host 业务所有权迁移 §2.4, 远端补全设计 §3.3).
//!
//! An execution host is not a second store. It is `settings.ssh.hosts[]` read
//! out as an addressable object, so a client can create, rename, retire,
//! validate and carry one without hand-editing a JSON array inside a
//! preferences document — and so a change to one host is a change to one
//! thing, rather than "the settings changed". Every write here goes through
//! `SettingsStore::patch`, which is the only writer; there is no path by which
//! the two could disagree.
//!
//! Three rules the surface exists to enforce:
//!
//!  1. **This machine is always in the list and is never stored.** Its
//!     identifier is the empty string — the convention migration 0009 already
//!     uses for a local workspace — and it needs no registration, so it has no
//!     row, no revision and no delete.
//!  2. **Nothing that could be a credential travels.** The record holds where
//!     a host is and how the Worker is started there. `identityFile` is a path
//!     the host resolves against its own filesystem; there is no field a
//!     password, passphrase or key could be carried in, so an export is a
//!     configuration file rather than a secret.
//!  3. **A host in use is not deleted out from under its workspaces.** Removing
//!     one whose workspaces still point at it would leave those workspaces
//!     naming a machine nobody can reach, and the files are on it.

use axum::{
    Json,
    extract::{Path as AxumPath, State},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    error::{AppError, AppResult},
    ownership,
    terminal::ssh::{self, SshHost},
};

/// How many hosts one import may carry, matching `terminal::ssh`'s own ceiling
/// on the registry.
const MAX_IMPORT_HOSTS: usize = 64;

/// The export's own shape version. An importer that does not recognise it
/// refuses rather than guessing, because guessing would mean writing a machine
/// registry from a file it could not read.
const EXPORT_VERSION: u32 = 1;

/* ---------------------------------- listing -------------------------------- */

/// One machine, as the settings page and the switch dialog read it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionHostView {
    /// Empty for this machine.
    pub execution_host_id: String,
    pub name: String,
    /// `local` or `ssh`.
    pub kind: &'static str,
    /// Absent for this machine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshHost>,
    /// Whether a `worker` is configured. Without one the host runs terminals
    /// only: a workspace cannot execute on it, and asking is `UNSUPPORTED`
    /// rather than a quiet fall back to this machine.
    pub worker_configured: bool,
    /// How many workspaces currently run here. The delete refusal is derived
    /// from the same number, so what the page shows is what the API enforces.
    pub workspace_count: u32,
}

/// `GET /api/execution-hosts` — this machine first, then the SSH registry in
/// the order the document stores it.
pub async fn list_execution_hosts(
    State(state): State<AppState>,
) -> AppResult<Json<Vec<ExecutionHostView>>> {
    let counts = workspace_counts(&state).await?;
    let mut hosts = vec![ExecutionHostView {
        execution_host_id: String::new(),
        name: String::new(),
        kind: "local",
        ssh: None,
        worker_configured: true,
        workspace_count: counts
            .iter()
            .find(|(id, _)| id.is_empty())
            .map_or(0, |(_, count)| *count),
    }];
    for host in state.settings.ssh_hosts() {
        hosts.push(ExecutionHostView {
            execution_host_id: host.id.clone(),
            name: host.name.clone(),
            kind: "ssh",
            worker_configured: host.worker.is_some(),
            workspace_count: counts
                .iter()
                .find(|(id, _)| *id == host.id)
                .map_or(0, |(_, count)| *count),
            ssh: Some(host),
        });
    }
    Ok(Json(hosts))
}

async fn workspace_counts(state: &AppState) -> AppResult<Vec<(String, u32)>> {
    Ok(sqlx::query_as::<_, (String, i64)>(
        "SELECT execution_host_id, count(*) FROM workspaces GROUP BY execution_host_id",
    )
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(id, count)| (id, count.max(0) as u32))
    .collect())
}

/* ---------------------------------- writes --------------------------------- */

/// `PUT /api/execution-hosts/{id}` — create or replace one host.
///
/// The whole entry is replaced rather than merged: a host is a small record
/// that is edited as a form, and a merge would make "clear the identity file"
/// impossible to express.
pub async fn put_execution_host(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
    Json(host): Json<SshHost>,
) -> AppResult<Json<Vec<ExecutionHostView>>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Settings).await?;
    if host.id != host_id {
        return Err(AppError::BadRequest(
            "The execution host id in the path and in the body must match".into(),
        ));
    }
    if host_id.is_empty() {
        return Err(AppError::BadRequest(
            "This machine is always available and is not registered".into(),
        ));
    }
    // The same validation `normalize` applies, run here so a bad entry is a
    // refusal with a field name rather than an entry that silently disappears
    // on the next read.
    ssh::validate_host(&host)
        .map_err(|field| AppError::BadRequest(format!("Invalid execution host field: {field}")))?;
    let mut hosts = state.settings.ssh_hosts();
    match hosts.iter_mut().find(|existing| existing.id == host.id) {
        Some(existing) => *existing = host,
        None => {
            if hosts.len() >= MAX_IMPORT_HOSTS {
                return Err(AppError::BadRequest(
                    "This installation already holds as many execution hosts as it supports".into(),
                ));
            }
            hosts.push(host);
        }
    }
    write_hosts(&state, hosts).await?;
    list_execution_hosts(State(state)).await
}

/// `DELETE /api/execution-hosts/{id}` — retire a host nothing runs on.
pub async fn delete_execution_host(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
) -> AppResult<Json<Vec<ExecutionHostView>>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Settings).await?;
    let hosts = state.settings.ssh_hosts();
    if !hosts.iter().any(|host| host.id == host_id) {
        return Err(AppError::NotFound("No such execution host".into()));
    }
    let bound = workspace_counts(&state)
        .await?
        .into_iter()
        .find(|(id, _)| *id == host_id)
        .map_or(0, |(_, count)| count);
    if bound > 0 {
        // Deleting it would leave those workspaces naming a machine nothing
        // can reach, and their files are on it. Moving them is a decision, so
        // it is asked for rather than performed here.
        return Err(AppError::Conflict(format!(
            "{bound} workspace(s) still run on this execution host; move them before removing it"
        )));
    }
    write_hosts(
        &state,
        hosts
            .into_iter()
            .filter(|host| host.id != host_id)
            .collect(),
    )
    .await?;
    list_execution_hosts(State(state)).await
}

async fn write_hosts(state: &AppState, hosts: Vec<SshHost>) -> AppResult<()> {
    // The array is replaced whole: `SettingsStore::merge` only recurses into
    // objects, so a partial list would not be a partial write — it would be
    // the new registry.
    state.settings.patch(&serde_json::json!({
        "ssh": { "hosts": serde_json::to_value(&hosts).unwrap_or_default() }
    }))?;
    Ok(())
}

/* --------------------------------- validate -------------------------------- */

/// What one validation found.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionHostValidation {
    pub execution_host_id: String,
    /// Whether `ssh … true` exited zero.
    pub reachable: bool,
    /// Whether the Worker started and its handshake was accepted. `false`
    /// while `reachable` is `true` is the case worth separating: the machine
    /// answers, the Armadra binary on it does not.
    pub worker_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    /// A stable key, not a sentence: `noWorkerConfigured`,
    /// `unreachable`, `handshakeRefused`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// The redacted tail of whatever diagnostics were produced. Empty when
    /// everything worked.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

/// `POST /api/execution-hosts/{id}/validate` — reachability *and* the version
/// handshake, in one answer.
///
/// Two questions, deliberately not collapsed into one: `ssh` can work
/// perfectly while the Worker binary is missing or is a different Armadra
/// build, and a person who is told only "failed" cannot tell which of the two
/// they have to fix.
///
/// Not gated on settings ownership. It runs a command on a machine and stores
/// nothing, and execution stays with the Worker whoever owns a domain (§1.3).
pub async fn validate_execution_host(
    State(state): State<AppState>,
    AxumPath(host_id): AxumPath<String>,
) -> AppResult<Json<ExecutionHostValidation>> {
    let host = state
        .settings
        .ssh_host(&host_id)
        .ok_or_else(|| AppError::NotFound("No such execution host".into()))?;
    let probe = ssh::probe_host(&host).await?;
    let mut result = ExecutionHostValidation {
        execution_host_id: host_id.clone(),
        reachable: probe.ok,
        worker_ok: false,
        platform: None,
        architecture: None,
        runtime_version: None,
        capabilities: Vec::new(),
        reason: None,
        detail: probe.output,
    };
    if !probe.ok {
        result.reason = Some("unreachable");
        return Ok(Json(result));
    }
    if host.worker.is_none() {
        // Reachable and usable for terminals, but no workspace can execute on
        // it. Saying so is the whole point of a separate flag.
        result.reason = Some("noWorkerConfigured");
        return Ok(Json(result));
    }
    match state.remote.get(Some(host), &host_id)?.probe().await {
        Ok(hello) => {
            result.worker_ok = true;
            result.platform = Some(hello.platform);
            result.architecture = Some(hello.architecture);
            result.runtime_version = Some(hello.runtime_version);
            result.capabilities = hello.capabilities;
            result.detail = String::new();
        }
        Err(error) => {
            result.reason = Some("handshakeRefused");
            result.detail = crate::security::redact_secrets(&error.to_string());
        }
    }
    Ok(Json(result))
}

/* ------------------------------ export / import ---------------------------- */

/// The portable form of the registry.
///
/// It carries where each host is and how the Worker is started there, and
/// nothing that could authenticate to it: there is no password or key field to
/// omit, and `identityFile` is a path each machine resolves against its own
/// filesystem. So this is a configuration file, and moving it between two of a
/// person's own machines does not move any secret.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionHostPackage {
    pub version: u32,
    pub hosts: Vec<SshHost>,
}

/// `GET /api/execution-hosts/export`.
pub async fn export_execution_hosts(
    State(state): State<AppState>,
) -> AppResult<Json<ExecutionHostPackage>> {
    Ok(Json(ExecutionHostPackage {
        version: EXPORT_VERSION,
        hosts: state.settings.ssh_hosts(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportExecutionHostsRequest {
    pub version: u32,
    pub hosts: Vec<SshHost>,
    /// Drop the hosts this installation already has instead of merging.
    /// Default is a merge, and a merge never silently replaces: an id that
    /// already exists is refused unless `overwrite` says otherwise.
    #[serde(default)]
    pub replace: bool,
    #[serde(default)]
    pub overwrite: bool,
}

/// `POST /api/execution-hosts/import`.
///
/// The whole package is validated before anything is written. A partial
/// import — some hosts in, one refused — would leave a registry nobody chose,
/// and there is no way to tell from the result which half landed.
pub async fn import_execution_hosts(
    State(state): State<AppState>,
    Json(request): Json<ImportExecutionHostsRequest>,
) -> AppResult<Json<Vec<ExecutionHostView>>> {
    ownership::require_local_write(&state.pool, ownership::OwnershipDomain::Settings).await?;
    if request.version != EXPORT_VERSION {
        return Err(AppError::BadRequest(
            "This execution host package was written to a shape this build does not read".into(),
        ));
    }
    if request.hosts.len() > MAX_IMPORT_HOSTS {
        return Err(AppError::BadRequest(
            "The package holds more execution hosts than this installation supports".into(),
        ));
    }
    for host in &request.hosts {
        ssh::validate_host(host).map_err(|field| {
            AppError::BadRequest(format!(
                "Execution host '{}' has an invalid {field}",
                host.id
            ))
        })?;
    }
    let mut hosts = match request.replace {
        true => Vec::new(),
        false => state.settings.ssh_hosts(),
    };
    for host in request.hosts {
        match hosts.iter_mut().find(|existing| existing.id == host.id) {
            Some(existing) if request.overwrite => *existing = host,
            Some(existing) => {
                return Err(AppError::Conflict(format!(
                    "Execution host '{}' already exists; import with overwrite to replace it",
                    existing.id
                )));
            }
            None => hosts.push(host),
        }
    }
    if hosts.len() > MAX_IMPORT_HOSTS {
        return Err(AppError::BadRequest(
            "Importing these hosts would exceed the registry ceiling".into(),
        ));
    }
    write_hosts(&state, hosts).await?;
    list_execution_hosts(State(state)).await
}
