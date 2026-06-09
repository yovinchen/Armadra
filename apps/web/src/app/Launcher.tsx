import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import type { WorkspaceSummary } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useWorkspaceFolderDrop } from "../canvas/dnd/workspace-drop";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { pickDirectory } from "../platform";
import { NewWorkspaceModal } from "../modals/NewWorkspaceModal";
import { SettingsModal } from "../modals/SettingsModal";
import { setPendingWorkspacePath } from "../modals/new-workspace-state";
import { setPendingSettingsTab } from "../modals/settings-state";
import { letterOf } from "../shell/Rail";

/** Start page — plan §1.2, template.html "启动页". Replaces WorkspaceGate. */
export function Launcher() {
  const { t } = usePreferences();
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const setModal = useCanvasStore((state) => state.setModal);
  const modal = useCanvasStore((state) => state.modal);
  const [search, setSearch] = useState("");

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    refetchInterval: 10_000,
    retry: false,
  });
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: runtimeApi.listWorkspaces,
    retry: false,
  });

  const openWorkspace = (workspace: WorkspaceSummary) => {
    localStorage.setItem("ai-canvas-workspace", workspace.id);
    localStorage.removeItem("ai-canvas-board");
    setWorkspace(workspace);
    void runtimeApi.openWorkspace(workspace.id).catch(() => undefined);
  };

  /** Opens the New Workspace modal, optionally prefilled with a folder. */
  const openNewWorkspace = useCallback(
    (path?: string) => {
      setPendingWorkspacePath(path ?? null);
      setModal("newWorkspace");
      if (path) return;
      window.setTimeout(() => {
        document.getElementById("workspace-path")?.focus();
      }, 0);
    },
    [setModal],
  );

  const browseForFolder = useCallback(async () => {
    // On the web there is no system picker: fall through to the manual field.
    const picked = await pickDirectory();
    openNewWorkspace(picked ?? undefined);
  }, [openNewWorkspace]);

  const drop = useWorkspaceFolderDrop(openNewWorkspace);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void browseForFolder();
      }
      if (event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        openNewWorkspace();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [browseForFolder, openNewWorkspace]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = workspaces.data ?? [];
    if (!query) return list;
    return list.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.rootPath.toLowerCase().includes(query),
    );
  }, [search, workspaces.data]);

  const version = health.data?.version ?? "0.1.0";

  return (
    <div className="launcher">
      <div className="launcher-topbar">{t("launcher.brand")}</div>
      <div className="launcher-main">
        <aside className="launcher-aside">
          <div className="launcher-brand">
            <span className="brand-big" aria-hidden="true">
              ✦
            </span>
            <div>
              <div className="brand-name">{t("launcher.brand")}</div>
              <div className="brand-sub">
                {health.isSuccess
                  ? t("launcher.ready", { version })
                  : t("launcher.offline", { version })}
              </div>
            </div>
          </div>

          <div className="launcher-actions">
            <button
              type="button"
              className="launcher-action launcher-action--primary"
              onClick={() => void browseForFolder()}
            >
              <span aria-hidden="true">▤</span>
              {t("launcher.open")}
              <span className="action-key">⌘O</span>
            </button>
            <button
              type="button"
              className="launcher-action"
              onClick={() => openNewWorkspace()}
            >
              <span aria-hidden="true">＋</span>
              {t("launcher.new")}
              <span className="action-key">⌘N</span>
            </button>
            <button
              type="button"
              className="launcher-action"
              disabled
              title={t("launcher.remoteReserved")}
            >
              <span aria-hidden="true">⇄</span>
              {t("launcher.remote")}
              <span className="action-key">{t("launcher.remoteHint")}</span>
            </button>
          </div>

          <div className="launcher-fill" />

          <div
            className={`launcher-drop${drop.isOver ? " is-over" : ""}`}
            onDragOver={drop.onDragOver}
            onDragLeave={drop.onDragLeave}
            onDrop={drop.onDrop}
          >
            <div className="drop-glyph" aria-hidden="true">
              ⤓
            </div>
            {t("launcher.drop")}
            <br />
            {t("launcher.drop2")}
            {drop.unsupportedMessage && (
              <span className="drop-unsupported">
                {drop.unsupportedMessage}
              </span>
            )}
          </div>

          <div className="launcher-links">
            <button type="button" onClick={() => setModal("settings")}>
              {t("launcher.settings")}
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={() => {
                setPendingSettingsTab("keys");
                setModal("settings");
              }}
            >
              {t("launcher.shortcuts")}
            </button>
          </div>
        </aside>

        <main className="launcher-recents">
          <div className="launcher-recents-head">
            <h1>{t("launcher.recent")}</h1>
            <label className="launcher-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                value={search}
                placeholder={t("launcher.search")}
                aria-label={t("launcher.search")}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          {workspaces.isError && (
            <div className="launcher-offline" role="alert">
              <p className="launcher-offline-text">
                {t("launcher.runtimeFailed", {
                  error: workspaces.error.message,
                })}
              </p>
              <button
                type="button"
                className="secondary-action"
                disabled={workspaces.isFetching}
                onClick={() => void workspaces.refetch()}
              >
                {workspaces.isFetching
                  ? t("launcher.reconnecting")
                  : t("launcher.reconnect")}
              </button>
            </div>
          )}

          <div className="launcher-grid">
            {filtered.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                onOpen={() => openWorkspace(workspace)}
              />
            ))}
          </div>

          {workspaces.isSuccess && filtered.length === 0 && (
            <p className="inspector-hint">
              {search ? t("launcher.noMatch") : t("launcher.empty")}
            </p>
          )}

          <p className="launcher-note">{t("launcher.note")}</p>
        </main>
      </div>

      {modal === "newWorkspace" && <NewWorkspaceModal />}
      {modal === "settings" && <SettingsModal />}
    </div>
  );
}

function WorkspaceCard({
  workspace,
  onOpen,
}: {
  workspace: WorkspaceSummary;
  onOpen: () => void;
}) {
  const { t } = usePreferences();
  const nodeCount = workspace.boards.reduce(
    (sum, board) => sum + board.nodeCount,
    0,
  );
  return (
    <button type="button" className="launcher-card" onClick={onOpen}>
      <span className="card-head">
        <span
          className="card-tile"
          style={{ background: workspace.color }}
          aria-hidden="true"
        >
          {letterOf(workspace.name)}
        </span>
        <span className="card-head-text">
          <span className="card-name">{workspace.name}</span>
          <span className="card-path" title={workspace.rootPath}>
            {workspace.rootPath}
          </span>
        </span>
        <span className="card-when">
          {relativeTime(workspace.lastOpenedAt, t)}
        </span>
      </span>
      <span className="card-boards">
        {workspace.boards.map((board) => (
          <span className="card-chip" key={board.id}>
            ▦ {board.name}
          </span>
        ))}
      </span>
      <span className="card-meta">
        <span>
          {t("launcher.stats", {
            boards: workspace.boards.length,
            nodes: nodeCount,
          })}
        </span>
        <span
          className="card-gateway"
          style={{
            color: workspace.gatewayEnabled ? "var(--info)" : "var(--muted)",
          }}
        >
          {workspace.gatewayEnabled ? "⇄" : "⊘"}{" "}
          {workspace.gatewayEnabled
            ? t("launcher.gatewayOn")
            : t("launcher.gatewayOff")}
        </span>
      </span>
    </button>
  );
}

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** Chinese-friendly coarse relative time; matches the prototype's wording. */
export function relativeTime(iso: string, t: Translate): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 2) return t("time.justNow");
  if (minutes < 60) return t("time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("time.yesterday");
  if (days < 7) return t("time.days", { count: days });
  const weeks = Math.round(days / 7);
  if (weeks === 1) return t("time.lastWeek");
  if (weeks < 6) return t("time.weeks", { count: weeks });
  return t("time.longAgo");
}
