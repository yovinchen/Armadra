//! opencode — a plugin file, because opencode has no hook configuration.
//!
//! opencode exposes one `event` bus to plugins and nothing resembling the
//! per-event command hooks the other CLIs have. So the "installer" writes a
//! small ESM module into `<config home>/plugins/` and the "uninstaller" deletes
//! it; there is no shared file to merge into and therefore nothing of the
//! user's to preserve — except other plugins, which live in their own files.
//!
//! Since B3 the module is [`extension_template::transport_prelude`] plus a few
//! lines of bus wiring, which makes opencode channel B of 协作通道 §3.1: the
//! plugin talks to `hook.sock` from inside opencode's own process instead of
//! forking `armadra-hook` once per bus event. opencode runs plugins on bun, so
//! the prelude's `fetch(url, { unix })` transport is the one that answers here;
//! node's `http.request({ socketPath })` and the loopback port stay behind it,
//! and a socket that cannot be reached at all still falls back to spawning
//! `armadra-hook opencode` with the payload on stdin — the pre-B3 path.
//!
//! What does *not* change is the authority: the same `hook-endpoint.env`
//! bearer, the same `node-tokens/<id>`, the same `terminalBinding`, the same
//! `POST /hook/opencode` body carrying the bus event verbatim, so
//! `normalize/opencode.rs` reads exactly what it read before.
//!
//! The plugin is gated on `ARMADRA_NODE_ID`: in a terminal the user opened
//! themselves the variable is absent, the factory returns no handlers, and
//! opencode behaves exactly as if the plugin were not there.
//!
//! Sources (checked 2026-09-06): plugins run on bun, load from
//! `~/.config/opencode/plugins/` and `.opencode/plugins/`, and export a factory
//! returning a hooks object whose `event` hook is `async ({ event }) => …` with
//! `event` shaped `{ type, properties }` —
//! <https://opencode.ai/docs/plugins/>. That same page is why there is no
//! context reporting here: opencode gives a plugin no `getContextUsage()`
//! equivalent and no context-window size, so `context_events` below is empty
//! and `armadraReportContextUsage` is never called. Token counts do exist
//! inside `message.updated`'s assistant message, but those are transcript
//! accounting without a window to divide by — an estimate, not the `reported`
//! reading Pi's API gives — so they are left to `context_estimate.rs`.

use std::{fs, path::Path};

use super::{HOOK_CLIENT_REVISION, InstallReport, extension_template, is_managed_command};
use crate::error::AppResult;

const AGENT_ID: &str = "opencode";
const PLUGIN_FILE: &str = "armadra-status.js";

/// No handler pushes a context reading: opencode exposes none (see above).
const OPENCODE_CONTEXT_EVENTS: &[&str] = &[];

pub fn plugin_path(config_home: &Path) -> std::path::PathBuf {
    config_home.join("plugins").join(PLUGIN_FILE)
}

pub fn install(config_home: &Path, client_bin: &Path) -> AppResult<InstallReport> {
    let path = plugin_path(config_home);
    super::write_atomically(&path, plugin_source(client_bin).as_bytes())?;
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: Some(client_bin.to_string_lossy().into_owned()),
        client_revision: HOOK_CLIENT_REVISION,
        installed: true,
        warning: None,
    })
}

pub fn uninstall(config_home: &Path) -> AppResult<InstallReport> {
    let path = plugin_path(config_home);
    // Only delete a file that is recognisably ours — the name could have been
    // taken over by something else the user wrote.
    if let Ok(existing) = fs::read_to_string(&path)
        && is_managed_command(&existing)
    {
        fs::remove_file(&path)?;
    }
    Ok(InstallReport {
        agent_id: AGENT_ID.to_owned(),
        config_path: path.to_string_lossy().into_owned(),
        client_bin: None,
        client_revision: HOOK_CLIENT_REVISION,
        installed: false,
        warning: None,
    })
}

/// The plugin body: the shared transport, then opencode's bus wiring.
/// Deterministic — reinstalling writes the same bytes.
fn plugin_source(client_bin: &Path) -> String {
    format!(
        "{prelude}\n{OPENCODE_WIRING}",
        prelude =
            extension_template::transport_prelude(AGENT_ID, client_bin, OPENCODE_CONTEXT_EVENTS),
    )
}

const OPENCODE_WIRING: &str = r##"
/**
 * opencode's documented plugin shape: a factory returning the hooks object.
 * The bus event arrives as `{ type, properties }` and is forwarded verbatim,
 * because `normalize/opencode.rs` is the half that decides which topics mean
 * anything — the plugin has no opinion and keeps none across versions.
 */
export const ArmadraStatus = async () => {
  // Outside a canvas terminal no handler is registered at all, so opencode
  // behaves exactly as if this file were not on disk.
  if (!armadraEnv("ARMADRA_NODE_ID")) return {};
  return {
    event: async ({ event }) => {
      try {
        // Re-checked per event: the report is what carries the node id, and a
        // handler that outlived its terminal has nothing to report to.
        if (!armadraEnv("ARMADRA_NODE_ID")) return;
        // Awaited, unlike the Pi extension's fire-and-forget handlers, because
        // opencode's ordering is the state machine: a `session.idle` that
        // overtook the `message.updated` opening the turn would report the
        // wrong state. Both transports are bounded by ARMADRA_TIMEOUT_MS.
        await armadraReport(event);
      } catch {
        // Reporting is best effort: a canvas problem must not break a turn.
      }
    },
  };
};
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn client() -> &'static Path {
        Path::new("/opt/armadra/armadra-hook")
    }

    #[test]
    fn the_plugin_is_written_gated_and_idempotent() {
        let home = tempdir().unwrap();
        let report = install(home.path(), client()).unwrap();
        assert!(report.installed);
        assert_eq!(report.agent_id, "opencode");
        assert_eq!(report.client_revision, HOOK_CLIENT_REVISION);
        let path = plugin_path(home.path());
        assert!(path.ends_with("plugins/armadra-status.js"));
        assert_eq!(report.config_path, path.to_string_lossy());

        let source = fs::read_to_string(&path).unwrap();
        assert!(source.contains("export const ArmadraStatus"));
        assert!(source.contains("armadraEnv(\"ARMADRA_NODE_ID\")"));
        assert!(source.contains("/opt/armadra/armadra-hook"));
        assert!(source.contains("const ARMADRA_AGENT = \"opencode\";"));
        assert!(is_managed_command(&source));

        install(home.path(), client()).unwrap();
        assert_eq!(source, fs::read_to_string(&path).unwrap());
    }

    /// §3.1 channel B: the plugin dials the socket itself and only spawns when
    /// it cannot. Both halves have to be in the file for either claim to hold.
    #[test]
    fn the_plugin_connects_in_process_and_keeps_the_spawn_fallback() {
        let source = plugin_source(client());
        // bun's transport first — that is what opencode runs on — then node's,
        // then the loopback port the endpoint file may carry.
        assert!(source.contains("unix: session.sock"));
        assert!(source.contains("socketPath: session.sock"));
        assert!(source.contains("host: \"127.0.0.1\""));
        // The fallback that was the whole plugin before B3.
        assert!(source.contains("spawn(ARMADRA_CLIENT, [ARMADRA_AGENT]"));
        // The credentials §1.3 calls unweakenable, unchanged by the transport.
        assert!(source.contains("X-Armadra-Hook-Token"));
        assert!(source.contains("X-Armadra-Node-Token"));
        assert!(source.contains("terminalBinding"));
        assert!(source.contains("context-sequences"));
        // The route stays opencode's own.
        assert!(source.contains("\"/hook/\" + ARMADRA_AGENT"));
        // opencode gives a plugin no live window, so nothing is ever pushed.
        assert!(source.contains("const ARMADRA_CONTEXT_EVENTS = [];"));
        // And the bus hook never returns a decision to opencode (§3.5).
        assert!(!source.contains("permissionDecision"));
        assert!(!source.contains("\"deny\""));
    }

    #[test]
    fn uninstall_removes_our_plugin_and_leaves_a_stranger_alone() {
        let home = tempdir().unwrap();
        install(home.path(), client()).unwrap();
        uninstall(home.path()).unwrap();
        assert!(!plugin_path(home.path()).exists());
        // Uninstalling again is a no-op, not an error.
        assert!(uninstall(home.path()).is_ok());

        // Someone else's file under the same name is not ours to delete.
        let path = plugin_path(home.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "export const Other = () => ({});\n").unwrap();
        uninstall(home.path()).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn other_plugins_survive_install_and_uninstall() {
        let home = tempdir().unwrap();
        let theirs = home.path().join("plugins").join("their-plugin.js");
        fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        fs::write(&theirs, "export const Theirs = () => ({});\n").unwrap();

        install(home.path(), client()).unwrap();
        assert_eq!(
            fs::read_to_string(&theirs).unwrap(),
            "export const Theirs = () => ({});\n"
        );

        uninstall(home.path()).unwrap();
        assert!(!plugin_path(home.path()).exists());
        assert!(theirs.exists());
    }

    #[test]
    fn a_windows_style_path_is_escaped_for_javascript() {
        let source = plugin_source(Path::new(r"C:\Program Files\armadra\armadra-hook.exe"));
        assert!(source.contains(r"C:\\Program Files\\armadra\\armadra-hook.exe"));
        // And the literal it lands in is still one well-formed string.
        assert_eq!(source.matches("const ARMADRA_CLIENT = \"").count(), 1);
    }
}
