import {
  HostClient,
  HostClientError,
  type HelloResponse,
} from "@armadra/host-client";

export const DEFAULT_HOST_ADDRESS = "http://127.0.0.1:43121";
export const HOST_ADDRESS_STORAGE_KEY = "armadra.host-check.address.v1";
const CLIENT_ID = "armadra-web-host-check";

export type HostProbe = (
  address: string,
  signal: AbortSignal,
) => Promise<HelloResponse>;

export const probeHost: HostProbe = (address, signal) =>
  new HostClient({ baseUrl: address, clientId: CLIENT_ID }).hello({ signal });

function validateAddress(address: string): void {
  // Construction validates configuration without making any request.
  new HostClient({ baseUrl: address, clientId: CLIENT_ID });
}

export function loadHostAddress(): string {
  try {
    const stored = localStorage.getItem(HOST_ADDRESS_STORAGE_KEY);
    if (stored) {
      try {
        validateAddress(stored);
        return stored;
      } catch {
        localStorage.removeItem(HOST_ADDRESS_STORAGE_KEY);
      }
    }
  } catch {
    /* Browser storage may be disabled. */
  }
  return DEFAULT_HOST_ADDRESS;
}

export function rememberHostAddress(address: string): void {
  validateAddress(address);
  try {
    localStorage.setItem(HOST_ADDRESS_STORAGE_KEY, address);
  } catch {
    /* A failed preference write must not block the connection check. */
  }
}

export function hostErrorKey(error: unknown): string {
  if (!(error instanceof HostClientError)) return "host.error.network";
  switch (error.code) {
    case "INVALID_OPTIONS":
      return "host.error.address";
    case "CANCELLED":
      return "host.status.cancelled";
    case "TIMEOUT":
      return "host.error.timeout";
    case "NETWORK_ERROR":
      return "host.error.network";
    case "RESPONSE_TOO_LARGE":
      return "host.error.tooLarge";
    case "INCOMPATIBLE_PROTOCOL":
      return "host.error.version";
    case "MALFORMED_RESPONSE":
      return "host.error.invalidResponse";
    case "UNEXPECTED_CONTENT_TYPE":
      return "host.error.contentType";
    case "HTTP_ERROR":
      return "host.error.http";
    case "REMOTE_ERROR":
      if (error.hostCode === "UNAUTHENTICATED") return "host.error.auth";
      if (error.hostCode === "PERMISSION_DENIED")
        return "host.error.permission";
      if (error.hostCode === "UNSUPPORTED") return "host.error.unsupported";
      return "host.error.remote";
  }
}
