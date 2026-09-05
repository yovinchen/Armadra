// Package buildinfo carries what the release pipeline stamped into this
// binary: which version it is, which channel produced it, and the public key
// its signed release artifacts can be verified against.
//
// Every value is a build-time constant injected with -ldflags -X, and every
// default is the honest answer for a binary nobody released. A locally built
// Host therefore reports the development channel and holds no public key, so
// it never offers itself an update and never accepts a download it could not
// verify. Nothing here is a secret: a public key is public, and a version is
// printed by `armadra-host version`.
package buildinfo

import "strings"

// Channel names. They are the spelling the release channel enum uses, so the
// value can be compared without a translation table.
const (
	ChannelStable      = "stable"
	ChannelBeta        = "beta"
	ChannelDevelopment = "development"
)

// DevelopmentVersion is what an unstamped build reports. It sorts below every
// released version, so an upgrade never mistakes a local build for a newer one.
const DevelopmentVersion = "0.0.0-development"

// Values injected at link time. They are variables rather than constants
// because -ldflags -X can only write to variables.
var (
	// Version is the release this binary was built from, e.g. "0.2.0" or
	// "0.2.0-beta.1", without the tag's leading "v".
	Version = DevelopmentVersion
	// Channel is stable, beta or development. An unrecognised value is read as
	// development: a build whose provenance cannot be read is not a release.
	Channel = ChannelDevelopment
	// UpdatesPublicKey is the minisign public key line the release pipeline
	// signs artifacts with — the second line of a minisign .pub file, base64.
	// Empty means this build holds no key, and an upgrade that would have to
	// verify a signature refuses rather than skipping verification.
	UpdatesPublicKey = ""
)

// ReleaseChannel is the channel this build belongs to, normalised. Anything
// the pipeline did not write is development.
func ReleaseChannel() string {
	switch strings.TrimSpace(Channel) {
	case ChannelStable:
		return ChannelStable
	case ChannelBeta:
		return ChannelBeta
	default:
		return ChannelDevelopment
	}
}

// ReleaseVersion is the stamped version, or the development placeholder when
// the pipeline wrote nothing.
func ReleaseVersion() string {
	value := strings.TrimSpace(Version)
	if value == "" {
		return DevelopmentVersion
	}
	return strings.TrimPrefix(value, "v")
}

// Released reports whether this binary came out of the release pipeline. A
// build that did not is never offered an update and never publishes itself as
// an upgrade candidate.
func Released() bool {
	return ReleaseChannel() != ChannelDevelopment && ReleaseVersion() != DevelopmentVersion
}

// PublicKey is the minisign public key this build verifies release artifacts
// with, or "" when it holds none.
func PublicKey() string { return strings.TrimSpace(UpdatesPublicKey) }
