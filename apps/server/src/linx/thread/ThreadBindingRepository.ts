import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";

import { LinxIdempotencyConflictError, LinxStorageError } from "../persistence/Errors.ts";
import { LinxSqlClient } from "../persistence/LinxSqlite.ts";

export interface LinxThreadBinding {
  readonly threadId: string;
  readonly snapshotId: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly parentThreadId: string | null;
  readonly suiteSnapshotId: string | null;
  readonly memberKey: string | null;
  readonly createdAt: string;
}

export interface LinxOutboxRecord {
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly requestHash: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly state: "pending" | "sent" | "failed";
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LinxBindAndEnqueueInput {
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly requestHash: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly runId?: string | null;
  readonly parentThreadId?: string | null;
  readonly suiteSnapshotId?: string | null;
  readonly memberKey?: string | null;
}

export interface LinxBindAndEnqueueResult {
  readonly binding: LinxThreadBinding;
  readonly outbox: LinxOutboxRecord;
  readonly resumed: boolean;
}

interface BindingRow {
  readonly t3_thread_id: string;
  readonly snapshot_id: string;
  readonly t3_project_id: string;
  readonly t3_run_id: string | null;
  readonly parent_thread_id: string | null;
  readonly suite_snapshot_id: string | null;
  readonly member_key: string | null;
  readonly created_at: string;
}

interface OutboxRow {
  readonly idempotency_key: string;
  readonly kind: string;
  readonly request_hash: string;
  readonly command_id: string;
  readonly t3_thread_id: string;
  readonly t3_project_id: string;
  readonly state: "pending" | "sent" | "failed";
  readonly attempts: number;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const toBinding = (row: BindingRow): LinxThreadBinding => ({
  threadId: row.t3_thread_id,
  snapshotId: row.snapshot_id,
  projectId: row.t3_project_id,
  runId: row.t3_run_id,
  parentThreadId: row.parent_thread_id,
  suiteSnapshotId: row.suite_snapshot_id,
  memberKey: row.member_key,
  createdAt: row.created_at,
});

const toOutbox = (row: OutboxRow): LinxOutboxRecord => ({
  idempotencyKey: row.idempotency_key,
  kind: row.kind,
  requestHash: row.request_hash,
  commandId: row.command_id,
  threadId: row.t3_thread_id,
  projectId: row.t3_project_id,
  state: row.state,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ThreadBindingRepository extends Context.Service<
  ThreadBindingRepository,
  {
    readonly bindAndEnqueue: (
      input: LinxBindAndEnqueueInput,
    ) => Effect.Effect<
      LinxBindAndEnqueueResult,
      LinxIdempotencyConflictError | LinxStorageError | SqlError.SqlError
    >;
    readonly getBinding: (
      threadId: string,
    ) => Effect.Effect<LinxThreadBinding | null, LinxStorageError | SqlError.SqlError>;
    readonly getOutbox: (
      idempotencyKey: string,
    ) => Effect.Effect<LinxOutboxRecord | null, LinxStorageError | SqlError.SqlError>;
    readonly markSent: (
      idempotencyKey: string,
      runId?: string | null,
    ) => Effect.Effect<void, LinxStorageError | SqlError.SqlError>;
    readonly markFailed: (
      idempotencyKey: string,
      lastError: string,
    ) => Effect.Effect<void, LinxStorageError | SqlError.SqlError>;
    readonly markPending: (
      idempotencyKey: string,
      lastError: string,
    ) => Effect.Effect<void, LinxStorageError | SqlError.SqlError>;
  }
>()("t3/linx/thread/ThreadBindingRepository") {}

export const layer = Layer.effect(
  ThreadBindingRepository,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;

    const selectBinding = (threadId: string) =>
      sql<BindingRow>`
        SELECT t3_thread_id, snapshot_id, t3_project_id, t3_run_id, parent_thread_id,
               suite_snapshot_id, member_key, created_at
        FROM thread_expert_bindings
        WHERE t3_thread_id = ${threadId}
      `;

    const selectOutbox = (idempotencyKey: string) =>
      sql<OutboxRow>`
        SELECT idempotency_key, kind, request_hash, command_id, t3_thread_id, t3_project_id,
               state, attempts, last_error, created_at, updated_at
        FROM linx_outbox
        WHERE idempotency_key = ${idempotencyKey}
      `;

    const bindAndEnqueue = Effect.fn("ThreadBindingRepository.bindAndEnqueue")(function* (
      input: LinxBindAndEnqueueInput,
    ) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const existingOutbox = (yield* selectOutbox(input.idempotencyKey))[0];
          if (existingOutbox !== undefined) {
            if (existingOutbox.request_hash !== input.requestHash) {
              return yield* new LinxIdempotencyConflictError({
                idempotencyKey: input.idempotencyKey,
              });
            }
            const existingBinding = (yield* selectBinding(existingOutbox.t3_thread_id))[0];
            if (existingBinding === undefined) {
              return yield* new LinxStorageError({
                operation: "query",
                entity: "thread_expert_bindings",
                category: "missing-for-outbox",
              });
            }
            return {
              binding: toBinding(existingBinding),
              outbox: toOutbox(existingOutbox),
              resumed: true,
            };
          }

          const existingBinding = (yield* selectBinding(input.threadId))[0];
          if (existingBinding !== undefined) {
            return yield* new LinxIdempotencyConflictError({
              idempotencyKey: input.idempotencyKey,
            });
          }

          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO thread_expert_bindings
              (t3_thread_id, snapshot_id, t3_project_id, t3_run_id, parent_thread_id,
               suite_snapshot_id, member_key, created_at)
            VALUES
              (${input.threadId}, ${input.snapshotId}, ${input.projectId}, ${input.runId ?? null},
               ${input.parentThreadId ?? null}, ${input.suiteSnapshotId ?? null},
               ${input.memberKey ?? null}, ${createdAt})
          `;
          yield* sql`
            INSERT INTO linx_outbox
              (idempotency_key, kind, request_hash, command_id, t3_thread_id, t3_project_id,
               state, attempts, last_error, created_at, updated_at)
            VALUES
              (${input.idempotencyKey}, ${input.kind}, ${input.requestHash}, ${input.commandId},
               ${input.threadId}, ${input.projectId}, 'pending', 0, NULL, ${createdAt}, ${createdAt})
          `;
          const binding = (yield* selectBinding(input.threadId))[0];
          const outbox = (yield* selectOutbox(input.idempotencyKey))[0];
          if (binding === undefined || outbox === undefined) {
            return yield* new LinxStorageError({
              operation: "transaction",
              entity: "thread_binding_outbox",
              category: "missing-after-insert",
            });
          }
          return { binding: toBinding(binding), outbox: toOutbox(outbox), resumed: false };
        }),
      );
      return result;
    });

    const getBinding = Effect.fn("ThreadBindingRepository.getBinding")(function* (
      threadId: string,
    ) {
      const row = (yield* selectBinding(threadId))[0];
      return row === undefined ? null : toBinding(row);
    });

    const getOutbox = Effect.fn("ThreadBindingRepository.getOutbox")(function* (
      idempotencyKey: string,
    ) {
      const row = (yield* selectOutbox(idempotencyKey))[0];
      return row === undefined ? null : toOutbox(row);
    });

    const markSent = Effect.fn("ThreadBindingRepository.markSent")(function* (
      idempotencyKey: string,
      runId?: string | null,
    ) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (runId !== undefined && runId !== null) {
            yield* sql`
              UPDATE thread_expert_bindings
              SET t3_run_id = ${runId}
              WHERE t3_thread_id = (
                SELECT t3_thread_id FROM linx_outbox WHERE idempotency_key = ${idempotencyKey}
              )
            `;
          }
          yield* sql`
            UPDATE linx_outbox
            SET state = 'sent', last_error = NULL, updated_at = ${updatedAt}
            WHERE idempotency_key = ${idempotencyKey}
          `;
        }),
      );
    });

    const markFailed = Effect.fn("ThreadBindingRepository.markFailed")(function* (
      idempotencyKey: string,
      lastError: string,
    ) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE linx_outbox
        SET state = 'failed', last_error = ${lastError}, attempts = attempts + 1,
            updated_at = ${updatedAt}
        WHERE idempotency_key = ${idempotencyKey} AND state = 'pending'
      `;
    });

    const markPending = Effect.fn("ThreadBindingRepository.markPending")(function* (
      idempotencyKey: string,
      lastError: string,
    ) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE linx_outbox
        SET last_error = ${lastError}, attempts = attempts + 1, updated_at = ${updatedAt}
        WHERE idempotency_key = ${idempotencyKey} AND state = 'pending'
      `;
    });

    return ThreadBindingRepository.of({
      bindAndEnqueue,
      getBinding,
      getOutbox,
      markSent,
      markFailed,
      markPending,
    });
  }),
);
