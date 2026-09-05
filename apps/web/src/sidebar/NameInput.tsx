import { useState } from "react";

import { Input } from "@/ui/input";

/** 就地命名输入框：Enter 提交、Escape/失焦取消，挂载即选中。 */
export function NameInput({
  initial,
  label,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  const commit = () => {
    const name = value.trim();
    if (!name || name === initial) {
      onCancel();
      return;
    }
    onSubmit(name);
  };

  return (
    <Input
      autoFocus
      value={value}
      disabled={pending}
      aria-label={label}
      placeholder={label}
      className="my-0.5 h-7 text-[length:var(--text-body)]"
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") commit();
        if (event.key === "Escape") onCancel();
      }}
    />
  );
}
