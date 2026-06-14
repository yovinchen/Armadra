import { useCanvasStore, type CanvasTool } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { useAutoArrange } from "./auto-arrange";

/** Pen palette from plan §6 — the only hard-coded colours on the canvas. */
export const PEN_COLORS = [
  "#5B5BD6",
  "#DC4C4A",
  "#1F9D64",
  "#D18F0F",
  "#1B1D26",
] as const;

const TOOLS: {
  tool: CanvasTool;
  glyph: string;
  label: string;
  title: string;
}[] = [
  {
    tool: "select",
    glyph: "↖",
    label: "canvas.tool.select",
    title: "canvas.tool.select.hint",
  },
  {
    tool: "pen",
    glyph: "✎",
    label: "canvas.tool.pen",
    title: "canvas.tool.pen.hint",
  },
];

/**
 * Top-right canvas toolbar (SPEC §6): 选择 / 画笔 + pen palette + 一键整理.
 * Node creation deliberately lives in the sidebar and ⌘K instead.
 */
export function CanvasToolbar() {
  const { t } = usePreferences();
  const tool = useCanvasStore((state) => state.tool);
  const penColor = useCanvasStore((state) => state.penColor);
  const setTool = useCanvasStore((state) => state.setTool);
  const setPenColor = useCanvasStore((state) => state.setPenColor);
  const clearStrokes = useCanvasStore((state) => state.clearStrokes);
  const arrange = useAutoArrange();

  return (
    <div
      className="canvas-toolbar"
      role="toolbar"
      aria-label={t("canvas.toolbar")}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {TOOLS.map((entry) => (
        <button
          key={entry.tool}
          type="button"
          className={`canvas-tool${tool === entry.tool ? " is-active" : ""}`}
          title={t(entry.title)}
          aria-pressed={tool === entry.tool}
          onClick={() => setTool(entry.tool)}
        >
          <span aria-hidden="true">{entry.glyph}</span>
          {t(entry.label)}
        </button>
      ))}
      {tool === "pen" && (
        <>
          <span className="canvas-toolbar-divider" aria-hidden="true" />
          {PEN_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`canvas-pen-color${penColor === color ? " is-active" : ""}`}
              style={{ background: color }}
              title={t("canvas.pen.color", { color })}
              aria-label={t("canvas.pen.color", { color })}
              aria-pressed={penColor === color}
              onClick={() => setPenColor(color)}
            />
          ))}
          <button
            type="button"
            className="canvas-tool canvas-tool--ghost"
            onClick={() => clearStrokes()}
          >
            {t("canvas.pen.clear")}
          </button>
        </>
      )}
      <span className="canvas-toolbar-divider" aria-hidden="true" />
      <button
        type="button"
        className="canvas-tool canvas-tool--plain"
        title={t("canvas.arrange.hint")}
        onClick={() => arrange()}
      >
        <span aria-hidden="true">⊞</span>
        {t("canvas.arrange")}
      </button>
    </div>
  );
}
