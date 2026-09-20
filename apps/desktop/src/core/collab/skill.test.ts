import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SKILLS_REVISION,
  installedRevision,
  skillFile,
  skillInstaller,
  registerSkillInstaller,
} from "../hook/install/skills";
import { collaborationSkill, installCollaborationSkill, skillBody } from "./skill";

/**
 * The skill half of the install unit.
 *
 * What is asserted is the part the settings page and the model both depend on:
 * the file carries a revision the reader can find, reinstalling does not touch
 * a byte, and uninstalling takes the file without taking anything the user put
 * beside it.
 */

let home: string;
let release: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "armadra-skill-"));
});

afterEach(() => {
  release?.();
  release = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("the collaboration skill", () => {
  it("writes a body whose revision the integration can read back", () => {
    const written = collaborationSkill.install("claude", home);
    expect(written).toEqual([skillFile(home)]);
    expect(installedRevision(home)).toBe(SKILLS_REVISION);
    const body = readFileSync(skillFile(home), "utf8");
    // The three things an agent cannot discover on its own.
    expect(body).toContain("armadra-hook context list");
    expect(body).toContain("armadra-hook canvas post");
    expect(body).toContain("ARMADRA_HOOK_BIN");
  });

  it("leaves the file and its mtime alone when nothing changed", async () => {
    collaborationSkill.install("claude", home);
    const before = statSync(skillFile(home)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(collaborationSkill.install("claude", home)).toEqual([]);
    expect(statSync(skillFile(home)).mtimeMs).toBe(before);
  });

  it("retires a revision-4 skill directory on install", () => {
    const legacy = join(home, "skills", "armadra-canvas");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "old", "utf8");
    const written = collaborationSkill.install("claude", home);
    expect(written).toContain(join(legacy, "SKILL.md"));
    expect(existsSync(join(legacy, "SKILL.md"))).toBe(false);
  });

  it("uninstalls the file but keeps a file the user put beside it", () => {
    collaborationSkill.install("claude", home);
    const mine = join(home, "skills", "armadra", "notes.md");
    writeFileSync(mine, "mine", "utf8");
    expect(collaborationSkill.uninstall("claude", home)).toEqual([
      skillFile(home),
    ]);
    expect(existsSync(skillFile(home))).toBe(false);
    expect(readFileSync(mine, "utf8")).toBe("mine");
  });

  it("uninstalling something that was never installed is not an error", () => {
    expect(collaborationSkill.uninstall("claude", home)).toEqual([]);
  });

  it("registers itself as the installer the integration looks up", () => {
    registerSkillInstaller(undefined);
    expect(skillInstaller()).toBeUndefined();
    release = installCollaborationSkill();
    expect(skillInstaller()).toBe(collaborationSkill);
  });

  it("names only verbs the control dispatcher answers", async () => {
    const { VERBS } = await import("./control/index");
    const body = skillBody();
    const named = [...body.matchAll(/armadra-hook canvas ([a-z-]+)/g)].map(
      (match) => match[1] as string,
    );
    expect(named.length).toBeGreaterThan(4);
    for (const verb of new Set(named)) {
      expect(VERBS as readonly string[]).toContain(verb);
    }
  });
});
