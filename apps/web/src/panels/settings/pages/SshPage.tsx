import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderInput, PlugZap, Plus, ServerCog } from "lucide-react";
import { toast } from "sonner";
import { sshHostSchema, type SshHost } from "@armadra/shared";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { sshHostTarget } from "../ssh-hosts";
import { useSubpage } from "../subpage";
import { useRuntimeSettings } from "../use-runtime-settings";
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
import { Input } from "@/ui/input";

/**
 * 设置 → SSH（§21 + §24.1）。
 *
 * 主机表存在 Runtime 的 `settings.json` 里，这里只做「读整段、改一条、写整段」
 * ——PATCH 对数组是整段替换，所以删除也是发一份新数组。校验用的是
 * `sshHostSchema`（与 `terminal/ssh.rs` 同一套规则），不合法就不允许保存，
 * 免得 Runtime 静默丢掉这条主机。
 *
 * 编辑不再叠一层对话框：点一行推入右栏内的子页，删除放在子页页尾。
 */
export function SshPage() {
  const t = useT();
  const subpage = useSubpage();
  const { settings, save } = useRuntimeSettings();
  const hosts = React.useMemo(
    () => settings.data?.ssh?.hosts ?? [],
    [settings.data],
  );

  const test = useMutation({
    mutationFn: (hostId: string) => runtimeApi.testSshHost(hostId),
    onSuccess: (result) => {
      const description = result.output.trim();
      if (result.ok) toast.success(t("ssh.test.ok"), ...describe(description));
      else toast.error(t("ssh.test.failed"), ...describe(description));
    },
    onError: (cause: Error) =>
      toast.error(t("ssh.test.failed"), { description: cause.message }),
  });

  // Reachable over `ssh` and "the Armadra Worker is installed there and is
  // this build" are different questions, so they are different buttons.
  const probe = useMutation({
    mutationFn: (hostId: string) => runtimeApi.testRemoteWorker(hostId),
    onSuccess: (result) =>
      toast.success(
        t("ssh.worker.ok", {
          version: result.runtimeVersion,
          platform: result.platform,
          architecture: result.architecture,
        }),
      ),
    onError: (cause: Error) =>
      toast.error(t("ssh.worker.failed"), { description: cause.message }),
  });

  function write(next: SshHost[]) {
    save.mutate({ ssh: { hosts: next } });
    subpage.close();
  }

  if (subpage.current?.startsWith("ssh:")) {
    const reference = subpage.current.slice("ssh:".length);
    const existing = hosts.find((host) => host.id === reference);
    return (
      <HostForm
        existing={existing}
        disabled={!settings.data}
        onSubmit={(host) =>
          write(
            existing
              ? hosts.map((entry) => (entry.id === host.id ? host : entry))
              : [...hosts, host],
          )
        }
        onDelete={() =>
          write(hosts.filter((entry) => entry.id !== existing?.id))
        }
        onCancel={subpage.close}
      />
    );
  }

  return (
    <SettingsGroup>
      {hosts.map((host) => (
        <SettingsRow
          key={host.id}
          label={host.name}
          onClick={() => subpage.open("ssh", host.id)}
        >
          <span className="text-[11px] text-muted-foreground">
            {sshHostTarget(host)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate(host.id)}
          >
            <PlugZap />
            {t("ssh.test")}
          </Button>
          {host.worker && (
            <Button
              variant="secondary"
              size="sm"
              disabled={probe.isPending}
              onClick={() => probe.mutate(host.id)}
            >
              <ServerCog />
              {t("ssh.worker.test")}
            </Button>
          )}
        </SettingsRow>
      ))}

      {hosts
        .filter((host) => host.worker)
        .map((host) => (
          <OpenRemoteProject key={`open-${host.id}`} host={host} />
        ))}

      {hosts.length === 0 && <SettingsRow label={t("ssh.empty")} />}

      <SettingsRow label={null}>
        <Button
          variant="secondary"
          size="sm"
          disabled={!settings.data}
          onClick={() => subpage.open("ssh", "new")}
        >
          <Plus />
          {t("ssh.add")}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * 在执行主机上打开一个项目（H02）。
 *
 * 路径是那台机器上的路径，本机不做任何解析：Runtime 通过远端 Worker 的根注册
 * 把它规范化并冻结，主机不可达或 Worker 不匹配时这里失败，而不是悄悄打开一个
 * 读本机文件的工作区。
 */
function OpenRemoteProject({ host }: { host: SshHost }) {
  const t = useT();
  const client = useQueryClient();
  const [path, setPath] = React.useState("");
  const open = useMutation({
    mutationFn: (rootPath: string) =>
      runtimeApi.openRemoteWorkspace({
        name: rootPath.split("/").filter(Boolean).at(-1) ?? host.name,
        executionHostId: host.id,
        rootPath,
      }),
    onSuccess: (workspace) => {
      setPath("");
      void client.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success(t("ssh.remote.opened", { name: workspace.name }));
    },
    onError: (cause: Error) =>
      toast.error(t("ssh.remote.failed"), { description: cause.message }),
  });
  return (
    <SettingsRow label={`${host.name} · ${t("ssh.remote.path")}`}>
      <Input
        className="h-8 w-[280px] text-xs"
        aria-label={t("ssh.remote.path")}
        placeholder="/srv/project"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={open.isPending || path.trim().length === 0}
        onClick={() => open.mutate(path.trim())}
      >
        <FolderInput />
        {t("ssh.remote.open")}
      </Button>
    </SettingsRow>
  );
}

/** `ssh` 什么都没说时不给 Toast 挂一个空的说明行。 */
function describe(output: string): [{ description: string }] | [] {
  return output.length > 0 ? [{ description: output }] : [];
}

/* --------------------------------- 编辑子页 -------------------------------- */

interface HostForm {
  name: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
  extraArgs: string;
  /** Where the Armadra Worker is on the far end; empty = terminals only. */
  workerPath: string;
  workerStateDir: string;
}

const EMPTY: HostForm = {
  name: "",
  host: "",
  user: "",
  port: "",
  identityFile: "",
  extraArgs: "",
  workerPath: "",
  workerStateDir: "",
};

function toForm(host: SshHost | undefined): HostForm {
  if (!host) return EMPTY;
  return {
    name: host.name,
    host: host.host,
    user: host.user ?? "",
    port: host.port === undefined ? "" : String(host.port),
    identityFile: host.identityFile ?? "",
    extraArgs: (host.extraArgs ?? []).join(" "),
    workerPath: host.worker?.path ?? "",
    workerStateDir: host.worker?.stateDir ?? "",
  };
}

/**
 * 表单 → 主机。空字符串代表「没填」，要整个字段省掉而不是发空串；
 * 额外参数按空白切分，因为命令是 argv，一个参数就是一个元素。
 */
export function parseHostForm(form: HostForm, id: string): SshHost | null {
  const extraArgs = form.extraArgs.trim().split(/\s+/).filter(Boolean);
  const candidate = {
    id,
    name: form.name.trim(),
    host: form.host.trim(),
    ...(form.user.trim() ? { user: form.user.trim() } : {}),
    ...(form.port.trim() ? { port: Number(form.port) } : {}),
    ...(form.identityFile.trim()
      ? { identityFile: form.identityFile.trim() }
      : {}),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
    // No Worker path means this host runs terminals and nothing else, which
    // is a different thing from a Worker at an empty path.
    ...(form.workerPath.trim()
      ? {
          worker: {
            path: form.workerPath.trim(),
            ...(form.workerStateDir.trim()
              ? { stateDir: form.workerStateDir.trim() }
              : {}),
          },
        }
      : {}),
  };
  const parsed = sshHostSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function HostForm({
  existing,
  disabled,
  onSubmit,
  onDelete,
  onCancel,
}: {
  existing: SshHost | undefined;
  disabled: boolean;
  onSubmit: (host: SshHost) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [form, setForm] = React.useState<HostForm>(() => toForm(existing));
  const [pendingDelete, setPendingDelete] = React.useState(false);

  const fields: Array<{ key: keyof HostForm; label: string }> = [
    { key: "name", label: t("ssh.field.name") },
    { key: "host", label: t("ssh.field.host") },
    { key: "user", label: t("ssh.field.user") },
    { key: "port", label: t("ssh.field.port") },
    { key: "identityFile", label: t("ssh.field.identity") },
    { key: "extraArgs", label: t("ssh.field.extraArgs") },
    { key: "workerPath", label: t("ssh.field.workerPath") },
    { key: "workerStateDir", label: t("ssh.field.workerStateDir") },
  ];

  return (
    <>
      <SettingsGroup>
        {fields.map((field) => (
          <SettingsRow key={field.key} label={field.label}>
            <Input
              className="h-8 w-[280px] text-xs"
              aria-label={field.label}
              value={form[field.key]}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
            />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <div className="flex items-center justify-between gap-2">
        <div>
          {existing && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setPendingDelete(true)}
            >
              {t("ssh.delete")}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("ssh.dialog.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              const host = parseHostForm(
                form,
                existing?.id ?? crypto.randomUUID(),
              );
              if (!host) {
                toast.error(t("ssh.dialog.invalid"));
                return;
              }
              onSubmit(host);
            }}
          >
            {t("ssh.dialog.save")}
          </Button>
        </div>
      </div>

      <AlertDialog open={pendingDelete} onOpenChange={setPendingDelete}>
        <AlertDialogContent className="z-[var(--z-dialog)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ssh.delete.title", { name: existing?.name ?? "" })}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("ssh.dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>
              {t("ssh.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
