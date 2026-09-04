import { useCallback, useEffect, useRef, useState } from "react";
import type { HelloResponse } from "@armadra/host-client";

import {
  hostErrorKey,
  loadHostAddress,
  probeHost,
  rememberHostAddress,
  type HostProbe,
} from "./connection";

export type HostConnectionState =
  | { status: "idle"; cancelled?: boolean }
  | { status: "checking" }
  | { status: "connected"; hello: HelloResponse }
  | { status: "error"; messageKey: string };

export function useHostConnection(probe: HostProbe = probeHost) {
  const [address, setAddress] = useState(loadHostAddress);
  const [state, setState] = useState<HostConnectionState>({ status: "idle" });
  const active = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    const previous = active.current;
    active.current = null;
    previous?.abort();
  }, []);
  useEffect(() => invalidate, [invalidate]);

  const editAddress = useCallback(
    (next: string) => {
      invalidate();
      setAddress(next);
      setState({ status: "idle" });
    },
    [invalidate],
  );

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
      const target = address.trim();
      rememberHostAddress(target);
      setAddress(target);
      const hello = await probe(target, request.signal);
      if (active.current === request) setState({ status: "connected", hello });
    } catch (error) {
      if (active.current === request)
        setState({ status: "error", messageKey: hostErrorKey(error) });
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [address, probe]);

  return { address, state, editAddress, check, cancel };
}
