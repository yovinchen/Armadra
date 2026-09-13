package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "armadra.local/host/gen/armadra/v1"
	"armadra.local/host/internal/automation"
	"armadra.local/host/internal/daemon"
	"armadra.local/host/internal/server"
	"google.golang.org/protobuf/proto"
)

type httpsFixture struct {
	origin string
	client *http.Client
	csrf   string
	t      *testing.T
}

func writeTLSMaterial(t *testing.T, directory string) (string, string, *x509.Certificate) {
	t.Helper()
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	certificate := fixture.TLS.Certificates[0]
	leaf := fixture.Certificate()
	fixture.Close()
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	certPath, keyPath := filepath.Join(directory, "cert.pem"), filepath.Join(directory, "key.pem")
	if err = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	return certPath, keyPath, leaf
}

func freeAddress(t *testing.T) string {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := probe.Addr().String()
	probe.Close()
	return address
}

func (f *httpsFixture) call(path string, input, output proto.Message) int {
	f.t.Helper()
	wire, err := proto.Marshal(input)
	if err != nil {
		f.t.Fatal(err)
	}
	request, err := http.NewRequest("POST", f.origin+path, bytes.NewReader(wire))
	if err != nil {
		f.t.Fatal(err)
	}
	request.Header.Set("Origin", f.origin)
	request.Header.Set("Content-Type", server.MediaType)
	if f.csrf != "" {
		request.Header.Set("X-Armadra-CSRF", f.csrf)
	}
	response, err := f.client.Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if response.StatusCode == http.StatusOK && output != nil {
		if err = proto.Unmarshal(body, output); err != nil {
			f.t.Fatal(err)
		}
	}
	return response.StatusCode
}

func killStateDirWorker(t *testing.T, stateDir string) {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command("pgrep", "-f", resolved).Output()
	if err != nil {
		t.Fatal("no Worker process matched the state directory:", err)
	}
	killed := 0
	for _, line := range strings.Fields(string(output)) {
		pid, convert := strconv.Atoi(line)
		if convert != nil || pid <= 1 || pid == os.Getpid() {
			continue
		}
		if worker, find := os.FindProcess(pid); find == nil && worker.Kill() == nil {
			killed++
		}
	}
	if killed == 0 {
		t.Fatal("no Worker process was terminated")
	}
}

func stateDirWorkers(t *testing.T, stateDir string) int {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(stateDir)
	if err != nil {
		return 0
	}
	output, err := exec.Command("pgrep", "-f", resolved).Output()
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Fields(string(output)) {
		if pid, convert := strconv.Atoi(line); convert == nil && pid != os.Getpid() {
			count++
		}
	}
	return count
}

// A running Host must schedule and execute with no client attached, survive
// losing its Worker, and leave no process behind when it stops.
func TestRealHostSchedulesOverHTTPSAndLeavesNoWorkerBehind(t *testing.T) {
	binary := os.Getenv("ARMADRA_TEST_REAL_WORKER")
	if binary == "" {
		t.Skip("set ARMADRA_TEST_REAL_WORKER to the built Rust Runtime binary")
	}
	if runtime.GOOS == "windows" {
		t.Skip("Unix command fixture")
	}
	directory := t.TempDir()
	certPath, keyPath, leaf := writeTLSMaterial(t, directory)
	address := freeAddress(t)
	origin := "https://" + address
	stateDir := filepath.Join(directory, "worker")
	root := t.TempDir()
	c, err := parseConfig([]string{"serve", "--data-dir", filepath.Join(directory, "host"), "--listen", address, "--tls-cert", certPath, "--tls-key", keyPath, "--public-origin", origin, "--worker-binary", binary, "--worker-state-dir", stateDir})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- serveHost(ctx, c) }()
	stopped := false
	stop := func() error {
		cancel()
		select {
		case err := <-served:
			stopped = true
			return err
		case <-time.After(20 * time.Second):
			return errors.New("Host did not stop")
		}
	}
	t.Cleanup(func() {
		if !stopped {
			_ = stop()
		}
	})
	var status *pb.HostStatus
	for waited := time.Now(); status == nil && time.Since(waited) < 15*time.Second; {
		if current, statusErr := daemon.Status(ctx, c.dataDir); statusErr == nil {
			status = current
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status == nil {
		t.Fatal("Host private control did not become ready")
	}
	if stateDirWorkers(t, stateDir) == 0 {
		t.Fatal("serve did not start the configured Worker")
	}
	wire, err := pairProcess(t, []string{"pair", "--data-dir", c.dataDir, "--origin", origin, "--device-name", "调度设备", "--output", "protobuf"})
	if err != nil {
		t.Fatal("pair subprocess failed")
	}
	ticket := new(pb.BootstrapTicketResponse)
	if proto.Unmarshal(wire, ticket) != nil || ticket.Ticket == "" {
		t.Fatal("pair did not return a bound ticket")
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	jar, _ := cookiejar.New(nil)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	f := &httpsFixture{origin: origin, client: &http.Client{Transport: transport, Jar: jar, Timeout: 10 * time.Second}, t: t}
	session := new(pb.AuthenticatedSession)
	if code := f.call(server.AuthPrefix+"Pair", &pb.PairDeviceRequest{ExpectedHostId: status.HostId, ExpectedInstanceId: status.HostInstanceId, Ticket: ticket.Ticket}, session); code != 200 {
		t.Fatal("HTTPS pairing failed with", code)
	}
	f.csrf = session.CsrfToken
	meta := &pb.CommandMeta{RequestId: "e2e", Scope: &pb.Scope{HostId: status.HostId, WorkspaceId: "workspace", ExecutionHostId: status.HostId}}

	command := new(pb.AutomationCommandSession)
	if code := f.call(server.AutomationPrefix+"DefineCommandSession", &pb.DefineCommandSessionRequest{Meta: meta, SessionId: "nightly", RootPath: root, Launch: &pb.CommandLaunchSpec{Executable: "/bin/echo", Args: []string{"无人值守"}, WorkingDirectory: ".", AccountId: "default", TimeoutMs: 10000}}, command); code != 200 {
		t.Fatal("DefineCommandSession failed with", code)
	}
	if command.State != pb.AutomationCommandSessionState_AUTOMATION_COMMAND_SESSION_STATE_READY {
		t.Fatalf("command session: %+v", command)
	}
	plan := new(pb.AutomationPlanSnapshot)
	config := &pb.AutomationPlanConfig{
		WorkspaceId: "workspace",
		Title:       "两秒后执行",
		Target:      &pb.AutomationTarget{ExecutionHostId: status.HostId, SessionId: "nightly", Generation: command.Generation},
		Schedule:    &pb.AutomationSchedule{Kind: &pb.AutomationSchedule_Once{Once: &pb.AutomationOnce{AtUnixMs: time.Now().Add(2 * time.Second).UnixMilli()}}},
		MaxRuns:     1,
	}
	if code := f.call(server.AutomationPrefix+"Define", &pb.DefineAutomationRequest{Meta: meta, PlanId: "plan", Config: config, Payload: []byte("stdin 内容\n")}, plan); code != 200 {
		t.Fatal("Define failed with", code)
	}
	activated := new(pb.AutomationPlanSnapshot)
	if code := f.call(server.AutomationPrefix+"Activate", &pb.ActivateAutomationRequest{Meta: meta, PlanId: "plan", ConfigVersion: plan.Plan.ConfigVersion, ConfigSha256: plan.ConfigSha256, ExpectedRevision: plan.Revision}, activated); code != 200 {
		t.Fatal("Activate failed with", code)
	}
	if activated.Plan.State != automation.Active || activated.Plan.NextDueUnixMs == 0 {
		t.Fatalf("activated plan: %+v", activated.Plan)
	}
	// No client is required from here: the Host alone reaches the due time.
	runs := new(pb.ListAutomationRunsResponse)
	deadline := time.Now().Add(25 * time.Second)
	succeeded := false
	for time.Now().Before(deadline) && !succeeded {
		runs.Reset()
		if code := f.call(server.AutomationPrefix+"ListRuns", &pb.ListAutomationRunsRequest{Meta: meta, PlanId: "plan"}, runs); code != 200 {
			t.Fatal("ListRuns failed with", code)
		}
		for _, run := range runs.Runs {
			succeeded = succeeded || run.Run.State == automation.Succeeded
		}
		if !succeeded {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if !succeeded {
		t.Fatalf("no scheduled run completed: %+v", runs.Runs)
	}
	if len(runs.Runs) != 1 {
		t.Fatalf("a single Once plan produced %d runs", len(runs.Runs))
	}

	// Losing the Worker must be recovered without replaying the delivered run.
	killStateDirWorker(t, stateDir)
	restarted := false
	for deadline = time.Now().Add(25 * time.Second); time.Now().Before(deadline) && !restarted; {
		restarted = stateDirWorkers(t, stateDir) > 0
		if !restarted {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if !restarted {
		t.Fatal("the Host did not restart its Worker")
	}
	sessions := new(pb.ListCommandSessionsResponse)
	if code := f.call(server.AutomationPrefix+"ListCommandSessions", &pb.ListCommandSessionsRequest{Meta: meta}, sessions); code != 200 {
		t.Fatal("ListCommandSessions failed with", code)
	}
	if len(sessions.Sessions) != 1 || sessions.Sessions[0].State != pb.AutomationCommandSessionState_AUTOMATION_COMMAND_SESSION_STATE_READY || sessions.Sessions[0].Generation != command.Generation {
		t.Fatalf("definition was not rebuilt on the replacement Worker: %+v", sessions.Sessions)
	}
	after := new(pb.ListAutomationRunsResponse)
	if code := f.call(server.AutomationPrefix+"ListRuns", &pb.ListAutomationRunsRequest{Meta: meta, PlanId: "plan"}, after); code != 200 {
		t.Fatal("ListRuns failed with", code)
	}
	if len(after.Runs) != 1 {
		t.Fatalf("a Worker restart replayed delivery: %+v", after.Runs)
	}
	// Stopping the Host must reclaim its Worker: no orphan keeps running.
	if err = stop(); err != nil {
		t.Fatal(err)
	}
	for waited := time.Now(); time.Since(waited) < 5*time.Second; {
		if stateDirWorkers(t, stateDir) == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("a Worker process outlived the Host")
}
