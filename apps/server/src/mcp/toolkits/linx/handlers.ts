// @effect-diagnostics globalJsonInEffect:off - structuredContent came from JSON.parse and cannot cycle.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Ajv } from "ajv";
import * as Effect from "effect/Effect";

import * as ExpertSnapshotService from "../../../linx/expert/ExpertSnapshotService.ts";
import * as ExternalMcpClient from "../../../linx/mcp/ExternalMcpClient.ts";
import * as McpConnectionService from "../../../linx/mcp/McpConnectionService.ts";
import * as SecretStore from "../../../linx/secret/SecretStore.ts";
import type { LinxExpertSnapshot } from "../../../linx/expert/ExpertSnapshotService.ts";
import * as SkillPackageService from "../../../linx/skill/SkillPackageService.ts";
import * as ThreadBindingRepository from "../../../linx/thread/ThreadBindingRepository.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LinxExpertContextToolkit, LinxMcpToolkit, LinxSkillToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const PAGE_SIZE = 20;

const resolveContext = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return yield* invalid("This tool requires a Linx thread.");
  }
  const bindings = yield* ThreadBindingRepository.ThreadBindingRepository;
  const binding = yield* bindings
    .getBinding(scope.thread.threadId)
    .pipe(Effect.mapError(() => invalid("The Linx thread binding could not be read.")));
  if (binding === null) {
    return yield* invalid("This thread has no Linx expert binding.");
  }
  const snapshots = yield* ExpertSnapshotService.ExpertSnapshotService;
  const snapshot = yield* snapshots
    .getById(binding.snapshotId)
    .pipe(
      Effect.mapError((error) =>
        error._tag === "LinxSnapshotIntegrityError"
          ? invalid("The Linx expert snapshot failed its integrity check.")
          : invalid("The Linx expert snapshot could not be read."),
      ),
    );
  if (snapshot === null) {
    return yield* invalid("The Linx expert snapshot no longer exists.");
  }
  return snapshot satisfies LinxExpertSnapshot;
});

interface SkillMatch {
  readonly packageId: string;
  readonly revision: number;
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly sha256: string;
}

const searchSkills = Effect.fn("linx.skillSearch")(function* (input: {
  readonly query: string;
  readonly cursor?: string;
}) {
  const query = input.query.trim();
  if (query.length === 0 || query.length > 128) {
    return yield* invalid("The skill search query must be between 1 and 128 characters.");
  }
  const offsetText = input.cursor === undefined || input.cursor === "" ? "0" : input.cursor;
  if (!/^\d{1,6}$/.test(offsetText)) {
    return yield* invalid("The skill search cursor is invalid.");
  }
  const offset = Number(offsetText);
  const snapshot = yield* resolveContext;
  const skills = yield* SkillPackageService.SkillPackageService;
  const needle = query.toLowerCase();
  const matches = new Map<string, SkillMatch>();
  for (const choice of snapshot.skillSelection) {
    const installed = yield* skills
      .get(choice.packageId, choice.revision)
      .pipe(Effect.mapError(() => invalid("A selected skill package could not be read.")));
    const revision = installed?.revisions.find((entry) => entry.revision === choice.revision);
    if (
      installed === null ||
      revision === undefined ||
      revision.contentHash !== choice.contentHash
    ) {
      return yield* invalid("A selected skill package is missing or its hash changed.");
    }
    const files = yield* skills
      .filesFor(choice.packageId, choice.revision, choice.contentHash)
      .pipe(
        Effect.mapError(() => invalid("A selected skill package is missing or its hash changed.")),
      );
    const packageMatches =
      installed.name.toLowerCase().includes(needle) ||
      revision.version.toLowerCase().includes(needle) ||
      choice.packageId.toLowerCase().includes(needle);
    if (packageMatches) {
      const entry = files.find((candidate) => candidate.path === revision.entryPath);
      if (entry !== undefined) {
        matches.set(`${choice.packageId}\0${entry.path}`, {
          packageId: choice.packageId,
          revision: choice.revision,
          name: installed.name,
          version: revision.version,
          path: entry.path,
          sha256: entry.sha256,
        });
      }
      continue;
    }
    for (const file of files) {
      if (!file.path.toLowerCase().includes(needle)) continue;
      matches.set(`${choice.packageId}\0${file.path}`, {
        packageId: choice.packageId,
        revision: choice.revision,
        name: installed.name,
        version: revision.version,
        path: file.path,
        sha256: file.sha256,
      });
    }
  }
  const ordered = [...matches.values()].sort(
    (left, right) =>
      left.packageId.localeCompare(right.packageId) || left.path.localeCompare(right.path),
  );
  const page = ordered.slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE < ordered.length ? String(offset + PAGE_SIZE) : null;
  return { matches: page, nextCursor: next };
});

const readSkill = Effect.fn("linx.skillRead")(function* (input: {
  readonly packageId: string;
  readonly path?: string;
}) {
  const snapshot = yield* resolveContext;
  const choice = snapshot.skillSelection.find((entry) => entry.packageId === input.packageId);
  if (choice === undefined) {
    return yield* invalid("This skill package is not selected by the thread's expert snapshot.");
  }
  const skills = yield* SkillPackageService.SkillPackageService;
  const file = yield* skills
    .readFile({
      packageId: choice.packageId,
      revision: choice.revision,
      contentHash: choice.contentHash,
      ...(input.path === undefined ? {} : { relativePath: input.path }),
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "LinxDependencyMissingError"
          ? invalid("The skill file is missing or does not belong to the frozen package.")
          : invalid("The skill file could not be read."),
      ),
    );
  return {
    packageId: choice.packageId,
    revision: choice.revision,
    path: file.path,
    content: file.content,
    sha256: file.sha256,
    bytes: file.bytes,
  };
});

export const layer = McpToolAccess.toLayer(LinxExpertContextToolkit, {
  linx_expert_context: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const snapshot = yield* resolveContext;
      return {
        snapshotId: snapshot.snapshotId,
        expertId: snapshot.expertId,
        revision: snapshot.revision,
        contentHash: snapshot.contentHash,
        persona: snapshot.persona,
        references: snapshot.references,
        skillSelection: snapshot.skillSelection,
        mcpGrants: snapshot.mcpGrants,
      };
    }),
  ),
});

export const skillLayer = McpToolAccess.toLayer(LinxSkillToolkit, {
  linx_skill_search: McpToolAccess.readsAsCaller((input) => searchSkills(input)),
  linx_skill_read: McpToolAccess.readsAsCaller((input) => readSkill(input)),
});

const schemaValidators = new Map<string, (data: unknown) => boolean>();
const ajv = new Ajv({ allErrors: false, strict: false, allowUnionTypes: true });

const validatorFor = (schemaHash: string, schema: unknown) => {
  const cached = schemaValidators.get(schemaHash);
  if (cached !== undefined) return cached;
  const compiled = ajv.compile(schema as object);
  const validate = (data: unknown) => compiled(data) === true;
  schemaValidators.set(schemaHash, validate);
  return validate;
};

const listMcpTools = Effect.gen(function* () {
  const snapshot = yield* resolveContext;
  const connections = yield* McpConnectionService.McpConnectionService;
  const result: Array<{
    connectionId: string;
    name: string;
    tools: Array<{ name: string; description: string }>;
  }> = [];
  for (const grant of snapshot.mcpGrants) {
    const resolved = yield* connections
      .resolveRevision(grant.connectionId, grant.revision)
      .pipe(Effect.mapError(() => invalid("The granted MCP connection could not be read.")));
    if (resolved === null) {
      return yield* invalid("A granted MCP connection no longer exists at its frozen revision.");
    }
    if (resolved.disabled) {
      return yield* invalid("A granted MCP connection has been disabled.");
    }
    const allowed = resolved.tools.filter((tool) => grant.tools.includes(tool.name));
    if (allowed.length !== grant.tools.length) {
      return yield* invalid("A granted MCP tool no longer exists in the frozen connection.");
    }
    result.push({
      connectionId: resolved.connectionId,
      name: resolved.name,
      tools: allowed.map((tool) => ({ name: tool.name, description: tool.description })),
    });
  }
  return { connections: result };
});

const callMcpTool = Effect.fn("linx.mcpCall")(function* (input: {
  readonly connectionId: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}) {
  const snapshot = yield* resolveContext;
  const grant = snapshot.mcpGrants.find((entry) => entry.connectionId === input.connectionId);
  if (grant === undefined) {
    return yield* invalid("This MCP connection is not granted to the thread's expert snapshot.");
  }
  if (!grant.tools.includes(input.tool)) {
    return yield* invalid("This MCP tool is not granted to the thread's expert snapshot.");
  }
  const connections = yield* McpConnectionService.McpConnectionService;
  const resolved = yield* connections
    .resolveRevision(grant.connectionId, grant.revision)
    .pipe(Effect.mapError(() => invalid("The granted MCP connection could not be read.")));
  if (resolved === null) {
    return yield* invalid("The granted MCP connection no longer exists at its frozen revision.");
  }
  if (resolved.disabled) {
    return yield* invalid("The granted MCP connection has been disabled.");
  }
  const tool = resolved.tools.find((entry) => entry.name === input.tool);
  if (tool === undefined) {
    return yield* invalid("The MCP tool no longer exists in the frozen connection.");
  }
  const validate = yield* Effect.try({
    try: () => validatorFor(tool.schemaHash, tool.inputSchema),
    catch: () => invalid("The MCP tool schema is not usable."),
  });
  if (!validate(input.arguments)) {
    return yield* invalid("The MCP tool arguments do not match the approved schema.");
  }
  const secrets = yield* SecretStore.SecretStore;
  let bearerToken: string | undefined;
  if (resolved.authKind === "bearer") {
    if (resolved.secretRef === null) {
      return yield* invalid("The MCP credential reference is missing.");
    }
    const value = yield* secrets
      .resolve(resolved.secretRef)
      .pipe(Effect.mapError(() => invalid("The MCP credential could not be read.")));
    if (value === null) {
      return yield* invalid("The MCP credential is no longer available.");
    }
    bearerToken = value;
  }
  const client = yield* ExternalMcpClient.ExternalMcpClient;
  const result = yield* client
    .callTool({
      endpoint: resolved.endpoint,
      tool: tool.name,
      arguments: input.arguments,
      ...(bearerToken === undefined ? {} : { bearerToken }),
    })
    .pipe(
      Effect.mapError((error) =>
        error.category === "unauthorized"
          ? invalid("The MCP endpoint rejected the request.")
          : invalid("The MCP endpoint could not be reached."),
      ),
    );
  const stillAllowed = yield* connections
    .resolveRevision(grant.connectionId, grant.revision)
    .pipe(Effect.mapError(() => invalid("The granted MCP connection could not be re-read.")));
  if (stillAllowed === null || stillAllowed.disabled) {
    return yield* invalid("The MCP connection was revoked while the call was running.");
  }
  if (
    bearerToken !== undefined &&
    (result.text.includes(bearerToken) ||
      JSON.stringify(result.structuredContent ?? null).includes(bearerToken))
  ) {
    return yield* invalid("The MCP result contained a credential and was discarded.");
  }
  return {
    connectionId: resolved.connectionId,
    tool: tool.name,
    text: result.text,
    structuredContent: result.structuredContent,
    isError: result.isError,
  };
});

export const mcpLayer = McpToolAccess.toLayer(LinxMcpToolkit, {
  linx_mcp_list_tools: McpToolAccess.readsAsCaller(() => listMcpTools),
  linx_mcp_call: McpToolAccess.readsAsCaller((input) => callMcpTool(input)),
});
