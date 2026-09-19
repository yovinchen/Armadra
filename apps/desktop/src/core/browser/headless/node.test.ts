import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BROWSER_PATH_ENV } from "./discover";
import { FakeBrowser, FakeViewer } from "./fake-browser";
import { HeadlessBackend } from "./index";

/**
 * The headless backend against a fake Chromium.
 *
 * What is real here is everything between the verb and the wire: the target
 * bookkeeping, the screencast acknowledgement, the input mapping and its
 * bounds, the single-viewer rule and what a dead browser does to a node. What
 * is fake is Chromium, which is the part no unit test can own.
 */

let dataDir = "";
let fake: FakeBrowser;
let events: Record<string, unknown>[];

function backend(): HeadlessBackend {
  const made = new HeadlessBackend({
    dataDir,
    env: { [BROWSER_PATH_ENV]: "/fake/chrome" },
    platform: "linux",
    exists: () => true,
    launch: fake.launcher,
  });
  made.connect((event) => {
    events.push(event);
  });
  return made;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "armadra-headless-"));
  fake = new FakeBrowser();
  events = [];
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("starting a browser for a node", () => {
  it("starts one browser per node, with that node's own profile", async () => {
    const made = backend();
    await made.ensure("node-a", "https://example.test/");
    expect(fake.launched?.executable).toBe("/fake/chrome");
    expect(fake.launched?.profileDir).toBe(
      join(dataDir, "browser-profiles", "node-a"),
    );
    // The login of a browser node is its profile directory. Two nodes sharing
    // one would be two nodes sharing an account.
    expect(fake.launched?.profileDir).not.toContain("node-b");
    made.close();
  });

  it("opens the node's url as its first tab and attaches to it", async () => {
    const made = backend();
    const node = await made.ensure("node-a", "https://example.test/");
    expect(fake.called("Target.createTarget")[0]?.params.url).toBe(
      "https://example.test/",
    );
    expect(fake.called("Target.attachToTarget")[0]?.params).toMatchObject({
      flatten: true,
    });
    // The three that make a page answerable at all: without `Page.enable` no
    // navigation event arrives, and without the chooser intercept no `upload`
    // could ever be answered.
    for (const method of [
      "Page.enable",
      "Runtime.enable",
      "Page.setInterceptFileChooserDialog",
    ]) {
      expect(fake.called(method).length, method).toBeGreaterThan(0);
    }
    expect(node.listTabs()).toHaveLength(1);
    expect(node.listTabs()[0]?.active).toBe(true);
    made.close();
  });

  it("reuses the running browser rather than starting a second one", async () => {
    const made = backend();
    const first = await made.ensure("node-a");
    const second = await made.ensure("node-a");
    expect(second).toBe(first);
    expect(fake.called("Target.createTarget")).toHaveLength(1);
    made.close();
  });

  it("answers browser_unavailable, with where it looked, when there is none", async () => {
    const made = new HeadlessBackend({
      dataDir,
      env: {},
      platform: "linux",
      exists: () => false,
    });
    made.connect(() => {});
    expect(made.isConnected()).toBe(false);
    const status = made.status();
    expect(status.kind).toBe("headless");
    expect(status.available).toBe(false);
    expect(status.reason).toBe("browser_unavailable");
    expect((status.detail?.searched as string[]).length).toBeGreaterThan(0);
    await expect(made.drive("node-a", "read", {})).rejects.toMatchObject({
      message: expect.stringContaining(BROWSER_PATH_ENV),
    });
  });
});

describe("tabs are the browser's targets", () => {
  it("opens, switches and closes them", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    const host = node.host();
    await host.requestTab("new", "", "https://second.test/");
    expect(node.listTabs()).toHaveLength(2);
    const [first, second] = node.listTabs();
    expect(second?.active).toBe(true);

    await host.requestTab("switch", first?.id ?? "", "");
    expect(node.listTabs().find((tab) => tab.active)?.id).toBe(first?.id);
    expect(fake.called("Target.activateTarget")).toHaveLength(1);

    await host.requestTab("close", second?.id ?? "", "");
    expect(node.listTabs()).toHaveLength(1);
    made.close();
  });

  it("adopts a page the page itself opened", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    fake.emit("Target.targetCreated", {
      targetInfo: { targetId: "popup-1", type: "page", url: "https://p.test/" },
    });
    await settle();
    expect(node.listTabs().map((tab) => tab.id)).toContain("popup-1");
    // A target that is not a page is not a tab: service workers and the
    // browser target itself are not things anybody switches to.
    fake.emit("Target.targetCreated", {
      targetInfo: { targetId: "sw-1", type: "service_worker", url: "" },
    });
    await settle();
    expect(node.listTabs().map((tab) => tab.id)).not.toContain("sw-1");
    made.close();
  });

  it("tells the canvas where the active tab went", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    const session = fake.sessionFor(node.listTabs()[0]?.id ?? "");
    fake.emit(
      "Page.frameNavigated",
      { frame: { url: "https://moved.test/" } },
      session,
    );
    await settle();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "navigated",
        nodeId: "node-a",
        url: "https://moved.test/",
      }),
    );
    made.close();
  });
});

describe("the one viewer", () => {
  it("starts the screencast on attach and stops it when the viewer goes", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    const viewer = new FakeViewer();
    node.attachViewer(viewer);
    await settle();
    expect(node.hasViewer()).toBe(true);
    expect(made.hasViewer("node-a")).toBe(true);
    const started = fake.called("Page.startScreencast")[0];
    expect(started?.params).toMatchObject({
      format: "jpeg",
      maxWidth: 1_280,
      maxHeight: 800,
    });
    expect(viewer.messages()[0]).toMatchObject({ type: "hello" });

    node.detachViewer(viewer);
    await settle();
    expect(node.hasViewer()).toBe(false);
    // Nobody is watching, so nothing is encoded.
    expect(fake.called("Page.stopScreencast").length).toBeGreaterThan(0);
    made.close();
  });

  it("acknowledges every frame and forwards it as metadata plus bytes", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    const viewer = new FakeViewer();
    node.attachViewer(viewer);
    await settle();
    const session = fake.sessionFor(node.listTabs()[0]?.id ?? "");
    fake.frame(session, 11);
    fake.frame(session, 12);
    await settle();

    // The ack is not optional: Chromium sends the next frame only after the
    // previous one is acknowledged, so a missed ack is a stream that stops.
    expect(
      fake
        .called("Page.screencastFrameAck")
        .map((call) => call.params.sessionId),
    ).toEqual([11, 12]);
    expect(viewer.binaries).toHaveLength(2);
    const header = viewer.messages().at(-1);
    expect(header).toMatchObject({ type: "frame", seq: 2, width: 1_280 });
    made.close();
  });

  it("acknowledges frames even with nobody left to send them to", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    const viewer = new FakeViewer();
    node.attachViewer(viewer);
    await settle();
    const session = fake.sessionFor(node.listTabs()[0]?.id ?? "");
    node.detachViewer(viewer);
    fake.frame(session, 20);
    await settle();
    expect(
      fake
        .called("Page.screencastFrameAck")
        .map((call) => call.params.sessionId),
    ).toContain(20);
    expect(viewer.binaries).toHaveLength(0);
    made.close();
  });

  it("treats a viewer's input as a person's, which takes the lease", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    const viewer = new FakeViewer();
    node.attachViewer(viewer);
    await settle();
    node.onViewerMessage(
      JSON.stringify({ type: "mouse", action: "down", x: 40, y: 60 }),
    );
    await settle();
    // The same event a `<webview>` guest's `before-input-event` produces, so
    // the lease moves to the human and the agent's next verb is refused with
    // LEASE_HELD_BY_HUMAN — one rule, two backends.
    expect(events).toContainEqual(
      expect.objectContaining({ event: "humanInput", nodeId: "node-a" }),
    );
    expect(fake.called("Input.dispatchMouseEvent")[0]?.params).toMatchObject({
      type: "mousePressed",
      x: 40,
      y: 60,
    });
    made.close();
  });

  it("does not report a viewport change as a person typing", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    node.attachViewer(new FakeViewer());
    await settle();
    node.onViewerMessage(
      JSON.stringify({ type: "viewport", width: 900, height: 700 }),
    );
    await settle();
    expect(events.some((event) => event.event === "humanInput")).toBe(false);
    expect(fake.called("Page.startScreencast").at(-1)?.params).toMatchObject({
      maxWidth: 900,
      maxHeight: 700,
    });
    made.close();
  });

  it("ignores a message that is not one of the five", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    node.attachViewer(new FakeViewer());
    await settle();
    const before = fake.calls.length;
    node.onViewerMessage(
      JSON.stringify({ type: "evaluate", expression: "document.cookie" }),
    );
    await settle();
    expect(fake.calls.length).toBe(before);
    made.close();
  });
});

describe("a browser that went away", () => {
  it("tells the canvas, and stops claiming it can drive", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    const viewer = new FakeViewer();
    node.attachViewer(viewer);
    await settle();
    fake.crash();
    await settle();

    expect(node.isAlive()).toBe(false);
    expect(made.node("node-a")).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ event: "guestLost", nodeId: "node-a" }),
    );
    // The viewer is told rather than left watching a frozen last frame.
    expect(viewer.closedWith).toBeDefined();
    made.close();
  });

  it("starts a fresh browser for the node after a crash", async () => {
    const made = backend();
    await made.ensure("node-a");
    fake.crash();
    await settle();
    const second = new FakeBrowser();
    const restarted = new HeadlessBackend({
      dataDir,
      env: { [BROWSER_PATH_ENV]: "/fake/chrome" },
      platform: "linux",
      exists: () => true,
      launch: second.launcher,
    });
    restarted.connect(() => {});
    await restarted.ensure("node-a");
    expect(second.launched?.profileDir).toBe(
      join(dataDir, "browser-profiles", "node-a"),
    );
    restarted.close();
    made.close();
  });
});

describe("the verbs, against the fake", () => {
  it("runs one through the same dispatcher the desktop shell uses", async () => {
    const made = backend();
    const answer = (await made.drive("node-a", "read", {
      mode: "title",
    })) as Record<string, unknown>;
    expect(answer).toMatchObject({ mode: "title", title: "fake" });
    made.close();
  });

  it("refuses a name that is not a verb before it starts anything", async () => {
    const made = new HeadlessBackend({
      dataDir,
      env: { [BROWSER_PATH_ENV]: "/fake/chrome" },
      platform: "linux",
      exists: () => true,
      launch: fake.launcher,
    });
    made.connect(() => {});
    await expect(made.drive("node-a", "evaluate", {})).rejects.toThrow(
      /browser_unknown_verb/,
    );
    expect(fake.launched).toBeUndefined();
    made.close();
  });

  it("refuses a CDP method the allowlist does not carry", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    await expect(
      node.host().session.send("Runtime.evaluate", { expression: "1" }),
    ).rejects.toMatchObject({ code: "browser_refused" });
    expect(fake.called("Runtime.evaluate")).toHaveLength(0);
    made.close();
  });

  it("stops driving when the lease was taken back", async () => {
    const made = backend();
    const node = await made.ensure("node-a");
    made.notify("node-a", "revoke", {
      reason: "the user took this browser back",
    });
    await expect(
      node.host().session.send("Page.getLayoutMetrics", {}),
    ).rejects.toMatchObject({ code: "browser_lease_revoked" });
    // And the next verb the lease allows starts again, rather than a node
    // being permanently poisoned by one revocation.
    await made.drive("node-a", "read", { mode: "title" });
    made.close();
  });
});

/** Lets the pipe's microtasks and the fake's writes land. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 10));
}
