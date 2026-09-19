import { describe, expect, it } from "vitest";

import {
  BROWSER_PATH_ENV,
  browserCandidates,
  discoverBrowser,
} from "./discover";

/**
 * Discovery has to answer on a machine with no browser, which is every CI
 * runner, so `exists` is injected and every case below is a fixed answer to a
 * fixed question.
 */

const none = () => false;

describe("finding a browser", () => {
  it("takes the configured path first, whatever else is installed", () => {
    const found = discoverBrowser(
      { [BROWSER_PATH_ENV]: "/opt/my-chrome" },
      "linux",
      (path) => path === "/opt/my-chrome" || path === "/usr/bin/chromium",
    );
    expect(found).toEqual({
      path: "/opt/my-chrome",
      source: "env",
      searched: ["/opt/my-chrome"],
    });
  });

  it("does not quietly fall back when the configured path is missing", () => {
    // Somebody named a browser. Starting a different one is worse than saying
    // the named one is not there: profiles, extensions and logins differ.
    const found = discoverBrowser(
      { [BROWSER_PATH_ENV]: "/opt/my-chrome" },
      "linux",
      (path) => path === "/usr/bin/chromium",
    );
    expect(found.path).toBeUndefined();
    expect(found.source).toBe("none");
    expect(found.searched).toEqual(["/opt/my-chrome"]);
  });

  it("walks this platform's install paths in order", () => {
    const found = discoverBrowser(
      {},
      "linux",
      (path) => path === "/usr/bin/chromium",
    );
    expect(found.path).toBe("/usr/bin/chromium");
    expect(found.source).toBe("installed");
    // Everything it looked at, including the ones before the hit: `status`
    // reports this verbatim so an operator can see where to install one.
    expect(found.searched[0]).toBe("/usr/bin/google-chrome");
  });

  it("reports where it looked when there is nothing to find", () => {
    const found = discoverBrowser({}, "darwin", none);
    expect(found.source).toBe("none");
    expect(found.path).toBeUndefined();
    expect(found.searched.length).toBeGreaterThan(0);
  });

  it("knows the three platforms' candidates apart", () => {
    expect(browserCandidates("darwin")[0]).toContain("Google Chrome.app");
    expect(browserCandidates("win32", { PROGRAMFILES: "C:\\PF" })[0]).toBe(
      "C:\\PF\\Google\\Chrome\\Application\\chrome.exe",
    );
    expect(browserCandidates("linux")).toContain("/usr/bin/chromium");
  });

  it("downloads nothing", () => {
    // Stated as a test because it is a decision, not an omission: a service
    // that fetches a browser on first use does it on the machine with no
    // egress, at the moment somebody wanted to look at a page.
    const source = discoverBrowser({}, "linux", none);
    expect(source.source).toBe("none");
  });
});
