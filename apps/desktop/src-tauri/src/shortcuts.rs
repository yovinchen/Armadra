//! 系统级全局热键（快捷键页的 `global` 作用域）。
//!
//! A global hotkey is the only kind of shortcut that fires while another
//! application is in front, which makes it the only kind that can take a
//! combination away from software this shell knows nothing about. Three rules
//! follow from that, and they are the whole of this module's design:
//!
//! 1. **Nothing is registered by default.** The command table ships both of
//!    these unbound; a hotkey only exists because somebody typed it into the
//!    settings page.
//! 2. **Only the ids in [`KNOWN_IDS`] can be bound.** The page hands over a
//!    list, and a list from a page is input — an id this build does not
//!    recognize is refused rather than registered against nothing.
//! 3. **A refusal is reported, not swallowed.** The operating system, or
//!    another application, may already hold a combination. Saying so is the
//!    only way a person can pick a different one; silently failing would leave
//!    them pressing a key that does nothing, with the settings page claiming it
//!    is bound.
//!
//! Applying a list always starts by unregistering everything this shell holds,
//! so the set of live hotkeys is exactly the last list that was applied — there
//! is no incremental state to drift out of sync with the settings document.

use std::{str::FromStr, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// The command ids this shell will register a system hotkey for.
pub const KNOWN_IDS: &[&str] = &["global.toggleWindow", "global.newTerminal"];

/// Emitted when a global hotkey fires and the page is the one that acts on it.
pub const TRIGGERED_EVENT: &str = "shortcut://triggered";

/// One requested hotkey, as the settings page sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    /// Tauri accelerator syntax (`CmdOrCtrl+Shift+K`). The page converts from
    /// the chord syntax the rest of the keymap uses.
    #[serde(default)]
    pub accelerator: String,
}

/// What became of one requested hotkey.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingState {
    /// Registered with the operating system; it will fire.
    Bound,
    /// No accelerator was asked for. The ordinary case.
    Unbound,
    /// This build does not know the id, or the accelerator did not parse.
    Invalid,
    /// The operating system refused it — something else already holds it.
    Taken,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingOutcome {
    pub id: String,
    pub state: BindingState,
}

/// The hotkeys this shell currently holds, so the next apply can release them.
#[derive(Default)]
pub struct GlobalShortcuts {
    held: Mutex<Vec<Shortcut>>,
}

/// Whether this build knows what to do with an id.
pub fn is_known_id(id: &str) -> bool {
    KNOWN_IDS.contains(&id)
}

/// The outcome of a request before the operating system is consulted.
///
/// Pulled out as a pure function because it is where the input from the page is
/// judged, and that judgement is worth a test that does not need a window.
pub fn precheck(binding: &Binding) -> Result<Shortcut, BindingState> {
    if !is_known_id(&binding.id) {
        return Err(BindingState::Invalid);
    }
    let accelerator = binding.accelerator.trim();
    if accelerator.is_empty() {
        return Err(BindingState::Unbound);
    }
    Shortcut::from_str(accelerator).map_err(|_| BindingState::Invalid)
}

/// Replaces every hotkey this shell holds with the requested list.
///
/// Returns one outcome per request, in the order they were given, so the
/// settings page can say which line is the one the system refused.
#[tauri::command]
pub fn global_shortcuts_apply(app: AppHandle, bindings: Vec<Binding>) -> Vec<BindingOutcome> {
    let manager = app.global_shortcut();
    let state = app.state::<GlobalShortcuts>();
    // 先全部释放：活着的热键集合就等于最后一次 apply 的那张表，中间没有
    // 一份会和设置文档慢慢对不上的增量状态。
    for shortcut in state
        .held
        .lock()
        .expect("global shortcut lock")
        .drain(..)
    {
        let _ = manager.unregister(shortcut);
    }

    let mut outcomes = Vec::with_capacity(bindings.len());
    let mut registered = Vec::new();
    for binding in bindings {
        let state = match precheck(&binding) {
            Err(state) => state,
            Ok(shortcut) => {
                let id = binding.id.clone();
                let handle = app.clone();
                match manager.on_shortcut(shortcut, move |app, _, event| {
                    // 只在按下时动作。松开也送一次会让「显示 / 隐藏」按一下
                    // 切换两回，看起来像没反应。
                    if event.state() == ShortcutState::Pressed {
                        perform(app, &id);
                    }
                    let _ = &handle;
                }) {
                    Ok(()) => {
                        registered.push(shortcut);
                        BindingState::Bound
                    }
                    // 注册失败几乎总是「被别人占了」：系统不区分原因，而这是
                    // 用户唯一能采取行动的解释。
                    Err(_) => BindingState::Taken,
                }
            }
        };
        outcomes.push(BindingOutcome {
            id: binding.id,
            state,
        });
    }
    *state.held.lock().expect("global shortcut lock") = registered;
    outcomes
}

/// What a hotkey does when it fires.
///
/// Showing and hiding the window is the shell's own business, so it happens
/// here. Anything that touches the canvas is the page's business and is handed
/// over as an event: the shell has no idea what a terminal node is, and giving
/// it one would be a second, divergent implementation of a canvas action.
fn perform(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match id {
        "global.toggleWindow" => {
            if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
                let _ = window.hide();
            } else {
                crate::lifecycle::reveal_window(&window);
            }
        }
        _ => {
            // 新建终端节点得先能看见画布。
            crate::lifecycle::reveal_window(&window);
            let _ = app.emit(TRIGGERED_EVENT, Triggered { id: id.to_owned() });
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Triggered {
    id: String,
}
