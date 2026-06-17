import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import type { Board } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { usePreferences } from "../preferences/Preferences";

/** 侧栏「看板」 section — plan §5 [A3]. */
export function BoardList() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Board | null>(null);
  const [error, setError] = useState("");

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["boards", workspace?.id] });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      runtimeApi.updateBoard(workspace!.id, id, { name }),
    onSuccess: () => void refresh(),
    onError: (cause: Error) => setError(cause.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => runtimeApi.deleteBoard(workspace!.id, id),
    onSuccess: (_result, id) => {
      if (boardId === id) {
        const next = boards.find((board) => board.id !== id);
        selectBoard(next?.id ?? null);
      }
      void refresh();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  if (!workspace) return null;

  const commitRename = (board: Board) => {
    const name = draft.trim();
    setRenaming(null);
    if (!name || name === board.name) return;
    rename.mutate({ id: board.id, name });
  };

  return (
    <>
      <div className="board-list">
        {boards.map((board) => (
          <div
            key={board.id}
            className={`board-row${board.id === boardId ? " is-current" : ""}`}
            onDoubleClick={() => {
              setRenaming(board.id);
              setDraft(board.name);
            }}
          >
            <span className="board-glyph" aria-hidden="true">
              ▦
            </span>
            {renaming === board.id ? (
              <input
                className="board-rename"
                autoFocus
                aria-label={t("sidebar.renameBoard")}
                value={draft}
                maxLength={120}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => commitRename(board)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="board-name board-name-button"
                onClick={() => {
                  setError("");
                  selectBoard(board.id);
                  localStorage.setItem("ai-canvas-board", board.id);
                }}
              >
                {board.name}
              </button>
            )}
            {board.id === boardId && document && (
              <span className="board-count">{document.nodes.length}</span>
            )}
            <button
              type="button"
              className="board-more"
              aria-label={t("sidebar.deleteBoard")}
              title={t("sidebar.deleteBoard")}
              onClick={() => {
                if (boards.length <= 1) {
                  setError(t("sidebar.lastBoard"));
                  return;
                }
                setError("");
                setPendingDelete(board);
              }}
            >
              <MoreHorizontal size={13} />
            </button>
          </div>
        ))}
        {error && (
          <p className="panel-state panel-state--error" role="alert">
            {error}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("sidebar.deleteBoardTitle", {
          name: pendingDelete?.name ?? "",
        })}
        description={t("sidebar.deleteBoardDescription")}
        confirmLabel={t("sidebar.deleteBoard")}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) remove.mutate(target.id);
        }}
      />
    </>
  );
}

/** Used by the sidebar header ＋ button. */
export function useCreateBoard() {
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const { t } = usePreferences();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      runtimeApi.createBoard(
        workspace!.id,
        t("sidebar.boardName", { count: boards.length + 1 }),
      ),
    onSuccess: async (board) => {
      await queryClient.invalidateQueries({
        queryKey: ["boards", workspace?.id],
      });
      selectBoard(board.id);
      localStorage.setItem("ai-canvas-board", board.id);
    },
  });
}
