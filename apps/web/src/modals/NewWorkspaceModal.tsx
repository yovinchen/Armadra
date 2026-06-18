import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  WORKSPACE_COLORS,
  type Workspace,
  type WorkspaceSummary,
} from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { isTauri, pickDirectory } from "../platform";
import { ModalShell } from "./ModalShell";
import { basename, takePendingWorkspacePath } from "./new-workspace-state";

const WORKSPACE_KEY = "ai-canvas-workspace";
const BOARD_KEY = "ai-canvas-board";

type PermissionKey = "read" | "write" | "execute";

/** SPEC §10 / template.html「弹层：新建工作空间」. */
export function NewWorkspaceModal() {
  const { t } = usePreferences();
  const setModal = useCanvasStore((state) => state.setModal);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const queryClient = useQueryClient();

  // The pending path is consumed once, on mount (see new-workspace-state.ts).
  const [prefilled] = useState(() => takePendingWorkspacePath());
  const [rootPath, setRootPath] = useState(prefilled ?? "");
  const [name, setName] = useState(prefilled ? basename(prefilled) : "");
  const [nameTouched, setNameTouched] = useState(Boolean(prefilled));
  const [permissions, setPermissions] = useState({
    read: true,
    write: true,
    execute: false,
  });
  const [gatewayEnabled, setGatewayEnabled] = useState(false);
  const [notice, setNotice] = useState("");

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: runtimeApi.listWorkspaces,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      runtimeApi.createWorkspace({
        name: name.trim(),
        rootPath: rootPath.trim(),
        color: nextColor(workspaces.data ?? []),
        permissions,
        gatewayEnabled,
      }),
    onSuccess: (workspace: Workspace) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      localStorage.setItem(WORKSPACE_KEY, workspace.id);
      localStorage.removeItem(BOARD_KEY);
      setWorkspace(workspace);
      void runtimeApi.openWorkspace(workspace.id).catch(() => undefined);
      setModal(null);
    },
  });

  const browse = async () => {
    const picked = await pickDirectory();
    if (!picked) {
      if (!isTauri()) setNotice(t("modal.newWorkspace.browseUnavailable"));
      return;
    }
    setNotice("");
    setRootPath(picked);
    if (!nameTouched || !name.trim()) setName(basename(picked));
  };

  const permissionRows: Array<{ key: PermissionKey }> = [
    { key: "read" },
    { key: "write" },
    { key: "execute" },
  ];

  return (
    <ModalShell className="new-workspace" labelledBy="new-workspace-title">
      <div>
        <h2 id="new-workspace-title">{t("modal.newWorkspace.title")}</h2>
        <p className="modal-sub">{t("modal.newWorkspace.subtitle")}</p>
      </div>

      <label className="field-label">
        {t("modal.newWorkspace.name")}
        <input
          name="workspace-name"
          autoComplete="off"
          maxLength={120}
          placeholder={t("modal.newWorkspace.namePlaceholder")}
          value={name}
          onChange={(event) => {
            setNameTouched(true);
            setName(event.target.value);
          }}
        />
      </label>

      <label className="field-label">
        {t("modal.newWorkspace.path")}
        <span className="modal-path-row">
          <input
            id="workspace-path"
            name="workspace-path"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("modal.newWorkspace.pathPlaceholder")}
            value={rootPath}
            onChange={(event) => {
              const next = event.target.value;
              setRootPath(next);
              if (!nameTouched) setName(basename(next.trim()));
            }}
          />
          <button
            type="button"
            className="secondary-action"
            disabled={!isTauri()}
            title={
              isTauri() ? undefined : t("modal.newWorkspace.browseUnavailable")
            }
            onClick={() => void browse()}
          >
            {t("modal.newWorkspace.browse")}
          </button>
        </span>
      </label>

      <div className="permission-grid">
        {permissionRows.map(({ key }) => {
          const on = permissions[key];
          return (
            <button
              key={key}
              type="button"
              className={`permission-card${on ? " is-on" : ""}`}
              aria-pressed={on}
              onClick={() =>
                setPermissions((current) => ({ ...current, [key]: !on }))
              }
            >
              <span className="permission-name">
                <span className="permission-mark" aria-hidden="true">
                  {on ? "☑" : "☐"}
                </span>
                {t(`modal.newWorkspace.perm.${key}`)}
              </span>
              <span className="permission-desc">
                {t(`modal.newWorkspace.perm.${key}.desc`)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="switch-row">
        <span className="switch-glyph" aria-hidden="true">
          ⇄
        </span>
        <span className="switch-text">
          <span className="switch-title">
            {t("modal.newWorkspace.gateway")}
          </span>
          <span className="switch-desc">
            {t("modal.newWorkspace.gatewayDesc")}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={gatewayEnabled}
          aria-label={t("modal.newWorkspace.gateway")}
          className={`switch${gatewayEnabled ? " is-on" : ""}`}
          onClick={() => setGatewayEnabled((value) => !value)}
        >
          <span className="switch-knob" />
        </button>
      </div>

      {notice && <p className="inspector-hint">{notice}</p>}
      {create.error && (
        <p className="form-error" role="alert">
          {create.error.message}
        </p>
      )}

      <div className="modal-actions">
        <button
          type="button"
          className="secondary-action"
          onClick={() => setModal(null)}
        >
          {t("dialog.cancel")}
        </button>
        <button
          type="button"
          className="primary-action"
          disabled={!name.trim() || !rootPath.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending
            ? t("modal.newWorkspace.creating")
            : t("modal.newWorkspace.create")}
        </button>
      </div>
    </ModalShell>
  );
}

/** First palette colour not already used by an existing workspace (plan §6). */
export function nextColor(existing: Pick<WorkspaceSummary, "color">[]): string {
  const used = new Set(existing.map((item) => item.color));
  return (
    WORKSPACE_COLORS.find((color) => !used.has(color)) ??
    WORKSPACE_COLORS[existing.length % WORKSPACE_COLORS.length]!
  );
}
