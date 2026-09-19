import { describe, expect, it } from "vitest";
import { SCHEME_NOT_ALLOWED, isAllowedExternalUrl } from "./external-url";

describe("the external-link allow-list", () => {
  it("lets ordinary web links through", () => {
    for (const url of [
      "http://example.com",
      "https://example.com/path?query=1#fragment",
      "HTTPS://EXAMPLE.COM",
      "http://127.0.0.1:1420/",
    ])
      expect(isAllowedExternalUrl(url), url).toBe(true);
  });

  it("refuses every other scheme, including the ones that open an app", () => {
    for (const url of [
      "file:///etc/passwd",
      "file://~/.ssh/id_ed25519",
      "mailto:someone@example.com",
      "smb://share/secret",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vscode://file/Users/me/project",
      "ftp://example.com",
    ])
      expect(isAllowedExternalUrl(url), url).toBe(false);
  });

  it("refuses anything that is not a parseable URL at all", () => {
    for (const url of ["", "   ", "example.com", "//example.com", "not a url"])
      expect(isAllowedExternalUrl(url), JSON.stringify(url)).toBe(false);
    for (const value of [null, undefined, 42, {}, ["https://example.com"]])
      expect(isAllowedExternalUrl(value), JSON.stringify(value)).toBe(false);
  });

  it("is not fooled by a smuggled scheme", () => {
    // The allowed scheme appears in the string, but it is not the scheme.
    for (const url of [
      "javascript:void(0)//https://example.com",
      "data:text/plain,http://example.com",
    ])
      expect(isAllowedExternalUrl(url), url).toBe(false);
  });

  it("names its refusal code once, for the page to key off", () => {
    expect(SCHEME_NOT_ALLOWED).toBe("scheme_not_allowed");
  });
});
