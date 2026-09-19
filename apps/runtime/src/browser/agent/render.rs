//! The prose an agent verb answers with.
//!
//! Replies are `text/plain` because the reader is a model reading its own
//! stdout, exactly like the context-link surface. Kept apart from the dispatch
//! so the wording can change without touching the authorization.
//!
//! Only the lease is rendered here. Every other verb is answered by the shell
//! and its prose lives in [`super::super::shell::render`]: the line reports
//! what the page actually did, which is something only the side that measured
//! it can say.

use crate::browser::{Lease, LeaseState};

/// Who is driving, in one line. An agent that has just been refused reads this
/// to say *why* instead of retrying (§2.6).
pub fn render_lease(lease: &Lease) -> String {
    let who = match (lease.state, lease.holder.as_ref()) {
        (LeaseState::Free, _) => "没有人在操作".to_owned(),
        (_, None) => "有人在操作".to_owned(),
        (state, Some(holder)) => {
            let name = if holder.display_name.is_empty() {
                holder.id.as_str()
            } else {
                holder.display_name.as_str()
            };
            match state {
                LeaseState::HumanTakeover => format!("人已接管：{name}"),
                LeaseState::Human => format!("人正在操作：{name}"),
                _ => format!("Agent 正在操作：{name}"),
            }
        }
    };
    let until = if lease.expires_at.is_empty() {
        "，不会自动释放".to_owned()
    } else {
        format!("，{} 前有效", lease.expires_at)
    };
    format!("{who}（世代 {}）{until}\n", lease.generation)
}
