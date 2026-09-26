import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal } from "../collab/refusals";
import { VERBS, shellArgs, withWorkspace } from "./args";
import { UNAVAILABLE, interpret, unavailable } from "./client";
import { type BrowserFixture, browserFixture, callerFor } from "./fixture";
import { agentActor } from "./lease";
import { render } from "./render";
import { storedSession } from "./store";
import { ensureSession } from "./session";
import { runBrowserVerb } from "./verbs";

/**
 * The shell route: the half of a verb that stays in the core.
 *
 * Ported from the pre-merge implementation. None of this needs a
 * browser, and that is the point of the split. What is tested here is what did
 * NOT move to the shell — the argument surface, the lease, the prose — plus
 * the two refusals whose exact wording is part of the design rather than
 * incidental.
 */

let fixture: BrowserFixture | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

function session(current: BrowserFixture) {
  return ensureSession(
    current.context.sessions,
    current.context,
    current.nodeId,
    current.workspaceId,
    "https://example.com",
  );
}

/* ------------------------------ the argument face ------------------------- */

describe("the drive channel's argument face", () => {
  it("sends only the arguments that verb has", () => {
    const raw = {
      url: "https://example.com",
      selector: "#go",
      text: "hello",
      // Not an argument of any verb. It must not reach the wire.
      method: "Runtime.evaluate",
      expression: "document.cookie",
    };
    for (const verb of VERBS) {
      const sent = shellArgs(verb, raw);
      expect(Object.keys(sent), verb).not.toContain("method");
      expect(Object.keys(sent), verb).not.toContain("expression");
    }
  });

  it("carries the url and the action for a navigation", () => {
    const sent = shellArgs("navigate", { url: "https://example.com/a" });
    expect(sent.url).toBe("https://example.com/a");
    expect(sent.action).toBe("goto");

    // `back` and `forward` are verbs of their own as well as actions of
    // `navigate`; both spellings reach the same history walk.
    for (const verb of ["back", "forward"]) {
      expect(shellArgs(verb, {}).action).toBe(verb);
    }
    // No url and no action is a reload, not a navigation to nowhere.
    expect(shellArgs("navigate", {}).action).toBe("reload");
  });

  it("defaults a capture to a path inside the workspace", () => {
    const sent = shellArgs("capture", {});
    const path = String(sent.path);
    expect(path.startsWith(".armadra/browser/")).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    // The root is added separately, and it is what the shell's jail resolves
    // against. Neither half is sufficient alone.
    expect(withWorkspace(sent, "/tmp/project").workspaceRoot).toBe(
      "/tmp/project",
    );
  });

  it("clamps what press and scroll are given", () => {
    const sent = shellArgs("press", {
      key: "Enter",
      repeat: 4,
      modifiers: ["shift", "meta"],
    });
    expect(sent.key).toBe("Enter");
    expect(sent.repeat).toBe(4);
    // shift = 8, meta = 4.
    expect(sent.modifiers).toBe(12);
  });

  it("carries its own read ceilings rather than trusting the shell to have some", () => {
    const sent = shellArgs("read", {});
    // The snapshot is the default now, with its own, smaller budget.
    expect(sent.mode).toBe("snapshot");
    expect(sent.limit).toBe(40);
    expect(sent.maxBytes).toBe(16 * 1024);
    expect(shellArgs("read", { mode: "text" }).maxBytes).toBe(24 * 1024);
  });

  it("reads the old element list as the interactive snapshot", () => {
    for (const mode of ["elements", "map"]) {
      const sent = shellArgs("read", { mode });
      expect(sent.mode).toBe("snapshot");
      expect(sent.interactive).toBe(true);
    }
  });

  it("forwards --tab and --snapshot, and --to-ref as a ref", () => {
    const sent = shellArgs("click", { ref: "e3", tab: "t2", snapshot: true });
    expect(sent).toMatchObject({ ref: "e3", tab: "t2", snapshot: true });
    expect(shellArgs("scroll", { "to-ref": "e9" }).ref).toBe("e9");
    // `--snapshot` only where a verb changes the page.
    expect(shellArgs("read", { snapshot: true }).snapshot).toBeUndefined();
  });

  it("keeps typed text and accessible names exactly as given", () => {
    expect(shellArgs("type", { text: " 2 " }).text).toBe(" 2 ");
    expect(shellArgs("click", { role: "button", name: "提交 " }).name).toBe(
      "提交 ",
    );
  });
});

/* ------------------------------- the answers ------------------------------ */

describe("the prose a verb answers with", () => {
  it("reports what the page did on a scroll and not what was asked", () => {
    const line = render(
      "scroll",
      { amount: 600 },
      {
        moved: 0,
        position: 4_400,
        extent: 4_400,
      },
    );
    // The page was already at the bottom, so it moved nothing. The requested
    // 600 appears nowhere: an answer that echoes the request cannot tell the
    // reader that the page ignored them.
    expect(line).toContain("已滚动 0 px");
    expect(line).not.toContain("600");
  });

  it("reports a count for a type and not the text", () => {
    const line = render(
      "type",
      { text: "hunter2" },
      {
        chars: 7,
        url: "https://example.com",
        generation: 3,
      },
    );
    expect(line).toContain("已输入 7 个字符");
    expect(line).not.toContain("hunter2");
  });

  it("reports a path and a digest for a capture, and no bytes", () => {
    const line = render(
      "capture",
      {},
      {
        path: "/p/.armadra/browser/1.png",
        width: 520,
        height: 332,
        bytes: 8_192,
        sha256: "abc123",
      },
    );
    expect(line).toContain("/p/.armadra/browser/1.png");
    expect(line).toContain("sha256 abc123");
    expect(line).not.toContain("base64");
  });

  it("reports the address after a click", () => {
    const line = render(
      "click",
      {},
      {
        url: "https://example.com/next",
        title: "Next",
        generation: 4,
        role: "button",
        name: "Sign in",
        target: 'button "Sign in" (e3)',
      },
    );
    expect(line).toContain('已点击 button "Sign in" (e3)');
    expect(line).toContain("https://example.com/next");
    // Never where it was on the screen.
    expect(line).not.toContain("px");
    expect(line).not.toContain(",");
  });
});

/* --------------------------- codes off the wire --------------------------- */

describe("codes off the drive channel", () => {
  it("keeps a refusal's code at the front of the line", () => {
    for (const [code, expectedNotFound] of [
      ["browser_not_drivable", true],
      ["browser_not_found", true],
      ["browser_stale_ref", false],
      ["browser_refused", false],
    ] as const) {
      let thrown: unknown;
      try {
        interpret({ id: "r1", ok: false, error: { code, message: "no" } });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Refusal);
      const refusal = thrown as Refusal;
      expect(refusal.message).toContain(code);
      expect(refusal.status === 404, code).toBe(expectedNotFound);
    }
  });

  it("answers an ok result and nothing else", () => {
    expect(interpret({ id: "r1", ok: true, result: { a: 1 } })).toEqual({
      a: 1,
    });
  });

  it("names the absence of a shell", () => {
    expect(unavailable().message.startsWith(UNAVAILABLE)).toBe(true);
  });
});

/* -------------------------------- the lease ------------------------------- */

describe("the lease under the shell route", () => {
  it("revokes the agent on a takeover and records the action as unknown", async () => {
    const current = browserFixture();
    fixture = current;
    const handle = session(current);
    const agent = agentActor(current.agentId, handle.sessionId, "Claude");
    await handle.acquire(agent);
    expect(handle.leaseSnapshot().state).toBe("agent");

    handle.takeover("device-1", "我");
    expect(handle.leaseSnapshot().state).toBe("humanTakeover");

    // The agent's next action is refused with LEASE_REVOKED and is not queued
    // behind the takeover: taking over is a decision, not a turn in a line.
    await expect(handle.acquire(agent)).rejects.toThrow(/LEASE_REVOKED/);

    // An action already dispatched cannot be taken back, so it is recorded as
    // `unknown` rather than as something that succeeded or failed.
    const unknown = handle
      .activity()
      .find((entry) => entry.outcome === "unknown");
    expect(unknown?.reasonCode).toBe("LEASE_REVOKED");
    expect(unknown?.actorId).toBe(current.agentId);
  });

  it("lets a person clicking into the page preempt an agent outright", async () => {
    const current = browserFixture();
    fixture = current;
    const handle = session(current);
    const agent = agentActor(current.agentId, handle.sessionId, "Claude");
    await handle.acquire(agent);
    // This is what the shell reports from the guest's own
    // `before-input-event`. Nothing about it travels through this process
    // except the fact that it happened.
    expect(handle.humanActivity("local")).toBeDefined();
    expect(handle.leaseSnapshot().state).toBe("human");

    // A deliberate takeover is not walked over by a later click.
    handle.takeover("device-1", "我");
    expect(handle.humanActivity("local")).toBeUndefined();
    expect(handle.leaseSnapshot().state).toBe("humanTakeover");
  });

  it("gives the active tab url exactly one writer", () => {
    const current = browserFixture();
    fixture = current;
    const handle = ensureSession(
      current.context.sessions,
      current.context,
      current.nodeId,
      current.workspaceId,
      "https://example.com/one",
    );
    expect(handle.activeTabUrl()).toBe("https://example.com/one");

    // The shell's navigation event is the writer. The canvas node's own `url`
    // is what the page draws; this column is what a restart re-navigates to,
    // and the two must not be two truths.
    handle.rememberUrl("https://example.com/two");
    expect(
      storedSession(current.database, handle.sessionId)?.activeTabUrl,
    ).toBe("https://example.com/two");
  });
});

/* ------------------------------ the refusals ------------------------------ */

describe("what a refusal does and does not say", () => {
  /**
   * A node that is not linked and a node that does not exist get the SAME
   * sentence. A refusal that told them apart would turn the verb into a probe
   * for what is on somebody else's canvas.
   */
  it("refuses an unlinked node and a missing node in the same words", async () => {
    const current = browserFixture();
    fixture = current;
    const caller = callerFor(current, current.agentId);
    for (const name of [
      "no-such-node-at-all",
      "00000000-0000-0000-0000-000000000000",
      current.agentId,
    ]) {
      let thrown: unknown;
      try {
        await runBrowserVerb(current.context, caller, "read", { node: name });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Refusal);
      expect((thrown as Refusal).message).toBe(
        `连接的浏览器节点里没有叫「${name}」的。`,
      );
      expect((thrown as Refusal).status).toBe(404);
    }
  });
});

/* -------------------------------- the list -------------------------------- */

describe("the verb list", () => {
  it("is the same list the shell checks", () => {
    // Read as source rather than imported: the core may not import from
    // `shell-core/` (`no-electron.test.ts`). The shell's list is DERIVED from
    // the one in `verb-spec.ts`; what is worth checking here is that it still
    // is, rather than a copy that can drift.
    const drive = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../shell-core/browser/drive.ts",
      ),
      "utf8",
    );
    expect(drive).toContain(
      "export const DRIVE_VERBS: readonly string[] = Object.freeze([...VERB_NAMES]);",
    );
    expect(VERBS).toContain("lease");
    expect(VERBS).toContain("hover");
  });
});
