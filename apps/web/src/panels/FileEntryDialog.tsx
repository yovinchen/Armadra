/**
 * 新建 / 重命名 / 移动 的输入框（E01/M4）。
 *
 * 一个字段，三种用途：新建时填名称（落在选中的目录里），重命名与移动填的
 * 是工作区内路径，所以「移动到别处」就是把路径前缀改掉——不必另做一个树
 * 形选择器。真正的校验在 Runtime：越界、符号链接、同名都在那边拒绝，这里
 * 只把错误原样显示出来。
 */
import { useEffect, useState } from "react";

import { useT } from "../app/preferences-store";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

export interface FileEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 初始值：新建时为空，重命名时是当前路径。 */
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: (value: string) => void;
}

export function FileEntryDialog({
  open,
  onOpenChange,
  title,
  initialValue = "",
  placeholder,
  confirmLabel,
  pending = false,
  onConfirm,
}: FileEntryDialogProps) {
  const t = useT();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [initialValue, open]);

  const ready = value.trim().length > 0 && value.trim() !== initialValue;
  const confirm = () => {
    if (ready && !pending) onConfirm(value.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[var(--z-dialog)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <Input
            autoFocus
            aria-label={placeholder ?? title}
            placeholder={placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            // 一个字段的对话框必须能只用回车确认，所以除了表单的隐式提交，
            // 这里再自己接一次；输入法组合期间的回车是选字，不算确认。
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              confirm();
            }}
          />
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" disabled={!ready || pending}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
