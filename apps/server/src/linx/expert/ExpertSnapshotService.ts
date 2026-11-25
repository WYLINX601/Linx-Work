// @effect-diagnostics nodeBuiltinImport:off - snapshot ids and hashes use node:crypto directly.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";
import type { LinxExpertSummary } from "@t3tools/contracts";

import {
  LinxSnapshotConflictError,
  LinxSnapshotIntegrityError,
  LinxStorageError,
} from "../persistence/Errors.ts";
import { LinxSqlClient } from "../persistence/LinxSqlite.ts";

export interface LinxSnapshotReference {
  readonly name: string;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface LinxSnapshotSkillSelection {
  readonly packageId: string;
  readonly revision: number;
  readonly contentHash: string;
}

export interface LinxSnapshotMcpGrant {
  readonly connectionId: string;
  readonly revision: number;
  readonly tools: ReadonlyArray<string>;
}

export interface LinxExpertSnapshotContent {
  readonly persona: string;
  readonly references: ReadonlyArray<LinxSnapshotReference>;
  readonly skillSelection: ReadonlyArray<LinxSnapshotSkillSelection>;
  readonly mcpGrants: ReadonlyArray<LinxSnapshotMcpGrant>;
  readonly connectionRevisions: Readonly<Record<string, number>>;
}

export interface LinxCreateExpertSnapshotInput extends LinxExpertSnapshotContent {
  readonly expertId: string;
  readonly revision: number;
}

export interface LinxExpertSnapshot extends LinxExpertSnapshotContent {
  readonly snapshotId: string;
  readonly expertId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly createdAt: string;
}

const sha256 = (value: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const normalizedContent = (input: LinxExpertSnapshotContent): LinxExpertSnapshotContent => ({
  persona: input.persona,
  references: [...input.references]
    .map((reference) => ({
      name: reference.name,
      relativePath: reference.relativePath,
      sha256: reference.sha256,
    }))
    .sort((left, right) => left.name.localeCompare(right.name)),
  skillSelection: [...input.skillSelection]
    .map((skill) => ({
      packageId: skill.packageId,
      revision: skill.revision,
      contentHash: skill.contentHash,
    }))
    .sort(
      (left, right) =>
        left.packageId.localeCompare(right.packageId) || left.revision - right.revision,
    ),
  mcpGrants: [...input.mcpGrants]
    .map((grant) => ({
      connectionId: grant.connectionId,
      revision: grant.revision,
      tools: [...grant.tools].sort(),
    }))
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
  connectionRevisions: Object.fromEntries(
    Object.entries(input.connectionRevisions).sort(([left], [right]) => left.localeCompare(right)),
  ),
});

const canonicalSnapshotContent = (input: LinxExpertSnapshotContent): string =>
  JSON.stringify(normalizedContent(input));

const snapshotIdFor = (expertId: string, revision: number, contentHash: string): string =>
  `snap_${sha256(`${expertId}\0${revision}\0${contentHash}`).slice(0, 32)}`;

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly expert_id: string;
  readonly revision: number;
  readonly content_json: string;
  readonly content_hash: string;
  readonly created_at: string;
  readonly title?: string;
}

const toSnapshot = (row: SnapshotRow): LinxExpertSnapshot => ({
  ...(JSON.parse(row.content_json) as LinxExpertSnapshotContent),
  snapshotId: row.snapshot_id,
  expertId: row.expert_id,
  revision: row.revision,
  contentHash: row.content_hash,
  createdAt: row.created_at,
});

const verifiedSnapshot = (row: SnapshotRow) =>
  sha256(row.content_json) === row.content_hash
    ? Effect.succeed(toSnapshot(row))
    : Effect.fail(new LinxSnapshotIntegrityError({ snapshotId: row.snapshot_id }));

export class ExpertSnapshotService extends Context.Service<
  ExpertSnapshotService,
  {
    readonly create: (
      input: LinxCreateExpertSnapshotInput,
    ) => Effect.Effect<
      LinxExpertSnapshot,
      LinxSnapshotConflictError | LinxSnapshotIntegrityError | LinxStorageError | SqlError.SqlError
    >;
    readonly getById: (
      snapshotId: string,
    ) => Effect.Effect<
      LinxExpertSnapshot | null,
      LinxSnapshotIntegrityError | LinxStorageError | SqlError.SqlError
    >;
    readonly getByRevision: (
      expertId: string,
      revision: number,
    ) => Effect.Effect<
      LinxExpertSnapshot | null,
      LinxSnapshotIntegrityError | LinxStorageError | SqlError.SqlError
    >;
    readonly listLatest: () => Effect.Effect<
      ReadonlyArray<LinxExpertSummary>,
      LinxSnapshotIntegrityError | SqlError.SqlError
    >;
  }
>()("t3/linx/expert/ExpertSnapshotService") {}

export const layer = Layer.effect(
  ExpertSnapshotService,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;

    const selectByRevision = (expertId: string, revision: number) =>
      sql<SnapshotRow>`
        SELECT snapshot_id, expert_id, revision, content_json, content_hash, created_at
        FROM expert_snapshots
        WHERE expert_id = ${expertId} AND revision = ${revision}
      `;

    const create = Effect.fn("ExpertSnapshotService.create")(function* (
      input: LinxCreateExpertSnapshotInput,
    ) {
      const contentJson = canonicalSnapshotContent(input);
      const contentHash = sha256(contentJson);
      const snapshotId = snapshotIdFor(input.expertId, input.revision, contentHash);
      const createdAt = DateTime.formatIso(yield* DateTime.now);

      const existing = yield* selectByRevision(input.expertId, input.revision);
      if (existing[0] !== undefined) {
        if (existing[0].content_hash !== contentHash) {
          return yield* new LinxSnapshotConflictError({
            expertId: input.expertId,
            revision: input.revision,
          });
        }
        return yield* verifiedSnapshot(existing[0]);
      }

      const inserted = yield* sql`
        INSERT INTO expert_snapshots
          (snapshot_id, expert_id, revision, content_json, content_hash, created_at)
        VALUES
          (${snapshotId}, ${input.expertId}, ${input.revision}, ${contentJson}, ${contentHash}, ${createdAt})
        ON CONFLICT DO NOTHING
        RETURNING snapshot_id, expert_id, revision, content_json, content_hash, created_at
      `.pipe(
        Effect.map((rows) => rows as unknown as ReadonlyArray<SnapshotRow>),
        Effect.orElseSucceed(() => [] as ReadonlyArray<SnapshotRow>),
      );
      if (inserted[0] !== undefined) return toSnapshot(inserted[0]);

      const raced = yield* selectByRevision(input.expertId, input.revision);
      const row = raced[0];
      if (row === undefined) {
        return yield* new LinxStorageError({
          operation: "write",
          entity: "expert_snapshots",
          category: "insert-failed",
        });
      }
      if (row.content_hash !== contentHash) {
        return yield* new LinxSnapshotConflictError({
          expertId: input.expertId,
          revision: input.revision,
        });
      }
      return yield* verifiedSnapshot(row);
    });

    const getById = Effect.fn("ExpertSnapshotService.getById")(function* (snapshotId: string) {
      const rows = yield* sql<SnapshotRow>`
        SELECT snapshot_id, expert_id, revision, content_json, content_hash, created_at
        FROM expert_snapshots
        WHERE snapshot_id = ${snapshotId}
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return yield* verifiedSnapshot(row);
    });

    const getByRevision = Effect.fn("ExpertSnapshotService.getByRevision")(function* (
      expertId: string,
      revision: number,
    ) {
      const row = (yield* selectByRevision(expertId, revision))[0];
      if (row === undefined) return null;
      return yield* verifiedSnapshot(row);
    });

    const listLatest = Effect.fn("ExpertSnapshotService.listLatest")(function* () {
      const rows = yield* sql<SnapshotRow>`
        SELECT snapshot.snapshot_id, snapshot.expert_id, snapshot.revision,
               snapshot.content_json, snapshot.content_hash, snapshot.created_at,
               COALESCE(definition.title, snapshot.expert_id) AS title
        FROM expert_snapshots AS snapshot
        INNER JOIN (
          SELECT expert_id AS expert, MAX(revision) AS latest
          FROM expert_snapshots
          GROUP BY expert_id
        ) ON snapshot.expert_id = expert AND snapshot.revision = latest
        LEFT JOIN expert_definitions AS definition ON definition.expert_id = snapshot.expert_id
        WHERE definition.archived_at IS NULL
        ORDER BY snapshot.expert_id
      `;
      const summaries: LinxExpertSummary[] = [];
      for (const row of rows) {
        const { expertId, snapshotId, revision, contentHash, persona } =
          yield* verifiedSnapshot(row);
        summaries.push({
          expertId,
          title: row.title ?? expertId,
          snapshotId,
          revision,
          contentHash,
          personaPreview: persona.slice(0, 160),
        });
      }
      return summaries;
    });

    return ExpertSnapshotService.of({ create, getById, getByRevision, listLatest });
  }),
);
