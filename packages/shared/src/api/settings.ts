import { z } from "zod";

/**
 * `GET /api/settings/local` — which settings belong to this execution host
 * rather than to the account (Go Host 业务所有权迁移 §1.4).
 *
 * The list is served by the Runtime rather than declared here, because the
 * Runtime is what enforces it: a second copy in the front end would be a
 * second answer to "does this key travel", and the two would drift the first
 * time somebody added a key to one of them.
 *
 * A path here is dotted and matches by prefix — `language.servers` covers
 * `language.servers.rust.path` — which is the same rule the Runtime's own
 * split applies.
 */
export const localSettingsSchema = z.object({
  paths: z.array(z.string()).default([]),
  /** Where the file is, so the page can say it rather than imply it. */
  file: z.string().default(""),
});

export type LocalSettings = z.infer<typeof localSettingsSchema>;

/** Whether a dotted settings path is stored on this machine. */
export function isLocalSettingPath(paths: readonly string[], path: string) {
  return paths.some((local) => path === local || path.startsWith(`${local}.`));
}
