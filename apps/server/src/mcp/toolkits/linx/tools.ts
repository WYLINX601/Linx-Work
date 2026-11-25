import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ExpertSnapshotService from "../../../linx/expert/ExpertSnapshotService.ts";
import * as ExternalMcpClient from "../../../linx/mcp/ExternalMcpClient.ts";
import * as McpConnectionService from "../../../linx/mcp/McpConnectionService.ts";
import * as SecretStore from "../../../linx/secret/SecretStore.ts";
import * as SuiteDelegationService from "../../../linx/suite/SuiteDelegationService.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SkillPackageService from "../../../linx/skill/SkillPackageService.ts";
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

export const LinxSkillToolkit = Toolkit.make(
  Tool.make("linx_skill_search", {
    description:
      "Search the frozen Linx skill packages selected by the calling thread's expert snapshot. Takes a query and an optional cursor.",
    parameters: Schema.Struct({
      query: Schema.String,
      cursor: Schema.optionalKey(Schema.String),
    }),
    success: Schema.Struct({
      matches: Schema.Array(
        Schema.Struct({
          packageId: Schema.String,
          revision: Schema.Number,
          name: Schema.String,
          version: Schema.String,
          path: Schema.String,
          sha256: Schema.String,
        }),
      ),
      nextCursor: Schema.NullOr(Schema.String),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ExpertSnapshotService.ExpertSnapshotService,
      ThreadBindingRepository.ThreadBindingRepository,
      SkillPackageService.SkillPackageService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("linx_skill_read", {
    description:
      "Read one text file from a skill package frozen in the calling thread's expert snapshot. Defaults to the package entry file.",
    parameters: Schema.Struct({
      packageId: Schema.String,
      path: Schema.optionalKey(Schema.String),
    }),
    success: Schema.Struct({
      packageId: Schema.String,
      revision: Schema.Number,
      path: Schema.String,
      content: Schema.String,
      sha256: Schema.String,
      bytes: Schema.Number,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ExpertSnapshotService.ExpertSnapshotService,
      ThreadBindingRepository.ThreadBindingRepository,
      SkillPackageService.SkillPackageService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);

export const LinxMcpToolkit = Toolkit.make(
  Tool.make("linx_mcp_list_tools", {
    description:
      "List the external MCP tools granted to the calling thread's expert snapshot. Takes no arguments.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      connections: Schema.Array(
        Schema.Struct({
          connectionId: Schema.String,
          name: Schema.String,
          tools: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              description: Schema.String,
            }),
          ),
        }),
      ),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ExpertSnapshotService.ExpertSnapshotService,
      ThreadBindingRepository.ThreadBindingRepository,
      McpConnectionService.McpConnectionService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("linx_mcp_call", {
    description:
      "Call an external MCP tool granted to the calling thread's expert snapshot. Arguments must match the approved tool schema.",
    parameters: Schema.Struct({
      connectionId: Schema.String,
      tool: Schema.String,
      arguments: Schema.Record(Schema.String, Schema.Unknown),
    }),
    success: Schema.Struct({
      connectionId: Schema.String,
      tool: Schema.String,
      text: Schema.String,
      structuredContent: Schema.Unknown,
      isError: Schema.Boolean,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ExpertSnapshotService.ExpertSnapshotService,
      ThreadBindingRepository.ThreadBindingRepository,
      McpConnectionService.McpConnectionService,
      ExternalMcpClient.ExternalMcpClient,
      SecretStore.SecretStore,
    ],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);

export const LinxSuiteToolkit = Toolkit.make(
  Tool.make("linx_suite_members", {
    description:
      "List the frozen members of the calling Suite Lead's snapshot. Takes no arguments.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({
      members: Schema.Array(
        Schema.Struct({
          memberKey: Schema.String,
          title: Schema.String,
          expertId: Schema.String,
          revision: Schema.Number,
          snapshotId: Schema.String,
        }),
      ),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      SuiteDelegationService.SuiteDelegationService,
      OrchestratorMcpService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
  Tool.make("linx_suite_delegate", {
    description:
      "Delegate work to one frozen Suite member through T3 native delegation. Only a Suite Lead can call this.",
    parameters: Schema.Struct({
      memberKey: Schema.String,
      clientRequestId: Schema.String,
      objective: Schema.String,
      acceptance: Schema.String,
    }),
    success: Schema.Struct({
      memberKey: Schema.String,
      taskId: Schema.String,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      SuiteDelegationService.SuiteDelegationService,
      OrchestratorMcpService,
      ThreadManagementService.ThreadManagementService,
    ],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients),
);
