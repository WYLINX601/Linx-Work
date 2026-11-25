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

export const LinxExpertSummary = Schema.Struct({
  expertId: LinxExpertSnapshot.fields.expertId,
  title: TrimmedNonEmptyString,
  snapshotId: LinxExpertSnapshot.fields.snapshotId,
  revision: LinxExpertSnapshot.fields.revision,
  contentHash: LinxExpertSnapshot.fields.contentHash,
  personaPreview: Schema.String,
});
export type LinxExpertSummary = typeof LinxExpertSummary.Type;

export const LinxExpertDefinitionSummary = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  currentRevision: NonNegativeInt,
  snapshotId: TrimmedNonEmptyString,
  contentHash: Sha256Hex,
  archived: Schema.Boolean,
  updatedAt: TrimmedNonEmptyString,
});
export type LinxExpertDefinitionSummary = typeof LinxExpertDefinitionSummary.Type;

export const LinxExpertDefinition = Schema.Struct({
  ...LinxExpertDefinitionSummary.fields,
  persona: Schema.String,
  references: Schema.Array(LinxSnapshotReference),
  skillSelection: Schema.Array(LinxSnapshotSkillSelection),
  mcpGrants: Schema.Array(LinxSnapshotMcpGrant),
  createdAt: TrimmedNonEmptyString,
});
export type LinxExpertDefinition = typeof LinxExpertDefinition.Type;

export const LinxSaveExpertInput = Schema.Struct({
  expertId: Schema.optionalKey(TrimmedNonEmptyString),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  title: TrimmedNonEmptyString,
  persona: Schema.String,
  references: Schema.Array(LinxSnapshotReference),
  skillSelection: Schema.Array(LinxSnapshotSkillSelection),
  mcpGrants: Schema.Array(LinxSnapshotMcpGrant),
});
export type LinxSaveExpertInput = typeof LinxSaveExpertInput.Type;

export const LinxArchiveExpertInput = Schema.Struct({
  expertId: TrimmedNonEmptyString,
  expectedRevision: NonNegativeInt,
});
export type LinxArchiveExpertInput = typeof LinxArchiveExpertInput.Type;

export const LinxSkillPackageRevision = Schema.Struct({
  packageId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  contentHash: Sha256Hex,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  entryPath: TrimmedNonEmptyString,
  fileCount: NonNegativeInt,
  totalBytes: NonNegativeInt,
  license: Schema.String,
  source: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
});
export type LinxSkillPackageRevision = typeof LinxSkillPackageRevision.Type;

export const LinxSkillPackageSummary = Schema.Struct({
  packageId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  currentRevision: NonNegativeInt,
  contentHash: Sha256Hex,
  archived: Schema.Boolean,
  updatedAt: TrimmedNonEmptyString,
});
export type LinxSkillPackageSummary = typeof LinxSkillPackageSummary.Type;

export const LinxSkillPackageDetail = Schema.Struct({
  ...LinxSkillPackageSummary.fields,
  revisions: Schema.Array(LinxSkillPackageRevision),
});
export type LinxSkillPackageDetail = typeof LinxSkillPackageDetail.Type;

export const LinxMcpTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  schemaHash: Sha256Hex,
});
export type LinxMcpTool = typeof LinxMcpTool.Type;

export const LinxMcpAuthKind = Schema.Literals(["none", "bearer"]);
export type LinxMcpAuthKind = typeof LinxMcpAuthKind.Type;

export const LinxMcpAuthMode = Schema.Literals(["none", "bearer", "keep"]);
export type LinxMcpAuthMode = typeof LinxMcpAuthMode.Type;

export const LinxMcpConnectionSummary = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  endpoint: TrimmedNonEmptyString,
  authKind: LinxMcpAuthKind,
  currentRevision: NonNegativeInt,
  disabled: Schema.Boolean,
  updatedAt: TrimmedNonEmptyString,
  toolCount: NonNegativeInt,
});
export type LinxMcpConnectionSummary = typeof LinxMcpConnectionSummary.Type;

export const LinxMcpConnectionDetail = Schema.Struct({
  ...LinxMcpConnectionSummary.fields,
  tools: Schema.Array(LinxMcpTool),
});
export type LinxMcpConnectionDetail = typeof LinxMcpConnectionDetail.Type;

export const LinxTestMcpConnectionInput = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  authMode: Schema.optionalKey(Schema.Literals(["none", "bearer"])),
  bearerToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type LinxTestMcpConnectionInput = typeof LinxTestMcpConnectionInput.Type;

export const LinxTestMcpConnectionResult = Schema.Struct({
  tools: Schema.Array(LinxMcpTool),
});
export type LinxTestMcpConnectionResult = typeof LinxTestMcpConnectionResult.Type;

export const LinxSaveMcpConnectionInput = Schema.Struct({
  connectionId: Schema.optionalKey(TrimmedNonEmptyString),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  name: TrimmedNonEmptyString,
  endpoint: TrimmedNonEmptyString,
  authMode: LinxMcpAuthMode,
  bearerToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type LinxSaveMcpConnectionInput = typeof LinxSaveMcpConnectionInput.Type;

export const LinxDisableMcpConnectionInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  expectedRevision: NonNegativeInt,
});
export type LinxDisableMcpConnectionInput = typeof LinxDisableMcpConnectionInput.Type;

export const LinxImportSkillInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type LinxImportSkillInput = typeof LinxImportSkillInput.Type;

export const LinxArchiveSkillInput = Schema.Struct({
  packageId: TrimmedNonEmptyString,
  expectedRevision: NonNegativeInt,
});
export type LinxArchiveSkillInput = typeof LinxArchiveSkillInput.Type;

export const LinxSuiteMemberInput = Schema.Struct({
  memberKey: TrimmedNonEmptyString,
  expertId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  title: Schema.optionalKey(TrimmedNonEmptyString),
});
export type LinxSuiteMemberInput = typeof LinxSuiteMemberInput.Type;

export const LinxSuitePolicy = Schema.Struct({
  maxActiveDelegations: NonNegativeInt,
});
export type LinxSuitePolicy = typeof LinxSuitePolicy.Type;

export const LinxSaveSuiteInput = Schema.Struct({
  suiteId: Schema.optionalKey(TrimmedNonEmptyString),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  name: TrimmedNonEmptyString,
  leadExpertId: TrimmedNonEmptyString,
  leadExpertRevision: NonNegativeInt,
  members: Schema.Array(LinxSuiteMemberInput),
  policy: LinxSuitePolicy,
});
export type LinxSaveSuiteInput = typeof LinxSaveSuiteInput.Type;

export const LinxArchiveSuiteInput = Schema.Struct({
  suiteId: TrimmedNonEmptyString,
  expectedRevision: NonNegativeInt,
});
export type LinxArchiveSuiteInput = typeof LinxArchiveSuiteInput.Type;

export const LinxSuiteMember = Schema.Struct({
  memberKey: TrimmedNonEmptyString,
  expertId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  snapshotId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
export type LinxSuiteMember = typeof LinxSuiteMember.Type;

export const LinxSuiteSummary = Schema.Struct({
  suiteId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  currentRevision: NonNegativeInt,
  leadExpertId: TrimmedNonEmptyString,
  memberCount: NonNegativeInt,
  archived: Schema.Boolean,
  updatedAt: TrimmedNonEmptyString,
});
export type LinxSuiteSummary = typeof LinxSuiteSummary.Type;

export const LinxSuiteDetail = Schema.Struct({
  ...LinxSuiteSummary.fields,
  leadExpertRevision: NonNegativeInt,
  leadSnapshotId: TrimmedNonEmptyString,
  members: Schema.Array(LinxSuiteMember),
  policy: LinxSuitePolicy,
});
export type LinxSuiteDetail = typeof LinxSuiteDetail.Type;

export const LinxLaunchSuiteInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  suiteId: TrimmedNonEmptyString,
  suiteRevision: Schema.optionalKey(NonNegativeInt),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  initialMessage: Schema.Struct({ text: Schema.String }),
});
export type LinxLaunchSuiteInput = typeof LinxLaunchSuiteInput.Type;

export const LinxSuiteLaunchResult = Schema.Struct({
  threadId: ThreadId,
  suiteSnapshotId: TrimmedNonEmptyString,
  leadSnapshotId: TrimmedNonEmptyString,
  resumed: Schema.Boolean,
});
export type LinxSuiteLaunchResult = typeof LinxSuiteLaunchResult.Type;

export const LinxSuiteBinding = Schema.Struct({
  threadId: ThreadId,
  suiteId: TrimmedNonEmptyString,
  suiteRevision: NonNegativeInt,
  suiteSnapshotId: TrimmedNonEmptyString,
  leadExpertId: TrimmedNonEmptyString,
  leadRevision: NonNegativeInt,
  projectId: ProjectId,
  createdAt: TrimmedNonEmptyString,
});
export type LinxSuiteBinding = typeof LinxSuiteBinding.Type;

export const LinxSuiteDelegateInput = Schema.Struct({
  memberKey: TrimmedNonEmptyString,
  clientRequestId: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  acceptance: Schema.String,
});
export type LinxSuiteDelegateInput = typeof LinxSuiteDelegateInput.Type;

export const LinxSuiteDelegateResult = Schema.Struct({
  memberKey: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
});
export type LinxSuiteDelegateResult = typeof LinxSuiteDelegateResult.Type;

export const LinxLaunchThreadInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  snapshotId: TrimmedNonEmptyString,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  initialMessage: Schema.Struct({ text: Schema.String }),
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
  expertId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  projectId: ProjectId,
  contentHash: Sha256Hex,
  createdAt: TrimmedNonEmptyString,
});
export type LinxThreadBinding = typeof LinxThreadBinding.Type;

export const LinxFailureCode = Schema.Literals([
  "invalid_request",
  "idempotency_conflict",
  "not_found",
  "revision_conflict",
  "dependency_missing",
  "limit_exceeded",
  "snapshot_missing",
  "snapshot_integrity",
  "binding_missing",
  "launch_failed",
  "provider_unavailable",
  "unsupported",
  "forbidden",
]);
export type LinxFailureCode = typeof LinxFailureCode.Type;

export const LinxFailure = Schema.Struct({
  code: LinxFailureCode,
  message: TrimmedNonEmptyString,
  threadId: Schema.optionalKey(ThreadId),
});
export type LinxFailure = typeof LinxFailure.Type;
