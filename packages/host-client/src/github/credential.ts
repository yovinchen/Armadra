import {
  ConfigureGithubCredentialRequestSchema,
  GetGithubCredentialRequestSchema,
  GithubCredentialSource,
  GithubCredentialStatusSchema,
  ResolveGithubRepositoryRequestSchema,
  ResolveGithubRepositoryResponseSchema,
  RevokeGithubCredentialRequestSchema,
  create,
  fromBinary,
  toBinary,
  type GithubCredentialStatus,
  type ResolveGithubRepositoryResponse,
} from "@armadra/protocol";

import { type GithubCallContext } from "./context.js";
import { HostGithubError, reject } from "./errors.js";
import { checkCredential, validRepository } from "./validate.js";

/** Never returns a token; only which source is configured and whether it works. */
export function getCredential(
  ctx: GithubCallContext,
): Promise<GithubCredentialStatus> {
  const request = create(GetGithubCredentialRequestSchema, {
    meta: ctx.meta(),
  });
  return ctx.call(
    "GetCredential",
    toBinary(GetGithubCredentialRequestSchema, request),
    false,
    (wire) => checkCredential(fromBinary(GithubCredentialStatusSchema, wire)),
  );
}

/**
 * `token` is the one value that travels outbound, and only for TOKEN_REF.
 * It is not retained here and the Host answers with a status, never an echo.
 */
export function configureCredential(
  ctx: GithubCallContext,
  input: {
    source: GithubCredentialSource;
    token?: string;
    apiBase?: string;
    expectedRevision: bigint;
  },
): Promise<GithubCredentialStatus> {
  const token = input?.token ?? "";
  const needsToken =
    input?.source === GithubCredentialSource.TOKEN_REF && token.length > 0;
  if (
    !input ||
    typeof input.expectedRevision !== "bigint" ||
    input.expectedRevision < 0n ||
    typeof token !== "string" ||
    token.length > 4096 ||
    (input.source === GithubCredentialSource.TOKEN_REF && !needsToken) ||
    (input.source !== GithubCredentialSource.TOKEN_REF && token.length > 0)
  )
    reject("invalid");
  const apiBase = input.apiBase ?? "";
  if (apiBase) {
    let url: URL;
    try {
      url = new URL(apiBase);
    } catch {
      return Promise.reject(new HostGithubError("invalid"));
    }
    if (url.protocol !== "https:" || url.username || url.password)
      reject("invalid");
  }
  const request = create(ConfigureGithubCredentialRequestSchema, {
    meta: ctx.meta(),
    source: input.source,
    token,
    apiBase,
    expectedRevision: input.expectedRevision,
  });
  return ctx.call(
    "ConfigureCredential",
    toBinary(ConfigureGithubCredentialRequestSchema, request),
    true,
    (wire) => checkCredential(fromBinary(GithubCredentialStatusSchema, wire)),
  );
}

export function revokeCredential(
  ctx: GithubCallContext,
  input: {
    expectedRevision: bigint;
  },
): Promise<GithubCredentialStatus> {
  if (
    typeof input?.expectedRevision !== "bigint" ||
    input.expectedRevision <= 0n
  )
    reject("invalid");
  const request = create(RevokeGithubCredentialRequestSchema, {
    meta: ctx.meta(),
    expectedRevision: input.expectedRevision,
  });
  return ctx.call(
    "RevokeCredential",
    toBinary(RevokeGithubCredentialRequestSchema, request),
    true,
    (wire) => checkCredential(fromBinary(GithubCredentialStatusSchema, wire)),
  );
}

export function resolveRepository(
  ctx: GithubCallContext,
  remoteUrl: string,
): Promise<ResolveGithubRepositoryResponse> {
  if (
    typeof remoteUrl !== "string" ||
    !remoteUrl.trim() ||
    remoteUrl.length > 2048
  )
    reject("invalid");
  const request = create(ResolveGithubRepositoryRequestSchema, {
    meta: ctx.meta(),
    remoteUrl,
  });
  return ctx.call(
    "ResolveRepository",
    toBinary(ResolveGithubRepositoryRequestSchema, request),
    false,
    (wire) => {
      const value = fromBinary(ResolveGithubRepositoryResponseSchema, wire);
      // A mismatch is an answer, not a repository: it must not arrive with
      // one, or the panel would show an enterprise repo it never resolved.
      if (value.hostMismatch) {
        if (value.repository) reject("response");
        return value;
      }
      if (!validRepository(value.repository?.ref)) reject("response");
      return value;
    },
  );
}
