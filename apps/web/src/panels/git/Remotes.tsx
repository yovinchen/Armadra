import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  GitExpectedState,
  GitRemoteRecord,
  GitRepositoryAction,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Badge } from "../../ui/badge";
import { Field, ReadError } from "./forms";

/**
 * 展示用的 URL 脱敏，和 Runtime 的规则一致：http/https/ssh 里的 userinfo
 * 一律换成 `[redacted]`。用户刚输入的 URL 也会经过它，免得凭据留在本次
 * 会话的操作列表里。
 */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^(https?|ssh):\/\/[^/\s@]+@/i, "$1://[redacted]@");
}

export interface RemotesProps {
  workspaceId: string;
  repositoryKey: string;
  busy: boolean;
  loadRemotes: (signal: AbortSignal) => Promise<GitRemoteRecord[]>;
  request: (action: GitRepositoryAction, expected?: GitExpectedState) => void;
}

/**
 * 远端页。列出的 URL 已经由 Runtime 去掉其中的凭据，因此它是展示值：
 * 改地址时必须重新输入完整 URL，界面不会把打码后的值回填再送回去。
 */
export function Remotes({
  workspaceId,
  repositoryKey,
  busy,
  loadRemotes,
  request,
}: RemotesProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [renames, setRenames] = useState<Record<string, string>>({});
  const remotes = useQuery({
    queryKey: ["git-repository-remotes", workspaceId, repositoryKey],
    queryFn: ({ signal }) => loadRemotes(signal),
    retry: false,
  });
  return (
    <div className="min-w-0 space-y-3 p-3 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={remotes.isFetching}
        onClick={() => void remotes.refetch()}
      >
        {t("gitRepo.refresh")}
      </Button>
      {remotes.isPending && <p role="status">{t("gitRepo.loading")}</p>}
      {remotes.error && (
        <ReadError error={remotes.error} retry={() => void remotes.refetch()} />
      )}
      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !name.trim() || !url.trim()) return;
          request({ kind: "addRemote", name: name.trim(), url: url.trim() });
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <Field label={t("gitRepo.remoteName")}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="off"
            />
          </Field>
          <Field label={t("gitRepo.remoteUrl")}>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              autoComplete="off"
            />
          </Field>
          <p className="text-muted-foreground">{t("gitRepo.remoteSafety")}</p>
          <Button
            size="sm"
            type="submit"
            disabled={!name.trim() || !url.trim()}
          >
            {t("gitRepo.addRemote")}
          </Button>
        </fieldset>
      </form>
      {remotes.data?.length === 0 && <p>{t("gitRepo.noRemote")}</p>}
      {remotes.data?.map((remote) => (
        <section
          key={remote.name}
          className="min-w-0 space-y-2 rounded-md border border-border p-2"
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 break-all font-mono">
              {remote.name}
            </span>
            {remote.redacted && (
              <Badge variant="outline">{t("gitRepo.remoteRedacted")}</Badge>
            )}
          </div>
          <p className="break-all font-mono text-muted-foreground">
            {remote.fetchUrl}
          </p>
          {remote.pushUrl !== remote.fetchUrl && (
            <p className="break-all font-mono text-muted-foreground">
              → {remote.pushUrl}
            </p>
          )}
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = (edits[remote.name] ?? "").trim();
              if (busy || !next) return;
              request({ kind: "setRemoteUrl", name: remote.name, url: next });
            }}
          >
            <fieldset disabled={busy} className="min-w-0 space-y-2">
              <Field label={t("gitRepo.remoteNewUrl")}>
                <Input
                  value={edits[remote.name] ?? ""}
                  onChange={(event) =>
                    setEdits((current) => ({
                      ...current,
                      [remote.name]: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
              <Button
                size="sm"
                type="submit"
                variant="outline"
                disabled={!(edits[remote.name] ?? "").trim()}
              >
                {t("gitRepo.setRemoteUrl")}
              </Button>
              <Field label={t("gitRepo.remoteNewName")}>
                <Input
                  value={renames[remote.name] ?? ""}
                  onChange={(event) =>
                    setRenames((current) => ({
                      ...current,
                      [remote.name]: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={
                    !(renames[remote.name] ?? "").trim() ||
                    (renames[remote.name] ?? "").trim() === remote.name
                  }
                  onClick={() =>
                    request({
                      kind: "renameRemote",
                      name: remote.name,
                      newName: (renames[remote.name] ?? "").trim(),
                    })
                  }
                >
                  {t("gitRepo.renameRemote")}
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    request({ kind: "removeRemote", name: remote.name })
                  }
                >
                  {t("gitRepo.removeRemote")}
                </Button>
              </div>
            </fieldset>
          </form>
        </section>
      ))}
    </div>
  );
}
