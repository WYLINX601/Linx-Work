// @effect-diagnostics nodeBuiltinImport:off - suite launch ids use node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  LinxFailureCode,
  type LinxFailure,
  type LinxLaunchSuiteInput,
  type LinxSuiteBinding,
  type LinxSuiteLaunchResult,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { ExpertSnapshotService } from "../expert/ExpertSnapshotService.ts";
import { SkillPackageService } from "../skill/SkillPackageService.ts";
import { ThreadBindingRepository } from "../thread/ThreadBindingRepository.ts";
import { ThreadLauncher } from "../thread/ThreadLauncher.ts";
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

const commandIdFor = (clientRequestId: string): string =>
  `linx:suite:launch:${sha256(clientRequestId)}`;

const requestHashFor = (input: LinxLaunchSuiteInput): string =>
  sha256(
    stableJson({
      suiteId: input.suiteId,
      suiteRevision: input.suiteRevision ?? null,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspaceStrategy: input.workspaceStrategy,
      initialMessage: input.initialMessage,
    }),
  );

const failure = (code: LinxFailure["code"], message: string, threadId?: string): LinxFailure => ({
  code,
  message,
  ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
});

const retryable = (code: LinxFailure["code"]): boolean =>
  code === "provider_unavailable" || code === "launch_failed";

const isFailureCode = Schema.is(LinxFailureCode);

export class SuiteLaunchService extends Context.Service<
  SuiteLaunchService,
  {
    readonly launch: (
      input: LinxLaunchSuiteInput,
    ) => Effect.Effect<LinxSuiteLaunchResult, LinxFailure>;
    readonly getBinding: (threadId: string) => Effect.Effect<LinxSuiteBinding | null, LinxFailure>;
  }
>()("t3/linx/suite/SuiteLaunchService") {}

export const layer = Layer.effect(
  SuiteLaunchService,
  Effect.gen(function* () {
    const suites = yield* SuiteService;
    const snapshots = yield* ExpertSnapshotService;
    const skills = yield* SkillPackageService;
    const bindings = yield* ThreadBindingRepository;
    const launcher = yield* ThreadLauncher;

    const launch = Effect.fn("SuiteLaunchService.launch")(function* (input: LinxLaunchSuiteInput) {
      const snapshot = yield* suites.freeze(input.suiteId, input.suiteRevision).pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "LinxDefinitionArchivedError":
              return failure("snapshot_missing", "The selected suite is archived.");
            case "LinxDefinitionMissingError":
              return failure("not_found", "The selected suite does not exist.");
            case "LinxDependencyMissingError":
              return failure("dependency_missing", "A suite member snapshot is missing.");
            default:
              return failure("launch_failed", "The suite snapshot could not be frozen.");
          }
        }),
      );
      const leadSnapshotId = snapshot.content.lead.snapshotId;
      const lead = yield* snapshots
        .getById(leadSnapshotId)
        .pipe(
          Effect.mapError(() =>
            failure("snapshot_integrity", "The Lead expert snapshot could not be read."),
          ),
        );
      if (lead === null) {
        return yield* Effect.fail(
          failure("snapshot_missing", "The Lead expert snapshot does not exist."),
        );
      }
      const assembly = yield* skills
        .resolveAssembly(lead.skillSelection)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "LinxDependencyMissingError"
              ? failure("dependency_missing", "A Lead skill is missing or its hash changed.")
              : failure("launch_failed", "The Lead skill assembly could not be resolved."),
          ),
        );

      const commandId = commandIdFor(input.clientRequestId);
      const threadId = commandId;
      const requestHash = requestHashFor(input);
      const bound = yield* bindings
        .bindAndEnqueue({
          idempotencyKey: input.clientRequestId,
          kind: "suite-launch",
          requestHash,
          commandId,
          threadId,
          projectId: input.projectId,
          snapshotId: leadSnapshotId,
          suiteSnapshotId: snapshot.suiteSnapshotId,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "LinxIdempotencyConflictError"
              ? failure(
                  "idempotency_conflict",
                  "This client request id was already used with a different payload.",
                  threadId,
                )
              : failure("launch_failed", "The suite launch could not be persisted.", threadId),
          ),
        );

      if (bound.outbox.state === "sent") {
        return {
          threadId: ThreadId.make(threadId),
          suiteSnapshotId: snapshot.suiteSnapshotId,
          leadSnapshotId,
          resumed: true,
        } satisfies LinxSuiteLaunchResult;
      }
      if (bound.outbox.state === "failed") {
        return yield* Effect.fail(
          failure(
            isFailureCode(bound.outbox.lastError) ? bound.outbox.lastError : "launch_failed",
            "The suite launch was rejected.",
            threadId,
          ),
        );
      }
      const recordError = Effect.mapError(() =>
        failure("launch_failed", "The suite launch outcome could not be persisted.", threadId),
      );
      const outcome = yield* launcher
        .launch({
          commandId,
          threadId,
          messageId: MessageId.make(commandId),
          input: {
            clientRequestId: input.clientRequestId,
            snapshotId: leadSnapshotId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            workspaceStrategy: input.workspaceStrategy,
            initialMessage: input.initialMessage,
          },
        })
        .pipe(Effect.result);
      if (outcome._tag === "Failure") {
        const launchFailure = outcome.failure;
        if (retryable(launchFailure.code)) {
          yield* bindings.markPending(input.clientRequestId, launchFailure.code).pipe(recordError);
          return yield* Effect.fail(launchFailure);
        }
        yield* bindings.markFailed(input.clientRequestId, launchFailure.code).pipe(recordError);
        return yield* Effect.fail(
          failure(launchFailure.code, "The suite launch was rejected.", threadId),
        );
      }
      yield* bindings
        .markSent(input.clientRequestId, outcome.success.runId, {
          snapshotId: leadSnapshotId,
          assemblyJson: assembly.assemblyJson,
          assemblyHash: assembly.assemblyHash,
        })
        .pipe(recordError);
      return {
        threadId: ThreadId.make(threadId),
        suiteSnapshotId: snapshot.suiteSnapshotId,
        leadSnapshotId,
        resumed: bound.resumed || outcome.success.resumed,
      } satisfies LinxSuiteLaunchResult;
    });

    const getBinding = Effect.fn("SuiteLaunchService.getBinding")(function* (threadId: string) {
      const binding = yield* bindings
        .getBinding(threadId)
        .pipe(
          Effect.mapError(() =>
            failure("launch_failed", "The suite thread binding could not be read."),
          ),
        );
      if (binding === null || binding.suiteSnapshotId === null) return null;
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
      return {
        threadId: ThreadId.make(threadId),
        suiteId: snapshot.content.suiteId,
        suiteRevision: snapshot.content.suiteRevision,
        suiteSnapshotId: snapshot.suiteSnapshotId,
        leadExpertId: snapshot.content.lead.expertId,
        leadRevision: snapshot.content.lead.revision,
        projectId: ProjectId.make(binding.projectId),
        createdAt: binding.createdAt,
      } satisfies LinxSuiteBinding;
    });

    return SuiteLaunchService.of({ launch, getBinding });
  }),
);
