import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_REVISION } from "./events";

/**
 * The skill half of an integration, and the seam the collaboration domain
 * fills in.
 *
 * The body of `SKILL.md` and the canvas instructions describe the
 * collaboration verbs, so they are the collaboration domain's
 * (`collab/skill.ts`); this module only knows where a skill lives and how its
 * revision is read back. The collaboration domain registers the text at
 * assembly; until it does, the injection artifacts are written without a skill
 * and the state reports the skill half as missing — which is the truth, and
 * what the settings page draws.
 */

/** The directory name every supported CLI scans for skills under. */
export const SKILLS_ROOT = "skills";
/** The directory name we own under that root. */
export const SKILL_NAME = "armadra";

export { SKILLS_REVISION };

/**
 * Where a skill sits under a skills root: `<root>/skills/armadra/SKILL.md`.
 *
 * The root is a CLI's global config home for the skill an earlier Armadra
 * installed there (the migration looks it up to remove it), and a directory
 * under our own data directory for the skill injected at launch now.
 */
export function skillFile(root: string): string {
  return join(root, SKILLS_ROOT, SKILL_NAME, "SKILL.md");
}

/**
 * A CLI's global instruction file. Only *read*: `repair.ts` looks for the
 * marked blocks much older versions wrote there. Nothing current writes a
 * global instruction file — the canvas instructions are injected per launch
 * (docs/design/canvas-only-integration.md).
 */
export function instructionFile(configHome: string): string {
  return join(configHome, "AGENTS.md");
}

/** The revision a skill file carries in its trailer, or `undefined`. */
export function revisionOf(path: string): number | undefined {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const marker = /<!--\s*armadra:skill-revision\s+(\d+)\s*-->/.exec(body);
  return marker === null ? undefined : Number(marker[1]);
}

/** The revision of the skill under a skills root, or `undefined`. */
export function installedRevision(root: string): number | undefined {
  return revisionOf(skillFile(root));
}

/**
 * What the collaboration domain registers: the three texts the injection
 * writes. Paths are passed in because the texts point at the full skill file
 * by its absolute path — a CLI with no per-launch skill loading (Codex) reads
 * it on demand from there.
 */
export interface SkillContent {
  /** The whole `SKILL.md`, revision trailer included. */
  skill(): string;
  /** The canvas instructions appended to the system prompt. */
  instructions(skillPath: string): string;
  /** The shorter form Codex takes as `developer_instructions`. */
  developerInstructions(skillPath: string): string;
}

let registered: SkillContent | undefined;

export function registerSkillContent(
  content: SkillContent | undefined,
): () => void {
  registered = content;
  return () => {
    if (registered === content) registered = undefined;
  };
}

export function skillContent(): SkillContent | undefined {
  return registered;
}
