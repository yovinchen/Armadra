package updates

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// Every test serves its own artifact from an httptest server. Nothing here
// reaches a release host: a download test that needs the network stops testing
// the moment the network is down.

type assetHost struct {
	server *httptest.Server
	// faults reproduce what a real host does: a wrong length, a body that stops
	// early, and bytes that changed after the release index was written.
	truncate bool
	corrupt  bool
	lie      int64
	status   int
	body     []byte
}

func serveArtifact(t *testing.T, body []byte) *assetHost {
	t.Helper()
	r := &assetHost{body: body}
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if r.status != 0 {
			w.WriteHeader(r.status)
			return
		}
		payload := r.body
		if r.corrupt {
			payload = append([]byte{}, r.body...)
			payload[0] ^= 0xff
		}
		length := int64(len(payload))
		if r.lie != 0 {
			length = r.lie
		}
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		if r.truncate {
			_, _ = w.Write(payload[:len(payload)/2])
			// Dropping the connection is what an interrupted download looks
			// like; a body that simply ends short would be a framing error the
			// transport reports differently on every platform.
			if hijacker, ok := w.(http.Hijacker); ok {
				connection, _, err := hijacker.Hijack()
				if err == nil {
					connection.Close()
				}
			}
			return
		}
		_, _ = w.Write(payload)
	}))
	t.Cleanup(r.server.Close)
	return r
}

func artifactFrom(r *assetHost, name string, sum []byte, size uint64, signed bool) *pb.UpdateArtifact {
	artifact := &pb.UpdateArtifact{
		Url:       r.server.URL + "/download/" + name,
		SizeBytes: size,
		Sha256:    sum,
		Signature: &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_ABSENT},
		Component: ComponentHost,
	}
	if signed {
		artifact.Signature = &pb.UpdateSignature{State: pb.UpdateSignatureState_UPDATE_SIGNATURE_STATE_PRESENT}
	}
	return artifact
}

func TestFetchWritesTheArtifactAndItsSignature(t *testing.T) {
	body := []byte("armadra-host archive bytes\n")
	sum := sha256.Sum256(body)
	r := serveArtifact(t, body)
	directory := t.TempDir()
	artifact := artifactFrom(r, "armadra-host_0.2.0_linux-x86_64.tar.gz", sum[:], uint64(len(body)), true)
	downloaded, err := Fetch(context.Background(), r.server.Client(), artifact, directory)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(downloaded.Path) != "armadra-host_0.2.0_linux-x86_64.tar.gz" {
		t.Fatalf("wrote %s", downloaded.Path)
	}
	if downloaded.Bytes != uint64(len(body)) {
		t.Fatalf("reported %d bytes", downloaded.Bytes)
	}
	// A release that says a signature exists gets one fetched; one that says
	// ABSENT never has a `.sig` invented for it.
	if downloaded.SignaturePath == "" {
		t.Fatal("a PRESENT signature was not fetched")
	}
	unsigned := artifactFrom(r, "armadra-hook_0.2.0_linux-x86_64.tar.gz", sum[:], uint64(len(body)), false)
	plain, err := Fetch(context.Background(), r.server.Client(), unsigned, directory)
	if err != nil {
		t.Fatal(err)
	}
	if plain.SignaturePath != "" {
		t.Fatal("a signature was fetched for an artifact that declares none")
	}
}

// Every one of these leaves nothing on disk. A partial or wrong download that
// stayed behind is a file some later step might install.
func TestFetchRefusalsLeaveNothingBehind(t *testing.T) {
	body := []byte("armadra-host archive bytes\n")
	sum := sha256.Sum256(body)
	cases := map[string]func(r *assetHost) *pb.UpdateArtifact{
		"digest mismatch": func(r *assetHost) *pb.UpdateArtifact {
			r.corrupt = true
			return artifactFrom(r, "asset.tar.gz", sum[:], uint64(len(body)), false)
		},
		"truncated body": func(r *assetHost) *pb.UpdateArtifact {
			r.truncate = true
			return artifactFrom(r, "asset.tar.gz", sum[:], uint64(len(body)), false)
		},
		"declared length disagrees": func(r *assetHost) *pb.UpdateArtifact {
			return artifactFrom(r, "asset.tar.gz", sum[:], uint64(len(body))+10, false)
		},
		"source unreachable": func(r *assetHost) *pb.UpdateArtifact {
			r.status = http.StatusNotFound
			return artifactFrom(r, "asset.tar.gz", sum[:], uint64(len(body)), false)
		},
		"no published digest": func(r *assetHost) *pb.UpdateArtifact {
			return artifactFrom(r, "asset.tar.gz", nil, uint64(len(body)), false)
		},
		"implausible size": func(r *assetHost) *pb.UpdateArtifact {
			return artifactFrom(r, "asset.tar.gz", sum[:], MaxArtifactBytes+1, false)
		},
		"zero size": func(r *assetHost) *pb.UpdateArtifact {
			return artifactFrom(r, "asset.tar.gz", sum[:], 0, false)
		},
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			r := serveArtifact(t, body)
			directory := t.TempDir()
			if _, err := Fetch(context.Background(), r.server.Client(), build(r), directory); err == nil {
				t.Fatalf("accepted %s", name)
			}
			entries, err := os.ReadDir(directory)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("%s left %d file(s) behind", name, len(entries))
			}
		})
	}
}

// A URL that names no file has nothing to check a signature's trusted comment
// against, so it is refused before a single byte is fetched.
func TestFetchRefusesAnArtifactWithNoFileName(t *testing.T) {
	r := serveArtifact(t, []byte("x"))
	sum := sha256.Sum256([]byte("x"))
	for _, url := range []string{"", r.server.URL + "/", r.server.URL} {
		artifact := &pb.UpdateArtifact{Url: url, SizeBytes: 1, Sha256: sum[:]}
		if _, err := Fetch(context.Background(), r.server.Client(), artifact, t.TempDir()); !errors.Is(err, ErrDownload) {
			t.Fatalf("accepted %q: %v", url, err)
		}
	}
}

func TestAssetNameIsReadFromTheURL(t *testing.T) {
	for url, want := range map[string]string{
		"https://example.invalid/download/v0.2.0/armadra-host_0.2.0_linux-x86_64.tar.gz": "armadra-host_0.2.0_linux-x86_64.tar.gz",
		"https://example.invalid/download/v0.2.0/armadra-web_0.2.0.tar.gz":               "armadra-web_0.2.0.tar.gz",
		"https://example.invalid/latest.json":                                            "latest.json",
		"https://example.invalid/":                                                       "",
		"https://example.invalid":                                                        "",
	} {
		if got := AssetName(url); got != want {
			t.Fatalf("%s produced %q, expected %q", url, got, want)
		}
	}
}
