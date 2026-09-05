import {
  create,
  GithubIssueFilterSchema,
  GithubPullFilterSchema,
} from "@armadra/protocol";
import {
  GithubIssueState,
  GithubPullState,
  type GithubIssueFilter,
  type GithubPullFilter,
} from "@armadra/host-client";

import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useT } from "@/app/preferences-store";
import { Check, Field, selectClass } from "../git/forms";
import type { GithubTab } from "./open";

/** One filter form for both tabs; each tab shows the fields that apply. */
export interface GithubFilterState {
  state: "open" | "closed" | "all";
  author: string;
  assignee: string;
  labels: string;
  query: string;
  baseRef: string;
  reviewRequested: string;
  draftOnly: boolean;
}

export const EMPTY_FILTER: GithubFilterState = {
  state: "open",
  author: "",
  assignee: "",
  labels: "",
  query: "",
  baseRef: "",
  reviewRequested: "",
  draftOnly: false,
};

function list(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function issueFilter(state: GithubFilterState): GithubIssueFilter {
  return create(GithubIssueFilterSchema, {
    state:
      state.state === "open"
        ? GithubIssueState.OPEN
        : state.state === "closed"
          ? GithubIssueState.CLOSED
          : GithubIssueState.UNSPECIFIED,
    labels: list(state.labels),
    assignee: state.assignee.trim(),
    author: state.author.trim(),
    query: state.query.trim(),
  });
}

export function pullFilter(state: GithubFilterState): GithubPullFilter {
  return create(GithubPullFilterSchema, {
    state:
      state.state === "open"
        ? GithubPullState.OPEN
        : state.state === "closed"
          ? GithubPullState.CLOSED
          : GithubPullState.UNSPECIFIED,
    author: state.author.trim(),
    baseRef: state.baseRef.trim(),
    reviewRequested: state.reviewRequested.trim(),
    draftOnly: state.draftOnly,
  });
}

/** Stable cache key for one filter form, per tab. */
export function filterKey(tab: GithubTab, state: GithubFilterState): string {
  return tab === "issues"
    ? [state.state, state.author, state.assignee, state.labels, state.query]
        .map((part) => part.trim())
        .join("|")
    : [
        state.state,
        state.author,
        state.baseRef,
        state.reviewRequested,
        state.draftOnly ? "draft" : "",
      ]
        .map((part) => String(part).trim())
        .join("|");
}

export interface FilterBarProps {
  tab: GithubTab;
  value: GithubFilterState;
  onChange: (next: GithubFilterState) => void;
  onApply: () => void;
  busy: boolean;
}

export function FilterBar({
  tab,
  value,
  onChange,
  onApply,
  busy,
}: FilterBarProps) {
  const t = useT();
  const set = <K extends keyof GithubFilterState>(
    key: K,
    next: GithubFilterState[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <form
      className="grid min-w-0 gap-2 border-b border-border p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onApply();
      }}
    >
      <Field label={t("github.filter.state")}>
        <select
          className={selectClass}
          value={value.state}
          onChange={(event) =>
            set("state", event.target.value as GithubFilterState["state"])
          }
        >
          <option value="open">{t("github.filter.state.open")}</option>
          <option value="closed">{t("github.filter.state.closed")}</option>
          <option value="all">{t("github.filter.state.all")}</option>
        </select>
      </Field>
      <Field label={t("github.filter.author")}>
        <Input
          value={value.author}
          autoComplete="off"
          onChange={(event) => set("author", event.target.value)}
          className="h-9 min-w-0"
        />
      </Field>
      {tab === "issues" ? (
        <>
          <Field label={t("github.filter.assignee")}>
            <Input
              value={value.assignee}
              autoComplete="off"
              onChange={(event) => set("assignee", event.target.value)}
              className="h-9 min-w-0"
            />
          </Field>
          <Field label={t("github.filter.labels")}>
            <Input
              value={value.labels}
              autoComplete="off"
              onChange={(event) => set("labels", event.target.value)}
              className="h-9 min-w-0"
            />
          </Field>
          <Field label={t("github.filter.query")}>
            <Input
              value={value.query}
              autoComplete="off"
              onChange={(event) => set("query", event.target.value)}
              className="h-9 min-w-0"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={t("github.filter.baseRef")}>
            <Input
              value={value.baseRef}
              autoComplete="off"
              onChange={(event) => set("baseRef", event.target.value)}
              className="h-9 min-w-0"
            />
          </Field>
          <Field label={t("github.filter.reviewRequested")}>
            <Input
              value={value.reviewRequested}
              autoComplete="off"
              onChange={(event) => set("reviewRequested", event.target.value)}
              className="h-9 min-w-0"
            />
          </Field>
          <Check
            label={t("github.filter.draftOnly")}
            checked={value.draftOnly}
            onChange={(next) => set("draftOnly", next)}
          />
        </>
      )}
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        className="min-h-10 sm:col-span-2"
        disabled={busy}
      >
        {t("github.filter.apply")}
      </Button>
    </form>
  );
}
