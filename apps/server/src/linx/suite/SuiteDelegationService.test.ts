import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as T3Sqlite from "../../persistence/Sqlite.ts";

import { ExpertSnapshotService, layer as expertLayer } from "../expert/ExpertSnapshotService.ts";
import { layer as linxSqliteLayer, LinxSqlClient } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import Migration001 from "../persistence/Migrations/001_Initial.ts";
import Migration005 from "../persistence/Migrations/005_Suites.ts";
import Migration006 from "../persistence/Migrations/006_SuiteDelegationRecovery.ts";
import {
  layer as bindingLayer,
  ThreadBindingRepository,
} from "../thread/ThreadBindingRepository.ts";
import { SuiteService, layer as suiteLayer } from "./SuiteService.ts";
import { SuiteDelegationRecovery, layer as recoveryLayer } from "./SuiteDelegationRecovery.ts";
import {
  SuiteDelegationService,
  SuiteDelegationSubmissionLease,
  layer as delegationLayer,
} from "./SuiteDelegationService.ts";

const snapshot = (expertId: string) => ({
  expertId,
  revision: 1,
  persona: expertId,
  references: [],
  skillSelection: [],
  mcpGrants: [],
  connectionRevisions: {},
});

const suites = suiteLayer.pipe(Layer.provide(expertLayer));
const nativeStore = Layer.mergeAll(Receipts.layer, Projections.layer).pipe(
  Layer.provide(T3Sqlite.layerMemory),
);
const stack = recoveryLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      nativeStore,
      suites,
      expertLayer,
      bindingLayer,
      delegationLayer.pipe(Layer.provide(suites), Layer.provide(bindingLayer)),
    ),
  ),
  Layer.provideMerge(linxSqliteLayer(":memory:")),
  Layer.provide(NodeServices.layer),
);

const withServices = <A, E>(
  run: () => Effect.Effect<
    A,
    E,
    | SuiteService
    | SuiteDelegationService
    | SuiteDelegationRecovery
    | Receipts.CommandReceiptStoreV2
    | Projections.ProjectionStoreV2
    | ExpertSnapshotService
    | ThreadBindingRepository
    | LinxSqlClient
  >,
) =>
  Effect.gen(function* () {
    yield* runLinxMigrations;
    return yield* run();
  }).pipe(Effect.provide(stack));

const threadId = ThreadId.make("lead-thread");
const parentRunId = RunId.make("lead-original-run");
const subsequentRunId = RunId.make("lead-subsequent-run");
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

const request = {
  parentThreadId: threadId,
  parentRunId,
  memberKey: "member",
  clientRequestId: "delegate-1",
  objective: "Check the diff",
  acceptance: "Name one risk",
};
const competing = { ...request, clientRequestId: "delegate-2" };

const bindSuite = Effect.fnUntraced(function* (worktree = false) {
  const snapshots = yield* ExpertSnapshotService;
  const suites = yield* SuiteService;
  const bindings = yield* ThreadBindingRepository;
  yield* snapshots.create(snapshot("lead"));
  yield* snapshots.create(snapshot("member"));
  const suite = yield* suites.save({
    name: "Suite",
    leadExpertId: "lead",
    leadExpertRevision: 1,
    members: [{ memberKey: "member", expertId: "member", revision: 1 }],
    policy: {
      maxActiveDelegations: 1,
      ...(worktree
        ? ({ sandbox: "workspace-write", workspaceIsolation: "worktree" } as const)
        : {}),
    },
  });
  const frozen = yield* suites.freeze(suite.suiteId);
  yield* bindings.bindAndEnqueue({
    idempotencyKey: "lead-launch",
    requestHash: "lead",
    kind: "suite-launch",
    commandId: "lead-thread",
    threadId,
    projectId,
    snapshotId: frozen.content.lead.snapshotId,
    suiteSnapshotId: frozen.suiteSnapshotId,
  });
  return frozen;
});

const projectThread = Effect.fnUntraced(function* (
  id: ThreadId,
  runId: RunId,
  options?: { readonly taskId: NodeId; readonly messageId: MessageId },
) {
  const projection = yield* Projections.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const rootNodeId = NodeId.make(`${id}:root`);
  yield* projection.apply({
    id: EventId.make(`${id}:created`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: {
      id,
      projectId,
      title: id,
      providerInstanceId,
      modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: options === undefined ? null : threadId,
        relationshipToParent: options === undefined ? null : "subagent",
        rootThreadId: threadId,
      },
      forkedFrom: options === undefined ? null : { type: "node", nodeId: options.taskId },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      createdBy: "user",
      creationSource: "web",
    },
  });
  yield* projection.apply({
    id: EventId.make(`${id}:run-created`),
    type: "run.created",
    threadId: id,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId: id,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: options?.messageId ?? MessageId.make(`${id}:message`),
      rootNodeId,
      activeAttemptId: null,
      status: options === undefined ? "running" : "preparing",
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    } satisfies OrchestrationV2Run,
  });
});

it.effect(
  "atomically reserves quota and the frozen child binding under duplicate and concurrent calls",
  () =>
    withServices(() =>
      Effect.gen(function* () {
        const frozen = yield* bindSuite(true);
        const delegations = yield* SuiteDelegationService;
        const bindings = yield* ThreadBindingRepository;
        const members = yield* delegations.members(threadId);
        assert.equal(members[0]?.memberKey, "member");

        const [left, duplicate, other] = yield* Effect.all(
          [
            Effect.result(delegations.prepare(request)),
            Effect.result(delegations.prepare(request)),
            Effect.result(delegations.prepare(competing)),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(left, duplicate);
        const winner = left._tag === "Success" ? left : other;
        const loser = left._tag === "Failure" ? left : other;
        if (winner._tag !== "Success" || loser._tag !== "Failure") {
          return assert.fail("Exactly one distinct key must acquire quota");
        }
        assert.equal(loser.failure.code, "limit_exceeded");
        const winningRequest = winner === other ? competing : request;
        const { key } = winner.success;
        const conflict = yield* Effect.flip(
          delegations.prepare({ ...winningRequest, objective: "Different" }),
        );
        assert.equal(conflict.code, "idempotency_conflict");
        assert.isNull(yield* delegations.claimSubmission(key, subsequentRunId));

        const leases = yield* Effect.all(
          [
            delegations.claimSubmission(key, parentRunId),
            delegations.claimSubmission(key, parentRunId),
          ],
          { concurrency: "unbounded" },
        );
        assert.lengthOf(leases.filter(Boolean), 1);
        const prepared = leases[0] ?? leases[1];
        if (prepared === null) return assert.fail("No submission held the lease");
        assert.match(prepared.commandId, /^linx:suite:delegate:/);
        assert.equal(prepared.parentRunId, parentRunId);
        assert.equal(prepared.nativeInput.isolation, "worktree");
        assert.equal(prepared.nativeInput.runtimeMode, "auto-accept-edits");
        const child = yield* bindings.getBinding(prepared.expectedChildThreadId);
        assert.equal(child?.snapshotId, frozen.content.members[0]?.snapshotId);
        assert.equal(child?.parentThreadId, threadId);
        assert.isNull(child?.runId);
      }),
    ),
);

it.effect(
  "recovers lost submission responses from T3 without resubmitting and releases quota only on native terminal status",
  () =>
    withServices(() =>
      Effect.gen(function* () {
        yield* bindSuite();
        yield* projectThread(threadId, parentRunId);
        const delegations = yield* SuiteDelegationService;
        const recovery = yield* SuiteDelegationRecovery;
        const projection = yield* Projections.ProjectionStoreV2;
        const receipts = yield* Receipts.CommandReceiptStoreV2;
        const sql = yield* LinxSqlClient;
        const { key } = yield* delegations.prepare(request);
        const prepared = yield* delegations.claimSubmission(key, parentRunId);
        if (prepared === null) return assert.fail("No submission lease");
        assert.equal(prepared.nativeInput.isolation, "shared");
        const rewritten = yield* Effect.flip(
          delegations
            .assertSubmission({
              ...prepared,
              nativeInput: { ...prepared.nativeInput, task: "Rewritten task" },
            })
            .pipe(Effect.provideService(SuiteDelegationSubmissionLease, prepared.token)),
        );
        assert.equal(rewritten.code, "forbidden");
        assert.equal(prepared.nativeInput.runtimeMode, "approval-required");
        const begin = delegations
          .assertSubmission(prepared)
          .pipe(Effect.provideService(SuiteDelegationSubmissionLease, prepared.token));
        yield* begin;
        assert.equal((yield* Effect.flip(begin)).code, "forbidden");
        yield* stopProjectedRun();

        yield* recovery.reconcileSubmission(prepared, true);
        assert.isNull(yield* delegations.claimSubmission(key, parentRunId));
        assert.equal((yield* Effect.flip(delegations.prepare(competing))).code, "limit_exceeded");
        const errorClass = sql<{ readonly last_error: string }>`
      SELECT last_error FROM linx_outbox WHERE idempotency_key = ${key}
    `;
        assert.equal((yield* errorClass)[0]?.last_error, "submission_outcome_unknown");

        const now = yield* DateTime.now;
        const { commandId, expectedChildThreadId } = prepared;
        const receipt = {
          commandId,
          threadId,
          commandType: "delegated_task.request",
          acceptedAt: now,
          resultSequence: 1,
          status: "accepted",
          error: null,
        } as const;
        yield* receipts.upsert(receipt);
        yield* TestClock.adjust("1 minute");
        yield* recovery.reconcile();
        assert.equal((yield* errorClass)[0]?.last_error, "accepted_task_missing");
        assert.isNull((yield* delegations.find(request))?.taskId);

        const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
        const childRunId = RunId.make("child-first-run");
        yield* projectThread(expectedChildThreadId, childRunId, {
          taskId,
          messageId: IdAllocator.derive.delegatedTaskMessage({ commandId }),
        });
        const task: OrchestrationV2Subagent = {
          id: taskId,
          threadId,
          runId: parentRunId,
          parentNodeId: NodeId.make("lead-root"),
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: expectedChildThreadId,
          nativeTaskRef: null,
          prompt: prepared.nativeInput.task,
          title: null,
          model: modelSelection.model,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        yield* projection.apply({
          id: EventId.make("task-created"),
          type: "subagent.updated",
          threadId,
          runId: parentRunId,
          nodeId: taskId,
          occurredAt: now,
          payload: task,
        });
        yield* TestClock.adjust("1 minute");
        yield* recovery.reconcile();
        const accepted = yield* delegations.prepare({ ...request, parentRunId: subsequentRunId });
        assert.equal(accepted.taskId, taskId);
        const bindings = yield* ThreadBindingRepository;
        assert.equal((yield* bindings.getBinding(expectedChildThreadId))?.runId, childRunId);
        assert.equal((yield* Effect.flip(delegations.prepare(competing))).code, "limit_exceeded");

        yield* projection.apply({
          id: EventId.make("task-cancelled"),
          type: "subagent.updated",
          threadId,
          runId: parentRunId,
          nodeId: taskId,
          occurredAt: now,
          payload: { ...task, status: "cancelled", completedAt: now },
        });
        yield* TestClock.adjust("15 seconds");
        yield* recovery.reconcile();
        assert.equal((yield* delegations.find(request))?.state, "completed");
        assert.equal((yield* delegations.prepare(competing)).state, "pending");
        assert.isNull(yield* delegations.claimSubmission(key, subsequentRunId));
      }),
    ),
);

const stopProjectedRun = Effect.fnUntraced(function* () {
  const projection = yield* Projections.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const nodeId = NodeId.make(`${threadId}:root`);
  yield* projection.apply({
    id: EventId.make("parent-stop"),
    type: "turn-item.updated",
    threadId,
    runId: parentRunId,
    nodeId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make("parent-stop-item"),
      threadId,
      runId: parentRunId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Interrupt requested",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "run_interrupt_request",
      message: "Stopped by the user",
    },
  });
});

it.effect("seals a stopped parent's unsubmitted intent and rejects a fenced stale caller", () =>
  withServices(() =>
    Effect.gen(function* () {
      yield* bindSuite();
      yield* projectThread(threadId, parentRunId);
      const delegations = yield* SuiteDelegationService;
      const recovery = yield* SuiteDelegationRecovery;
      const { key } = yield* delegations.prepare(request);
      const prepared = yield* delegations.claimSubmission(key, parentRunId);
      if (prepared === null) return assert.fail("No submission lease");
      yield* TestClock.adjust("2 minutes");
      yield* stopProjectedRun();
      yield* recovery.reconcile();
      assert.equal((yield* delegations.find(request))?.state, "failed");
      assert.equal((yield* delegations.prepare(competing)).state, "pending");
      assert.isNull(yield* delegations.claimSubmission(key, parentRunId));
      const late = yield* Effect.flip(
        delegations
          .assertSubmission(prepared)
          .pipe(Effect.provideService(SuiteDelegationSubmissionLease, prepared.token)),
      );
      assert.equal(late.code, "forbidden");
    }),
  ),
);

it.effect("uses a matching native rejection receipt to release a fenced request", () =>
  withServices(() =>
    Effect.gen(function* () {
      yield* bindSuite();
      yield* projectThread(threadId, parentRunId);
      const delegations = yield* SuiteDelegationService;
      const recovery = yield* SuiteDelegationRecovery;
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const { key } = yield* delegations.prepare(request);
      const prepared = yield* delegations.claimSubmission(key, parentRunId);
      if (prepared === null) return assert.fail("No submission lease");
      yield* delegations
        .assertSubmission(prepared)
        .pipe(Effect.provideService(SuiteDelegationSubmissionLease, prepared.token));
      yield* receipts.upsert({
        commandId: prepared.commandId,
        threadId,
        commandType: "delegated_task.request",
        acceptedAt: yield* DateTime.now,
        resultSequence: 0,
        status: "rejected",
        error: "Parent run is stopping",
      });
      yield* TestClock.adjust("2 minutes");
      yield* recovery.reconcile();
      assert.equal((yield* delegations.find(request))?.state, "failed");
      assert.equal((yield* delegations.prepare(competing)).state, "pending");
      assert.isNull(yield* delegations.claimSubmission(key, parentRunId));
    }),
  ),
);

it.effect(
  "upgrades legacy delegation keys without changing command IDs or making unknown requests eligible to dispatch",
  () =>
    Effect.gen(function* () {
      const client = yield* LinxSqlClient;
      const sql = yield* SqlClient.SqlClient;
      yield* Migration001;
      yield* Migration005;
      const legacyKey = "lead\0req\0é";
      yield* sql`
      INSERT INTO suite_delegations
        (idempotency_key, parent_thread_id, client_request_id, request_hash, command_id,
         member_key, expected_child_thread_id, member_snapshot_id, suite_snapshot_id,
         state, created_at, updated_at)
      VALUES (${legacyKey}, 'lead', ${"req\0é"}, 'hash', 'command', 'member', 'child',
              'member-snapshot', 'suite-snapshot', 'failed', 'created', 'updated')
    `;
      yield* sql`
      INSERT INTO linx_outbox
        (idempotency_key, kind, request_hash, command_id, t3_thread_id, t3_project_id,
         state, created_at, updated_at)
      VALUES (${legacyKey}, 'suite-delegate', 'hash', 'command', 'child', 'project',
              'failed', 'created', 'updated')
    `;
      yield* Migration006;
      const rows = yield* client`
      SELECT d.idempotency_key, d.command_id, d.state, o.request_version, o.next_attempt_at
      FROM suite_delegations d JOIN linx_outbox o USING (idempotency_key)
    `;
      assert.deepEqual(rows, [
        {
          idempotency_key: "suite-delegate:6c656164:72657100c3a9",
          command_id: "command",
          state: "pending",
          request_version: null,
          next_attempt_at: 0,
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.effect(SqlClient.SqlClient, LinxSqlClient).pipe(
          Layer.provideMerge(linxSqliteLayer(":memory:")),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
