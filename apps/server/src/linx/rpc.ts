import { LinxWsRpcGroup, ProjectId, WS_METHODS, type LinxFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ExpertDefinitionService } from "./expert/ExpertDefinitionService.ts";
import { ExpertSnapshotService } from "./expert/ExpertSnapshotService.ts";
import { LinxResourceStore } from "./persistence/LinxResourceStore.ts";
import { SkillPackageService } from "./skill/SkillPackageService.ts";
import { LinxLaunchService } from "./thread/LinxLaunchService.ts";
import { ThreadBindingRepository } from "./thread/ThreadBindingRepository.ts";

const failure = (code: LinxFailure["code"], message: string): LinxFailure => ({ code, message });

const mapError = (error: { readonly _tag: string }): LinxFailure => {
  switch (error._tag) {
    case "LinxRevisionConflictError":
      return failure("revision_conflict", "The item was changed by another save.");
    case "LinxDefinitionMissingError":
      return failure("not_found", "The requested Linx item does not exist.");
    case "LinxDefinitionArchivedError":
      return failure("revision_conflict", "The item is archived and cannot be changed.");
    case "LinxDependencyMissingError":
      return failure("dependency_missing", "A referenced Linx item is missing or does not match.");
    case "LinxLimitExceededError":
      return failure("limit_exceeded", "The skill package exceeds an import limit.");
    case "LinxSnapshotConflictError":
      return failure("idempotency_conflict", "This expert revision already has different content.");
    case "LinxSnapshotIntegrityError":
      return failure("snapshot_integrity", "A Linx snapshot failed its integrity check.");
    case "LinxResourcePathError":
      return failure("invalid_request", "A Linx resource path was rejected.");
    case "LinxIdempotencyConflictError":
      return failure("idempotency_conflict", "This request was already used with different input.");
    default:
      return failure("launch_failed", "The Linx request could not be completed.");
  }
};

const mapped = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.mapError(mapError));

export const layer = LinxWsRpcGroup.toLayer(
  Effect.gen(function* () {
    const snapshots = yield* ExpertSnapshotService;
    const definitions = yield* ExpertDefinitionService;
    const bindings = yield* ThreadBindingRepository;
    const resources = yield* LinxResourceStore;
    const skills = yield* SkillPackageService;
    const launches = yield* LinxLaunchService;

    return LinxWsRpcGroup.of({
      [WS_METHODS.linxExpertsCreateSnapshot]: Effect.fn("LinxRpc.createSnapshot")(
        function* (input) {
          for (const reference of input.references) {
            const filename = reference.relativePath.split("/").at(-1);
            const invalid = failure(
              "invalid_request",
              "An expert resource is missing or its hash does not match.",
            );
            if (filename?.split(".", 1)[0] !== reference.sha256) return yield* Effect.fail(invalid);
            yield* resources.read(reference.relativePath).pipe(Effect.mapError(() => invalid));
          }
          return yield* snapshots.create(input).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "LinxSnapshotConflictError":
                  return failure(
                    "idempotency_conflict",
                    "This expert revision already has different content.",
                  );
                case "LinxSnapshotIntegrityError":
                  return failure(
                    "snapshot_integrity",
                    "The expert snapshot failed its integrity check.",
                  );
                default:
                  return failure("launch_failed", "The expert snapshot could not be created.");
              }
            }),
          );
        },
      ),
      [WS_METHODS.linxExpertsList]: () =>
        snapshots
          .listLatest()
          .pipe(
            Effect.mapError((error) =>
              error._tag === "LinxSnapshotIntegrityError"
                ? failure("snapshot_integrity", "An expert snapshot failed its integrity check.")
                : failure("launch_failed", "The expert list could not be read."),
            ),
          ),
      [WS_METHODS.linxExpertsListDefinitions]: () => mapped(definitions.list()),
      [WS_METHODS.linxExpertsGetDefinition]: ({ expertId }) => mapped(definitions.get(expertId)),
      [WS_METHODS.linxExpertsSave]: (input) => mapped(definitions.save(input)),
      [WS_METHODS.linxExpertsArchive]: ({ expertId, expectedRevision }) =>
        mapped(definitions.archive(expertId, expectedRevision)),
      [WS_METHODS.linxSkillsImport]: ({ path }) => mapped(skills.importDirectory(path)),
      [WS_METHODS.linxSkillsList]: () => mapped(skills.list()),
      [WS_METHODS.linxSkillsGet]: ({ packageId, revision }) =>
        mapped(skills.get(packageId, revision)),
      [WS_METHODS.linxSkillsArchive]: ({ packageId, expectedRevision }) =>
        mapped(skills.archive(packageId, expectedRevision)),
      [WS_METHODS.linxThreadsLaunch]: launches.launch,
      [WS_METHODS.linxThreadsGetBinding]: Effect.fn("LinxRpc.getBinding")(function* ({ threadId }) {
        const binding = yield* bindings
          .getBinding(threadId)
          .pipe(
            Effect.mapError(() =>
              failure("launch_failed", "The thread binding could not be read."),
            ),
          );
        if (binding === null) return null;
        const snapshot = yield* snapshots
          .getById(binding.snapshotId)
          .pipe(
            Effect.mapError(() =>
              failure("snapshot_integrity", "The bound expert snapshot could not be read."),
            ),
          );
        if (snapshot === null) {
          return yield* Effect.fail(
            failure("snapshot_missing", "The bound expert snapshot does not exist."),
          );
        }
        return {
          threadId,
          projectId: ProjectId.make(binding.projectId),
          snapshotId: snapshot.snapshotId,
          expertId: snapshot.expertId,
          revision: snapshot.revision,
          contentHash: snapshot.contentHash,
          createdAt: binding.createdAt,
        };
      }),
    });
  }),
);
