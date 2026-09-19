import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useT } from "@/app/preferences-store";
import { failureKey } from "./model";
import {
  TargetSelect,
  linkReferenceTo,
  parseTarget,
  targetKindKey,
  useLinkTargets,
} from "./link-targets";
import { githubKeys } from "./queries";
import {
  GithubApi,
  GithubExternalReference,
  GithubReferenceKind,
  GithubRepositoryRef,
} from "../../api/github";

export interface ReferenceSectionProps {
  client: GithubApi;
  workspaceId: string;
  repository: GithubRepositoryRef;
  kind: GithubReferenceKind;
  number: bigint;
  /** The remote title, stored with the link so a badge reads offline. */
  title: string;
  references: readonly GithubExternalReference[];
  canWrite: boolean;
}

/**
 * The local sessions, branches and worktrees one remote item is linked to
 * (Git/GitHub design §7.1).
 *
 * A link is a badge and a way back, so linking and unlinking touch nothing on
 * either side. A read-only device sees the list and no controls at all: the
 * Host would refuse both writes, and a button that always fails is worse than
 * showing only what exists.
 */
export function ReferenceSection({
  client,
  workspaceId,
  repository,
  kind,
  number,
  title,
  references,
  canWrite,
}: ReferenceSectionProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [target, setTarget] = React.useState("");
  const targets = useLinkTargets(canWrite ? workspaceId : "");

  // The node badges read their own query, so every link and unlink has to
  // invalidate the reference queries, not only this detail view.
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: githubKeys.all });
  const fail = (error: unknown) => toast.error(t(failureKey(error)));

  const link = useMutation({
    mutationFn: (value: string) => {
      const chosen = parseTarget(value);
      if (!chosen) throw new Error(t("github.link.choose"));
      return linkReferenceTo(client, {
        repository,
        kind,
        number,
        title,
        target: chosen,
      });
    },
    onSuccess: (result) => {
      toast.success(
        t(result === "already" ? "github.link.already" : "github.link.linked"),
      );
      setTarget("");
      void refresh();
    },
    onError: fail,
  });

  const unlink = useMutation({
    mutationFn: (reference: GithubExternalReference) =>
      client.unlinkReference({
        referenceId: reference.referenceId,
        // The revision that was displayed: a link changed elsewhere is refused.
        expectedRevision: reference.revision,
      }),
    onSuccess: () => {
      toast.success(t("github.link.unlinked"));
      void refresh();
    },
    onError: fail,
  });

  const busy = link.isPending || unlink.isPending;

  return (
    <section data-slot="github-references" className="min-w-0 space-y-2">
      <h4 className="text-[12px] font-medium text-muted-foreground">
        {t("github.issue.references")}
      </h4>
      {references.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          {t("github.link.none")}
        </p>
      ) : (
        <ul className="min-w-0 space-y-1">
          {references.map((reference) => (
            <li
              key={reference.referenceId}
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              <Badge variant="outline">
                {t(targetKindKey(reference.targetKind))}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[12px] select-text">
                {reference.targetId}
              </span>
              {canWrite && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-10"
                  disabled={busy}
                  onClick={() => unlink.mutate(reference)}
                >
                  {t("github.link.unlink")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite &&
        (targets.empty ? (
          <p className="text-[12px] text-muted-foreground">
            {t("github.link.noTargets")}
          </p>
        ) : (
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <TargetSelect
                value={target}
                targets={targets}
                disabled={busy}
                onChange={setTarget}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-10"
              disabled={busy || !target}
              onClick={() => link.mutate(target)}
            >
              {t("github.link.submit")}
            </Button>
          </div>
        ))}
    </section>
  );
}
