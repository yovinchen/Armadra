// 提交框：消息、修补上一次提交的两级确认，以及提交按钮。判断（能不能提交、
// 能不能修补）由抽屉算好后传进来。
import type { GitHeadCommit } from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";

export function CommitComposer({
  message,
  setMessage,
  head,
  amend,
  amendable,
  toggleAmend,
  acknowledgePublished,
  setAcknowledgePublished,
  canCommit,
  commit,
  compact,
  hunkOpen,
}: {
  message: string;
  setMessage: (value: string) => void;
  head: GitHeadCommit | null;
  amend: boolean;
  amendable: boolean;
  toggleAmend: (next: boolean) => void;
  acknowledgePublished: boolean;
  setAcknowledgePublished: (next: boolean) => void;
  canCommit: boolean;
  commit: (message: string) => void;
  compact: boolean;
  hunkOpen: boolean;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2 border-t border-border p-3",
        compact && hunkOpen && "hidden",
      )}
    >
      <Textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder={t("scm.message")}
        aria-label={t("scm.message")}
        className="min-h-[64px] resize-none"
      />
      {head && (
        <div className="space-y-1 text-xs">
          <label className="flex min-h-8 items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-[var(--brand)]"
              checked={amend}
              disabled={!amendable}
              onChange={(event) => toggleAmend(event.target.checked)}
            />
            {t("scm.amend")}
          </label>
          {amend && (
            <>
              <p className="break-words text-muted-foreground">
                {t("scm.amendTarget")}:{" "}
                <span className="font-mono">{head.oid.slice(0, 10)}</span>{" "}
                {head.subject}
              </p>
              <p className="text-muted-foreground">{t("scm.amendSafety")}</p>
            </>
          )}
          {!amendable && (
            <p className="text-muted-foreground">{t("scm.amendUnavailable")}</p>
          )}
          {amend && head.published && (
            <label className="flex min-h-8 items-center gap-2 rounded-md border border-destructive p-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand)]"
                checked={acknowledgePublished}
                onChange={(event) =>
                  setAcknowledgePublished(event.target.checked)
                }
              />
              {t("scm.amendPublished")}
            </label>
          )}
        </div>
      )}
      <Button
        className="self-end"
        size="sm"
        disabled={!canCommit}
        onClick={() => commit(message.trim())}
      >
        {t(amend ? "scm.amendCommit" : "scm.commit")}
      </Button>
    </div>
  );
}
