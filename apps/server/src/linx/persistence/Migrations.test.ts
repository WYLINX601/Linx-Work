import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration001 from "./Migrations/001_Initial.ts";
import { LinxSqlClient, layer as linxSqliteLayer } from "./LinxSqlite.ts";
import { runLinxMigrations } from "./Migrations.ts";

it.effect("creates only Linx tables under the Linx migration ledger", () => {
  const layer = linxSqliteLayer(":memory:").pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* () {
    yield* runLinxMigrations;
    const sql = yield* LinxSqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `;
    const names = tables.map((row) => row.name);
    assert.include(names, "linx_migrations");
    assert.include(names, "expert_snapshots");
    assert.include(names, "expert_definitions");
    assert.include(names, "expert_revisions");
    assert.include(names, "skill_packages");
    assert.include(names, "skill_package_revisions");
    assert.include(names, "run_skill_assemblies");
    assert.include(names, "thread_expert_bindings");
    assert.include(names, "linx_outbox");
    assert.notInclude(names, "orchestration_events");
    assert.notInclude(names, "effect_sql_migrations");
    assert.notInclude(names, "orchestration_v2_threads");
  }).pipe(Effect.provide(layer));
});

it.effect("records the Linx schema version once", () => {
  const layer = linxSqliteLayer(":memory:").pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* () {
    yield* runLinxMigrations;
    yield* runLinxMigrations;
    const sql = yield* LinxSqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM linx_migrations
    `;
    assert.equal(rows[0]?.count, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("backfills every existing P1 snapshot as a readable definition revision", () => {
  const layer = linxSqliteLayer(":memory:").pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* () {
    const client = yield* LinxSqlClient;
    const runFirstOnly = Migrator.make({});
    yield* Effect.provideService(
      runFirstOnly({
        loader: Migrator.fromRecord({ "001_Initial": Migration001 }),
        table: "linx_migrations",
      }),
      SqlClient.SqlClient,
      client,
    );
    const contentHash = "a".repeat(64);
    yield* client`
      INSERT INTO expert_snapshots
        (snapshot_id, expert_id, revision, content_json, content_hash, created_at)
      VALUES
        ('snap-legacy', 'expert-legacy', 3, '{"persona":"Legacy."}',
         ${contentHash}, '2026-11-01T00:00:00.000Z')
    `;

    yield* runLinxMigrations;

    const definitions = yield* client<{
      readonly expert_id: string;
      readonly current_revision: number;
      readonly title: string;
    }>`SELECT expert_id, current_revision, title FROM expert_definitions`;
    assert.deepEqual(definitions, [
      { expert_id: "expert-legacy", current_revision: 3, title: "expert-legacy" },
    ]);
    const revisions = yield* client<{
      readonly revision: number;
      readonly snapshot_id: string;
    }>`SELECT revision, snapshot_id FROM expert_revisions`;
    assert.deepEqual(revisions, [{ revision: 3, snapshot_id: "snap-legacy" }]);
  }).pipe(Effect.provide(layer));
});
