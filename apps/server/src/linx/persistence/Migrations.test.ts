import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
    assert.equal(rows[0]?.count, 1);
  }).pipe(Effect.provide(layer));
});
