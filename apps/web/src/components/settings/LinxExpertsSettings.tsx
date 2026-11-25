import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type LinxMcpConnectionSummary,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useGT, useMessages, T, Var } from "gt-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import {
  archiveExpert,
  archiveSkill,
  disableConnection,
  importSkill,
  linxExpertDefinition,
  linxExpertDefinitions,
  linxMcpConnection,
  linxMcpConnections,
  linxSkillPackages,
  saveConnection,
  saveExpert,
  testConnection,
} from "../../state/linx";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { LinxSuiteSettings } from "./LinxSuiteSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface SkillChoice {
  readonly packageId: string;
  readonly revision: number;
  readonly contentHash: string;
}

interface GrantChoice {
  readonly connectionId: string;
  readonly revision: number;
  readonly tools: ReadonlyArray<string>;
}

interface EditorForm {
  readonly title: string;
  readonly persona: string;
  readonly skills: ReadonlyArray<SkillChoice>;
  readonly grants: ReadonlyArray<GrantChoice>;
}

const EMPTY_FORM: EditorForm = {
  title: "",
  persona: "",
  skills: [],
  grants: [],
};

export function LinxExpertsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const mf = useMessages();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const definitions = useEnvironmentQuery(linxExpertDefinitions({ environmentId, input: {} }));
  const skills = useEnvironmentQuery(linxSkillPackages({ environmentId, input: {} }));
  const connections = useEnvironmentQuery(linxMcpConnections({ environmentId, input: {} }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<{ readonly key: string; readonly form: EditorForm } | null>(
    null,
  );
  const [skillPath, setSkillPath] = useState("");
  const [connectionForm, setConnectionForm] = useState<{
    readonly connectionId?: string;
    readonly expectedRevision?: number;
    readonly name: string;
    readonly endpoint: string;
    readonly authMode: "none" | "bearer" | "keep";
    readonly bearerToken: string;
  }>({ name: "", endpoint: "", authMode: "none", bearerToken: "" });
  const [connectionTools, setConnectionTools] = useState<ReadonlyArray<string>>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
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
  const runSaveConnection = useAtomCommand(saveConnection, { reportFailure: false });
  const runTestConnection = useAtomCommand(testConnection, { reportFailure: false });
  const runDisableConnection = useAtomCommand(disableConnection, { reportFailure: false });
  const errorText = (result: AtomCommandResult<unknown, unknown> | null): string | null => {
    if (result?._tag !== "Failure") return null;
    return thrownErrorMessage(result.cause, mf) ?? mf(m("The request failed."));
  };

  const experts = definitions.data ?? [];
  const packages = skills.data ?? [];
  const mcpConnections = connections.data ?? [];
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
        : {
            title: loaded.title,
            persona: loaded.persona,
            skills: loaded.skillSelection,
            grants: loaded.mcpGrants,
          };
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
    if (form.grants.some((grant) => grant.tools.length === 0)) {
      setError(mf(m("Select at least one MCP tool for every granted connection.")));
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
        mcpGrants: form.grants,
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

  const testConnectionEndpoint = async () => {
    if (!canManage || pending !== null) return;
    const endpoint = connectionForm.endpoint.trim();
    if (endpoint.length === 0) {
      setConnectionError(mf(m("Enter an MCP endpoint.")));
      return;
    }
    if (connectionForm.authMode === "bearer" && connectionForm.bearerToken.trim().length === 0) {
      setConnectionError(mf(m("Enter the bearer token.")));
      return;
    }
    setPending("connection-test");
    setConnectionError(null);
    try {
      const result = await runTestConnection({
        environmentId,
        input: {
          endpoint,
          authMode: connectionForm.authMode === "bearer" ? "bearer" : "none",
          ...(connectionForm.authMode === "bearer"
            ? { bearerToken: connectionForm.bearerToken.trim() }
            : {}),
        },
      });
      const failure = errorText(result);
      if (failure !== null) {
        setConnectionError(failure);
        return;
      }
      setConnectionTools(
        result._tag === "Success" ? result.value.tools.map((tool) => tool.name) : [],
      );
    } finally {
      setPending(null);
    }
  };

  const saveConnectionDetails = async () => {
    if (!canManage || pending !== null) return;
    const name = connectionForm.name.trim();
    const endpoint = connectionForm.endpoint.trim();
    if (name.length === 0 || endpoint.length === 0) {
      setConnectionError(mf(m("Enter a connection name and endpoint.")));
      return;
    }
    if (connectionForm.authMode === "bearer" && connectionForm.bearerToken.trim().length === 0) {
      setConnectionError(mf(m("Enter the bearer token.")));
      return;
    }
    setPending("connection-save");
    setConnectionError(null);
    try {
      const result = await runSaveConnection({
        environmentId,
        input: {
          ...(connectionForm.connectionId === undefined
            ? {}
            : {
                connectionId: connectionForm.connectionId,
                expectedRevision: connectionForm.expectedRevision,
              }),
          name,
          endpoint,
          authMode: connectionForm.authMode,
          ...(connectionForm.authMode === "bearer"
            ? { bearerToken: connectionForm.bearerToken.trim() }
            : {}),
        },
      });
      const failure = errorText(result);
      if (failure !== null) {
        setConnectionError(failure);
        return;
      }
      setConnectionForm({ name: "", endpoint: "", authMode: "none", bearerToken: "" });
      setConnectionTools([]);
      connections.refresh();
      definitions.refresh();
    } finally {
      setPending(null);
    }
  };

  const editConnection = (connection: LinxMcpConnectionSummary) => {
    setConnectionError(null);
    setConnectionTools([]);
    setConnectionForm({
      connectionId: connection.connectionId,
      expectedRevision: connection.currentRevision,
      name: connection.name,
      endpoint: connection.endpoint,
      authMode: connection.authKind === "bearer" ? "keep" : "none",
      bearerToken: "",
    });
  };

  const disableSavedConnection = async (connection: LinxMcpConnectionSummary) => {
    if (!canManage || pending !== null) return;
    setPending(`connection-disable:${connection.connectionId}`);
    setConnectionError(null);
    try {
      const result = await runDisableConnection({
        environmentId,
        input: {
          connectionId: connection.connectionId,
          expectedRevision: connection.currentRevision,
        },
      });
      const failure = errorText(result);
      if (failure !== null) {
        setConnectionError(failure);
        return;
      }
      connections.refresh();
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
          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground">{gt("MCP tools")}</span>
            {mcpConnections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {gt("No MCP connections yet. Add one below, then grant its tools here.")}
              </p>
            ) : (
              <ul className="space-y-3">
                {mcpConnections.map((connection) => (
                  <McpGrantPicker
                    key={connection.connectionId}
                    environmentId={environmentId}
                    connection={connection}
                    grant={form.grants.find(
                      (grant) => grant.connectionId === connection.connectionId,
                    )}
                    disabled={!canManage || archived || pending !== null}
                    onChange={(next) =>
                      updateForm((current) => ({
                        ...current,
                        grants:
                          next === null
                            ? current.grants.filter(
                                (grant) => grant.connectionId !== connection.connectionId,
                              )
                            : [
                                ...current.grants.filter(
                                  (grant) => grant.connectionId !== connection.connectionId,
                                ),
                                next,
                              ],
                      }))
                    }
                  />
                ))}
              </ul>
            )}
          </div>
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

      <SettingsSection title={gt("MCP connections")}>
        <p className="px-4 pt-3 text-sm text-muted-foreground">
          {gt(
            "Only loopback or public HTTPS Streamable HTTP endpoints are accepted. Bearer tokens are stored in the macOS Keychain and never shown again.",
          )}
        </p>
        <div className="space-y-3 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              placeholder={gt("Connection name")}
              value={connectionForm.name}
              disabled={!canManage || pending !== null}
              onChange={(event) =>
                setConnectionForm((current) => ({ ...current, name: event.target.value }))
              }
            />
            <Input
              className="min-w-0 flex-[2]"
              placeholder={gt("http://127.0.0.1:3000/mcp")}
              value={connectionForm.endpoint}
              disabled={!canManage || pending !== null}
              onChange={(event) =>
                setConnectionForm((current) => ({ ...current, endpoint: event.target.value }))
              }
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={connectionForm.authMode}
              onValueChange={(value) => {
                if (value === "none" || value === "bearer" || value === "keep") {
                  setConnectionForm((current) => ({ ...current, authMode: value }));
                }
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Authentication")}>
                <SelectValue>
                  {(value: "none" | "bearer" | "keep" | null) =>
                    value === "bearer"
                      ? gt("Bearer token")
                      : value === "keep"
                        ? gt("Keep current token")
                        : gt("No authentication")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start">
                <SelectItem value="none">{gt("No authentication")}</SelectItem>
                <SelectItem value="bearer">{gt("Bearer token")}</SelectItem>
                {connectionForm.connectionId === undefined ? null : (
                  <SelectItem value="keep">{gt("Keep current token")}</SelectItem>
                )}
              </SelectPopup>
            </Select>
            {connectionForm.authMode === "bearer" ? (
              <Input
                className="min-w-0 flex-1"
                type="password"
                autoComplete="off"
                placeholder={gt("Bearer token")}
                value={connectionForm.bearerToken}
                disabled={!canManage || pending !== null}
                onChange={(event) =>
                  setConnectionForm((current) => ({
                    ...current,
                    bearerToken: event.target.value,
                  }))
                }
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || pending !== null}
              onClick={() => void testConnectionEndpoint()}
            >
              {gt("Test")}
            </Button>
            <Button
              size="sm"
              disabled={!canManage || pending !== null}
              onClick={() => void saveConnectionDetails()}
            >
              {connectionForm.connectionId === undefined
                ? gt("Add connection")
                : gt("Save connection")}
            </Button>
            {connectionForm.connectionId !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canManage || pending !== null}
                onClick={() => {
                  setConnectionForm({
                    name: "",
                    endpoint: "",
                    authMode: "none",
                    bearerToken: "",
                  });
                  setConnectionTools([]);
                  setConnectionError(null);
                }}
              >
                {gt("Cancel edit")}
              </Button>
            ) : null}
            {pending?.startsWith("connection") ? <Spinner /> : null}
          </div>
          {connectionTools.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>
                Approved tools: <Var>{connectionTools.join(", ")}</Var>
              </T>
            </p>
          ) : null}
          {connectionError !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {connectionError}
            </p>
          ) : null}
          <ul className="divide-y divide-border/60">
            {mcpConnections.length === 0 ? (
              <li className="py-2 text-sm text-muted-foreground">
                {gt("No MCP connections configured.")}
              </li>
            ) : null}
            {mcpConnections.map((connection) => (
              <li key={connection.connectionId} className="flex items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {connection.name}
                    {connection.disabled ? (
                      <span className="ml-2 text-xs text-muted-foreground">{gt("Disabled")}</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <T>
                      v<Var>{connection.currentRevision}</Var> · <Var>{connection.toolCount}</Var>{" "}
                      tools ·{" "}
                      <Var>{connection.authKind === "bearer" ? gt("Bearer") : gt("No auth")}</Var> ·{" "}
                      <Var>{connection.endpoint}</Var>
                    </T>
                  </span>
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canManage || pending !== null}
                  onClick={() => editConnection(connection)}
                >
                  {gt("Edit")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canManage || pending !== null || connection.disabled}
                  onClick={() => void disableSavedConnection(connection)}
                >
                  {gt("Disable")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </SettingsSection>

      <LinxSuiteSettings environmentId={environmentId} experts={experts} />

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

function McpGrantPicker({
  environmentId,
  connection,
  grant,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: LinxMcpConnectionSummary;
  readonly grant: GrantChoice | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: GrantChoice | null) => void;
}) {
  const gt = useGT();
  const detail = useEnvironmentQuery(
    grant === undefined
      ? null
      : linxMcpConnection({
          environmentId,
          input: { connectionId: connection.connectionId },
        }),
  );
  const tools = detail.data?.tools ?? [];
  const unavailable = disabled || connection.disabled;
  return (
    <li className="space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={grant !== undefined}
          disabled={unavailable}
          onCheckedChange={(checked) =>
            onChange(
              checked === true
                ? {
                    connectionId: connection.connectionId,
                    revision: connection.currentRevision,
                    tools: [],
                  }
                : null,
            )
          }
        />
        <span className="min-w-0 flex-1 truncate">
          {connection.name}
          <span className="ml-2 text-xs text-muted-foreground">
            <T>
              v<Var>{connection.currentRevision}</Var> · <Var>{connection.toolCount}</Var> tools
            </T>
          </span>
        </span>
        {connection.disabled ? (
          <span className="text-xs text-muted-foreground">{gt("Disabled")}</span>
        ) : null}
        {grant !== undefined && grant.revision !== connection.currentRevision ? (
          <span className="text-xs text-muted-foreground">
            <T>
              frozen at v<Var>{grant.revision}</Var>
            </T>
          </span>
        ) : null}
      </div>
      {grant === undefined ? null : detail.isPending ? (
        <p className="pl-6 text-xs text-muted-foreground">{gt("Loading tools…")}</p>
      ) : detail.error ? (
        <p className="pl-6 text-xs text-destructive">{gt("Tools could not be loaded.")}</p>
      ) : (
        <ul className="space-y-1 pl-6">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-center gap-2">
              <Checkbox
                checked={grant.tools.includes(tool.name)}
                disabled={unavailable}
                onCheckedChange={(checked) =>
                  onChange({
                    ...grant,
                    tools:
                      checked === true
                        ? [...grant.tools, tool.name].sort()
                        : grant.tools.filter((name) => name !== tool.name),
                  })
                }
              />
              <span className="min-w-0 truncate">{tool.name}</span>
              {tool.description.length > 0 ? (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {tool.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
