/**
 * 提交页底部的消息区（Git 工具窗口设计 §2.3）。
 *
 * 一条信息，多个仓库：跨仓库勾选时按仓库各提交一次、用同一条信息（设计 §4 明
 * 说不做跨仓库的一次提交）。所以这里的进度不是一个转圈，而是一个仓库一行的
 * 结果——四个仓库里第三个失败时，必须看得出前两个已经提交出去了。
 */
import { useState } from "react";
import type { GitHeadCommit } from "@armadra/shared";
import { ChevronDown, History, Sparkles } from "lucide-react";
import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { Button } from "../../../ui/button";
import { Textarea } from "../../../ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { CommitMessageAssistant } from "../CommitMessageAssistant";

/** 一个仓库这一轮提交的结果。 */
export interface CommitOutcome {
  repositoryPath: string;
  name: string;
  state: "queued" | "running" | "committed" | "failed";
  commit?: string;
  error?: string;
}

export interface CommitMessageProps {
  workspaceId: string;
  message: string;
  onMessageChange: (message: string) => void;
  /** 最近用过的信息，最新的在前。 */
  history: readonly string[];
  amend: boolean;
  onAmendChange: (next: boolean) => void;
  /** 要修补的那一次提交；跨仓库时是 `null`，那时不提供修补。 */
  head: GitHeadCommit | null;
  acknowledgePublished: boolean;
  onAcknowledgePublished: (next: boolean) => void;
  /** 这一次会被提交的仓库。 */
  targets: readonly { repositoryPath: string; name: string }[];
  outcomes: readonly CommitOutcome[];
  busy: boolean;
  showRepositories: boolean;
  onCommit: (options: { push: boolean }) => void;
}

export function CommitMessage({
  workspaceId,
  message,
  onMessageChange,
  history,
  amend,
  onAmendChange,
  head,
  acknowledgePublished,
  onAcknowledgePublished,
  targets,
  outcomes,
  busy,
  showRepositories,
  onCommit,
}: CommitMessageProps) {
  const t = useT();
  const [assistant, setAssistant] = useState(false);
  // 跨仓库时不提供修补：`--amend` 要绑定**那个仓库**读到的 HEAD，四个仓库就是
  // 四个不同的 HEAD，一个开关代表不了它们。
  const single = targets.length === 1;
  const amendable = single && Boolean(head) && !head!.truncated;
  const blocked =
    amend && (!amendable || (head!.published && !acknowledgePublished));
  const canCommit =
    message.trim().length > 0 && targets.length > 0 && !busy && !blocked;
  return (
    <section
      aria-label={t("gitCommit.message")}
      className="flex shrink-0 flex-col gap-2 border-t border-border p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-muted-foreground">
          {t("gitCommit.message")}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={history.length === 0}
              aria-label={t("gitCommit.history")}
            >
              <History aria-hidden />
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[min(28rem,90vw)]">
            {history.map((entry) => (
              <DropdownMenuItem
                key={entry}
                className="block truncate"
                onSelect={() => onMessageChange(entry)}
              >
                {entry.split("\n")[0]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={assistant}
          onClick={() => setAssistant((open) => !open)}
        >
          <Sparkles aria-hidden />
          {t("gitCommit.assistant")}
        </Button>
      </div>
      {assistant && (
        // 生成本身仍然是 `CommitMessageAssistant`：它带着自己的那套复核——生成
        // 前后各读一次索引摘要，对不上就拒绝回填，而不是把一条描述别的改动的
        // 信息塞进输入框。
        <CommitMessageAssistant
          workspaceId={workspaceId}
          message={message}
          onFill={onMessageChange}
          providers={runtimeApi.gitMessageProviders}
          source={runtimeApi.gitMessageSource}
          generate={runtimeApi.gitMessageGenerate}
        />
      )}
      <Textarea
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        placeholder={t("gitCommit.messagePlaceholder")}
        aria-label={t("gitCommit.message")}
        className="min-h-[72px] resize-none"
      />
      <div className="space-y-1 text-xs">
        <label className="flex min-h-8 items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-[var(--brand)]"
            checked={amend}
            disabled={!amendable}
            onChange={(event) => onAmendChange(event.target.checked)}
          />
          {t("gitCommit.amend")}
        </label>
        {!single && targets.length > 1 && (
          <p className="text-muted-foreground">
            {t("gitCommit.amendMultiple")}
          </p>
        )}
        {single && !amendable && (
          <p className="text-muted-foreground">{t("scm.amendUnavailable")}</p>
        )}
        {amend && head && (
          <>
            <p className="break-words text-muted-foreground">
              {t("scm.amendTarget")}:{" "}
              <span className="font-mono">{head.oid.slice(0, 10)}</span>{" "}
              {head.subject}
            </p>
            <p className="text-muted-foreground">{t("scm.amendSafety")}</p>
            {head.published && (
              <label className="flex min-h-8 items-center gap-2 rounded-md border border-destructive p-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--brand)]"
                  checked={acknowledgePublished}
                  onChange={(event) =>
                    onAcknowledgePublished(event.target.checked)
                  }
                />
                {t("scm.amendPublished")}
              </label>
            )}
          </>
        )}
      </div>
      {targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("gitCommit.nothingSelected")}
        </p>
      ) : (
        showRepositories && (
          <p className="break-words text-xs text-muted-foreground">
            {t("gitCommit.commitsInto", {
              count: targets.length,
              repositories: targets.map((target) => target.name).join(", "),
            })}
          </p>
        )
      )}
      {outcomes.length > 0 && (
        <ul aria-label={t("gitCommit.progress")} className="space-y-1 text-xs">
          {outcomes.map((outcome) => (
            <li
              key={outcome.repositoryPath}
              className="flex min-w-0 items-start gap-2"
            >
              <span className="min-w-0 flex-1 truncate">{outcome.name}</span>
              <span
                className={
                  outcome.state === "failed"
                    ? "shrink-0 text-destructive"
                    : "shrink-0 text-muted-foreground"
                }
              >
                {outcome.state === "committed" && outcome.commit
                  ? outcome.commit.slice(0, 7)
                  : t(`gitCommit.state.${outcome.state}`)}
              </span>
            </li>
          ))}
          {outcomes
            .filter((outcome) => outcome.error)
            .map((outcome) => (
              <li
                key={`${outcome.repositoryPath}:error`}
                role="alert"
                className="break-words text-destructive"
              >
                {outcome.name}: {outcome.error}
              </li>
            ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canCommit}
          onClick={() => onCommit({ push: true })}
        >
          {t("gitCommit.commitAndPush")}
        </Button>
        <Button
          size="sm"
          disabled={!canCommit}
          onClick={() => onCommit({ push: false })}
        >
          {t(amend ? "gitCommit.amendCommit" : "gitCommit.commit")}
        </Button>
      </div>
    </section>
  );
}
