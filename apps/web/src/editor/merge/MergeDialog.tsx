import * as React from "react";

import { runtimeApi } from "@/api/client";
import { useT } from "@/app/preferences-store";
import {
  countConflicts,
  textOf,
  type Choice,
  type ConflictRegion,
} from "@/lib/merge3";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { ScrollArea } from "@/ui/scroll-area";
import { workspaceRelative } from "./conflict";
import { useMergeStore } from "./merge-store";

/**
 * 三方合并视图（编辑器设计 §3、Git 冲突中心）。
 *
 * 四栏：base / 我们的 / 他们的 / 结果。每一处冲突单独挑一侧、两侧都要、
 * 或者都不要；两边改成同一样东西的地方根本不会出现在这里——那不是冲突，
 * 问一遍只是浪费一次确认。
 *
 * 「保存并标记已解决」不是两个动作被并成一个：写盘之后仍然调**现有的**
 * `git/resolve`，由它重读文件、确认再没有冲突标记，才把路径加进索引。
 * 保存一个文件从来都不等于解决了它，这条规矩这里不绕过（合并前的实现
 * 的 `mark_resolved`）。
 */
export function MergeDialog() {
  const t = useT();
  const state = useMergeStore();
  const store = useMergeStore;

  const conflicts = React.useMemo(
    () => state.regions.filter((region) => region.kind === "conflict"),
    [state.regions],
  );

  const merged = React.useMemo(
    () => textOf(state.regions, state.choices, state.trailingNewline),
    [state.regions, state.choices, state.trailingNewline],
  );

  const draft = state.mode === "draft";

  const applyDraft = () => {
    store.getState().applyDraft?.(merged);
    store.getState().close();
  };

  const save = async (markResolved: boolean) => {
    const { workspaceId, path, repositoryPath, expectedSha256, bom } =
      store.getState();
    if (!workspaceId || !path) return;
    store.getState().setSaving(true);
    try {
      // 写盘按工作空间寻址，`git/resolve` 按检出寻址、收的是仓库相对路径——
      // 同一个文件在两条路上是两种写法，换算在 `conflict.ts` 里只有一处。
      await runtimeApi.writeFile(
        workspaceId,
        workspaceRelative(repositoryPath, path),
        merged,
        undefined,
        expectedSha256 ?? undefined,
        bom,
      );
      if (markResolved)
        await runtimeApi.gitMarkResolved(workspaceId, [path], repositoryPath);
      store.getState().finish();
    } catch (error) {
      store
        .getState()
        .fail(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Dialog
      open={state.open}
      onOpenChange={(next) => {
        if (!next) store.getState().close();
      }}
    >
      <DialogContent className="flex max-h-[86vh] w-[min(96vw,72rem)] max-w-none flex-col gap-3">
        <DialogHeader>
          <DialogTitle>
            {t(draft ? "merge.draft.title" : "merge.title")}
          </DialogTitle>
          <DialogDescription>
            {state.loading ? t("merge.loading") : (state.path ?? "")}
          </DialogDescription>
        </DialogHeader>

        {state.unavailable && (
          <p className="text-[12px] text-[var(--warn)]">
            {reasonText(t, state.unavailable)}
          </p>
        )}
        {state.error && (
          <p
            role="alert"
            className="break-words text-[12px] text-[var(--danger)]"
          >
            {state.error}
          </p>
        )}
        {state.resolved && (
          <Badge variant="outline">{t("merge.resolved")}</Badge>
        )}

        {!state.loading && !state.unavailable && (
          <ScrollArea className="min-h-0 flex-1 rounded-[var(--radius-sm)] border border-border">
            <div className="flex flex-col gap-3 p-3">
              {conflicts.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  {t(draft ? "merge.draft.noConflicts" : "merge.noConflicts")}
                </p>
              ) : (
                conflicts.map((region, index) => (
                  <Hunk
                    key={index}
                    index={index}
                    region={region as ConflictRegion}
                    choice={state.choices[index] ?? "ours"}
                    draft={draft}
                    onChoose={(choice) =>
                      store.getState().choose(index, choice)
                    }
                  />
                ))
              )}
              <div className="min-w-0">
                <p className="pb-1 text-[12px] font-medium">
                  {t("merge.result")}
                </p>
                <pre className="max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] p-2 font-mono text-[11px]">
                  {merged}
                </pre>
              </div>
            </div>
          </ScrollArea>
        )}

        <DialogFooter className="gap-2">
          <span className="mr-auto text-[length:var(--text-caption)] text-muted-foreground">
            {t("merge.summary", {
              count: String(countConflicts(state.regions)),
            })}
          </span>
          {draft ? (
            <Button size="sm" onClick={applyDraft}>
              {t("merge.draft.apply")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={state.saving || state.loading || !!state.unavailable}
                onClick={() => void save(false)}
              >
                {t("merge.saveOnly")}
              </Button>
              <Button
                size="sm"
                disabled={state.saving || state.loading || !!state.unavailable}
                onClick={() => void save(true)}
              >
                {t("merge.saveAndResolve")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CHOICES: readonly Choice[] = ["ours", "theirs", "both", "base", "none"];

/**
 * 草稿合并里「我们的 / 他们的」是草稿与磁盘版，同一个词在 Git 冲突里指的是
 * 两个分支——换成说得清的名字，而不是让人去猜哪边是哪边。
 */
const DRAFT_LABELS: Record<string, string> = {
  "merge.base": "merge.draft.base",
  "merge.ours": "merge.draft.ours",
  "merge.theirs": "merge.draft.theirs",
  "merge.choice.ours": "merge.draft.choice.ours",
  "merge.choice.theirs": "merge.draft.choice.theirs",
};

function Hunk({
  index,
  region,
  choice,
  draft,
  onChoose,
}: {
  index: number;
  region: ConflictRegion;
  choice: Choice;
  draft: boolean;
  onChoose: (choice: Choice) => void;
}) {
  const translate = useT();
  const t = (key: string, values?: Record<string, string>) =>
    translate(draft ? (DRAFT_LABELS[key] ?? key) : key, values);
  return (
    <section className="min-w-0 rounded-[var(--radius-sm)] border border-border p-2">
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        <span className="mr-auto text-[12px] font-medium">
          {t("merge.hunk", { index: String(index + 1) })}
        </span>
        {CHOICES.map((option) => (
          <Button
            key={option}
            size="xs"
            variant={choice === option ? "default" : "outline"}
            aria-pressed={choice === option}
            onClick={() => onChoose(option)}
          >
            {t(`merge.choice.${option}`)}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <Side label={t("merge.base")} lines={region.base} />
        <Side label={t("merge.ours")} lines={region.ours} />
        <Side label={t("merge.theirs")} lines={region.theirs} />
      </div>
    </section>
  );
}

function Side({ label, lines }: { label: string; lines: string[] }) {
  const t = useT();
  return (
    <div className="min-w-0">
      <p className="pb-1 text-[length:var(--text-caption)] text-muted-foreground">
        {label}
      </p>
      <pre className="max-h-40 overflow-auto rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] p-2 font-mono text-[11px]">
        {lines.length > 0 ? lines.join("\n") : t("merge.emptySide")}
      </pre>
    </div>
  );
}

/** 打不开合并视图时的固定几种原因；其余原样显示 Runtime 的那句话。 */
function reasonText(
  t: (key: string, values?: Record<string, string>) => string,
  reason: string,
): string {
  const known = [
    "notConflicted",
    "sideMissing",
    "submodule",
    "truncated",
    "binary",
  ];
  return known.includes(reason) ? t(`merge.reason.${reason}`) : reason;
}
