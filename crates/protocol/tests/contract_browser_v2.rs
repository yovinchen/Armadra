//! The second wave of the controlled-browser wire surface: managed binaries,
//! tabs and frames, the control lease, dialogs and choosers, the new verbs and
//! the dedicated frame stream (remote-and-browser-completion §2.11).
//!
//! The golden bytes come from the Go runtime; this file decodes them and
//! re-encodes its own values, so a field number that drifted in one language
//! fails here rather than at a device boundary.

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .chunks_exact(2)
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

fn target(tab: &str, frame: &str) -> Option<BrowserTarget> {
    Some(BrowserTarget {
        tab_id: tab.into(),
        frame_id: frame.into(),
    })
}

#[test]
fn a_session_carries_its_tabs_lease_dialog_and_chooser() {
    check(
        "browser_control_session",
        BrowserSession {
            session_id: "browser-1".into(),
            generation: 3,
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
            navigation_epoch: 0,
            headful: false,
            keep_alive: false,
            created_at_unix_ms: 1788557000000,
            updated_at_unix_ms: 1788557900000,
            active_tab_id: "t2".into(),
            tab_count: 3,
            lease: Some(BrowserLease {
                state: BrowserLeaseState::Agent as i32,
                generation: 7,
                expires_at_unix_ms: 1788557900000,
                holder: Some(browser_lease::Holder::Agent(BrowserLeaseAgent {
                    node_id: "node-2".into(),
                    session_id: "agent-1".into(),
                    display_name: "评审 Agent".into(),
                })),
            }),
            pending_dialog: Some(BrowserDialog {
                dialog_id: "d-1".into(),
                tab_id: "t2".into(),
                kind: BrowserDialogKind::Prompt as i32,
                message: "确认提交？".into(),
                default_prompt: "默认".into(),
                url: "http://127.0.0.1:8080/表单".into(),
                opened_at_unix_ms: 1788557900000,
            }),
            pending_file_chooser: Some(BrowserFileChooser {
                chooser_id: "c-1".into(),
                tab_id: "t2".into(),
                frame_id: "f3".into(),
                multiple: true,
                accept: ".png,.jpg".into(),
                opened_at_unix_ms: 1788557900001,
            }),
            // Stored, so a client's generation cannot come back to life after
            // a restart even though the lease itself starts free.
            lease_generation: u64::MAX,
        },
    );
}

#[test]
fn a_managed_binary_reports_progress_and_refuses_honestly() {
    check(
        "browser_managed_unsupported",
        BrowserManagedState {
            state: BrowserManagedInstallState::Failed as i32,
            version: "131.0.6778.85".into(),
            reason_code: "manifest_missing_target".into(),
            // No entry for this OS/arch: the panel says so rather than
            // offering a button that cannot work (§2.1).
            supported: false,
            ..Default::default()
        },
    );
    check(
        "browser_managed_progress",
        BrowserManagedState {
            state: BrowserManagedInstallState::Downloading as i32,
            version: "131.0.6778.85".into(),
            received_bytes: 9007199254740993,
            total_bytes: u64::MAX,
            supported: true,
            ..Default::default()
        },
    );
    check(
        "browser_availability_managed",
        BrowserAvailability {
            available: true,
            executable:
                "/data/browser-managed/131.0.6778.85-macos-arm64/Chrome.app/Contents/MacOS/Chrome"
                    .into(),
            source: "managed".into(),
            reason_code: String::new(),
            searched: vec![
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
            ],
            managed: Some(BrowserManagedState {
                state: BrowserManagedInstallState::Installed as i32,
                version: "131.0.6778.85".into(),
                total_bytes: 172_000_000,
                supported: true,
                executable:
                    "/data/browser-managed/131.0.6778.85-macos-arm64/Chrome.app/Contents/MacOS/Chrome"
                        .into(),
                ..Default::default()
            }),
        },
    );
    check(
        "browser_result_managed",
        BrowserActionResult {
            request_id: "请求-managed".into(),
            result: Some(browser_action_result::Result::Managed(
                BrowserManagedState {
                    state: BrowserManagedInstallState::Failed as i32,
                    version: "131.0.6778.85".into(),
                    reason_code: "sha256_mismatch".into(),
                    supported: true,
                    ..Default::default()
                },
            )),
        },
    );
}

#[test]
fn tabs_and_frame_bound_references_survive_the_wire() {
    check(
        "browser_tab_list",
        BrowserTabList {
            tabs: vec![
                BrowserTab {
                    tab_id: "t1".into(),
                    url: "http://127.0.0.1:8080/".into(),
                    title: "首页".into(),
                    navigation_epoch: 4,
                    ..Default::default()
                },
                BrowserTab {
                    tab_id: "t2".into(),
                    url: "http://127.0.0.1:8081/弹窗".into(),
                    title: "弹窗 😀".into(),
                    active: true,
                    opener_tab_id: "t1".into(),
                    navigation_epoch: u64::MAX,
                    loading: true,
                    pending_dialog: Some(BrowserDialog {
                        dialog_id: "d-2".into(),
                        tab_id: "t2".into(),
                        kind: BrowserDialogKind::BeforeUnload as i32,
                        message: "离开此页？".into(),
                        ..Default::default()
                    }),
                },
            ],
            active_tab_id: "t2".into(),
            limit: 16,
        },
    );
    check(
        "browser_element_frame",
        BrowserElement {
            element_ref: "e4-12@t2/f3".into(),
            role: "textbox".into(),
            name: "邮箱".into(),
            value: "a@b.c".into(),
            selector: "#email".into(),
            visible: true,
            x: 10.0,
            y: 20.0,
            width: 200.0,
            height: 32.0,
            tab_id: "t2".into(),
            frame_id: "f3".into(),
        },
    );
    check(
        "browser_download_hashed",
        BrowserDownload {
            download_id: "d-1".into(),
            session_id: "browser-1".into(),
            url: "http://127.0.0.1:8080/报告.pdf".into(),
            suggested_filename: "报告.pdf".into(),
            state: BrowserDownloadState::Completed as i32,
            path: ".armadra/downloads/报告.pdf".into(),
            total_bytes: 4096,
            received_bytes: 4096,
            created_at_unix_ms: 1788557000000,
            reason_code: String::new(),
            tab_id: "t2".into(),
            sha256: vec![
                0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0,
                0xd0, 0xe0, 0xf0, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
                0x0c, 0x0d, 0x0e, 0x0f,
            ],
        },
    );
}

#[test]
fn a_lease_names_its_holder_and_keeps_an_unknown_state_unknown() {
    check(
        "browser_lease_takeover",
        BrowserLease {
            state: BrowserLeaseState::HumanTakeover as i32,
            generation: 9007199254740993,
            expires_at_unix_ms: 0,
            holder: Some(browser_lease::Holder::Human(BrowserLeaseHuman {
                device_id: "device-1".into(),
                display_name: "手机📱".into(),
            })),
        },
    );
    check(
        "browser_lease_free",
        BrowserLease {
            state: BrowserLeaseState::Free as i32,
            generation: 1,
            ..Default::default()
        },
    );
    // An unknown holder state must stay unknown: showing "free" would invite a
    // client to grab a lease somebody else is holding (§2.6).
    let decoded = BrowserLease::decode(fixture("browser_lease_unknown").as_slice()).unwrap();
    assert_eq!(decoded.state, 999);
    assert!(BrowserLeaseState::try_from(decoded.state).is_err());
}

#[test]
fn every_new_verb_carries_its_target_and_lease_generation() {
    check(
        "browser_action_select",
        BrowserAction {
            action: Some(browser_action::Action::Select(BrowserSelectRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-select".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                navigation_epoch: 4,
                element_ref: "e4-2".into(),
                values: vec!["cn".into(), "jp".into()],
                labels: vec!["中国".into(), "日本".into()],
                target: target("t2", "f3"),
                lease_generation: 7,
                ..Default::default()
            })),
        },
    );
    check(
        "browser_action_press",
        BrowserAction {
            action: Some(browser_action::Action::Press(BrowserPressRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-press".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                navigation_epoch: 4,
                key: "Enter".into(),
                modifiers: 15,
                repeat: 2,
                lease_generation: 7,
                ..Default::default()
            })),
        },
    );
    check(
        "browser_action_scroll",
        BrowserAction {
            action: Some(browser_action::Action::Scroll(BrowserScrollRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-scroll".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                navigation_epoch: 4,
                direction: "down".into(),
                amount: 480.5,
                lease_generation: 7,
                ..Default::default()
            })),
        },
    );
    check(
        "browser_action_upload",
        BrowserAction {
            action: Some(browser_action::Action::Upload(BrowserUploadRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-upload".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                chooser_id: "c-1".into(),
                paths: vec!["docs/报告.pdf".into(), "assets/图.png".into()],
                target: target("t2", ""),
                lease_generation: 7,
                ..Default::default()
            })),
        },
    );
    check(
        "browser_action_dialog",
        BrowserAction {
            action: Some(browser_action::Action::Dialog(BrowserDialogRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-dialog".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                tab_id: "t2".into(),
                dialog_id: "d-1".into(),
                accept: true,
                prompt_text: "确认 😀".into(),
                lease_generation: 7,
            })),
        },
    );
    check(
        "browser_action_tabs",
        BrowserAction {
            action: Some(browser_action::Action::Tabs(BrowserTabRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-tabs".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                action: BrowserTabAction::New as i32,
                url: "http://127.0.0.1:8081/".into(),
                ..Default::default()
            })),
        },
    );
    check(
        "browser_action_lease",
        BrowserAction {
            action: Some(browser_action::Action::Lease(BrowserLeaseRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-lease".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                action: BrowserLeaseAction::Takeover as i32,
                lease_generation: 7,
                // The device id is what a badge names as the human holder;
                // it is not an authenticated identity and grants nothing.
                device_id: "设备-1".into(),
                display_name: "iPhone".into(),
            })),
        },
    );
    check(
        "browser_action_close_tab",
        BrowserAction {
            action: Some(browser_action::Action::CloseTab(BrowserCloseTabRequest {
                meta: Some(CommandMeta {
                    request_id: "请求-close-tab".into(),
                    ..Default::default()
                }),
                session_id: "browser-1".into(),
                tab_id: "t2".into(),
                lease_generation: 7,
            })),
        },
    );
    check(
        "browser_action_managed_install",
        BrowserAction {
            action: Some(browser_action::Action::ManagedInstall(
                BrowserManagedInstallRequest {
                    meta: Some(CommandMeta {
                        request_id: "请求-managed".into(),
                        ..Default::default()
                    }),
                    install: true,
                },
            )),
        },
    );
    check(
        "browser_result_tabs",
        BrowserActionResult {
            request_id: "请求-tabs".into(),
            result: Some(browser_action_result::Result::Tabs(BrowserTabList {
                tabs: vec![BrowserTab {
                    tab_id: "t1".into(),
                    url: "http://127.0.0.1:8080/".into(),
                    active: true,
                    ..Default::default()
                }],
                active_tab_id: "t1".into(),
                limit: 16,
            })),
        },
    );
}

#[test]
fn the_dedicated_stream_carries_raw_frames_and_a_closed_uplink() {
    check(
        "browser_stream_frame",
        BrowserStreamFrame {
            session_id: "browser-1".into(),
            generation: 3,
            frame_seq: 9007199254740993,
            navigation_epoch: u64::MAX,
            tab_id: "t2".into(),
            viewport_width: 1280,
            viewport_height: 800,
            device_scale_factor: 1.5,
            encoding: "jpeg".into(),
            data: vec![0xff, 0xd8, 0x00, 0xff],
            captured_at_unix_ms: 1788557900000,
        },
    );
    check(
        "browser_stream_hello",
        BrowserStreamClient {
            message: Some(browser_stream_client::Message::Hello(
                BrowserSubscribeRequest {
                    session_id: "browser-1".into(),
                    subscription_id: "sub-1".into(),
                    visibility: BrowserVisibility::Focused as i32,
                    bandwidth_class: BrowserBandwidthClass::Metered as i32,
                    max_width: 960,
                    ..Default::default()
                },
            )),
        },
    );
    // An acknowledgement is a bare number, so keeping the picture flowing
    // costs one varint rather than a message.
    check(
        "browser_stream_ack",
        BrowserStreamClient {
            message: Some(browser_stream_client::Message::Ack(u64::MAX)),
        },
    );
    check(
        "browser_stream_input",
        BrowserStreamClient {
            message: Some(browser_stream_client::Message::Input(BrowserInputRequest {
                session_id: "browser-1".into(),
                navigation_epoch: 4,
                frame_seq: 7,
                events: vec![BrowserInputEvent {
                    kind: BrowserInputKind::TouchStart as i32,
                    x: 100.0,
                    y: 200.0,
                    ..Default::default()
                }],
                target: target("t2", ""),
                lease_generation: 7,
                ..Default::default()
            })),
        },
    );
    // The receipt reports the budget that was actually applied, so a phone
    // shows the degradation instead of guessing it did not happen (§2.9).
    check(
        "browser_subscription_degraded",
        BrowserSubscription {
            subscription_id: "sub-1".into(),
            expires_at_unix_ms: 1788557900000,
            quality: 45,
            max_fps: 4,
            max_width: 960,
        },
    );
    check(
        "browser_activity_refused",
        BrowserActivity {
            session_id: "browser-1".into(),
            actor: "agent".into(),
            actor_id: "node-2".into(),
            verb: "click".into(),
            target: "e4-12@t2/f3".into(),
            outcome: "refused".into(),
            reason_code: "LEASE_REVOKED".into(),
            at_unix_ms: 1788557900000,
        },
    );
}
