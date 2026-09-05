import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  GitExpectedState,
  GitRepositoryAction,
  GitTagSnapshot,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Badge } from "../../ui/badge";
import { Check, Field, ReadError, selectClass } from "./forms";

export interface TagsProps {
  workspaceId: string;
  repositoryKey: string;
  remotes: string[];
  busy: boolean;
  loadTags: (signal: AbortSignal) => Promise<GitTagSnapshot>;
  request: (action: GitRepositoryAction, expected?: GitExpectedState) => void;
}

/**
 * 标签页。每个写操作都带上这一行观察到的对象 ID：删除和推送确认的是
 * 标签对象本身，不是它指向的提交，所以标签被重新指向后旧请求会被拒绝。
 */
export function Tags({
  workspaceId,
  repositoryKey,
  remotes,
  busy,
  loadTags,
  request,
}: TagsProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [annotated, setAnnotated] = useState(false);
  const [message, setMessage] = useState("");
  const [chosenRemote, setRemote] = useState("");
  const remote = remotes.includes(chosenRemote)
    ? chosenRemote
    : (remotes[0] ?? "");
  const tags = useQuery({
    queryKey: ["git-repository-tags", workspaceId, repositoryKey],
    queryFn: ({ signal }) => loadTags(signal),
    retry: false,
  });
  const head = tags.data?.head.headOid ?? null;
  const targetOid = target.trim() || head;
  return (
    <div className="min-w-0 space-y-3 p-3 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={tags.isFetching}
        onClick={() => void tags.refetch()}
      >
        {t("gitRepo.refresh")}
      </Button>
      {tags.isPending && <p role="status">{t("gitRepo.loading")}</p>}
      {tags.error && (
        <ReadError error={tags.error} retry={() => void tags.refetch()} />
      )}
      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !name.trim() || !targetOid) return;
          request({
            kind: "createTag",
            name: name.trim(),
            targetOid,
            message: annotated ? message : null,
          });
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <Field label={t("gitRepo.tagName")}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="off"
            />
          </Field>
          <Field label={t("gitRepo.tagTarget")}>
            <Input
              value={target}
              placeholder={head ?? ""}
              onChange={(event) => setTarget(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Check
            label={t("gitRepo.tagAnnotated")}
            checked={annotated}
            onChange={setAnnotated}
          />
          {annotated && (
            <Field label={t("gitRepo.tagMessage")}>
              <Input
                maxLength={4096}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                required
              />
            </Field>
          )}
          <p className="text-muted-foreground">{t("gitRepo.tagSafety")}</p>
          <Button
            size="sm"
            type="submit"
            disabled={
              !name.trim() || !targetOid || (annotated && !message.trim())
            }
          >
            {t("gitRepo.createTag")}
          </Button>
        </fieldset>
      </form>
      <Field label={t("gitRepo.remote")}>
        <select
          aria-label={t("gitRepo.remote")}
          className={selectClass}
          value={remote}
          onChange={(event) => setRemote(event.target.value)}
          disabled={busy}
        >
          {remotes.length ? (
            remotes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))
          ) : (
            <option value="">{t("gitRepo.noRemote")}</option>
          )}
        </select>
      </Field>
      {tags.data?.tags.length === 0 && <p>{t("gitRepo.noTags")}</p>}
      {tags.data?.tags.map((tag) => (
        <section
          key={tag.fullRef}
          className="min-w-0 space-y-2 rounded-md border border-border p-2"
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 break-all font-mono">
              {tag.name}
            </span>
            <Badge variant="outline">
              {t(tag.annotated ? "gitRepo.annotated" : "gitRepo.lightweight")}
            </Badge>
          </div>
          <p className="break-all font-mono text-muted-foreground">
            {tag.targetOid.slice(0, 12)}
          </p>
          {tag.subject && <p className="break-words">{tag.subject}</p>}
          {tag.taggerName && (
            <p className="break-words text-muted-foreground">
              {tag.taggerName}
              {tag.taggerTime ? ` · ${tag.taggerTime}` : ""}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !remote}
              onClick={() =>
                request({
                  kind: "pushTag",
                  remote,
                  name: tag.name,
                  expectedOid: tag.oid,
                })
              }
            >
              {t("gitRepo.pushTag")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                request({
                  kind: "deleteTag",
                  name: tag.name,
                  expectedOid: tag.oid,
                })
              }
            >
              {t("gitRepo.deleteTag")}
            </Button>
          </div>
        </section>
      ))}
    </div>
  );
}
