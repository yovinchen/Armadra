import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReactFlow } from "@xyflow/react";
import { Search } from "lucide-react";
import { runtimeApi } from "../api/client";
import { useAutoArrange } from "../canvas/auto-arrange";
import { createNodeData } from "../nodes/defaults";
import { NODE_META, PALETTE_TYPES } from "../nodes";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { useCreateBoard } from "../sidebar/BoardList";
import { ModalShell } from "./ModalShell";
import { matchScore } from "./fuzzy";
import { SHORTCUT_KEYS } from "./shortcuts-table";

type CommandGroup = "create" | "jump" | "command";

interface Command {
  id: string;
  group: CommandGroup;
  label: string;
  /** Secondary text matched at a lower weight (path, board name, …). */
  hint?: string;
  glyph: string;
  color: string;
  background: string;
  keys?: string;
  run: () => void;
}

const GROUP_ORDER: CommandGroup[] = ["create", "jump", "command"];

/** SPEC §10 / template.html「⌘K」. */
export function CommandPalette() {
  const { t, resolvedTheme, setTheme } = usePreferences();
  const workspace = useCanvasStore((state) => state.workspace);
  const boards = useCanvasStore((state) => state.boards);
  const boardId = useCanvasStore((state) => state.boardId);
  const document = useCanvasStore((state) => state.document);
  const addNode = useCanvasStore((state) => state.addNode);
  const selectNode = useCanvasStore((state) => state.selectNode);
  const selectBoard = useCanvasStore((state) => state.selectBoard);
  const setModal = useCanvasStore((state) => state.setModal);
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const queryClient = useQueryClient();
  const flow = useReactFlow();
  const arrange = useAutoArrange();
  const createBoard = useCreateBoard();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const close = () => setModal(null);
    const items: Command[] = [];

    /* ------------------------------- 创建 -------------------------------- */
    if (document) {
      for (const type of PALETTE_TYPES) {
        const meta = NODE_META[type];
        items.push({
          id: `create:${type}`,
          group: "create",
          label: t("command.createNode", { type: t(meta.labelKey) }),
          hint: t(meta.descriptionKey),
          glyph: meta.glyph,
          color: meta.color,
          background: meta.softColor,
          run: () => {
            const data = createNodeData(type, {
              rootPath: workspace?.rootPath ?? ".",
              label: t(meta.labelKey),
            });
            const centre = stageCenter(flow);
            addNode(data, {
              x: centre.x - meta.defaultSize.width / 2,
              y: centre.y - meta.defaultSize.height / 2,
            });
            close();
          },
        });
      }
    }
    if (workspace) {
      items.push({
        id: "create:board",
        group: "create",
        label: t("command.newBoard"),
        glyph: "▦",
        color: "var(--accent)",
        background: "var(--accent-soft)",
        keys: SHORTCUT_KEYS.newBoard,
        run: () => {
          createBoard.mutate();
          close();
        },
      });
    }

    /* ------------------------------- 跳转 -------------------------------- */
    for (const node of document?.nodes ?? []) {
      const meta = NODE_META[node.type];
      items.push({
        id: `jump:node:${node.id}`,
        group: "jump",
        label: node.data.title,
        hint: `${t(meta.labelKey)} · ${node.data.subtitle ?? ""}`.trim(),
        glyph: meta.glyph,
        color: meta.color,
        background: meta.softColor,
        run: () => {
          selectNode(node.id);
          void flow.fitView({
            nodes: [{ id: node.id }],
            duration: 200,
            padding: 0.4,
            maxZoom: 1.2,
          });
          close();
        },
      });
    }
    for (const board of boards) {
      if (board.id === boardId) continue;
      items.push({
        id: `jump:board:${board.id}`,
        group: "jump",
        label: t("command.openBoard", { name: board.name }),
        hint: board.name,
        glyph: "▦",
        color: "var(--accent)",
        background: "var(--accent-soft)",
        run: () => {
          selectBoard(board.id);
          localStorage.setItem("ai-canvas-board", board.id);
          close();
        },
      });
    }

    /* ------------------------------- 命令 -------------------------------- */
    if (document) {
      items.push({
        id: "command:arrange",
        group: "command",
        label: t("command.arrange"),
        glyph: "⊞",
        color: "var(--muted)",
        background: "var(--card2)",
        keys: SHORTCUT_KEYS.arrange,
        run: () => {
          arrange();
          close();
        },
      });
      items.push({
        id: "command:fit",
        group: "command",
        label: t("command.fitView"),
        glyph: "⤢",
        color: "var(--muted)",
        background: "var(--card2)",
        keys: SHORTCUT_KEYS.fitView,
        run: () => {
          void flow.fitView({ padding: 0.15, duration: 200 });
          close();
        },
      });
      items.push({
        id: "command:zoom100",
        group: "command",
        label: t("command.zoomReset"),
        glyph: "◎",
        color: "var(--muted)",
        background: "var(--card2)",
        keys: SHORTCUT_KEYS.zoomReset,
        run: () => {
          void flow.zoomTo(1, { duration: 200 });
          close();
        },
      });
    }
    if (workspace) {
      items.push({
        id: "command:diff",
        group: "command",
        label: t("top.diff"),
        glyph: "±",
        color: NODE_META.diff.color,
        background: NODE_META.diff.softColor,
        run: () => setModal("diffScan"),
      });
      items.push({
        id: "command:gateway",
        group: "command",
        label: t(
          workspace.gatewayEnabled ? "command.gatewayOff" : "command.gatewayOn",
        ),
        glyph: "⇄",
        color: "var(--info)",
        background: "var(--info-soft)",
        run: () => {
          const next = !workspace.gatewayEnabled;
          close();
          void runtimeApi
            .updateWorkspace(workspace.id, { gatewayEnabled: next })
            .then((updated) => {
              setWorkspace({ ...updated });
              void queryClient.invalidateQueries({ queryKey: ["gateway"] });
              void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
            })
            .catch(() => undefined);
        },
      });
    }
    items.push({
      id: "command:theme",
      group: "command",
      label: t("command.toggleTheme"),
      glyph: "◑",
      color: "var(--muted)",
      background: "var(--card2)",
      keys: SHORTCUT_KEYS.toggleTheme,
      run: () => {
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
        close();
      },
    });
    items.push({
      id: "command:settings",
      group: "command",
      label: t("command.openSettings"),
      glyph: "⚙",
      color: "var(--muted)",
      background: "var(--card2)",
      run: () => setModal("settings"),
    });
    items.push({
      id: "command:newWorkspace",
      group: "command",
      label: t("rail.newWorkspace"),
      glyph: "＋",
      color: "var(--accent)",
      background: "var(--accent-soft)",
      keys: SHORTCUT_KEYS.newWorkspace,
      run: () => setModal("newWorkspace"),
    });

    return items;
  }, [
    addNode,
    arrange,
    boardId,
    boards,
    createBoard,
    document,
    flow,
    queryClient,
    resolvedTheme,
    selectBoard,
    selectNode,
    setModal,
    setTheme,
    setWorkspace,
    t,
    workspace,
  ]);

  const matches = useMemo(() => {
    const trimmed = query.trim();
    const scored = commands
      .map((command) => ({
        command,
        score: matchScore(
          { label: command.label, hint: command.hint },
          trimmed,
        ),
      }))
      .filter(
        (entry): entry is { command: Command; score: number } =>
          entry.score !== null,
      );
    if (trimmed) scored.sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.command).slice(0, 60);
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);

  const groups = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      items: matches.filter((command) => command.group === group),
    })).filter((entry) => entry.items.length > 0);
  }, [matches]);

  // Flat order must follow the rendered (grouped) order for ↑↓ to make sense.
  const ordered = useMemo(
    () => groups.flatMap((entry) => entry.items),
    [groups],
  );

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (ordered.length ? (index + 1) % ordered.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) =>
        ordered.length ? (index - 1 + ordered.length) % ordered.length : 0,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      ordered[active]?.run();
    }
  };

  return (
    <ModalShell
      variant="top"
      className="command-palette"
      label={t("modal.command.title")}
    >
      <div className="command-search" onKeyDown={onKeyDown}>
        <Search size={14} aria-hidden="true" />
        <input
          autoFocus
          type="text"
          value={query}
          aria-label={t("modal.command.title")}
          placeholder={t("modal.command.placeholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <kbd>Esc</kbd>
      </div>
      <div className="command-list" ref={listRef}>
        {groups.map(({ group, items }) => (
          <div key={group}>
            <div className="command-group">{t(`command.group.${group}`)}</div>
            {items.map((command) => {
              const index = ordered.indexOf(command);
              return (
                <button
                  key={command.id}
                  type="button"
                  data-index={index}
                  className={`command-item${index === active ? " is-active" : ""}`}
                  onMouseMove={() => setActive(index)}
                  onClick={() => command.run()}
                >
                  <span
                    className="command-glyph"
                    aria-hidden="true"
                    style={{
                      background: command.background,
                      color: command.color,
                    }}
                  >
                    {command.glyph}
                  </span>
                  <span className="command-label">{command.label}</span>
                  {command.keys && <kbd>{command.keys}</kbd>}
                </button>
              );
            })}
          </div>
        ))}
        {ordered.length === 0 && (
          <p className="command-empty">{t("command.noResult")}</p>
        )}
      </div>
    </ModalShell>
  );
}

/** Centre of the canvas viewport in flow coordinates. */
function stageCenter(flow: ReturnType<typeof useReactFlow>) {
  const stage =
    document.querySelector<HTMLElement>(".react-flow") ??
    document.querySelector<HTMLElement>(".canvas-stage");
  const rect = stage?.getBoundingClientRect();
  const point = rect
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return flow.screenToFlowPosition(point);
}
