//! The prose an agent verb answers with.
//!
//! Replies are `text/plain` because the reader is a model reading its own
//! stdout, exactly like the context-link surface. Kept apart from the dispatch
//! so the wording can change without touching the authorization.

use crate::browser::{
    Download, DownloadState, Lease, LeaseState, ReadMode, ReadResponse, Tab, TabList,
};

pub fn render_read(mode: ReadMode, response: &ReadResponse) -> String {
    let mut out = format!(
        "{}\n{}\n\n",
        if response.title.is_empty() {
            "（无标题）"
        } else {
            &response.title
        },
        response.url
    );
    match mode {
        ReadMode::Title => {}
        ReadMode::Text => out.push_str(&response.text),
        ReadMode::Elements | ReadMode::Links => {
            for element in &response.elements {
                let reference = if element.element_ref.is_empty() {
                    String::new()
                } else {
                    format!("[{}] ", element.element_ref)
                };
                out.push_str(&format!(
                    "{reference}{} {}{}\n",
                    element.role,
                    element.name,
                    if element.value.is_empty() {
                        String::new()
                    } else {
                        format!("  ({})", element.value)
                    }
                ));
            }
            if response.elements.is_empty() {
                out.push_str("（这一页没有可操作的元素）\n");
            }
        }
        ReadMode::Console => {
            for entry in &response.console {
                out.push_str(&format!("{} {} {}\n", entry.at, entry.level, entry.text));
            }
            if response.console.is_empty() {
                out.push_str("（没有 console 记录）\n");
            }
        }
        ReadMode::Network => {
            for entry in &response.network {
                out.push_str(&format!(
                    "{} {} {} {}{}\n",
                    entry.method,
                    entry.status,
                    entry.url,
                    entry.mime_type,
                    if entry.failure_code.is_empty() {
                        String::new()
                    } else {
                        format!("  失败：{}", entry.failure_code)
                    }
                ));
            }
            if response.network.is_empty() {
                out.push_str("（没有网络记录）\n");
            }
        }
    }
    if response.truncated {
        out.push_str("\n（内容已按上限截断）\n");
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// A short line for the downloads queue, used by the CLI's `read` of a session
/// that has one pending. Kept here so the wording lives with the other prose.
pub fn describe_download(download: &Download) -> String {
    let state = match download.state {
        DownloadState::Pending => "待确认",
        DownloadState::InProgress => "下载中",
        DownloadState::Completed => "已保存",
        DownloadState::Cancelled => "已取消",
        DownloadState::Failed => "失败",
    };
    format!(
        "{state} [{}] {} {}\n",
        download.download_id, download.suggested_filename, download.url
    )
}

/// The tab strip as a model reads it: the active tab is marked, a popup names
/// the tab that opened it, and a tab holding a dialog says so — that is the
/// one whose actions are coming back as `DIALOG_PENDING`.
pub fn render_tabs(list: &TabList) -> String {
    let mut out = String::new();
    for tab in &list.tabs {
        out.push_str(&describe_tab(tab));
    }
    if list.tabs.is_empty() {
        out.push_str("（这个会话还没有标签）\n");
    }
    out.push_str(&format!(
        "共 {} 个标签，上限 {}。\n",
        list.tabs.len(),
        list.limit
    ));
    out
}

fn describe_tab(tab: &Tab) -> String {
    let mut line = format!(
        "{}[{}] {}  {}",
        if tab.active { "* " } else { "  " },
        tab.tab_id,
        if tab.title.is_empty() {
            "（无标题）"
        } else {
            &tab.title
        },
        tab.url
    );
    if !tab.opener_tab_id.is_empty() {
        line.push_str(&format!("  ← {}", tab.opener_tab_id));
    }
    if let Some(dialog) = &tab.pending_dialog {
        line.push_str(&format!("  ⧗ {}：{}", dialog.kind.as_str(), dialog.message));
    }
    line.push('\n');
    line
}

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
