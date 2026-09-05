import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContextUsage } from "@armadra/shared";
import { runtimeApi } from "@/api/client";
import { onWorkspaceEvent, onWorkspaceConnection } from "@/api/events";

export interface ContextBinding {
  workspaceId: string | null;
  nodeId: string;
  sessionId: string | null;
  generation: number | null;
  modelSelection?: string | null;
  enabled?: boolean;
}

export function useContextUsage(binding: ContextBinding) {
  const {
    workspaceId,
    nodeId,
    sessionId,
    generation,
    modelSelection,
    enabled = true,
  } = binding;
  const client = useQueryClient();
  const [connectionUnavailable, setConnectionUnavailable] =
    React.useState(false);
  const key = React.useMemo(
    () => [
      "context-usage",
      workspaceId,
      nodeId,
      sessionId,
      generation,
      modelSelection ?? null,
    ],
    [workspaceId, nodeId, sessionId, generation, modelSelection],
  );
  const previous = React.useRef<{
    identity: string;
    model: string | null;
    revision: string | null;
    floor: string | null;
    baselineNeeded: boolean;
  }>({
    identity: "",
    model: null,
    revision: null,
    floor: null,
    baselineNeeded: false,
  });
  const identity = JSON.stringify([workspaceId, nodeId, sessionId, generation]);
  if (previous.current.identity !== identity) {
    previous.current = {
      identity,
      model: modelSelection ?? null,
      revision: null,
      floor: null,
      baselineNeeded: false,
    };
  } else if (previous.current.model !== (modelSelection ?? null)) {
    previous.current = {
      ...previous.current,
      model: modelSelection ?? null,
      floor: previous.current.revision,
      baselineNeeded: previous.current.revision === null,
    };
  }
  const query = useQuery({
    queryKey: key,
    enabled:
      enabled &&
      workspaceId !== null &&
      sessionId !== null &&
      generation !== null,
    queryFn: ({ signal }) =>
      runtimeApi.contextUsage(
        workspaceId!,
        nodeId,
        {
          sessionId: sessionId!,
          generation: generation!,
          modelId: modelSelection ?? null,
        },
        signal,
      ),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  React.useEffect(
    () =>
      onWorkspaceEvent("agent.context", (event) => {
        if (
          event.nodeId === nodeId &&
          event.sessionId === sessionId &&
          event.generation === generation
        ) {
          void client.invalidateQueries({ queryKey: key, exact: true });
        }
      }),
    [client, key, nodeId, sessionId, generation],
  );
  React.useEffect(() => {
    let active = true;
    let connectionRevision = 0;
    setConnectionUnavailable(false);
    const off = onWorkspaceConnection((eventWorkspaceId, connected) => {
      if (eventWorkspaceId !== workspaceId) return;
      const revision = ++connectionRevision;
      setConnectionUnavailable(true);
      if (connected) {
        void client
          .invalidateQueries({ queryKey: key, exact: true })
          .finally(() => {
            if (active && revision === connectionRevision)
              setConnectionUnavailable(false);
          });
      }
    });
    return () => {
      active = false;
      off();
    };
  }, [client, key, workspaceId]);
  const data = query.data as ContextUsage | undefined;
  let usage: ContextUsage | null =
    enabled &&
    !connectionUnavailable &&
    !query.isError &&
    data?.nodeId === nodeId &&
    data.sessionId === sessionId &&
    data.generation === generation
      ? data
      : null;
  // An estimated reading carries no revision: it is recomputed from the
  // transcript on every request, so there is no in-flight report from the old
  // model to fence off and no baseline to establish.
  if (usage && usage.sourceRevision === null) {
    previous.current.baselineNeeded = false;
    previous.current.floor = null;
  } else if (usage && previous.current.baselineNeeded) {
    previous.current.floor = usage.sourceRevision;
    previous.current.baselineNeeded = false;
    usage = null;
  }
  if (usage?.sourceRevision && previous.current.floor) {
    try {
      if (BigInt(usage.sourceRevision) <= BigInt(previous.current.floor))
        usage = null;
    } catch {
      usage = null;
    }
  }
  if (usage?.sourceRevision) previous.current.revision = usage.sourceRevision;
  return {
    usage,
    unavailableReason: !enabled
      ? ("unsupported" as const)
      : query.isError || connectionUnavailable
        ? ("source_unavailable" as const)
        : previous.current.floor
          ? ("session_changed" as const)
          : ("awaiting_report" as const),
  };
}
