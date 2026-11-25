// @effect-diagnostics nodeBuiltinImport:off - definition ids use node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type * as SqlError from "effect/sql/SqlError";

import type {
  LinxExpertDefinition,
  LinxExpertDefinitionSummary,
  LinxSaveExpertInput,
} from "@t3tools/contracts";

import { ExpertSnapshotService, type LinxExpertSnapshot } from "./ExpertSnapshotService.ts";
import {
  LinxDefinitionArchivedError,
  LinxDependencyMissingError,
  LinxDefinitionMissingError,
  LinxResourcePathError,
  LinxRevisionConflictError,
  LinxSnapshotConflictError,
  LinxSnapshotIntegrityError,
  LinxStorageError,
} from "../persistence/Errors.ts";
import { LinxResourceStore } from "../persistence/LinxResourceStore.ts";
import { LinxSqlClient } from "../persistence/LinxSqlite.ts";
import { SkillPackageService } from "../skill/SkillPackageService.ts";

interface DefinitionRow {
  readonly expert_id: string;
  readonly current_revision: number;
  readonly title: string;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionRow {
  readonly expert_id: string;
  readonly revision: number;
  readonly snapshot_id: string;
  readonly created_at: string;
}

const newExpertId = (): string => `expert_${NodeCrypto.randomUUID().replaceAll("-", "")}`;

const toError = (cause: unknown) =>
  new LinxStorageError({
    operation: "write",
    entity: "expert_definitions",
    category: cause instanceof Error ? cause.message : "unknown",
  });

const contentFromInput = Effect.fn("ExpertDefinitionService.contentFromInput")(function* (
  input: LinxSaveExpertInput,
) {
  const grants = [...input.mcpGrants]
    .map((grant) => ({
      connectionId: grant.connectionId,
      revision: grant.revision,
      tools: [...grant.tools].sort(),
    }))
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
  const connectionRevisions: Record<string, number> = {};
  for (const grant of grants) {
    if (grant.tools.length === 0) {
      return yield* new LinxDependencyMissingError({
        entity: "connection",
        id: grant.connectionId,
        category: "grant-without-tools",
      });
    }
    const seen = connectionRevisions[grant.connectionId];
    if (seen !== undefined && seen !== grant.revision) {
      return yield* new LinxDependencyMissingError({
        entity: "connection",
        id: grant.connectionId,
        category: "conflicting-revisions",
      });
    }
    connectionRevisions[grant.connectionId] = grant.revision;
  }
  return {
    persona: input.persona,
    references: input.references,
    skillSelection: input.skillSelection,
    mcpGrants: grants,
    connectionRevisions,
  };
});

export class ExpertDefinitionService extends Context.Service<
  ExpertDefinitionService,
  {
    readonly save: (
      input: LinxSaveExpertInput,
    ) => Effect.Effect<
      LinxExpertDefinition,
      | LinxDefinitionArchivedError
      | LinxDependencyMissingError
      | LinxDefinitionMissingError
      | LinxRevisionConflictError
      | LinxSnapshotConflictError
      | LinxSnapshotIntegrityError
      | LinxResourcePathError
      | LinxStorageError
      | PlatformError.PlatformError
      | SqlError.SqlError
    >;
    readonly get: (
      expertId: string,
    ) => Effect.Effect<
      LinxExpertDefinition | null,
      LinxSnapshotIntegrityError | LinxStorageError | SqlError.SqlError
    >;
    readonly list: () => Effect.Effect<
      ReadonlyArray<LinxExpertDefinitionSummary>,
      LinxSnapshotIntegrityError | LinxStorageError | SqlError.SqlError
    >;
    readonly archive: (
      expertId: string,
      expectedRevision: number,
    ) => Effect.Effect<
      LinxExpertDefinitionSummary,
      | LinxDefinitionMissingError
      | LinxRevisionConflictError
      | LinxSnapshotIntegrityError
      | LinxStorageError
      | SqlError.SqlError
    >;
    readonly assertSelectable: (
      expertId: string,
    ) => Effect.Effect<
      void,
      | LinxDefinitionMissingError
      | LinxDefinitionArchivedError
      | LinxStorageError
      | SqlError.SqlError
    >;
  }
>()("t3/linx/expert/ExpertDefinitionService") {}

export const layer = Layer.effect(
  ExpertDefinitionService,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;
    const snapshots = yield* ExpertSnapshotService;
    const resources = yield* LinxResourceStore;
    const skills = yield* SkillPackageService;

    const selectDefinition = (expertId: string) =>
      sql<DefinitionRow>`
        SELECT expert_id, current_revision, title, archived_at, created_at, updated_at
        FROM expert_definitions WHERE expert_id = ${expertId}
      `;

    const validateContent = Effect.fn("ExpertDefinitionService.validateContent")(function* (
      input: LinxSaveExpertInput,
    ) {
      for (const reference of input.references) {
        const filename = reference.relativePath.split("/").at(-1);
        if (filename?.split(".", 1)[0] !== reference.sha256) {
          return yield* new LinxDependencyMissingError({
            entity: "reference",
            id: reference.relativePath,
            category: "hash-path-mismatch",
          });
        }
        yield* resources.read(reference.relativePath);
      }
      for (const skill of input.skillSelection) {
        const installed = yield* skills.get(skill.packageId, skill.revision);
        if (installed === null) {
          return yield* new LinxDependencyMissingError({
            entity: "skill",
            id: skill.packageId,
            category: "revision-missing",
          });
        }
        const revision = installed.revisions.find((entry) => entry.revision === skill.revision);
        if (revision === undefined || revision.contentHash !== skill.contentHash) {
          return yield* new LinxDependencyMissingError({
            entity: "skill",
            id: skill.packageId,
            category: "hash-mismatch",
          });
        }
      }
    });

    const definitionFrom = (
      row: DefinitionRow,
      snapshot: LinxExpertSnapshot,
    ): LinxExpertDefinition => ({
      expertId: row.expert_id,
      title: row.title,
      currentRevision: row.current_revision,
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      archived: row.archived_at !== null,
      updatedAt: row.updated_at,
      persona: snapshot.persona,
      references: snapshot.references,
      skillSelection: snapshot.skillSelection,
      mcpGrants: snapshot.mcpGrants,
      createdAt: row.created_at,
    });

    const readDefinition = Effect.fn("ExpertDefinitionService.read")(function* (expertId: string) {
      const row = (yield* selectDefinition(expertId))[0];
      if (row === undefined) return null;
      const revision = yield* sql<RevisionRow>`
        SELECT expert_id, revision, snapshot_id, created_at FROM expert_revisions
        WHERE expert_id = ${expertId} AND revision = ${row.current_revision}
      `;
      const current = revision[0];
      if (current === undefined) {
        return yield* new LinxStorageError({
          operation: "query",
          entity: "expert_revisions",
          category: "current-revision-missing",
        });
      }
      const snapshot = yield* snapshots.getById(current.snapshot_id);
      if (snapshot === null) {
        return yield* new LinxStorageError({
          operation: "query",
          entity: "expert_snapshots",
          category: "snapshot-missing",
        });
      }
      return definitionFrom(row, snapshot);
    });

    const save = Effect.fn("ExpertDefinitionService.save")(function* (input: LinxSaveExpertInput) {
      const title = input.title.trim();
      const content = yield* contentFromInput(input);
      yield* validateContent(input);

      if (input.expertId === undefined) {
        const expertId = newExpertId();
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
                INSERT INTO expert_definitions
                  (expert_id, current_revision, title, archived_at, created_at, updated_at)
                VALUES (${expertId}, 1, ${title}, NULL, ${now}, ${now})
              `;
              const snapshot = yield* snapshots.create({
                ...content,
                expertId,
                revision: 1,
              });
              yield* sql`
                INSERT INTO expert_revisions (expert_id, revision, snapshot_id, created_at)
                VALUES (${expertId}, 1, ${snapshot.snapshotId}, ${now})
              `;
              const row = (yield* selectDefinition(expertId))[0];
              if (row === undefined) {
                return yield* new LinxStorageError({
                  operation: "read",
                  entity: "expert_definitions",
                  category: "missing-after-insert",
                });
              }
              return definitionFrom(row, snapshot);
            }),
          )
          .pipe(Effect.mapError((cause) => (cause._tag === "SqlError" ? toError(cause) : cause)));
      }

      const expertId = input.expertId;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = (yield* selectDefinition(expertId))[0];
            if (row === undefined) {
              return yield* new LinxDefinitionMissingError({
                entity: "expert",
                id: expertId,
              });
            }
            if (row.archived_at !== null) {
              return yield* new LinxDefinitionArchivedError({
                entity: "expert",
                id: expertId,
              });
            }
            if (input.expectedRevision !== row.current_revision) {
              return yield* new LinxRevisionConflictError({
                entity: "expert",
                expectedRevision: input.expectedRevision ?? row.current_revision,
                actualRevision: row.current_revision,
              });
            }
            const nextRevision = row.current_revision + 1;
            const now = DateTime.formatIso(yield* DateTime.now);
            const snapshot = yield* snapshots.create({
              ...content,
              expertId,
              revision: nextRevision,
            });
            yield* sql`
              INSERT INTO expert_revisions (expert_id, revision, snapshot_id, created_at)
              VALUES (${expertId}, ${nextRevision}, ${snapshot.snapshotId}, ${now})
            `;
            const updated = yield* sql<{ readonly revision: number }>`
              UPDATE expert_definitions
              SET current_revision = ${nextRevision}, title = ${title}, updated_at = ${now}
              WHERE expert_id = ${expertId} AND current_revision = ${row.current_revision}
              RETURNING current_revision AS revision
            `;
            if (updated.length === 0) {
              return yield* new LinxRevisionConflictError({
                entity: "expert",
                expectedRevision: row.current_revision,
                actualRevision: row.current_revision,
              });
            }
            const fresh = (yield* selectDefinition(expertId))[0];
            if (fresh === undefined) {
              return yield* new LinxStorageError({
                operation: "read",
                entity: "expert_definitions",
                category: "missing-after-update",
              });
            }
            return definitionFrom(fresh, snapshot);
          }),
        )
        .pipe(Effect.mapError((cause) => (cause._tag === "SqlError" ? toError(cause) : cause)));
    });

    const get = Effect.fn("ExpertDefinitionService.get")(function* (expertId: string) {
      return yield* readDefinition(expertId);
    });

    const list = Effect.fn("ExpertDefinitionService.list")(function* () {
      const rows = yield* sql<
        DefinitionRow & { readonly snapshot_id: string; readonly content_hash: string }
      >`
        SELECT d.expert_id, d.current_revision, d.title, d.archived_at, d.created_at, d.updated_at,
               r.snapshot_id, s.content_hash
        FROM expert_definitions AS d
        INNER JOIN expert_revisions AS r
          ON r.expert_id = d.expert_id AND r.revision = d.current_revision
        INNER JOIN expert_snapshots AS s ON s.snapshot_id = r.snapshot_id
        ORDER BY d.title, d.expert_id
      `;
      return rows.map((row) => ({
        expertId: row.expert_id,
        title: row.title,
        currentRevision: row.current_revision,
        snapshotId: row.snapshot_id,
        contentHash: row.content_hash,
        archived: row.archived_at !== null,
        updatedAt: row.updated_at,
      }));
    });

    const archive = Effect.fn("ExpertDefinitionService.archive")(function* (
      expertId: string,
      expectedRevision: number,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* sql<{ readonly revision: number }>`
        UPDATE expert_definitions
        SET archived_at = ${now}, updated_at = ${now}
        WHERE expert_id = ${expertId} AND current_revision = ${expectedRevision}
        RETURNING current_revision AS revision
      `;
      if (updated.length === 0) {
        const row = (yield* selectDefinition(expertId))[0];
        if (row === undefined) {
          return yield* new LinxDefinitionMissingError({ entity: "expert", id: expertId });
        }
        return yield* new LinxRevisionConflictError({
          entity: "expert",
          expectedRevision,
          actualRevision: row.current_revision,
        });
      }
      const current = yield* readDefinition(expertId);
      if (current === null) {
        return yield* new LinxStorageError({
          operation: "read",
          entity: "expert_definitions",
          category: "missing-after-archive",
        });
      }
      return {
        expertId: current.expertId,
        title: current.title,
        currentRevision: current.currentRevision,
        snapshotId: current.snapshotId,
        contentHash: current.contentHash,
        archived: current.archived,
        updatedAt: current.updatedAt,
      };
    });

    const assertSelectable = Effect.fn("ExpertDefinitionService.assertSelectable")(function* (
      expertId: string,
    ) {
      const row = (yield* selectDefinition(expertId))[0];
      // P1 snapshots predate definitions and stay selectable until they are saved again.
      if (row === undefined) return;
      if (row.archived_at !== null) {
        return yield* new LinxDefinitionArchivedError({ entity: "expert", id: expertId });
      }
    });

    return ExpertDefinitionService.of({
      save,
      get,
      list,
      archive,
      assertSelectable,
    });
  }),
);
