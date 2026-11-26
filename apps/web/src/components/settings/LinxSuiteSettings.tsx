import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type LinxExpertDefinitionSummary,
  type LinxSuiteDetail,
  type LinxSuiteMemberInput,
  type LinxSuiteSummary,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useGT, useMessages, T, Var } from "gt-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { archiveSuite, linxSuiteDetail, linxSuites, saveSuite } from "../../state/linx";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsSection } from "./settingsLayout";

export function LinxSuiteSettings({
  environmentId,
  experts,
}: {
  readonly environmentId: EnvironmentId;
  readonly experts: ReadonlyArray<LinxExpertDefinitionSummary>;
}) {
  const gt = useGT();
  const mf = useMessages();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const suites = useEnvironmentQuery(linxSuites({ environmentId, input: {} }));
  const [editing, setEditing] = useState<{ readonly id: "new" | string } | null>(null);
  const detail = useEnvironmentQuery(
    editing === null || editing.id === "new"
      ? null
      : linxSuiteDetail({ environmentId, input: { suiteId: editing.id } }),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runArchive = useAtomCommand(archiveSuite, { reportFailure: false });
  const errorText = (result: AtomCommandResult<unknown, unknown> | null): string | null => {
    if (result?._tag !== "Failure") return null;
    return thrownErrorMessage(result.cause, mf) ?? mf(m("The request failed."));
  };
  const rows = suites.data ?? [];
  const editorReady =
    editing !== null &&
    (editing.id === "new" || (detail.data !== null && detail.data !== undefined));

  const archive = async (suite: LinxSuiteSummary) => {
    if (!canManage || pending !== null) return;
    setPending(suite.suiteId);
    setError(null);
    const result = await runArchive({
      environmentId,
      input: { suiteId: suite.suiteId, expectedRevision: suite.currentRevision },
    });
    setPending(null);
    const failure = errorText(result);
    if (failure !== null) {
      setError(failure);
      return;
    }
    suites.refresh();
  };

  return (
    <>
      <SettingsSection title={gt("Suites")}>
        <p className="px-4 pt-3 text-sm text-muted-foreground">
          {gt(
            "A Suite freezes a Lead and its members. Members are delegated work through T3's native tasks.",
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage || pending !== null}
            onClick={() => setEditing({ id: "new" })}
          >
            {gt("New suite")}
          </Button>
          {suites.isPending ? <Spinner /> : null}
        </div>
        <ul className="divide-y divide-border/60 border-t border-border/60">
          {rows.length === 0 && !suites.isPending ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">{gt("No suites yet.")}</li>
          ) : null}
          {rows.map((suite) => (
            <li key={suite.suiteId} className="flex items-center gap-2 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{suite.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  <T>
                    v<Var>{suite.currentRevision}</Var> · <Var>{suite.memberCount}</Var> members
                  </T>
                </span>
              </span>
              {suite.archived ? (
                <span className="text-xs text-muted-foreground">{gt("Archived")}</span>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={!canManage || pending !== null}
                onClick={() => setEditing({ id: suite.suiteId })}
              >
                {gt("Edit")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canManage || pending !== null || suite.archived}
                onClick={() => void archive(suite)}
              >
                {gt("Archive")}
              </Button>
            </li>
          ))}
        </ul>
        {error !== null ? (
          <p role="alert" className="px-4 pb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      {editorReady ? (
        <SuiteEditor
          key={editing.id === "new" ? "new" : `${editing.id}:${detail.data?.currentRevision}`}
          environmentId={environmentId}
          experts={experts}
          initial={editing.id === "new" ? null : (detail.data ?? null)}
          onSaved={() => {
            setEditing(null);
            suites.refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function SuiteEditor({
  environmentId,
  experts,
  initial,
  onSaved,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly experts: ReadonlyArray<LinxExpertDefinitionSummary>;
  readonly initial: LinxSuiteDetail | null;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  const mf = useMessages();
  const [name, setName] = useState(initial?.name ?? "");
  const available = experts.filter((expert) => !expert.archived);
  const [leadExpertId, setLeadExpertId] = useState(initial?.leadExpertId ?? available[0]?.expertId);
  const [leadRevision, setLeadRevision] = useState(
    initial?.leadExpertRevision ?? available[0]?.currentRevision,
  );
  const [members, setMembers] = useState<ReadonlyArray<LinxSuiteMemberInput>>(
    () => initial?.members.map(({ snapshotId: _snapshotId, ...member }) => member) ?? [],
  );
  const [policy, setPolicy] = useState<
    Required<Pick<LinxSuiteDetail["policy"], "sandbox" | "workspaceIsolation" | "approval">>
  >(() => {
    const stored = initial?.policy;
    return stored?.sandbox === "workspace-write"
      ? {
          sandbox: "workspace-write",
          workspaceIsolation: "worktree",
          approval: stored.approval ?? "never",
        }
      : {
          sandbox: "read-only",
          workspaceIsolation: stored?.workspaceIsolation ?? "shared",
          approval: "never",
        };
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runSave = useAtomCommand(saveSuite, { reportFailure: false });
  const memberOptions = experts.filter(
    (expert) =>
      expert.expertId !== leadExpertId &&
      (!expert.archived || members.some((member) => member.expertId === expert.expertId)),
  );
  const lead = experts.find((expert) => expert.expertId === leadExpertId);
  const workspaceWrite = policy.sandbox === "workspace-write";
  const sandboxLabel = gt("Sandbox");
  const isolationLabel = gt("Workspace isolation");
  const approvalLabel = gt("Approval");
  const readOnlyLabel = gt("Read-only");
  const workspaceWriteLabel = gt("Workspace write");
  const sharedLabel = gt("Shared");
  const worktreeLabel = gt("Worktree");
  const neverLabel = gt("Never");
  const onRequestLabel = gt("On request");

  const toggleMember = (expert: LinxExpertDefinitionSummary, checked: boolean) => {
    setMembers((current) => {
      const remaining = current.filter((member) => member.expertId !== expert.expertId);
      return checked
        ? [
            ...remaining,
            {
              memberKey: expert.expertId,
              expertId: expert.expertId,
              revision: expert.currentRevision,
              title: expert.title,
            },
          ]
        : remaining;
    });
  };

  const save = async () => {
    if (pending) return;
    if (name.trim().length === 0 || leadExpertId === undefined || leadRevision === undefined) {
      setError(mf(m("Choose a name and a Lead expert.")));
      return;
    }
    if (members.length === 0) {
      setError(mf(m("Choose at least one member.")));
      return;
    }
    setPending(true);
    setError(null);
    const result = await runSave({
      environmentId,
      input: {
        ...(initial === null
          ? {}
          : { suiteId: initial.suiteId, expectedRevision: initial.currentRevision }),
        name: name.trim(),
        leadExpertId,
        leadExpertRevision: leadRevision,
        members,
        policy: { maxActiveDelegations: initial?.policy.maxActiveDelegations ?? 4, ...policy },
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(thrownErrorMessage(result.cause, mf) ?? mf(m("The suite could not be saved.")));
      return;
    }
    onSaved();
  };

  return (
    <SettingsSection title={initial === null ? gt("New suite") : gt("Edit suite")}>
      <div className="space-y-4 px-4 py-4">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{gt("Name")}</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">{gt("Lead expert")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={leadExpertId ?? null}
              onValueChange={(value) => {
                if (value === leadExpertId) return;
                const next = available.find((expert) => expert.expertId === value);
                if (!next) return;
                setLeadExpertId(next.expertId);
                setLeadRevision(next.currentRevision);
                setMembers((current) => current.filter((member) => member.expertId !== value));
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Lead expert")}>
                <SelectValue>
                  {leadExpertId !== undefined && leadRevision !== undefined
                    ? gt("{expert} · v{revision}", {
                        expert: lead?.title ?? leadExpertId,
                        revision: leadRevision,
                      })
                    : gt("Choose a Lead")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start">
                {available.map((expert) => (
                  <SelectItem key={expert.expertId} value={expert.expertId}>
                    {expert.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {lead && !lead.archived && lead.currentRevision !== leadRevision ? (
              <Button
                variant="outline"
                size="xs"
                disabled={pending}
                aria-label={gt("Use version {revision} of {expert}", {
                  revision: lead.currentRevision,
                  expert: lead.title,
                })}
                onClick={() => setLeadRevision(lead.currentRevision)}
              >
                {gt("Use v{revision}", { revision: lead.currentRevision })}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">{gt("Members")}</span>
          {memberOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{gt("No other experts available.")}</p>
          ) : (
            <ul className="space-y-2">
              {memberOptions.map((expert) => {
                const selected = members.filter((member) => member.expertId === expert.expertId);
                const revisions =
                  selected.length > 0
                    ? new Set(selected.map((member) => member.revision))
                    : [expert.currentRevision];
                const canUpdate =
                  !expert.archived &&
                  selected.some((member) => member.revision !== expert.currentRevision);
                return (
                  <li key={expert.expertId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label={expert.title}
                      checked={selected.length > 0}
                      onCheckedChange={(checked) => toggleMember(expert, checked === true)}
                    />
                    <span className="min-w-0 flex-1 truncate">{expert.title}</span>
                    {Array.from(revisions, (revision) => (
                      <span key={revision} className="text-xs text-muted-foreground">
                        <T>
                          v<Var>{revision}</Var>
                        </T>
                      </span>
                    ))}
                    {canUpdate ? (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={pending}
                        aria-label={gt("Use version {revision} of {expert}", {
                          revision: expert.currentRevision,
                          expert: expert.title,
                        })}
                        onClick={() =>
                          setMembers((current) =>
                            current.map((member) =>
                              member.expertId === expert.expertId
                                ? { ...member, revision: expert.currentRevision }
                                : member,
                            ),
                          )
                        }
                      >
                        {gt("Use v{revision}", { revision: expert.currentRevision })}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted-foreground">
            {gt("Member execution policy")}
          </legend>
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1.5">
              <span className="block text-xs text-muted-foreground">{sandboxLabel}</span>
              <Select
                disabled={pending}
                value={policy.sandbox}
                onValueChange={(value) => {
                  if (value === "workspace-write") {
                    setPolicy((current) => ({
                      ...current,
                      sandbox: value,
                      workspaceIsolation: "worktree",
                    }));
                  } else if (value === "read-only") {
                    setPolicy((current) => ({ ...current, sandbox: value }));
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={sandboxLabel}>
                  <SelectValue>{workspaceWrite ? workspaceWriteLabel : readOnlyLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="read-only">{readOnlyLabel}</SelectItem>
                  <SelectItem value="workspace-write">{workspaceWriteLabel}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <span className="block text-xs text-muted-foreground">{isolationLabel}</span>
              <Select
                disabled={pending || workspaceWrite}
                value={policy.workspaceIsolation}
                onValueChange={(value) => {
                  if (value === "shared" || value === "worktree") {
                    setPolicy((current) =>
                      current.sandbox === "read-only"
                        ? { ...current, workspaceIsolation: value }
                        : current,
                    );
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={isolationLabel}>
                  <SelectValue>
                    {policy.workspaceIsolation === "shared" ? sharedLabel : worktreeLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="shared">{sharedLabel}</SelectItem>
                  <SelectItem value="worktree">{worktreeLabel}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <span className="block text-xs text-muted-foreground">{approvalLabel}</span>
              <Select
                disabled={pending}
                value={policy.approval}
                onValueChange={(value) => {
                  if (value === "never" || value === "on-request") {
                    setPolicy((current) => ({ ...current, approval: value }));
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={approvalLabel}>
                  <SelectValue>
                    {policy.approval === "never" ? neverLabel : onRequestLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="never">{neverLabel}</SelectItem>
                  <SelectItem value="on-request">{onRequestLabel}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {workspaceWrite
              ? gt("Workspace write requires a worktree. Approvals cannot expand sandbox access.")
              : gt("Read-only members cannot request approvals.")}
          </p>
        </fieldset>
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={pending} onClick={() => void save()}>
            {initial === null ? gt("Create suite") : gt("Save revision")}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            {gt("Cancel")}
          </Button>
          {pending ? <Spinner /> : null}
        </div>
      </div>
    </SettingsSection>
  );
}
