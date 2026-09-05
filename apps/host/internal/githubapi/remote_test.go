package githubapi

import "testing"

// Which service a remote belongs to is decided locally, before any request.
// Getting this wrong would send an enterprise repository's name, and this
// Host's token, to the public service.
func TestRemoteParsingAndServiceOwnership(t *testing.T) {
	for name, expected := range map[string]Repository{
		"https://github.com/owner/repo.git":         {Owner: "owner", Name: "repo", WebHost: "github.com"},
		"https://github.com/owner/repo":             {Owner: "owner", Name: "repo", WebHost: "github.com"},
		"git@github.com:owner/repo.git":             {Owner: "owner", Name: "repo", WebHost: "github.com"},
		"ssh://git@ghe.example.com/team/service":    {Owner: "team", Name: "service", WebHost: "ghe.example.com"},
		"git@ghe.example.com:team/service.git":      {Owner: "team", Name: "service", WebHost: "ghe.example.com"},
		"https://GHE.Example.COM/team/service.git/": {Owner: "team", Name: "service", WebHost: "ghe.example.com"},
		// Some enterprise deployments prefix a path; the repository is always
		// the last two segments.
		"https://ghe.example.com/git/team/service.git": {Owner: "team", Name: "service", WebHost: "ghe.example.com"},
	} {
		parsed, err := ParseRemote(name)
		if err != nil || parsed != expected {
			t.Fatalf("%s parsed as %+v (%v)", name, parsed, err)
		}
	}
	for _, invalid := range []string{
		"", "github.com/owner/repo", "https://github.com/owner", "https://github.com/",
		"file:///tmp/repo/owner/name", "https://github.com/-bad/repo", "git@:owner/repo",
		// A trailing newline is trimmed, because remotes are commonly read from
		// a command's output; an embedded one is not a URL at all.
		"https://github.com/owner/re\npo", "https://github.com/ow ner/repo",
	} {
		if _, err := ParseRemote(invalid); err == nil {
			t.Fatalf("%q was accepted as a remote", invalid)
		}
	}
}

func TestAPIBaseNormalizationRefusesAnythingButAnHTTPSBase(t *testing.T) {
	for value, expected := range map[string]string{
		"":                                 PublicAPIBase,
		"https://api.github.com":           PublicAPIBase,
		"https://api.github.com/":          PublicAPIBase,
		"https://ghe.example.com/api/v3":   "https://ghe.example.com/api/v3",
		"https://ghe.example.com/api/v3/":  "https://ghe.example.com/api/v3",
		"https://GHE.example.com:8443/api": "https://ghe.example.com:8443/api",
	} {
		normalized, err := NormalizeAPIBase(value)
		if err != nil || normalized != expected {
			t.Fatalf("%q normalized to %q (%v)", value, normalized, err)
		}
	}
	// An http base would put the bearer token on the wire in clear text, and a
	// base carrying credentials or a query is not a base.
	for _, invalid := range []string{
		"http://ghe.example.com/api/v3", "https://user:pass@ghe.example.com/api",
		"https://ghe.example.com/api?x=1", "https://ghe.example.com/api#f",
		"ftp://ghe.example.com", "https://", "https://ghe.example.com/api/../../x",
	} {
		if _, err := NormalizeAPIBase(invalid); err == nil {
			t.Fatalf("%q was accepted as an API base", invalid)
		}
	}
}

func TestEnterpriseRemotesNeverBelongToThePublicService(t *testing.T) {
	if !BelongsTo(PublicAPIBase, "github.com") || !BelongsTo(PublicAPIBase, "www.github.com") {
		t.Fatal("public remotes must belong to the public API base")
	}
	if BelongsTo(PublicAPIBase, "ghe.example.com") {
		t.Fatal("an enterprise remote was accepted against the public service")
	}
	enterprise := "https://ghe.example.com/api/v3"
	if !BelongsTo(enterprise, "ghe.example.com") {
		t.Fatal("the enterprise remote must belong to its own base")
	}
	// A public repository must not be resolved against an enterprise base either:
	// the check is symmetric, not a one-way guard.
	if BelongsTo(enterprise, "github.com") {
		t.Fatal("a public remote was accepted against an enterprise base")
	}
	if WebHostFor(PublicAPIBase) != "github.com" || WebHostFor(enterprise) != "ghe.example.com" {
		t.Fatal("web host does not follow the API base")
	}
}

func TestNextPageReadsOnlyAPageNumber(t *testing.T) {
	link := `<https://api.github.com/repos/o/r/issues?page=3>; rel="next", <https://api.github.com/repos/o/r/issues?page=9>; rel="last"`
	if page := nextPage(link); page != 3 {
		t.Fatalf("next page was %d", page)
	}
	// A Link header cannot steer the next request anywhere: only the page number
	// is ever read, and a header without a usable one yields none at all. The
	// foreign authority below is discarded with everything else in the URL.
	for _, hostile := range []string{
		`<https://evil.example.com/x>; rel="next"`,
		`<https://api.github.com/repos/o/r/issues>; rel="next"`,
		`<https://api.github.com/x?page=0>; rel="next"`,
		`<https://api.github.com/x?page=abc>; rel="next"`,
		"", `<https://api.github.com/x?page=2>; rel="prev"`,
	} {
		if page := nextPage(hostile); page != 0 {
			t.Fatalf("%q yielded page %d", hostile, page)
		}
	}
	// The number survives even when the URL names another host, because the
	// number is all that is kept.
	if page := nextPage(`<https://evil.example.com/x?page=4>; rel="next"`); page != 4 {
		t.Fatalf("page number was not extracted independently of the URL: %d", page)
	}
}
