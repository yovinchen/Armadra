import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path, { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_METHODS,
  FORBIDDEN_METHODS,
  NETWORK_METHODS,
} from "../../core/browser/cdp/allowlist";

/**
 * The structural guard on the CDP boundary.
 *
 * The allowlist in `core/browser/cdp/allowlist.ts` is a security boundary for
 * exactly as long as every command passes through it. A second place that calls
 * `sendCommand` is not a bug in the allowlist; it is the allowlist ceasing to
 * be one, silently, in a diff that looks like plumbing. So the call site is
 * pinned by a scan, and the scan carries its own positive and negative samples
 * so a regex that stopped matching cannot pass by matching nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..");

function walk(dir: string, pathModule: typeof path, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = pathModule.join(prefix, entry.name);
    if (entry.isDirectory())
      return walk(join(dir, entry.name), pathModule, relativePath);
    return relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")
      ? [relativePath]
      : [];
  });
}

const CALL = /\.sendCommand\s*\(/;
const ATTACH = /\.debugger\b|\bdebugger\.attach\s*\(/;

describe.each([
  { label: "native", pathModule: path },
  { label: "POSIX", pathModule: posix },
  { label: "Windows", pathModule: win32 },
])("the CDP call site ($label)", ({ pathModule }) => {
  const files = walk(src, pathModule).filter(
    (file) => !file.endsWith(".test.ts"),
  );
  const readSource = (file: string) =>
    readFileSync(join(src, ...file.split(pathModule.sep)), "utf8");

  it("exists in exactly one file", () => {
    const callers = files.filter((file) => CALL.test(readSource(file)));
    expect(callers).toEqual([pathModule.join("main", "browser", "cdp.ts")]);
  });

  it("reaches the debugger from that one file only", () => {
    const users = files.filter((file) => ATTACH.test(readSource(file)));
    expect(users).toEqual([pathModule.join("main", "browser", "cdp.ts")]);
  });

  it("the regexes match what they are meant to and nothing else", () => {
    for (const sample of [
      "await contents.debugger.sendCommand('Runtime.evaluate', {})",
      "dbg.sendCommand ( 'x' )",
      "this.dbg.sendCommand(method, params)",
    ]) {
      expect(CALL.test(sample), sample).toBe(true);
    }
    for (const sample of [
      "session.send('Page.navigate', {})",
      "// sendCommand is not called here",
      "const sendCommandName = 'x'",
    ]) {
      expect(CALL.test(sample), sample).toBe(false);
    }
  });

  it("nobody evaluates JavaScript in a page by any other door", () => {
    for (const file of files) {
      const source = readSource(file);
      for (const door of [
        "executeJavaScript(",
        "insertCSS(",
        "webFrame.",
        "eval(",
      ]) {
        expect(source.includes(door), `${file} contains ${door}`).toBe(false);
      }
    }
  });

  it("the words Runtime.evaluate appear only where they are refused", () => {
    const mentions = files.filter((file) =>
      readSource(file).includes("Runtime.evaluate"),
    );
    expect(mentions).toEqual([
      pathModule.join("core", "browser", "cdp", "allowlist.ts"),
    ]);
  });

  it("the allowlist reaches the network only to listen", () => {
    // `read --mode network` needs the request events, so the Network domain
    // is in the table — as exactly its two subscriptions. Everything that
    // RETURNS something (a body, a post payload, a cookie, a certificate) or
    // changes the traffic stays out: a page given a session cookie for
    // accounts.google.com could turn the next human visit into somebody
    // else's login, and a response body is where the tokens are.
    const network = ALLOWED_METHODS.filter((method) =>
      method.startsWith("Network."),
    );
    expect(network).toEqual([...NETWORK_METHODS]);
    expect(network).toEqual(["Network.enable", "Network.disable"]);
    for (const reader of [
      "Network.getResponseBody",
      "Network.getRequestPostData",
      "Network.getCookies",
      "Network.getAllCookies",
      "Network.setCookie",
      "Network.setCookies",
      "Network.deleteCookies",
      "Network.clearBrowserCookies",
      "Network.searchInResponseBody",
      "Network.takeResponseBodyForInterceptionAsStream",
    ]) {
      expect(FORBIDDEN_METHODS, reader).toContain(reader);
      expect(ALLOWED_METHODS, reader).not.toContain(reader);
    }
  });

  it("nothing but the ring buffer reads a request event, and it keeps no header", () => {
    // The events `Network.enable` subscribes to carry request and response
    // headers (Cookie, Authorization, Set-Cookie). The only reader is
    // `devlog.ts`, and no header field name appears in it.
    const readers = files.filter((file) =>
      readSource(file).includes('"Network.responseReceived"'),
    );
    expect(readers).toEqual([
      pathModule.join("core", "browser", "cdp", "devlog.ts"),
    ]);
    const devlog = readSource(readers[0]!);
    for (const field of [".headers", "postData", "requestHeaders", "cookie"]) {
      expect(devlog.includes(field), field).toBe(false);
    }
  });
});
