import { useQuery } from "@tanstack/react-query";
import {
  GithubReferenceKind,
  type GithubExternalReference,
} from "@armadra/host-client";

import { useGithubSession } from "@/host/github-session";
import { githubKeys } from "./queries";

/**
 * The GitHub items linked to one canvas node.
 *
 * This deliberately does not open a session of its own: the badge is decoration
 * on a board that may never touch GitHub, so it reads whatever session the
 * GitHub page already established and otherwise reports nothing. An empty
 * result and "no session" are the same thing to the caller — both render
 * nothing rather than a placeholder that suggests a link exists.
 */
export function useGithubReferences(
  targetId: string,
): GithubExternalReference[] {
  const state = useGithubSession((store) => store.state);
  const client = state.status === "ready" ? state.client : null;
  const query = useQuery({
    queryKey: githubKeys.references(client?.workspaceId ?? "", targetId),
    queryFn: () => client!.listReferences({ targetId, limit: 50 }),
    enabled: Boolean(client) && targetId.length > 0,
    retry: false,
  });
  return query.data?.references ?? [];
}

/** Which tab of the GitHub page a reference belongs to. */
export function referenceTab(
  reference: GithubExternalReference,
): "issues" | "pulls" {
  return reference.kind === GithubReferenceKind.PULL_REQUEST
    ? "pulls"
    : "issues";
}
