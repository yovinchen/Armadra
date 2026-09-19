import { useEffect, useId, useRef, useState } from "react";

import {
  hasSessionCapability,
  IdentityRequestError,
  IdentityTransportError,
  listIdentityDevices,
  logoutIdentity,
  pairIdentity,
  resumeIdentity,
  revokeIdentityDevice,
  takePairingTicket,
  type IdentityDevicePage,
  type IdentityHello,
  type IdentitySession,
} from "../../../api/identity";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import {
  isNativeShell,
  nativeSessionFailureKey,
} from "../../../host/native-session";
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
  hello?: IdentityHello;
}

type Device = IdentityDevicePage["devices"][number];

/** 身份面用不上的原因；`null` 表示可以用。 */
function availability(hello: IdentityHello | undefined): string | null {
  if (!hello?.hostId || !hello.hostInstanceId)
    return "hostIdentity.checkRequired";
  if (!hasSessionCapability(hello)) return "hostIdentity.unsupported";
  return null;
}

function failureKey(error: unknown): string {
  // 壳里票据由壳自己签；它的失败有自己那句话，好让人知道该看哪一边。
  const native = nativeSessionFailureKey(error);
  if (native) return native;
  if (error instanceof IdentityTransportError)
    return "hostIdentity.error.network";
  if (!(error instanceof IdentityRequestError))
    return "hostIdentity.error.response";
  if (error.status === 401) return "hostIdentity.error.auth";
  if (error.status === 403) return "hostIdentity.error.permission";
  if (error.status === 409) return "hostIdentity.error.conflict";
  if (error.status === 400) return "hostIdentity.error.invalid";
  return "hostIdentity.error.network";
}

export function HostIdentityPanel({ hello }: HostIdentityPanelProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const id = useId();
  const unavailable = availability(hello);
  const ready = unavailable === null;
  const working = useRef(false);
  const generation = useRef(0);
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [cursor, setCursor] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Device | null>(null);

  const live = (mark: number) => generation.current === mark;

  async function devicePage(mark: number, after = "") {
    const page = await listIdentityDevices(after);
    if (!live(mark)) return;
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

  async function accept(mark: number, value: IdentitySession | null) {
    if (!live(mark)) return;
    setSession(value);
    setConfirm(null);
    setDevices([]);
    setHasMore(false);
    setCursor("");
    if (value?.scopes.some((scope) => scope.permission === "identity:read"))
      await devicePage(mark);
  }

  async function run(action: (mark: number) => Promise<void>) {
    const mark = generation.current;
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(mark);
    } catch (failure) {
      if (live(mark)) setError(failureKey(failure));
    } finally {
      if (live(mark)) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    generation.current += 1;
    const mark = generation.current;
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
    if (!ready) return;
    // 服务器壳把票放在地址栏的片段里（`…/#pair=<票>`）。读到就直接配对：
    // 让人把一串票自己复制一遍，只会多一次出错的机会。
    const pending = takePairingTicket();
    void run(async (current) =>
      accept(
        current,
        pending ? await pairIdentity(pending) : await resumeIdentity(),
      ),
    );
    return () => {
      generation.current += 1;
      revokeTrigger.current = null;
    };
    // 这条会话只跟着「身份面能不能用」走，不跟着语言或响应对象的身份走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const canManage = session?.scopes.some(
    (scope) => scope.permission === "identity:manage",
  );
  const canList = session?.scopes.some(
    (scope) => scope.permission === "identity:read",
  );
  const expiry =
    session && session.expiresAtUnixMs > 0
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(session.expiresAtUnixMs)
      : "—";

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
      <h3 id={`${id}-title`} className="text-[13px] font-medium">
        {t("hostIdentity.title")}
      </h3>
      {unavailable ? (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(unavailable)}
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
                  void run(async (mark) =>
                    accept(mark, await pairIdentity(material)),
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
                  {t(
                    isNativeShell()
                      ? "hostIdentity.ticketHelp"
                      : "hostIdentity.ticketHelp.server",
                  )}
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
                      void run(async (mark) =>
                        accept(mark, await resumeIdentity()),
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
                      {session.device.displayName} · {t("hostIdentity.owner")}
                    </dd>
                    <dd className="mt-1 break-all text-muted-foreground select-text">
                      {session.device.deviceId}
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
                      void run(async (mark) =>
                        accept(mark, await resumeIdentity()),
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
                      void run(async (mark) => {
                        await logoutIdentity();
                        await accept(mark, null);
                        if (live(mark)) setNotice("hostIdentity.loggedOut");
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
                          void run((mark) => devicePage(mark));
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
                              {device.name}
                              {device.deviceId === session.device.deviceId && (
                                <> · {t("hostIdentity.thisDevice")}</>
                              )}
                            </p>
                            <p className="mt-1 break-all text-muted-foreground">
                              {device.deviceId}
                            </p>
                            {device.revokedAtMs > 0 && (
                              <p className="mt-1 text-muted-foreground">
                                {t("hostIdentity.revoked")}
                              </p>
                            )}
                          </div>
                          {canManage && device.revokedAtMs === 0 && (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="min-h-10 shrink-0"
                              disabled={busy}
                              aria-label={t("hostIdentity.revokeNamed", {
                                name: device.name,
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
                          void run((mark) => devicePage(mark, cursor))
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
                      {confirm?.name}
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
                          void run(async (mark) => {
                            await revokeIdentityDevice(
                              device.deviceId,
                              device.epoch,
                            );
                            if (!live(mark)) return;
                            if (device.deviceId === session.device.deviceId)
                              await accept(mark, null);
                            else await devicePage(mark);
                            if (live(mark))
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
