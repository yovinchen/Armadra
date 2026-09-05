package automationhost

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	auth "armadra.local/host/internal/identity"
	"armadra.local/host/internal/storage"
)

// The one acceptance that cannot be faked: a Once plan, no client anywhere, a
// real Rust Worker, a real Runtime holding a real PTY, and a shell standing in
// for an Agent that reports itself idle through the real hook client. It passes
// only when the prompt actually lands in that terminal's input.
//
// Set both binaries to run it:
//
//	ARMADRA_TEST_REAL_WORKER=<path to armadra-runtime>
//	ARMADRA_TEST_REAL_HOOK=<path to armadra-hook>
func TestOncePlanWritesAPromptIntoARealAgentTerminal(t *testing.T) {
	binary := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	hook := os.Getenv("ARMADRA_TEST_REAL_HOOK")
	if binary == "" || hook == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER and ARMADRA_TEST_REAL_HOOK to built binaries")
	}
	if runtime.GOOS == "windows" {
		t.Skip("the fixture Agent is a POSIX shell script")
	}
	ctx := context.Background()
	fixture := startRuntime(t, binary, hook)
	workspace, node, session := fixture.agentTerminal(t)

	// The delivery gate needs the hook to have reported a finished turn. The
	// fixture Agent does that itself, through the real client, over the real
	// endpoint file — nothing here writes an observation by hand.
	fixture.awaitIdle(t, workspace, node)

	// The Runtime's own answer first: nothing downstream can call a target
	// writable that the Runtime does not, and its reason code says why in one
	// stable word rather than a stack of "unsupported".
	var probe struct {
		State      string `json:"state"`
		ReasonCode string `json:"reasonCode"`
	}
	fixture.call(t, http.MethodPost, "/automation/agent-target", map[string]any{
		"nodeId": node, "sessionId": session, "generation": 1,
		"expected": map[string]any{"agentId": "claude", "workingDirectory": ".", "accountId": "default"},
	}, &probe)
	if probe.State != "ready" {
		t.Fatalf("the Runtime refused the target: %+v", probe)
	}

	host := strings.Repeat("e", 32)
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0700)
	store, err := storage.Open(t.TempDir(), host)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	// The grant a dispatch is re-checked against points at a real device row.
	pairDevice(t, store)
	// The Worker inherits the Runtime's data directory, which is the only way
	// it can find that Runtime's private endpoint file and app bearer.
	t.Setenv("ARMADRA_DATA_DIR", fixture.dataDir)
	service, err := New(ctx, Options{
		Executable: binary, StateDir: stateDir, HostID: host, InstanceID: "instance-agent",
		Store: store, PollInterval: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { service.Close() })

	caller := Caller{
		PrincipalID: testOwner, DeviceID: testDevice, DeviceEpoch: 1, WorkspaceID: workspace,
		Scopes: []auth.Scope{
			{Permission: ScopeManage, WorkspaceID: workspace, ExecutionHostID: host},
			{Permission: ScopeRead, WorkspaceID: workspace, ExecutionHostID: host},
		},
	}
	prompt := "自动化投递测试-" + session[:8]
	config := &pb.AutomationPlanConfig{
		WorkspaceId: workspace,
		Title:       "夜间提示",
		Schedule:    &pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Once{Once: &pb.AutomationOnce{AtUnixMs: time.Now().UnixMilli()}}},
		Target: &pb.AutomationTarget{
			ExecutionHostId: host,
			SessionId:       session,
			Generation:      1,
			Kind:            pb.AutomationTargetKind_AUTOMATION_TARGET_KIND_AGENT_SESSION_PROMPT,
			NodeId:          node,
			AgentLaunch:     &pb.AgentLaunchSpec{AgentId: "claude", WorkingDirectory: ".", AccountId: "default"},
		},
		BusyTtlMs: 60000,
	}
	snapshot, err := service.Define(ctx, caller, "agent-plan", config, []byte(prompt), 0)
	if err != nil {
		t.Fatal("define:", err)
	}
	if _, err = service.Activate(ctx, caller, "agent-plan", snapshot.Revision, snapshot.Plan.ConfigVersion, snapshot.ConfigSha256); err != nil {
		t.Fatal("activate:", err)
	}

	loop, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- service.Run(loop) }()
	t.Cleanup(func() { cancel(); <-done })

	// The terminal is the evidence. A run that says DELIVERED while the shell
	// never saw the text would be exactly the lie this whole path is built to
	// avoid, so the assertion is on what the fixture Agent actually read.
	deadline := time.Now().Add(45 * time.Second)
	for {
		if strings.Contains(fixture.received(t), prompt) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the fixture Agent never received the prompt; it read %q", fixture.received(t))
		}
		time.Sleep(100 * time.Millisecond)
	}

	// And the run has to describe it honestly: delivered, not finished.
	run := awaitDelivered(t, service, caller, "agent-plan", 20*time.Second)
	if run.Run.State != automation.Delivered && run.Run.State != automation.Succeeded {
		t.Fatalf("a delivered prompt was recorded as %v (%s)", run.Run.State, run.Run.ReasonCode)
	}
	if !run.Run.DeliveryObserved {
		t.Fatal("delivery was not recorded as observed")
	}
}

func awaitDelivered(t *testing.T, service *Service, caller Caller, plan string, budget time.Duration) *pb.AutomationRunSnapshot {
	t.Helper()
	deadline := time.Now().Add(budget)
	for {
		page, err := service.ListRuns(context.Background(), caller, plan, "", 20)
		if err == nil {
			for _, snapshot := range page.Runs {
				if snapshot.Run != nil && snapshot.Run.State >= automation.Delivered {
					return snapshot
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the run never reached a delivery state")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

/* ------------------------------ the Runtime ------------------------------- */

type runtimeFixture struct {
	dataDir  string
	rootPath string
	base     string
	received func(*testing.T) string
	inbox    string
}

// startRuntime brings up a real Runtime with a fixture on PATH that stands in
// for the `claude` CLI: it reports one finished turn through the real hook
// client, then records everything typed at it.
func startRuntime(t *testing.T, binary, hook string) *runtimeFixture {
	t.Helper()
	// Not t.TempDir(): the Runtime puts its hook and tmux sockets in here, and
	// the per-test temporary path is longer than a Unix socket may be.
	dataDir, err := os.MkdirTemp(shortTempRoot(), "armadra-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dataDir) })
	_ = os.Chmod(dataDir, 0700)
	root := t.TempDir()
	inbox := filepath.Join(dataDir, "agent-inbox.txt")
	bin := filepath.Join(dataDir, "bin")
	if err = os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf(`#!/bin/sh
# Stands in for an Agent CLI. It reports a finished turn through the real hook
# client — the same binary, endpoint file and node token a real CLI uses — and
# then records whatever is typed at it.
printf '{"hook_event_name":"SessionStart"}' | %[1]q claude >/dev/null 2>&1
printf '{"hook_event_name":"Stop"}' | %[1]q claude >/dev/null 2>&1
while IFS= read -r line; do
  printf '%%s\n' "$line" >>%[2]q
done
`, hook, inbox)
	if err = os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	// The direct PTY backend, so the delivery gate reads the fixture Agent's
	// own argv rather than a tmux pane's shell name — the gate's rule is that
	// the foreground has to *be* the Agent, and tmux naming is its own topic.
	settings := `{"terminal":{"backend":"direct"},"usage":{"enabled":false}}`
	if err = os.WriteFile(filepath.Join(dataDir, "settings.json"), []byte(settings), 0600); err != nil {
		t.Fatal(err)
	}

	child := exec.Command(binary, "--listen", "tcp:127.0.0.1:0")
	child.Env = append(os.Environ(),
		"ARMADRA_DATA_DIR="+dataDir,
		"ARMADRA_DATABASE_URL=sqlite://"+filepath.Join(dataDir, "canvas.db")+"?mode=rwc",
		"PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"),
	)
	child.Stdout, child.Stderr = os.Stderr, os.Stderr
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = child.Process.Kill()
		_, _ = child.Process.Wait()
	})

	base := awaitEndpoint(t, dataDir)
	return &runtimeFixture{
		dataDir:  dataDir,
		rootPath: root,
		base:     base,
		received: func(t *testing.T) string {
			t.Helper()
			data, err := os.ReadFile(inbox)
			if err != nil {
				return ""
			}
			return string(data)
		},
		inbox: inbox,
	}
}

// A directory short enough for a Unix socket path to fit inside it.
func shortTempRoot() string {
	for _, candidate := range []string{"/tmp", os.TempDir()} {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

// bearer reads the Runtime's app token out of its endpoint file, the same way
// the hook client and the Worker's bridge do.
func (f *runtimeFixture) bearer() string {
	data, err := os.ReadFile(filepath.Join(f.dataDir, "hook-endpoint.env"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if value, ok := strings.CutPrefix(line, "ARMADRA_HOOK_TOKEN='"); ok {
			return strings.TrimSuffix(value, "'")
		}
	}
	return ""
}

func awaitEndpoint(t *testing.T, dataDir string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		data, err := os.ReadFile(filepath.Join(dataDir, "endpoints.json"))
		if err == nil {
			var document struct {
				Runtime struct {
					HTTP string `json:"http"`
				} `json:"runtime"`
			}
			if json.Unmarshal(data, &document) == nil && document.Runtime.HTTP != "" {
				return document.Runtime.HTTP
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the Runtime never published an endpoint")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (f *runtimeFixture) call(t *testing.T, method, path string, body any, out any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequest(method, f.base+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	// The private delivery surface needs the Runtime's own app bearer, read
	// from the same endpoint file the hook client and the Worker read.
	if token := f.bearer(); token != "" {
		request.Header.Set("X-Armadra-Hook-Token", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(method, path, err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		t.Fatalf("%s %s: %d %s", method, path, response.StatusCode, detail)
	}
	if out != nil {
		if err = json.NewDecoder(response.Body).Decode(out); err != nil {
			t.Fatal(method, path, err)
		}
	}
}

// agentTerminal creates a workspace, a terminal node and the PTY that runs the
// fixture Agent, exactly as the front end would.
func (f *runtimeFixture) agentTerminal(t *testing.T) (workspace, node, session string) {
	t.Helper()
	var created struct {
		ID string `json:"id"`
	}
	f.call(t, http.MethodPost, "/api/workspaces", map[string]any{
		"name": "automation e2e", "rootPath": f.rootPath,
		// Delivery requires execute, which is off by default. A plan aimed at a
		// workspace that never granted it is refused, and that is the point.
		"permissions": map[string]any{"read": true, "write": true, "execute": true},
	}, &created)
	workspace = created.ID

	var boards []struct {
		ID string `json:"id"`
	}
	f.call(t, http.MethodGet, "/api/workspaces/"+workspace+"/boards", nil, &boards)
	if len(boards) == 0 {
		t.Fatal("the new workspace has no canvas")
	}
	var document map[string]any
	f.call(t, http.MethodGet, "/api/workspaces/"+workspace+"/boards/"+boards[0].ID+"/document", nil, &document)

	node = "3f2b0f66-0f7b-7c1f-9a2c-2f7b0f7c1f9a"
	board := document["board"].(map[string]any)
	now := time.Now().UTC().Format(time.RFC3339)
	f.call(t, http.MethodPut, "/api/workspaces/"+workspace+"/boards/"+boards[0].ID+"/document", map[string]any{
		"expectedUpdatedAt": board["updatedAt"],
		"nodes": []any{map[string]any{
			"id": node, "boardId": boards[0].ID, "type": "terminal", "title": "claude",
			"color":     "#0a84ff",
			"position":  map[string]any{"x": 0, "y": 0},
			"size":      map[string]any{"width": 480, "height": 320},
			"labels":    []string{},
			"note":      "",
			"data":      map[string]any{"kind": "terminal", "cwd": ".", "agent": map[string]any{"id": "claude"}},
			"createdAt": now, "updatedAt": now,
		}},
		"edges":    []any{},
		"viewport": board["viewport"],
	}, nil)

	var terminal struct {
		ID string `json:"id"`
	}
	f.call(t, http.MethodPost, "/api/terminals", map[string]any{
		"workspaceId": workspace,
		"cwd":         ".",
		"nodeId":      node,
		"command":     filepath.Join(f.dataDir, "bin", "claude"),
		"args":        []string{},
		"agent":       map[string]any{"id": "claude"},
	}, &terminal)
	return workspace, node, terminal.ID
}

// awaitIdle waits for the fixture Agent's own hook report to land. Nothing
// here writes an observation by hand: the state comes from the real hook client
// talking to the real Runtime over its real endpoint file.
func (f *runtimeFixture) awaitIdle(t *testing.T, workspace, node string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var sessions []struct {
			NodeID string `json:"nodeId"`
			State  string `json:"state"`
		}
		f.call(t, http.MethodGet, "/api/workspaces/"+workspace+"/sessions", nil, &sessions)
		for _, row := range sessions {
			if row.NodeID == node && row.State == "done" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the fixture Agent never reported a finished turn")
		}
		time.Sleep(200 * time.Millisecond)
	}
}
