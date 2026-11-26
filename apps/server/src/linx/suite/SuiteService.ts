// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - suite snapshots store our own canonical JSON.
// @effect-diagnostics nodeBuiltinImport:off - suite snapshot hashes use node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import * as Schema from "effect/Schema";

import { LinxSuitePolicy } from "@t3tools/contracts";

import type {
  ModelSelection,
  LinxSaveSuiteInput,
  LinxSuiteDetail,
  LinxSuiteMember,
  LinxSuiteMemberInput,
  LinxSuiteSummary,
} from "@t3tools/contracts";

import {
  LinxDependencyMissingError,
  LinxDefinitionArchivedError,
  LinxDefinitionMissingError,
  LinxRevisionConflictError,
  LinxSnapshotIntegrityError,
  LinxStorageError,
} from "../persistence/Errors.ts";
import { LinxSqlClient } from "../persistence/LinxSqlite.ts";
import { ExpertSnapshotService } from "../expert/ExpertSnapshotService.ts";

export interface LinxSuiteSnapshotMember {
  readonly memberKey: string;
  readonly title: string;
  readonly expertId: string;
  readonly revision: number;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly modelSelection?: NonNullable<LinxSuiteMemberInput["modelSelection"]>;
  readonly runtimeMode?: NonNullable<LinxSuiteMemberInput["runtimeMode"]>;
  readonly interactionMode?: NonNullable<LinxSuiteMemberInput["interactionMode"]>;
}

export interface LinxSuiteSnapshotContent {
  readonly version: 1;
  readonly suiteId: string;
  readonly suiteRevision: number;
  readonly name?: string;
  readonly lead: {
    readonly expertId: string;
    readonly revision: number;
    readonly snapshotId: string;
    readonly contentHash: string;
  };
  readonly leadModelSelection?: ModelSelection;
  readonly members: ReadonlyArray<LinxSuiteSnapshotMember>;
  readonly policy: LinxSuitePolicy;
}

export interface LinxSuiteSnapshot {
  readonly suiteSnapshotId: string;
  readonly content: LinxSuiteSnapshotContent;
  readonly contentHash: string;
  readonly createdAt: string;
}

interface DefinitionRow {
  readonly suite_id: string;
  readonly name: string;
  readonly current_revision: number;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionRow {
  readonly suite_id: string;
  readonly revision: number;
  readonly lead_expert_id: string;
  readonly lead_expert_revision: number;
  readonly members_json: string;
  readonly policy_json: string;
  readonly created_at: string;
}

interface SnapshotRow {
  readonly suite_snapshot_id: string;
  readonly suite_id: string;
  readonly revision: number;
  readonly content_json: string;
  readonly content_hash: string;
  readonly created_at: string;
}

const canonicalJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const validateMembers = Effect.fn("SuiteService.validateMembers")(function* (
  members: ReadonlyArray<LinxSuiteMemberInput>,
) {
  if (members.length === 0) {
    return yield* new LinxDependencyMissingError({
      entity: "suite",
      id: "members",
      category: "member-required",
    });
  }
  if (members.length > 8) {
    return yield* new LinxDependencyMissingError({
      entity: "suite",
      id: "members",
      category: "too-many-members",
    });
  }
  const keys = new Set<string>();
  for (const member of members) {
    if (keys.has(member.memberKey)) {
      return yield* new LinxDependencyMissingError({
        entity: "suite",
        id: member.memberKey,
        category: "duplicate-member-key",
      });
    }
    keys.add(member.memberKey);
  }
});

export class LinxSuitePolicyError extends Schema.TaggedError<LinxSuitePolicyError>()(
  "LinxSuitePolicyError",
  { message: Schema.String },
) {}

const decodePolicy = Schema.decodeUnknownOption(LinxSuitePolicy);
const normalizedPolicy = (policy: LinxSuitePolicy): Required<LinxSuitePolicy> => ({
  maxActiveDelegations: Math.min(4, Math.max(1, policy.maxActiveDelegations)),
  sandbox: policy.sandbox ?? "read-only",
  workspaceIsolation: policy.workspaceIsolation ?? "shared",
  approval: policy.approval ?? "never",
});

const validatePolicy = (policy: Required<LinxSuitePolicy>) =>
  policy.sandbox === "workspace-write" && policy.workspaceIsolation !== "worktree"
    ? new LinxSuitePolicyError({ message: "Workspace writes require a dedicated child worktree." })
    : undefined;

const parseMembers = (row: RevisionRow): ReadonlyArray<LinxSuiteMemberInput> =>
  JSON.parse(row.members_json) as ReadonlyArray<LinxSuiteMemberInput>;
const parsePolicy = (row: RevisionRow): LinxSuitePolicy =>
  JSON.parse(row.policy_json) as LinxSuitePolicy;

export class SuiteService extends Context.Service<
  SuiteService,
  {
    readonly save: (
      input: LinxSaveSuiteInput,
    ) => Effect.Effect<
      LinxSuiteDetail,
      | LinxDependencyMissingError
      | LinxDefinitionMissingError
      | LinxSuitePolicyError
      | LinxDefinitionArchivedError
      | LinxRevisionConflictError
      | LinxSnapshotIntegrityError
      | LinxStorageError
      | SqlError.SqlError
    >;
    readonly list: () => Effect.Effect<
      ReadonlyArray<LinxSuiteSummary>,
      LinxStorageError | SqlError.SqlError
    >;
    readonly get: (
      suiteId: string,
    ) => Effect.Effect<
      LinxSuiteDetail | null,
      LinxDependencyMissingError | LinxSnapshotIntegrityError | LinxStorageError | SqlError.SqlError
    >;
    readonly archive: (
      suiteId: string,
      expectedRevision: number,
    ) => Effect.Effect<
      LinxSuiteSummary,
      LinxDefinitionMissingError | LinxRevisionConflictError | LinxStorageError | SqlError.SqlError
    >;
    readonly freeze: (
      suiteId: string,
      revision?: number,
      leadModelSelection?: ModelSelection,
    ) => Effect.Effect<
      LinxSuiteSnapshot,
      | LinxDependencyMissingError
      | LinxDefinitionMissingError
      | LinxDefinitionArchivedError
      | LinxDependencyMissingError
      | LinxSnapshotIntegrityError
      | LinxStorageError
      | SqlError.SqlError
    >;
    readonly getSnapshot: (
      suiteSnapshotId: string,
    ) => Effect.Effect<
      LinxSuiteSnapshot | null,
      LinxSnapshotIntegrityError | LinxStorageError | SqlError.SqlError
    >;
  }
>()("t3/linx/suite/SuiteService") {}

export const layer = Layer.effect(
  SuiteService,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;
    const snapshots = yield* ExpertSnapshotService;

    const selectDefinition = (suiteId: string) =>
      sql<DefinitionRow>`
        SELECT suite_id, name, current_revision, archived_at, created_at, updated_at
        FROM suite_definitions WHERE suite_id = ${suiteId}
      `;
    const selectRevision = (suiteId: string, revision: number) =>
      sql<RevisionRow>`
        SELECT suite_id, revision, lead_expert_id, lead_expert_revision, members_json,
               policy_json, created_at
        FROM suite_revisions WHERE suite_id = ${suiteId} AND revision = ${revision}
      `;
    const selectSnapshot = (suiteSnapshotId: string) =>
      sql<SnapshotRow>`
        SELECT suite_snapshot_id, suite_id, revision, content_json, content_hash, created_at
        FROM suite_snapshots WHERE suite_snapshot_id = ${suiteSnapshotId}
      `;

    const resolveMember = Effect.fn("SuiteService.resolveMember")(function* (
      member: LinxSuiteMemberInput,
    ) {
      const snapshot = yield* snapshots.getByRevision(member.expertId, member.revision);
      if (snapshot === null) {
        return yield* new LinxDependencyMissingError({
          entity: "expert",
          id: `${member.expertId}@${member.revision}`,
          category: "member-snapshot-missing",
        });
      }
      return {
        memberKey: member.memberKey,
        title: member.title ?? member.memberKey,
        expertId: member.expertId,
        revision: member.revision,
        snapshotId: snapshot.snapshotId,
        contentHash: snapshot.contentHash,
        ...(member.modelSelection === undefined ? {} : { modelSelection: member.modelSelection }),
        ...(member.runtimeMode === undefined ? {} : { runtimeMode: member.runtimeMode }),
        ...(member.interactionMode === undefined
          ? {}
          : { interactionMode: member.interactionMode }),
      } satisfies LinxSuiteSnapshotMember;
    });

    const detailFrom = Effect.fn("SuiteService.detailFrom")(function* (
      definition: DefinitionRow,
      revision: RevisionRow,
    ) {
      const lead = yield* snapshots.getByRevision(
        revision.lead_expert_id,
        revision.lead_expert_revision,
      );
      if (lead === null) {
        return yield* new LinxDependencyMissingError({
          entity: "expert",
          id: `${revision.lead_expert_id}@${revision.lead_expert_revision}`,
          category: "lead-snapshot-missing",
        });
      }
      const members: LinxSuiteMember[] = [];
      for (const member of parseMembers(revision)) {
        const resolved = yield* resolveMember(member);
        members.push(resolved);
      }
      return {
        suiteId: definition.suite_id,
        name: definition.name,
        currentRevision: definition.current_revision,
        leadExpertId: revision.lead_expert_id,
        leadExpertRevision: revision.lead_expert_revision,
        leadSnapshotId: lead.snapshotId,
        memberCount: members.length,
        archived: definition.archived_at !== null,
        updatedAt: definition.updated_at,
        members,
        policy: parsePolicy(revision),
      } satisfies LinxSuiteDetail;
    });

    const save = Effect.fn("SuiteService.save")(function* (input: LinxSaveSuiteInput) {
      yield* validateMembers(input.members);
      const lead = yield* snapshots.getByRevision(input.leadExpertId, input.leadExpertRevision);
      if (lead === null) {
        return yield* new LinxDependencyMissingError({
          entity: "expert",
          id: `${input.leadExpertId}@${input.leadExpertRevision}`,
          category: "lead-snapshot-missing",
        });
      }
      for (const member of input.members) {
        const resolved = yield* snapshots.getByRevision(member.expertId, member.revision);
        if (resolved === null) {
          return yield* new LinxDependencyMissingError({
            entity: "expert",
            id: `${member.expertId}@${member.revision}`,
            category: "member-snapshot-missing",
          });
        }
      }
      const policy = normalizedPolicy(input.policy);
      const rejected = validatePolicy(policy);
      if (rejected !== undefined) return yield* rejected;
      const membersJson = JSON.stringify(input.members);
      const policyJson = JSON.stringify(policy);
      const name = input.name.trim();

      if (input.suiteId === undefined) {
        const suiteId = `suite_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
                INSERT INTO suite_definitions
                  (suite_id, name, current_revision, archived_at, created_at, updated_at)
                VALUES (${suiteId}, ${name}, 1, NULL, ${now}, ${now})
              `;
              yield* sql`
                INSERT INTO suite_revisions
                  (suite_id, revision, lead_expert_id, lead_expert_revision, members_json,
                   policy_json, created_at)
                VALUES (${suiteId}, 1, ${input.leadExpertId}, ${input.leadExpertRevision},
                        ${membersJson}, ${policyJson}, ${now})
              `;
              const definition = (yield* selectDefinition(suiteId))[0];
              const revision = (yield* selectRevision(suiteId, 1))[0];
              if (definition === undefined || revision === undefined) {
                return yield* new LinxStorageError({
                  operation: "read",
                  entity: "suite_definitions",
                  category: "missing-after-insert",
                });
              }
              return yield* detailFrom(definition, revision);
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "SqlError"
                ? new LinxStorageError({
                    operation: "write",
                    entity: "suite_definitions",
                    category: "insert-failed",
                  })
                : cause,
            ),
          );
      }

      const suiteId = input.suiteId;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const definition = (yield* selectDefinition(suiteId))[0];
          if (definition === undefined) {
            return yield* new LinxDefinitionMissingError({ entity: "suite", id: suiteId });
          }
          if (definition.archived_at !== null) {
            return yield* new LinxDefinitionArchivedError({ entity: "suite", id: suiteId });
          }
          if (input.expectedRevision !== definition.current_revision) {
            return yield* new LinxRevisionConflictError({
              entity: "suite",
              expectedRevision: input.expectedRevision ?? definition.current_revision,
              actualRevision: definition.current_revision,
            });
          }
          const nextRevision = definition.current_revision + 1;
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO suite_revisions
              (suite_id, revision, lead_expert_id, lead_expert_revision, members_json,
               policy_json, created_at)
            VALUES (${suiteId}, ${nextRevision}, ${input.leadExpertId},
                    ${input.leadExpertRevision}, ${membersJson}, ${policyJson}, ${now})
          `;
          const updated = yield* sql<{ readonly revision: number }>`
            UPDATE suite_definitions
            SET name = ${name}, current_revision = ${nextRevision}, updated_at = ${now}
            WHERE suite_id = ${suiteId} AND current_revision = ${definition.current_revision}
            RETURNING current_revision AS revision
          `;
          if (updated.length === 0) {
            return yield* new LinxRevisionConflictError({
              entity: "suite",
              expectedRevision: definition.current_revision,
              actualRevision: definition.current_revision,
            });
          }
          const fresh = (yield* selectDefinition(suiteId))[0];
          const revision = (yield* selectRevision(suiteId, nextRevision))[0];
          if (fresh === undefined || revision === undefined) {
            return yield* new LinxStorageError({
              operation: "read",
              entity: "suite_definitions",
              category: "missing-after-update",
            });
          }
          return yield* detailFrom(fresh, revision);
        }),
      );
    });

    const list = Effect.fn("SuiteService.list")(function* () {
      const rows = yield* sql<
        DefinitionRow & { readonly members_json: string; readonly lead_expert_id: string }
      >`
        SELECT d.suite_id, d.name, d.current_revision, d.archived_at, d.created_at,
               d.updated_at, r.members_json, r.lead_expert_id
        FROM suite_definitions AS d
        INNER JOIN suite_revisions AS r
          ON r.suite_id = d.suite_id AND r.revision = d.current_revision
        ORDER BY d.name, d.suite_id
      `;
      return rows.map((row) => ({
        suiteId: row.suite_id,
        name: row.name,
        currentRevision: row.current_revision,
        leadExpertId: row.lead_expert_id,
        memberCount: (JSON.parse(row.members_json) as ReadonlyArray<unknown>).length,
        archived: row.archived_at !== null,
        updatedAt: row.updated_at,
      }));
    });

    const get = Effect.fn("SuiteService.get")(function* (suiteId: string) {
      const definition = (yield* selectDefinition(suiteId))[0];
      if (definition === undefined) return null;
      const revision = (yield* selectRevision(suiteId, definition.current_revision))[0];
      if (revision === undefined) {
        return yield* new LinxStorageError({
          operation: "query",
          entity: "suite_revisions",
          category: "current-revision-missing",
        });
      }
      return yield* detailFrom(definition, revision);
    });

    const archive = Effect.fn("SuiteService.archive")(function* (
      suiteId: string,
      expectedRevision: number,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* sql<{ readonly revision: number }>`
        UPDATE suite_definitions
        SET archived_at = ${now}, updated_at = ${now}
        WHERE suite_id = ${suiteId} AND current_revision = ${expectedRevision}
        RETURNING current_revision AS revision
      `;
      if (updated.length === 0) {
        const definition = (yield* selectDefinition(suiteId))[0];
        if (definition === undefined) {
          return yield* new LinxDefinitionMissingError({ entity: "suite", id: suiteId });
        }
        return yield* new LinxRevisionConflictError({
          entity: "suite",
          expectedRevision,
          actualRevision: definition.current_revision,
        });
      }
      const definition = (yield* selectDefinition(suiteId))[0];
      const revision = (yield* selectRevision(suiteId, expectedRevision))[0];
      if (definition === undefined || revision === undefined) {
        return yield* new LinxStorageError({
          operation: "read",
          entity: "suite_definitions",
          category: "missing-after-archive",
        });
      }
      return {
        suiteId: definition.suite_id,
        name: definition.name,
        currentRevision: definition.current_revision,
        leadExpertId: revision.lead_expert_id,
        memberCount: parseMembers(revision).length,
        archived: definition.archived_at !== null,
        updatedAt: definition.updated_at,
      };
    });

    const freeze = Effect.fn("SuiteService.freeze")(function* (
      suiteId: string,
      revision?: number,
      leadModelSelection?: ModelSelection,
    ) {
      const definition = (yield* selectDefinition(suiteId))[0];
      if (definition === undefined) {
        return yield* new LinxDefinitionMissingError({ entity: "suite", id: suiteId });
      }
      if (definition.archived_at !== null) {
        return yield* new LinxDefinitionArchivedError({ entity: "suite", id: suiteId });
      }
      const targetRevision = revision ?? definition.current_revision;
      const row = (yield* selectRevision(suiteId, targetRevision))[0];
      if (row === undefined) {
        return yield* new LinxDefinitionMissingError({
          entity: "suite revision",
          id: `${suiteId}@${targetRevision}`,
        });
      }
      const lead = yield* snapshots.getByRevision(row.lead_expert_id, row.lead_expert_revision);
      if (lead === null) {
        return yield* new LinxDependencyMissingError({
          entity: "expert",
          id: `${row.lead_expert_id}@${row.lead_expert_revision}`,
          category: "lead-snapshot-missing",
        });
      }
      const members: LinxSuiteSnapshotMember[] = [];
      for (const member of parseMembers(row)) {
        members.push(yield* resolveMember(member));
      }
      members.sort((left, right) => left.memberKey.localeCompare(right.memberKey));
      const content: LinxSuiteSnapshotContent = {
        version: 1,
        suiteId,
        suiteRevision: targetRevision,
        name: definition.name,
        lead: {
          expertId: lead.expertId,
          revision: lead.revision,
          snapshotId: lead.snapshotId,
          contentHash: lead.contentHash,
        },
        ...(leadModelSelection === undefined ? {} : { leadModelSelection }),
        members,
        policy: normalizedPolicy(parsePolicy(row)),
      };
      const contentJson = canonicalJson(content);
      const contentHash = sha256(`linx-suite/1\0${contentJson}`);
      const suiteSnapshotId = `ssnap_${contentHash.slice(0, 32)}`;
      const now = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* sql<SnapshotRow>`
        INSERT INTO suite_snapshots
          (suite_snapshot_id, suite_id, revision, content_json, content_hash, created_at)
        VALUES (${suiteSnapshotId}, ${suiteId}, ${targetRevision}, ${contentJson},
                ${contentHash}, ${now})
        ON CONFLICT(suite_snapshot_id) DO NOTHING
        RETURNING suite_snapshot_id, suite_id, revision, content_json, content_hash, created_at
      `;
      const stored = inserted[0] ?? (yield* selectSnapshot(suiteSnapshotId))[0];
      if (stored === undefined) {
        return yield* new LinxStorageError({
          operation: "write",
          entity: "suite_snapshots",
          category: "missing-after-insert",
        });
      }
      return {
        suiteSnapshotId: stored.suite_snapshot_id,
        content,
        contentHash: stored.content_hash,
        createdAt: stored.created_at,
      } satisfies LinxSuiteSnapshot;
    });

    const getSnapshot = Effect.fn("SuiteService.getSnapshot")(function* (suiteSnapshotId: string) {
      const row = (yield* selectSnapshot(suiteSnapshotId))[0];
      if (row === undefined) return null;
      const content = JSON.parse(row.content_json) as LinxSuiteSnapshotContent;
      const contentHash = sha256(`linx-suite/1\0${canonicalJson(content)}`);
      const policy = decodePolicy(content.policy);
      if (
        contentHash !== row.content_hash ||
        `ssnap_${contentHash.slice(0, 32)}` !== suiteSnapshotId ||
        content.suiteId !== row.suite_id ||
        content.suiteRevision !== row.revision ||
        policy._tag === "None" ||
        validatePolicy(normalizedPolicy(policy.value)) !== undefined
      ) {
        return yield* new LinxSnapshotIntegrityError({ snapshotId: suiteSnapshotId });
      }
      return {
        suiteSnapshotId: row.suite_snapshot_id,
        content,
        contentHash: row.content_hash,
        createdAt: row.created_at,
      } satisfies LinxSuiteSnapshot;
    });

    return SuiteService.of({ save, list, get, archive, freeze, getSnapshot });
  }),
);
