import type {
  AutomationCommandSession,
  AutomationPlanSnapshot,
  AutomationRunSnapshot,
  HostAutomationClient,
} from "@armadra/host-client";

/**
 * Paging helpers for the automation surface.
 *
 * The Host stores runs under a slot hash, so a page is not chronological. Runs
 * are therefore sorted here by the scheduled instant before they are shown —
 * the alternative would be a "history" whose order means nothing.
 */

/** Hard stop so a broken cursor can never spin forever. */
const MAX_PAGES = 20;
const PAGE = 100;

export const automationKeys = {
  plans: (workspaceId: string) => ["automation", "plans", workspaceId] as const,
  runs: (workspaceId: string, planId: string) =>
    ["automation", "runs", workspaceId, planId] as const,
  sessions: (workspaceId: string) =>
    ["automation", "sessions", workspaceId] as const,
};

export async function allPlans(
  client: HostAutomationClient,
): Promise<AutomationPlanSnapshot[]> {
  const plans: AutomationPlanSnapshot[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listPlans(cursor, PAGE);
    plans.push(...result.plans);
    if (!result.hasMore) break;
    cursor = result.nextId;
  }
  return plans;
}

export async function allCommandSessions(
  client: HostAutomationClient,
): Promise<AutomationCommandSession[]> {
  const sessions: AutomationCommandSession[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listCommandSessions(cursor, PAGE);
    sessions.push(...result.sessions);
    if (!result.hasMore) break;
    cursor = result.nextId;
  }
  return sessions;
}

/** Newest first; a run with no scheduled instant sorts by its creation time. */
export function byRecency(
  runs: AutomationRunSnapshot[],
): AutomationRunSnapshot[] {
  const at = (snapshot: AutomationRunSnapshot) =>
    snapshot.run?.scheduledAtUnixMs || snapshot.run?.createdAtUnixMs || 0n;
  return [...runs].sort((left, right) => {
    const difference = at(right) - at(left);
    return difference === 0n ? 0 : difference > 0n ? 1 : -1;
  });
}

export async function planRuns(
  client: HostAutomationClient,
  planId: string,
): Promise<AutomationRunSnapshot[]> {
  const runs: AutomationRunSnapshot[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listRuns(planId, cursor, PAGE);
    runs.push(...result.runs);
    if (!result.hasMore) break;
    cursor = result.nextId;
  }
  return byRecency(runs);
}

export function findPlan(
  plans: AutomationPlanSnapshot[] | undefined,
  planId: string,
): AutomationPlanSnapshot | null {
  return plans?.find((snapshot) => snapshot.plan?.id === planId) ?? null;
}
