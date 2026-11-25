import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useGT, useMessages, T, Var } from "gt-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import {
  archiveExpert,
  archiveSkill,
  importSkill,
  linxExpertDefinition,
  linxExpertDefinitions,
  linxSkillPackages,
  saveExpert,
} from "../../state/linx";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface SkillChoice {
  readonly packageId: string;
  readonly revision: number;
  readonly contentHash: string;
}

interface EditorForm {
  readonly title: string;
  readonly persona: string;
  readonly skills: ReadonlyArray<SkillChoice>;
}

const EMPTY_FORM: EditorForm = { title: "", persona: "", skills: [] };

export function LinxExpertsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const mf = useMessages();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const definitions = useEnvironmentQuery(linxExpertDefinitions({ environmentId, input: {} }));
  const skills = useEnvironmentQuery(linxSkillPackages({ environmentId, input: {} }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<{ readonly key: string; readonly form: EditorForm } | null>(
    null,
  );
  const [skillPath, setSkillPath] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detail = useEnvironmentQuery(
    selectedId !== null && !creating
      ? linxExpertDefinition({ environmentId, input: { expertId: selectedId } })
      : null,
  );
  const runSave = useAtomCommand(saveExpert, { reportFailure: false });
  const runArchive = useAtomCommand(archiveExpert, { reportFailure: false });
  const runImport = useAtomCommand(importSkill, { reportFailure: false });
  const runArchiveSkill = useAtomCommand(archiveSkill, { reportFailure: false });
  const errorText = (result: AtomCommandResult<unknown, unknown> | null): string | null => {
    if (result?._tag !== "Failure") return null;
    return thrownErrorMessage(result.cause, mf) ?? mf(m("The request failed."));
  };

  const experts = definitions.data ?? [];
  const packages = skills.data ?? [];
  const loaded = creating ? null : detail.data;
  const archived = loaded?.archived ?? false;
  const selectionKey = creating
    ? "new"
    : loaded === null || loaded === undefined
      ? "empty"
      : `${loaded.expertId}:${loaded.currentRevision}`;
  const form: EditorForm =
    edit?.key === selectionKey
      ? edit.form
      : creating || loaded === null || loaded === undefined
        ? EMPTY_FORM
        : { title: loaded.title, persona: loaded.persona, skills: loaded.skillSelection };
  const updateForm = (update: (current: EditorForm) => EditorForm) => {
    setEdit({ key: selectionKey, form: update(form) });
  };

  const startNew = () => {
    setCreating(true);
    setSelectedId(null);
    setEdit(null);
    setError(null);
  };

  const selectExpert = (expertId: string) => {
    setCreating(false);
    setSelectedId(expertId);
    setEdit(null);
    setError(null);
  };

  const toggleSkill = (packageId: string, checked: boolean) => {
    updateForm((current) => {
      if (!checked) {
        return {
          ...current,
          skills: current.skills.filter((skill) => skill.packageId !== packageId),
        };
      }
      const installed = packages.find((entry) => entry.packageId === packageId);
      if (installed === undefined) return current;
      return {
        ...current,
        skills: [
          ...current.skills.filter((skill) => skill.packageId !== packageId),
          {
            packageId: installed.packageId,
            revision: installed.currentRevision,
            contentHash: installed.contentHash,
          },
        ],
      };
    });
  };

  const save = async () => {
    if (!canManage || pending !== null) return;
    if (form.title.trim().length === 0) {
      setError(mf(m("Give the expert a title.")));
      return;
    }
    setPending("save");
    setError(null);
    try {
      const content = {
        title: form.title.trim(),
        persona: form.persona,
        references: loaded?.references ?? [],
        skillSelection: form.skills,
        mcpGrants: loaded?.mcpGrants ?? [],
      };
      const result = await runSave({
        environmentId,
        input:
          loaded === null || loaded === undefined
            ? content
            : {
                ...content,
                expertId: loaded.expertId,
                expectedRevision: loaded.currentRevision,
              },
      });
      const failure = errorText(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      setCreating(false);
      setEdit(null);
      if (result._tag === "Success") {
        setSelectedId(result.value.expertId);
      }
      definitions.refresh();
      detail.refresh();
    } finally {
      setPending(null);
    }
  };

  const archive = async () => {
    if (!canManage || loaded === null || pending !== null) return;
    setPending("archive");
    setError(null);
    try {
      const result = await runArchive({
        environmentId,
        input: { expertId: loaded.expertId, expectedRevision: loaded.currentRevision },
      });
      const failure = errorText(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      definitions.refresh();
      detail.refresh();
    } finally {
      setPending(null);
    }
  };

  const importPackage = async () => {
    if (!canManage || pending !== null) return;
    const path = skillPath.trim();
    if (path.length === 0) {
      setError(mf(m("Enter the skill package directory on the server machine.")));
      return;
    }
    setPending("import");
    setError(null);
    try {
      const result = await runImport({ environmentId, input: { path } });
      const failure = errorText(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      setSkillPath("");
      skills.refresh();
    } finally {
      setPending(null);
    }
  };

  const archivePackage = async (packageId: string, expectedRevision: number) => {
    if (!canManage || pending !== null) return;
    setPending(`archive-skill:${packageId}`);
    setError(null);
    try {
      const result = await runArchiveSkill({
        environmentId,
        input: { packageId, expectedRevision },
      });
      const failure = errorText(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      skills.refresh();
      definitions.refresh();
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title={gt("Linx experts")}>
        <p className="px-4 pt-3 text-sm text-muted-foreground">
          {gt(
            "Experts freeze a persona and skill set into an immutable snapshot. Chats keep the snapshot they started with.",
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage || pending !== null}
            onClick={startNew}
          >
            {gt("New expert")}
          </Button>
          {definitions.isPending ? <Spinner /> : null}
        </div>
        <ul className="divide-y divide-border/60 border-t border-border/60">
          {experts.length === 0 && !definitions.isPending ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">
              {gt("No experts yet. Create one to use it from the composer.")}
            </li>
          ) : null}
          {experts.map((expert) => (
            <li key={expert.expertId}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/50"
                data-selected={!creating && selectedId === expert.expertId ? "true" : undefined}
                onClick={() => selectExpert(expert.expertId)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{expert.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <T>
                      v<Var>{expert.currentRevision}</Var> ·{" "}
                      <Var>{expert.contentHash.slice(0, 8)}</Var>
                    </T>
                  </span>
                </span>
                {expert.archived ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{gt("Archived")}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <SettingsSection title={creating ? gt("New expert") : (loaded?.title ?? gt("Expert editor"))}>
        <p className="px-4 pt-3 text-sm text-muted-foreground">
          {archived
            ? gt("This expert is archived. Existing chats keep their snapshot.")
            : gt("Saving appends a new immutable revision; saved chats do not move.")}
        </p>
        <div className="space-y-4 px-4 py-4">
          {!canManage ? (
            <p className="text-sm text-muted-foreground">
              {gt("Managing experts needs the providers:manage scope.")}
            </p>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{gt("Title")}</span>
            <Input
              value={form.title}
              disabled={!canManage || archived || pending !== null}
              onChange={(event) =>
                updateForm((current) => ({ ...current, title: event.target.value }))
              }
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{gt("Persona")}</span>
            <Textarea
              rows={8}
              value={form.persona}
              disabled={!canManage || archived || pending !== null}
              onChange={(event) =>
                updateForm((current) => ({ ...current, persona: event.target.value }))
              }
            />
          </label>
          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground">{gt("Skills")}</span>
            {packages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {gt("No skill packages imported yet.")}
              </p>
            ) : (
              <ul className="space-y-2">
                {packages.map((installed) => {
                  const selected = form.skills.find(
                    (skill) => skill.packageId === installed.packageId,
                  );
                  return (
                    <li key={installed.packageId} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected !== undefined}
                        disabled={!canManage || archived || pending !== null || installed.archived}
                        onCheckedChange={(checked) =>
                          toggleSkill(installed.packageId, checked === true)
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {installed.name}
                        <span className="ml-2 text-xs text-muted-foreground">
                          <T>
                            v<Var>{installed.currentRevision}</Var> ·{" "}
                            <Var>{installed.contentHash.slice(0, 8)}</Var>
                          </T>
                        </span>
                      </span>
                      {selected !== undefined && selected.revision !== installed.currentRevision ? (
                        <span className="text-xs text-muted-foreground">
                          <T>
                            frozen at v<Var>{selected.revision}</Var>
                          </T>
                        </span>
                      ) : null}
                      {installed.archived ? (
                        <span className="text-xs text-muted-foreground">{gt("Archived")}</span>
                      ) : (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={!canManage || pending !== null}
                          onClick={() =>
                            void archivePackage(installed.packageId, installed.currentRevision)
                          }
                        >
                          {gt("Archive")}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {loaded !== null && loaded !== undefined ? (
            <p className="text-xs text-muted-foreground">
              <T>
                Preserved from this revision: <Var>{loaded.references.length}</Var> references,{" "}
                <Var>{loaded.mcpGrants.length}</Var> MCP grants.
              </T>
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!canManage || archived || pending !== null}
              onClick={() => void save()}
            >
              {creating ? gt("Create expert") : gt("Save revision")}
            </Button>
            {!creating && loaded !== null && loaded !== undefined && !archived ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canManage || pending !== null}
                onClick={() => void archive()}
              >
                {gt("Archive expert")}
              </Button>
            ) : null}
            {pending !== null ? <Spinner /> : null}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={gt("Skill packages")}>
        <p className="px-4 pt-3 text-sm text-muted-foreground">
          {gt(
            "Import a directory containing linx-skill.json. Files are hashed and stored read-only.",
          )}
        </p>
        <div className="space-y-3 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              placeholder={gt("/path/to/skill-package")}
              value={skillPath}
              disabled={!canManage || pending !== null}
              onChange={(event) => setSkillPath(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || pending !== null}
              onClick={() => void importPackage()}
            >
              {gt("Import")}
            </Button>
          </div>
          <ul className="space-y-2">
            {packages.map((installed) => (
              <li key={installed.packageId} className="text-sm">
                <span className="font-medium">{installed.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  <T>
                    v<Var>{installed.currentRevision}</Var> ·{" "}
                    <Var>{installed.contentHash.slice(0, 8)}</Var>
                  </T>
                </span>
                {installed.archived ? (
                  <span className="ml-2 text-xs text-muted-foreground">{gt("Archived")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
