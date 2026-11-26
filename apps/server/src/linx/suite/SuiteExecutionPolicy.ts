import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { LinxSqlClient } from "../persistence/LinxSqlite.ts";
import { ThreadBindingRepository } from "../thread/ThreadBindingRepository.ts";
import { SuiteService } from "./SuiteService.ts";

export const suiteLeadIdPrefix = "linx:suite:launch:";
export const suiteDelegateIdPrefix = "linx:suite:delegate:";
const suiteChildPrefix = IdAllocator.derive.delegatedTaskThread({
  commandId: CommandId.make(suiteDelegateIdPrefix),
});

// The ID survives native recovery even if the Linx database or binding is missing.
export function suiteThreadRole(threadId: ThreadId): "lead" | "member" | undefined {
  if (threadId.startsWith(suiteLeadIdPrefix)) return "lead";
  if (threadId.startsWith(suiteChildPrefix)) return "member";
  return undefined;
}

export const suiteLaunchEnabled = Config.Boolean("LINX_ENABLE_SUITE_EXECUTION").pipe(
  Config.withDefault(false),
  Effect.orDie,
);

export class SuiteExecutionRefused extends Schema.TaggedError<SuiteExecutionRefused>()(
  "SuiteExecutionRefused",
  { message: Schema.String },
) {}

export const assertSuiteProvider = Effect.fn("linx.suite.assertSuiteProvider")(function* (
  registry: ProviderInstanceRegistry["Service"],
  model: ModelSelection,
) {
  const instance = yield* registry.getInstance(model.instanceId);
  if (instance?.driverKind !== "codex" || !instance.enabled) {
    return yield* new SuiteExecutionRefused({
      message: "This provider is not enabled for isolated Suite turns.",
    });
  }
  const { version } = yield* instance.snapshot.getSnapshot;
  if (
    (yield* HostProcess.Platform) !== "darwin" ||
    (yield* HostProcess.Architecture) !== "arm64" ||
    version !== "0.172.0"
  ) {
    return yield* new SuiteExecutionRefused({
      message: "This Codex version or platform is not enabled for isolated Suite turns.",
    });
  }
});

export class SuiteExecutionPolicy extends Context.Service<
  SuiteExecutionPolicy,
  {
    readonly resolve: (
      thread: OrchestrationV2AppThread,
      model: ModelSelection,
      base: ProviderAdapterV2RuntimePolicy,
    ) => Effect.Effect<ProviderAdapterV2RuntimePolicy, SuiteExecutionRefused>;
    readonly validateCaller: (
      threadId: ThreadId,
      instanceId: ModelSelection["instanceId"],
    ) => Effect.Effect<void, SuiteExecutionRefused>;
  }
>()("t3/linx/suite/SuiteExecutionPolicy") {}

export const layer = Layer.effect(
  SuiteExecutionPolicy,
  Effect.gen(function* () {
    const bindings = yield* ThreadBindingRepository;
    const suites = yield* SuiteService;
    const providers = yield* ProviderInstanceRegistry;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* LinxSqlClient;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const missingIdentity = () =>
      new SuiteExecutionRefused({
        message: "Suite thread identity or native lineage could not be verified.",
      });

    const readIdentity = Effect.fn("linx.suite.readIdentity")(function* (
      thread: OrchestrationV2AppThread,
      role: "lead" | "member",
    ) {
      const missing = missingIdentity();
      const binding = yield* bindings.getBinding(thread.id).pipe(Effect.mapError(() => missing));
      if (binding?.suiteSnapshotId == null || binding.projectId !== thread.projectId)
        return yield* missing;
      const suite = yield* suites
        .getSnapshot(binding.suiteSnapshotId)
        .pipe(Effect.mapError(() => missing));
      if (suite === null) return yield* missing;
      const { lead, leadModelSelection, members, policy } = suite.content;
      let expectedModel = leadModelSelection;
      let parentId: ThreadId | null = null;
      let memberAllowsWrites = false;
      if (role === "lead") {
        if (
          binding.memberKey !== null ||
          binding.parentThreadId !== null ||
          binding.snapshotId !== lead.snapshotId ||
          thread.lineage.parentThreadId !== null
        )
          return yield* missing;
      } else {
        parentId = thread.lineage.parentThreadId;
        const member = members.find((entry) => entry.memberKey === binding.memberKey);
        if (
          parentId === null ||
          suiteThreadRole(parentId) !== "lead" ||
          thread.lineage.relationshipToParent !== "subagent" ||
          parentId !== binding.parentThreadId ||
          member?.snapshotId !== binding.snapshotId
        )
          return yield* missing;
        const parentBinding = yield* bindings
          .getBinding(parentId)
          .pipe(Effect.mapError(() => missing));
        if (
          parentBinding?.suiteSnapshotId !== binding.suiteSnapshotId ||
          parentBinding.projectId !== binding.projectId ||
          parentBinding.snapshotId !== lead.snapshotId
        )
          return yield* missing;
        const [intent] = yield* sql<{
          readonly command_id: string;
          readonly parent_run_id: string | null;
        }>`
        SELECT command_id, parent_run_id FROM suite_delegations
        WHERE expected_child_thread_id = ${thread.id} AND parent_thread_id = ${parentId}
          AND member_key = ${member.memberKey} AND member_snapshot_id = ${binding.snapshotId}
          AND suite_snapshot_id = ${binding.suiteSnapshotId} AND state IN ('pending','sent','completed')
      `.pipe(Effect.mapError(() => missing));
        if (intent?.parent_run_id == null) return yield* missing;
        const commandId = CommandId.make(intent.command_id);
        const taskId = IdAllocator.derive.delegatedTaskNode({ commandId });
        const { subagents } = yield* projections
          .getThreadRecords(parentId, ["subagents"], { subagentIds: [taskId] })
          .pipe(Effect.mapError(() => missing));
        if (
          IdAllocator.derive.delegatedTaskThread({ commandId }) !== thread.id ||
          !subagents.some(
            (task) =>
              task.id === taskId &&
              task.origin === "app_owned" &&
              task.childThreadId === thread.id &&
              task.runId === intent.parent_run_id,
          )
        )
          return yield* missing;
        expectedModel = member.modelSelection ?? leadModelSelection;
        memberAllowsWrites = member.runtimeMode !== "approval-required";
      }
      return { expectedModel, policy, parentId, memberAllowsWrites };
    });

    const validateCaller = Effect.fn("linx.suite.validateToolCaller")(function* (
      threadId: ThreadId,
      instanceId: ModelSelection["instanceId"],
    ) {
      const role = suiteThreadRole(threadId);
      if (role === undefined) return;
      const missing = missingIdentity();
      const thread = yield* projections.getThread(threadId).pipe(Effect.mapError(() => missing));
      if (thread === null || thread.deletedAt !== null || thread.providerInstanceId !== instanceId)
        return yield* missing;
      const { expectedModel } = yield* readIdentity(thread, role);
      if (expectedModel?.instanceId !== instanceId) return yield* missing;
    });

    const resolve = Effect.fn("linx.suite.resolveTurnPolicy")(function* (
      thread: OrchestrationV2AppThread,
      model: ModelSelection,
      base: ProviderAdapterV2RuntimePolicy,
    ) {
      const role = suiteThreadRole(thread.id);
      if (role === undefined) return base;
      const { expectedModel, policy, parentId, memberAllowsWrites } = yield* readIdentity(
        thread,
        role,
      );
      const write = memberAllowsWrites && policy.sandbox === "workspace-write";
      let cwd = base.cwd;
      if (parentId !== null) {
        if (policy.workspaceIsolation === "worktree") {
          const workspace = new SuiteExecutionRefused({
            message: "The Suite member has no isolated worktree.",
          });
          const parent = yield* projections
            .getThread(parentId)
            .pipe(Effect.mapError(() => workspace));
          const project = yield* projects
            .get(thread.projectId)
            .pipe(Effect.mapError(() => workspace));
          if (
            parent === null ||
            Option.isNone(project) ||
            thread.worktreePath === null ||
            cwd !== thread.worktreePath
          )
            return yield* workspace;
          cwd = yield* fs.realPath(thread.worktreePath).pipe(Effect.mapError(() => workspace));
          const root = project.value.workspaceRoot;
          const roots = parent.worktreePath === null ? [root] : [root, parent.worktreePath];
          for (const root of roots) {
            const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(() => workspace));
            const relative = path.relative(realRoot, cwd);
            if (!relative.startsWith(`..${path.sep}`) && relative !== "..") return yield* workspace;
            const inverse = path.relative(cwd, realRoot);
            if (!inverse.startsWith(`..${path.sep}`) && inverse !== "..") return yield* workspace;
          }
        } else if (write) {
          return yield* new SuiteExecutionRefused({
            message: "Workspace writes require an isolated child worktree.",
          });
        }
      }
      if (
        expectedModel === undefined ||
        expectedModel.instanceId !== model.instanceId ||
        expectedModel.model !== model.model
      ) {
        return yield* new SuiteExecutionRefused({
          message: "Suite turns must use the frozen provider and model.",
        });
      }
      const frozenOptions = expectedModel.options ?? [];
      const options = model.options ?? [];
      if (
        options.length !== frozenOptions.length ||
        frozenOptions.some(
          (option) =>
            !options.some((current) => current.id === option.id && current.value === option.value),
        )
      ) {
        return yield* new SuiteExecutionRefused({
          message: "Suite turns must use the frozen model options.",
        });
      }
      yield* assertSuiteProvider(providers, model);
      if (cwd === null) return yield* missingIdentity();
      const workspaceCwd = yield* fs.realPath(cwd).pipe(Effect.mapError(missingIdentity));
      if (
        workspaceCwd === path.parse(workspaceCwd).root ||
        ["/private/tmp", "/private/var/folders", "/private/var/tmp"].some(
          (tmp) => workspaceCwd === tmp || workspaceCwd.startsWith(`${tmp}${path.sep}`),
        )
      ) {
        return yield* new SuiteExecutionRefused({
          message:
            "The Suite workspace cannot be the filesystem root or a system temporary directory.",
        });
      }
      if (write && base.runtimeMode === "approval-required") {
        return yield* new SuiteExecutionRefused({
          message: "The environment does not permit workspace writes for this Suite turn.",
        });
      }
      const { workspace: _extraWorkspace, ...restricted } = base;
      return {
        ...restricted,
        cwd: workspaceCwd,
        runtimeMode: write ? "auto-accept-edits" : "approval-required",
        maxRuntimeMode: write ? "auto-accept-edits" : "approval-required",
        suiteIsolation: true,
        sandboxPolicy: write
          ? {
              type: "workspaceWrite",
              writableRoots: [workspaceCwd],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : { type: "readOnly", networkAccess: false },
        approvalPolicy:
          policy.approval === "on-request"
            ? {
                granular: {
                  mcp_elicitations: true,
                  request_permissions: false,
                  rules: false,
                  sandbox_approval: false,
                  skill_approval: false,
                },
              }
            : "never",
      } satisfies ProviderAdapterV2RuntimePolicy;
    });
    return SuiteExecutionPolicy.of({ resolve, validateCaller });
  }),
);

/** Only the authenticated Suite adapter supplies this after persisting the dispatch marker. */
export const SuiteDelegationAuthority = Context.Reference<
  | {
      readonly commandId: CommandId;
      readonly parentThreadId: ThreadId;
      readonly parentRunId: string;
    }
  | undefined
>("t3/linx/SuiteDelegationAuthority", { defaultValue: () => undefined });

/** Native checkout provisioning may attach its worktree; public metadata commands may not. */
export const SuiteProvisioningThread = Context.Reference<ThreadId | undefined>(
  "t3/linx/SuiteProvisioningThread",
  { defaultValue: () => undefined },
);

export const resolveSuitePolicy = Effect.fn("linx.suite.resolvePolicy")(function* (
  service: Option.Option<SuiteExecutionPolicy["Service"]>,
  thread: OrchestrationV2AppThread,
  model: ModelSelection,
  base: ProviderAdapterV2RuntimePolicy,
) {
  if (suiteThreadRole(thread.id) === undefined) return base;
  if (Option.isNone(service))
    return yield* new SuiteExecutionRefused({ message: "Suite execution policy is unavailable." });
  return yield* service.value.resolve(thread, model, base);
});
