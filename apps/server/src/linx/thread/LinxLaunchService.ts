// @effect-diagnostics nodeBuiltinImport:off - request ids are hashed with node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  type LinxFailure,
  LinxFailureCode,
  type LinxLaunchThreadInput,
  type LinxLaunchThreadResult,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";

import { ExpertSnapshotService } from "../expert/ExpertSnapshotService.ts";
import { ThreadBindingRepository } from "./ThreadBindingRepository.ts";
import { ThreadLauncher } from "./ThreadLauncher.ts";

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

const commandIdFor = (clientRequestId: string): string => `linx:launch:${sha256(clientRequestId)}`;

const requestHashFor = (input: LinxLaunchThreadInput): string =>
  sha256(
    stableJson({
      snapshotId: input.snapshotId,
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
const terminalFailure = (code: LinxFailure["code"], threadId: string) =>
  failure(code, "The thread launch was rejected.", threadId);

export class LinxLaunchService extends Context.Service<
  LinxLaunchService,
  {
    readonly launch: (
      input: LinxLaunchThreadInput,
    ) => Effect.Effect<LinxLaunchThreadResult, LinxFailure>;
  }
>()("t3/linx/thread/LinxLaunchService") {}

export const layer = Layer.effect(
  LinxLaunchService,
  Effect.gen(function* () {
    const snapshots = yield* ExpertSnapshotService;
    const bindings = yield* ThreadBindingRepository;
    const launcher = yield* ThreadLauncher;

    const launch = Effect.fn("LinxLaunchService.launch")(function* (input: LinxLaunchThreadInput) {
      const snapshot = yield* snapshots
        .getById(input.snapshotId)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "LinxSnapshotIntegrityError"
              ? failure("snapshot_integrity", "The expert snapshot failed its integrity check.")
              : failure("launch_failed", "The expert snapshot could not be read."),
          ),
        );
      if (snapshot === null) {
        return yield* Effect.fail(
          failure("snapshot_missing", "The expert snapshot does not exist."),
        );
      }

      const commandId = commandIdFor(input.clientRequestId);
      const threadId = commandId;
      const messageId = commandId;
      const requestHash = requestHashFor(input);

      const bound = yield* bindings
        .bindAndEnqueue({
          idempotencyKey: input.clientRequestId,
          kind: "launch",
          requestHash,
          commandId,
          threadId,
          projectId: input.projectId,
          snapshotId: snapshot.snapshotId,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "LinxIdempotencyConflictError"
              ? failure(
                  "idempotency_conflict",
                  "This client request id was already used with a different payload.",
                  threadId,
                )
              : failure("launch_failed", "The launch could not be persisted.", threadId),
          ),
        );

      if (bound.outbox.state === "sent") {
        return {
          threadId: ThreadId.make(threadId),
          snapshotId: snapshot.snapshotId,
          resumed: true,
        } satisfies LinxLaunchThreadResult;
      }
      if (bound.outbox.state === "failed") {
        return yield* Effect.fail(
          terminalFailure(
            isFailureCode(bound.outbox.lastError) ? bound.outbox.lastError : "launch_failed",
            threadId,
          ),
        );
      }
      const recordError = Effect.mapError(() =>
        failure("launch_failed", "The launch outcome could not be persisted.", threadId),
      );

      const outcome = yield* launcher
        .launch({
          commandId,
          threadId,
          messageId: MessageId.make(messageId),
          input,
        })
        .pipe(Effect.result);

      if (outcome._tag === "Failure") {
        const launchFailure = outcome.failure;
        if (retryable(launchFailure.code)) {
          yield* bindings.markPending(input.clientRequestId, launchFailure.code).pipe(recordError);
          return yield* Effect.fail(launchFailure);
        }
        yield* bindings.markFailed(input.clientRequestId, launchFailure.code).pipe(recordError);
        return yield* Effect.fail(terminalFailure(launchFailure.code, threadId));
      }

      yield* bindings.markSent(input.clientRequestId, outcome.success.runId).pipe(recordError);
      return {
        threadId: ThreadId.make(threadId),
        snapshotId: snapshot.snapshotId,
        resumed: bound.resumed || outcome.success.resumed,
      } satisfies LinxLaunchThreadResult;
    });

    return LinxLaunchService.of({ launch });
  }),
);
