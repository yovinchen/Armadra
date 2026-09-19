import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_REVISION } from "./events";

/**
 * The skill half of an install unit, and the seam the collaboration domain
 * fills in.
 *
 * Hook and skill are one install unit with one staleness question
 * (docs/design/agent-integration.md §2), so the integration routes below have
 * to know four things about the skill: where it lives, which revision is on
 * disk, how to write it and how to remove it. The first two are statements
 * about a path and a marker and live here; the body of `SKILL.md` is the
 * collaboration domain's, and it registers the writer.
 *
 * Until it does, the hook half installs on its own and the state reports the
 * skill half as not installed — which is the truth, and which is what the
 * settings page draws.
 */

/** The directory every supported CLI scans for user-level skills. */
export const SKILLS_ROOT = "skills";
/** The directory name we own under that root. */
export const SKILL_NAME = "armadra";

export { SKILLS_REVISION };

/**
 * The file this provider's skill lives in, installed or not. The settings page
 * shows it either way: "where it would go" is the answer to "why is this not
 * installed".
 */
export function skillFile(configHome: string): string {
  return join(configHome, SKILLS_ROOT, SKILL_NAME, "SKILL.md");
}

/**
 * The global instruction file a provider reads. Claude also reads `CLAUDE.md`;
 * the current installer's own block goes to `AGENTS.md`, and old ones may be
 * in either.
 */
export function instructionFile(configHome: string): string {
  return join(configHome, "AGENTS.md");
}

/**
 * The revision on disk, from the trailer the skill body carries.
 *
 * An HTML comment rather than a front matter key, because a CLI that validates
 * front matter should not have to know about a field only we read.
 */
export function installedRevision(configHome: string): number | undefined {
  let body: string;
  try {
    body = readFileSync(skillFile(configHome), "utf8");
  } catch {
    return undefined;
  }
  const marker = /<!--\s*armadra:skill-revision\s+(\d+)\s*-->/.exec(body);
  return marker === null ? undefined : Number(marker[1]);
}

/** What the collaboration domain registers to own the skill body. */
export interface SkillInstaller {
  install(agentId: string, configHome: string): readonly string[];
  uninstall(agentId: string, configHome: string): readonly string[];
}

let registered: SkillInstaller | undefined;

export function registerSkillInstaller(
  installer: SkillInstaller | undefined,
): () => void {
  registered = installer;
  return () => {
    if (registered === installer) registered = undefined;
  };
}

export function skillInstaller(): SkillInstaller | undefined {
  return registered;
}
