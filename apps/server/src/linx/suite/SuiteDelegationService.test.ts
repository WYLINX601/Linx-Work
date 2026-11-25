import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ExpertSnapshotService, layer as expertLayer } from "../expert/ExpertSnapshotService.ts";
import { layer as linxSqliteLayer, LinxSqlClient } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import {
  layer as bindingLayer,
  ThreadBindingRepository,
} from "../thread/ThreadBindingRepository.ts";
import { SuiteService, layer as suiteLayer } from "./SuiteService.ts";
import { SuiteDelegationService, layer as delegationLayer } from "./SuiteDelegationService.ts";

const snapshot = (expertId: string) => ({
  expertId,
  revision: 1,
  persona: expertId,
  references: [],
  skillSelection: [],
  mcpGrants: [],
  connectionRevisions: {},
});

const stack = Layer.mergeAll(
  suiteLayer.pipe(Layer.provide(expertLayer)),
  expertLayer,
  bindingLayer,
  delegationLayer.pipe(
    Layer.provide(suiteLayer.pipe(Layer.provide(expertLayer))),
    Layer.provide(bindingLayer),
  ),
).pipe(Layer.provideMerge(linxSqliteLayer(":memory:")), Layer.provide(NodeServices.layer));

const withServices = <A, E>(
  run: () => Effect.Effect<
    A,
    E,
    | SuiteService
    | SuiteDelegationService
    | ExpertSnapshotService
    | ThreadBindingRepository
    | LinxSqlClient
  >,
) =>
  Effect.gen(function* () {
    yield* runLinxMigrations;
    return yield* run();
  }).pipe(Effect.provide(stack));

it.effect("prepares a native delegation with a frozen binding and enforces idempotency", () =>
  withServices(() =>
    Effect.gen(function* () {
      const snapshots = yield* ExpertSnapshotService;
      const suites = yield* SuiteService;
      const bindings = yield* ThreadBindingRepository;
      const delegations = yield* SuiteDelegationService;
      yield* snapshots.create(snapshot("lead"));
      yield* snapshots.create(snapshot("member"));
      const suite = yield* suites.save({
        name: "Suite",
        leadExpertId: "lead",
        leadExpertRevision: 1,
        members: [{ memberKey: "member", expertId: "member", revision: 1 }],
        policy: { maxActiveDelegations: 1 },
      });
      const frozen = yield* suites.freeze(suite.suiteId);
      yield* bindings.bindAndEnqueue({
        idempotencyKey: "lead-launch",
        requestHash: "lead",
        kind: "suite-launch",
        commandId: "lead-thread",
        threadId: "lead-thread",
        projectId: "project",
        snapshotId: frozen.content.lead.snapshotId,
        suiteSnapshotId: frozen.suiteSnapshotId,
      });
      const members = yield* delegations.members("lead-thread");
      assert.equal(members[0]?.memberKey, "member");

      const prepared = yield* delegations.prepare({
        parentThreadId: "lead-thread",
        memberKey: "member",
        clientRequestId: "delegate-1",
        objective: "Check the diff",
        acceptance: "Name one risk",
      });
      assert.equal(prepared.resumed, false);
      assert.equal(prepared.member.snapshotId, frozen.content.members[0]?.snapshotId);
      assert.match(prepared.commandId, /^linx:suite:delegate:/);

      const again = yield* delegations.prepare({
        parentThreadId: "lead-thread",
        memberKey: "member",
        clientRequestId: "delegate-1",
        objective: "Check the diff",
        acceptance: "Name one risk",
      });
      assert.equal(again.resumed, true);
      assert.equal(again.commandId, prepared.commandId);

      const conflict = yield* Effect.flip(
        delegations.prepare({
          parentThreadId: "lead-thread",
          memberKey: "member",
          clientRequestId: "delegate-1",
          objective: "Different",
          acceptance: "Different",
        }),
      );
      assert.equal(conflict.code, "idempotency_conflict");

      const quota = yield* Effect.flip(
        delegations.prepare({
          parentThreadId: "lead-thread",
          memberKey: "member",
          clientRequestId: "delegate-2",
          objective: "Second",
          acceptance: "Second",
        }),
      );
      assert.equal(quota.code, "limit_exceeded");

      yield* delegations.markSent(prepared.key, "task-1");
      const active = yield* delegations.active("lead-thread");
      assert.equal(active[0]?.taskId, "task-1");
      yield* delegations.markCompleted(prepared.key);
      const after = yield* delegations.prepare({
        parentThreadId: "lead-thread",
        memberKey: "member",
        clientRequestId: "delegate-3",
        objective: "Third",
        acceptance: "Third",
      });
      assert.equal(after.resumed, false);
    }),
  ),
);
