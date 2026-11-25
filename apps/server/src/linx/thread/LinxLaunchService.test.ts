// @effect-diagnostics nodeBuiltinImport:off - the test allocates a temporary Linx resource root.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LinxFailure, LinxLaunchThreadInput } from "@t3tools/contracts";

import { layer as definitionLayer } from "../expert/ExpertDefinitionService.ts";
import { ExpertSnapshotService, layer as expertLayer } from "../expert/ExpertSnapshotService.ts";
import { layer as resourcesLayer } from "../persistence/LinxResourceStore.ts";
import { layer as linxSqliteLayer } from "../persistence/LinxSqlite.ts";
import { layer as skillPackageLayer } from "../skill/SkillPackageService.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import { LinxLaunchService, layer as launchLayer } from "./LinxLaunchService.ts";
import { layer as bindingLayer, ThreadBindingRepository } from "./ThreadBindingRepository.ts";
import { ThreadLauncher, type LinxThreadLaunchOutcome } from "./ThreadLauncher.ts";

const input = (clientRequestId: string): LinxLaunchThreadInput => ({
  clientRequestId,
  snapshotId: "snapshot-placeholder",
  projectId: "project-1" as LinxLaunchThreadInput["projectId"],
  title: "First Linx thread",
  modelSelection: {
    instanceId: "codex",
    model: "gpt-5",
  } as LinxLaunchThreadInput["modelSelection"],
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  initialMessage: { text: "Report the expert context." },
});

const stack = (
  launch: (
    request: {
      readonly commandId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly input: LinxLaunchThreadInput;
    },
    bindings: ThreadBindingRepository["Service"],
  ) => Effect.Effect<LinxThreadLaunchOutcome, LinxFailure>,
) => {
  const resourceDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linx-launch-"));
  const resources = resourcesLayer(resourceDir);
  const skills = skillPackageLayer.pipe(Layer.provide(resources));
  const definitions = definitionLayer.pipe(
    Layer.provide(skills),
    Layer.provide(expertLayer),
    Layer.provide(resources),
  );
  const core = Layer.mergeAll(expertLayer, bindingLayer, skills, definitions, resources);
  const launcher = Layer.effect(
    ThreadLauncher,
    Effect.gen(function* () {
      const bindings = yield* ThreadBindingRepository;
      return ThreadLauncher.of({
        launch: (request) => launch(request, bindings),
      });
    }),
  ).pipe(Layer.provideMerge(core));
  return launchLayer.pipe(
    Layer.provideMerge(launcher),
    Layer.provideMerge(linxSqliteLayer(":memory:")),
    Layer.provide(NodeServices.layer),
  );
};

it.effect("persists the binding before calling the launcher and is idempotent", () => {
  let calls = 0;
  let sawBinding = false;
  const layer = stack((request, bindings) =>
    Effect.gen(function* () {
      calls += 1;
      sawBinding = (yield* bindings.getBinding(request.threadId).pipe(Effect.orDie)) !== null;
      return { resumed: false, runId: "run-1" };
    }),
  );
  return Effect.gen(function* () {
    yield* runLinxMigrations;
    const snapshots = yield* ExpertSnapshotService;
    const launches = yield* LinxLaunchService;
    const snapshot = yield* snapshots.create({
      expertId: "expert-1",
      revision: 1,
      persona: "Review carefully.",
      references: [],
      skillSelection: [],
      mcpGrants: [],
      connectionRevisions: {},
    });
    const first = yield* launches.launch({
      ...input("request-1"),
      snapshotId: snapshot.snapshotId,
    });
    const second = yield* launches.launch({
      ...input("request-1"),
      snapshotId: snapshot.snapshotId,
    });
    assert.isTrue(sawBinding);
    assert.equal(calls, 1);
    assert.equal(first.threadId, second.threadId);
    assert.isFalse(first.resumed);
    assert.isTrue(second.resumed);
  }).pipe(Effect.provide(layer));
});

it.effect("returns a conflict for the same request id with a different payload", () => {
  const layer = stack(() => Effect.succeed({ resumed: false, runId: null }));
  return Effect.gen(function* () {
    yield* runLinxMigrations;
    const snapshots = yield* ExpertSnapshotService;
    const launches = yield* LinxLaunchService;
    const snapshot = yield* snapshots.create({
      expertId: "expert-1",
      revision: 1,
      persona: "Review carefully.",
      references: [],
      skillSelection: [],
      mcpGrants: [],
      connectionRevisions: {},
    });
    yield* launches.launch({ ...input("request-1"), snapshotId: snapshot.snapshotId });
    const failure = yield* Effect.flip(
      launches.launch({
        ...input("request-1"),
        snapshotId: snapshot.snapshotId,
        title: "Changed",
      }),
    );
    assert.equal(failure.code, "idempotency_conflict");
  }).pipe(Effect.provide(layer));
});

it.effect("retries a retryable launch with the original thread id", () => {
  let calls = 0;
  const layer = stack(() =>
    Effect.gen(function* () {
      calls += 1;
      if (calls === 1) {
        return yield* Effect.fail({
          code: "provider_unavailable",
          message: "offline",
        } satisfies LinxFailure);
      }
      return { resumed: true, runId: null };
    }),
  );
  return Effect.gen(function* () {
    yield* runLinxMigrations;
    const snapshots = yield* ExpertSnapshotService;
    const launches = yield* LinxLaunchService;
    const snapshot = yield* snapshots.create({
      expertId: "expert-1",
      revision: 1,
      persona: "Review carefully.",
      references: [],
      skillSelection: [],
      mcpGrants: [],
      connectionRevisions: {},
    });
    const first = yield* Effect.flip(
      launches.launch({ ...input("request-retry"), snapshotId: snapshot.snapshotId }),
    );
    assert.equal(first.code, "provider_unavailable");
    const retried = yield* launches.launch({
      ...input("request-retry"),
      snapshotId: snapshot.snapshotId,
    });
    assert.equal(calls, 2);
    assert.isTrue(retried.resumed);
  }).pipe(Effect.provide(layer));
});
