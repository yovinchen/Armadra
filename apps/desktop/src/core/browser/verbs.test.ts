import { afterEach, describe, expect, it } from "vitest";
import { putContextLinks } from "../canvas/context-links";
import { Refusal, asRefused } from "../collab/refusals";
import { VERBS } from "./args";
import { createBrowserVerbs } from "./index";
import { type BrowserFixture, browserFixture, callerFor } from "./fixture";
import { onShellEvent } from "./events";
import { ensureSession } from "./session";
import { runBrowserVerb } from "./verbs";

/**
 * The three authorization rules and the verbs.
 *
 * Ported from the pre-merge implementation and its capability tests.
 * Nothing here opens a socket: the drive channel is
 * a stub, because what is worth testing on this side is which arguments travel
 * and who was allowed to send them.
 */

let fixture: BrowserFixture | undefined;

afterEach(() => {
  fixture?.close();
  fixture = undefined;
});

function call(
  current: BrowserFixture,
  verb: string,
  args: Record<string, unknown> = {},
  nodeId = current.agentId,
): Promise<string> {
  return runBrowserVerb(
    current.context,
    callerFor(current, nodeId),
    verb,
    args,
  );
}

describe("the three rules", () => {
  it("refuses a node that is not linked to a browser", async () => {
    const current = browserFixture();
    fixture = current;
    // The browser node itself has no agent links, so it may not drive
    // anything: the link document it holds names a terminal, not a browser.
    const lonely = current.node("terminal", "Alone", { kind: "terminal" });
    let thrown: unknown;
    try {
      await call(current, "read", {}, lonely);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Refusal).status).toBe(403);
  });

  it("never lets an unknown verb reach the browser", async () => {
    const current = browserFixture();
    fixture = current;
    let thrown: unknown;
    try {
      await call(current, "evaluate");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Refusal).status).toBe(400);
    expect((thrown as Refusal).message).toContain("navigate");
  });

  it("does not let a legacy token drive a browser", async () => {
    const current = browserFixture();
    fixture = current;
    let thrown: unknown;
    try {
      await runBrowserVerb(
        current.context,
        callerFor(current, current.agentId, "legacy"),
        "navigate",
        {},
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Refusal).status).toBe(403);
  });

  it("lets a custom agent have its browser capability switched off", async () => {
    const current = browserFixture({ withShell: true });
    fixture = current;
    current.customAgents.push({
      id: "custom:narrow",
      label: "Narrow",
      launchCmd: "wrapper",
      baseAgent: "claude",
      disabledCapabilities: ["browser"],
    });
    const narrow = current.node("terminal", "Narrow", {
      kind: "terminal",
      agent: { id: "custom:narrow" },
    });
    current.link(narrow, current.nodeId);
    let thrown: unknown;
    try {
      await call(current, "read", {}, narrow);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Refusal).status).toBe(403);
    expect((thrown as Refusal).message).toContain("browser");
    // Nothing reached the shell, so nothing attached a debugger to a guest:
    // the capability gate is in front of the channel, not behind it.
    expect(current.sent).toHaveLength(0);
  });

  it("refuses a link that claims to be a browser but names a terminal", async () => {
    const current = browserFixture();
    fixture = current;
    // The link document and the node row are two records, and only one of
    // them is authoritative. A document that says `browser` about a terminal
    // is drift — the node row decides, and the verb says so rather than
    // driving whatever it was handed.
    const peer = current.node("terminal", "Codex", {
      kind: "terminal",
      agent: { id: "codex" },
    });
    putContextLinks(current.database, current.workspaceId, current.agentId, [
      { id: peer, title: "Codex", kind: "browser" },
    ]);
    let thrown: unknown;
    try {
      await call(current, "read", { node: "Codex" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Refusal).status).toBe(400);
    expect((thrown as Refusal).message).toContain("不是浏览器节点");
  });
});

describe("the lease verb", () => {
  /**
   * The only verb that reads the lease instead of taking it: an agent that has
   * been refused has to be able to find out who is driving, and to hand its
   * own turn back early.
   */
  it("reads and hands back the lease without ever taking one", async () => {
    const current = browserFixture();
    fixture = current;
    const handle = ensureSession(
      current.context.sessions,
      current.context,
      current.nodeId,
      current.workspaceId,
      "https://example.com/form",
    );

    // Nobody is driving, and asking did not change that.
    expect(await call(current, "lease")).toContain("没有人在操作");
    expect(handle.leaseSnapshot().state).toBe("free");

    // One action that drives the page takes it, before it is sent anywhere;
    // the verb then names the agent. The click itself is refused — there is no
    // shell here — and the lease is still the agent's, which is the point: a
    // dispatched action that failed does not silently hand the page back.
    await expect(
      call(current, "click", { selector: "#picked" }),
    ).rejects.toThrow();
    expect(await call(current, "lease")).toContain("Agent 正在操作");

    // Handing it back frees it early rather than waiting out the idle timer.
    expect(await call(current, "lease", { release: true })).toContain(
      "已交还租约",
    );
    expect(handle.leaseSnapshot().state).toBe("free");

    // A person's takeover revokes the agent's turn: the next action is refused
    // and not retried, while reading the lease still works.
    handle.takeover("device-1", "我");
    let thrown: unknown;
    try {
      await call(current, "click", { selector: "#picked" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Refusal).message).toContain("LEASE_REVOKED");
    expect(await call(current, "lease")).toContain("人已接管：我");
  });

  it("refuses a dialog with neither accept nor dismiss", async () => {
    const current = browserFixture();
    fixture = current;
    await expect(call(current, "dialog", { id: "d1" })).rejects.toThrow(
      /--accept/,
    );
  });

  it("refuses handling a download without saying which way", async () => {
    const current = browserFixture();
    fixture = current;
    await expect(call(current, "download", { id: "d1" })).rejects.toThrow(
      /--accept/,
    );
  });
});

describe("with a shell on the other end", () => {
  it("drives every verb and renders each answer", async () => {
    const current = browserFixture({ withShell: true });
    fixture = current;
    // One answer shaped like every verb's: each renderer reads only the fields
    // it knows, so one object exercises the whole table.
    current.answer = {
      url: "https://example.com/next",
      title: "Next",
      generation: 7,
      mode: "text",
      text: "hello",
      chars: 5,
      key: "Enter",
      times: 1,
      chosen: ["one"],
      moved: 120,
      position: 120,
      extent: 4_400,
      matched: true,
      waitedMs: 12,
      path: "/p/.armadra/browser/1.png",
      width: 520,
      height: 332,
      bytes: 8_192,
      sha256: "abc123",
      paths: ["/p/a.txt"],
      answeredChooser: true,
      accepted: true,
      kind: "confirm",
      message: "sure?",
      suggestedFilename: "a.pdf",
      activeTabId: "t1",
      tabs: [{ id: "t1", title: "Next", url: "https://example.com/next" }],
    };
    const flags: Record<string, Record<string, unknown>> = {
      navigate: { url: "https://example.com/next" },
      type: { text: "hello" },
      press: { key: "Enter" },
      upload: { path: "/p/a.txt" },
      dialog: { id: "d1", accept: true },
      download: { id: "d1", accept: true },
      tabs: { switch: "t1" },
      fill: { field: "e1=x" },
      drag: { from: "e1", to: "e2" },
      resize: { width: 800, height: 600 },
    };
    for (const verb of VERBS) {
      const line = await call(current, verb, flags[verb] ?? {});
      expect(line.endsWith("\n"), verb).toBe(true);
      expect(line.length, verb).toBeGreaterThan(0);
      // Release between verbs so the next one is not queued behind this one's
      // own lease; `lease --release` is the verb that exists for exactly this.
      await call(current, "lease", { release: true }).catch(() => "");
    }
    // All but one reached the wire. `lease` is answered here, because there is
    // nothing on a page for it to do.
    const verbsSent = new Set(current.sent.map((entry) => entry.verb));
    expect(verbsSent.size).toBe(VERBS.length - 1);
    expect(verbsSent.has("lease")).toBe(false);
    // Every payload carried the workspace root, and none carried a method.
    for (const entry of current.sent) {
      const args = entry.args as Record<string, unknown>;
      expect(args.workspaceRoot, entry.verb).toBe(current.directory);
      expect(Object.keys(args), entry.verb).not.toContain("method");
    }
  });

  it("revokes the lease and detaches when a person takes over", async () => {
    const current = browserFixture({ withShell: true });
    fixture = current;
    current.answer = { url: "https://example.com", title: "x", generation: 1 };
    await call(current, "click", { selector: "#go" });

    // The shell reports the takeover; the core answers by revoking the lease
    // and telling the shell to drop every debugger attached to that node.
    onShellEvent(current.context, {
      event: "control",
      nodeId: current.nodeId,
      action: "takeover",
    });
    expect(current.notices.some((notice) => notice.event === "revoke")).toBe(
      true,
    );

    let thrown: unknown;
    try {
      await call(current, "click", { selector: "#go" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Refusal).message).toContain("LEASE_REVOKED");
  });

  it("writes the active tab url from the shell's navigation event", () => {
    const current = browserFixture({ withShell: true });
    fixture = current;
    const handle = ensureSession(
      current.context.sessions,
      current.context,
      current.nodeId,
      current.workspaceId,
      "",
    );
    onShellEvent(current.context, {
      event: "navigated",
      nodeId: current.nodeId,
      url: "https://example.com/deep",
    });
    expect(handle.activeTabUrl()).toBe("https://example.com/deep");
  });

  it("publishes a dialog and its closing to the workspace stream", () => {
    const current = browserFixture({ withShell: true });
    fixture = current;
    ensureSession(
      current.context.sessions,
      current.context,
      current.nodeId,
      current.workspaceId,
      "",
    );
    onShellEvent(current.context, {
      event: "dialog",
      nodeId: current.nodeId,
      id: "d1",
      tabId: "t1",
      kind: "confirm",
      message: "sure?",
    });
    onShellEvent(current.context, {
      event: "dialogClosed",
      nodeId: current.nodeId,
    });
    const dialogs = current.events.filter(
      (entry) => entry.event.type === "browser.dialog",
    );
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1]?.event).not.toHaveProperty("dialog");
  });

  it("ignores an event for a node nobody has driven", () => {
    const current = browserFixture({ withShell: true });
    fixture = current;
    onShellEvent(current.context, {
      event: "navigated",
      nodeId: "never-driven",
      url: "https://example.com/",
    });
    expect(current.events).toHaveLength(0);
  });
});

describe("the dispatcher the hook surface calls", () => {
  it("answers prose for a verb and a code for a refusal", async () => {
    const current = browserFixture();
    fixture = current;
    const verbs = createBrowserVerbs(current.context);
    expect(verbs.verbs).toHaveLength(VERBS.length);

    const ok = await verbs.dispatch(
      callerFor(current, current.agentId),
      "lease",
      {},
    );
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.body).toContain("没有人在操作");

    const refused = await verbs.dispatch(
      callerFor(current, current.agentId),
      "evaluate",
      {},
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.status).toBe(400);
    expect(refused.ok === false && refused.code).toBe("bad_request");
    // And the same mapping the rest of the core uses, so a hook route never
    // has to know which refusal shape a domain threw.
    expect(asRefused(Refusal.forbidden("no")).code).toBe("forbidden");
  });
});
