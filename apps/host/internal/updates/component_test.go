package updates

import (
	"context"
	"testing"

	pb "armadra.local/host/gen/armadra/v1"
)

// One release publishes several programs for the same target. Before the
// component field the first artifact whose target matched won, so a Host
// asking to upgrade itself could be handed the desktop bundle.

func TestAssetNamesDeclareTheirComponent(t *testing.T) {
	for name, want := range map[string]string{
		"Armadra_0.2.0_darwin-aarch64.dmg":                  ComponentDesktop,
		"Armadra_0.2.0_windows-x86_64-setup.exe":            ComponentDesktop,
		"armadra-host_0.2.0_linux-x86_64.tar.gz":            ComponentHost,
		"armadra-runtime_0.2.0_linux-x86_64.tar.gz":         ComponentWorker,
		"armadra-worker_0.2.0_linux-x86_64.tar.gz":          ComponentWorker,
		"armadra-hook_0.2.0_darwin-aarch64.tar.gz":          ComponentHook,
		"armadra-session-host_0.2.0_windows-x86_64.zip":     ComponentSessionHost,
		"armadra-web_0.2.0.tar.gz":                          ComponentWeb,
		"latest.json":                                       ComponentManifest,
		"SHA256SUMS":                                        ComponentManifest,
		"notes.txt":                                         "",
		"armadra-something-else_0.2.0_linux-x86_64.tar.gz":  "",
		"prefixarmadra-host_0.2.0_linux-x86_64.tar.gz":      "",
		"armadra-host-0.2.0-linux-x86_64.tar.gz":            "",
		"SHA256SUMS.other":                                  "",
		"armadra-session-host_0.2.0_windows-aarch64.tar.gz": ComponentSessionHost,
	} {
		if got := assetComponent(name); got != want {
			t.Fatalf("%s declared component %q, expected %q", name, got, want)
		}
	}
}

func TestValidComponentAcceptsOnlyPublishedNames(t *testing.T) {
	for _, name := range []string{ComponentDesktop, ComponentHost, ComponentWorker, ComponentHook, ComponentSessionHost, ComponentWeb, ComponentManifest} {
		if !ValidComponent(name) {
			t.Fatalf("refused the published component %q", name)
		}
	}
	for _, name := range []string{"", "Desktop", "runtime", "armadra-host", "manifest "} {
		if ValidComponent(name) {
			t.Fatalf("accepted %q as a component", name)
		}
	}
}

// The release below is the shape §1.2 publishes: one target carrying four
// programs plus two platform-independent files.
func componentRelease() string {
	return index(releaseJSON("v0.2.0", false, compatibilityNote("0.1.0", "", 1, 0),
		"Armadra_0.2.0_darwin-aarch64.dmg",
		"armadra-host_0.2.0_darwin-aarch64.tar.gz",
		"armadra-runtime_0.2.0_darwin-aarch64.tar.gz",
		"armadra-hook_0.2.0_darwin-aarch64.tar.gz",
		"armadra-host_0.2.0_linux-x86_64.tar.gz",
		"armadra-web_0.2.0.tar.gz",
		"latest.json",
		"SHA256SUMS",
	))
}

func checkComponent(t *testing.T, service *Service, target, component string) *pb.CheckForUpdateResponse {
	t.Helper()
	installed, err := ParseVersion("0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	response, err := service.Check(context.Background(), &pb.CheckForUpdateRequest{
		InstalledVersion: installed,
		Target:           target,
		Component:        component,
	})
	if err != nil {
		t.Fatalf("check returned an error instead of a state: %v", err)
	}
	return response
}

func TestCheckAnswersAboutTheRequestedComponent(t *testing.T) {
	f := newFixture(t, componentRelease(), Options{})
	for _, want := range []struct {
		component string
		target    string
		asset     string
	}{
		{ComponentDesktop, "darwin-aarch64", "Armadra_0.2.0_darwin-aarch64.dmg"},
		{ComponentHost, "darwin-aarch64", "armadra-host_0.2.0_darwin-aarch64.tar.gz"},
		{ComponentHost, "linux-x86_64", "armadra-host_0.2.0_linux-x86_64.tar.gz"},
		{ComponentWorker, "darwin-aarch64", "armadra-runtime_0.2.0_darwin-aarch64.tar.gz"},
		{ComponentHook, "darwin-aarch64", "armadra-hook_0.2.0_darwin-aarch64.tar.gz"},
		// Platform-independent files answer any target.
		{ComponentWeb, "windows-x86_64", "armadra-web_0.2.0.tar.gz"},
		{ComponentManifest, "linux-x86_64", "latest.json"},
	} {
		response := checkComponent(t, f.service, want.target, want.component)
		expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE, "")
		artifacts := response.GetRelease().GetArtifacts()
		if len(artifacts) != 1 {
			t.Fatalf("%s/%s was offered %d artifacts", want.component, want.target, len(artifacts))
		}
		if artifacts[0].GetComponent() != want.component {
			t.Fatalf("asked for %s, got component %q", want.component, artifacts[0].GetComponent())
		}
		if got := artifacts[0].GetUrl(); got != "https://releases.invalid/"+want.asset {
			t.Fatalf("%s/%s was offered %s", want.component, want.target, got)
		}
	}
}

// An empty component is the desktop bundle: the shell was the only caller
// before protocol minor 2, and it never sent the field.
func TestAnAbsentComponentStillMeansTheDesktopBundle(t *testing.T) {
	f := newFixture(t, componentRelease(), Options{})
	response := checkComponent(t, f.service, "darwin-aarch64", "")
	expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_AVAILABLE, "")
	if got := response.GetRelease().GetArtifacts()[0].GetComponent(); got != ComponentDesktop {
		t.Fatalf("an absent component resolved to %q", got)
	}
}

// A release that carries a program for another target, or no program of that
// kind at all, is reported — never answered with somebody else's artifact.
func TestMissingComponentIsReportedRatherThanSubstituted(t *testing.T) {
	f := newFixture(t, componentRelease(), Options{})
	for _, absent := range []struct{ target, component string }{
		{"windows-x86_64", ComponentDesktop},
		{"darwin-aarch64", ComponentSessionHost},
		{"linux-x86_64", ComponentWorker},
	} {
		response := checkComponent(t, f.service, absent.target, absent.component)
		expect(t, response, pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonNoArtifact)
	}
}

// A component name nobody publishes is a caller error. Widening it to the
// desktop bundle would offer the wrong program to a caller that asked
// precisely because it did not want the default.
func TestUnknownComponentIsARequestError(t *testing.T) {
	f := newFixture(t, componentRelease(), Options{})
	installed, err := ParseVersion("0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Check(context.Background(), &pb.CheckForUpdateRequest{
		InstalledVersion: installed,
		Target:           "darwin-aarch64",
		Component:        "runtime",
	})
	if err == nil {
		t.Fatal("an unknown component was answered instead of refused")
	}
}

// A per-target program whose asset name this Host cannot place is not a file
// that runs everywhere. Only the manifest and the web bundle are published
// once for every platform.
func TestOnlyManifestAndWebAnswerWithoutATarget(t *testing.T) {
	body := index(releaseJSON("v0.2.0", false, compatibilityNote("0.1.0", "", 1, 0), "Armadra_0.2.0_plan9-mips.tar.gz"))
	f := newFixture(t, body, Options{})
	expect(t, checkComponent(t, f.service, "darwin-aarch64", ComponentDesktop), pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonNoArtifact)
	if !TargetlessComponent(ComponentManifest) || !TargetlessComponent(ComponentWeb) {
		t.Fatal("the platform-independent components changed")
	}
	for _, perTarget := range []string{ComponentDesktop, ComponentHost, ComponentWorker, ComponentHook, ComponentSessionHost} {
		if TargetlessComponent(perTarget) {
			t.Fatalf("%s was treated as platform-independent", perTarget)
		}
	}
}

// An asset whose name follows no published convention carries no component,
// so nothing matches it. A file dropped into a release by hand is never
// offered as if it were a program this Host knows how to install.
func TestUnrecognisedAssetsAreNeverOffered(t *testing.T) {
	body := index(releaseJSON("v0.2.0", false, compatibilityNote("0.1.0", "", 1, 0), "surprise_0.2.0_darwin-aarch64.tar.gz"))
	f := newFixture(t, body, Options{})
	expect(t, checkComponent(t, f.service, "darwin-aarch64", ComponentDesktop), pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonNoArtifact)
	expect(t, checkComponent(t, f.service, "darwin-aarch64", ComponentHost), pb.UpdateCheckState_UPDATE_CHECK_STATE_UNAVAILABLE, ReasonNoArtifact)
}
