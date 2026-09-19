//! One line back, in the prose the reader is a model reading its own stdout.
//!
//! Three rules run through every line here, and they are the reason this is a
//! module and not a `format!` at each call site:
//!
//!   * **re-measured, not echoed.** A scroll reports the distance the page
//!     actually moved. A click reports the address afterwards. An answer that
//!     repeats the request cannot tell the reader the page ignored them.
//!   * **counts, not contents.** `type` says how many characters went in.
//!     `read --map` says whether a field is filled. Neither ever says what.
//!   * **no coordinates.** Where an element happens to sit is a fact about
//!     this window at this zoom, and repeating it invites an agent to aim at a
//!     number instead of at a ref.

use serde_json::Value;

fn text(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn number(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or_default()
}

fn titled(value: &Value) -> String {
    let title = text(value, "title");
    if title.is_empty() {
        "（未知）".to_owned()
    } else {
        title
    }
}

/// The answer for one verb.
pub fn render(verb: &str, args: &crate::collab::Args<'_>, result: &Value) -> String {
    match verb {
        "navigate" | "back" | "forward" => format!(
            "已导航。\n当前地址：{}\n标题：{}\n导航序号：{}\n",
            text(result, "url"),
            titled(result),
            number(result, "generation"),
        ),
        "read" => read(result),
        "click" => format!(
            "已点击{}。\n当前地址：{}\n导航序号：{}\n",
            described(result),
            text(result, "url"),
            number(result, "generation"),
        ),
        "type" => format!(
            "已输入 {} 个字符。\n当前地址：{}\n导航序号：{}\n",
            number(result, "chars"),
            text(result, "url"),
            number(result, "generation"),
        ),
        "press" => format!(
            "已按下 {} {} 次。\n",
            text(result, "key"),
            number(result, "times")
        ),
        "select" => format!(
            "已选中：{}\n",
            result
                .get("chosen")
                .and_then(Value::as_array)
                .map(|values| values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("、"))
                .unwrap_or_default()
        ),
        "scroll" => scroll(result),
        "wait" => {
            if result.get("matched").and_then(Value::as_bool) == Some(true) {
                format!("条件在 {} ms 内满足。\n", number(result, "waitedMs"))
            } else {
                format!(
                    "等待超时（{} ms），条件没有满足。页面没有被改动。\n",
                    number(result, "waitedMs")
                )
            }
        }
        "capture" => format!(
            "截图已保存到工作区：{}\n{}×{}，{} 字节，sha256 {}\n",
            text(result, "path"),
            number(result, "width"),
            number(result, "height"),
            number(result, "bytes"),
            text(result, "sha256"),
        ),
        "upload" => format!(
            "已{}：{}\n",
            if result.get("answeredChooser").and_then(Value::as_bool) == Some(true) {
                "回填页面打开的文件选择器"
            } else {
                "填入文件输入框"
            },
            joined(result, "paths"),
        ),
        "download" => download(args, result),
        "tabs" | "close" => tabs(result),
        "dialog" => format!(
            "已{}对话框（{}）：{}\n",
            if result.get("accepted").and_then(Value::as_bool) == Some(true) {
                "接受"
            } else {
                "取消"
            },
            text(result, "kind"),
            text(result, "message"),
        ),
        _ => format!("{result}\n"),
    }
}

fn described(result: &Value) -> String {
    let name = text(result, "name");
    let role = text(result, "role");
    if name.is_empty() && role.is_empty() {
        return String::new();
    }
    if name.is_empty() {
        return format!("（{role}）");
    }
    format!("（{role}「{name}」）")
}

fn joined(result: &Value, field: &str) -> String {
    result
        .get(field)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default()
}

fn read(result: &Value) -> String {
    match text(result, "mode").as_str() {
        "title" => format!("标题：{}\n地址：{}\n", titled(result), text(result, "url")),
        "links" => {
            let mut out = format!("地址：{}\n", text(result, "url"));
            for link in result
                .get("links")
                .and_then(Value::as_array)
                .unwrap_or(&Vec::new())
            {
                out.push_str(&format!(
                    "{} → {}\n",
                    text(link, "name"),
                    text(link, "href")
                ));
            }
            out
        }
        "map" => {
            let mut out = format!(
                "地址：{}\n标题：{}\n",
                text(result, "url"),
                titled(result)
            );
            for element in result
                .get("elements")
                .and_then(Value::as_array)
                .unwrap_or(&Vec::new())
            {
                // `detail` is "填没填", never what is in it — the filtering
                // that produced it happened inside the frozen reader, where no
                // caller can skip it.
                let detail = text(element, "detail");
                out.push_str(&format!(
                    "{} {} 「{}」{}\n",
                    text(element, "ref"),
                    text(element, "role"),
                    text(element, "name"),
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!("（{detail}）")
                    }
                ));
            }
            out
        }
        _ => {
            let body = text(result, "text");
            let truncated = result.get("truncated").and_then(Value::as_bool) == Some(true);
            format!(
                "地址：{}\n标题：{}\n\n{body}{}",
                text(result, "url"),
                titled(result),
                if truncated { "\n…（已截断）\n" } else { "\n" }
            )
        }
    }
}

fn scroll(result: &Value) -> String {
    // The MEASURED displacement. A page that refused to move says zero here,
    // which is the fact the caller needs; the requested amount is not.
    format!(
        "已滚动 {} px（当前 {}/{}）。\n",
        number(result, "moved"),
        number(result, "position"),
        number(result, "extent"),
    )
}

fn download(args: &crate::collab::Args<'_>, result: &Value) -> String {
    if let Some(queue) = result.get("downloads").and_then(Value::as_array) {
        if queue.is_empty() {
            return "下载队列是空的。\n".to_owned();
        }
        return queue
            .iter()
            .map(|entry| {
                format!(
                    "{}  {}  {} 字节  {}\n",
                    text(entry, "id"),
                    text(entry, "suggestedFilename"),
                    number(entry, "bytes"),
                    text(entry, "state"),
                )
            })
            .collect();
    }
    if args.flag("accept") {
        let sha = text(result, "sha256");
        return format!(
            "已保存到工作区：{}\nsha256 {}\n",
            text(result, "path"),
            if sha.is_empty() { "（未知）" } else { &sha }
        );
    }
    format!(
        "已丢弃暂存文件：{}\n",
        text(result, "suggestedFilename")
    )
}

fn tabs(result: &Value) -> String {
    let active = text(result, "activeTabId");
    let mut out = String::new();
    for tab in result
        .get("tabs")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let id = text(tab, "id");
        out.push_str(&format!(
            "{}{}  {}  {}\n",
            if id == active { "* " } else { "  " },
            id,
            text(tab, "title"),
            text(tab, "url"),
        ));
    }
    if out.is_empty() {
        return "这个浏览器节点现在没有标签。\n".to_owned();
    }
    out
}
