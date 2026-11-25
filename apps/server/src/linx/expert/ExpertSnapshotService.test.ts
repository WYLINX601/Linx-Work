// @effect-diagnostics nodeBuiltinImport:off - test hashes and temp dirs use node builtins.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ExpertSnapshotService, layer as expertSnapshotLayer } from "./ExpertSnapshotService.ts";
import { LinxSqlClient, layer as linxSqliteLayer } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";

const input = {
  expertId: "expert-1",
  revision: 1,
  persona: "You are a careful reviewer.",
  references: [
    { name: "z", relativePath: "expert/z.txt", sha256: "b".repeat(64) },
    { name: "a", relativePath: "expert/a.txt", sha256: "a".repeat(64) },
  ],
  skillSelection: [{ packageId: "skill-b", revision: 1, contentHash: "c".repeat(64) }],
  mcpGrants: [{ connectionId: "mcp-1", revision: 2, tools: ["z", "a"] }],
  connectionRevisions: { "mcp-1": 2 },
} as const;

const withService = <A, E>(run: () => Effect.Effect<A, E, ExpertSnapshotService | LinxSqlClient>) =>
  Effect.gen(function* () {
    yield* runLinxMigrations;
    return yield* run();
  }).pipe(
    Effect.provide(
      expertSnapshotLayer.pipe(
        Layer.provideMerge(linxSqliteLayer(":memory:")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("creates a stable, sorted snapshot and returns it on retry", () =>
  withService(() =>
    Effect.gen(function* () {
      const service = yield* ExpertSnapshotService;
      const first = yield* service.create(input);
      const second = yield* service.create(input);
      assert.equal(first.snapshotId, second.snapshotId);
      assert.deepEqual(
        first.references.map((reference) => reference.name),
        ["a", "z"],
      );
      assert.deepEqual(first.mcpGrants[0]?.tools, ["a", "z"]);
      const expectedHash = NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify({
            persona: input.persona,
            references: [
              { name: "a", relativePath: "expert/a.txt", sha256: "a".repeat(64) },
              { name: "z", relativePath: "expert/z.txt", sha256: "b".repeat(64) },
            ],
            skillSelection: input.skillSelection,
            mcpGrants: [{ connectionId: "mcp-1", revision: 2, tools: ["a", "z"] }],
            connectionRevisions: input.connectionRevisions,
          }),
        )
        .digest("hex");
      assert.equal(first.contentHash, expectedHash);
      assert.equal((yield* service.getById(first.snapshotId))?.contentHash, first.contentHash);
    }),
  ),
);

it.effect("rejects a different payload for the same revision", () =>
  withService(() =>
    Effect.gen(function* () {
      const service = yield* ExpertSnapshotService;
      yield* service.create(input);
      const error = yield* Effect.flip(service.create({ ...input, persona: "Different persona." }));
      assert.equal(error._tag, "LinxSnapshotConflictError");
    }),
  ),
);

it.effect("fails closed when stored content no longer matches its hash", () =>
  withService(() =>
    Effect.gen(function* () {
      const service = yield* ExpertSnapshotService;
      const sql = yield* LinxSqlClient;
      const snapshot = yield* service.create(input);
      yield* sql`
        UPDATE expert_snapshots
        SET content_json = ${JSON.stringify({ ...input, persona: "tampered" })}
        WHERE snapshot_id = ${snapshot.snapshotId}
      `;
      const error = yield* Effect.flip(service.getById(snapshot.snapshotId));
      assert.equal(error._tag, "LinxSnapshotIntegrityError");
    }),
  ),
);

it.effect("lists the highest revision per expert, ordered by expert id", () =>
  withService(() =>
    Effect.gen(function* () {
      const service = yield* ExpertSnapshotService;
      yield* service.create({ ...input, expertId: "z", revision: 1 });
      const latest = yield* service.create({
        ...input,
        expertId: "a",
        revision: 3,
        persona: "Latest",
      });
      yield* service.create({ ...input, expertId: "a", revision: 2, persona: "Older" });
      const list = yield* service.listLatest();
      assert.deepEqual(
        list.map(({ expertId, revision }) => [expertId, revision]),
        [
          ["a", 3],
          ["z", 1],
        ],
      );
      assert.deepEqual(list[0], {
        expertId: "a",
        title: "a",
        revision: 3,
        snapshotId: latest.snapshotId,
        contentHash: latest.contentHash,
        personaPreview: "Latest",
      });
    }),
  ),
);
