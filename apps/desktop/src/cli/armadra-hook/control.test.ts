/** The 12 pre-merge unit tests, translated. */

import { describe, expect, it } from "vitest";

import {
  BROWSER_TIMEOUT_MS,
  browserTimeoutMs,
  controlBody,
  parseFlags,
  render,
  renderError,
} from "./control.js";
import type { Args } from "./control.js";
import type { HookResponse } from "./http.js";

function flags(input: string[]): Args {
  const parsed = parseFlags(input);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.ok;
}

describe("flag parsing", () => {
  it("turns bare flags into true", () => {
    expect(flags(["--dry-run"])["dry-run"]).toBe(true);
  });

  it("agrees on both flag spellings", () => {
    expect(flags(["--title", "Build"])).toEqual(flags(["--title=Build"]));
  });

  it("collects repeated flags into an array", () => {
    expect(
      flags(["--after", "a", "--after", "b", "--after=c"])["after"],
    ).toEqual(["a", "b", "c"]);
  });

  it("treats a flag followed by a flag as boolean", () => {
    const map = flags(["--dry-run", "--title", "x"]);
    expect(map["dry-run"]).toBe(true);
    expect(map["title"]).toBe("x");
  });

  it("lets values look like short options", () => {
    // Only `--` prefixed tokens end a value, so a title of "-5" survives.
    expect(flags(["--title=-5"])["title"]).toBe("-5");
  });

  it("rejects positional arguments", () => {
    expect(parseFlags(["oops"])).toHaveProperty("error");
  });
});

describe("control body", () => {
  it("has the expected shape", () => {
    expect(controlBody("n1", flags(["--dry-run"])).toString("utf8")).toBe(
      '{"args":{"dry-run":true},"nodeId":"n1"}',
    );
  });

  it("keeps an empty args object", () => {
    expect(controlBody("n1", {}).toString("utf8")).toBe(
      '{"args":{},"nodeId":"n1"}',
    );
  });
});

function response(
  status: number,
  contentType: string | undefined,
  body: string,
): HookResponse {
  return { status, contentType, body };
}

describe("rendering", () => {
  it("reduces JSON responses to their message", () => {
    expect(
      render(
        response(
          200,
          "application/json",
          '{"ok":true,"message":"opened 2 nodes"}',
        ),
      ),
    ).toBe("opened 2 nodes");
  });

  it("lets mailbox and delivery protocol fields survive CLI rendering", () => {
    for (const body of [
      '{"ok":true,"protocol":"armadra.mailbox.v1","id":"m1","message":"stored"}',
      '{"ok":false,"outcome":"targetBusy","retryable":true,"message":"busy"}',
    ]) {
      expect(render(response(200, "application/json", body))).toBe(body);
    }
  });

  it("passes plain text responses through", () => {
    const body = "linked nodes:\n- api (n2)\n";
    expect(render(response(200, "text/plain; charset=utf-8", body))).toBe(body);
  });

  it("carries the status on errors", () => {
    expect(
      renderError(
        response(403, "application/json", '{"error":"node is not linked"}'),
      ),
    ).toBe("node is not linked (403)");
    expect(renderError(response(500, "text/plain", "boom"))).toBe("boom (500)");
    expect(renderError(response(502, undefined, ""))).toBe(
      "hook endpoint answered 502",
    );
  });
});

describe("a browser verb's budget", () => {
  it("outlasts the longest verb, not the hook's 1.5 s", () => {
    // A verb that runs out of budget is re-sent to the next candidate: with
    // the hook budget, a 3-second `wait` became a second request (and a slow
    // click a second click) and then an unrelated 404.
    const saved = process.env.ARMADRA_HOOK_TIMEOUT_MS;
    delete process.env.ARMADRA_HOOK_TIMEOUT_MS;
    try {
      expect(browserTimeoutMs()).toBe(BROWSER_TIMEOUT_MS);
      expect(BROWSER_TIMEOUT_MS).toBeGreaterThan(45_000 + 15_000);
      process.env.ARMADRA_HOOK_TIMEOUT_MS = "90000";
      expect(browserTimeoutMs()).toBe(90_000);
    } finally {
      if (saved === undefined) delete process.env.ARMADRA_HOOK_TIMEOUT_MS;
      else process.env.ARMADRA_HOOK_TIMEOUT_MS = saved;
    }
  });
});
