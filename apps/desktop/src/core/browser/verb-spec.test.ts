import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BROWSER_VERBS, USAGE } from "../../cli/armadra-hook/usage";
import { LEASE_CODES } from "../drive/lease";
import { VERBS, needsLease, shellArgs } from "./args";
import { DRIVE_CODES } from "./cdp/codes";
import { FakePage } from "./cdp/fake-page";
import { isAllowedChord, parseChord } from "./cdp/keys";
import { CdpSession } from "./cdp/session";
import { implementedVerbs, runVerbOnHost, type VerbHost } from "./cdp/verbs";
import {
  BROWSER_NOTES,
  BROWSER_NOTES_ZH,
  BROWSER_VERB_SPECS,
  DOCUMENTED_CODES,
  flagsOf,
  verbSpec,
} from "./verb-spec";

/**
 * The one list, held to the implementation.
 *
 * `armadra-hook --help` used to be a paragraph written by hand, and it
 * disagreed with the code in eight places: a ref format nothing accepted, two
 * error codes nothing produced, two read modes nothing implemented, keys the
 * allowlist refused, three flags nothing forwarded, an action that fell into
 * the wrong branch and a direction that scrolled the other way. Every one of
 * those is a claim the help makes; every claim is checked here.
 */

describe("one list of verbs", () => {
  it("is what the core accepts, what the pages execute, and what the hook checks", () => {
    const names = BROWSER_VERB_SPECS.map((spec) => spec.name);
    expect([...VERBS]).toEqual(names);
    expect([...BROWSER_VERBS]).toEqual(names);
    expect(new Set(implementedVerbs())).toEqual(new Set(names));
  });

  it("has no verb twice and no flag twice", () => {
    const names = BROWSER_VERB_SPECS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of BROWSER_VERB_SPECS) {
      const flags = flagsOf(spec).map((each) => each.name);
      expect(new Set(flags).size, spec.name).toBe(flags.length);
    }
  });

  it("says which verbs read, and those never take the lease", () => {
    for (const spec of BROWSER_VERB_SPECS) {
      if (spec.lease === "never")
        expect(needsLease(spec.name, {}), spec.name).toBe(false);
      if (spec.lease === "always")
        expect(needsLease(spec.name, {}), spec.name).toBe(true);
    }
    expect(needsLease("tabs", { switch: "t2" })).toBe(true);
    expect(needsLease("download", { id: "d", accept: true })).toBe(true);
  });
});

describe("every flag the list names is forwarded", () => {
  for (const spec of BROWSER_VERB_SPECS) {
    it(spec.name, () => {
      for (const flag of flagsOf(spec)) {
        if (flag.coreOnly === true) continue;
        const sample = flag.sample ?? (flag.value === undefined ? true : "7");
        const given: Record<string, unknown> =
          flag.name === "x" || flag.name === "y"
            ? { x: "5", y: "5" }
            : { [flag.name]: flag.repeat === true ? [sample] : sample };
        const without = shellArgs(spec.name, {});
        const withFlag = shellArgs(spec.name, given);
        // A default file name carries the time; it is not what is compared.
        if (flag.name !== "path") {
          delete without.path;
          delete withFlag.path;
        }
        expect(
          JSON.stringify(withFlag),
          `${spec.name} --${flag.name}`,
        ).not.toBe(JSON.stringify(without));
      }
    });
  }
});

describe("the help", () => {
  const section = USAGE.slice(
    USAGE.indexOf("BROWSER VERBS"),
    USAGE.indexOf("ENVIRONMENT:"),
  );

  it("lists every verb, and every flag each verb takes", () => {
    for (const spec of BROWSER_VERB_SPECS) {
      expect(section, spec.name).toMatch(
        new RegExp(`^  ${spec.name}( |$)`, "m"),
      );
      for (const flag of spec.flags) {
        if (flag.coreOnly === true && !spec.synopsis.includes(`--${flag.name}`))
          continue;
        expect(section, `${spec.name} --${flag.name}`).toContain(
          `--${flag.name}`,
        );
      }
    }
  });

  it("mentions no flag a verb does not take", () => {
    for (const spec of BROWSER_VERB_SPECS) {
      const known = new Set(flagsOf(spec).map((each) => each.name));
      for (const match of spec.synopsis.matchAll(/--([a-z-]+)/g)) {
        expect(known.has(match[1]!), `${spec.name} --${match[1]}`).toBe(true);
      }
    }
  });

  it("names only error codes that exist, and every one it names", () => {
    const real = new Set<string>([
      ...Object.values(DRIVE_CODES),
      ...LEASE_CODES,
    ]);
    for (const code of DOCUMENTED_CODES)
      expect(real.has(code), code).toBe(true);
    for (const note of [...BROWSER_NOTES, ...BROWSER_NOTES_ZH]) {
      for (const match of note.matchAll(
        /\b(browser_[a-z_]+|LEASE_[A-Z_]+)\b/g,
      )) {
        expect(DOCUMENTED_CODES, match[1]).toContain(match[1]);
      }
    }
    // The two the old help invented.
    expect(section).not.toContain("STALE_TARGET");
    expect(section).not.toContain("DIALOG_PENDING");
    expect(section).toContain("browser_dialog_pending");
  });

  it("shows refs the way `read` prints them", () => {
    expect(section).toContain("e12");
    expect(section).not.toMatch(/e\d+-\d+@t/);
    expect(section).not.toContain("--frame");
  });

  it("names only keys the allowlist lets through", () => {
    const press = verbSpec("press")!;
    const named = [
      ...press.help.matchAll(
        /(?:^|[ :,])((?:[A-Z][a-z]+\+)*[A-Za-z0-9]+)(?=,|$)/g,
      ),
    ].map((match) => match[1]!);
    for (const key of [
      "Enter",
      "Tab",
      "Escape",
      "F1",
      "F12",
      "F5",
      "Control+a",
      "Meta+Shift+z",
      ...named,
    ]) {
      if (
        key === "arrows" ||
        key === "chord" ||
        key === "a" ||
        key === "or" ||
        key === "key"
      )
        continue;
      const chord = parseChord(key);
      expect(chord, key).toBeDefined();
      expect(isAllowedChord(chord!.key, chord!.modifiers), key).toBe(true);
    }
  });
});

describe("every mode, action and direction the help names works", () => {
  const workspace = mkdtempSync(join(tmpdir(), "armadra-verb-spec-"));

  function host(page: FakePage): VerbHost {
    const session = new CdpSession(page.dispatch);
    return {
      nodeId: "n",
      tabId: "t1",
      session,
      listTabs: () => [],
      requestTab: async () => undefined,
      listDownloads: () => [],
      acceptDownload: () => ({}),
      rejectDownload: () => ({}),
      pendingChooser: () => undefined,
      clearChooser: () => undefined,
      openDialog: () => undefined,
      clearDialog: () => undefined,
    };
  }

  function options(verb: string, flag: string): string[] {
    const synopsis = verbSpec(verb)!.synopsis;
    const found = new RegExp(`--${flag} ([a-z|]+)`).exec(synopsis)?.[1];
    return found?.split("|") ?? [];
  }

  it("read --mode", async () => {
    const modes = options("read", "mode");
    expect(modes).toEqual([
      "snapshot",
      "text",
      "links",
      "title",
      "console",
      "network",
    ]);
    for (const mode of [...modes, "elements"]) {
      const page = new FakePage();
      await expect(
        runVerbOnHost(host(page), "read", shellArgs("read", { mode })),
        mode,
      ).resolves.toBeDefined();
    }
  });

  it("navigate --action", async () => {
    const actions = options("navigate", "action");
    expect(actions).toEqual(["back", "forward", "reload", "stop"]);
    for (const action of actions) {
      const page = new FakePage();
      await runVerbOnHost(
        host(page),
        "navigate",
        shellArgs("navigate", { action }),
      );
      const methods = page.methods();
      const expected = {
        back: "Page.navigateToHistoryEntry",
        forward: "Page.navigateToHistoryEntry",
        reload: "Page.reload",
        stop: "Page.stopLoading",
      }[action]!;
      expect(methods, action).toContain(expected);
      expect(methods, action).not.toContain("Page.navigate");
    }
  });

  it("scroll --direction, each the way it says", async () => {
    const directions = options("scroll", "direction");
    expect(directions).toEqual([
      "up",
      "down",
      "left",
      "right",
      "top",
      "bottom",
    ]);
    for (const direction of directions) {
      const page = new FakePage();
      await runVerbOnHost(
        host(page),
        "scroll",
        shellArgs("scroll", { direction }),
      );
      const wheel = page.sent.find(
        (each) => each.params.type === "mouseWheel",
      )!.params;
      const horizontal = direction === "left" || direction === "right";
      expect(wheel.deltaX !== 0, direction).toBe(horizontal);
      const sign = horizontal
        ? Math.sign(Number(wheel.deltaX))
        : Math.sign(Number(wheel.deltaY));
      expect(sign, direction).toBe(
        ["up", "left", "top"].includes(direction) ? -1 : 1,
      );
    }
    rmSync(workspace, { recursive: true, force: true });
  });
});
