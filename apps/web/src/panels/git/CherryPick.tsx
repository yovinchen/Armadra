import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  GitCherryPickPreview,
  GitExpectedState,
  GitIntegrationSnapshot,
  GitRepositoryAction,
} from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Check, Field, ReadError, selectClass } from "./forms";
export interface CherryPickProps {
  workspaceId: string;
  repositoryKey: string;
  state: GitIntegrationSnapshot;
  disabled: boolean;
  canRequest: () => boolean;
  loadPreview: (
    oid: string,
    mainline: number | null,
    signal: AbortSignal,
  ) => Promise<GitCherryPickPreview>;
  request: (action: GitRepositoryAction, expected: GitExpectedState) => void;
}
export function CherryPick({
  workspaceId,
  repositoryKey,
  state,
  disabled,
  canRequest,
  loadPreview,
  request,
}: CherryPickProps) {
  const t = useT();
  const client = useQueryClient();
  const [input, setInput] = useState("");
  const [mainline, setMainline] = useState<number | null>(null);
  const [recordOrigin, setRecordOrigin] = useState(false);
  const oid = input.trim().toLowerCase();
  const validOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid);
  const key = (parent: number | null) => [
    "git-cherry-pick-preview",
    workspaceId,
    repositoryKey,
    oid,
    parent,
  ];
  const read = async (parent: number | null, signal: AbortSignal) => {
    const preview = await loadPreview(oid, parent, signal);
    if (preview.targetOid !== oid || preview.mainline !== parent)
      throw new Error(t("gitIntegration.changed"));
    return preview;
  };
  const metadata = useQuery({
    queryKey: key(null),
    queryFn: ({ signal }) => read(null, signal),
    enabled: validOid,
    retry: false,
  });
  const isMerge = Boolean(metadata.data && metadata.data.parents.length > 1);
  const selectedParent =
    isMerge && mainline && metadata.data?.parents[mainline - 1]
      ? mainline
      : null;
  const patch = useQuery({
    queryKey: key(selectedParent),
    queryFn: ({ signal }) => read(selectedParent, signal),
    enabled: validOid && isMerge && selectedParent !== null,
    retry: false,
  });
  const preview = isMerge ? patch.data : metadata.data;
  const ready = () =>
    !disabled &&
    canRequest() &&
    validOid &&
    !metadata.isError &&
    !metadata.isFetching &&
    client.getQueryData(key(null)) === metadata.data &&
    Boolean(
      preview &&
        preview.targetOid === oid &&
        preview.patch !== null &&
        (!isMerge ||
          (selectedParent !== null &&
            !patch.isError &&
            !patch.isFetching &&
            preview.mainline === selectedParent &&
            client.getQueryData(key(selectedParent)) === preview)),
    );
  return (
    <form
      className="space-y-2 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready())
          request(
            {
              kind: "startCherryPick",
              targetOid: oid,
              mainline: selectedParent,
              recordOrigin,
              expectedStateToken: state.stateToken,
            },
            { ...state.head },
          );
      }}
    >
      <h3 className="font-medium">{t("gitIntegration.cherryPick")}</h3>
      <Field label={t("gitIntegration.commitOid")}>
        <Input
          value={input}
          maxLength={64}
          placeholder={t("gitIntegration.fullOid")}
          onChange={(event) => {
            setInput(event.target.value);
            setMainline(null);
          }}
          autoComplete="off"
        />
      </Field>
      <p className="text-muted-foreground">{t("gitIntegration.pickSafety")}</p>
      {metadata.isFetching && <p role="status">{t("gitRepo.loading")}</p>}
      {metadata.error && (
        <ReadError
          error={metadata.error}
          retry={() => void metadata.refetch()}
        />
      )}
      {metadata.data?.targetOid === oid && (
        <>
          <p className="break-words font-medium">{metadata.data.subject}</p>
          <p className="break-words text-muted-foreground">
            {metadata.data.authorName} &lt;{metadata.data.authorEmail}&gt; ·{" "}
            {metadata.data.authorTime}
          </p>
          <p className="break-all font-mono">{metadata.data.targetOid}</p>
          {isMerge && (
            <Field label={t("gitIntegration.mainline")}>
              <select
                aria-label={t("gitIntegration.mainline")}
                className={selectClass}
                value={selectedParent ?? ""}
                onChange={(event) =>
                  setMainline(
                    event.target.value ? Number(event.target.value) : null,
                  )
                }
              >
                <option value="">{t("gitIntegration.chooseMainline")}</option>
                {metadata.data.parents.map((parent, index) => (
                  <option key={`${index}:${parent}`} value={index + 1}>
                    {index + 1} · {parent}
                  </option>
                ))}
              </select>
              <span>{t("gitIntegration.mainlineSafety")}</span>
            </Field>
          )}
          {isMerge && patch.isFetching && (
            <p role="status">{t("gitRepo.loading")}</p>
          )}
          {isMerge && patch.error && (
            <ReadError error={patch.error} retry={() => void patch.refetch()} />
          )}
          {preview?.targetOid === oid &&
            preview.patch !== null &&
            (!isMerge || preview.mainline === selectedParent) && (
              <details open>
                <summary>{t("gitIntegration.pickDiff")}</summary>
                <pre
                  className="max-h-80 overflow-auto rounded bg-muted p-2 text-[11px]"
                  tabIndex={0}
                >
                  {preview.patch || t("gitIntegration.emptyPreview")}
                </pre>
              </details>
            )}
        </>
      )}
      <Check
        label={t("gitIntegration.recordOrigin")}
        checked={recordOrigin}
        onChange={setRecordOrigin}
      />
      <Button type="submit" size="sm" disabled={!ready()}>
        {t("gitRepo.startCherryPick")}
      </Button>
    </form>
  );
}
