import type { KeyboardEvent } from "react";
import { useState } from "react";
import type { ChecklistItem } from "@ai-coding-canvas/shared";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";
import { dispatchTask } from "./actions";
import type { NodeContentProps, OfKind } from "./types";

/** Task body: description, checklist and the ➤ dispatch button (SPEC §3). */
export function TaskNode({ id, data }: NodeContentProps) {
  const { t } = usePreferences();
  const updateNode = useCanvasStore((state) => state.updateNode);
  const task = data as OfKind<"task">;
  const [entry, setEntry] = useState("");

  const patch = (checklist: ChecklistItem[]) => updateNode(id, { checklist });

  const addItem = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = entry.trim();
    if (!text) return;
    patch([
      ...task.checklist,
      { id: crypto.randomUUID().slice(0, 32), text, done: false },
    ]);
    setEntry("");
  };

  return (
    <div className="task-body nodrag nowheel">
      <textarea
        className="task-description nodrag nowheel"
        aria-label={t("task.label")}
        maxLength={20_000}
        placeholder={t("task.placeholder")}
        value={task.description}
        onChange={(event) =>
          updateNode(id, { description: event.target.value })
        }
      />

      <div className="task-checklist">
        {task.checklist.map((item) => (
          <label
            className={`task-check${item.done ? " is-done" : ""}`}
            key={item.id}
          >
            <input
              type="checkbox"
              className="nodrag"
              checked={item.done}
              onChange={() =>
                patch(
                  task.checklist.map((candidate) =>
                    candidate.id === item.id
                      ? { ...candidate, done: !candidate.done }
                      : candidate,
                  ),
                )
              }
            />
            <span className="task-check-text">{item.text}</span>
            <button
              type="button"
              className="task-check-remove nodrag"
              aria-label={t("task.removeItem", { text: item.text })}
              onClick={() =>
                patch(
                  task.checklist.filter(
                    (candidate) => candidate.id !== item.id,
                  ),
                )
              }
            >
              ✕
            </button>
          </label>
        ))}
        <input
          className="task-check-entry nodrag"
          aria-label={t("task.addItem")}
          placeholder={t("task.addItem")}
          maxLength={2_000}
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={addItem}
        />
      </div>

      <button
        type="button"
        className="task-dispatch nodrag"
        onClick={() => dispatchTask(id)}
      >
        ➤ {t("task.dispatch")}
      </button>
    </div>
  );
}
