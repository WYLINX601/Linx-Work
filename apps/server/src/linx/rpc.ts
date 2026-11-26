import { LinxWsRpcGroup, ProjectId, WS_METHODS, type LinxFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ExpertDefinitionService } from "./expert/ExpertDefinitionService.ts";
import { ExpertSnapshotService } from "./expert/ExpertSnapshotService.ts";
import { McpConnectionService } from "./mcp/McpConnectionService.ts";
import { LinxResourceStore } from "./persistence/LinxResourceStore.ts";
import { SkillPackageService } from "./skill/SkillPackageService.ts";
import { SuiteLaunchService } from "./suite/SuiteLaunchService.ts";
import { SuiteService } from "./suite/SuiteService.ts";
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
    case "LinxMcpTransportError":
      return failure("provider_unavailable", "The external MCP endpoint could not be used.");
    case "LinxSecretStoreError":
      return failure("unsupported", "A credential could not be stored securely on this machine.");
    case "LinxSnapshotConflictError":
      return failure("idempotency_conflict", "This expert revision already has different content.");
    case "LinxSnapshotIntegrityError":
      return failure("snapshot_integrity", "A Linx snapshot failed its integrity check.");
    case "LinxResourcePathError":
      return failure("invalid_request", "A Linx resource path was rejected.");
    case "LinxSuitePolicyError":
      return failure("invalid_request", "The suite execution policy is not supported.");
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
    const suites = yield* SuiteService;
    const suiteLaunches = yield* SuiteLaunchService;
    const connections = yield* McpConnectionService;
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
      [WS_METHODS.linxSuitesList]: () => mapped(suites.list()),
      [WS_METHODS.linxSuitesGet]: ({ suiteId }) => mapped(suites.get(suiteId)),
      [WS_METHODS.linxSuitesSave]: (input) => mapped(suites.save(input)),
      [WS_METHODS.linxSuitesArchive]: ({ suiteId, expectedRevision }) =>
        mapped(suites.archive(suiteId, expectedRevision)),
      [WS_METHODS.linxSuitesLaunch]: (input) => suiteLaunches.launch(input),
      [WS_METHODS.linxSuitesGetBinding]: ({ threadId }) => suiteLaunches.getBinding(threadId),
      [WS_METHODS.linxConnectionsList]: () => mapped(connections.list()),
      [WS_METHODS.linxConnectionsGet]: ({ connectionId }) => mapped(connections.get(connectionId)),
      [WS_METHODS.linxConnectionsTest]: (input) =>
        mapped(connections.test(input)).pipe(Effect.map((result) => ({ tools: result.tools }))),
      [WS_METHODS.linxConnectionsSave]: (input) => mapped(connections.save(input)),
      [WS_METHODS.linxConnectionsDisable]: ({ connectionId, expectedRevision }) =>
        mapped(connections.disable(connectionId, expectedRevision)),
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
        const suite =
          binding.suiteSnapshotId === null
            ? null
            : yield* mapped(suites.getSnapshot(binding.suiteSnapshotId));
        const member =
          binding.memberKey === null
            ? undefined
            : suite?.content.members.find((candidate) => candidate.memberKey === binding.memberKey);
        if (
          binding.suiteSnapshotId !== null &&
          (suite === null ||
            (binding.memberKey !== null && member?.snapshotId !== binding.snapshotId) ||
            (binding.memberKey === null && suite.content.lead.snapshotId !== binding.snapshotId))
        ) {
          return yield* Effect.fail(
            failure("snapshot_integrity", "The bound suite could not be verified."),
          );
        }
        return {
          threadId,
          projectId: ProjectId.make(binding.projectId),
          snapshotId: snapshot.snapshotId,
          expertId: snapshot.expertId,
          revision: snapshot.revision,
          contentHash: snapshot.contentHash,
          ...(member === undefined ? {} : { expertTitle: member.title }),
          ...(suite === null
            ? {}
            : {
                suite: {
                  name: suite.content.name ?? suite.content.suiteId,
                  revision: suite.content.suiteRevision,
                  role: binding.memberKey === null ? ("lead" as const) : ("member" as const),
                  ...(member === undefined ? {} : { memberTitle: member.title }),
                },
              }),
          createdAt: binding.createdAt,
        };
      }),
    });
  }),
);
