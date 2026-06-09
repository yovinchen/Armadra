import { useQuery } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import type { WorkspaceSummary } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { setPendingWorkspacePath } from "../modals/new-workspace-state";
import { setPendingSettingsTab } from "../modals/settings-state";
import { useGatewayState } from "./gateway";

/** 52px workspace rail — plan §1.2, template.html "工作空间轨". */
export function Rail() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const document = useCanvasStore((state) => state.document);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const setModal = useCanvasStore((state) => state.setModal);
  const gateway = useGatewayState(workspace?.id);

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: runtimeApi.listWorkspaces,
    retry: false,
  });

  // Only the open board's nodes are loaded, so the running badge is authoritative
  // for the current workspace and conservatively false elsewhere (plan rule 4).
  const currentRunning = Boolean(
    document?.nodes.some((node) => node.data.status === "running"),
  );

  const list: WorkspaceSummary[] = workspaces.data ?? [];

  return (
    <nav className="rail" aria-label={t("sidebar.label")}>
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`rail-tile${item.id === workspace?.id ? " is-current" : ""}`}
          style={{ background: item.color }}
          title={`${item.name} · ${item.rootPath}`}
          aria-current={item.id === workspace?.id}
          onClick={() => {
            if (item.id === workspace?.id) return;
            localStorage.setItem("ai-canvas-workspace", item.id);
            localStorage.removeItem("ai-canvas-board");
            setWorkspace(item);
            void runtimeApi.openWorkspace(item.id).catch(() => undefined);
          }}
        >
          {letterOf(item.name)}
          {item.id === workspace?.id && currentRunning && (
            <span className="rail-running" aria-hidden="true" />
          )}
        </button>
      ))}

      <button
        type="button"
        className="rail-add"
        title={t("rail.newWorkspace")}
        aria-label={t("rail.newWorkspace")}
        onClick={() => {
          setPendingWorkspacePath(null);
          setModal("newWorkspace");
        }}
      >
        ＋
      </button>

      <div className="rail-spacer" />

      <button
        type="button"
        className="rail-icon"
        title={`${t("gateway.title")} · ${t(gateway.labelKey)}`}
        aria-label={`${t("gateway.title")}: ${t(gateway.labelKey)}`}
        style={{ color: gateway.enabled ? "var(--info)" : "var(--muted)" }}
        onClick={() => {
          setPendingSettingsTab("gateway");
          setModal("settings");
        }}
      >
        {gateway.glyph}
      </button>

      <button
        type="button"
        className="rail-icon"
        title={t("rail.settings")}
        aria-label={t("rail.settings")}
        onClick={() => setModal("settings")}
      >
        <Settings size={15} />
      </button>
    </nav>
  );
}

export function letterOf(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}
