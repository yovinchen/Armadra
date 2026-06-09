import { useQuery } from "@tanstack/react-query";
import { runtimeApi } from "../api/client";

export interface GatewayView {
  enabled: boolean;
  port: number;
  glyph: string;
  /** Maps to a `topbar-pill--*` / colour token class. */
  tone: "muted" | "info";
  /** i18n key for the state text. */
  labelKey: string;
  known: boolean;
}

const DEFAULT_PORT = 7420;

/**
 * The gateway is reserved for a later milestone (plan §1.4): the UI shows its
 * state everywhere but must never claim online devices.
 */
export function useGatewayState(workspaceId?: string): GatewayView {
  const gateway = useQuery({
    queryKey: ["gateway", workspaceId ?? null],
    queryFn: () => runtimeApi.gatewayStatus(workspaceId),
    refetchInterval: 30_000,
    retry: false,
  });
  const enabled = gateway.data?.enabled ?? false;
  return {
    enabled,
    port: gateway.data?.port ?? DEFAULT_PORT,
    glyph: enabled ? "⇄" : "⊘",
    tone: enabled ? "info" : "muted",
    labelKey: enabled ? "gateway.reserved" : "gateway.off",
    known: gateway.isSuccess,
  };
}
