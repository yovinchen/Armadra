import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  ExecutionHost,
  ExecutionHostBlocker,
  ExecutionHostRefusal,
  Workspace,
} from "@armadra/shared";

import { executionHostRefusal, runtimeApi } from "../../../../api/client";
import { useT } from "../../../../app/preferences-store";
import { useCanvasStore } from "../../../../store/canvas-store";
import { SettingsGroup } from "../../SettingsGroup";
import { SettingsRow } from "../../SettingsRow";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/**
 * 把当前工作区改绑到另一台执行主机（远端补全设计 §3.3）。
 *
 * 改绑，不是搬文件——搬文件是用户拿 Git 做的事。所以这里要用户自己填出目标
 * 机器上的项目路径，Runtime 再比对两边的 `HEAD` 与顶层目录，不一致就拒绝。
 *
 * 两种拒绝对应两种下一步，所以分开显示：
 *
 *  - **还有东西占着旧主机**：逐条列出来。终端和浏览器会话可以由「停止并
 *    切换」结束掉；编辑器草稿和进行中的 Git 操作不行——那是重开一个节点找不
 *    回来的东西，得用户自己处理。
 *  - **目标目录不是同一个项目**：把两边的指纹摆出来，由人判断要不要强制。
 */
export function SwitchExecutionHost({
  workspace,
  hosts,
  onDone,
}: {
  workspace: Workspace;
  hosts: ExecutionHost[];
  onDone: () => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const setWorkspace = useCanvasStore((state) => state.setWorkspace);
  const [target, setTarget] = React.useState(workspace.executionHostId ?? "");
  const [rootPath, setRootPath] = React.useState(workspace.rootPath);
  const [refusal, setRefusal] = React.useState<ExecutionHostRefusal | null>(
    null,
  );

  const switchHost = useMutation({
    mutationFn: (options: { stopBlockers?: boolean; force?: boolean }) =>
      runtimeApi.switchExecutionHost(workspace.id, {
        executionHostId: target,
        rootPath,
        ...options,
      }),
    onSuccess: (updated) => {
      setRefusal(null);
      // 改绑只动两个字段；画布持有的工作区还带着它自己的看板列表，
      // 整个替换会把那份列表换成一个没有看板的对象。
      setWorkspace({
        ...workspace,
        executionHostId: updated.executionHostId,
        rootPath: updated.rootPath,
      });
      // 这个工作区的每一个读都换了一台机器，所以整片缓存重取，而不是补丁。
      void client.invalidateQueries();
      toast.success(
        t("executionHosts.switch.done", {
          name: hostName(hosts, updated.executionHostId ?? "", t),
        }),
      );
      onDone();
    },
    onError: (cause: Error) => {
      const structured = executionHostRefusal(cause);
      setRefusal(structured);
      // 停掉的东西即使最后没切成也真的停了：不说的话，用户会以为什么都没发生。
      if (structured?.stopped.length) {
        toast.warning(
          t("executionHosts.switch.stopped", {
            count: structured.stopped.length,
          }),
        );
      }
      if (!structured) {
        toast.error(t("executionHosts.switch.failed"), {
          description: cause.message,
        });
      }
    },
  });

  // 「停止并切换」只对那些真的能被停掉的东西有意义。草稿和 Git 操作留在列表
  // 里，按钮就不给——给了也只是再撞一次同一堵墙。
  const stoppable =
    refusal?.code === "switch_blocked" &&
    refusal.blockers.every(
      (blocker) => blocker.kind === "terminal" || blocker.kind === "browser",
    );

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("executionHosts.switch.target")}>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="sm" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {hosts.map((host) => (
                <SelectItem
                  key={host.executionHostId || "local"}
                  value={host.executionHostId}
                >
                  {host.kind === "local"
                    ? t("executionHosts.local")
                    : host.name || host.executionHostId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t("executionHosts.switch.rootPath")}>
          <Input
            value={rootPath}
            spellCheck={false}
            className="h-8 w-[280px] text-[12px]"
            aria-label={t("executionHosts.switch.rootPath")}
            onChange={(event) => setRootPath(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow label={null}>
          <Button size="sm" variant="ghost" onClick={onDone}>
            {t("executionHosts.switch.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={switchHost.isPending || rootPath.trim() === ""}
            onClick={() => switchHost.mutate({})}
          >
            {t("executionHosts.switch.confirm")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {refusal?.code === "switch_blocked" && (
        <SettingsGroup title={t("executionHosts.switch.blocked")}>
          {refusal.blockers.map((blocker, index) => (
            <SettingsRow
              key={`${blocker.kind}-${blocker.detail}-${index}`}
              label={blockerLabel(blocker, t)}
              footnote={blocker.detail}
            />
          ))}
          {stoppable && (
            <SettingsRow label={null}>
              <Button
                size="sm"
                variant="destructive"
                disabled={switchHost.isPending}
                onClick={() => switchHost.mutate({ stopBlockers: true })}
              >
                {t("executionHosts.switch.stop")}
              </Button>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}

      {refusal?.code === "root_mismatch" && (
        <SettingsGroup title={t("executionHosts.switch.mismatch")}>
          <SettingsRow
            label={workspace.rootPath}
            footnote={fingerprint(refusal.from, t)}
          />
          <SettingsRow label={rootPath} footnote={fingerprint(refusal.to, t)} />
          <SettingsRow label={null}>
            <Button
              size="sm"
              variant="destructive"
              disabled={switchHost.isPending}
              onClick={() => switchHost.mutate({ force: true })}
            >
              {t("executionHosts.switch.force")}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      )}
    </>
  );
}

function blockerLabel(
  blocker: ExecutionHostBlocker,
  t: (key: string) => string,
): string {
  // 未知的 kind 显示原键：新加一种阻塞项时，界面宁可露出一个英文键，
  // 也不要把它悄悄归到别的类别里。
  const key = `executionHosts.blocker.${blocker.kind}`;
  const label = t(key);
  return label === key ? blocker.kind : label;
}

function fingerprint(
  print: ExecutionHostRefusal["from"],
  t: (key: string, values: Record<string, string | number>) => string,
): string {
  if (!print) return "";
  return t("executionHosts.switch.fingerprint", {
    head: print.head ? print.head.slice(0, 12) : "—",
    count: print.entryCount,
  });
}

function hostName(
  hosts: ExecutionHost[],
  id: string,
  t: (key: string) => string,
): string {
  const host = hosts.find((entry) => entry.executionHostId === id);
  if (!host || host.kind === "local") return t("executionHosts.local");
  return host.name || id;
}
