import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";
import { RuntimeMode } from "./providerPolicy.ts";

const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));

export const LinxSnapshotReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  sha256: Sha256Hex,
});
export type LinxSnapshotReference = typeof LinxSnapshotReference.Type;

export const LinxSnapshotSkillSelection = Schema.Struct({
  packageId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  contentHash: Sha256Hex,
});
export type LinxSnapshotSkillSelection = typeof LinxSnapshotSkillSelection.Type;

export const LinxSnapshotMcpGrant = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  tools: Schema.Array(TrimmedNonEmptyString),
});
export type LinxSnapshotMcpGrant = typeof LinxSnapshotMcpGrant.Type;

export const LinxCreateSnapshotInput = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  persona: Schema.String,
  references: Schema.Array(LinxSnapshotReference),
  skillSelection: Schema.Array(LinxSnapshotSkillSelection),
  mcpGrants: Schema.Array(LinxSnapshotMcpGrant),
  connectionRevisions: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
});
export type LinxCreateSnapshotInput = typeof LinxCreateSnapshotInput.Type;

export const LinxExpertSnapshot = Schema.Struct({
  snapshotId: TrimmedNonEmptyString,
  expertId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  persona: Schema.String,
  references: Schema.Array(LinxSnapshotReference),
  skillSelection: Schema.Array(LinxSnapshotSkillSelection),
  mcpGrants: Schema.Array(LinxSnapshotMcpGrant),
  connectionRevisions: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  contentHash: Sha256Hex,
  createdAt: TrimmedNonEmptyString,
});
export type LinxExpertSnapshot = typeof LinxExpertSnapshot.Type;

export const LinxLaunchThreadInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  snapshotId: TrimmedNonEmptyString,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  initialMessage: Schema.Struct({
    text: Schema.String,
  }),
});
export type LinxLaunchThreadInput = typeof LinxLaunchThreadInput.Type;

export const LinxLaunchThreadResult = Schema.Struct({
  threadId: ThreadId,
  snapshotId: TrimmedNonEmptyString,
  resumed: Schema.Boolean,
});
export type LinxLaunchThreadResult = typeof LinxLaunchThreadResult.Type;

export const LinxThreadBinding = Schema.Struct({
  threadId: ThreadId,
  snapshotId: TrimmedNonEmptyString,
  projectId: ProjectId,
  contentHash: Sha256Hex,
  createdAt: TrimmedNonEmptyString,
});
export type LinxThreadBinding = typeof LinxThreadBinding.Type;

export const LinxFailureCode = Schema.Literals([
  "invalid_request",
  "idempotency_conflict",
  "snapshot_missing",
  "snapshot_integrity",
  "binding_missing",
  "launch_failed",
  "provider_unavailable",
  "forbidden",
]);
export type LinxFailureCode = typeof LinxFailureCode.Type;

export const LinxFailure = Schema.Struct({
  code: LinxFailureCode,
  message: TrimmedNonEmptyString,
  threadId: Schema.optionalKey(ThreadId),
});
export type LinxFailure = typeof LinxFailure.Type;
