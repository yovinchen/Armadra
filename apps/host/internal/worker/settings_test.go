package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

func settingsDocument(body string) *pb.SettingsDocument {
	sum := sha256.Sum256([]byte(body))
	return &pb.SettingsDocument{
		Scope:         pb.SettingsScope_SETTINGS_SCOPE_GLOBAL,
		Document:      []byte(body),
		Sha256:        sum[:],
		SchemaVersion: 1,
	}
}

// The two directions are one conversation: reading the document changes
// nothing, writing it reports what is actually on disk afterwards.
func TestSettingsFramesReadAndWriteTheRuntimeDocument(t *testing.T) {
	database := ownershipDatabase(t)
	client := ownershipClient(t, database)
	ctx := context.Background()

	exported, err := client.ExportSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(exported.Document.Document), `"theme":"dark"`) {
		t.Fatalf("the export reported %q", exported.Document.Document)
	}
	if exported.Applied || exported.Replayed {
		t.Fatal("an export reported a write")
	}
	// The registry the Worker derived includes the machine it runs on, whose
	// identifier is the empty string by convention.
	if len(exported.ExecutionHosts) != 2 || exported.ExecutionHosts[0].ExecutionHostId != "" {
		t.Fatalf("the export derived %+v", exported.ExecutionHosts)
	}

	body := `{"theme":"light","ssh":{"hosts":[]}}`
	stored, err := client.ImportSettings(ctx, &pb.WorkerSettingsRequest{
		Document:      settingsDocument(body),
		ExpectedEpoch: 2,
		ImportId:      "import-1",
		Direction:     pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !stored.Applied || string(stored.Document.Document) != body {
		t.Fatalf("the import reported %+v", stored)
	}
	// The digest travelled with the bytes, not with the request.
	sum := sha256.Sum256([]byte(body))
	if !bytes.Equal(stored.Document.Sha256, sum[:]) {
		t.Fatal("the re-read digest does not describe the re-read bytes")
	}
	// And it survives the process that wrote it.
	again, err := ownershipClient(t, database).ExportSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(again.Document.Document) != body {
		t.Fatalf("the write did not persist: %q", again.Document.Document)
	}
}

// A request this client can already tell is unanswerable is refused locally,
// before a frame is sent.
func TestSettingsImportsAreValidatedBeforeTheyAreSent(t *testing.T) {
	client := ownershipClient(t, ownershipDatabase(t))
	ctx := context.Background()
	for name, request := range map[string]*pb.WorkerSettingsRequest{
		"no document": {ImportId: "import-1", Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT},
		"empty document": {Document: &pb.SettingsDocument{Scope: pb.SettingsScope_SETTINGS_SCOPE_GLOBAL},
			ImportId: "import-1", Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT},
		"no import id": {Document: settingsDocument(`{"a":1}`), Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT},
		"oversized import id": {Document: settingsDocument(`{"a":1}`), ImportId: strings.Repeat("x", 129),
			Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT},
		"no direction": {Document: settingsDocument(`{"a":1}`), ImportId: "import-1"},
		"the wrong direction": {Document: settingsDocument(`{"a":1}`), ImportId: "import-1",
			Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_EXPORT},
	} {
		t.Run(name, func(t *testing.T) {
			var failure *Error
			if _, err := client.ImportSettings(ctx, request); !errors.As(err, &failure) || failure.Code != CodeInvalid {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

// An answer that does not describe what was asked is a protocol failure, not a
// success with surprising contents.
func TestSettingsAnswersThatDoNotDescribeTheRequestAreProtocolFailures(t *testing.T) {
	for name, check := range map[string]struct {
		mode string
		run  func(*Client) error
	}{
		"a digest that describes other bytes": {"settings-wrong-digest", func(c *Client) error {
			_, err := c.ExportSettings(context.Background())
			return err
		}},
		"an export that claims a write": {"settings-claims-write", func(c *Client) error {
			_, err := c.ExportSettings(context.Background())
			return err
		}},
		"an import that reports no write": {"settings-silent-write", func(c *Client) error {
			_, err := c.ImportSettings(context.Background(), &pb.WorkerSettingsRequest{
				Document:  settingsDocument(`{"theme":"light"}`),
				ImportId:  "import-1",
				Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT,
			})
			return err
		}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ARMADRA_TEST_WORKER_MODE", check.mode)
			client := ownershipClient(t, ownershipDatabase(t))
			var failure *Error
			if err := check.run(client); !errors.As(err, &failure) || failure.Code != CodeProtocol {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

// A Worker that never advertised the settings frames must not be planned
// against, even when it can move an epoch perfectly well.
func TestSettingsRequireTheAdvertisedCapability(t *testing.T) {
	t.Setenv("ARMADRA_TEST_WORKER_MODE", "settings-silent")
	client := ownershipClient(t, ownershipDatabase(t))
	if client.SupportsSettings() {
		t.Fatal("a silent Worker was reported as supporting settings")
	}
	var failure *Error
	if _, err := client.ExportSettings(context.Background()); !errors.As(err, &failure) || failure.Code != CodeUnsupported {
		t.Fatalf("a silent Worker answered an export: %v", err)
	}
	// The epoch half of the same channel still works, which is exactly why the
	// two capabilities are separate statements.
	if _, err := client.GetWriteOwnership(context.Background(), "canvas"); err != nil {
		t.Fatalf("the ownership frames were disturbed: %v", err)
	}
}

// A Worker started without the ownership database has no settings surface at
// all, and the client refuses locally rather than sending an unanswerable frame.
func TestSettingsRequireTheOwnershipMode(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	client, err := Start(context.Background(), Options{Executable: executable, HostID: fixtureHost})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var failure *Error
	if _, err = client.ExportSettings(context.Background()); !errors.As(err, &failure) || failure.Code != CodeUnsupported {
		t.Fatalf("a plain Worker answered a settings read: %v", err)
	}
}

// The settings file defaults to the Runtime's own layout, and a path that is
// not absolute is refused before a process is started.
func TestSettingsFileDefaultsBesideTheDatabase(t *testing.T) {
	database := ownershipDatabase(t)
	client := ownershipClient(t, database)
	if _, err := client.ExportSettings(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ImportSettings(context.Background(), &pb.WorkerSettingsRequest{
		Document:  settingsDocument(`{"theme":"light"}`),
		ImportId:  "import-1",
		Direction: pb.WorkerSettingsDirection_WORKER_SETTINGS_DIRECTION_IMPORT,
	}); err != nil {
		t.Fatal(err)
	}
	sibling := filepath.Join(filepath.Dir(database), "settings.json")
	if _, err := os.Stat(sibling); err != nil {
		t.Fatalf("the default settings file is not beside the database: %v", err)
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var failure *Error
	_, err = Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, CanvasDatabase: database, SettingsFile: "settings.json"})
	if !errors.As(err, &failure) || failure.Code != CodeInvalid {
		t.Fatalf("a relative settings file was accepted: %v", err)
	}
	// Naming one without the ownership database claims a mode this Worker is
	// not being started in.
	_, err = Start(context.Background(), Options{Executable: executable, HostID: fixtureHost, SettingsFile: sibling})
	if !errors.As(err, &failure) || failure.Code != CodeInvalid {
		t.Fatalf("a settings file without an ownership database was accepted: %v", err)
	}
}
