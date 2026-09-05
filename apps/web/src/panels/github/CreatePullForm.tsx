import * as React from "react";

import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { useT } from "@/app/preferences-store";
import { Check, Field } from "../git/forms";
import {
  TargetSelect,
  parseTarget,
  useLinkTargets,
  type LinkTarget,
} from "./link-targets";

export interface CreatePullRequestInput {
  baseRef: string;
  headRef: string;
  title: string;
  body: string;
  draft: boolean;
  linkedIssueNumber: bigint;
  /**
   * Where the new pull request is linked once it exists. Null unless the user
   * picked a target: creating a pull request never links anything silently.
   */
  target: LinkTarget | null;
}

export function CreatePullForm({
  busy,
  workspaceId,
  defaultBaseRef,
  onCreate,
}: {
  busy: boolean;
  workspaceId: string;
  defaultBaseRef: string;
  onCreate: (input: CreatePullRequestInput) => void;
}) {
  const t = useT();
  const [baseRef, setBaseRef] = React.useState(defaultBaseRef);
  const [headRef, setHeadRef] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [draft, setDraft] = React.useState(false);
  const [linked, setLinked] = React.useState("");
  const [target, setTarget] = React.useState("");
  const targets = useLinkTargets(workspaceId);

  const valid =
    baseRef.trim() && headRef.trim() && title.trim() && baseRef !== headRef;

  return (
    <form
      className="min-w-0 space-y-2 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !valid) return;
        const number = Number.parseInt(linked.trim(), 10);
        onCreate({
          baseRef: baseRef.trim(),
          headRef: headRef.trim(),
          title: title.trim(),
          body,
          draft,
          linkedIssueNumber:
            Number.isSafeInteger(number) && number > 0 ? BigInt(number) : 0n,
          target: target ? parseTarget(target) : null,
        });
        setHeadRef("");
        setTitle("");
        setBody("");
        setLinked("");
        setTarget("");
      }}
    >
      <h3 className="text-[12px] font-medium text-muted-foreground">
        {t("github.create.pull")}
      </h3>
      <Field label={t("github.create.baseRef")}>
        <Input
          value={baseRef}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setBaseRef(event.target.value)}
          className="h-9 min-w-0"
          required
        />
      </Field>
      <Field label={t("github.create.headRef")}>
        <Input
          value={headRef}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setHeadRef(event.target.value)}
          className="h-9 min-w-0"
          required
        />
      </Field>
      <Field label={t("github.create.title")}>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="h-9 min-w-0"
          required
        />
      </Field>
      <Field label={t("github.create.body")}>
        <Textarea
          value={body}
          rows={4}
          onChange={(event) => setBody(event.target.value)}
          className="min-w-0"
        />
      </Field>
      <Field label={t("github.create.linkedIssue")}>
        <Input
          value={linked}
          inputMode="numeric"
          onChange={(event) => setLinked(event.target.value)}
          className="h-9 min-w-0"
        />
      </Field>
      {!targets.empty && (
        <Field label={t("github.create.linkTarget")}>
          <TargetSelect
            value={target}
            targets={targets}
            disabled={busy}
            onChange={setTarget}
          />
        </Field>
      )}
      <Check
        label={t("github.create.draft")}
        checked={draft}
        onChange={setDraft}
      />
      <Button
        type="submit"
        size="sm"
        className="min-h-10"
        disabled={busy || !valid}
      >
        {t("github.create.submit")}
      </Button>
    </form>
  );
}
