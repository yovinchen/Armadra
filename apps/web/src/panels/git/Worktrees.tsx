import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitRepositoryAction, GitBranchRecord } from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import { useT } from "../../app/preferences-store";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Check, Field, ReadError, selectClass } from "./forms";

export function Worktrees({
  workspaceId,
  repositoryKey,
  branches,
  busy,
  request,
}: {
  workspaceId: string;
  repositoryKey: string;
  branches: GitBranchRecord[];
  busy: boolean;
  request: (action: GitRepositoryAction) => void;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const [startPoint, setStartPoint] = useState("");
  const selectedBranch = branches.find(
    (record) => !record.remote && record.name === branch,
  );
  const validBranch = createBranch
    ? Boolean(branch.trim())
    : Boolean(selectedBranch);
  const worktrees = useQuery({
    queryKey: ["git-repository-worktrees", workspaceId, repositoryKey],
    queryFn: ({ signal }) =>
      runtimeApi.gitRepositoryWorktrees(workspaceId, signal),
    retry: false,
  });
  return (
    <div className="space-y-3 p-3">
      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && path.trim() && validBranch)
            request({
              kind: "createWorktree",
              path: path.trim(),
              branch: branch.trim(),
              createBranch,
              expectedOid: createBranch ? null : selectedBranch!.oid,
              startPoint: createBranch ? startPoint.trim() || null : null,
            });
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <Field label={t("gitRepo.worktreePath")}>
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
            />
          </Field>
          <Field label={t("gitRepo.branchName")}>
            {createBranch ? (
              <Input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                required
              />
            ) : (
              <select
                className={selectClass}
                value={selectedBranch?.name ?? ""}
                onChange={(event) => setBranch(event.target.value)}
                required
              >
                <option value="">{t("gitRepo.chooseBranch")}</option>
                {branches
                  .filter((record) => !record.remote)
                  .map((record) => (
                    <option key={record.fullRef} value={record.name}>
                      {record.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <Check
            label={t("gitRepo.newWorktreeBranch")}
            checked={createBranch}
            onChange={setCreateBranch}
          />
          {createBranch && (
            <Field label={t("gitRepo.startPoint")}>
              <Input
                value={startPoint}
                onChange={(event) => setStartPoint(event.target.value)}
              />
            </Field>
          )}
          <Button
            size="sm"
            type="submit"
            disabled={!path.trim() || !validBranch}
          >
            {t("gitRepo.createWorktree")}
          </Button>
        </fieldset>
      </form>
      <p className="text-xs text-muted-foreground">
        {t("gitRepo.worktreeSafety")}
      </p>
      {worktrees.isPending && (
        <p role="status" className="text-xs">
          {t("gitRepo.loading")}
        </p>
      )}
      {worktrees.error && (
        <ReadError
          error={worktrees.error}
          retry={() => void worktrees.refetch()}
        />
      )}
      {worktrees.data?.map((tree) => (
        <section
          key={tree.path}
          className="space-y-2 rounded-md border border-border p-3 text-xs"
        >
          <h3 className="break-all font-mono">{tree.path}</h3>
          <p className="break-all">{tree.branch ?? t("gitRepo.detached")}</p>
          <p className="break-all font-mono text-muted-foreground">
            {tree.headOid ?? t("gitRepo.unborn")}
          </p>
          <div className="flex flex-wrap gap-1">
            {tree.isMain && (
              <Badge variant="outline">{t("gitRepo.mainWorktree")}</Badge>
            )}
            {tree.locked && (
              <Badge variant="outline">{t("gitRepo.locked")}</Badge>
            )}
            {tree.prunable && (
              <Badge variant="outline">{t("gitRepo.prunable")}</Badge>
            )}
          </div>
          <p>
            {!tree.accessible
              ? t("gitRepo.inaccessible")
              : t(
                  tree.dirty === null
                    ? "gitRepo.dirtyUnknown"
                    : tree.dirty
                      ? "gitRepo.dirty"
                      : "gitRepo.clean",
                )}
          </p>
          {(tree.lockReason || tree.pruneReason) && (
            <p className="break-words text-muted-foreground">
              {tree.lockReason ?? tree.pruneReason}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={
              busy ||
              worktrees.isFetching ||
              !tree.accessible ||
              tree.isMain ||
              tree.bare ||
              tree.locked ||
              tree.prunable ||
              tree.dirty !== false ||
              !tree.headOid
            }
            onClick={() =>
              request({
                kind: "removeWorktree",
                path: tree.path,
                expectedOid: tree.headOid!,
                allowUnpublished: false,
              })
            }
          >
            {t("gitRepo.removeWorktree")}
          </Button>
        </section>
      ))}
      {worktrees.data?.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("gitRepo.noWorktrees")}
        </p>
      )}
    </div>
  );
}
