import type { ReactNode } from "react";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-xs">
      <input
        type="checkbox"
        className="size-4 accent-[var(--brand)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
export function ReadError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className="max-h-[40dvh] space-y-2 overflow-y-auto break-words p-3 text-xs text-destructive"
    >
      <p>{error instanceof Error ? error.message : t("gitRepo.failed")}</p>
      <Button variant="outline" size="sm" onClick={retry}>
        {t("gitRepo.retry")}
      </Button>
    </div>
  );
}
export const selectClass =
  "h-9 min-w-0 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
