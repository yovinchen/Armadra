//! The controlled browser's first-round wire surface (B01): session, frame,
//! input, read, capture action, unsupported state and download.
//!
//! Split out of `contract.rs` as that file's own exemption note asks for, and
//! kept apart from `contract_browser_v2.rs` so the golden bytes of the first
//! round stay where they were minted.

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn check<M: Message + Default + PartialEq + std::fmt::Debug>(name: &str, expected: M) {
    let wire = fixture(name);
    assert_eq!(M::decode(wire.as_slice()).unwrap(), expected);
    assert_eq!(
        expected.encode_to_vec(),
        wire,
        "{name} differs across runtimes"
    );
}

#[test]
fn browser_surface() {
    check(
        "browser_session",
        BrowserSession {
            session_id: "browser-1".into(),
            generation: u64::MAX,
            workspace_id: "workspace-1".into(),
            node_id: "node-1".into(),
            url: "http://127.0.0.1:8080/表单".into(),
            title: "受控浏览器 😀".into(),
            viewport: Some(BrowserViewport {
                width: 1000,
                height: 700,
                device_scale_factor: 2.0,
            }),
            state: BrowserSessionState::Ready as i32,
            reason_code: String::new(),
            navigation_epoch: 9_007_199_254_740_993,
            headful: false,
            keep_alive: true,
            created_at_unix_ms: 1_788_557_000_000,
            updated_at_unix_ms: 1_788_557_900_000,
            ..Default::default()
        },
    );
    check(
        "browser_input",
        BrowserInputRequest {
            meta: None,
            session_id: "browser-1".into(),
            navigation_epoch: u64::MAX,
            frame_seq: 7,
            events: vec![
                BrowserInputEvent {
                    kind: BrowserInputKind::MousePressed as i32,
                    x: 12.5,
                    y: 40.0,
                    button: "left".into(),
                    click_count: 1,
                    modifiers: 15,
                    ..Default::default()
                },
                BrowserInputEvent {
                    kind: BrowserInputKind::Wheel as i32,
                    x: 500.0,
                    y: 550.0,
                    delta_y: 400.0,
                    ..Default::default()
                },
                BrowserInputEvent {
                    kind: BrowserInputKind::Text as i32,
                    text: "Hello 中文 😀".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        },
    );
    check(
        "browser_read",
        BrowserReadResponse {
            session_id: "browser-1".into(),
            navigation_epoch: 3,
            url: "http://127.0.0.1:8080/".into(),
            title: "Armadra 受控浏览器".into(),
            text: "正文 😀".into(),
            elements: vec![BrowserElement {
                element_ref: "e1".into(),
                role: "button".into(),
                name: "提交".into(),
                value: String::new(),
                selector: "#submit".into(),
                visible: true,
                x: 10.0,
                y: 20.0,
                width: 80.0,
                height: 32.0,
                ..Default::default()
            }],
            console: vec![BrowserConsoleEntry {
                at_unix_ms: 1_788_557_900_000,
                level: "error".into(),
                text: "boom".into(),
                url: "http://127.0.0.1:8080/".into(),
                line: 12,
            }],
            network: vec![BrowserNetworkEntry {
                at_unix_ms: 1_788_557_900_000,
                method: "GET".into(),
                url: "http://127.0.0.1:8080/a".into(),
                status: 404,
                mime_type: "text/html".into(),
                encoded_bytes: 9_007_199_254_740_993,
                failure_code: String::new(),
                from_cache: true,
            }],
            truncated: true,
        },
    );
    check(
        "browser_action_capture",
        BrowserAction {
            action: Some(browser_action::Action::Capture(BrowserCaptureRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-1".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                full_page: true,
                format: "png".into(),
                ..Default::default()
            })),
        },
    );
    // An enum value this build does not know survives the round trip instead of
    // collapsing to UNSPECIFIED.
    check(
        "browser_unsupported",
        BrowserSession {
            session_id: "browser-2".into(),
            state: 999,
            reason_code: "chrome_not_found".into(),
            ..Default::default()
        },
    );
    check(
        "browser_download",
        BrowserDownload {
            download_id: "d-1".into(),
            session_id: "browser-1".into(),
            url: "http://127.0.0.1:8080/报告.pdf".into(),
            suggested_filename: "报告.pdf".into(),
            state: BrowserDownloadState::Pending as i32,
            path: ".armadra/downloads/报告.pdf".into(),
            total_bytes: 9_007_199_254_740_993,
            received_bytes: 0,
            created_at_unix_ms: 1_788_557_000_000,
            reason_code: String::new(),
            ..Default::default()
        },
    );
}
