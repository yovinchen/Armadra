import { DEFAULT_PORT } from "../args";
import { Refusal } from "../collab/refusals";

/**
 * Where a controlled browser may be pointed.
 *
 * Ported from the pre-merge implementation. Pure functions on purpose:
 * a decision takes a URL, the addresses it resolved to and the workspace's
 * policy, and returns an admission or a refusal code. Nothing here needs a
 * browser, so every rule is testable without one.
 *
 * ## Why the check runs more than once
 *
 * Checking only the URL a caller typed leaves the redirect chain unchecked:
 * `http://example.test/go` may answer `302 http://169.254.169.254/`, and the
 * browser follows it without asking anybody. Every hop of a document request
 * therefore comes back through {@link admitDocument}. Sub-resources get the
 * cheap check in {@link admitSubresource}, which costs no DNS.
 *
 * ## What this does not claim
 *
 * The addresses resolved here are not necessarily the ones the guest will
 * connect to. A name that answers differently on the second lookup (DNS
 * rebinding) defeats the check, and that is a stated limit rather than a
 * solved problem.
 */

export type LoopbackPorts =
  /** Anything except the reserved ones. */
  | { readonly kind: "any" }
  /** Only these, and still never the reserved ones. */
  | { readonly kind: "listed"; readonly ports: readonly number[] };

export type PopupPolicy = "tab" | "block";

/**
 * What a workspace lets its browser nodes reach.
 *
 * Private networks are allowed by default because looking at a device or a
 * colleague's dev server on the LAN is an ordinary thing to want; loopback is
 * open apart from Armadra's own ports, because the whole point of a browser
 * node is the project's dev server.
 */
export interface NetworkPolicy {
  readonly allowPrivateNetworks: boolean;
  readonly loopbackPorts: LoopbackPorts;
  /**
   * What happens to a window the page opens itself. `tab` adopts it as a tab
   * of the same session — where the address policy still applies to its first
   * document request — and `block` closes it on sight.
   */
  readonly popups: PopupPolicy;
}

export function defaultNetworkPolicy(): NetworkPolicy {
  return {
    allowPrivateNetworks: true,
    loopbackPorts: { kind: "any" },
    popups: "tab",
  };
}

/**
 * The answer, with a stable code the client localizes. A refusal never carries
 * the raw reason a resolver gave: the code is the contract.
 */
export type Admission =
  | { readonly kind: "admit" }
  | { readonly kind: "refuse"; readonly code: string };

export const ADMIT: Admission = { kind: "admit" };

export function refuse(code: string): Admission {
  return { kind: "refuse", code };
}

export function isAdmitted(admission: Admission): boolean {
  return admission.kind === "admit";
}

export function reasonCode(admission: Admission): string {
  return admission.kind === "admit" ? "" : admission.code;
}

/**
 * The core and the hook surface. A browser node exists to look at the
 * project's dev server, not at the app that is driving it.
 */
export const RESERVED_LOOPBACK_PORTS: readonly number[] = [
  DEFAULT_PORT,
  DEFAULT_PORT + 1,
];

/**
 * Cloud instance metadata: reachable from every VM, and it hands out
 * credentials to whatever asks.
 */
const METADATA_HOSTS: readonly string[] = [
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "fd00:ec2::254",
];

/** The address, scheme and port a URL names, before anything is resolved. */
export interface UrlTarget {
  readonly scheme: string;
  readonly host: string;
  readonly port?: number;
}

export function isLoopbackName(target: UrlTarget): boolean {
  return isLoopbackHost(target.host);
}

/** The port a connection would actually use. */
export function effectivePort(target: UrlTarget): number {
  return target.port ?? (target.scheme === "https" ? 443 : 80);
}

/**
 * Splits a URL far enough to judge it. `undefined` for anything that is not an
 * absolute http/https URL — `data:`, `blob:`, `about:` and friends are judged
 * by their scheme alone and never reach here.
 */
export function parseTarget(url: string): UrlTarget | undefined {
  const separator = url.indexOf("://");
  if (separator < 0) return undefined;
  const scheme = url.slice(0, separator).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return undefined;
  const rest = url.slice(separator + 3);
  const authority = (rest.split(/[/?#]/)[0] ?? "")
    .split("@")
    .slice(-1)[0]!
    .toLowerCase();
  const split = splitAuthority(authority);
  if (split.host === "") return undefined;
  return split.port === undefined
    ? { scheme, host: split.host }
    : { scheme, host: split.host, port: split.port };
}

/**
 * The cheap check: no name resolution, so it can run on every sub-resource
 * without turning one page load into hundreds of lookups.
 */
export function admitSubresource(url: string): Admission {
  const target = parseTarget(url);
  // Not http(s): either a scheme the browser handles internally (`data:`,
  // `blob:`) or one this module does not admit as navigation. Sub-resources
  // are not the place to police that.
  if (target === undefined) return ADMIT;
  return admitTarget(target);
}

/**
 * The full check for one document request — the top-level navigation, an
 * iframe's document, a popup's first request, and **every redirect hop**.
 *
 * `resolved` is what a lookup of the host produced. An empty list for a name
 * that is not already a literal means the lookup failed, which is refused:
 * admitting an address nobody could resolve would mean admitting whatever the
 * browser resolves it to a moment later.
 */
export function admitDocument(
  url: string,
  resolved: readonly string[],
  policy: NetworkPolicy,
): Admission {
  const target = parseTarget(url);
  if (target === undefined) return refuse("scheme_not_allowed");
  const first = admitTarget(target);
  if (first.kind !== "admit") return first;
  const port = effectivePort(target);
  if (
    policy.loopbackPorts.kind === "listed" &&
    isLoopbackName(target) &&
    !policy.loopbackPorts.ports.includes(port)
  ) {
    return refuse("loopback_port_not_allowed");
  }
  const literal = parseAddress(target.host);
  const addresses =
    literal === undefined
      ? resolved
          .map((value) => parseAddress(value))
          .filter((value): value is Address => value !== undefined)
      : [literal];
  if (addresses.length === 0) return refuse("unresolvable");
  for (const address of addresses) {
    // Link-local covers the metadata addresses under any name, and is never a
    // thing a project legitimately browses.
    if (isLinkLocal(address)) return refuse("link_local_address");
    if (isLoopbackAddress(address)) {
      if (
        policy.loopbackPorts.kind === "listed" &&
        !policy.loopbackPorts.ports.includes(port)
      ) {
        return refuse("loopback_port_not_allowed");
      }
      if (RESERVED_LOOPBACK_PORTS.includes(port))
        return refuse("reserved_port");
      continue;
    }
    if (!policy.allowPrivateNetworks && isPrivate(address)) {
      return refuse("private_network");
    }
  }
  return ADMIT;
}

/** The parts of the decision that need neither the policy nor a resolver. */
function admitTarget(target: UrlTarget): Admission {
  if (METADATA_HOSTS.includes(target.host)) return refuse("metadata_address");
  if (
    isLoopbackName(target) &&
    RESERVED_LOOPBACK_PORTS.includes(effectivePort(target))
  ) {
    return refuse("reserved_port");
  }
  return ADMIT;
}

/**
 * Where a caller may point a session in the first place.
 *
 * Throws a {@link Refusal} because it answers a request directly and the
 * caller sees the message. The per-request checks above are what cover the
 * redirects this one cannot see.
 */
export function admitUrl(raw: string): string {
  const value = raw.trim();
  if (value === "") throw Refusal.badRequest("A URL is required");
  if (value.length > 4_000) throw Refusal.badRequest("That URL is too long");
  // A bare host gets `https://`, but only when it carries no scheme at all:
  // `javascript:` and `data:` have no authority, so treating them as hosts
  // would turn a refusal into `https://javascript:alert(1)`.
  let withScheme: string;
  if (value.includes("://")) {
    withScheme = value;
  } else {
    const colon = value.indexOf(":");
    const prefix = colon < 0 ? "" : value.slice(0, colon);
    const schemeShaped =
      colon >= 0 &&
      /^[A-Za-z][A-Za-z0-9+\-.]*$/.test(prefix) &&
      // `127.0.0.1:5173` is a host and a port, not a scheme.
      !/^[0-9]/.test(value.slice(colon + 1));
    if (schemeShaped) {
      throw Refusal.badRequest("Only http and https addresses can be opened");
    }
    withScheme = `https://${value}`;
  }
  const target = parseTarget(withScheme);
  if (target === undefined) {
    throw Refusal.badRequest("Only http and https addresses can be opened");
  }
  const admission = admitTarget(target);
  if (admission.kind === "admit") return withScheme;
  throw Refusal.forbidden(
    admission.code === "metadata_address"
      ? "Instance metadata addresses cannot be opened"
      : "Armadra's own service ports cannot be opened in a browser node",
  );
}

function splitAuthority(authority: string): {
  host: string;
  port: number | undefined;
} {
  if (authority.startsWith("[")) {
    // IPv6 literal: the port, if any, follows the closing bracket.
    const close = authority.indexOf("]", 1);
    if (close < 0) return { host: authority, port: undefined };
    const tail = authority.slice(close + 1);
    return {
      host: authority.slice(1, close),
      port: tail.startsWith(":") ? parsePort(tail.slice(1)) : undefined,
    };
  }
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return { host: authority, port: undefined };
  return {
    host: authority.slice(0, colon),
    port: parsePort(authority.slice(colon + 1)),
  };
}

/** Strictly a `u16`, exactly as the Rust `parse::<u16>()` this replaces. */
function parsePort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const port = Number.parseInt(value, 10);
  return port <= 65_535 ? port : undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/* ------------------------------- addresses -------------------------------- */

/**
 * One parsed IP literal. Node has no `IpAddr`, and pulling in a dependency to
 * answer four range questions would be more surface than the questions are
 * worth.
 */
export type Address =
  | { readonly version: 4; readonly octets: readonly number[] }
  | { readonly version: 6; readonly segments: readonly number[] };

export function parseAddress(value: string): Address | undefined {
  if (value.includes(":")) return parseV6(value);
  return parseV4(value);
}

function parseV4(value: string): Address | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return undefined;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return { version: 4, octets };
}

/** `::`-compressed IPv6, including the `::ffff:1.2.3.4` tail form. */
function parseV6(value: string): Address | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const expand = (text: string): number[] | undefined => {
    if (text === "") return [];
    const groups: number[] = [];
    const parts = text.split(":");
    for (const [index, part] of parts.entries()) {
      if (part.includes(".")) {
        // Only the final group may be a dotted-quad tail.
        if (index !== parts.length - 1) return undefined;
        const v4 = parseV4(part);
        if (v4 === undefined || v4.version !== 4) return undefined;
        groups.push(
          (v4.octets[0]! << 8) | v4.octets[1]!,
          (v4.octets[2]! << 8) | v4.octets[3]!,
        );
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const head = expand(halves[0] ?? "");
  if (head === undefined) return undefined;
  if (halves.length === 1) {
    return head.length === 8 ? { version: 6, segments: head } : undefined;
  }
  const tail = expand(halves[1] ?? "");
  if (tail === undefined) return undefined;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return undefined;
  return {
    version: 6,
    segments: [...head, ...Array<number>(gap).fill(0), ...tail],
  };
}

export function isLoopbackAddress(address: Address): boolean {
  if (address.version === 4) return address.octets[0] === 127;
  return (
    address.segments.slice(0, 7).every((segment) => segment === 0) &&
    address.segments[7] === 1
  );
}

export function isLinkLocal(address: Address): boolean {
  if (address.version === 4) {
    return address.octets[0] === 169 && address.octets[1] === 254;
  }
  // `fe80::/10` plus the IPv6 metadata address's own `fd00:ec2::254`, which is
  // unique-local rather than link-local but serves the same credential
  // endpoint.
  const segments = address.segments;
  if ((segments[0]! & 0xffc0) === 0xfe80) return true;
  return (
    segments[0] === 0xfd00 &&
    segments[1] === 0x0ec2 &&
    segments[2] === 0 &&
    segments[3] === 0 &&
    segments[7] === 0x254
  );
}

export function isPrivate(address: Address): boolean {
  if (address.version === 4) {
    const [a, b] = [address.octets[0]!, address.octets[1]!];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return a === 192 && b === 168;
  }
  // Unique local addresses, `fc00::/7`.
  return (address.segments[0]! & 0xfe00) === 0xfc00;
}

/* --------------------------------- paths ---------------------------------- */

/**
 * Where a capture or an accepted download lands. Both live under `.armadra/`
 * so they are inside the project an agent can already read, and out of the way
 * of the project's own tree.
 *
 * The write itself happens in the shell, which resolves this against the
 * workspace root it is handed and enforces the jail there. This side names the
 * convention; neither half is sufficient alone.
 */
export function captureDir(root: string): string {
  return `${root}/.armadra/browser`;
}

export function downloadDir(root: string): string {
  return `${root}/.armadra/downloads`;
}

/** A page-supplied filename reduced to one safe path segment. */
export function safeFilename(raw: string): string {
  const trimmed = trimDots(raw.trim());
  let cleaned = "";
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    const control = code <= 0x1f || code === 0x7f;
    cleaned += control || '/\\:*?"<>|'.includes(character) ? "_" : character;
  }
  cleaned = trimDots(cleaned).trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "download";
  const characters = [...cleaned];
  return characters.length > 120 ? characters.slice(0, 120).join("") : cleaned;
}

/** `str::trim_matches('.')` — every leading and trailing dot, not just one. */
function trimDots(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ".") start += 1;
  while (end > start && value[end - 1] === ".") end -= 1;
  return value.slice(start, end);
}
