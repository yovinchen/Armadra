// Package endpoints publishes this Host's address into the shared
// endpoints.json that the Runtime also writes (roadmap §4.4).
//
// The file is a discovery hint, not an authority: it says where a service said
// it was listening, and every reader still probes before trusting it. Two rules
// keep it usable when two processes write it independently:
//
//   - a publish is read-modify-write on one service key, so writing "host"
//     never disturbs "runtime";
//   - an unparsable or newer-versioned file is replaced rather than merged
//     into, because a half-written hint must not wedge start-up forever.
//
// The document is written 0600 through a temporary file in the same directory,
// so a concurrent reader sees the old file or the new one, never a partial one.
package endpoints

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Version is bumped only when a reader that understands the current shape could
// no longer make sense of the file. Adding an optional field does not bump it.
const Version = 1

// Name is the file every service publishes into its data directory.
const Name = "endpoints.json"

// Service keys. They match the Runtime's, because it is the same document.
const (
	RuntimeService = "runtime"
	HostService    = "host"
)

// Service is one process's advertised addresses. Absent transports are omitted
// rather than written empty, so "no HTTP endpoint" cannot be misread as "".
type Service struct {
	InstanceID string `json:"instanceId"`
	WrittenAt  string `json:"writtenAt"`
	ProcessID  uint32 `json:"processId"`
	HTTP       string `json:"http,omitempty"`
	WebSocket  string `json:"websocket,omitempty"`
	Socket     string `json:"socket,omitempty"`
	Pipe       string `json:"pipe,omitempty"`
}

// Document is the whole file.
type Document struct {
	Version int      `json:"version"`
	Runtime *Service `json:"runtime,omitempty"`
	Host    *Service `json:"host,omitempty"`
}

// Path returns the endpoints file inside dir.
func Path(dir string) string { return filepath.Join(dir, Name) }

// Now stamps a record for this process.
func Now(instanceID string) Service {
	return Service{
		InstanceID: instanceID,
		WrittenAt:  time.Now().UTC().Format(time.RFC3339),
		ProcessID:  uint32(os.Getpid()),
	}
}

// Read never fails: a missing, unreadable, unparsable or newer document yields
// an empty one. Callers treat it as a hint and probe what they find.
func Read(path string) Document {
	data, err := os.ReadFile(path)
	if err != nil {
		return Document{}
	}
	var document Document
	if err := json.Unmarshal(data, &document); err != nil || document.Version > Version {
		return Document{}
	}
	return document
}

// Publish replaces one service's record and leaves the others alone.
func Publish(path, service string, record Service) error {
	return write(path, service, &record)
}

// Withdraw removes one service's record on a clean shutdown, so an address
// nothing answers on does not outlive the process that owned it. A file that
// was never written is not an error.
func Withdraw(path, service string) error {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return write(path, service, nil)
}

func write(path, service string, record *Service) error {
	document := Read(path)
	document.Version = Version
	switch service {
	case RuntimeService:
		document.Runtime = record
	case HostService:
		document.Host = record
	default:
		return fmt.Errorf("unknown endpoints service %q", service)
	}
	body, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return writePrivate(path, body)
}

// writePrivate is temp + rename inside the target directory, so a reader never
// sees a half-written document and never sees a world-readable one.
func writePrivate(path string, body []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }()
	if err := temporary.Chmod(0600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
