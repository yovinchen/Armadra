import { useState } from "react";
import type { GitBranchSnapshot, GitRepositoryAction } from "@armadra/shared";
import { useT } from "../../app/preferences-store";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Badge } from "../../ui/badge";
import { Check, Field, selectClass } from "./forms";

export function Branches({
  snapshot,
  busy,
  request,
}: {
  snapshot: GitBranchSnapshot;
  busy: boolean;
  request: (action: GitRepositoryAction) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [switchAfter, setSwitchAfter] = useState(false);
  const [chosenRemote, setRemote] = useState("");
  const remote = snapshot.remotes.includes(chosenRemote)
    ? chosenRemote
    : (snapshot.remotes[0] ?? "");
  const [pullBranch, setPullBranch] = useState("");
  const [setUpstream, setSetUpstream] = useState(false);
  const [leaseForce, setLeaseForce] = useState(false);
  const branch = snapshot.head.branch;
  // The remote-tracking ref this view actually observed. Sync and any lease are
  // bound to it, never to whatever a later background fetch happens to see.
  const remoteOid =
    snapshot.branches.find(
      (record) => record.remote && record.name === `${remote}/${branch}`,
    )?.oid ?? null;
  const lease =
    leaseForce && remoteOid ? { expectedRemoteOid: remoteOid } : null;
  return (
    <div className="space-y-4 p-3">
      <div className="space-y-1 break-all text-xs">
        <p>
          {t("gitRepo.current")}:{" "}
          <strong>{branch ?? t("gitRepo.detached")}</strong>
        </p>
        <p className="font-mono text-muted-foreground">
          {snapshot.head.headOid ?? t("gitRepo.unborn")}
        </p>
      </div>
      <fieldset
        disabled={busy}
        className="min-w-0 space-y-2 rounded-md border border-border p-3"
      >
        <Field label={t("gitRepo.remote")}>
          <select
            aria-label={t("gitRepo.remote")}
            className={selectClass}
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
          >
            {snapshot.remotes.length ? (
              snapshot.remotes.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))
            ) : (
              <option value="">{t("gitRepo.noRemote")}</option>
            )}
          </select>
        </Field>
        <Field label={t("gitRepo.remoteBranch")}>
          <Input
            value={pullBranch}
            placeholder={branch ?? ""}
            onChange={(event) => setPullBranch(event.target.value)}
          />
        </Field>
        <Check
          label={t("gitRepo.setUpstream")}
          checked={setUpstream}
          onChange={setSetUpstream}
        />
        <p className="break-all font-mono text-muted-foreground">
          {t("gitRepo.remoteOid")}:{" "}
          {remoteOid ?? t("gitRepo.remoteBranchMissing")}
        </p>
        <Check
          label={t("gitRepo.forceWithLease")}
          checked={leaseForce}
          onChange={setLeaseForce}
        />
        <p className="text-muted-foreground">
          {t(remoteOid ? "gitRepo.leaseSafety" : "gitRepo.leaseUnavailable")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!remote}
            onClick={() => request({ kind: "fetch", remote, prune: false })}
          >
            {t("gitRepo.fetch")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!remote || !branch || !(pullBranch.trim() || branch)}
            onClick={() =>
              request({
                kind: "pull",
                remote,
                branch: pullBranch.trim() || branch!,
              })
            }
          >
            {t("gitRepo.pull")}
          </Button>
          <Button
            size="sm"
            variant={lease ? "destructive" : "outline"}
            disabled={
              !remote ||
              !branch ||
              !snapshot.head.headOid ||
              (leaseForce && !remoteOid)
            }
            onClick={() =>
              request({
                kind: "push",
                remote,
                branch: branch!,
                setUpstream,
                forceWithLease: lease,
              })
            }
          >
            {t(lease ? "gitRepo.forcePush" : "gitRepo.push")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!remote || !branch || !snapshot.head.headOid}
            onClick={() =>
              request({
                kind: "sync",
                remote,
                branch: branch!,
                expectedRemoteOid: remoteOid,
              })
            }
          >
            {t("gitRepo.sync")}
          </Button>
        </div>
        <p className="text-muted-foreground">{t("gitRepo.syncSafety")}</p>
      </fieldset>
      <form
        className="space-y-2 rounded-md border border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && name.trim())
            request({
              kind: "createBranch",
              name: name.trim(),
              startPoint: startPoint.trim() || null,
              switch: switchAfter,
            });
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-2">
          <Field label={t("gitRepo.branchName")}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="off"
            />
          </Field>
          <Field label={t("gitRepo.startPoint")}>
            <Input
              value={startPoint}
              onChange={(event) => setStartPoint(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Check
            label={t("gitRepo.switchAfterCreate")}
            checked={switchAfter}
            onChange={setSwitchAfter}
          />
          <Button size="sm" type="submit" disabled={!name.trim()}>
            {t("gitRepo.createBranch")}
          </Button>
        </fieldset>
      </form>
      {[false, true].map((remote) => (
        <section key={String(remote)} className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t(remote ? "gitRepo.remoteBranches" : "gitRepo.local")}
          </h3>
          {snapshot.branches
            .filter((branch) => branch.remote === remote)
            .map((branch) => (
              <div
                key={branch.fullRef}
                className="space-y-2 rounded-md border border-border p-2 text-xs"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono">
                    {branch.name}
                  </span>
                  {branch.current && (
                    <Badge variant="outline">{t("gitRepo.current")}</Badge>
                  )}
                </div>
                <p className="break-all font-mono text-muted-foreground">
                  {branch.oid.slice(0, 12)}
                </p>
                {branch.upstream && (
                  <p className="break-all text-muted-foreground">
                    {t("gitRepo.upstream")}: {branch.upstream}{" "}
                    {branch.ahead !== null && `↑${branch.ahead}`}{" "}
                    {branch.behind !== null && `↓${branch.behind}`}
                  </p>
                )}
                {branch.upstreamMissing && (
                  <p className="text-[var(--warn)]">
                    {t("gitRepo.upstreamMissing")}
                  </p>
                )}
                {branch.symbolicTarget && (
                  <p className="break-all text-muted-foreground">
                    → {branch.symbolicTarget}
                  </p>
                )}
                {!remote && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || branch.current}
                      onClick={() =>
                        request({
                          kind: "switchBranch",
                          name: branch.name,
                          expectedOid: branch.oid,
                        })
                      }
                    >
                      {t("gitRepo.switchBranch")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || branch.current}
                      onClick={() =>
                        request({
                          kind: "deleteBranch",
                          name: branch.name,
                          expectedOid: branch.oid,
                        })
                      }
                    >
                      {t("gitRepo.deleteBranch")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
        </section>
      ))}
      {snapshot.branches.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("gitRepo.emptyBranches")}
        </p>
      )}
    </div>
  );
}
