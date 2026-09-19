import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWED_METHODS } from "../../shell-core/browser/allowlist";

/**
 * The structural guard on the CDP boundary.
 *
 * The allowlist in `shell-core/browser/allowlist.ts` is a security boundary for
 * exactly as long as every command passes through it. A second place that calls
 * `sendCommand` is not a bug in the allowlist; it is the allowlist ceasing to
 * be one, silently, in a diff that looks like plumbing. So the call site is
 * pinned by a scan, and the scan carries its own positive and negative samples
 * so a regex that stopped matching cannot pass by matching nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

const CALL = /\.sendCommand\s*\(/;
const ATTACH = /\.debugger\b|\bdebugger\.attach\s*\(/;

describe("the CDP call site", () => {
  const files = walk(src).filter((file) => !file.endsWith(".test.ts"));

  it("exists in exactly one file", () => {
    const callers = files
      .filter((file) => CALL.test(readFileSync(file, "utf8")))
      .map((file) => relative(src, file));
    expect(callers).toEqual(["main/browser/cdp.ts"]);
  });

  it("reaches the debugger from that one file only", () => {
    const users = files
      .filter((file) => ATTACH.test(readFileSync(file, "utf8")))
      .map((file) => relative(src, file));
    expect(users).toEqual(["main/browser/cdp.ts"]);
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
      const source = readFileSync(file, "utf8");
      for (const door of [
        "executeJavaScript(",
        "insertCSS(",
        "webFrame.",
        "eval(",
      ]) {
        expect(
          source.includes(door),
          `${relative(src, file)} contains ${door}`,
        ).toBe(false);
      }
    }
  });

  it("the words Runtime.evaluate appear only where they are refused", () => {
    const mentions = files
      .filter((file) => readFileSync(file, "utf8").includes("Runtime.evaluate"))
      .map((file) => relative(src, file));
    expect(mentions).toEqual(["shell-core/browser/allowlist.ts"]);
  });

  it("the allowlist offers no reachable way to write a cookie", () => {
    // `Network.setCookie` is not in the table at all. nodeterm allowed it and
    // pinned it as unreachable; here the same guarantee costs one absence,
    // which is cheaper to keep true. A page that could be given a session
    // cookie for accounts.google.com turns the next human visit into somebody
    // else's login.
    expect(
      ALLOWED_METHODS.some((method) => method.startsWith("Network.")),
    ).toBe(false);
  });
});
