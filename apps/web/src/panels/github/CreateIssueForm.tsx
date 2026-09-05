import * as React from "react";

import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { useT } from "@/app/preferences-store";
import { Field } from "../git/forms";

export interface CreateIssueRequest {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
}

export function CreateIssueForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (request: CreateIssueRequest) => void;
}) {
  const t = useT();
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [labels, setLabels] = React.useState("");
  const [assignees, setAssignees] = React.useState("");
  const list = (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  return (
    <form
      className="min-w-0 space-y-2 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !title.trim()) return;
        onCreate({
          title: title.trim(),
          body,
          labels: list(labels),
          assignees: list(assignees),
        });
        setTitle("");
        setBody("");
        setLabels("");
        setAssignees("");
      }}
    >
      <h3 className="text-[12px] font-medium text-muted-foreground">
        {t("github.create.issue")}
      </h3>
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
      <Field label={t("github.create.labels")}>
        <Input
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          className="h-9 min-w-0"
        />
      </Field>
      <Field label={t("github.create.assignees")}>
        <Input
          value={assignees}
          onChange={(event) => setAssignees(event.target.value)}
          className="h-9 min-w-0"
        />
      </Field>
      <Button
        type="submit"
        size="sm"
        className="min-h-10"
        disabled={busy || !title.trim()}
      >
        {t("github.create.submit")}
      </Button>
    </form>
  );
}
