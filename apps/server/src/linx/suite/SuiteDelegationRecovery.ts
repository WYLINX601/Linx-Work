import { RunId, type LinxFailure, type ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { isActiveRun } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  SuiteDelegationService,
  type SuiteDelegationLease,
  type SuiteDelegationReconcileOutcome as Outcome,
} from "./SuiteDelegationService.ts";

const POLL_INTERVAL_MS = 5_000;

export class SuiteDelegationRecovery extends Context.Service<
  SuiteDelegationRecovery,
  {
    readonly reconcile: (parentThreadId?: ThreadId) => Effect.Effect<void, LinxFailure>;
    readonly reconcileKey: (key: string) => Effect.Effect<void, LinxFailure>;
    readonly reconcileSubmission: (
      lease: SuiteDelegationLease,
      preflightFailed: boolean,
    ) => Effect.Effect<void, LinxFailure>;
    readonly run: Effect.Effect<never>;
  }
>()("t3/linx/suite/SuiteDelegationRecovery") {}

const unavailableProjection = (lease: SuiteDelegationLease, reason: string): Outcome => {
  const previousFailures = lease.lastError === reason ? lease.consecutiveFailures : 0;
  return previousFailures >= 7
    ? { type: "quarantine", reason }
    : { type: "retry", reason, delayMs: Math.min(300_000, 5_000 * 2 ** previousFailures) };
};

export const layer = Layer.effect(
  SuiteDelegationRecovery,
  Effect.gen(function* () {
    const delegations = yield* SuiteDelegationService;
    const receipts = yield* CommandReceiptStoreV2;
    const projections = yield* ProjectionStoreV2;

    const inspect = Effect.fn("SuiteDelegationRecovery.inspect")(function* (
      lease: SuiteDelegationLease,
      preflightFailed: boolean,
    ) {
      const { commandId, parentThreadId, parentProjectId, expectedChildThreadId } = lease;
      const receipt = Option.getOrUndefined(yield* receipts.getByCommandId(commandId));
      if (
        receipt !== undefined &&
        (receipt.threadId !== parentThreadId || receipt.commandType !== "delegated_task.request")
      )
        return { type: "quarantine", reason: "receipt_identity_conflict" } satisfies Outcome;

      const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
      if (
        IdAllocator.derive.delegatedTaskThread({ commandId }) !== expectedChildThreadId ||
        (lease.recordedTaskId !== null && lease.recordedTaskId !== taskId)
      )
        return { type: "quarantine", reason: "reservation_identity_conflict" } satisfies Outcome;

      const parent = yield* projections.findThread(parentThreadId);
      if (parent !== null && parent.projectId !== parentProjectId) {
        return { type: "quarantine", reason: "parent_project_conflict" } satisfies Outcome;
      }
      const task =
        parent === null
          ? undefined
          : (yield* projections.getThreadRecords(parentThreadId, ["subagents"], {
              subagentIds: [taskId],
            })).subagents.find((candidate) => candidate.id === taskId);

      if (task !== undefined) {
        if (
          task.origin !== "app_owned" ||
          task.threadId !== parentThreadId ||
          task.childThreadId !== expectedChildThreadId ||
          task.runId === null ||
          (lease.parentRunId !== null && task.runId !== lease.parentRunId) ||
          receipt?.status === "rejected"
        )
          return { type: "quarantine", reason: "task_identity_conflict" } satisfies Outcome;

        const terminal =
          task.status === "completed" ||
          task.status === "failed" ||
          task.status === "cancelled" ||
          task.status === "interrupted";
        const child = yield* projections.findThread(expectedChildThreadId);
        if (child === null) {
          // The stable Run identity was previously verified, so a native terminal
          // task can release quota even if its child history has since been pruned.
          if (terminal && lease.recordedChildRunId !== null && lease.recordedTaskId === taskId) {
            return {
              type: "accepted",
              taskId,
              parentRunId: task.runId,
              childRunId: RunId.make(lease.recordedChildRunId),
              terminal,
            } satisfies Outcome;
          }
          return unavailableProjection(lease, "accepted_child_missing");
        }
        if (
          child.projectId !== parentProjectId ||
          child.lineage.parentThreadId !== parentThreadId ||
          child.lineage.relationshipToParent !== "subagent" ||
          child.forkedFrom?.type !== "node" ||
          child.forkedFrom.nodeId !== taskId
        )
          return { type: "quarantine", reason: "child_identity_conflict" } satisfies Outcome;

        const childMessageId = IdAllocator.derive.delegatedTaskMessage({ commandId });
        const { runs } = yield* projections.getThreadRecords(
          expectedChildThreadId,
          ["runs"],
          lease.recordedChildRunId === null
            ? undefined
            : { runIds: [RunId.make(lease.recordedChildRunId)] },
        );
        const childRun = runs.find((run) => run.userMessageId === childMessageId);
        if (childRun === undefined) return unavailableProjection(lease, "accepted_run_missing");
        if (childRun.threadId !== expectedChildThreadId) {
          return { type: "quarantine", reason: "run_identity_conflict" } satisfies Outcome;
        }
        // A preparing or even a terminal Run is not an extra start signal. T3
        // recovers preparation, continuations, cancellation and task settlement.
        return {
          type: "accepted",
          taskId,
          parentRunId: task.runId,
          childRunId: childRun.id,
          terminal,
        } satisfies Outcome;
      }

      if (receipt?.status === "accepted" || lease.recordedTaskId !== null) {
        return unavailableProjection(lease, "accepted_task_missing");
      }
      if ((yield* projections.findThread(expectedChildThreadId)) !== null) {
        return unavailableProjection(lease, "unpaired_child_projection");
      }
      if (receipt?.status === "rejected") {
        return { type: "rejected", reason: "native_rejected" } satisfies Outcome;
      }
      // T3 retains receipts and projections for different windows. Absence is
      // never proof of no commit. Only a versioned reservation still behind our
      // fenced native dispatch boundary gives us that proof.
      if (!lease.neverDispatched || lease.parentRunId === null) {
        return unavailableProjection(lease, "submission_outcome_unknown");
      }
      if (parent === null || parent.deletedAt !== null || parent.archivedAt !== null) {
        return { type: "cancelled", reason: "parent_stopped_before_submission" } satisfies Outcome;
      }
      const { runs } = yield* projections.getThreadRecords(parentThreadId, ["runs"], {
        runIds: [lease.parentRunId],
      });
      const run = runs.find((candidate) => candidate.id === lease.parentRunId);
      if (
        run === undefined ||
        !isActiveRun(run) ||
        (yield* projections.hasRunInterruptRequest(parentThreadId, lease.parentRunId))
      ) {
        return { type: "cancelled", reason: "parent_stopped_before_submission" } satisfies Outcome;
      }
      if (preflightFailed)
        return { type: "rejected", reason: "native_preflight_rejected" } satisfies Outcome;

      // Only a real authenticated MCP call may retry, and it must still belong to
      // this exact original Run. The worker does not restore or mint credentials.
      return {
        type: "retry",
        reason: "awaiting_authenticated_parent",
        delayMs: 15_000,
      } satisfies Outcome;
    });

    const reconcileLease = Effect.fn("SuiteDelegationRecovery.reconcileLease")(function* (
      lease: SuiteDelegationLease,
      preflightFailed = false,
    ) {
      const outcome: Outcome = yield* inspect(lease, preflightFailed).pipe(
        Effect.orElseSucceed(() => ({
          type: "retry" as const,
          reason: "native_store_unavailable",
          delayMs: 30_000,
        })),
      );
      const stored = yield* delegations.settle(lease, outcome);
      if (stored && outcome.type === "quarantine") {
        yield* Effect.logWarning("Quarantined a Suite delegation reservation", {
          delegationId: lease.commandId,
          reason: outcome.reason,
        });
      }
    });

    const reconcileKey = Effect.fn("SuiteDelegationRecovery.reconcileKey")(function* (key: string) {
      const lease = yield* delegations.claimRecovery(key);
      if (lease !== null) yield* reconcileLease(lease);
    });

    const reconcile = Effect.fn("SuiteDelegationRecovery.reconcile")(function* (
      parentThreadId?: ThreadId,
    ) {
      const keys = yield* delegations.due(parentThreadId);
      yield* Effect.forEach(keys, reconcileKey, { concurrency: 4, discard: true });
    });

    const reconcileSubmission = Effect.fn("SuiteDelegationRecovery.reconcileSubmission")(function* (
      lease: SuiteDelegationLease,
      preflightFailed: boolean,
    ) {
      // The trusted request may have crossed the native dispatch fence after the
      // lease was acquired. Reload the marker before making any release decision.
      const current = yield* delegations.reloadLease(lease);
      if (current !== null) yield* reconcileLease(current, preflightFailed);
    });

    const run = reconcile().pipe(
      Effect.catch((error) =>
        Effect.logWarning("Suite delegation recovery sweep failed", { code: error.code }),
      ),
      Effect.andThen(Effect.sleep(POLL_INTERVAL_MS)),
      Effect.forever,
    );
    return SuiteDelegationRecovery.of({ reconcile, reconcileKey, reconcileSubmission, run });
  }),
);
