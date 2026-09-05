import { expect, it } from "vitest";
import { gitHunkMutationSchema, gitHunkResultSchema } from "./git-hunks";
const request = {
  file: "a 'quoted' file.txt",
  scope: "worktree",
  diffDigest: "a".repeat(64),
  hunkId: "b".repeat(64),
  action: "stage",
};
it("requires scope-matched hunk identities and rejects arbitrary client patch input", () => {
  expect(gitHunkMutationSchema.safeParse(request).success).toBe(true);
  expect(
    gitHunkMutationSchema.safeParse({ ...request, patch: "arbitrary" }).success,
  ).toBe(false);
  expect(
    gitHunkMutationSchema.safeParse({ ...request, scope: "staged" }).success,
  ).toBe(false);
  expect(
    gitHunkMutationSchema.safeParse({ ...request, diffDigest: "old" }).success,
  ).toBe(false);
  expect(
    gitHunkMutationSchema.safeParse({
      ...request,
      scope: "staged",
      action: "unstage",
    }).success,
  ).toBe(true);
});
it("never decodes an unapplied result as a successful operation", () => {
  expect(
    gitHunkResultSchema.safeParse({ ...request, applied: true }).success,
  ).toBe(true);
  expect(
    gitHunkResultSchema.safeParse({ ...request, applied: false }).success,
  ).toBe(false);
});
