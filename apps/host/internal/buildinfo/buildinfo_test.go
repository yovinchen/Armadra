package buildinfo

import "testing"

// A binary nobody released must say so. The whole update path hangs on this:
// a development build is never offered an update, and never offers itself as
// an upgrade candidate for a released one.
func TestAnUnstampedBuildIsDevelopment(t *testing.T) {
	restore := func(version, channel, key string) {
		Version, Channel, UpdatesPublicKey = version, channel, key
	}
	defer restore(Version, Channel, UpdatesPublicKey)

	restore("", "", "")
	if ReleaseVersion() != DevelopmentVersion || ReleaseChannel() != ChannelDevelopment {
		t.Fatalf("an unstamped build reported %s/%s", ReleaseVersion(), ReleaseChannel())
	}
	if Released() {
		t.Fatal("an unstamped build claimed to be a release")
	}
	if PublicKey() != "" {
		t.Fatal("an unstamped build produced a public key")
	}
}

// A channel the pipeline did not write is development. A value that cannot be
// read is not evidence of a release.
func TestAnUnknownChannelIsDevelopment(t *testing.T) {
	defer func(version, channel string) { Version, Channel = version, channel }(Version, Channel)
	Version = "0.2.0"
	for _, unknown := range []string{"nightly", "STABLE", "Beta", ""} {
		Channel = unknown
		if ReleaseChannel() != ChannelDevelopment {
			t.Fatalf("channel %q was read as %q", unknown, ReleaseChannel())
		}
		if Released() {
			t.Fatalf("channel %q was treated as a release", unknown)
		}
	}
}

func TestAStampedBuildReportsItsRelease(t *testing.T) {
	defer func(version, channel, key string) {
		Version, Channel, UpdatesPublicKey = version, channel, key
	}(Version, Channel, UpdatesPublicKey)
	// The pipeline stamps the tag; the leading "v" is not part of a version.
	Version, Channel, UpdatesPublicKey = "v0.2.0-beta.1", ChannelBeta, "  RWQf6LRCGA9i53  "
	if ReleaseVersion() != "0.2.0-beta.1" || ReleaseChannel() != ChannelBeta || !Released() {
		t.Fatalf("a stamped build reported %s/%s released=%v", ReleaseVersion(), ReleaseChannel(), Released())
	}
	if PublicKey() != "RWQf6LRCGA9i53" {
		t.Fatalf("public key was not trimmed: %q", PublicKey())
	}
}
