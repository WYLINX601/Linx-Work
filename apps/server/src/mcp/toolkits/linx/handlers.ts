import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ExpertSnapshotService from "../../../linx/expert/ExpertSnapshotService.ts";
import * as ThreadBindingRepository from "../../../linx/thread/ThreadBindingRepository.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LinxExpertContextToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(LinxExpertContextToolkit, {
  linx_expert_context: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.thread === undefined) {
        return yield* invalid("This tool requires a Linx thread.");
      }
      const bindings = yield* ThreadBindingRepository.ThreadBindingRepository;
      const binding = yield* bindings
        .getBinding(scope.thread.threadId)
        .pipe(Effect.mapError(() => invalid("The Linx thread binding could not be read.")));
      if (binding === null) {
        return yield* invalid("This thread has no Linx expert binding.");
      }
      const snapshots = yield* ExpertSnapshotService.ExpertSnapshotService;
      const snapshot = yield* snapshots
        .getById(binding.snapshotId)
        .pipe(
          Effect.mapError((error) =>
            error._tag === "LinxSnapshotIntegrityError"
              ? invalid("The Linx expert snapshot failed its integrity check.")
              : invalid("The Linx expert snapshot could not be read."),
          ),
        );
      if (snapshot === null) {
        return yield* invalid("The Linx expert snapshot no longer exists.");
      }
      return {
        snapshotId: snapshot.snapshotId,
        expertId: snapshot.expertId,
        revision: snapshot.revision,
        contentHash: snapshot.contentHash,
        persona: snapshot.persona,
        references: snapshot.references,
        skillSelection: snapshot.skillSelection,
        mcpGrants: snapshot.mcpGrants,
      };
    }),
  ),
});
