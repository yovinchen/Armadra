//! The `hook_installs` table: which agent CLIs currently have the Armadra
//! hook written into their configuration.

use chrono::Utc;
use sqlx::{Row, SqlitePool};

use crate::{
    error::{AppError, AppResult},
    model::HookInstall,
};

// ---------------------------------------------------------------------------
// Hook installs
// ---------------------------------------------------------------------------

pub async fn upsert_hook_install(
    pool: &SqlitePool,
    agent_id: &str,
    client_revision: i64,
    config_path: Option<&str>,
) -> AppResult<HookInstall> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO hook_installs (agent_id, client_revision, installed_at, config_path) VALUES (?, ?, ?, ?) \
         ON CONFLICT(agent_id) DO UPDATE SET client_revision = excluded.client_revision, \
           installed_at = excluded.installed_at, config_path = excluded.config_path",
    )
    .bind(agent_id)
    .bind(client_revision)
    .bind(&now)
    .bind(config_path)
    .execute(pool)
    .await?;
    Ok(HookInstall {
        agent_id: agent_id.to_owned(),
        client_revision,
        installed_at: now,
        config_path: config_path.map(str::to_owned),
    })
}

pub async fn remove_hook_install(pool: &SqlitePool, agent_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM hook_installs WHERE agent_id = ?")
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_hook_installs(pool: &SqlitePool) -> AppResult<Vec<HookInstall>> {
    let rows = sqlx::query(
        "SELECT agent_id, client_revision, installed_at, config_path FROM hook_installs",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(HookInstall {
                agent_id: row.try_get("agent_id")?,
                client_revision: row.try_get("client_revision")?,
                installed_at: row.try_get("installed_at")?,
                config_path: row.try_get("config_path")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(AppError::from)
}
