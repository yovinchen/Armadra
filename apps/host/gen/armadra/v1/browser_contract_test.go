package v1_test

import (
	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
	"math"
	"testing"
)

func TestBrowserWireSurfaceAndUnknownState(t *testing.T) {
	for name, message := range map[string]proto.Message{
		"browser_session":        &pb.BrowserSession{SessionId: "browser-1", Generation: math.MaxUint64, WorkspaceId: "workspace-1", NodeId: "node-1", Url: "http://127.0.0.1:8080/表单", Title: "受控浏览器 😀", Viewport: &pb.BrowserViewport{Width: 1000, Height: 700, DeviceScaleFactor: 2}, State: pb.BrowserSessionState_BROWSER_SESSION_STATE_READY, ReasonCode: "", NavigationEpoch: 9007199254740993, Headful: false, KeepAlive: true, CreatedAtUnixMs: 1788557000000, UpdatedAtUnixMs: 1788557900000},
		"browser_frame":          &pb.BrowserFrame{SessionId: "browser-1", Generation: 2, FrameSeq: 9007199254740993, NavigationEpoch: math.MaxUint64, ViewportWidth: 1000, ViewportHeight: 700, DeviceScaleFactor: 1.5, Encoding: "jpeg", Data: []byte{0, 255, 0xd8, 0xff}, CapturedAtUnixMs: 1788557900000},
		"browser_input":          &pb.BrowserInputRequest{SessionId: "browser-1", NavigationEpoch: math.MaxUint64, FrameSeq: 7, Events: []*pb.BrowserInputEvent{{Kind: pb.BrowserInputKind_BROWSER_INPUT_KIND_MOUSE_PRESSED, X: 12.5, Y: 40, Button: "left", ClickCount: 1, Modifiers: 15}, {Kind: pb.BrowserInputKind_BROWSER_INPUT_KIND_WHEEL, X: 500, Y: 550, DeltaY: 400}, {Kind: pb.BrowserInputKind_BROWSER_INPUT_KIND_TEXT, Text: "Hello 中文 😀"}}},
		"browser_read":           &pb.BrowserReadResponse{SessionId: "browser-1", NavigationEpoch: 3, Url: "http://127.0.0.1:8080/", Title: "Armadra 受控浏览器", Text: "正文 😀", Elements: []*pb.BrowserElement{{ElementRef: "e1", Role: "button", Name: "提交", Selector: "#submit", Visible: true, X: 10, Y: 20, Width: 80, Height: 32}}, Console: []*pb.BrowserConsoleEntry{{AtUnixMs: 1788557900000, Level: "error", Text: "boom", Url: "http://127.0.0.1:8080/", Line: 12}}, Network: []*pb.BrowserNetworkEntry{{AtUnixMs: 1788557900000, Method: "GET", Url: "http://127.0.0.1:8080/a", Status: 404, MimeType: "text/html", EncodedBytes: 9007199254740993, FailureCode: "", FromCache: true}}, Truncated: true},
		"browser_action_capture": &pb.BrowserAction{Action: &pb.BrowserAction_Capture{Capture: &pb.BrowserCaptureRequest{Meta: &pb.CommandMeta{RequestId: "请求-1"}, SessionId: "browser-1", FullPage: true, Format: "png"}}},
		"browser_unsupported":    &pb.BrowserSession{SessionId: "browser-2", State: pb.BrowserSessionState(999), ReasonCode: "chrome_not_found"},
		"browser_download":       &pb.BrowserDownload{DownloadId: "d-1", SessionId: "browser-1", Url: "http://127.0.0.1:8080/报告.pdf", SuggestedFilename: "报告.pdf", State: pb.BrowserDownloadState_BROWSER_DOWNLOAD_STATE_PENDING, Path: ".armadra/downloads/报告.pdf", TotalBytes: 9007199254740993, ReceivedBytes: 0, CreatedAtUnixMs: 1788557000000, ReasonCode: ""},
	} {
		wire, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		encoded := fixture(t, name, wire)
		decoded := message.ProtoReflect().New().Interface()
		if err = proto.Unmarshal(encoded, decoded); err != nil || !proto.Equal(decoded, message) {
			t.Fatal("browser contract changed")
		}
	}
}
