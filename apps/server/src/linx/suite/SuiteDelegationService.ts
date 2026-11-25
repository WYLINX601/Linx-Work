// @effect-diagnostics nodeBuiltinImport:off - delegation ids use node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CommandId,
  ProjectId,
  type LinxFailure,
  type ModelSelection,
  type LinxSuiteDelegateInput,
  type LinxSuiteMember,
  type OrchestratorMcpDelegateTaskInput,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import { LinxSqlClient } from "../persistence/LinxSqlite.ts";
import { ThreadBindingRepository } from "../thread/ThreadBindingRepository.ts";
import { SuiteService } from "./SuiteService.ts";

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const stableJson = (value: unknown): string => {
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

const failure = (code: LinxFailure["code"], message: string): LinxFailure => ({ code, message });

export interface PreparedSuiteDelegation {
  readonly key: string;
  readonly commandId: string;
  readonly expectedChildThreadId: string;
  readonly member: LinxSuiteMember;
  readonly parentThreadId: string;
  readonly parentProjectId: string;
  readonly nativeInput: OrchestratorMcpDelegateTaskInput;
  readonly taskId: string | null;
  readonly resumed: boolean;
}

interface DelegationRow {
  readonly idempotency_key: string;
  readonly parent_thread_id: string;
  readonly client_request_id: string;
  readonly request_hash: string;
  readonly command_id: string;
  readonly member_key: string;
  readonly expected_child_thread_id: string;
  readonly member_snapshot_id: string;
  readonly suite_snapshot_id: string;
  readonly state: "pending" | "sent" | "failed" | "completed";
  readonly t3_task_id: string | null;
  readonly last_error: string | null;
}

export class SuiteDelegationService extends Context.Service<
  SuiteDelegationService,
  {
    readonly members: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<LinxSuiteMember>, LinxFailure>;
    readonly prepare: (
      input: LinxSuiteDelegateInput & { readonly parentThreadId: string },
    ) => Effect.Effect<PreparedSuiteDelegation, LinxFailure>;
    readonly markSent: (key: string, taskId: string) => Effect.Effect<void, LinxFailure>;
    readonly markFailed: (key: string, message: string) => Effect.Effect<void, LinxFailure>;
    readonly markCompleted: (key: string) => Effect.Effect<void, LinxFailure>;
    readonly active: (
      parentThreadId: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly key: string; readonly taskId: string | null }>,
      LinxFailure
    >;
  }
>()("t3/linx/suite/SuiteDelegationService") {}

export const layer = Layer.effect(
  SuiteDelegationService,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;
    const suites = yield* SuiteService;
    const bindings = yield* ThreadBindingRepository;

    const selectByKey = (key: string) =>
      sql<DelegationRow>`
        SELECT idempotency_key, parent_thread_id, client_request_id, request_hash, command_id,
               member_key, expected_child_thread_id, member_snapshot_id, suite_snapshot_id,
               state, t3_task_id, last_error
        FROM suite_delegations WHERE idempotency_key = ${key}
      `;

    const suiteContextFor = Effect.fn("SuiteDelegationService.suiteContextFor")(function* (
      threadId: string,
    ) {
      const binding = yield* bindings
        .getBinding(threadId)
        .pipe(
          Effect.mapError(() => failure("launch_failed", "The suite binding could not be read.")),
        );
      if (binding === null || binding.suiteSnapshotId === null) {
        return yield* Effect.fail(
          failure("binding_missing", "This thread is not bound to a suite."),
        );
      }
      if (binding.memberKey !== null) {
        return yield* Effect.fail(failure("forbidden", "Only the Suite Lead can delegate work."));
      }
      const snapshot = yield* suites
        .getSnapshot(binding.suiteSnapshotId)
        .pipe(
          Effect.mapError(() => failure("launch_failed", "The suite snapshot could not be read.")),
        );
      if (snapshot === null) {
        return yield* Effect.fail(
          failure("snapshot_missing", "The bound suite snapshot does not exist."),
        );
      }
      return { binding, snapshot };
    });

    const members = Effect.fn("SuiteDelegationService.members")(function* (threadId: string) {
      const { snapshot } = yield* suiteContextFor(threadId);
      return snapshot.content.members.map((member) => ({
        memberKey: member.memberKey,
        expertId: member.expertId,
        revision: member.revision,
        snapshotId: member.snapshotId,
        title: member.title,
        ...(member.modelSelection === undefined ? {} : { modelSelection: member.modelSelection }),
        ...(member.runtimeMode === undefined ? {} : { runtimeMode: member.runtimeMode }),
        ...(member.interactionMode === undefined
          ? {}
          : { interactionMode: member.interactionMode }),
      }));
    });

    const prepare = Effect.fn("SuiteDelegationService.prepare")(function* (
      input: LinxSuiteDelegateInput & { readonly parentThreadId: string },
    ) {
      const { binding, snapshot } = yield* suiteContextFor(input.parentThreadId);
      const member = snapshot.content.members.find(
        (candidate) => candidate.memberKey === input.memberKey,
      );
      if (member === undefined) {
        return yield* Effect.fail(failure("invalid_request", "This suite has no such member."));
      }
      const key = `${input.parentThreadId}\0${input.clientRequestId}`;
      const requestHash = sha256(
        stableJson({
          parentThreadId: input.parentThreadId,
          suiteSnapshotId: binding.suiteSnapshotId,
          memberKey: input.memberKey,
          objective: input.objective,
          acceptance: input.acceptance,
        }),
      );
      const commandId = `linx:suite:delegate:${sha256(key)}`;
      const expectedChildThreadId = IdAllocator.derive.delegatedTaskThread({
        commandId: CommandId.make(commandId),
      });
      const existing = (yield* selectByKey(key).pipe(
        Effect.mapError(() => failure("launch_failed", "Delegations could not be read.")),
      ))[0];
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) {
          return yield* Effect.fail(
            failure("idempotency_conflict", "This delegation id was already used differently."),
          );
        }
        if (existing.state === "failed") {
          return yield* Effect.fail(failure("launch_failed", "This delegation already failed."));
        }
        return {
          key,
          commandId: existing.command_id,
          expectedChildThreadId: existing.expected_child_thread_id,
          member,
          parentThreadId: input.parentThreadId,
          parentProjectId: binding.projectId,
          nativeInput: nativeInputFor(
            member,
            input,
            binding.projectId,
            snapshot.content.leadModelSelection,
          ),
          taskId: existing.t3_task_id,
          resumed: true,
        } satisfies PreparedSuiteDelegation;
      }

      const active = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM suite_delegations
        WHERE parent_thread_id = ${input.parentThreadId} AND state IN ('pending','sent')
      `.pipe(Effect.mapError(() => failure("launch_failed", "Delegations could not be read.")));
      if ((active[0]?.count ?? 0) >= snapshot.content.policy.maxActiveDelegations) {
        return yield* Effect.fail(
          failure("limit_exceeded", "This suite has reached its active delegation limit."),
        );
      }

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
              INSERT INTO suite_delegations
                (idempotency_key, parent_thread_id, client_request_id, request_hash, command_id,
                 member_key, expected_child_thread_id, member_snapshot_id, suite_snapshot_id,
                 state, t3_task_id, attempts, last_error, created_at, updated_at)
              VALUES (${key}, ${input.parentThreadId}, ${input.clientRequestId}, ${requestHash},
                      ${commandId}, ${input.memberKey}, ${expectedChildThreadId},
                      ${member.snapshotId}, ${binding.suiteSnapshotId}, 'pending', NULL, 0, NULL,
                      ${now}, ${now})
            `;
            yield* sql`
              INSERT INTO thread_expert_bindings
                (t3_thread_id, snapshot_id, t3_project_id, t3_run_id, parent_thread_id,
                 suite_snapshot_id, member_key, created_at)
              VALUES (${expectedChildThreadId}, ${member.snapshotId}, ${binding.projectId}, NULL,
                      ${input.parentThreadId}, ${binding.suiteSnapshotId}, ${input.memberKey},
                      ${now})
            `;
            yield* sql`
              INSERT INTO linx_outbox
                (idempotency_key, kind, request_hash, command_id, t3_thread_id, t3_project_id,
                 state, attempts, last_error, created_at, updated_at)
              VALUES (${key}, 'suite-delegate', ${requestHash}, ${commandId},
                      ${expectedChildThreadId}, ${binding.projectId}, 'pending', 0, NULL,
                      ${now}, ${now})
            `;
          }),
        )
        .pipe(
          Effect.mapError(() => failure("launch_failed", "The delegation could not be persisted.")),
        );

      return {
        key,
        commandId,
        expectedChildThreadId,
        member,
        parentThreadId: input.parentThreadId,
        parentProjectId: binding.projectId,
        nativeInput: nativeInputFor(
          member,
          input,
          binding.projectId,
          snapshot.content.leadModelSelection,
        ),
        taskId: null,
        resumed: false,
      } satisfies PreparedSuiteDelegation;
    });

    const markSent = Effect.fn("SuiteDelegationService.markSent")(function* (
      key: string,
      taskId: string,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE suite_delegations
        SET state = 'sent', t3_task_id = ${taskId}, last_error = NULL, updated_at = ${now}
        WHERE idempotency_key = ${key} AND state = 'pending'
      `.pipe(
        Effect.mapError(() =>
          failure("launch_failed", "The delegation outcome could not be persisted."),
        ),
      );
      yield* sql`
        UPDATE linx_outbox SET state = 'sent', updated_at = ${now}
        WHERE idempotency_key = ${key}
      `.pipe(
        Effect.mapError(() =>
          failure("launch_failed", "The delegation outbox could not be updated."),
        ),
      );
    });

    const markFailed = Effect.fn("SuiteDelegationService.markFailed")(function* (
      key: string,
      message: string,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE suite_delegations
        SET state = 'failed', last_error = ${message}, attempts = attempts + 1,
            updated_at = ${now}
        WHERE idempotency_key = ${key} AND state = 'pending'
      `.pipe(
        Effect.mapError(() =>
          failure("launch_failed", "The delegation failure could not be persisted."),
        ),
      );
      yield* sql`
        UPDATE linx_outbox
        SET state = 'failed', last_error = ${message}, attempts = attempts + 1,
            updated_at = ${now}
        WHERE idempotency_key = ${key}
      `.pipe(
        Effect.mapError(() =>
          failure("launch_failed", "The delegation outbox could not be updated."),
        ),
      );
    });

    const markCompleted = Effect.fn("SuiteDelegationService.markCompleted")(function* (
      key: string,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE suite_delegations SET state = 'completed', updated_at = ${now}
        WHERE idempotency_key = ${key} AND state IN ('pending','sent')
      `.pipe(
        Effect.mapError(() =>
          failure("launch_failed", "The delegation completion could not be persisted."),
        ),
      );
    });

    const active = Effect.fn("SuiteDelegationService.active")(function* (parentThreadId: string) {
      const rows = yield* sql<{
        readonly idempotency_key: string;
        readonly t3_task_id: string | null;
      }>`
        SELECT idempotency_key, t3_task_id FROM suite_delegations
        WHERE parent_thread_id = ${parentThreadId} AND state = 'sent'
      `.pipe(Effect.mapError(() => failure("launch_failed", "Delegations could not be read.")));
      return rows.map((row) => ({ key: row.idempotency_key, taskId: row.t3_task_id }));
    });

    return SuiteDelegationService.of({
      members,
      prepare,
      markSent,
      markFailed,
      markCompleted,
      active,
    });
  }),
);

function nativeInputFor(
  member: LinxSuiteMember,
  input: LinxSuiteDelegateInput,
  parentProjectId: string,
  leadModelSelection: ModelSelection | undefined,
): OrchestratorMcpDelegateTaskInput {
  const modelSelection = member.modelSelection ?? leadModelSelection;
  return {
    task: `${input.objective}\n\nAcceptance criteria:\n${input.acceptance}`,
    title: member.title,
    target: {
      ...(modelSelection === undefined
        ? {}
        : {
            providerInstanceId: modelSelection.instanceId,
            model: modelSelection.model,
          }),
      projectId: ProjectId.make(parentProjectId),
    },
    isolation: "shared",
    mode: "async",
    clientRequestId: input.clientRequestId,
    ...(member.runtimeMode === undefined ? {} : { runtimeMode: member.runtimeMode }),
    ...(member.interactionMode === undefined ? {} : { interactionMode: member.interactionMode }),
  };
}
