import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardDocument } from "@ai-coding-canvas/shared";
import { runtimeApi } from "../api/client";
import { CanvasWorkspace } from "../canvas/CanvasWorkspace";
import { useCanvasShortcuts } from "../canvas/shortcuts";
import { MobileNav } from "../components/MobileNav";
import { Inspector } from "../inspector/Inspector";
import { CommandPalette } from "../modals/CommandPalette";
import { DiffScanDrawer } from "../modals/DiffScanDrawer";
import { NewWorkspaceModal } from "../modals/NewWorkspaceModal";
import { SettingsModal } from "../modals/SettingsModal";
import { usePreferences } from "../preferences/Preferences";
import { CanvasSaveQueue } from "../save/canvas-save-queue";
import { Rail } from "../shell/Rail";
import { Sidebar } from "../shell/Sidebar";
import { StatusBar } from "../shell/StatusBar";
import { Topbar } from "../shell/Topbar";
import { useCanvasStore } from "../store/canvas-store";
import { Launcher } from "./Launcher";

const WORKSPACE_KEY = "ai-canvas-workspace";
const BOARD_KEY = "ai-canvas-board";
/** Panning is cosmetic: it gets its own slow, silent save (plan §4). */
const VIEWPORT_SAVE_DELAY = 2_000;

export function App() {
  const { t } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const saveState = useCanvasStore((state) => state.saveState);
  const mobilePanel = useCanvasStore((state) => state.mobilePanel);
  const modal = useCanvasStore((state) => state.modal);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const setBoards = useCanvasStore((state) => state.setBoards);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const setDocument = useCanvasStore((state) => state.setDocument);
  const setSaveState = useCanvasStore((state) => state.setSaveState);
  const setSaveError = useCanvasStore((state) => state.setSaveError);
  const queryClient = useQueryClient();

  useCanvasShortcuts();

  const saveQueueRef = useRef<CanvasSaveQueue | null>(null);
  if (!saveQueueRef.current) {
    saveQueueRef.current = new CanvasSaveQueue(
      runtimeApi.saveBoard,
      (workspaceId, savedBoardId, source, saved) => {
        queryClient.setQueryData(["board", workspaceId, savedBoardId], saved);
        saveQueueRef.current?.rebasePending(
          workspaceId,
          savedBoardId,
          saved.board,
        );
        const current = useCanvasStore.getState();
        if (
          current.workspace?.id !== workspaceId ||
          current.boardId !== savedBoardId
        )
          return;
        if (current.document === source) {
          useCanvasStore.setState({
            document: saved,
            saveState: "saved",
            saveError: null,
          });
        } else {
          useCanvasStore.setState({
            document: current.document
              ? { ...current.document, board: saved.board }
              : current.document,
            saveState: "dirty",
            saveError: null,
          });
        }
      },
      (workspaceId, failedBoardId, cause) => {
        const current = useCanvasStore.getState();
        if (
          current.workspace?.id !== workspaceId ||
          current.boardId !== failedBoardId
        )
          return;
        useCanvasStore.setState({
          saveState: "failed",
          saveError:
            cause instanceof Error ? cause.message : "本地看板保存失败",
        });
      },
    );
  }

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: runtimeApi.listWorkspaces,
    enabled: !workspace,
    retry: false,
  });
  const boards = useQuery({
    queryKey: ["boards", workspace?.id],
    queryFn: () => runtimeApi.listBoards(workspace!.id),
    enabled: Boolean(workspace),
  });
  const board = useQuery({
    queryKey: ["board", workspace?.id, boardId],
    queryFn: () => runtimeApi.loadBoard(workspace!.id, boardId!),
    enabled: Boolean(workspace && boardId),
  });

  useEffect(() => {
    if (workspace || !workspaces.data) return;
    const remembered = localStorage.getItem(WORKSPACE_KEY);
    const match = workspaces.data.find((item) => item.id === remembered);
    if (match) {
      setWorkspace(match);
      void runtimeApi.openWorkspace(match.id).catch(() => undefined);
    }
  }, [setWorkspace, workspace, workspaces.data]);

  // Restore the remembered board once per workspace; afterwards the store
  // keeps whichever board the user selected.
  const restoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!boards.data || !workspace) return;
    setBoards(boards.data);
    if (restoredForRef.current === workspace.id) return;
    restoredForRef.current = workspace.id;
    const remembered = localStorage.getItem(BOARD_KEY);
    if (remembered && boards.data.some((item) => item.id === remembered)) {
      selectBoard(remembered);
    }
  }, [boards.data, selectBoard, setBoards, workspace]);

  useEffect(() => {
    if (boardId) localStorage.setItem(BOARD_KEY, boardId);
  }, [boardId]);

  useEffect(() => {
    if (!workspace || document || !board.data) return;
    if (board.data.board.workspaceId !== workspace.id) return;
    if (board.data.board.id !== boardId) return;
    const migrated = normalizeWorkspacePaths(board.data, workspace.rootPath);
    if (migrated.changed) {
      useCanvasStore.setState({
        document: migrated.document,
        boardId: migrated.document.board.id,
        saveState: "dirty",
        saveError: null,
      });
    } else {
      setDocument(migrated.document);
    }
  }, [board.data, boardId, document, setDocument, workspace]);

  useEffect(() => {
    if (!workspace || !boardId || !document || saveState !== "dirty") return;
    const timeout = window.setTimeout(() => {
      const documentBeingSaved = document;
      const workspaceBeingSaved = workspace.id;
      const boardBeingSaved = boardId;
      setSaveState("saving");
      setSaveError(null);
      void saveQueueRef
        .current!.enqueue(
          workspaceBeingSaved,
          boardBeingSaved,
          documentBeingSaved,
        )
        .catch(() => undefined);
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [boardId, document, saveState, setSaveError, setSaveState, workspace]);

  // Viewport-only persistence: throttled, and it never moves `saveState`, so
  // panning can never resurrect the unsaved-changes guard (plan §4).
  const lastViewportRef = useRef<string | null>(null);
  useEffect(() => {
    lastViewportRef.current = null;
  }, [boardId]);
  useEffect(() => {
    if (!workspace || !boardId || !document) return;
    if (
      saveState === "dirty" ||
      saveState === "saving" ||
      saveState === "failed"
    )
      return;
    const key = JSON.stringify(document.board.viewport);
    if (lastViewportRef.current === null) {
      lastViewportRef.current = key;
      return;
    }
    if (lastViewportRef.current === key) return;
    const workspaceId = workspace.id;
    const savingBoardId = boardId;
    const snapshot = document;
    const timeout = window.setTimeout(async () => {
      lastViewportRef.current = key;
      try {
        const saved = await runtimeApi.saveBoard(
          workspaceId,
          savingBoardId,
          snapshot,
        );
        queryClient.setQueryData(["board", workspaceId, savingBoardId], saved);
        const current = useCanvasStore.getState();
        if (
          current.workspace?.id === workspaceId &&
          current.boardId === savingBoardId &&
          current.document
        ) {
          useCanvasStore.setState({
            document: {
              ...current.document,
              board: {
                ...current.document.board,
                updatedAt: saved.board.updatedAt,
              },
            },
          });
        }
      } catch {
        // A viewport write is cosmetic; the next real edit reconciles it.
        lastViewportRef.current = null;
      }
    }, VIEWPORT_SAVE_DELAY);
    return () => window.clearTimeout(timeout);
  }, [boardId, document, queryClient, saveState, workspace]);

  useEffect(() => {
    if (!workspace || !["dirty", "saving", "failed"].includes(saveState))
      return;
    const protectUnsavedChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () =>
      window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, [saveState, workspace]);

  if (!workspace) return <Launcher />;

  return (
    <div className={`app-shell mobile-panel--${mobilePanel}`}>
      <a className="skip-link" href="#canvas-main">
        {t("top.skip")}
      </a>
      <Topbar />
      <div className="workspace-layout">
        <Rail />
        <Sidebar />
        {document ? (
          <CanvasWorkspace />
        ) : boards.isError || board.isError ? (
          <main className="canvas-stage application-state application-state--error">
            <strong>{t("app.loadFailed")}</strong>
            <p>{(boards.error ?? board.error)?.message}</p>
            <button
              type="button"
              onClick={() => {
                void boards.refetch();
                void board.refetch();
              }}
            >
              {t("app.retry")}
            </button>
          </main>
        ) : (
          <main className="canvas-stage application-state">
            <span className="loading-orbit" />
            {t("app.loading")}
          </main>
        )}
        <Inspector />
      </div>
      <StatusBar />
      <MobileNav />
      {modal === "newWorkspace" && <NewWorkspaceModal />}
      {modal === "settings" && <SettingsModal />}
      {modal === "command" && <CommandPalette />}
      {modal === "diffScan" && <DiffScanDrawer />}
    </div>
  );
}

function normalizeWorkspacePaths(document: BoardDocument, rootPath: string) {
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (node.data.kind === "terminal" && node.data.cwd === ".") {
      changed = true;
      return { ...node, data: { ...node.data, cwd: rootPath } };
    }
    if (node.data.kind === "agent" && node.data.projectPath === ".") {
      changed = true;
      return { ...node, data: { ...node.data, projectPath: rootPath } };
    }
    return node;
  });
  return { changed, document: changed ? { ...document, nodes } : document };
}
