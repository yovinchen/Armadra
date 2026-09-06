//! Pairing and session identity (`identity.proto`): the bootstrap ticket's
//! scopes and the device revision an authenticated session carries.

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

#[test]
fn bootstrap_scope_and_authenticated_device_revision() {
    check(
        "identity_bootstrap",
        HostControlRequest {
            request_id: "pair-1".into(),
            action: Some(host_control_request::Action::Bootstrap(
                BootstrapTicketRequest {
                    expected_host_id: "host-1".into(),
                    expected_instance_id: "instance-1".into(),
                    origin: "https://armadra.example".into(),
                    device_name: "手机📱".into(),
                    scopes: vec![
                        AuthorizationGrant {
                            permission: "canvas:read".into(),
                            ..Default::default()
                        },
                        AuthorizationGrant {
                            permission: "terminal:write".into(),
                            workspace_id: "workspace-1".into(),
                            ..Default::default()
                        },
                    ],
                },
            )),
        },
    );
    check(
        "identity_session",
        AuthenticatedSession {
            host_id: "host-1".into(),
            device: Some(DeviceIdentity {
                device_id: "device-1".into(),
                principal_id: "owner-1".into(),
                display_name: "手机📱".into(),
                role: "owner".into(),
                created_at_unix_ms: 1788557000000,
                revoked_at_unix_ms: 0,
                revision: u64::MAX,
            }),
            csrf_token: "fixture-not-a-secret".into(),
            scopes: vec![AuthorizationGrant {
                permission: "canvas:read".into(),
                ..Default::default()
            }],
            expires_at_unix_ms: 1788557900000,
            native: None,
        },
    );
    // The desktop shell's native transport carries bearer credentials in the
    // body; a browser response leaves `native` unset.
    check(
        "identity_native_session",
        AuthenticatedSession {
            host_id: "host-1".into(),
            device: Some(DeviceIdentity {
                device_id: "device-2".into(),
                principal_id: "owner-1".into(),
                display_name: "本机桌面".into(),
                role: "owner".into(),
                created_at_unix_ms: 1788557000000,
                revoked_at_unix_ms: 0,
                revision: 1,
            }),
            csrf_token: "fixture-not-a-secret".into(),
            scopes: vec![AuthorizationGrant {
                permission: "identity:read".into(),
                ..Default::default()
            }],
            expires_at_unix_ms: 1788557900000,
            native: Some(NativeSessionCredentials {
                access_token: "fixture-access-not-a-secret".into(),
                refresh_token: "fixture-refresh-not-a-secret".into(),
            }),
        },
    );
}
