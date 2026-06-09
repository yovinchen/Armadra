import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Moon, Search, Settings, Sun } from "lucide-react";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { usePreferences } from "../preferences/Preferences";
import { useGatewayState } from "./gateway";

/** 36px application top bar — plan §1.2, template.html "顶栏". */
export function Topbar() {
  const { t, resolvedTheme, setTheme } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const saveState = useCanvasStore((state) => state.saveState);
  const saveError = useCanvasStore((state) => state.saveError);
  const setModal = useCanvasStore((state) => state.setModal);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const [confirmExit, setConfirmExit] = useState(false);

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    refetchInterval: 10_000,
    retry: false,
  });
  const git = useQuery({
    queryKey: ["git-status", workspace?.id],
    queryFn: () => runtimeApi.gitStatus(workspace!.id),
    enabled: Boolean(workspace),
    refetchInterval: 15_000,
    retry: false,
  });
  const gateway = useGatewayState(workspace?.id);

  const healthStatus = health.isPending
    ? "connecting"
    : health.isSuccess
      ? "online"
      : "offline";
  const boardName =
    boards.find((board) => board.id === boardId)?.name ??
    document?.board.name ??
    "";
  const changedCount = git.data?.repository ? git.data.changedCount : 0;

  return (
    <header className="topbar">
      <div className="topbar-breadcrumb">
        <span className="brand-tile" aria-hidden="true">
          ✦
        </span>
        <span className="ws-name" title={workspace?.rootPath}>
          {workspace?.name}
        </span>
        <span className="breadcrumb-sep">/</span>
        <span className="board-name">{boardName}</span>
      </div>

      <div className="topbar-spacer" />

      <span className="topbar-pill" aria-live="polite">
        <i className={`runtime-dot is-${healthStatus}`} />
        {healthStatus === "online"
          ? t("top.runtime", { version: health.data?.version ?? "" })
          : healthStatus === "connecting"
            ? t("top.connecting")
            : t("top.offline")}
      </span>

      <span
        className={`topbar-pill topbar-pill--${saveTone(saveState)}`}
        aria-live="polite"
        title={
          saveState === "failed"
            ? t("save.failedTitle", { error: saveError ?? t("save.failed") })
            : undefined
        }
      >
        <span aria-hidden="true">{saveGlyph(saveState)}</span>
        {saveLabel(saveState, t)}
      </span>

      <span
        className={`topbar-pill topbar-pill--${gateway.tone === "info" ? "info" : "muted"}`}
      >
        <span aria-hidden="true">{gateway.glyph}</span>
        {t("gateway.pill", { state: t(gateway.labelKey) })}
      </span>

      <span className="topbar-pill">
        <span aria-hidden="true">⑂</span>
        {gitLabel(git.data, git.isError, t)}
      </span>

      <div className="topbar-spacer" />

      <button
        type="button"
        className="topbar-button"
        title={t("top.diffTitle")}
        onClick={() => setModal("diffScan")}
      >
        ± {t("top.diff")}
        {changedCount > 0 && (
          <span className="topbar-count">{changedCount}</span>
        )}
      </button>

      <button
        type="button"
        className="topbar-search"
        onClick={() => setModal("command")}
      >
        <Search size={13} aria-hidden="true" />
        {t("top.search")}
        <kbd>⌘K</kbd>
      </button>

      <button
        type="button"
        className="icon-button"
        title={t("top.theme")}
        aria-label={t("top.theme")}
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        {resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>

      <button
        type="button"
        className="icon-button"
        title={t("top.settings")}
        aria-label={t("top.settings")}
        onClick={() => setModal("settings")}
      >
        <Settings size={15} />
      </button>

      <button
        type="button"
        className="icon-button"
        title={t("top.leave")}
        aria-label={t("top.leave")}
        onClick={() => {
          if (["dirty", "saving", "failed"].includes(saveState)) {
            setConfirmExit(true);
          } else {
            leaveWorkspace(setWorkspace);
          }
        }}
      >
        <LogOut size={15} />
      </button>

      <ConfirmDialog
        open={confirmExit}
        title={t("top.exit.title")}
        description={
          saveState === "failed"
            ? t("save.failedTitle", { error: saveError ?? t("save.failed") })
            : t("top.exit.unsaved")
        }
        confirmLabel={t("top.exit.confirm")}
        onCancel={() => setConfirmExit(false)}
        onConfirm={() => {
          setConfirmExit(false);
          leaveWorkspace(setWorkspace);
        }}
      />
    </header>
  );
}

function leaveWorkspace(
  setWorkspace: ReturnType<typeof useCanvasStore.getState>["setWorkspace"],
) {
  localStorage.removeItem("ai-canvas-workspace");
  localStorage.removeItem("ai-canvas-board");
  setWorkspace(null);
}

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

function gitLabel(
  status:
    | { repository: boolean; branch: string | null; changedCount: number }
    | undefined,
  failed: boolean,
  t: Translate,
): string {
  if (failed) return t("top.gitUnknown");
  if (!status) return t("top.gitUnknown");
  if (!status.repository) return t("top.notGit");
  const branch = status.branch ?? "HEAD";
  return status.changedCount > 0
    ? t("top.gitBranch", { branch, count: status.changedCount })
    : t("top.gitClean", { branch });
}

function saveGlyph(state: string): string {
  if (state === "saved") return "✓";
  if (state === "failed") return "✕";
  return "…";
}

function saveTone(state: string): "ok" | "err" | "warn" | "muted" {
  if (state === "saved") return "ok";
  if (state === "failed") return "err";
  if (state === "saving" || state === "dirty") return "warn";
  return "muted";
}

function saveLabel(state: string, t: Translate): string {
  if (state === "dirty") return t("save.dirty");
  if (state === "saving") return t("save.saving");
  if (state === "failed") return t("save.failed");
  if (state === "saved") return t("save.saved");
  return t("app.local");
}
