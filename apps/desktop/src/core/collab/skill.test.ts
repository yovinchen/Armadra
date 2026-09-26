import { afterEach, describe, expect, it } from "vitest";
import { VERBS as BROWSER_VERBS } from "../browser/args";
import {
  SKILLS_REVISION,
  registerSkillContent,
  skillContent,
} from "../hook/install/skills";
import {
  canvasInstructions,
  canvasRules,
  collaborationSkill,
  developerInstructions,
  installCollaborationSkill,
  skillBody,
} from "./skill";

/**
 * The texts the canvas injection hands a CLI.
 *
 * What is asserted is what the model depends on: the rules are there, early,
 * in every text; the verbs they name exist; and the browser verb list is the
 * browser domain's own list, not a copy that drifts.
 */

let release: (() => void) | undefined;

afterEach(() => {
  release?.();
  release = undefined;
});

describe("the collaboration skill", () => {
  it("carries a revision the integration can read back", () => {
    const body = skillBody();
    expect(body).toContain(
      `<!-- armadra:skill-revision ${SKILLS_REVISION} -->`,
    );
    // The three things an agent cannot discover on its own.
    expect(body).toContain("armadra-hook context list");
    expect(body).toContain("armadra-hook canvas post");
    expect(body).toContain("ARMADRA_HOOK_BIN");
  });

  /**
   * The sentence is only true now that the skill is injected per launch — and
   * the rules come right after it, before any section a model might skim past.
   */
  it("opens with the node sentence and the canvas rules", () => {
    const body = skillBody();
    const node = body.indexOf("本终端跑在 Armadra 画布的一个节点里");
    const rules = body.indexOf("## 画布规则");
    const firstSection = body.indexOf("## 你的名字");
    expect(node).toBeGreaterThan(0);
    expect(rules).toBeGreaterThan(node);
    expect(rules).toBeLessThan(firstSection);
  });

  it("states the three rules in so many words", () => {
    const rules = canvasRules();
    expect(rules).toContain("画布上的一个节点");
    expect(rules).toContain("armadra-hook canvas open-agent");
    expect(rules).toContain("armadra-hook canvas team");
    expect(rules).toContain("子代理");
    expect(rules).toContain("armadra-hook browser <动词>");
    expect(rules).toContain("armadra-hook canvas open-browser --url");
    expect(rules).toContain("computer-use");
  });

  /** One source: a verb the browser domain adds shows up here by itself. */
  it("lists every browser verb the browser domain dispatches", () => {
    const rules = canvasRules();
    for (const verb of BROWSER_VERBS) {
      expect(rules, verb).toContain(`\`${verb}\``);
    }
    const examples = [...rules.matchAll(/armadra-hook browser ([a-z-]+)/g)].map(
      (match) => match[1] as string,
    );
    expect(examples.length).toBeGreaterThan(1);
    for (const verb of examples) expect(BROWSER_VERBS).toContain(verb);
  });

  it("puts the rules and the skill path into both instruction forms", () => {
    const path = "/data/integration/codex/skills/armadra/SKILL.md";
    for (const text of [
      canvasInstructions(path),
      developerInstructions(path),
    ]) {
      expect(text).toContain(canvasRules());
      expect(text).toContain(path);
    }
  });

  it("registers itself as the content the injection writes", () => {
    registerSkillContent(undefined);
    expect(skillContent()).toBeUndefined();
    release = installCollaborationSkill();
    expect(skillContent()).toBe(collaborationSkill);
    expect(collaborationSkill.skill()).toBe(skillBody());
  });

  it("names only verbs the control dispatcher answers", async () => {
    const { VERBS } = await import("./control/index");
    const body = skillBody();
    const named = [...body.matchAll(/armadra-hook canvas ([a-z-]+)/g)].map(
      (match) => match[1] as string,
    );
    expect(named.length).toBeGreaterThan(4);
    expect(named).toContain("open-browser");
    for (const verb of new Set(named)) {
      expect(VERBS as readonly string[]).toContain(verb);
    }
  });
});
