import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DiffFileStatus, GitFileDiff } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { applyDiffScan } from "../canvas/diff-scan";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { relativeTime } from "../app/Launcher";
import { ModalShell } from "./ModalShell";

const BADGE_TONE: Record<DiffFileStatus, string> = {
  M: "warn",
  A: "ok",
  D: "err",
  R: "info",
  "?": "muted",
};

/** SPEC §8 / template.html「Diff 扫描面板」. */
export function DiffScanDrawer() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const document = useCanvasStore((state) => state.document);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const selectNode = useCanvasStore((state) => state.selectNode);
  const setModal = useCanvasStore((state) => state.setModal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const diff = useQuery({
    queryKey: ["git-diff", workspace?.id],
    queryFn: () => runtimeApi.gitDiff(workspace!.id),
    enabled: Boolean(workspace),
    retry: false,
  });

  const files: GitFileDiff[] = diff.data?.files ?? [];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  const sourceAgent = document?.nodes.find(
    (node) => node.id === selectedNodeId && node.data.kind === "agent",
  );

  // A Diff node already on the board carries the per-file 接受/回滚 decisions.
  const existing = document?.nodes.find(
    (node) => node.data.kind === "diff" && node.data.repoPath === ".",
  );
  const decided = new Map<string, "pending" | "accepted" | "reverted">(
    existing?.data.kind === "diff"
      ? existing.data.files.map((file) => [file.path, file.state])
      : [],
  );

  const scanned = new Date(diff.dataUpdatedAt || Date.now()).toISOString();

  const place = async () => {
    if (!workspace) return;
    setBusy(true);
    setError("");
    try {
      const result = await applyDiffScan({
        workspaceId: workspace.id,
        document,
        selectedNodeId,
      });
      if (result.kind === "scanned") {
        if (result.nodeId) selectNode(result.nodeId);
        setModal(null);
      } else {
        setError(
          t(
            result.kind === "not-git"
              ? "modal.diffScan.notGit"
              : "modal.diffScan.clean",
          ),
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("modal.diffScan.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const exportPatch = () => {
    const patch = files
      .filter((file) => file.previewable)
      .map((file) => file.patch.trimEnd())
      .filter(Boolean)
      .join("\n");
    const blob = new Blob([`${patch}\n`], { type: "text/x-patch" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${workspace?.name ?? "workspace"}-worktree.patch`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const empty =
    diff.isSuccess && (!diff.data.repository || diff.data.files.length === 0);

  return (
    <ModalShell
      variant="drawer"
      className="diff-drawer"
      labelledBy="diff-drawer-title"
    >
      <header className="diff-drawer-head">
        <span className="diff-tile" aria-hidden="true">
          ±
        </span>
        <span className="diff-drawer-title">
          <h2 id="diff-drawer-title">{t("modal.diffScan.title")}</h2>
          <span className="diff-drawer-sub">
            {t("modal.diffScan.against", {
              when: relativeTime(scanned, t),
            })}
          </span>
        </span>
        <button
          type="button"
          className="secondary-action diff-rescan"
          disabled={diff.isFetching || !workspace}
          onClick={() => void diff.refetch()}
        >
          ↻ {t("modal.diffScan.rescan")}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t("modal.close")}
          onClick={() => setModal(null)}
        >
          ✕
        </button>
      </header>

      <div className="diff-summary">
        <span>{t("modal.diffScan.fileCount", { count: files.length })}</span>
        <span className="diff-add">+{additions}</span>
        <span className="diff-del">−{deletions}</span>
        {sourceAgent && (
          <span className="diff-source">
            {t("modal.diffScan.source", { name: sourceAgent.data.title })}
          </span>
        )}
      </div>

      <div className="diff-file-list">
        {diff.isPending && (
          <p className="diff-state">{t("modal.diffScan.scanning")}</p>
        )}
        {diff.isError && (
          <p className="diff-state form-error" role="alert">
            {diff.error.message}
          </p>
        )}
        {empty && (
          <p className="diff-state">
            {diff.data.repository
              ? t("modal.diffScan.clean")
              : t("modal.diffScan.notGit")}
          </p>
        )}
        {files.map((file) => {
          const state = decided.get(file.path) ?? "pending";
          return (
            <div className="diff-file" key={file.path}>
              <span
                className={`diff-badge diff-badge--${BADGE_TONE[file.status]}`}
              >
                {file.status}
              </span>
              <span className="diff-path mono" title={file.path}>
                {file.path}
              </span>
              <span className="diff-add">+{file.additions}</span>
              <span className="diff-del">−{file.deletions}</span>
              <span className={`diff-state-tag is-${state}`}>
                <span aria-hidden="true">{stateGlyph(state)}</span>
                {t(`modal.diffScan.state.${state}`)}
              </span>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="form-error diff-error" role="alert">
          {error}
        </p>
      )}

      <footer className="diff-drawer-foot">
        <button
          type="button"
          className="primary-action diff-place"
          disabled={!workspace || busy || files.length === 0}
          onClick={() => void place()}
        >
          ± {t("modal.diffScan.place")}
        </button>
        <button
          type="button"
          className="secondary-action"
          disabled={files.length === 0}
          onClick={exportPatch}
        >
          {t("modal.diffScan.export")}
        </button>
      </footer>
    </ModalShell>
  );
}

function stateGlyph(state: "pending" | "accepted" | "reverted"): string {
  if (state === "accepted") return "✓";
  if (state === "reverted") return "↺";
  return "◇";
}
