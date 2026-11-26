// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - hash our canonical execution JSON.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CommandId,
  OrchestratorMcpDelegateTaskInput,
  ProjectId,
  RunId,
  ThreadId,
  type LinxFailure,
  type LinxSuiteDelegateInput,
  type LinxSuiteMember,
  type LinxSuitePolicy,
  type ModelSelection,
  type NodeId,
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

const REQUEST_VERSION = 1;
const LEASE_MS = 120_000;
const BATCH_SIZE = 32;

type Request = LinxSuiteDelegateInput & { readonly parentThreadId: string };
type State = "pending" | "sent" | "failed" | "completed";

interface Reservation {
  readonly key: string;
  readonly memberKey: string;
  readonly taskId: string | null;
  readonly state: State;
  readonly canSubmit: boolean;
}

interface DelegationRow {
  readonly idempotency_key: string;
  readonly parent_thread_id: string;
  readonly parent_run_id: string | null;
  readonly request_hash: string;
  readonly command_id: string;
  readonly member_key: string;
  readonly expected_child_thread_id: string;
  readonly state: State;
  readonly t3_task_id: string | null;
  readonly t3_run_id: string | null;
  readonly t3_project_id: string;
  readonly request_version: number | null;
  readonly request_json: string | null;
  readonly execution_hash: string | null;
  readonly dispatch_started_at: number | null;
  readonly consecutive_failures: number;
  readonly last_error: string | null;
  readonly next_attempt_at: number | null;
}

export interface SuiteDelegationLease {
  readonly key: string;
  readonly token: string;
  readonly commandId: CommandId;
  readonly parentThreadId: ThreadId;
  readonly parentRunId: RunId | null;
  readonly parentProjectId: ProjectId;
  readonly expectedChildThreadId: ThreadId;
  readonly recordedChildRunId: string | null;
  readonly recordedTaskId: string | null;
  readonly neverDispatched: boolean;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

interface Submission extends SuiteDelegationLease {
  readonly parentRunId: RunId;
  readonly nativeInput: OrchestratorMcpDelegateTaskInput;
}

export type SuiteDelegationReconcileOutcome =
  | {
      readonly type: "accepted";
      readonly taskId: NodeId;
      readonly parentRunId: RunId;
      readonly childRunId: RunId;
      readonly terminal: boolean;
    }
  | { readonly type: "rejected" | "cancelled" | "quarantine"; readonly reason: string }
  | { readonly type: "retry"; readonly reason: string; readonly delayMs: number };

interface SubmissionIdentity {
  readonly commandId: CommandId;
  readonly parentThreadId: ThreadId;
  readonly parentRunId: RunId;
  readonly parentProjectId: ProjectId;
  readonly expectedChildThreadId: ThreadId;
  readonly nativeInput: OrchestratorMcpDelegateTaskInput;
}

// A fiber that outlives its lease cannot begin dispatch on the next owner's lease.
export const SuiteDelegationSubmissionLease = Context.Reference<string | undefined>(
  "t3/linx/suite/SuiteDelegationSubmissionLease",
  { defaultValue: () => undefined },
);

export class SuiteDelegationService extends Context.Service<
  SuiteDelegationService,
  {
    readonly members: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<LinxSuiteMember>, LinxFailure>;
    readonly find: (input: Request) => Effect.Effect<Reservation | null, LinxFailure>;
    readonly prepare: (
      input: Request & { readonly parentRunId: RunId },
    ) => Effect.Effect<Reservation, LinxFailure>;
    readonly claimSubmission: (
      key: string,
      parentRunId: RunId,
    ) => Effect.Effect<Submission | null, LinxFailure>;
    readonly assertSubmission: (identity: SubmissionIdentity) => Effect.Effect<void, LinxFailure>;
    readonly due: (parentThreadId?: ThreadId) => Effect.Effect<ReadonlyArray<string>, LinxFailure>;
    readonly claimRecovery: (
      key: string,
    ) => Effect.Effect<SuiteDelegationLease | null, LinxFailure>;
    readonly reloadLease: (
      lease: SuiteDelegationLease,
    ) => Effect.Effect<SuiteDelegationLease | null, LinxFailure>;
    readonly settle: (
      lease: SuiteDelegationLease,
      outcome: SuiteDelegationReconcileOutcome,
    ) => Effect.Effect<boolean, LinxFailure>;
  }
>()("t3/linx/suite/SuiteDelegationService") {}

const keyFor = ({ parentThreadId, clientRequestId }: Request) =>
  `suite-delegate:${Buffer.from(parentThreadId).toString("hex")}:${Buffer.from(clientRequestId).toString("hex")}`;

const requestHashFor = (input: Request, suiteSnapshotId: string) =>
  sha256(
    stableJson({
      parentThreadId: input.parentThreadId,
      suiteSnapshotId,
      memberKey: input.memberKey,
      objective: input.objective,
      acceptance: input.acceptance,
    }),
  );

const summary = (row: DelegationRow): Reservation => ({
  key: row.idempotency_key,
  memberKey: row.member_key,
  taskId:
    row.state === "completed" || (row.state === "sent" && row.next_attempt_at !== null)
      ? row.t3_task_id
      : null,
  state: row.state,
  canSubmit:
    row.state === "pending" &&
    row.request_version === REQUEST_VERSION &&
    row.dispatch_started_at === null &&
    row.next_attempt_at !== null,
});

const leaseFor = (row: DelegationRow, token: string): SuiteDelegationLease => ({
  key: row.idempotency_key,
  token,
  commandId: CommandId.make(row.command_id),
  parentThreadId: ThreadId.make(row.parent_thread_id),
  parentRunId: row.parent_run_id === null ? null : RunId.make(row.parent_run_id),
  parentProjectId: ProjectId.make(row.t3_project_id),
  expectedChildThreadId: ThreadId.make(row.expected_child_thread_id),
  recordedChildRunId: row.t3_run_id,
  recordedTaskId: row.t3_task_id,
  neverDispatched: row.request_version === REQUEST_VERSION && row.dispatch_started_at === null,
  consecutiveFailures: row.consecutive_failures,
  lastError: row.last_error,
});

const decodeNativeRequest = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskInput);
const decodeNativeInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestratorMcpDelegateTaskInput),
);
const storageFailure = () => failure("launch_failed", "The Suite delegation store is unavailable.");
const mismatchedRequest = () =>
  failure("idempotency_conflict", "This delegation id was already used differently.");

export const layer = Layer.effect(
  SuiteDelegationService,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;
    const suites = yield* SuiteService;
    const bindings = yield* ThreadBindingRepository;

    const select = (key: string) =>
      sql<DelegationRow>`
        SELECT d.idempotency_key, d.parent_thread_id, d.parent_run_id, d.request_hash,
               d.command_id, d.member_key, d.expected_child_thread_id, d.state, d.t3_task_id,
               d.t3_run_id, o.t3_project_id, o.request_version, o.request_json, o.execution_hash,
               o.dispatch_started_at, o.last_error, o.next_attempt_at, o.consecutive_failures
        FROM suite_delegations d JOIN linx_outbox o ON o.idempotency_key = d.idempotency_key
        WHERE d.idempotency_key = ${key} AND o.kind = 'suite-delegate'
      `.pipe(Effect.map((rows) => rows[0]));

    const leadBindingFor = Effect.fn("SuiteDelegationService.leadBindingFor")(function* (
      threadId: string,
    ) {
      const binding = yield* bindings.getBinding(threadId).pipe(Effect.mapError(storageFailure));
      if (binding === null || binding.suiteSnapshotId === null) {
        return yield* Effect.fail(
          failure("binding_missing", "This thread is not bound to a suite."),
        );
      }
      if (binding.memberKey !== null || binding.parentThreadId !== null) {
        return yield* Effect.fail(failure("forbidden", "Only the Suite Lead can delegate work."));
      }
      return { projectId: binding.projectId, suiteSnapshotId: binding.suiteSnapshotId };
    });

    const suiteContextFor = Effect.fn("SuiteDelegationService.suiteContextFor")(function* (
      threadId: string,
    ) {
      const binding = yield* leadBindingFor(threadId);
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

    const find = Effect.fn("SuiteDelegationService.find")(function* (input: Request) {
      const binding = yield* leadBindingFor(input.parentThreadId);
      const row = yield* select(keyFor(input)).pipe(Effect.mapError(storageFailure));
      if (row === undefined) return null;
      if (row.request_hash !== requestHashFor(input, binding.suiteSnapshotId)) {
        return yield* Effect.fail(mismatchedRequest());
      }
      return summary(row);
    });

    const prepare = Effect.fn("SuiteDelegationService.prepare")(function* (
      input: Request & { readonly parentRunId: RunId },
    ) {
      // Linx's SQLite writer uses BEGIN IMMEDIATE. Lookup, quota and all three
      // writes are serialized even when there are multiple writer connections.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const { binding, snapshot } = yield* suiteContextFor(input.parentThreadId);
            const key = keyFor(input);
            const requestHash = requestHashFor(input, snapshot.suiteSnapshotId);
            const existing = yield* select(key);
            if (existing !== undefined) {
              if (existing.request_hash !== requestHash)
                return yield* Effect.fail(mismatchedRequest());
              return summary(existing);
            }
            const member = snapshot.content.members.find(
              (candidate) => candidate.memberKey === input.memberKey,
            );
            if (member === undefined) {
              return yield* Effect.fail(
                failure("invalid_request", "This suite has no such member."),
              );
            }

            const [active] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM suite_delegations
          WHERE parent_thread_id = ${input.parentThreadId} AND state IN ('pending', 'sent')
        `;
            if ((active?.count ?? 0) >= Math.min(4, snapshot.content.policy.maxActiveDelegations)) {
              return yield* Effect.fail(
                failure("limit_exceeded", "This suite has reached its active delegation limit."),
              );
            }

            const commandId = CommandId.make(`linx:suite:delegate:${sha256(key)}`);
            const childId = IdAllocator.derive.delegatedTaskThread({ commandId });
            const nativeInput = yield* decodeNativeRequest(
              nativeInputFor(
                member,
                input,
                binding.projectId,
                snapshot.content.leadModelSelection,
                snapshot.content.policy,
              ),
            ).pipe(
              Effect.mapError(() =>
                failure("invalid_request", "The native delegation input is invalid."),
              ),
            );
            const requestJson = stableJson(nativeInput);
            const nowMs = yield* Clock.currentTimeMillis;
            const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
            yield* sql`
          INSERT INTO suite_delegations
            (idempotency_key, parent_thread_id, parent_run_id, client_request_id, request_hash,
             command_id, member_key, expected_child_thread_id, member_snapshot_id, suite_snapshot_id,
             state, created_at, updated_at)
          VALUES (${key}, ${input.parentThreadId}, ${input.parentRunId}, ${input.clientRequestId},
                  ${requestHash}, ${commandId}, ${input.memberKey}, ${childId}, ${member.snapshotId},
                  ${snapshot.suiteSnapshotId}, 'pending', ${now}, ${now})
        `;
            yield* sql`
          INSERT INTO thread_expert_bindings
            (t3_thread_id, snapshot_id, t3_project_id, parent_thread_id, suite_snapshot_id,
             member_key, created_at)
          VALUES (${childId}, ${member.snapshotId}, ${binding.projectId}, ${input.parentThreadId},
                  ${snapshot.suiteSnapshotId}, ${input.memberKey}, ${now})
        `;
            yield* sql`
          INSERT INTO linx_outbox
            (idempotency_key, kind, request_hash, command_id, t3_thread_id, t3_project_id,
             request_version, request_json, execution_hash, next_attempt_at, state, created_at, updated_at)
          VALUES (${key}, 'suite-delegate', ${requestHash}, ${commandId}, ${childId}, ${binding.projectId},
                  ${REQUEST_VERSION}, ${requestJson}, ${sha256(requestJson)}, ${nowMs}, 'pending', ${now}, ${now})
        `;
            return {
              key,
              memberKey: input.memberKey,
              taskId: null,
              state: "pending",
              canSubmit: true,
            } satisfies Reservation;
          }),
        )
        .pipe(Effect.mapError((error) => ("_tag" in error ? storageFailure() : error)));
    });

    const claim = (key: string, parentRunId?: RunId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const token = NodeCrypto.randomUUID();
            const submission = parentRunId !== undefined;
            const [claimed] = yield* sql`
          UPDATE linx_outbox SET lease_token = ${token}, lease_expires_at = ${now + LEASE_MS},
            attempts = attempts + 1
          WHERE idempotency_key = ${key} AND kind = 'suite-delegate' AND next_attempt_at IS NOT NULL
            AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
            AND idempotency_key IN (
              SELECT idempotency_key FROM suite_delegations WHERE idempotency_key = ${key}
                AND state IN ('pending', 'sent')
            )
            ${
              submission
                ? sql`
              AND state = 'pending' AND request_version = ${REQUEST_VERSION} AND dispatch_started_at IS NULL
              AND idempotency_key IN (
                SELECT idempotency_key FROM suite_delegations
                WHERE idempotency_key = ${key} AND state = 'pending' AND parent_run_id = ${parentRunId}
              )
            `
                : sql`AND next_attempt_at <= ${now}`
            }
          RETURNING idempotency_key
        `;
            if (claimed === undefined) return null;
            const row = yield* select(key);
            return row === undefined ? null : { row, token };
          }),
        )
        .pipe(Effect.mapError(storageFailure));

    const claimSubmission = Effect.fn("SuiteDelegationService.claimSubmission")(function* (
      key: string,
      parentRunId: RunId,
    ) {
      const claimed = yield* claim(key, parentRunId);
      if (claimed === null) return null;
      const { row, token } = claimed;
      if (row.request_json === null || row.execution_hash !== sha256(row.request_json)) {
        return yield* Effect.fail(
          failure("snapshot_integrity", "The frozen delegation request is invalid."),
        );
      }
      const nativeInput = yield* decodeNativeInput(row.request_json).pipe(
        Effect.mapError(() =>
          failure("snapshot_integrity", "The frozen delegation request is invalid."),
        ),
      );
      return { ...leaseFor(row, token), parentRunId, nativeInput };
    });

    const assertSubmission = Effect.fn("SuiteDelegationService.assertSubmission")(function* (
      input: SubmissionIdentity,
    ) {
      const token = yield* SuiteDelegationSubmissionLease;
      const now = yield* Clock.currentTimeMillis;
      const requestJson = stableJson(input.nativeInput);
      const updated =
        token === undefined
          ? []
          : yield* sql`
        UPDATE linx_outbox SET dispatch_started_at = ${now}
        WHERE kind = 'suite-delegate' AND command_id = ${input.commandId}
          AND t3_thread_id = ${input.expectedChildThreadId} AND t3_project_id = ${input.parentProjectId}
          AND state = 'pending' AND request_version = ${REQUEST_VERSION}
          AND request_json = ${requestJson} AND execution_hash = ${sha256(requestJson)}
          AND dispatch_started_at IS NULL AND lease_token = ${token} AND lease_expires_at > ${now}
          AND EXISTS (
            SELECT 1 FROM suite_delegations d JOIN thread_expert_bindings b
              ON b.t3_thread_id = d.expected_child_thread_id
            WHERE d.idempotency_key = linx_outbox.idempotency_key AND d.state = 'pending'
              AND d.command_id = linx_outbox.command_id AND d.request_hash = linx_outbox.request_hash
              AND d.parent_thread_id = ${input.parentThreadId} AND d.parent_run_id = ${input.parentRunId}
              AND b.t3_thread_id = linx_outbox.t3_thread_id AND b.t3_project_id = linx_outbox.t3_project_id
              AND b.parent_thread_id = d.parent_thread_id AND b.suite_snapshot_id = d.suite_snapshot_id
              AND b.snapshot_id = d.member_snapshot_id AND b.member_key = d.member_key
          )
        RETURNING command_id
      `.pipe(Effect.mapError(storageFailure));
      if (updated.length !== 1) {
        return yield* Effect.fail(
          failure("forbidden", "The Suite delegation is no longer authorized to submit."),
        );
      }
    });

    const due = Effect.fn("SuiteDelegationService.due")(function* (parentThreadId?: ThreadId) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{ readonly idempotency_key: string }>`
        SELECT o.idempotency_key
        FROM linx_outbox o JOIN suite_delegations d ON d.idempotency_key = o.idempotency_key
        WHERE o.kind = 'suite-delegate' AND o.next_attempt_at <= ${now}
          AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= ${now})
          AND d.state IN ('pending', 'sent')
          ${parentThreadId === undefined ? sql`` : sql`AND d.parent_thread_id = ${parentThreadId}`}
        ORDER BY o.next_attempt_at, o.idempotency_key LIMIT ${BATCH_SIZE}
      `.pipe(Effect.mapError(storageFailure));
      return rows.map((row) => row.idempotency_key);
    });

    const claimRecovery = (key: string) =>
      claim(key).pipe(
        Effect.map((claimed) => (claimed === null ? null : leaseFor(claimed.row, claimed.token))),
      );

    const reloadLease = Effect.fn("SuiteDelegationService.reloadLease")(function* (
      lease: SuiteDelegationLease,
    ) {
      const now = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [current] = yield* sql`
          SELECT 1 FROM linx_outbox
          WHERE idempotency_key = ${lease.key} AND lease_token = ${lease.token} AND lease_expires_at > ${now}
        `;
            if (current === undefined) return null;
            const row = yield* select(lease.key);
            return row === undefined ? null : leaseFor(row, lease.token);
          }),
        )
        .pipe(Effect.mapError(storageFailure));
    });

    const settle = Effect.fn("SuiteDelegationService.settle")(function* (
      lease: SuiteDelegationLease,
      outcome: SuiteDelegationReconcileOutcome,
    ) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
            const requiresUnsubmitted =
              outcome.type === "cancelled" ||
              (outcome.type === "rejected" && outcome.reason === "native_preflight_rejected");
            const [held] = yield* sql`
          SELECT 1 FROM linx_outbox
          WHERE idempotency_key = ${lease.key} AND lease_token = ${lease.token} AND lease_expires_at > ${nowMs}
          ${
            requiresUnsubmitted
              ? sql`
            AND request_version = ${REQUEST_VERSION} AND dispatch_started_at IS NULL
          `
              : sql``
          }
        `;
            if (held === undefined) return false;

            if (outcome.type === "accepted") {
              const [updated] = yield* sql`
            UPDATE suite_delegations SET state = ${outcome.terminal ? "completed" : "sent"},
              parent_run_id = ${outcome.parentRunId}, t3_task_id = ${outcome.taskId},
              t3_run_id = ${outcome.childRunId}, last_error = NULL, updated_at = ${now}
            WHERE idempotency_key = ${lease.key} AND state IN ('pending', 'sent')
              AND (parent_run_id IS NULL OR parent_run_id = ${outcome.parentRunId})
              AND (t3_task_id IS NULL OR t3_task_id = ${outcome.taskId})
              AND (t3_run_id IS NULL OR t3_run_id = ${outcome.childRunId})
            RETURNING expected_child_thread_id
          `;
              if (updated === undefined) return false;
              yield* sql`
            UPDATE thread_expert_bindings SET t3_run_id = ${outcome.childRunId}
            WHERE t3_thread_id = ${lease.expectedChildThreadId}
              AND (t3_run_id IS NULL OR t3_run_id = ${outcome.childRunId})
          `;
            } else if (outcome.type === "rejected" || outcome.type === "cancelled") {
              const [updated] = yield* sql`
            UPDATE suite_delegations SET state = 'failed', last_error = ${outcome.reason}, updated_at = ${now}
            WHERE idempotency_key = ${lease.key} AND state = 'pending' AND t3_task_id IS NULL
            RETURNING idempotency_key
          `;
              if (updated === undefined) return false;
            }

            yield* sql`
          UPDATE linx_outbox SET lease_token = NULL, lease_expires_at = NULL, updated_at = ${now},
            next_attempt_at = ${
              outcome.type === "retry"
                ? nowMs + outcome.delayMs
                : outcome.type === "accepted" && !outcome.terminal
                  ? nowMs + 15_000
                  : null
            },
            last_error = ${outcome.type === "accepted" ? null : outcome.reason},
            consecutive_failures = ${
              outcome.type !== "retry" || outcome.reason === "awaiting_authenticated_parent"
                ? sql`0`
                : sql`CASE WHEN last_error = ${outcome.reason} THEN consecutive_failures + 1 ELSE 1 END`
            },
            state = ${
              outcome.type === "accepted"
                ? sql`'sent'`
                : outcome.type === "rejected" || outcome.type === "cancelled"
                  ? sql`'failed'`
                  : sql`state`
            }
          WHERE idempotency_key = ${lease.key} AND lease_token = ${lease.token}
        `;
            return true;
          }),
        )
        .pipe(Effect.mapError(storageFailure));
    });

    return SuiteDelegationService.of({
      members,
      find,
      prepare,
      claimSubmission,
      assertSubmission,
      due,
      claimRecovery,
      reloadLease,
      settle,
    });
  }),
);

function nativeInputFor(
  member: LinxSuiteMember,
  input: LinxSuiteDelegateInput,
  parentProjectId: string,
  leadModelSelection: ModelSelection | undefined,
  policy: LinxSuitePolicy,
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
            options: modelSelection.options ?? [],
          }),
      projectId: ProjectId.make(parentProjectId),
    },
    isolation: policy.workspaceIsolation ?? "shared",
    mode: "async",
    clientRequestId: input.clientRequestId,
    runtimeMode:
      policy.sandbox === "workspace-write" && member.runtimeMode !== "approval-required"
        ? "auto-accept-edits"
        : "approval-required",
    ...(member.interactionMode === undefined ? {} : { interactionMode: member.interactionMode }),
  };
}
