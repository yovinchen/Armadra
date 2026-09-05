import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  HostIdentityClient,
  HostIdentityError,
  type HelloResponse,
  type HostIdentityDevices,
  type HostIdentitySession,
} from "@armadra/host-client";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { Button } from "@/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { SettingsGroup } from "../SettingsGroup";

export interface HostIdentityPanelProps {
  address: string;
  hello?: HelloResponse;
}
type Device = HostIdentityDevices["devices"][number];
function availability(
  address: string,
  hello: HelloResponse | undefined,
): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "hostIdentity.tlsRequired";
  }
  if (url.protocol !== "https:") return "hostIdentity.tlsRequired";
  if (url.origin !== globalThis.location?.origin)
    return "hostIdentity.sameOrigin";
  if (!hello?.hostId || !hello.hostInstanceId)
    return "hostIdentity.checkRequired";
  if (!hello.capabilities.includes("identity.browser-session.v1"))
    return "hostIdentity.unsupported";
  return null;
}
function failureKey(error: unknown): string {
  if (!(error instanceof HostIdentityError))
    return "hostIdentity.error.network";
  if (error.outcomeUnknown) return "hostIdentity.error.unknown";
  if (error.hostCode === "UNAUTHENTICATED") return "hostIdentity.error.auth";
  if (error.hostCode === "PERMISSION_DENIED")
    return "hostIdentity.error.permission";
  if (error.hostCode === "CONFLICT") return "hostIdentity.error.conflict";
  if (error.code === "INVALID_OPTIONS") return "hostIdentity.error.invalid";
  if (
    [
      "MALFORMED_RESPONSE",
      "RESPONSE_TOO_LARGE",
      "UNEXPECTED_CONTENT_TYPE",
    ].includes(error.code)
  )
    return "hostIdentity.error.response";
  return "hostIdentity.error.network";
}

export function HostIdentityPanel({ address, hello }: HostIdentityPanelProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const id = useId();
  const unavailable = availability(address, hello);
  const hostId = hello?.hostId,
    instanceId = hello?.hostInstanceId;
  const config = useMemo(
    () =>
      unavailable || !hostId || !instanceId
        ? null
        : { baseUrl: address, hostId, hostInstanceId: instanceId },
    [address, hostId, instanceId, unavailable],
  );
  const current = useRef<HostIdentityClient | null>(null);
  const working = useRef(false);
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const [session, setSession] = useState<HostIdentitySession | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [cursor, setCursor] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Device | null>(null);

  function live(target: HostIdentityClient) {
    return current.current === target;
  }
  async function devicePage(target: HostIdentityClient, after = "") {
    const page = await target.listDevices(after);
    if (!live(target)) return;
    setDevices((previous) =>
      after
        ? [
            ...previous,
            ...page.devices.filter(
              (device) =>
                !previous.some((old) => old.deviceId === device.deviceId),
            ),
          ]
        : page.devices,
    );
    setCursor(page.nextId);
    setHasMore(page.hasMore);
  }
  async function accept(
    target: HostIdentityClient,
    value: HostIdentitySession | null,
  ) {
    if (!live(target)) return;
    setSession(value);
    setConfirm(null);
    setDevices([]);
    setHasMore(false);
    setCursor("");
    if (value?.scopes.some((scope) => scope.permission === "identity:read"))
      await devicePage(target);
  }
  async function run(action: (target: HostIdentityClient) => Promise<void>) {
    const target = current.current;
    if (!target || working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(target);
    } catch (failure) {
      if (live(target)) setError(failureKey(failure));
    } finally {
      if (live(target)) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    let client: HostIdentityClient | null = null;
    try {
      if (config) client = new HostIdentityClient(config);
    } catch {
      /* Invalid configuration never starts a request. */
    }
    current.current = client;
    working.current = false;
    setSession(null);
    setDevices([]);
    setHasMore(false);
    setCursor("");
    setTicket("");
    setError(null);
    setNotice(null);
    setConfirm(null);
    setBusy(false);
    if (client)
      void run(async (target) => accept(target, await target.resume()));
    return () => {
      if (current.current === client) current.current = null;
      revokeTrigger.current = null;
      client?.dispose();
    };
    // The selected Host, not locale or response-object identity, owns this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);
  const canManage = session?.scopes.some(
    (scope) => scope.permission === "identity:manage",
  );
  const canList = session?.scopes.some(
    (scope) => scope.permission === "identity:read",
  );
  const expiry =
    session && session.expiresAtUnixMs <= 8_640_000_000_000_000n
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(Number(session.expiresAtUnixMs))
      : "—";
  const disabledKey =
    unavailable ?? (!config ? "hostIdentity.checkRequired" : null);
  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
      <h3 id={`${id}-title`} className="text-[13px] font-medium">
        {t("hostIdentity.title")}
      </h3>
      {disabledKey ? (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(disabledKey)}
        </p>
      ) : (
        <SettingsGroup>
          <div className="min-w-0 space-y-4 px-4 py-3" aria-busy={busy}>
            <p
              role="status"
              aria-live="polite"
              className={`break-words text-[12px] leading-5 ${error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {t(
                error ??
                  (busy
                    ? session
                      ? "hostIdentity.busy"
                      : "hostIdentity.loading"
                    : (notice ??
                      (!session
                        ? "hostIdentity.signedOut"
                        : "hostIdentity.current"))),
              )}
            </p>
            {!session ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || !ticket.trim()) return;
                  const material = ticket;
                  setTicket("");
                  void run(async (target) =>
                    accept(target, await target.pair(material)),
                  );
                }}
              >
                <label
                  htmlFor={`${id}-ticket`}
                  className="block text-[13px] font-medium"
                >
                  {t("hostIdentity.ticket")}
                </label>
                <textarea
                  id={`${id}-ticket`}
                  rows={3}
                  maxLength={8192}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={ticket}
                  disabled={busy}
                  aria-describedby={`${id}-ticket-help`}
                  onChange={(event) => setTicket(event.target.value)}
                  className="w-full min-w-0 resize-y rounded-lg border border-input bg-background px-3 py-2 text-[12px] focus-visible:outline-2 focus-visible:outline-ring"
                />
                <p
                  id={`${id}-ticket-help`}
                  className="text-[11px] leading-4 text-muted-foreground"
                >
                  {t("hostIdentity.ticketHelp")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    className="min-h-10"
                    disabled={busy || !ticket.trim()}
                  >
                    {t("hostIdentity.pair")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() =>
                      void run(async (target) =>
                        accept(target, await target.resume()),
                      )
                    }
                  >
                    {t("hostIdentity.restore")}
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <dl className="grid min-w-0 gap-3 text-[12px]">
                  <div>
                    <dt className="text-muted-foreground">
                      {t("hostIdentity.current")}
                    </dt>
                    <dd className="mt-1 break-words font-medium">
                      {session.device!.displayName} · {t("hostIdentity.owner")}
                    </dd>
                    <dd className="mt-1 break-all text-muted-foreground select-text">
                      {session.device!.deviceId}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("hostIdentity.expires")}
                    </dt>
                    <dd className="mt-1">{expiry}</dd>
                  </div>
                </dl>
                <details>
                  <summary className="cursor-pointer text-[12px] focus-visible:outline-2 focus-visible:outline-ring">
                    {t("hostIdentity.permissions")}
                  </summary>
                  <ul className="mt-2 space-y-2 text-[12px]">
                    {session.scopes.map((scope, index) => (
                      <li
                        key={`${scope.permission}-${index}`}
                        className="break-words"
                      >
                        {t(`hostIdentity.scope.${scope.permission}`)} ·{" "}
                        {scope.workspaceId
                          ? t("hostIdentity.workspace", {
                              id: scope.workspaceId,
                            })
                          : t("hostIdentity.allWorkspaces")}
                        {scope.executionHostId && (
                          <>
                            {" "}
                            ·{" "}
                            {t("hostIdentity.executionHost", {
                              id: scope.executionHostId,
                            })}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() =>
                      void run(async (target) =>
                        accept(target, await target.resume()),
                      )
                    }
                  >
                    {t("hostIdentity.restore")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() =>
                      void run(async (target) => {
                        await target.logout();
                        await accept(target, null);
                        if (live(target)) setNotice("hostIdentity.loggedOut");
                      })
                    }
                  >
                    {t("hostIdentity.logout")}
                  </Button>
                </div>
                {canList && (
                  <div className="space-y-3 border-t border-border pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-[13px] font-medium">
                        {t("hostIdentity.devices")}
                      </h4>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-10"
                        disabled={busy}
                        onClick={() => {
                          setConfirm(null);
                          void run((target) => devicePage(target));
                        }}
                      >
                        {t("hostIdentity.reloadDevices")}
                      </Button>
                    </div>
                    <ul className="space-y-2">
                      {devices.map((device) => (
                        <li
                          key={device.deviceId}
                          className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
                        >
                          <div className="min-w-0 text-[12px]">
                            <p className="break-words font-medium">
                              {device.displayName}
                              {device.deviceId === session.device!.deviceId && (
                                <> · {t("hostIdentity.thisDevice")}</>
                              )}
                            </p>
                            <p className="mt-1 break-all text-muted-foreground">
                              {device.deviceId}
                            </p>
                            {device.revokedAtUnixMs > 0n && (
                              <p className="mt-1 text-muted-foreground">
                                {t("hostIdentity.revoked")}
                              </p>
                            )}
                          </div>
                          {canManage && device.revokedAtUnixMs === 0n && (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="min-h-10 shrink-0"
                              disabled={busy}
                              aria-label={t("hostIdentity.revokeNamed", {
                                name: device.displayName,
                              })}
                              onClick={(event) => {
                                revokeTrigger.current = event.currentTarget;
                                setConfirm(device);
                              }}
                            >
                              {t("hostIdentity.revoke")}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {hasMore && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="min-h-10"
                        disabled={busy}
                        onClick={() =>
                          void run((target) => devicePage(target, cursor))
                        }
                      >
                        {t("hostIdentity.more")}
                      </Button>
                    )}
                  </div>
                )}
                <AlertDialog
                  open={confirm !== null}
                  onOpenChange={(open) => {
                    if (!open) setConfirm(null);
                  }}
                >
                  <AlertDialogContent
                    className="z-[var(--z-dialog)]"
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      if (revokeTrigger.current?.isConnected)
                        revokeTrigger.current.focus();
                    }}
                  >
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("hostIdentity.confirmTitle")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("hostIdentity.confirmNote")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <p className="break-words text-[13px] font-medium">
                      {confirm?.displayName}
                    </p>
                    <p className="break-all text-[11px] text-muted-foreground">
                      {confirm?.deviceId}
                    </p>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="min-h-10" disabled={busy}>
                        {t("hostIdentity.cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        className="min-h-10"
                        disabled={busy}
                        onClick={() => {
                          const device = confirm;
                          if (!device) return;
                          setConfirm(null);
                          void run(async (target) => {
                            await target.revokeDevice(
                              device.deviceId,
                              device.revision,
                            );
                            if (!live(target)) return;
                            if (device.deviceId === session.device!.deviceId)
                              await accept(target, null);
                            else await devicePage(target);
                            if (live(target))
                              setNotice("hostIdentity.revokedNotice");
                          });
                        }}
                      >
                        {t("hostIdentity.confirm")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        </SettingsGroup>
      )}
    </section>
  );
}
