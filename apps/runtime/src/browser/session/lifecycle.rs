//! Closing, restoring and shutting sessions down.

use super::*;

/* ------------------------------- close / restore --------------------------- */

/// Detaches the picture (`terminate = false`) or ends the session for good.
pub async fn close(state: &AppState, session_id: &str, terminate: bool) -> AppResult<()> {
    let service = service(state);
    if !terminate {
        // Design §9: closing a node removes the view, not the page. All that
        // happens is the stream stops once the last subscription lapses.
        if let Some(live) = service.live(session_id) {
            live.subscriptions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
            reconcile_stream(&live).await;
        }
        return Ok(());
    }
    let stored = crate::browser::stored(&state.pool, session_id).await?;
    if let Some(live) = service.remove(session_id) {
        live.edit(|record| {
            record.state = SessionState::Terminated;
            record.reason_code = "terminated".into();
        });
        // Ask nicely first so the profile is flushed, then make sure.
        let _ = live
            .client
            .call_with_timeout("Browser.close", json!({}), Duration::from_secs(3))
            .await;
        end_process(&live).await;
        live.events.publish(
            &live.workspace_id,
            WorkspaceEvent::BrowserSession {
                session: Box::new(live.snapshot()),
            },
        );
        let _ = std::fs::remove_dir_all(&live.staging);
    }
    if let Some(stored) = stored {
        launch::remove_profile(Path::new(&stored.profile_dir));
        crate::browser::delete_stored(&state.pool, session_id).await?;
    }
    Ok(())
}

/// Relaunches every kept session after a Runtime restart.
///
/// What comes back: the profile (so logins survive), the URL and the viewport.
/// What does not: the page's JavaScript heap and anything typed but not
/// submitted. Design §9 requires that gap to be stated, not hidden.
pub async fn restore(state: &AppState) -> AppResult<usize> {
    let availability = crate::browser::availability(state);
    let stored = crate::browser::stored_all(&state.pool).await?;
    let mut restored = 0;
    for session in stored {
        if !session.keep_alive || session.state == SessionState::Terminated {
            let _ = crate::browser::delete_stored(&state.pool, &session.id).await;
            launch::remove_profile(Path::new(&session.profile_dir));
            continue;
        }
        if crate::db::get_workspace(&state.pool, &session.workspace_id)
            .await
            .is_err()
        {
            // The workspace is gone; so is any reason to keep the profile.
            let _ = crate::browser::delete_stored(&state.pool, &session.id).await;
            launch::remove_profile(Path::new(&session.profile_dir));
            continue;
        }
        if !availability.available {
            let mut record = record_of(&session);
            record.state = SessionState::Unsupported;
            record.reason_code = availability.reason_code.to_owned();
            let _ = crate::browser::persist(&state.pool, &record).await;
            continue;
        }
        let id = session.id.clone();
        let profile = PathBuf::from(&session.profile_dir);
        match launch::recover(session.process, &profile) {
            launch::Recovery::Reattach { cdp_port } => {
                // The browser this Runtime started is still running, so the
                // page, its JavaScript heap and its logins all survive.
                match reattach(state, session.clone(), cdp_port).await {
                    Ok(_) => {
                        restored += 1;
                        continue;
                    }
                    Err(error) => {
                        // It answered the identity check but not CDP. Falling
                        // through relaunches it, which loses the page but not
                        // the profile.
                        tracing::info!(session = %id, %error, "re-attach failed, relaunching");
                        launch::clear_singleton_locks(&profile);
                    }
                }
            }
            launch::Recovery::ProfileLocked { pid } => {
                // Alive, but not the process this row recorded: the pid was
                // reused, or somebody else opened this profile. Killing a
                // process this Runtime did not start is a decision for a
                // person, so the node says who is holding it and stops.
                tracing::warn!(session = %id, pid, "browser profile is held by another process");
                let mut record = record_of(&session);
                record.state = SessionState::Disconnected;
                record.reason_code = "profile_locked".into();
                let _ = crate::browser::persist(&state.pool, &record).await;
                let workspace_id = record.workspace_id.clone();
                state.events.publish(
                    &workspace_id,
                    WorkspaceEvent::BrowserSession {
                        session: Box::new(record),
                    },
                );
                continue;
            }
            launch::Recovery::Relaunch => {
                // A `kill -9` leaves the profile's singleton files behind, and
                // Chrome refuses to open a profile that still looks taken.
                launch::clear_singleton_locks(&profile);
            }
        }
        match start(state, &availability.executable, session).await {
            Ok(_) => restored += 1,
            Err(error) => {
                tracing::warn!(session = %id, %error, "could not restore a browser session")
            }
        }
    }
    Ok(restored)
}

/// Ends every live session's browser process without deleting anything.
/// Called on Runtime shutdown so no orphan Chrome survives the app.
pub async fn shutdown(state: &AppState) {
    for live in service(state).all() {
        let _ = live
            .client
            .call_with_timeout("Browser.close", json!({}), Duration::from_secs(2))
            .await;
        end_process(&live).await;
        // An orderly exit clears the identity, so the next start does not go
        // looking for a process that was asked to stop.
        let _ = crate::browser::persist_process(
            &live.pool,
            &live.session_id,
            crate::browser::ProcessIdentity::default(),
            &live.snapshot().url,
        )
        .await;
    }
}

/// Ends the browser behind a session, whether this process spawned it or
/// re-attached to it. A re-attached session has no child handle, so the
/// process group (or the Job Object) is all there is to reach.
async fn end_process(live: &Live) {
    let child = live.child.lock().await.take();
    match child {
        Some(mut child) => launch::terminate(&mut child).await,
        None => {
            let pid = live.pid.load(Ordering::SeqCst);
            if pid != 0 {
                launch::kill_group_now(pid);
            }
        }
    }
    live.pid.store(0, Ordering::SeqCst);
}

/// Kills every live browser for this data directory without awaiting.
///
/// The ordinary path is [`shutdown`]; this is the one a `Drop` or a panicking
/// process can take, so a browser is never left running with nobody owning it.
pub fn kill_all_now(state: &AppState) {
    for live in service(state).all() {
        let pid = live.pid.swap(0, Ordering::SeqCst);
        if pid != 0 {
            launch::kill_group_now(pid);
        }
    }
}
