import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CopilotLoginProgress } from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Button } from "@/ui/button";

/**
 * Copilot 登录（§4.2）。
 *
 * GitHub 的 device flow：Runtime 换到用户码，这里把码显示出来并按 GitHub
 * 指定的间隔轮询。`deviceCode` 从不下发，所以这一页只知道「码是多少」和
 * 「到哪里输入」。
 *
 * 验证地址只显示成可复制的文本，不做成会自动打开的链接——设置页里冒出一个
 * 外部跳转不该由一次开关点击触发。
 */
export function CopilotSignIn({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<CopilotLoginProgress | null>(null);

  const auth = useQuery({
    queryKey: ["copilot-auth"],
    queryFn: () => runtimeApi.copilotAuth(),
    retry: false,
  });
  const login = useMutation({
    mutationFn: () => runtimeApi.copilotLogin(),
    onMutate: () => setProgress("pending"),
    onSuccess: (next) => queryClient.setQueryData(["copilot-auth"], next),
    onError: () => setProgress("error"),
  });
  const logout = useMutation({
    mutationFn: () => runtimeApi.copilotLogout(),
    onSuccess: (next) => {
      setProgress(null);
      queryClient.setQueryData(["copilot-auth"], next);
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
    },
  });

  const pending = auth.data?.pending;
  const interval = pending?.intervalSeconds ?? 5;
  const polling = progress === "pending" && Boolean(pending);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const next = await runtimeApi.copilotPoll();
        if (cancelled) return;
        setProgress(next.progress);
        queryClient.setQueryData(["copilot-auth"], {
          signedIn: next.signedIn,
          backend: next.backend,
          pending: next.pending,
        });
        if (next.progress === "authorized")
          void queryClient.invalidateQueries({ queryKey: ["usage"] });
      } catch {
        if (!cancelled) setProgress("error");
      }
    }, interval * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling, interval, queryClient]);

  const signedIn = auth.data?.signedIn === true;

  return (
    <SettingsGroup>
      <SettingsRow
        label={t("settings.copilotAccount")}
        footnote={
          auth.data?.backend === "file"
            ? t("settings.copilotFileBackend")
            : undefined
        }
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={
            disabled || auth.isLoading || login.isPending || logout.isPending
          }
          onClick={() => (signedIn ? logout.mutate() : login.mutate())}
        >
          {signedIn
            ? t("settings.copilotSignOut")
            : t("settings.copilotSignIn")}
        </Button>
      </SettingsRow>

      {pending && (
        <div
          role="status"
          className="flex flex-col gap-1 px-4 pb-3 text-[13px] leading-5"
        >
          <span className="text-muted-foreground">
            {t("settings.copilotPrompt", { value: pending.verificationUri })}
          </span>
          <code
            data-slot="copilot-user-code"
            className="w-fit rounded-md bg-muted px-2 py-1 font-mono text-sm tracking-widest tabular-nums"
          >
            {pending.userCode}
          </code>
        </div>
      )}

      {progress && progress !== "pending" && (
        <p
          role="status"
          data-slot="copilot-progress"
          className={`px-4 pb-3 text-xs ${
            progress === "authorized" ? "text-muted-foreground" : "text-danger"
          }`}
        >
          {t(`settings.copilot.${progress}`)}
        </p>
      )}
    </SettingsGroup>
  );
}
