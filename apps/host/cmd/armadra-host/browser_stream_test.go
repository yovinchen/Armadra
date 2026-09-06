package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"google.golang.org/protobuf/proto"
)

// A phone watching a browser node, over the real thing: the real Rust Runtime,
// a real Chromium, the real Host, a real paired device and a real WebSocket
// through `proxyStream`.
//
// The point is not that the bytes arrive — the terminal test already proves the
// proxy carries a socket — but that they arrive *fast enough*, from the far end
// of the path the design (§8) sets a p95 target for. The number is printed and
// judged by a person; the assertion here only catches a stall.
//
// Skips loudly without a Chromium: a silent pass would be worse than no test.
func TestAPhoneWatchesABrowserSessionThroughTheProxy(t *testing.T) {
	executable := os.Getenv("ARMADRA_BROWSER_PATH")
	if executable == "" {
		executable = os.Getenv("CHROME_PATH")
	}
	if executable == "" {
		for _, candidate := range []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
		} {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				executable = candidate
				break
			}
		}
	}
	if executable == "" {
		t.Skip("SKIPPED: no Chromium-family browser on this host; set ARMADRA_BROWSER_PATH or CHROME_PATH")
	}
	t.Setenv("ARMADRA_BROWSER_PATH", executable)

	page := servePage(t)
	runtimeDir := startRuntime(t)
	host := startProxyHost(t, runtimeDir, writeWebFixture(t))
	host.pair(t, "手机", allGrants())

	root := t.TempDir()
	status, workspace := host.json(t, http.MethodPost, "/api/workspaces", map[string]any{"name": "browser", "rootPath": root})
	if status != 200 {
		t.Fatalf("workspace creation answered %d %v", status, workspace)
	}
	workspaceID, _ := workspace["id"].(string)

	status, availability := host.json(t, http.MethodGet, "/api/workspaces/"+workspaceID+"/browser/availability", nil)
	if status != 200 {
		t.Fatalf("availability answered %d %v", status, availability)
	}
	if available, _ := availability["available"].(bool); !available {
		t.Skipf("SKIPPED: the Runtime found no usable browser: %v", availability["searched"])
	}

	// A phone in portrait, which is the viewport the focus page asks for.
	status, session := host.json(t, http.MethodPost, "/api/workspaces/"+workspaceID+"/browser/sessions", map[string]any{
		"nodeId":   "00000000-0000-4000-8000-000000000001",
		"url":      page,
		"viewport": map[string]any{"width": 390, "height": 844, "deviceScaleFactor": 1},
	})
	if status != 200 {
		t.Fatalf("browser session creation answered %d %v", status, session)
	}
	sessionID, _ := session["sessionId"].(string)
	t.Cleanup(func() {
		host.do(t, http.MethodDelete, "/api/workspaces/"+workspaceID+"/browser/sessions/"+sessionID+"?terminate=true", nil, nil).Body.Close()
	})

	socket, err := dialTestSocket(
		host.address,
		"/api/workspaces/"+workspaceID+"/browser/sessions/"+sessionID+"/stream",
		host.origin, host.tls, host.jar.Cookies(mustParse(t, host.origin)),
	)
	if err != nil {
		t.Fatalf("the frame stream did not open through the proxy: %v", err)
	}
	defer socket.Close()

	hello, err := proto.Marshal(&pb.BrowserStreamClient{Message: &pb.BrowserStreamClient_Hello{Hello: &pb.BrowserSubscribeRequest{
		Visibility:     pb.BrowserVisibility_BROWSER_VISIBILITY_FOCUSED,
		BandwidthClass: pb.BrowserBandwidthClass_BROWSER_BANDWIDTH_CLASS_WAN,
		DeviceId:       "phone-1",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = socket.writeBinary(hello); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(60 * time.Second)
	receipt := map[string]any{}
	opcode, body, err := socket.readFrame(deadline)
	if err != nil || opcode != 0x1 {
		t.Fatalf("the stream did not answer the hello: opcode %d %v", opcode, err)
	}
	if err = json.Unmarshal(body, &receipt); err != nil {
		t.Fatalf("the subscription receipt was not JSON: %q", body)
	}
	// A WAN link is served a smaller budget than a LAN one, and the receipt
	// says so rather than leaving the client to assume it happened (§2.9).
	if fps, _ := receipt["maxFps"].(float64); fps <= 0 || fps > 8 {
		t.Fatalf("a WAN subscriber was given maxFps %v", receipt["maxFps"])
	}

	first := readStreamFrame(t, socket, deadline)
	if first.GetViewportWidth() != 390 {
		t.Fatalf("the phone was sent a %d px wide picture", first.GetViewportWidth())
	}
	if len(first.GetData()) < 2 || first.GetData()[0] != 0xff || first.GetData()[1] != 0xd8 {
		t.Fatal("the frame did not survive the proxy as JPEG bytes")
	}

	// From here the test behaves like the real client: one reader, and every
	// frame is acknowledged as it arrives. Reading one frame per click instead
	// would let the socket buffer a backlog, and the number being measured
	// would be this test's own laziness rather than the path's latency.
	frames := make(chan *pb.BrowserStreamFrame, 64)
	failures := make(chan error, 1)
	go func() {
		for {
			opcode, body, readErr := socket.readFrame(time.Now().Add(60 * time.Second))
			if readErr != nil {
				close(frames)
				return
			}
			if opcode == 0x1 {
				failures <- fmt.Errorf("the stream refused the input: %s", body)
				close(frames)
				return
			}
			frame := &pb.BrowserStreamFrame{}
			if proto.Unmarshal(body, frame) != nil {
				continue
			}
			ack, _ := proto.Marshal(&pb.BrowserStreamClient{
				Message: &pb.BrowserStreamClient_Ack{Ack: frame.GetFrameSeq()},
			})
			if socket.writeBinary(ack) != nil {
				close(frames)
				return
			}
			frames <- frame
		}
	}()

	samples := make([]time.Duration, 0, 20)
	last := first
	for round := range 20 {
		click, marshalErr := proto.Marshal(&pb.BrowserStreamClient{Message: &pb.BrowserStreamClient_Input{Input: &pb.BrowserInputRequest{
			SessionId:       sessionID,
			NavigationEpoch: last.GetNavigationEpoch(),
			FrameSeq:        last.GetFrameSeq(),
			DeviceId:        "phone-1",
			Events: []*pb.BrowserInputEvent{
				{Kind: pb.BrowserInputKind_BROWSER_INPUT_KIND_MOUSE_PRESSED, X: 195, Y: 300 + float64(round), Button: "left", ClickCount: 1},
				{Kind: pb.BrowserInputKind_BROWSER_INPUT_KIND_MOUSE_RELEASED, X: 195, Y: 300 + float64(round), Button: "left", ClickCount: 1},
			},
		}}})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		sent := time.Now()
		if err = socket.writeBinary(click); err != nil {
			t.Fatal(err)
		}
		next, ok := <-frames
		if !ok {
			select {
			case failure := <-failures:
				t.Fatal(failure)
			default:
				t.Fatal("the frame stream ended before the click produced a frame")
			}
		}
		samples = append(samples, time.Since(sent))
		if next.GetFrameSeq() <= last.GetFrameSeq() {
			t.Fatalf("the proxy delivered frame %d again", next.GetFrameSeq())
		}
		last = next
	}

	sort.Slice(samples, func(a, b int) bool { return samples[a] < samples[b] })
	p95 := samples[len(samples)*95/100]
	fmt.Printf(
		"browser stream click→frame through the Host proxy at 390×844: median %v, p95 %v over %d samples (design §8 target: p95 ≤ 350 ms)\n",
		samples[len(samples)/2], p95, len(samples),
	)
	if p95 > 5*time.Second {
		t.Fatalf("the proxied stream stalled: p95 %v", p95)
	}
}

func readStreamFrame(t *testing.T, socket *testSocket, deadline time.Time) *pb.BrowserStreamFrame {
	t.Helper()
	for {
		opcode, body, err := socket.readFrame(deadline)
		if err != nil {
			t.Fatalf("the frame stream ended: %v", err)
		}
		if opcode == 0x1 {
			// A refusal comes back as `{ code, message }`; it is a failure here.
			t.Fatalf("the stream refused the input: %s", body)
		}
		frame := &pb.BrowserStreamFrame{}
		if err = proto.Unmarshal(body, frame); err != nil {
			t.Fatalf("a frame did not decode: %v", err)
		}
		return frame
	}
}

// The page under test repaints on every click, which is what makes
// "click → new frame" a thing that can be timed. Loopback only; it reaches
// nothing.
func servePage(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, `<!doctype html><html><head><meta charset="utf-8"><title>帧流</title>
<style>body{font:20px sans-serif;margin:0}#box{width:100%;height:100vh;background:#123}</style>
</head><body><div id="box" onclick="
  window.n=(window.n||0)+1;
  this.style.background='hsl('+(window.n*37%360)+',70%,40%)';
  this.textContent=window.n;
"></div></body></html>`)
	}))
	t.Cleanup(server.Close)
	return server.URL + "/"
}
