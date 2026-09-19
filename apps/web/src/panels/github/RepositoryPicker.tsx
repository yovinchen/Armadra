import * as React from "react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "@/app/preferences-store";
import { Field } from "../git/forms";
import { ResolveGithubRepositoryResponse } from "../../api/github";

export interface RepositoryPickerProps {
  remoteUrl: string;
  onRemoteUrl: (value: string) => void;
  onResolve: () => void;
  busy: boolean;
  resolved: ResolveGithubRepositoryResponse | undefined;
}

/**
 * The repository both tabs act on, resolved from a git remote URL.
 *
 * A `hostMismatch` answer ends here: the panel says so and offers nothing
 * else. Falling back to the public service would send an enterprise
 * repository's name — and this Host's token — somewhere it does not belong.
 */
export function RepositoryPicker({
  remoteUrl,
  onRemoteUrl,
  onResolve,
  busy,
  resolved,
}: RepositoryPickerProps) {
  const t = useT();
  const repository = resolved?.repository;
  return (
    <form
      className="min-w-0 space-y-2 border-b border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && remoteUrl.trim()) onResolve();
      }}
    >
      <Field label={t("github.remoteUrl")}>
        <Input
          value={remoteUrl}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onRemoteUrl(event.target.value)}
          className="h-9 min-w-0"
        />
      </Field>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        className="min-h-10"
        disabled={busy || !remoteUrl.trim()}
      >
        {t("github.resolve")}
      </Button>

      {resolved?.hostMismatch && (
        <p role="status" className="text-[12px] text-destructive">
          {t("github.hostMismatch")}
          {resolved.reasonCode ? ` · ${resolved.reasonCode}` : ""}
        </p>
      )}

      {repository?.ref && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
          <span className="min-w-0 truncate font-medium select-text">
            {repository.ref.owner}/{repository.ref.name}
          </span>
          <Badge variant="outline">{repository.ref.host}</Badge>
          {repository.permission && (
            <Badge variant="secondary" title={t("github.permission")}>
              {repository.permission}
            </Badge>
          )}
          {repository.defaultBranch && (
            <span className="min-w-0 truncate text-muted-foreground">
              {t("github.defaultBranch")} · {repository.defaultBranch}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
