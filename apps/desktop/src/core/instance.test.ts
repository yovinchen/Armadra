import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANNOUNCE_PREFIX,
  BUILD,
  VERSION,
  announcement,
  buildStamp,
  instanceId,
  parseAnnouncement,
} from "./instance";

const here = dirname(fileURLToPath(import.meta.url));

describe("instance identity", () => {
  it("mints the id once and it is not the build stamp", () => {
    const first = instanceId();
    expect(instanceId()).toBe(first);
    expect(first).not.toBe(BUILD);
    // A uuid, so two data directories on one machine cannot collide.
    expect(first).toHaveLength(36);
  });

  it("reports the version the package declares", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(here, "../../package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });

  it("prints the announcement line the shell already parses", () => {
    // The prefix is a wire literal, not a name: the shell's reader
    // (`main/runtime-process.ts`) matches it byte for byte, and an installed
    // shell keeps matching the old one. R7d deleted the implementation it was
    // copied from, so this is now the only place the literal is written down.
    expect(ANNOUNCE_PREFIX).toBe("armadra-runtime instance ");
    expect(announcement()).toBe(
      `${ANNOUNCE_PREFIX}${instanceId()} build ${BUILD}`,
    );
  });

  it("round trips an announcement and is not fooled by log output", () => {
    const line = announcement();
    expect(parseAnnouncement(line)).toBe(instanceId());
    expect(parseAnnouncement(`  ${line}  `)).toBe(instanceId());
    for (const other of [
      "",
      "armadra-runtime instance",
      "armadra-runtime instance ",
      "2026-09-13T00:00:00Z  INFO armadra: listening",
      "instance abc",
    ]) {
      expect(parseAnnouncement(other), other).toBeUndefined();
    }
  });

  it("keeps the build stamp printable and on one line", () => {
    expect(BUILD.length).toBeGreaterThan(0);
    expect(BUILD.length).toBeLessThanOrEqual(64);
    expect(/^[\x21-\x7e]+$/.test(BUILD)).toBe(true);
  });

  it("filters a configured stamp rather than trusting it", () => {
    expect(buildStamp("  c29cf841fa20  ")).toBe("c29cf841fa20");
    expect(buildStamp("a b\nc\td")).toBe("abcd");
    expect(buildStamp("x".repeat(200))).toHaveLength(64);
    expect(buildStamp(undefined, () => 1_700_000_000_000)).toBe(
      `${VERSION}+1700000000`,
    );
    expect(buildStamp("", () => 0)).toBe(`${VERSION}+0`);
  });
});
