package v1_test

import (
	"math"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// The second wave of the controlled-browser surface: managed binaries, tabs
// and frames, the control lease, dialogs and choosers, the new verbs and the
// dedicated frame stream (remote-and-browser-completion §2.11). Kept apart
// from browser_contract_test.go so the first round's golden bytes are not
// touched while this one grows.
func TestBrowserControlSurface(t *testing.T) {
	for name, message := range map[string]proto.Message{
		// A session that now knows about tabs, a lease and a blocked dialog.
		// The lease generation is stored, so it keeps climbing across a
		// Runtime restart even though the lease itself starts free (§2.6).
		"browser_control_session": &pb.BrowserSession{
			SessionId: "browser-1", Generation: 3, WorkspaceId: "workspace-1", NodeId: "node-1",
			Url: "http://127.0.0.1:8080/表单", Title: "受控浏览器 😀",
			Viewport:    &pb.BrowserViewport{Width: 1000, Height: 700, DeviceScaleFactor: 2},
			State:       pb.BrowserSessionState_BROWSER_SESSION_STATE_READY,
			ActiveTabId: "t2", TabCount: 3,
			Lease: &pb.BrowserLease{
				State: pb.BrowserLeaseState_BROWSER_LEASE_STATE_AGENT, Generation: 7,
				ExpiresAtUnixMs: 1788557900000,
				Holder:          &pb.BrowserLease_Agent{Agent: &pb.BrowserLeaseAgent{NodeId: "node-2", SessionId: "agent-1", DisplayName: "评审 Agent"}},
			},
			PendingDialog: &pb.BrowserDialog{
				DialogId: "d-1", TabId: "t2", Kind: pb.BrowserDialogKind_BROWSER_DIALOG_KIND_PROMPT,
				Message: "确认提交？", DefaultPrompt: "默认", Url: "http://127.0.0.1:8080/表单",
				OpenedAtUnixMs: 1788557900000,
			},
			PendingFileChooser: &pb.BrowserFileChooser{ChooserId: "c-1", TabId: "t2", FrameId: "f3", Multiple: true, Accept: ".png,.jpg", OpenedAtUnixMs: 1788557900001},
			LeaseGeneration:    math.MaxUint64,
			CreatedAtUnixMs:    1788557000000, UpdatedAtUnixMs: 1788557900000,
		},
		// No manifest entry for this OS/arch: `supported` is false and the
		// panel says so rather than offering a button that cannot work.
		"browser_managed_unsupported": &pb.BrowserManagedState{
			State:   pb.BrowserManagedInstallState_BROWSER_MANAGED_INSTALL_STATE_FAILED,
			Version: "131.0.6778.85", ReasonCode: "manifest_missing_target", Supported: false,
		},
		"browser_managed_progress": &pb.BrowserManagedState{
			State:   pb.BrowserManagedInstallState_BROWSER_MANAGED_INSTALL_STATE_DOWNLOADING,
			Version: "131.0.6778.85", ReceivedBytes: 9007199254740993, TotalBytes: math.MaxUint64,
			Executable: "", Supported: true,
		},
		"browser_availability_managed": &pb.BrowserAvailability{
			Available: true, Executable: "/data/browser-managed/131.0.6778.85-macos-arm64/Chrome.app/Contents/MacOS/Chrome",
			Source: "managed", Searched: []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"},
			Managed: &pb.BrowserManagedState{
				State:   pb.BrowserManagedInstallState_BROWSER_MANAGED_INSTALL_STATE_INSTALLED,
				Version: "131.0.6778.85", TotalBytes: 172000000, Supported: true,
				Executable: "/data/browser-managed/131.0.6778.85-macos-arm64/Chrome.app/Contents/MacOS/Chrome",
			},
		},
		"browser_tab_list": &pb.BrowserTabList{
			Tabs: []*pb.BrowserTab{
				{TabId: "t1", Url: "http://127.0.0.1:8080/", Title: "首页", Active: false, NavigationEpoch: 4},
				{TabId: "t2", Url: "http://127.0.0.1:8081/弹窗", Title: "弹窗 😀", Active: true, OpenerTabId: "t1", NavigationEpoch: math.MaxUint64, Loading: true,
					PendingDialog: &pb.BrowserDialog{DialogId: "d-2", TabId: "t2", Kind: pb.BrowserDialogKind_BROWSER_DIALOG_KIND_BEFORE_UNLOAD, Message: "离开此页？"}},
			},
			ActiveTabId: "t2", Limit: 16,
		},
		// A human takeover: the holder is a device, and the generation is
		// what a revoked agent's next request will fail against.
		"browser_lease_takeover": &pb.BrowserLease{
			State: pb.BrowserLeaseState_BROWSER_LEASE_STATE_HUMAN_TAKEOVER, Generation: 9007199254740993,
			ExpiresAtUnixMs: 0,
			Holder:          &pb.BrowserLease_Human{Human: &pb.BrowserLeaseHuman{DeviceId: "device-1", DisplayName: "手机📱"}},
		},
		"browser_lease_free": &pb.BrowserLease{State: pb.BrowserLeaseState_BROWSER_LEASE_STATE_FREE, Generation: 1},
		"browser_element_frame": &pb.BrowserElement{
			ElementRef: "e4-12@t2/f3", Role: "textbox", Name: "邮箱", Value: "a@b.c", Selector: "#email",
			Visible: true, X: 10, Y: 20, Width: 200, Height: 32, TabId: "t2", FrameId: "f3",
		},
		"browser_download_hashed": &pb.BrowserDownload{
			DownloadId: "d-1", SessionId: "browser-1", Url: "http://127.0.0.1:8080/报告.pdf",
			SuggestedFilename: "报告.pdf", State: pb.BrowserDownloadState_BROWSER_DOWNLOAD_STATE_COMPLETED,
			Path: ".armadra/downloads/报告.pdf", TotalBytes: 4096, ReceivedBytes: 4096,
			CreatedAtUnixMs: 1788557000000, TabId: "t2",
			Sha256: []byte{0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f},
		},
		// Every new verb, each carrying the target and the lease generation
		// its refusal is checked against.
		"browser_action_select": &pb.BrowserAction{Action: &pb.BrowserAction_Select{Select: &pb.BrowserSelectRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-select"}, SessionId: "browser-1", NavigationEpoch: 4,
			ElementRef: "e4-2", Values: []string{"cn", "jp"}, Labels: []string{"中国", "日本"},
			Target: &pb.BrowserTarget{TabId: "t2", FrameId: "f3"}, LeaseGeneration: 7,
		}}},
		"browser_action_press": &pb.BrowserAction{Action: &pb.BrowserAction_Press{Press: &pb.BrowserPressRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-press"}, SessionId: "browser-1", NavigationEpoch: 4,
			Key: "Enter", Modifiers: 15, Repeat: 2, LeaseGeneration: 7,
		}}},
		"browser_action_scroll": &pb.BrowserAction{Action: &pb.BrowserAction_Scroll{Scroll: &pb.BrowserScrollRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-scroll"}, SessionId: "browser-1", NavigationEpoch: 4,
			Direction: "down", Amount: 480.5, LeaseGeneration: 7,
		}}},
		"browser_action_upload": &pb.BrowserAction{Action: &pb.BrowserAction_Upload{Upload: &pb.BrowserUploadRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-upload"}, SessionId: "browser-1", ChooserId: "c-1",
			Paths: []string{"docs/报告.pdf", "assets/图.png"}, Target: &pb.BrowserTarget{TabId: "t2"}, LeaseGeneration: 7,
		}}},
		"browser_action_dialog": &pb.BrowserAction{Action: &pb.BrowserAction_Dialog{Dialog: &pb.BrowserDialogRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-dialog"}, SessionId: "browser-1", TabId: "t2",
			DialogId: "d-1", Accept: true, PromptText: "确认 😀", LeaseGeneration: 7,
		}}},
		"browser_action_tabs": &pb.BrowserAction{Action: &pb.BrowserAction_Tabs{Tabs: &pb.BrowserTabRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-tabs"}, SessionId: "browser-1",
			Action: pb.BrowserTabAction_BROWSER_TAB_ACTION_NEW, Url: "http://127.0.0.1:8081/",
		}}},
		"browser_action_lease": &pb.BrowserAction{Action: &pb.BrowserAction_Lease{Lease: &pb.BrowserLeaseRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-lease"}, SessionId: "browser-1",
			Action: pb.BrowserLeaseAction_BROWSER_LEASE_ACTION_TAKEOVER, LeaseGeneration: 7,
			DeviceId: "设备-1", DisplayName: "iPhone",
		}}},
		"browser_action_close_tab": &pb.BrowserAction{Action: &pb.BrowserAction_CloseTab{CloseTab: &pb.BrowserCloseTabRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-close-tab"}, SessionId: "browser-1", TabId: "t2", LeaseGeneration: 7,
		}}},
		"browser_action_managed_install": &pb.BrowserAction{Action: &pb.BrowserAction_ManagedInstall{ManagedInstall: &pb.BrowserManagedInstallRequest{
			Meta: &pb.CommandMeta{RequestId: "请求-managed"}, Install: true,
		}}},
		"browser_result_tabs": &pb.BrowserActionResult{RequestId: "请求-tabs", Result: &pb.BrowserActionResult_Tabs{Tabs: &pb.BrowserTabList{
			Tabs: []*pb.BrowserTab{{TabId: "t1", Url: "http://127.0.0.1:8080/", Active: true}}, ActiveTabId: "t1", Limit: 16,
		}}},
		"browser_result_managed": &pb.BrowserActionResult{RequestId: "请求-managed", Result: &pb.BrowserActionResult_Managed{Managed: &pb.BrowserManagedState{
			State: pb.BrowserManagedInstallState_BROWSER_MANAGED_INSTALL_STATE_FAILED, Version: "131.0.6778.85", ReasonCode: "sha256_mismatch", Supported: true,
		}}},
		// The dedicated stream: raw bytes down, and a closed set of messages
		// up. `ack` is a bare number so a frame acknowledgement costs nothing.
		"browser_stream_frame": &pb.BrowserStreamFrame{
			SessionId: "browser-1", Generation: 3, FrameSeq: 9007199254740993, NavigationEpoch: math.MaxUint64,
			TabId: "t2", ViewportWidth: 1280, ViewportHeight: 800, DeviceScaleFactor: 1.5,
			Encoding: "jpeg", Data: []byte{0xff, 0xd8, 0x00, 0xff}, CapturedAtUnixMs: 1788557900000,
		},
		"browser_stream_hello": &pb.BrowserStreamClient{Message: &pb.BrowserStreamClient_Hello{Hello: &pb.BrowserSubscribeRequest{
			SessionId: "browser-1", SubscriptionId: "sub-1", Visibility: pb.BrowserVisibility_BROWSER_VISIBILITY_FOCUSED,
			BandwidthClass: pb.BrowserBandwidthClass_BROWSER_BANDWIDTH_CLASS_METERED, MaxWidth: 960,
		}}},
		"browser_stream_ack": &pb.BrowserStreamClient{Message: &pb.BrowserStreamClient_Ack{Ack: math.MaxUint64}},
		"browser_stream_input": &pb.BrowserStreamClient{Message: &pb.BrowserStreamClient_Input{Input: &pb.BrowserInputRequest{
			SessionId: "browser-1", NavigationEpoch: 4, FrameSeq: 7,
			Events:          []*pb.BrowserInputEvent{{Kind: pb.BrowserInputKind_BROWSER_INPUT_KIND_TOUCH_START, X: 100, Y: 200}},
			Target:          &pb.BrowserTarget{TabId: "t2"},
			LeaseGeneration: 7,
		}}},
		"browser_subscription_degraded": &pb.BrowserSubscription{
			SubscriptionId: "sub-1", ExpiresAtUnixMs: 1788557900000, Quality: 45, MaxFps: 4, MaxWidth: 960,
		},
		"browser_activity_refused": &pb.BrowserActivity{
			SessionId: "browser-1", Actor: "agent", ActorId: "node-2", Verb: "click", Target: "e4-12@t2/f3",
			Outcome: "refused", ReasonCode: "LEASE_REVOKED", AtUnixMs: 1788557900000,
		},
	} {
		wire, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		encoded := fixture(t, name, wire)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(encoded, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatalf("%s contract changed", name)
		}
	}
}

// An unknown lease state and an unknown managed state have to survive a round
// trip: an older client must show "someone else is driving" rather than
// silently reading it as free (§2.6).
func TestBrowserControlUnknownEnums(t *testing.T) {
	lease := &pb.BrowserLease{State: pb.BrowserLeaseState(999), Generation: 2}
	wire, err := proto.Marshal(lease)
	if err != nil {
		t.Fatal(err)
	}
	encoded := fixture(t, "browser_lease_unknown", wire)
	decoded := &pb.BrowserLease{}
	if err = proto.Unmarshal(encoded, decoded); err != nil || decoded.State != pb.BrowserLeaseState(999) {
		t.Fatal("an unknown lease state must not decode as free")
	}
}
