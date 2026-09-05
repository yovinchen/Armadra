import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  GithubCredentialSource,
  GithubSecretStore,
} from "@armadra/host-client";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { useGithubSession } from "../../../host/github-session";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
import { Field, selectClass } from "../../git/forms";
import {
  credentialSourceKey,
  failureKey,
  instant,
  secretStoreKey,
} from "../../github/model";
import { githubKeys } from "../../github/queries";

/**
 * 设置 → GitHub（Git/GitHub 设计 §9）。
 *
 * 令牌只往外走一次：输入框是 password 类型，永远不回填、不从任何回应里读回来，
 * 保存成功后立即从组件状态里清掉。降级到 0600 文件时明说，不写成「已安全保存」。
 */
export function GithubPage() {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const workspace = useCanvasStore((state) => state.workspace);
  const state = useGithubSession((store) => store.state);
  const client = useGithubSession((store) => store.client);
  const connect = useGithubSession((store) => store.connect);
  const queryClient = useQueryClient();

  const workspaceId = workspace?.id ?? null;
  const [source, setSource] = React.useState<GithubCredentialSource>(
    GithubCredentialSource.GH_CLI,
  );
  const [apiBase, setApiBase] = React.useState("");
  const [token, setToken] = React.useState("");

  React.useEffect(() => {
    void connect(workspaceId);
  }, [connect, workspaceId]);

  const credential = useQuery({
    queryKey: githubKeys.credential(workspaceId ?? ""),
    queryFn: () => client!.getCredential(),
    enabled: Boolean(client),
    retry: false,
  });
  const status = credential.data;
  const fail = (error: unknown) => toast.error(t(failureKey(error)));

  const configure = useMutation({
    mutationFn: () =>
      client!.configureCredential({
        source,
        token: source === GithubCredentialSource.TOKEN_REF ? token : undefined,
        apiBase: apiBase.trim() || undefined,
        expectedRevision: status?.revision ?? 0n,
      }),
    onSuccess: () => {
      // The token leaves this component the moment the Host accepted it.
      setToken("");
      toast.success(t("github.settings.saved"));
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
      void connect(workspaceId);
    },
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: () =>
      client!.revokeCredential({ expectedRevision: status!.revision }),
    onSuccess: () => {
      setToken("");
      toast.success(t("github.settings.revoked"));
      void queryClient.invalidateQueries({ queryKey: githubKeys.all });
      void connect(workspaceId);
    },
    onError: fail,
  });

  const blocked =
    state.status === "blocked" && state.reason !== "noCredential"
      ? state.reason
      : null;
  const busy = configure.isPending || revoke.isPending;

  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("github.settings.note")}
      </p>

      {blocked || !client ? (
        <p
          role="status"
          className="text-[13px] leading-5 text-muted-foreground"
        >
          {blocked ? t(`github.blocked.${blocked}`) : t("github.loading")}
        </p>
      ) : (
        <>
          <SettingsGroup>
            <form
              className="flex min-w-0 flex-col gap-3 px-4 py-3"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                if (
                  source === GithubCredentialSource.TOKEN_REF &&
                  !token.trim()
                )
                  return;
                configure.mutate();
              }}
            >
              <Field label={t("github.settings.source")}>
                <select
                  className={selectClass}
                  value={String(source)}
                  onChange={(event) =>
                    setSource(
                      Number(event.target.value) as GithubCredentialSource,
                    )
                  }
                >
                  <option value={String(GithubCredentialSource.NONE)}>
                    {t("github.source.none")}
                  </option>
                  <option value={String(GithubCredentialSource.GH_CLI)}>
                    {t("github.source.ghCli")}
                  </option>
                  <option value={String(GithubCredentialSource.TOKEN_REF)}>
                    {t("github.source.token")}
                  </option>
                </select>
              </Field>
              <Field label={t("github.settings.apiBase")}>
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiBase}
                  onChange={(event) => setApiBase(event.target.value)}
                  className="h-10 min-w-0"
                />
              </Field>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {t("github.settings.apiBaseNote")}
              </p>
              {source === GithubCredentialSource.TOKEN_REF && (
                <>
                  <Field label={t("github.settings.token")}>
                    <Input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      data-slot="github-token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      className="h-10 min-w-0"
                    />
                  </Field>
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {t("github.settings.tokenNote")}
                  </p>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-10"
                  disabled={
                    busy ||
                    (source === GithubCredentialSource.TOKEN_REF &&
                      !token.trim())
                  }
                >
                  {t("github.settings.save")}
                </Button>
                {status && status.revision > 0n && (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() => revoke.mutate()}
                  >
                    {t("github.settings.revoke")}
                  </Button>
                )}
              </div>
            </form>
          </SettingsGroup>

          <SettingsGroup>
            <dl className="grid min-w-0 gap-3 px-4 py-3 text-[12px]">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant={status?.available ? "secondary" : "outline"}>
                  {t(
                    status?.available
                      ? "github.settings.available"
                      : "github.settings.unavailable",
                  )}
                </Badge>
                {status?.enterprise && (
                  <Badge variant="outline">{t("github.enterprise")}</Badge>
                )}
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("github.settings.source")}
                </dt>
                <dd className="mt-1">
                  {t(
                    credentialSourceKey(
                      status?.source ?? GithubCredentialSource.UNSPECIFIED,
                    ),
                  )}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("github.settings.store")}
                </dt>
                <dd className="mt-1">
                  {t(
                    secretStoreKey(
                      status?.store ?? GithubSecretStore.UNSPECIFIED,
                    ),
                  )}
                </dd>
              </div>
              {status?.store === GithubSecretStore.FILE_FALLBACK && (
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {t("github.settings.fileFallbackNote")}
                </p>
              )}
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("github.settings.apiBase")}
                </dt>
                <dd className="mt-1 break-all select-text">
                  {status?.apiBase}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("github.settings.account")}
                </dt>
                <dd className="mt-1 break-all select-text">
                  {status?.accountLogin || t("github.settings.unknown")}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("github.settings.scopes")}
                </dt>
                <dd className="mt-1 break-all select-text">
                  {status?.tokenScopes.join(", ") ||
                    t("github.settings.unknown")}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("github.settings.checkedAt")}
                </dt>
                <dd className="mt-1">
                  {instant(status?.checkedAtUnixMs, locale) ??
                    t("github.settings.unknown")}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("github.settings.revision")}
                </dt>
                <dd className="mt-1 tabular-nums">
                  {String(status?.revision ?? 0n)}
                </dd>
              </div>
              {status?.reasonCode && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t("github.reasonCode")}
                  </dt>
                  <dd className="mt-1 font-mono break-all select-text">
                    {status.reasonCode}
                  </dd>
                </div>
              )}
            </dl>
          </SettingsGroup>
        </>
      )}
    </>
  );
}
