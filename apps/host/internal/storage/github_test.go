package storage

import (
	"errors"
	"testing"
)

func githubStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.TempDir(), "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func repositoryKey() GithubRepositoryKey {
	return GithubRepositoryKey{Owner: "owner", Name: "repo", APIBase: "https://ghe.example.com/api/v3", WebHost: "ghe.example.com"}
}

// The configuration row records where a token comes from and where it is kept.
// It must never be able to describe a state that is not true — a source with no
// secret at rest cannot carry a reference, and a stored token must have one.
func TestGithubConfigCannotDescribeAnImpossibleCredential(t *testing.T) {
	store := githubStore(t)
	for name, record := range map[string]GithubConfig{
		"gh source with a secret reference": {Source: GithubSourceGhCLI, APIBase: "https://api.github.com", SecretStore: GithubStoreNone, SecretRef: "api@api.github.com", CreatedAtMS: 1, UpdatedAtMS: 1},
		"stored token with no reference":    {Source: GithubSourceTokenRef, APIBase: "https://api.github.com", SecretStore: GithubStoreOSKeychain, CreatedAtMS: 1, UpdatedAtMS: 1},
		"gh source with a secret store":     {Source: GithubSourceGhCLI, APIBase: "https://api.github.com", SecretStore: GithubStoreOSKeychain, CreatedAtMS: 1, UpdatedAtMS: 1},
		"unknown source":                    {Source: "other", APIBase: "https://api.github.com", SecretStore: GithubStoreNone, CreatedAtMS: 1, UpdatedAtMS: 1},
		"no api base":                       {Source: GithubSourceNone, SecretStore: GithubStoreNone, CreatedAtMS: 1, UpdatedAtMS: 1},
	} {
		if _, err := store.PutGithubConfig(testContext, record, 0); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s was accepted: %v", name, err)
		}
	}
	valid := GithubConfig{Source: GithubSourceTokenRef, APIBase: "https://ghe.example.com/api/v3", SecretStore: GithubStoreFileFallback, SecretRef: "api@ghe.example.com", AccountLogin: "octo-user", CreatedAtMS: 1, UpdatedAtMS: 1}
	stored, err := store.PutGithubConfig(testContext, valid, 0)
	if err != nil || stored.Revision != 1 {
		t.Fatalf("valid configuration stored as %+v (%v)", stored, err)
	}
	// A second write at revision zero is a conflict, so two settings pages
	// cannot silently overwrite one another.
	if _, err = store.PutGithubConfig(testContext, valid, 0); !errors.Is(err, ErrConflict) {
		t.Fatalf("a stale write reported %v", err)
	}
	valid.AccountLogin = "another"
	updated, err := store.PutGithubConfig(testContext, valid, 1)
	if err != nil || updated.Revision != 2 || updated.CreatedAtMS != 1 {
		t.Fatalf("update produced %+v (%v)", updated, err)
	}
	read, err := store.GithubConfig(testContext)
	if err != nil || read.AccountLogin != "another" || read.Revision != 2 {
		t.Fatalf("read back %+v (%v)", read, err)
	}
}

func TestGithubStatusMappingIsKeyedByRepositoryAndBase(t *testing.T) {
	store := githubStore(t)
	record := GithubStatusMappingRecord{WorkspaceID: "workspace", Repository: repositoryKey(), Mapping: []byte{1, 2, 3}, CreatedAtMS: 1, UpdatedAtMS: 1}
	stored, err := store.PutGithubStatusMapping(testContext, record, 0)
	if err != nil || stored.Revision != 1 {
		t.Fatalf("mapping stored as %+v (%v)", stored, err)
	}
	// A public repository with the same owner and name is a different record:
	// the API base is part of the key, not decoration.
	public := record
	public.Repository.APIBase = "https://api.github.com"
	public.Repository.WebHost = "github.com"
	public.Mapping = []byte{9}
	if _, err = store.PutGithubStatusMapping(testContext, public, 0); err != nil {
		t.Fatal(err)
	}
	enterprise, err := store.GithubStatusMapping(testContext, "workspace", repositoryKey())
	if err != nil || string(enterprise.Mapping) != string([]byte{1, 2, 3}) {
		t.Fatalf("enterprise mapping read back as %+v (%v)", enterprise, err)
	}
	if _, err = store.PutGithubStatusMapping(testContext, record, 0); !errors.Is(err, ErrConflict) {
		t.Fatalf("a stale mapping write reported %v", err)
	}
	if _, err = store.GithubStatusMapping(testContext, "another", repositoryKey()); !errors.Is(err, ErrNotFound) {
		t.Fatal("a mapping leaked into another workspace")
	}
}

// A reference is a badge. It may be retargeted at another local node, but never
// silently re-pointed at a different remote object.
func TestGithubReferencesStayBoundToTheirRemoteObject(t *testing.T) {
	store := githubStore(t)
	record := GithubReferenceRecord{
		ReferenceID: "ref-1", WorkspaceID: "workspace", Repository: repositoryKey(),
		Kind: GithubReferenceIssue, Number: 7, TargetKind: GithubTargetSession, TargetID: "node-1",
		Title: "修复上传", CreatedAtMS: 1, UpdatedAtMS: 1,
	}
	stored, err := store.PutGithubReference(testContext, record, 0)
	if err != nil || stored.Revision != 1 {
		t.Fatalf("reference stored as %+v (%v)", stored, err)
	}
	moved := record
	moved.TargetID = "node-2"
	moved.UpdatedAtMS = 2
	if _, err = store.PutGithubReference(testContext, moved, 1); err != nil {
		t.Fatalf("retargeting a reference failed: %v", err)
	}
	repointed := moved
	repointed.Number = 8
	repointed.Revision = 0
	if _, err = store.PutGithubReference(testContext, repointed, 2); !errors.Is(err, ErrConflict) {
		t.Fatal("a reference was re-pointed at another Issue")
	}
	elsewhere := moved
	elsewhere.WorkspaceID = "another"
	if _, err = store.PutGithubReference(testContext, elsewhere, 2); !errors.Is(err, ErrConflict) {
		t.Fatal("a reference was moved to another workspace")
	}
	page, err := store.GithubReferences(testContext, "workspace", "node-2", "", 10)
	if err != nil || len(page) != 1 {
		t.Fatalf("listing returned %d records (%v)", len(page), err)
	}
	if none, err := store.GithubReferences(testContext, "workspace", "node-1", "", 10); err != nil || len(none) != 0 {
		t.Fatalf("the old target still had %d records (%v)", len(none), err)
	}
	if err = store.DeleteGithubReference(testContext, "workspace", "ref-1", 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("a stale delete reported %v", err)
	}
	if err = store.DeleteGithubReference(testContext, "workspace", "ref-1", 2); err != nil {
		t.Fatal(err)
	}
	if remaining, err := store.GithubReferences(testContext, "workspace", "", "", 10); err != nil || len(remaining) != 0 {
		t.Fatalf("%d references survived deletion (%v)", len(remaining), err)
	}
}
