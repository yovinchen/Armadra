import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SshHost } from "@armadra/shared";

import { runtimeApi } from "../../api/client";
import { useAccess } from "../../app/use-access";

/**
 * `settings.ssh.hosts[]` 的共享读取（§21）。
 *
 * 和设置页用同一个 `["settings"]` 查询键：在设置里加完主机，添加菜单与命令
 * 面板下一帧就能看到，不需要各自轮询。Runtime 已经在 `normalize` 里丢掉了
 * 校验不过的条目，所以这里拿到的每一条都能直接建终端。
 */
export function useSshHosts(): SshHost[] {
  // SSH 主机是本机管理：服务器壳上的成员读不到（403），菜单里也就没有它们。
  const member = useAccess().member;
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: runtimeApi.settings,
    retry: false,
    staleTime: 30_000,
    enabled: !member,
  });
  const hosts = settings.data?.ssh?.hosts;
  // 引用要稳：`buildAddMenu` 的 `useMemo` 以它为依赖。
  return useMemo(() => hosts ?? [], [hosts]);
}

/** 列表第二列与节点 chip 的副标题：`user@host:port`。 */
export function sshHostTarget(host: SshHost): string {
  const user = host.user ? `${host.user}@` : "";
  const port = host.port === undefined ? "" : `:${host.port}`;
  return `${user}${host.host}${port}`;
}
