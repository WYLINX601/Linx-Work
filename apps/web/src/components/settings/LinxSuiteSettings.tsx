import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type LinxExpertDefinitionSummary,
  type LinxSuiteDetail,
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
    try {
      const result = await runArchive({
        environmentId,
        input: { suiteId: suite.suiteId, expectedRevision: suite.currentRevision },
      });
      const failure = errorText(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      suites.refresh();
    } finally {
      setPending(null);
    }
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
  const [leadExpertId, setLeadExpertId] = useState(
    initial?.leadExpertId ?? experts[0]?.expertId ?? "",
  );
  const [memberIds, setMemberIds] = useState<ReadonlyArray<string>>(
    initial?.members.map((member) => member.expertId) ?? [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runSave = useAtomCommand(saveSuite, { reportFailure: false });
  const available = experts.filter((expert) => !expert.archived);
  const availableMembers = available.filter((expert) => expert.expertId !== leadExpertId);
  const lead = available.find((expert) => expert.expertId === leadExpertId);

  const toggleMember = (expertId: string, checked: boolean) => {
    setMemberIds((current) =>
      checked
        ? [...current.filter((id) => id !== expertId), expertId]
        : current.filter((id) => id !== expertId),
    );
  };

  const save = async () => {
    if (pending) return;
    if (name.trim().length === 0 || lead === undefined) {
      setError(mf(m("Choose a name and a Lead expert.")));
      return;
    }
    const members = memberIds.flatMap((expertId) => {
      const expert = available.find((candidate) => candidate.expertId === expertId);
      return expert === undefined
        ? []
        : [
            {
              memberKey: expert.expertId,
              expertId: expert.expertId,
              revision: expert.currentRevision,
            },
          ];
    });
    if (members.length === 0) {
      setError(mf(m("Choose at least one member.")));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await runSave({
        environmentId,
        input: {
          ...(initial === null
            ? {}
            : { suiteId: initial.suiteId, expectedRevision: initial.currentRevision }),
          name: name.trim(),
          leadExpertId: lead.expertId,
          leadExpertRevision: lead.currentRevision,
          members,
          policy: { maxActiveDelegations: initial?.policy.maxActiveDelegations ?? 4 },
        },
      });
      if (result._tag === "Failure") {
        setError(thrownErrorMessage(result.cause, mf) ?? mf(m("The suite could not be saved.")));
        return;
      }
      onSaved();
    } finally {
      setPending(false);
    }
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
          <Select
            value={leadExpertId}
            onValueChange={(value) => {
              if (value !== null) {
                setLeadExpertId(value);
                setMemberIds((current) => current.filter((id) => id !== value));
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Lead expert")}>
              <SelectValue>
                {(value: string | null) =>
                  available.find((expert) => expert.expertId === value)?.title ??
                  gt("Choose a Lead")
                }
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
        </div>
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">{gt("Members")}</span>
          {availableMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{gt("No other experts available.")}</p>
          ) : (
            <ul className="space-y-2">
              {availableMembers.map((expert) => (
                <li key={expert.expertId} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={memberIds.includes(expert.expertId)}
                    onCheckedChange={(checked) => toggleMember(expert.expertId, checked === true)}
                  />
                  <span className="min-w-0 flex-1 truncate">{expert.title}</span>
                  <span className="text-xs text-muted-foreground">
                    <T>
                      v<Var>{expert.currentRevision}</Var>
                    </T>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
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
