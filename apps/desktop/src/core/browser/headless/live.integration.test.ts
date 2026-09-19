import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { discoverBrowser } from "./discover";
import { FakeViewer } from "./fake-browser";
import { HeadlessBackend } from "./index";

/**
 * The one test that runs a real browser.
 *
 * Everything else in this directory proves the bookkeeping against a fake
 * Chromium, which is the right shape for a unit test and cannot tell you
 * whether the switches are right, whether the pipe protocol is the one
 * Chromium actually speaks, or whether a screencast ever produces a frame.
 * This one can, and it SKIPS — loudly, with the reason — on a machine with no
 * browser, because a test that fails on a CI runner for lack of Chrome teaches
 * people to ignore it.
 */

const found = discoverBrowser(process.env, process.platform, existsSync);
const page =
  "data:text/html,<title>armadra</title><h1>headless hello</h1><p>frame test</p>";

const dataDir = mkdtempSync(join(tmpdir(), "armadra-live-browser-"));
let backend: HeadlessBackend | undefined;

afterAll(() => {
  backend?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(found.path === undefined)("a real headless Chromium", () => {
  it(
    "starts, paints a frame and answers a read",
    { timeout: 90_000 },
    async () => {
      backend = new HeadlessBackend({
        dataDir,
        log: (message, detail) => {
          // eslint-disable-next-line no-console
          console.log(`[live browser] ${message}`, detail ?? {});
        },
      });
      backend.connect(() => {});
      const started = Date.now();
      const node = await backend.ensure("live-node", page);
      const launched = Date.now() - started;

      const viewer = new FakeViewer();
      node.attachViewer(viewer);
      const firstFrame = Date.now();
      for (
        let attempt = 0;
        attempt < 300 && viewer.binaries.length === 0;
        attempt += 1
      ) {
        await new Promise((done) => setTimeout(done, 50));
      }
      const frameMs = Date.now() - firstFrame;
      expect(viewer.binaries.length).toBeGreaterThan(0);
      // A JPEG, not whatever else: the first two bytes are the SOI marker, and
      // the front end hands these to `createImageBitmap` with no sniffing.
      expect(viewer.binaries[0]?.subarray(0, 2)).toEqual(
        Buffer.from([0xff, 0xd8]),
      );
      const header = viewer
        .messages()
        .findLast((message) => message.type === "frame");
      expect(header).toMatchObject({ type: "frame" });

      const answer = (await backend.drive("live-node", "read", {
        mode: "text",
      })) as { text?: string };
      expect(JSON.stringify(answer)).toContain("headless hello");

      // Printed rather than asserted: a latency budget enforced on somebody's
      // laptop under load is a flaky test, and the number is still what a reader
      // of this file wants to know.
      // eslint-disable-next-line no-console
      console.log(
        `[live browser] ${found.path} — launch+first tab ${launched} ms, first frame ${frameMs} ms`,
      );
    },
  );
});

if (found.path === undefined) {
  // eslint-disable-next-line no-console
  console.log(
    `[live browser] skipped: no Chromium found. Looked at: ${found.searched.join(", ")}`,
  );
}
