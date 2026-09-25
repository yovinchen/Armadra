import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  SHARE_ROLES,
  createGroup,
  createMember,
  deleteGroup,
  disablePrincipal,
  invitationLink,
  issueInvitation,
  listGrants,
  listGroups,
  listInvitations,
  listPrincipals,
  loginWithPassword,
  putGrant,
  putGroupMember,
  redeemInvitation,
  removeGroupMember,
  revokeGrant,
  revokeInvitation,
  setPassword,
  takeInvitationToken,
  type Group,
  type GroupRole,
  type Principal,
  type ShareRole,
} from "../../../api/accounts";
import {
  IdentityRequestError,
  resumeIdentity,
  type IdentitySession,
} from "../../../api/identity";
import { localizedFailure } from "../../../api/request";
import { useWorkspacesQuery } from "../../../app/workspaces-query";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { CONTROL_WIDTH } from "./GeneralPage";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/**
 * 设置 → 账号与共享（服务器账号 R8，设计 `server-accounts-and-sharing.md`）。
 *
 * 只在服务器壳托管的页面上出现（`nav.ts` 的 `serverOnly`）。四块：自己的账号、
 * 成员、组、邀请与工作空间共享；后三块只给管理员（会话里有
 * `identity:manage`）。判定都在 core：这一页只是把「谁、在哪块画布上、是什么
 * 角色」写进去，拦不拦由路由门与事件流决定。
 *
 * 邀请链接落在页面根的 `#invite=` 片段上；设置对话框看见它会自己打开到这一页，
 * 这里取走令牌、弹出兑换对话框。
 */
export function AccountsSharingPage() {
  const [session, setSession] = React.useState<
    IdentitySession | null | undefined
  >(undefined);
  const [invite, setInvite] = React.useState("");

  React.useEffect(() => {
    const token = takeInvitationToken();
    if (token) setInvite(token);
    let live = true;
    void resumeIdentity().then(
      (value) => {
        if (live) setSession(value);
      },
      () => {
        if (live) setSession(null);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const canManage =
    session?.scopes.some((scope) => scope.permission === "identity:manage") ??
    false;

  return (
    <>
      {invite && (
        <RedeemDialog
          token={invite}
          onClose={(joined) => {
            setInvite("");
            if (joined) setSession(joined);
          }}
        />
      )}
      {session === null && !invite && <SignIn onSignedIn={setSession} />}
      {session && <MyAccount session={session} />}
      {session && canManage && (
        <>
          <Members self={session.device.principalId} />
          <Groups />
          <Invitations />
          <Sharing />
        </>
      )}
    </>
  );
}

/* --------------------------------- 公共 ---------------------------------- */

function failureText(error: unknown, t: ReturnType<typeof useT>): string {
  return error instanceof IdentityRequestError
    ? localizedFailure(error.code, error.message || t("sharing.failed"))
    : t("sharing.failed");
}

/** 跑一次管理动作：成功后让这一页的查询重取，失败弹一条。 */
function useAct() {
  const t = useT();
  const client = useQueryClient();
  return React.useCallback(
    async (work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work();
        await client.invalidateQueries({ queryKey: ["accounts"] });
        return true;
      } catch (error) {
        toast.error(failureText(error, t));
        return false;
      }
    },
    [client, t],
  );
}

function usePrincipals() {
  return useQuery({
    queryKey: ["accounts", "principals"],
    queryFn: listPrincipals,
  });
}

function useGroups() {
  return useQuery({ queryKey: ["accounts", "groups"], queryFn: listGroups });
}

function principalName(
  principal: Principal | undefined,
  t: ReturnType<typeof useT>,
): string {
  if (!principal) return t("sharing.members.unnamed");
  if (principal.displayName) return principal.displayName;
  return principal.kind === "owner"
    ? t("sharing.members.owner")
    : t("sharing.members.unnamed");
}

function RoleSelect({
  value,
  onChange,
  label,
}: {
  value: ShareRole;
  onChange: (role: ShareRole) => void;
  label: string;
}) {
  const t = useT();
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ShareRole)}>
      <SelectTrigger size="sm" className="w-[112px]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="z-[var(--z-dialog)]">
        {SHARE_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {t(`sharing.role.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 一个带若干输入框的小表单对话框：添加成员、新建组、设置口令都是它。 */
function FormDialog({
  open,
  title,
  fields,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  fields: { label: string; secret?: boolean }[];
  submitLabel: string;
  onClose: () => void;
  onSubmit: (values: string[]) => Promise<boolean>;
}) {
  const t = useT();
  const [values, setValues] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) setValues(fields.map(() => ""));
    // 字段只在打开的那一刻定形。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="z-[var(--z-dialog)] sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || values.some((value) => value.trim() === "")) return;
            setBusy(true);
            void onSubmit(values).then((done) => {
              setBusy(false);
              if (done) onClose();
            });
          }}
        >
          {fields.map((field, index) => (
            <Input
              key={field.label}
              type={field.secret ? "password" : "text"}
              autoComplete={field.secret ? "new-password" : "off"}
              aria-label={field.label}
              placeholder={field.label}
              value={values[index] ?? ""}
              disabled={busy}
              onChange={(event) =>
                setValues((current) =>
                  current.map((value, at) =>
                    at === index ? event.target.value : value,
                  ),
                )
              }
            />
          ))}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onClose}
            >
              {t("sharing.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ 登录与兑换 ------------------------------- */

function SignIn({
  onSignedIn,
}: {
  onSignedIn: (session: IdentitySession) => void;
}) {
  const t = useT();
  const [account, setAccount] = React.useState("");
  const [password, setPasswordValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <SettingsGroup title={t("sharing.signIn")}>
      <form
        className="flex flex-col gap-3 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !account.trim() || !password) return;
          setBusy(true);
          void loginWithPassword(account.trim(), password).then(
            (session) => {
              setPasswordValue("");
              setBusy(false);
              onSignedIn(session);
            },
            (error: unknown) => {
              setPasswordValue("");
              setBusy(false);
              toast.error(failureText(error, t));
            },
          );
        }}
      >
        <Input
          aria-label={t("sharing.accountId")}
          placeholder={t("sharing.accountId")}
          autoComplete="username"
          value={account}
          disabled={busy}
          onChange={(event) => setAccount(event.target.value)}
        />
        <Input
          type="password"
          aria-label={t("sharing.password")}
          placeholder={t("sharing.password")}
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPasswordValue(event.target.value)}
        />
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            {t("sharing.signIn")}
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}

function RedeemDialog({
  token,
  onClose,
}: {
  token: string;
  onClose: (joined: IdentitySession | null) => void;
}) {
  const t = useT();
  return (
    <FormDialog
      open
      title={t("sharing.redeem.title")}
      fields={[
        { label: t("sharing.members.name") },
        { label: t("sharing.password"), secret: true },
      ]}
      submitLabel={t("sharing.redeem.join")}
      onClose={() => onClose(null)}
      onSubmit={async ([displayName, password]) => {
        try {
          const session = await redeemInvitation({
            token,
            displayName: (displayName ?? "").trim(),
            password: password ?? "",
          });
          toast.success(t("sharing.redeem.done"));
          onClose(session);
          return false;
        } catch (error) {
          toast.error(failureText(error, t));
          return false;
        }
      }}
    />
  );
}

/* --------------------------------- 我的账号 ------------------------------- */

function MyAccount({ session }: { session: IdentitySession }) {
  const t = useT();
  const act = useAct();
  const [editing, setEditing] = React.useState(false);
  const principalId = session.device.principalId;
  return (
    <SettingsGroup title={t("sharing.me")}>
      <SettingsRow label={t("sharing.accountId")}>
        <span className="max-w-[260px] truncate font-mono text-[12px] select-text">
          {principalId}
        </span>
      </SettingsRow>
      <SettingsRow label={t("sharing.password")}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setEditing(true)}
        >
          {t("sharing.password.set")}
        </Button>
      </SettingsRow>
      <FormDialog
        open={editing}
        title={t("sharing.password.set")}
        fields={[{ label: t("sharing.password.new"), secret: true }]}
        submitLabel={t("sharing.save")}
        onClose={() => setEditing(false)}
        onSubmit={([password]) =>
          act(() => setPassword(principalId, password ?? ""))
        }
      />
    </SettingsGroup>
  );
}

/* ---------------------------------- 成员 ---------------------------------- */

function Members({ self }: { self: string }) {
  const t = useT();
  const act = useAct();
  const principals = usePrincipals();
  const [adding, setAdding] = React.useState(false);
  const [confirm, setConfirm] = React.useState<Principal | null>(null);
  return (
    <SettingsGroup title={t("sharing.members")}>
      {(principals.data ?? []).map((principal) => (
        <SettingsRow
          key={principal.principalId}
          label={principalName(principal, t)}
        >
          {principal.disabledAtMs > 0 ? (
            <span className="text-[12px] text-muted-foreground">
              {t("sharing.members.disabled")}
            </span>
          ) : principal.kind !== "owner" && principal.principalId !== self ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirm(principal)}
            >
              {t("sharing.members.disable")}
            </Button>
          ) : null}
        </SettingsRow>
      ))}
      <SettingsRow label={null}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setAdding(true)}
        >
          {t("sharing.members.add")}
        </Button>
      </SettingsRow>
      <FormDialog
        open={adding}
        title={t("sharing.members.add")}
        fields={[
          { label: t("sharing.members.name") },
          { label: t("sharing.members.initialPassword"), secret: true },
        ]}
        submitLabel={t("sharing.save")}
        onClose={() => setAdding(false)}
        onSubmit={([name, password]) =>
          act(() => createMember((name ?? "").trim(), password ?? ""))
        }
      />
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sharing.members.disableConfirm", {
                name: principalName(confirm ?? undefined, t),
              })}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sharing.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = confirm;
                setConfirm(null);
                if (target)
                  void act(() => disablePrincipal(target.principalId));
              }}
            >
              {t("sharing.members.disable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

/* ----------------------------------- 组 ----------------------------------- */

function Groups() {
  const t = useT();
  const act = useAct();
  const groups = useGroups();
  const [adding, setAdding] = React.useState(false);
  const [managing, setManaging] = React.useState<string | null>(null);
  const current = groups.data?.find((group) => group.groupId === managing);
  return (
    <SettingsGroup title={t("sharing.groups")}>
      {(groups.data ?? []).map((group) => (
        <SettingsRow
          key={group.groupId}
          label={group.name}
          onClick={() => setManaging(group.groupId)}
        >
          <span className="text-[12px] text-muted-foreground">
            {t("sharing.groups.count", { count: group.members.length })}
          </span>
        </SettingsRow>
      ))}
      <SettingsRow label={null}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setAdding(true)}
        >
          {t("sharing.groups.add")}
        </Button>
      </SettingsRow>
      <FormDialog
        open={adding}
        title={t("sharing.groups.add")}
        fields={[{ label: t("sharing.groups.name") }]}
        submitLabel={t("sharing.save")}
        onClose={() => setAdding(false)}
        onSubmit={([name]) => act(() => createGroup((name ?? "").trim()))}
      />
      {current && (
        <GroupDialog group={current} onClose={() => setManaging(null)} />
      )}
    </SettingsGroup>
  );
}

function GroupDialog({
  group,
  onClose,
}: {
  group: Group;
  onClose: () => void;
}) {
  const t = useT();
  const act = useAct();
  const principals = usePrincipals();
  const [pick, setPick] = React.useState("");
  const byId = new Map(
    (principals.data ?? []).map((principal) => [
      principal.principalId,
      principal,
    ]),
  );
  const candidates = (principals.data ?? []).filter(
    (principal) =>
      principal.disabledAtMs === 0 &&
      !group.members.some(
        (member) => member.principalId === principal.principalId,
      ),
  );
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="z-[var(--z-dialog)] sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{group.name}</DialogTitle>
        </DialogHeader>
        <div className="settings-group divide-y divide-border/60 rounded-lg border border-border/70 bg-card">
          {group.members.length === 0 && (
            <SettingsRow label={t("sharing.groups.empty")} />
          )}
          {group.members.map((member) => (
            <SettingsRow
              key={member.principalId}
              label={principalName(byId.get(member.principalId), t)}
            >
              <Select
                value={member.role}
                onValueChange={(role) =>
                  void act(() =>
                    putGroupMember(
                      group.groupId,
                      member.principalId,
                      role as GroupRole,
                    ),
                  )
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-[112px]"
                  aria-label={t("sharing.role")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[var(--z-dialog)]">
                  <SelectItem value="member">
                    {t("sharing.groups.role.member")}
                  </SelectItem>
                  <SelectItem value="admin">
                    {t("sharing.groups.role.admin")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <IconButton
                label={t("sharing.groups.remove")}
                onClick={() =>
                  void act(() =>
                    removeGroupMember(group.groupId, member.principalId),
                  )
                }
              >
                <Trash2 />
              </IconButton>
            </SettingsRow>
          ))}
          <SettingsRow label={null}>
            <Select value={pick} onValueChange={setPick}>
              <SelectTrigger
                size="sm"
                className={CONTROL_WIDTH}
                aria-label={t("sharing.groups.pick")}
              >
                <SelectValue placeholder={t("sharing.groups.pick")} />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {candidates.map((principal) => (
                  <SelectItem
                    key={principal.principalId}
                    value={principal.principalId}
                  >
                    {principalName(principal, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!pick}
              onClick={() => {
                const principalId = pick;
                setPick("");
                void act(() =>
                  putGroupMember(group.groupId, principalId, "member"),
                );
              }}
            >
              {t("sharing.groups.join")}
            </Button>
          </SettingsRow>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              void act(() => deleteGroup(group.groupId)).then((done) => {
                if (done) onClose();
              })
            }
          >
            {t("sharing.groups.delete")}
          </Button>
          <Button type="button" size="sm" onClick={onClose}>
            {t("sharing.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------- 邀请 ---------------------------------- */

function WorkspaceSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (workspaceId: string) => void;
}) {
  const t = useT();
  const workspaces = useWorkspacesQuery();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        className={CONTROL_WIDTH}
        aria-label={t("sharing.workspace")}
      >
        <SelectValue placeholder={t("sharing.workspace")} />
      </SelectTrigger>
      <SelectContent className="z-[var(--z-dialog)]">
        {(workspaces.data ?? []).map((workspace) => (
          <SelectItem key={workspace.id} value={workspace.id}>
            {workspace.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Invitations() {
  const t = useT();
  const act = useAct();
  const workspaces = useWorkspacesQuery();
  const invitations = useQuery({
    queryKey: ["accounts", "invitations"],
    queryFn: listInvitations,
  });
  const [open, setOpen] = React.useState(false);
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [role, setRole] = React.useState<ShareRole>("viewer");
  const [link, setLink] = React.useState("");
  const now = Date.now();
  const pending = (invitations.data ?? []).filter(
    (invitation) =>
      invitation.consumedAtMs === 0 && invitation.expiresAtMs > now,
  );
  const workspaceName = (id: string) =>
    workspaces.data?.find((workspace) => workspace.id === id)?.name ?? id;
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  return (
    <SettingsGroup title={t("sharing.invites")}>
      {pending.map((invitation) => (
        <SettingsRow
          key={invitation.invitationId}
          label={`${workspaceName(invitation.targetWorkspaceId)} · ${t(`sharing.role.${invitation.role}`)}`}
        >
          <span className="text-[12px] text-muted-foreground">
            {t("sharing.invites.expires", {
              time: format.format(invitation.expiresAtMs),
            })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              void act(() => revokeInvitation(invitation.invitationId))
            }
          >
            {t("sharing.invites.revoke")}
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow label={null}>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            setLink("");
            setOpen(true);
          }}
        >
          {t("sharing.invites.create")}
        </Button>
      </SettingsRow>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="z-[var(--z-dialog)] sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t("sharing.invites.create")}</DialogTitle>
          </DialogHeader>
          <div className="settings-group divide-y divide-border/60 rounded-lg border border-border/70 bg-card">
            <SettingsRow label={t("sharing.workspace")}>
              <WorkspaceSelect value={workspaceId} onChange={setWorkspaceId} />
            </SettingsRow>
            <SettingsRow label={t("sharing.role")}>
              <RoleSelect
                value={role}
                onChange={setRole}
                label={t("sharing.role")}
              />
            </SettingsRow>
          </div>
          {link && (
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label={t("sharing.invites.link")}
                value={link}
                onFocus={(event) => event.target.select()}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(link)
                    .then(() => toast.success(t("sharing.invites.copied")))
                }
              >
                {t("sharing.invites.copy")}
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              disabled={!workspaceId}
              onClick={() =>
                void act(async () => {
                  const issued = await issueInvitation({
                    role,
                    targetWorkspaceId: workspaceId,
                  });
                  setLink(invitationLink(issued.token));
                })
              }
            >
              {t("sharing.invites.generate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

/* ---------------------------------- 共享 ---------------------------------- */

function Sharing() {
  const t = useT();
  const act = useAct();
  const workspaces = useWorkspacesQuery();
  const principals = usePrincipals();
  const groups = useGroups();
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [role, setRole] = React.useState<ShareRole>("viewer");
  const selected = workspaceId || workspaces.data?.[0]?.id || "";
  const grants = useQuery({
    queryKey: ["accounts", "grants", selected],
    queryFn: () => listGrants(selected),
    enabled: selected !== "",
  });

  const subjectName = (kind: "principal" | "group", id: string) => {
    if (kind === "group") {
      const group = groups.data?.find((value) => value.groupId === id);
      return t("sharing.share.group", { name: group?.name ?? id });
    }
    return principalName(
      principals.data?.find((value) => value.principalId === id),
      t,
    );
  };

  // 选项值带上主体的种类：成员与组的标识长得一样（32 位十六进制）。
  const options = [
    ...(principals.data ?? [])
      .filter((value) => value.kind !== "owner" && value.disabledAtMs === 0)
      .map((value) => ({
        value: `principal:${value.principalId}`,
        label: principalName(value, t),
      })),
    ...(groups.data ?? []).map((value) => ({
      value: `group:${value.groupId}`,
      label: t("sharing.share.group", { name: value.name }),
    })),
  ];

  return (
    <SettingsGroup title={t("sharing.share")}>
      <SettingsRow label={t("sharing.workspace")}>
        <WorkspaceSelect value={selected} onChange={setWorkspaceId} />
      </SettingsRow>
      {grants.data?.length === 0 && (
        <SettingsRow label={t("sharing.share.none")} />
      )}
      {(grants.data ?? []).map((grant) => (
        <SettingsRow
          key={grant.grantId}
          label={subjectName(grant.subjectKind, grant.subjectId)}
        >
          <RoleSelect
            value={grant.role}
            label={t("sharing.role")}
            onChange={(next) =>
              void act(() =>
                putGrant({
                  workspaceId: selected,
                  subjectKind: grant.subjectKind,
                  subjectId: grant.subjectId,
                  role: next,
                }),
              )
            }
          />
          <IconButton
            label={t("sharing.share.remove")}
            onClick={() =>
              void act(() =>
                revokeGrant({
                  workspaceId: selected,
                  subjectKind: grant.subjectKind,
                  subjectId: grant.subjectId,
                }),
              )
            }
          >
            <Trash2 />
          </IconButton>
        </SettingsRow>
      ))}
      {selected && (
        <SettingsRow label={null}>
          <Select value={subject} onValueChange={setSubject}>
            <SelectTrigger
              size="sm"
              className={CONTROL_WIDTH}
              aria-label={t("sharing.share.subject")}
            >
              <SelectValue placeholder={t("sharing.share.subject")} />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <RoleSelect
            value={role}
            onChange={setRole}
            label={t("sharing.role")}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!subject}
            onClick={() => {
              const [kind, id] = subject.split(":") as [
                "principal" | "group",
                string,
              ];
              setSubject("");
              void act(() =>
                putGrant({
                  workspaceId: selected,
                  subjectKind: kind,
                  subjectId: id,
                  role,
                }),
              );
            }}
          >
            {t("sharing.share.add")}
          </Button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
