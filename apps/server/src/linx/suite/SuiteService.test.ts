import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ExpertSnapshotService, layer as expertLayer } from "../expert/ExpertSnapshotService.ts";
import { layer as linxSqliteLayer } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import { SuiteService, layer as suiteLayer } from "./SuiteService.ts";

const snapshot = (expertId: string) => ({
  expertId,
  revision: 1,
  persona: expertId,
  references: [],
  skillSelection: [],
  mcpGrants: [],
  connectionRevisions: {},
});

const withServices = <A, E>(run: () => Effect.Effect<A, E, SuiteService | ExpertSnapshotService>) =>
  Effect.gen(function* () {
    yield* runLinxMigrations;
    return yield* run();
  }).pipe(
    Effect.provide(
      suiteLayer.pipe(
        Layer.provideMerge(expertLayer),
        Layer.provideMerge(linxSqliteLayer(":memory:")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("saves a suite, freezes members, and appends revisions", () =>
  withServices(() =>
    Effect.gen(function* () {
      const snapshots = yield* ExpertSnapshotService;
      const suites = yield* SuiteService;
      yield* snapshots.create(snapshot("lead"));
      yield* snapshots.create(snapshot("member-a"));
      yield* snapshots.create(snapshot("member-b"));

      const saved = yield* suites.save({
        name: "Review suite",
        leadExpertId: "lead",
        leadExpertRevision: 1,
        members: [
          { memberKey: "a", expertId: "member-a", revision: 1 },
          { memberKey: "b", expertId: "member-b", revision: 1 },
        ],
        policy: { maxActiveDelegations: 4 },
      });
      assert.equal(saved.currentRevision, 1);
      assert.deepEqual(
        saved.members.map((member) => member.memberKey),
        ["a", "b"],
      );
      assert.equal((yield* suites.list())[0]?.memberCount, 2);

      const frozen = yield* suites.freeze(saved.suiteId);
      assert.equal(frozen.content.lead.expertId, "lead");
      assert.equal(frozen.content.members.length, 2);
      assert.match(frozen.contentHash, /^[0-9a-f]{64}$/);

      const updated = yield* suites.save({
        suiteId: saved.suiteId,
        expectedRevision: 1,
        name: "Review suite v2",
        leadExpertId: "lead",
        leadExpertRevision: 1,
        members: [{ memberKey: "a", expertId: "member-a", revision: 1 }],
        policy: { maxActiveDelegations: 2 },
      });
      assert.equal(updated.currentRevision, 2);
      assert.equal(updated.members.length, 1);

      const stale = yield* Effect.flip(
        suites.save({
          suiteId: saved.suiteId,
          expectedRevision: 1,
          name: "stale",
          leadExpertId: "lead",
          leadExpertRevision: 1,
          members: [{ memberKey: "a", expertId: "member-a", revision: 1 }],
          policy: { maxActiveDelegations: 2 },
        }),
      );
      assert.equal(stale._tag, "LinxRevisionConflictError");

      yield* suites.archive(saved.suiteId, 2);
      const archived = yield* Effect.flip(suites.freeze(saved.suiteId));
      assert.equal(archived._tag, "LinxDefinitionArchivedError");
    }),
  ),
);

it.effect("rejects duplicate member keys and missing snapshots", () =>
  withServices(() =>
    Effect.gen(function* () {
      const snapshots = yield* ExpertSnapshotService;
      const suites = yield* SuiteService;
      yield* snapshots.create(snapshot("lead"));
      yield* snapshots.create(snapshot("member"));
      const duplicate = yield* Effect.flip(
        suites.save({
          name: "dup",
          leadExpertId: "lead",
          leadExpertRevision: 1,
          members: [
            { memberKey: "same", expertId: "member", revision: 1 },
            { memberKey: "same", expertId: "member", revision: 1 },
          ],
          policy: { maxActiveDelegations: 4 },
        }),
      );
      assert.equal(duplicate._tag, "LinxDependencyMissingError");
      const missing = yield* Effect.flip(
        suites.save({
          name: "missing",
          leadExpertId: "lead",
          leadExpertRevision: 1,
          members: [{ memberKey: "m", expertId: "absent", revision: 1 }],
          policy: { maxActiveDelegations: 4 },
        }),
      );
      assert.equal(missing._tag, "LinxDependencyMissingError");
    }),
  ),
);
