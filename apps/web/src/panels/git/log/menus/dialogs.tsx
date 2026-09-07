import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitRemoteRecord, GitStashDetail } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { Button } from "../../../../ui/button";
import { Input } from "../../../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../ui/dialog";
import { ReadError } from "../../forms";
import { redactRemoteUrl } from "../../actions/refs";
import type { NamePrompt, NamePromptValue, StashDiffTarget } from "./context";
import {
  promptAction,
  promptFields,
  promptLabelKey,
  promptTitleKey,
} from "./prompt-action";

/**
 * 右键菜单放不下的那两类东西：要输入的，和要读一段文本回来看的。
 */

/** 新建 / 改名 / 改地址共用的一个输入对话框。 */
export function NamePromptDialog({
  prompt,
  onClose,
  onSubmit,
  loadRemotes,
}: {
  prompt: NamePrompt | null;
  onClose: () => void;
  onSubmit: (prompt: NamePrompt, value: NamePromptValue) => void;
  /** 只有「修改远端地址」用得上：先把现在那一条脱敏后显示出来。 */
  loadRemotes?: (
    repositoryPath: string,
    signal: AbortSignal,
  ) => Promise<GitRemoteRecord[]>;
}) {
  const t = useT();
  const [value, setValue] = useState<NamePromptValue>({ name: "", url: "" });
  // 换一条提示就换一组输入：上一次填了一半的名字不该出现在下一次的框里。
  useEffect(() => setValue({ name: "", url: "" }), [prompt]);
  const fields = prompt
    ? promptFields(prompt.kind)
    : { name: false, url: false };
  const action = prompt ? promptAction(prompt, value) : null;

  const remotes = useQuery({
    queryKey: ["git-log-remote-url", prompt?.repositoryPath, prompt?.reference],
    queryFn: ({ signal }) => loadRemotes!(prompt!.repositoryPath, signal),
    enabled: Boolean(
      loadRemotes && prompt?.kind === "remoteUrl" && prompt.repositoryPath,
    ),
    retry: false,
  });
  const currentRemote = remotes.data?.find(
    (record) => record.name === prompt?.reference,
  );

  const submit = () => {
    if (!prompt || !action) return;
    onSubmit(prompt, value);
  };

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(promptTitleKey(prompt))}</DialogTitle>
          {prompt?.reference && (
            <DialogDescription className="break-all font-mono">
              {prompt.reference}
            </DialogDescription>
          )}
        </DialogHeader>
        {fields.name && (
          <Input
            value={value.name}
            autoFocus
            aria-label={t(promptLabelKey(prompt?.kind ?? "branch"))}
            onChange={(event) =>
              setValue((previous) => ({
                ...previous,
                name: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !action) return;
              event.preventDefault();
              submit();
            }}
          />
        )}
        {fields.url && (
          <>
            <Input
              value={value.url}
              autoFocus={!fields.name}
              autoComplete="off"
              aria-label={t(
                prompt?.kind === "remoteUrl"
                  ? "gitRepo.remoteNewUrl"
                  : "gitRepo.remoteUrl",
              )}
              onChange={(event) =>
                setValue((previous) => ({
                  ...previous,
                  url: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !action) return;
                event.preventDefault();
                submit();
              }}
            />
            {prompt?.kind === "remoteUrl" && (
              <p className="text-xs text-muted-foreground">
                {t("gitLog.menu.remoteUrlRetype")}
              </p>
            )}
          </>
        )}
        {currentRemote && (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {/* 脱敏之后才显示，并且不回填——`[redacted]` 写回配置就把凭据删了。 */}
            {redactRemoteUrl(currentRemote.fetchUrl)}
          </p>
        )}
        {prompt?.oid && (
          <p className="font-mono text-xs text-muted-foreground">
            {prompt.oid.slice(0, 12)}
          </p>
        )}
        <DialogFooter>
          <Button disabled={!action} onClick={submit}>
            {t("gitRepo.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 一条 stash 存了什么。只读：应用 / 弹出 / 删除仍然走右键菜单里那三项，
 * 也就仍然经确认门。
 */
export function StashDiffDialog({
  target,
  onClose,
  load,
}: {
  target: StashDiffTarget | null;
  onClose: () => void;
  load: (
    repositoryPath: string,
    oid: string,
    signal: AbortSignal,
  ) => Promise<GitStashDetail>;
}) {
  const t = useT();
  const detail = useQuery({
    queryKey: ["git-log-stash-detail", target?.repositoryPath, target?.oid],
    queryFn: ({ signal }) => load(target!.repositoryPath, target!.oid, signal),
    enabled: target !== null,
    retry: false,
  });
  const sections: { key: string; patch: string }[] = detail.data
    ? [
        { key: "gitLog.stash.worktree", patch: detail.data.patch },
        { key: "gitLog.stash.staged", patch: detail.data.stagedPatch },
        { key: "gitLog.stash.untracked", patch: detail.data.untrackedPatch },
      ].filter((section) => section.patch.trim() !== "")
    : [];
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("gitLog.stash.diffTitle")}</DialogTitle>
          <DialogDescription className="break-all font-mono">
            {target?.oid.slice(0, 12)}
          </DialogDescription>
        </DialogHeader>
        {detail.isPending && target && (
          <p role="status" className="text-xs">
            {t("gitRepo.loading")}
          </p>
        )}
        {detail.error && (
          <ReadError error={detail.error} retry={() => void detail.refetch()} />
        )}
        {detail.data && sections.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("gitLog.stash.empty")}
          </p>
        )}
        {sections.map((section) => (
          <section key={section.key} className="min-w-0 space-y-1">
            <h3 className="text-xs font-medium">{t(section.key)}</h3>
            <pre
              tabIndex={0}
              className="max-h-72 overflow-auto rounded bg-muted p-2 text-[11px]"
            >
              {section.patch}
            </pre>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
