import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ExpertSnapshotService from "../../../linx/expert/ExpertSnapshotService.ts";
import * as ThreadBindingRepository from "../../../linx/thread/ThreadBindingRepository.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const LinxExpertContextToolkit = Toolkit.make(
  Tool.make("linx_expert_context", {
    description:
      "Read the immutable Linx expert snapshot bound to the calling thread. Call this at the start of a turn; it takes no arguments.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      snapshotId: Schema.String,
      expertId: Schema.String,
      revision: Schema.Number,
      contentHash: Schema.String,
      persona: Schema.String,
      references: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          relativePath: Schema.String,
          sha256: Schema.String,
        }),
      ),
      skillSelection: Schema.Array(
        Schema.Struct({
          packageId: Schema.String,
          revision: Schema.Number,
          contentHash: Schema.String,
        }),
      ),
      mcpGrants: Schema.Array(
        Schema.Struct({
          connectionId: Schema.String,
          revision: Schema.Number,
          tools: Schema.Array(Schema.String),
        }),
      ),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ExpertSnapshotService.ExpertSnapshotService,
      ThreadBindingRepository.ThreadBindingRepository,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
