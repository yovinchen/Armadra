import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "@/app/preferences-store";

/** A tree label becomes the editor, without opening a separate dialog. */
export function InlineName({
  name,
  label,
  caption,
  editing,
  onEditingChange,
  onSelect,
  onSave,
}: {
  name: string;
  label: string;
  caption?: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSelect: () => void;
  onSave: (name: string) => Promise<unknown>;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  const cancelled = useRef(false);
  const composing = useRef(false);
  const [draft, setDraft] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!editing) return;
    cancelled.current = false;
    setDraft(name);
    setError("");
    // Wait for a context menu to finish restoring its focus, if it opened editing.
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const finish = (restoreFocus: boolean) => {
    onEditingChange(false);
    if (restoreFocus) requestAnimationFrame(() => button.current?.focus());
  };
  const save = async (restoreFocus: boolean) => {
    if (saving.current || cancelled.current || composing.current) return;
    const next = draft.trim();
    if (!next) {
      setError(t("sidebar.nameRequired"));
      return;
    }
    if (next === name) {
      finish(restoreFocus);
      return;
    }
    saving.current = true;
    setPending(true);
    setError("");
    try {
      await onSave(next);
      finish(restoreFocus);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("sidebar.renameFailed"),
      );
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  if (!editing)
    return (
      <Button
        ref={button}
        variant="ghost"
        size="sm"
        title={caption ?? name}
        className="min-w-0 flex-1 justify-start px-1 text-[length:var(--text-body)] font-normal hover:bg-transparent"
        onClick={onSelect}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onEditingChange(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "F2") {
            event.preventDefault();
            event.stopPropagation();
            onEditingChange(true);
          }
        }}
      >
        <span className="truncate">{name}</span>
      </Button>
    );
  return (
    <>
      <Input
        ref={input}
        value={draft}
        aria-label={label}
        aria-invalid={Boolean(error)}
        aria-busy={pending}
        title={error || label}
        maxLength={120}
        readOnly={pending}
        className="h-6 min-w-0 flex-1 rounded-sm px-1 py-0 text-[length:var(--text-body)] shadow-none"
        onChange={(event) => {
          setDraft(event.target.value);
          setError("");
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={() => void save(false)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.nativeEvent.isComposing ||
            composing.current ||
            event.keyCode === 229
          )
            return;
          if (event.key === "Enter") {
            event.preventDefault();
            void save(true);
          }
          if (event.key === "Escape" && !pending) {
            event.preventDefault();
            cancelled.current = true;
            finish(true);
          }
        }}
      />
      {error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
    </>
  );
}
