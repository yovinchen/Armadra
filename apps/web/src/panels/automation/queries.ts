import type {
  AutomationCommandSession,
  AutomationPlanSnapshot,
  AutomationRunSnapshot,
  HostAutomationClient,
} from "@armadra/host-client";

/**
 * Paging helpers for the automation surface.
 *
 * Run history is paged by the Host, newest first: it keeps a time-ordered
 * index beside the runs, so a page really is "the next N older runs" and a
 * cursor really is a position in that order. Nothing is re-sorted here — a
 * client sort would only be able to order the page it happened to receive,
 * which is what the previous fetch-everything-then-sort approach was working
 * around.
 */

/** Hard stop so a broken cursor can never spin forever. */
const MAX_PAGES = 20;
const PAGE = 100;
/** One screenful of run history; the reader asks for more by scrolling. */
export const RUNS_PAGE = 25;

export const automationKeys = {
  plans: (workspaceId: string) => ["automation", "plans", workspaceId] as const,
  runs: (workspaceId: string, planId: string) =>
    ["automation", "runs", workspaceId, planId] as const,
  sessions: (workspaceId: string) =>
    ["automation", "sessions", workspaceId] as const,
  /** The stored stdin / prompt, read back only when a plan is being edited. */
  payload: (workspaceId: string, planId: string) =>
    ["automation", "payload", workspaceId, planId] as const,
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

export interface RunPage {
  runs: AutomationRunSnapshot[];
  /** The cursor for the next, older page; `null` when this is the last one. */
  nextCursor: string | null;
}

/**
 * One page of a plan's run history, newest first, as the Host ordered it.
 *
 * The cursor is opaque and belongs to the plan it was issued for — the Host
 * refuses one from another plan rather than paging through its history.
 */
export async function runPage(
  client: HostAutomationClient,
  planId: string,
  cursor: string,
): Promise<RunPage> {
  const result = await client.listRuns(planId, cursor, RUNS_PAGE);
  return {
    runs: result.runs,
    nextCursor: result.hasMore && result.nextId ? result.nextId : null,
  };
}

export function findPlan(
  plans: AutomationPlanSnapshot[] | undefined,
  planId: string,
): AutomationPlanSnapshot | null {
  return plans?.find((snapshot) => snapshot.plan?.id === planId) ?? null;
}
