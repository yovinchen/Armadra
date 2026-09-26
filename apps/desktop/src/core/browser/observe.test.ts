import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  onContextLinksChanged,
  putContextLinks,
} from "../canvas/context-links";
import { type BrowserFixture, browserFixture } from "./fixture";
import { BrowserObservation, linkedBrowserNodes } from "./observe";

/**
 * 哪些浏览器节点被 Agent 连着（被动旁听的节点表），以及它何时整份推给壳。
 */

let fixture: BrowserFixture;

beforeEach(() => {
  fixture = browserFixture({ withShell: true });
});

afterEach(() => {
  fixture.close();
  vi.useRealTimers();
});

describe("linkedBrowserNodes", () => {
  it("is every browser node a terminal's link document names", () => {
    const other = fixture.node("browser", "另一个", { kind: "browser" });
    const loose = fixture.node("browser", "没连的", { kind: "browser" });
    const plain = fixture.node("terminal", "终端", { kind: "terminal" });
    fixture.link(plain, other);
    const sticky = fixture.node("sticky", "便签", { kind: "sticky" });
    fixture.link(sticky, loose);
    expect(linkedBrowserNodes(fixture.database)).toEqual(
      [fixture.nodeId, other].sort(),
    );
  });

  it("drops a link when the terminal's document no longer names it", () => {
    putContextLinks(fixture.database, fixture.workspaceId, fixture.agentId, []);
    expect(linkedBrowserNodes(fixture.database)).toEqual([]);
  });

  it("ignores a link to a browser node that is gone", () => {
    fixture.database
      .prepare("DELETE FROM nodes WHERE id = ?")
      .run(fixture.nodeId);
    expect(linkedBrowserNodes(fixture.database)).toEqual([]);
  });
});

describe("BrowserObservation", () => {
  it("pushes the whole set once per change, and again whenever the channel comes up", () => {
    vi.useFakeTimers();
    const pushed: string[][] = [];
    const observation = new BrowserObservation(fixture.database, (ids) => {
      pushed.push([...ids]);
    });
    const off = onContextLinksChanged(() => observation.changed());
    observation.resync();
    expect(pushed).toEqual([[fixture.nodeId]]);

    // Several documents written in one go are one push.
    const other = fixture.node("browser", "另一个", { kind: "browser" });
    fixture.link(fixture.agentId, other);
    vi.advanceTimersByTime(60);
    expect(pushed).toEqual([[fixture.nodeId], [fixture.nodeId, other].sort()]);

    // A write that changes nothing is not pushed; a reconnect always is.
    observation.changed();
    vi.advanceTimersByTime(60);
    expect(pushed).toHaveLength(2);
    observation.resync();
    expect(pushed).toHaveLength(3);

    // The last link goes: an empty set, which is what makes the shell detach.
    putContextLinks(fixture.database, fixture.workspaceId, fixture.agentId, []);
    vi.advanceTimersByTime(60);
    expect(pushed.at(-1)).toEqual([]);
    off();
    observation.close();
  });
});
