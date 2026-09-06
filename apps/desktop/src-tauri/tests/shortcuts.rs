//! 全局热键请求的判定（`src/shortcuts.rs`）。
//!
//! 真正的注册要问操作系统，测不了；能测的是它之前那一步——一份从页面来的
//! 列表里，哪些请求根本不该走到操作系统面前。

use armadra_desktop::shortcuts::{Binding, BindingState, KNOWN_IDS, is_known_id, precheck};

fn binding(id: &str, accelerator: &str) -> Binding {
    Binding {
        id: id.to_owned(),
        accelerator: accelerator.to_owned(),
    }
}

#[test]
fn only_the_two_documented_ids_can_take_a_system_hotkey() {
    assert_eq!(KNOWN_IDS.len(), 2);
    for id in KNOWN_IDS {
        assert!(is_known_id(id));
        assert!(precheck(&binding(id, "CmdOrCtrl+Shift+K")).is_ok());
    }
    // 一份从页面来的列表是输入。别的命令 id 出现在里面时拒绝，而不是把一个
    // 全局热键注册到「按了什么也不会发生」上。
    for unknown in ["canvas.newTerminal", "global.somethingElse", "", "global."] {
        assert!(!is_known_id(unknown), "{unknown}");
        assert_eq!(
            precheck(&binding(unknown, "CmdOrCtrl+Shift+K")),
            Err(BindingState::Invalid),
            "{unknown}",
        );
    }
}

#[test]
fn no_accelerator_is_not_an_error() {
    // 这是常态：两条命令默认都不绑，设置页照样把它们发过来。
    for empty in ["", "   "] {
        assert_eq!(
            precheck(&binding("global.toggleWindow", empty)),
            Err(BindingState::Unbound),
        );
    }
}

#[test]
fn an_accelerator_that_does_not_parse_is_refused_here() {
    for broken in [
        "Nonsense",
        "CmdOrCtrl+",
        "+K",
        "CmdOrCtrl Shift K",
        "Mod+K", // 键位表的写法，不是 Tauri 的；页面负责转换
    ] {
        assert_eq!(
            precheck(&binding("global.toggleWindow", broken)),
            Err(BindingState::Invalid),
            "{broken}",
        );
    }
}

#[test]
fn the_accelerators_the_page_produces_all_parse() {
    // `apps/web/src/keybindings/accelerator.ts` 的输出样本。两边的对应关系
    // 只有在这里被断言过，改一边才不会静默地让热键装不上。
    for accelerator in [
        "CmdOrCtrl+Shift+K",
        "CmdOrCtrl+Alt+T",
        "Shift+Alt+F1",
        "Control+Shift+Space",
        "Super+Comma",
        "CmdOrCtrl+ArrowUp",
        "F12",
    ] {
        assert!(
            precheck(&binding("global.newTerminal", accelerator)).is_ok(),
            "{accelerator}",
        );
    }
}

#[test]
fn an_outcome_serializes_as_the_page_reads_it() {
    for (state, tag) in [
        (BindingState::Bound, "bound"),
        (BindingState::Unbound, "unbound"),
        (BindingState::Invalid, "invalid"),
        (BindingState::Taken, "taken"),
    ] {
        assert_eq!(
            serde_json::to_string(&state).expect("serialize"),
            format!("\"{tag}\"")
        );
    }
}
