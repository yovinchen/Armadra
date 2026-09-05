import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GIT_MESSAGE_LANGUAGES,
  type GitMessageProvider,
  type GitMessageSource,
  type GitMessageRequest,
  type GitMessageDraft,
  type GitMessageLanguage,
} from "@armadra/shared";
import { usePreferencesStore, useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { Check, Field, selectClass } from "./forms";

export interface CommitMessageAssistantProps {
  workspaceId: string;
  message: string;
  onFill: (message: string) => void;
  providers: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<GitMessageProvider[]>;
  source: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<GitMessageSource>;
  generate: (
    workspaceId: string,
    request: GitMessageRequest,
  ) => Promise<GitMessageDraft>;
}
export function CommitMessageAssistant(props: CommitMessageAssistantProps) {
  return <AssistantSession key={props.workspaceId} {...props} />;
}
const reasons = new Set([
  "notInstalled",
  "unsupportedCli",
  "missingCredentials",
  "unsupportedEndpoint",
]);
function AssistantSession({
  workspaceId,
  message,
  onFill,
  providers,
  source,
  generate,
}: CommitMessageAssistantProps) {
  const t = useT();
  const client = useQueryClient();
  const choices = useQuery({
    queryKey: ["git-message-providers", workspaceId],
    queryFn: ({ signal }) => providers(workspaceId, signal),
    retry: false,
  });
  const baseline = useQuery({
    queryKey: ["git-message-source", workspaceId],
    queryFn: ({ signal }) => source(workspaceId, signal),
    retry: false,
  });
  const [chosen, setChosen] = useState("");
  const selected =
    choices.data?.find((provider) => provider.id === chosen) ??
    choices.data?.find((provider) => provider.available) ??
    choices.data?.[0];
  const [draft, setDraft] = useState<{
    value: GitMessageDraft;
    revision: number;
  } | null>(null);
  /*
   * 草稿选项（A05）。它们只改写给隔离提供方的那句指令：读哪些文件、排除哪些、
   * 敏感行怎么处理、用哪几个 digest 复核，全都不受影响。默认语言跟界面语言
   * 走——想要另一种的人会自己改，反过来则要每次都改。
   */
  const [language, setLanguage] = useState<GitMessageLanguage>(() =>
    usePreferencesStore.getState().locale === "zh-CN" ? "zh" : "en",
  );
  const [conventional, setConventional] = useState(false);
  const [busy, setBusy] = useState<"generate" | "fill" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true),
    running = useRef(false),
    current = useRef({ message, revision: 0 });
  if (current.current.message !== message) {
    current.current = { message, revision: current.current.revision + 1 };
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const updateSource = async () => {
    const value = await source(workspaceId);
    if (active.current)
      client.setQueryData(["git-message-source", workspaceId], value);
    return value;
  };
  const makeDraft = async () => {
    if (
      running.current ||
      !selected?.available ||
      selected.id !== "claude-bare" ||
      selected.id !== "claude-bare"
    )
      return;
    const revision = current.current.revision;
    running.current = true;
    setBusy("generate");
    setError(null);
    setDraft(null);
    try {
      const before = await updateSource();
      if (!active.current) return;
      if (!before.includedFiles.length) throw new Error(t("gitMessage.empty"));
      const result = await generate(workspaceId, {
        provider: "claude-bare",
        expectedHead: before.expectedHead,
        indexDigest: before.indexDigest,
        language,
        conventional,
      });
      if (!active.current) return;
      if (
        result.expectedHead !== before.expectedHead ||
        result.indexDigest !== before.indexDigest ||
        result.sourceDigest !== before.sourceDigest
      )
        throw new Error(t("gitMessage.stale"));
      setDraft({ value: result, revision });
    } catch (error) {
      if (active.current)
        setError(
          error instanceof Error ? error.message : t("gitMessage.failed"),
        );
    } finally {
      running.current = false;
      if (active.current) setBusy(null);
    }
  };
  const fill = async () => {
    if (!draft || running.current) return;
    setError(null);
    if (draft.revision !== current.current.revision) {
      setError(t("gitMessage.edited"));
      return;
    }
    running.current = true;
    setBusy("fill");
    try {
      const now = await updateSource();
      if (!active.current) return;
      if (draft.revision !== current.current.revision)
        throw new Error(t("gitMessage.edited"));
      if (
        now.sourceDigest !== draft.value.sourceDigest ||
        now.indexDigest !== draft.value.indexDigest ||
        now.expectedHead !== draft.value.expectedHead
      )
        throw new Error(t("gitMessage.stale"));
      onFill(draft.value.message);
      setDraft(null);
    } catch (error) {
      if (active.current)
        setError(
          error instanceof Error ? error.message : t("gitMessage.sourceFailed"),
        );
    } finally {
      running.current = false;
      if (active.current) setBusy(null);
    }
  };
  const observed = draft?.value ?? baseline.data;
  return (
    <section
      aria-label={t("gitMessage.title")}
      className="max-h-[50dvh] overflow-y-auto min-w-0 space-y-2 rounded-md border border-border p-3 text-xs"
    >
      <h3 className="font-medium">{t("gitMessage.title")}</h3>
      <p className="text-muted-foreground">{t("gitMessage.note")}</p>
      <Field label={t("gitMessage.provider")}>
        <select
          className={selectClass}
          value={selected?.id ?? ""}
          disabled={busy !== null}
          onChange={(event) => setChosen(event.target.value)}
        >
          {choices.data?.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("gitMessage.language")}>
        <select
          className={selectClass}
          value={language}
          disabled={busy !== null}
          onChange={(event) =>
            setLanguage(event.target.value as GitMessageLanguage)
          }
        >
          {GIT_MESSAGE_LANGUAGES.map((value) => (
            <option key={value} value={value}>
              {t(`gitMessage.language.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <Check
        label={t("gitMessage.conventional")}
        checked={conventional}
        onChange={setConventional}
      />
      <p className="break-words text-muted-foreground">
        {t("gitMessage.optionsNote")}
      </p>
      <p className="break-words text-muted-foreground">
        {t("gitMessage.credentials")}
      </p>
      {selected && (!selected.available || selected.id !== "claude-bare") && (
        <p role="status">
          {t(
            selected.reason && reasons.has(selected.reason)
              ? `gitMessage.reason.${selected.reason}`
              : "gitMessage.unavailable",
          )}
        </p>
      )}
      {!choices.isPending && !choices.error && !selected && (
        <p>{t("gitMessage.unavailable")}</p>
      )}
      {(choices.error || baseline.error) && (
        <p role="alert" className="break-words text-destructive">
          {(choices.error ?? baseline.error)?.message}
        </p>
      )}
      {baseline.data?.includedFiles.length === 0 && (
        <p role="status">{t("gitMessage.empty")}</p>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            busy !== null ||
            !selected?.available ||
            selected.id !== "claude-bare" ||
            baseline.isPending ||
            baseline.isError ||
            !baseline.data?.includedFiles.length
          }
          onClick={() => void makeDraft()}
        >
          {t(
            busy === "generate"
              ? "gitMessage.generating"
              : "gitMessage.generate",
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            void choices.refetch();
            void baseline.refetch();
          }}
        >
          {t("gitMessage.reload")}
        </Button>
      </div>
      {observed && (
        <>
          <details>
            <summary className="cursor-pointer">
              {t("gitMessage.included")} ({observed.includedFiles.length}) ·{" "}
              {t("gitMessage.excluded")} ({observed.excludedFiles.length})
            </summary>
            <div className="max-h-32 space-y-2 overflow-auto py-2">
              <p>{t("gitMessage.included")}</p>
              {observed.includedFiles.map((file) => (
                <p key={`in:${file}`} className="break-all font-mono">
                  {file}
                </p>
              ))}
              <p>{t("gitMessage.excluded")}</p>
              {observed.excludedFiles.map((file) => (
                <p key={`out:${file}`} className="break-all font-mono">
                  {file}
                </p>
              ))}
            </div>
          </details>
          {observed.truncated && <p>{t("gitMessage.truncated")}</p>}
          {observed.redacted && <p>{t("gitMessage.redacted")}</p>}
        </>
      )}
      {draft && (
        <>
          <Field label={t("gitMessage.preview")}>
            <Textarea
              readOnly
              value={draft.value.message}
              className="min-h-24"
            />
          </Field>
          {draft.revision !== current.current.revision && (
            <p role="status">{t("gitMessage.edited")}</p>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy !== null || draft.revision !== current.current.revision
            }
            onClick={() => void fill()}
          >
            {t(busy === "fill" ? "gitMessage.checking" : "gitMessage.fill")}
          </Button>
          <p className="text-muted-foreground">{t("gitMessage.draftOnly")}</p>
        </>
      )}
    </section>
  );
}
