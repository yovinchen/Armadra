import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/i);
const lineNumber = z.number().int().nonnegative().max(0xffff_ffff);
export const gitHunkScopeSchema = z.enum(["worktree", "staged"]);
export const gitHunkActionSchema = z.enum(["stage", "unstage", "revert"]);
export const gitHunkSchema = z.object({
  id: digest,
  header: z.string(),
  content: z.string(),
  oldStart: lineNumber,
  oldLines: lineNumber,
  newStart: lineNumber,
  newLines: lineNumber,
});
export const gitHunkDiffSchema = z.object({
  file: z.string().min(1),
  scope: gitHunkScopeSchema,
  diffDigest: digest,
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
  hunks: z.array(gitHunkSchema),
});
export const gitHunkMutationSchema = z
  .object({
    /**
     * The checkout the file lives in, workspace-relative; `.` is the root.
     * A nested repository's hunk used to be applied against the root's index,
     * which is a different repository and a patch that does not describe it.
     */
    path: z.string().min(1).default("."),
    file: z.string().min(1),
    scope: gitHunkScopeSchema,
    diffDigest: digest,
    hunkId: digest,
    action: gitHunkActionSchema,
  })
  .strict()
  .refine(
    (request) =>
      request.scope === "staged"
        ? request.action === "unstage"
        : request.action !== "unstage",
    { path: ["action"], message: "Hunk action does not match its diff scope" },
  );
export const gitHunkResultSchema = z.object({
  applied: z.literal(true),
  file: z.string().min(1),
  scope: gitHunkScopeSchema,
  action: gitHunkActionSchema,
  hunkId: digest,
});
export type GitHunkScope = z.infer<typeof gitHunkScopeSchema>;
export type GitHunkAction = z.infer<typeof gitHunkActionSchema>;
export type GitHunk = z.infer<typeof gitHunkSchema>;
export type GitHunkDiff = z.infer<typeof gitHunkDiffSchema>;
export type GitHunkMutation = z.infer<typeof gitHunkMutationSchema>;
export type GitHunkResult = z.infer<typeof gitHunkResultSchema>;
