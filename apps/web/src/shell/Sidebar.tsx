import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { BoardList, useCreateBoard } from "../sidebar/BoardList";
import { FileTree } from "../sidebar/FileTree";
import { NodePalette } from "../sidebar/NodePalette";

/** 236px sidebar — plan §1.2, template.html "侧栏". */
export function Sidebar() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const createBoard = useCreateBoard();

  if (!workspace) return null;

  return (
    <aside className="sidebar" aria-label={t("sidebar.label")}>
      <div className="sidebar-head">
        <div className="ws-name">{workspace.name}</div>
        <div className="ws-path" title={workspace.rootPath}>
          {workspace.rootPath}
        </div>
      </div>

      <div className="sidebar-section-title">
        <span>{t("sidebar.boards")}</span>
        <button
          type="button"
          title={t("sidebar.newBoard")}
          aria-label={t("sidebar.newBoard")}
          disabled={createBoard.isPending}
          onClick={() => createBoard.mutate()}
        >
          ＋
        </button>
      </div>
      <BoardList />

      <div className="sidebar-section-title">
        <span>{t("sidebar.files")}</span>
        <span className="hint">{t("sidebar.filesHint")}</span>
      </div>
      <FileTree />

      <div className="sidebar-section-title sidebar-section-title--divider">
        <span>{t("sidebar.nodes")}</span>
      </div>
      <NodePalette />
    </aside>
  );
}
