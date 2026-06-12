import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { convertNoteToTask, sendToAgent } from "./actions";
import type { NodeContentProps, OfKind } from "./types";

/** Note body: pale-yellow textarea, character count, @ Agent / 转为任务. */
export function NoteNode({ id, data }: NodeContentProps) {
  const { t } = usePreferences();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const note = data as OfKind<"note">;

  return (
    <div className="note-body nodrag nowheel">
      <textarea
        className="note-editor nodrag nowheel"
        aria-label={t("node.note")}
        maxLength={20_000}
        placeholder={t("note.placeholder")}
        value={note.content}
        onChange={(event) => updateNode(id, { content: event.target.value })}
      />
      <div className="note-footer">
        <span>{t("note.chars", { count: note.content.length })}</span>
        <button
          type="button"
          className="note-button nodrag"
          onClick={() => sendToAgent(id)}
        >
          @ Agent
        </button>
        <button
          type="button"
          className="note-primary nodrag"
          onClick={() => convertNoteToTask(id)}
        >
          ☰ {t("note.toTask")}
        </button>
      </div>
    </div>
  );
}
