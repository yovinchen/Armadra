import { useCallback, useEffect, useRef, useState } from "react";

import type { IdentityHello } from "../api/identity";
import { hostErrorKey, probeHost, type HostProbe } from "./connection";

export type HostConnectionState =
  | { status: "idle"; cancelled?: boolean }
  | { status: "checking" }
  | { status: "connected"; hello: IdentityHello }
  | { status: "error"; messageKey: string };

export function useHostConnection(probe: HostProbe = probeHost) {
  const [state, setState] = useState<HostConnectionState>({ status: "idle" });
  const active = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    const previous = active.current;
    active.current = null;
    previous?.abort();
  }, []);
  useEffect(() => invalidate, [invalidate]);

  const cancel = useCallback(() => {
    invalidate();
    setState({ status: "idle", cancelled: true });
  }, [invalidate]);

  const check = useCallback(async () => {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setState({ status: "checking" });
    try {
      const hello = await probe(request.signal);
      if (active.current === request) setState({ status: "connected", hello });
    } catch (error) {
      if (active.current === request)
        setState({ status: "error", messageKey: hostErrorKey(error) });
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [probe]);

  return { state, check, cancel };
}
