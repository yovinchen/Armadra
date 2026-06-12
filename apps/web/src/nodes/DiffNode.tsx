import { useCallback, useMemo, useState } from "react";
import type { DiffFile, DiffFileState } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { NODE_COMMANDS } from "./actions";
import { hasHunks, parsePatch } from "./helpers";
import { useNodeCommand } from "./useNodeCommand";
import type { NodeContentProps, OfKind } from "./types";

const STATUS_TONE: Record<DiffFile["status"], string> = {
  A: "add",
  M: "mod",
  D: "del",
  R: "mod",
  "?": "mod",
};

const STATE_META: Record<
  DiffFileState,
  { glyph: string; label: string; tone: string }
> = {
  pending: { glyph: "◇", label: "diff.pending", tone: "diff" },
  accepted: { glyph: "✓", label: "diff.accepted", tone: "ok" },
  reverted: { glyph: "↶", label: "diff.reverted", tone: "muted" },
};

/** Diff body: header counters, per-file rows with patch, footer bulk actions. */
export function DiffNode({ id, data }: NodeContentProps) {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const diff = data as OfKind<"diff">;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState<string[] | null>(null);

  const additions = diff.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0);
  const decided = diff.files.filter((file) => file.state !== "pending").length;

  const apply = useCallback(
    async (paths: string[], next: DiffFileState) => {
      const state = useCanvasStore.getState();
      const node = state.document?.nodes.find((item) => item.id === id);
      if (!workspace || node?.data.kind !== "diff" || paths.length === 0)
        return;
      try {
        setError("");
        setBusy(true);
        if (next === "accepted") await runtimeApi.gitStage(workspace.id, paths);
        else await runtimeApi.gitRevert(workspace.id, paths);
        const targets = new Set(paths);
        const files = node.data.files.map((file) =>
          targets.has(file.path) ? { ...file, state: next } : file,
        );
        const settled = files.every((file) => file.state !== "pending");
        state.updateNode(id, {
          files,
          ...(settled ? { status: "done" as const } : {}),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t("diff.failed"));
      } finally {
        setBusy(false);
      }
    },
    [id, t, workspace],
  );

  const pendingPaths = useMemo(
    () =>
      diff.files
        .filter((file) => file.state === "pending")
        .map((file) => file.path),
    [diff.files],
  );

  useNodeCommand(NODE_COMMANDS.diffAcceptAll, id, () => {
    void apply(
      pendingPaths.length ? pendingPaths : diff.files.map((file) => file.path),
      "accepted",
    );
  });
  useNodeCommand(NODE_COMMANDS.diffRevertAll, id, () =>
    setConfirmRevert(
      pendingPaths.length ? pendingPaths : diff.files.map((file) => file.path),
    ),
  );

  return (
    <div className="diffnode-body nodrag nowheel">
      <div className="diffnode-head">
        <span>{t("diff.files", { count: diff.files.length })}</span>
        <span className="diffnode-add">+{additions}</span>
        <span className="diffnode-del">−{deletions}</span>
        <span className="diffnode-progress">
          {t("diff.progress", { decided, total: diff.files.length })}
        </span>
      </div>

      <div className="diffnode-list">
        {diff.files.length === 0 && (
          <p className="diffnode-empty">{t("diff.empty")}</p>
        )}
        {diff.files.map((file) => {
          const expanded = open[file.path] ?? false;
          const state = STATE_META[file.state];
          return (
            <div className="diffnode-file" key={file.path}>
              <div className="diffnode-row">
                <button
                  type="button"
                  className="diffnode-toggle nodrag"
                  aria-expanded={expanded}
                  aria-label={file.path}
                  onClick={() =>
                    setOpen((current) => ({
                      ...current,
                      [file.path]: !expanded,
                    }))
                  }
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <span
                  className={`diffnode-badge diffnode-badge--${STATUS_TONE[file.status]}`}
                >
                  {file.status}
                </span>
                <span className="diffnode-path" title={file.path}>
                  {file.path}
                </span>
                <span className="diffnode-add">+{file.additions}</span>
                <span className="diffnode-del">−{file.deletions}</span>
                <span className={`diffnode-state tone-${state.tone}`}>
                  <span aria-hidden="true">{state.glyph}</span>
                  {t(state.label)}
                </span>
              </div>
              {expanded && (
                <div className="diffnode-patch">
                  {parsePatch(file.patch).map((hunk, index) => (
                    <div key={`${file.path}-${index}`}>
                      <div className="diffnode-hunk">{hunk.header}</div>
                      {hunk.lines.map((line, lineIndex) => (
                        <div
                          className={`diffnode-line diffnode-line--${
                            line.sign === "+"
                              ? "add"
                              : line.sign === "-"
                                ? "del"
                                : "ctx"
                          }`}
                          key={`${index}-${lineIndex}`}
                        >
                          <span className="diffnode-lineno">{line.no}</span>
                          <span className="diffnode-sign">{line.sign}</span>
                          <span className="diffnode-text">{line.text}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {file.previewable === false ? (
                    <p className="diffnode-empty">{t("diff.notPreviewable")}</p>
                  ) : (
                    !hasHunks(file.patch) && (
                      <p className="diffnode-empty">{t("diff.noPatch")}</p>
                    )
                  )}
                </div>
              )}
              {expanded && (
                <div className="diffnode-file-actions">
                  <button
                    type="button"
                    className="diffnode-revert nodrag"
                    disabled={busy}
                    onClick={() => setConfirmRevert([file.path])}
                  >
                    ↶ {t("diff.revertFile")}
                  </button>
                  <button
                    type="button"
                    className="diffnode-accept nodrag"
                    disabled={busy}
                    onClick={() => void apply([file.path], "accepted")}
                  >
                    ✓ {t("diff.acceptFile")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p className="diffnode-error" role="alert">
          {error}
        </p>
      )}

      <div className="diffnode-footer">
        <button
          type="button"
          className="diffnode-revert-all nodrag"
          disabled={busy || diff.files.length === 0}
          onClick={() =>
            setConfirmRevert(
              pendingPaths.length
                ? pendingPaths
                : diff.files.map((file) => file.path),
            )
          }
        >
          ↶ {t("diff.revertAll")}
        </button>
        <button
          type="button"
          className="diffnode-accept-all nodrag"
          disabled={busy || diff.files.length === 0}
          onClick={() =>
            void apply(
              pendingPaths.length
                ? pendingPaths
                : diff.files.map((file) => file.path),
              "accepted",
            )
          }
        >
          ✓ {t("diff.acceptAll")}
        </button>
      </div>

      <ConfirmDialog
        open={confirmRevert !== null}
        title={t("diff.revertTitle", { count: confirmRevert?.length ?? 0 })}
        description={t("diff.revertDescription")}
        confirmLabel={t("diff.revertConfirm")}
        onCancel={() => setConfirmRevert(null)}
        onConfirm={() => {
          const paths = confirmRevert ?? [];
          setConfirmRevert(null);
          void apply(paths, "reverted");
        }}
      />
    </div>
  );
}
