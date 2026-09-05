package endpoints

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPublishKeepsTheOtherServiceAndStaysPrivate(t *testing.T) {
	path := Path(t.TempDir())
	runtimeRecord := Now("runtime-instance")
	runtimeRecord.HTTP = "http://127.0.0.1:53211"
	runtimeRecord.Socket = "/tmp/armadra/runtime.sock"
	if err := Publish(path, RuntimeService, runtimeRecord); err != nil {
		t.Fatalf("publish runtime: %v", err)
	}
	hostRecord := Now("host-instance")
	hostRecord.HTTP = "http://127.0.0.1:53212"
	if err := Publish(path, HostService, hostRecord); err != nil {
		t.Fatalf("publish host: %v", err)
	}

	document := Read(path)
	if document.Version != Version {
		t.Fatalf("version = %d, want %d", document.Version, Version)
	}
	if document.Runtime == nil || document.Runtime.HTTP != "http://127.0.0.1:53211" {
		t.Fatalf("the Runtime record did not survive the Host publish: %+v", document.Runtime)
	}
	if document.Host == nil || document.Host.HTTP != "http://127.0.0.1:53212" {
		t.Fatalf("host record = %+v", document.Host)
	}
	if document.Host.ProcessID != uint32(os.Getpid()) {
		t.Fatalf("processId = %d, want this process", document.Host.ProcessID)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// The Rust Runtime reads this file too; the keys are its camelCase.
	for _, key := range []string{`"instanceId"`, `"writtenAt"`, `"processId"`} {
		if !strings.Contains(string(raw), key) {
			t.Fatalf("%s missing from %s", key, raw)
		}
	}
	// A record with no WebSocket must not claim an empty one.
	if strings.Contains(string(raw), `"websocket"`) {
		t.Fatalf("absent transports should be omitted: %s", raw)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
		}
	}
}

func TestWithdrawRemovesOnlyItsOwnRecord(t *testing.T) {
	path := Path(t.TempDir())
	if err := Publish(path, RuntimeService, Now("runtime")); err != nil {
		t.Fatalf("publish runtime: %v", err)
	}
	if err := Publish(path, HostService, Now("host")); err != nil {
		t.Fatalf("publish host: %v", err)
	}
	if err := Withdraw(path, HostService); err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	document := Read(path)
	if document.Host != nil {
		t.Fatalf("host record survived withdrawal: %+v", document.Host)
	}
	if document.Runtime == nil {
		t.Fatal("withdrawing the Host removed the Runtime record")
	}
	// A file that was never written is not an error to withdraw from.
	if err := Withdraw(Path(filepath.Join(t.TempDir(), "absent")), HostService); err != nil {
		t.Fatalf("withdraw from a missing file: %v", err)
	}
}

func TestACorruptOrNewerFileIsIgnoredRatherThanFatal(t *testing.T) {
	path := Path(t.TempDir())
	for _, body := range []string{"{ not json", `{"version":99,"host":{"http":"x"}}`} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if document := Read(path); document.Host != nil || document.Runtime != nil {
			t.Fatalf("%q should have read as empty, got %+v", body, document)
		}
		if err := Publish(path, HostService, Now("host")); err != nil {
			t.Fatalf("publish over %q: %v", body, err)
		}
		if Read(path).Host == nil {
			t.Fatalf("publish over %q did not take", body)
		}
	}
}

func TestAnUnknownServiceIsRefusedRatherThanSilentlyDropped(t *testing.T) {
	path := Path(t.TempDir())
	if err := Publish(path, "worker", Now("worker")); err == nil {
		t.Fatal("an unknown service key should be an error")
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("a refused publish must not create the file")
	}
}

// The Rust Runtime and this package have to agree on the wire shape, because
// they write the same file. This pins the field names that agreement rests on.
func TestTheDocumentShapeMatchesTheRuntimeContract(t *testing.T) {
	record := Now("instance")
	record.HTTP = "http://127.0.0.1:1"
	record.WebSocket = "ws://127.0.0.1:1"
	record.Socket = "/tmp/s.sock"
	record.Pipe = `\\.\pipe\armadra`
	body, err := json.Marshal(Document{Version: Version, Host: &record})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	host, ok := decoded["host"].(map[string]any)
	if !ok {
		t.Fatalf("host is not an object: %s", body)
	}
	for _, key := range []string{"instanceId", "writtenAt", "processId", "http", "websocket", "socket", "pipe"} {
		if _, present := host[key]; !present {
			t.Fatalf("%q missing from %s", key, body)
		}
	}
}
