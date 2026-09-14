package servicedef

import (
	"bytes"
	"errors"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// sample builds a complete Spec rooted in the test's own temporary directory.
// Nothing here reaches the real system: the paths do not have to exist, because
// rendering is a pure text transformation.
func sample(t *testing.T, platform string) Spec {
	t.Helper()
	root := t.TempDir()
	// A launchd or systemd definition carries POSIX paths whatever host renders
	// it; a Windows temporary directory would come out escaped.
	join := filepath.Join
	if platform != PlatformWindows {
		root = filepath.ToSlash(root)
		join = path.Join
	}
	return Spec{
		Identifier:     "local.armadra.host",
		Platform:       platform,
		Executable:     join(root, "bin", "armadra-host"),
		RunAs:          "armadra",
		DataDir:        join(root, "state"),
		LogPath:        join(root, "state", "host.log"),
		Listen:         "127.0.0.1:45991",
		EndpointsDir:   join(root, "state"),
		AllowedOrigins: []string{"https://canvas.example"},
		WorkerBinary:   join(root, "bin", "armadra-runtime"),
		WorkerStateDir: join(root, "worker"),
		Environment:    []string{"ARMADRA_LOG=info"},
	}
}

func TestRenderCarriesConfigurationForEveryPlatform(t *testing.T) {
	for _, platform := range []string{PlatformDarwin, PlatformLinux, PlatformWindows} {
		t.Run(platform, func(t *testing.T) {
			spec := sample(t, platform)
			content, err := Render(spec)
			if err != nil {
				t.Fatal(err)
			}
			text := string(content)
			required := []string{
				spec.Identifier, spec.Executable, spec.RunAs, spec.DataDir,
				spec.Listen, spec.LogPath, spec.WorkerBinary, spec.WorkerStateDir,
				"serve", "--worker-binary", "--worker-state-dir", "--allow-origin",
				"https://canvas.example", "armadra-host install",
			}
			for _, want := range required {
				if !strings.Contains(text, want) {
					t.Fatalf("%s definition is missing %q", platform, want)
				}
			}
			switch platform {
			case PlatformDarwin:
				for _, want := range []string{"<key>RunAtLoad</key>", "<key>KeepAlive</key>", "<key>UserName</key>", "<key>StandardErrorPath</key>", "<key>WorkingDirectory</key>", "<key>EnvironmentVariables</key>"} {
					if !strings.Contains(text, want) {
						t.Fatalf("launchd definition is missing %q", want)
					}
				}
			case PlatformLinux:
				for _, want := range []string{"[Unit]", "[Service]", "[Install]", "Type=simple", "Restart=on-failure", "User=armadra", "NoNewPrivileges=true", "WantedBy=multi-user.target"} {
					if !strings.Contains(text, want) {
						t.Fatalf("systemd unit is missing %q", want)
					}
				}
			case PlatformWindows:
				for _, want := range []string{"sc.exe create", "NOTHING WAS INSTALLED", "obj= \"%ARMADRA_ACCOUNT%\"", "start= auto"} {
					if !strings.Contains(text, want) {
						t.Fatalf("windows script is missing %q", want)
					}
				}
			}
			// A definition is world-readable configuration. Nothing that reads
			// like a credential may appear in it.
			for _, forbidden := range []string{"token", "secret", "password", "bearer"} {
				if strings.Contains(strings.ToLower(text), forbidden) {
					t.Fatalf("%s definition mentions %q", platform, forbidden)
				}
			}
		})
	}
}

func TestGenerateIsDeterministicAndPrivate(t *testing.T) {
	for _, platform := range []string{PlatformDarwin, PlatformLinux, PlatformWindows} {
		t.Run(platform, func(t *testing.T) {
			spec := sample(t, platform)
			// Argument order the operator typed must not change the file.
			shuffled := spec
			shuffled.Environment = []string{"B_VALUE=2", "A_VALUE=1"}
			spec.Environment = []string{"A_VALUE=1", "B_VALUE=2"}
			serviceDir := filepath.Join(t.TempDir(), "definitions")
			first, content, err := Generate(spec, serviceDir)
			if err != nil {
				t.Fatal(err)
			}
			second, again, err := Generate(shuffled, serviceDir)
			if err != nil {
				t.Fatal(err)
			}
			if first != second {
				t.Fatalf("two runs wrote different paths: %s and %s", first, second)
			}
			if !bytes.Equal(content, again) {
				t.Fatal("two runs produced different definitions")
			}
			onDisk, err := os.ReadFile(first)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(onDisk, content) {
				t.Fatal("file content differs from the returned definition")
			}
			if entries, err := os.ReadDir(serviceDir); err != nil {
				t.Fatal(err)
			} else if len(entries) != 1 {
				t.Fatalf("service directory holds %d files, want only the definition", len(entries))
			}
			if runtime.GOOS != "windows" {
				directory, err := os.Lstat(serviceDir)
				if err != nil {
					t.Fatal(err)
				}
				if directory.Mode().Perm() != 0o700 {
					t.Fatalf("service directory is %v, want 0700", directory.Mode().Perm())
				}
				file, err := os.Lstat(first)
				if err != nil {
					t.Fatal(err)
				}
				if file.Mode().Perm() != 0o644 {
					t.Fatalf("definition is %v, want 0644", file.Mode().Perm())
				}
			}
		})
	}
}

func TestNormalizeRefusesUnsafeInputs(t *testing.T) {
	cases := map[string]func(spec *Spec){
		"empty account":        func(spec *Spec) { spec.RunAs = "" },
		"superuser account":    func(spec *Spec) { spec.RunAs = "root" },
		"relative executable":  func(spec *Spec) { spec.Executable = "armadra-host" },
		"credential variable":  func(spec *Spec) { spec.Environment = []string{"ARMADRA_TOKEN=abc"} },
		"password variable":    func(spec *Spec) { spec.Environment = []string{"DB_PASSWORD=abc"} },
		"newline in origin":    func(spec *Spec) { spec.AllowedOrigins = []string{"https://a\nExecStart=/bin/sh"} },
		"half configured tls":  func(spec *Spec) { spec.PublicOrigin = "https://canvas.example" },
		"half configured work": func(spec *Spec) { spec.WorkerStateDir = "" },
		"unknown platform":     func(spec *Spec) { spec.Platform = "plan9" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			spec := sample(t, PlatformLinux)
			mutate(&spec)
			if _, err := Render(spec); !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted %s: %v", name, err)
			}
		})
	}
}

func TestOwnsRejectsForeignDefinition(t *testing.T) {
	spec := sample(t, PlatformLinux)
	content, err := Render(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !Owns(content, spec) {
		t.Fatal("did not recognise its own definition")
	}
	foreign := []byte("[Unit]\nDescription=Someone else's service\n\n[Service]\nExecStart=/usr/bin/true\n")
	if Owns(foreign, spec) {
		t.Fatal("claimed a foreign unit")
	}
	other := spec
	other.Identifier = "local.example.other"
	if Owns(content, other) {
		t.Fatal("matched a definition for another identifier")
	}
	moved := spec
	moved.Executable = filepath.Join(t.TempDir(), "armadra-host")
	if Owns(content, moved) {
		t.Fatal("matched a definition naming another binary")
	}
}

func TestMarkerRoundTrip(t *testing.T) {
	dataDir := t.TempDir()
	if _, err := ReadMarker(dataDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty data directory reported a definition: %v", err)
	}
	spec := sample(t, runtime.GOOS)
	if err := spec.Normalize(); err != nil {
		t.Fatal(err)
	}
	if err := WriteMarker(dataDir, Marker{Spec: spec, Path: filepath.Join(dataDir, spec.FileName())}); err != nil {
		t.Fatal(err)
	}
	marker, err := ReadMarker(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if marker.Spec.RunAs != spec.RunAs || marker.Spec.Executable != spec.Executable {
		t.Fatalf("marker lost its inputs: %+v", marker.Spec)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Lstat(MarkerPath(dataDir))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("marker is %v, want 0600", info.Mode().Perm())
		}
	}
	if err := RemoveMarker(dataDir); err != nil {
		t.Fatal(err)
	}
	if err := RemoveMarker(dataDir); err != nil {
		t.Fatalf("removing an absent marker failed: %v", err)
	}
}
