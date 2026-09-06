import * as React from "react";
import { toast } from "sonner";
import type { SshPrompt } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent } from "@/api/events";
import { useT } from "@/app/preferences-store";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

/**
 * `ssh` 要密码或密钥口令时的输入框（远端补完设计 §3.6）。
 *
 * 答案只往一个方向走：输进来，POST 出去，然后立刻从组件状态里清掉。不进
 * store、不进 localStorage、不进日志、不进 toast——Runtime 那边也只在内存里
 * 留到 askpass 取走的那一次。
 *
 * 关掉 = 取消（DELETE），不是「等会儿再说」：让 `ssh` 干净地失败，好过挂在
 * 那里等一个不会来的答案。一次只问一条，其余排队。
 */
export function SshPromptDialog() {
  const t = useT();
  const [queue, setQueue] = React.useState<SshPrompt[]>([]);
  const [answer, setAnswer] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const current = queue[0];

  const enqueue = React.useCallback((prompts: SshPrompt[]) => {
    setQueue((pending) => [
      ...pending,
      ...prompts.filter(
        (prompt) => !pending.some((item) => item.promptId === prompt.promptId),
      ),
    ]);
  }, []);

  React.useEffect(
    () => onWorkspaceEvent("ssh.prompt", (event) => enqueue([event.prompt])),
    [enqueue],
  );

  // 页面刚打开时可能已经有人在等了：事件是广播的，错过就不会重发。
  React.useEffect(() => {
    let cancelled = false;
    void runtimeApi
      .sshPrompts()
      .then((prompts) => {
        if (!cancelled) enqueue(prompts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enqueue]);

  function done(promptId: string) {
    setAnswer("");
    setSending(false);
    setQueue((pending) => pending.filter((item) => item.promptId !== promptId));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!current || sending) return;
    const { hostId, promptId } = current;
    const secret = answer;
    // 先清再发：这一帧之后 React 状态里就没有这串了，失败也不回填。
    setAnswer("");
    setSending(true);
    void runtimeApi.answerSshPrompt(hostId, promptId, secret).then(
      () => done(promptId),
      (cause: Error) => {
        setSending(false);
        toast.error(t("ssh.prompt.failed"), { description: cause.message });
      },
    );
  }

  function cancel() {
    if (!current) return;
    const { hostId, promptId } = current;
    done(promptId);
    void runtimeApi.cancelSshPrompt(hostId, promptId).catch(() => undefined);
  }

  const label = t(
    current?.kind === "passphrase"
      ? "ssh.prompt.passphrase"
      : "ssh.prompt.password",
  );

  return (
    <Dialog
      open={Boolean(current)}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <DialogContent className="z-[var(--z-dialog)]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("ssh.prompt.title")}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <p className="text-xs text-muted-foreground">
            {`${t("ssh.prompt.host")} · ${current?.hostId ?? ""}`}
          </p>
          <p className="text-xs break-words text-muted-foreground">
            {current?.prompt}
          </p>
          <Input
            type="password"
            autoComplete="off"
            aria-label={label}
            className="h-8 text-xs"
            value={answer}
            disabled={sending}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              {t("ssh.prompt.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={sending}>
              {t("ssh.prompt.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
