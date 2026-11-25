import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { LinxSqlClient, layer as linxSqliteLayer } from "./LinxSqlite.ts";

it.effect("keeps the T3 SqlClient and the Linx client independent", () => {
  const stack = Layer.merge(
    SqlitePersistence.layerMemory.pipe(Layer.provide(NodeServices.layer)),
    linxSqliteLayer(":memory:").pipe(Layer.provide(NodeServices.layer)),
  );
  return Effect.gen(function* () {
    const t3 = yield* SqlClient.SqlClient;
    const linx = yield* LinxSqlClient;
    yield* t3`CREATE TABLE t3_probe(value TEXT NOT NULL)`;
    yield* linx`CREATE TABLE linx_probe(value TEXT NOT NULL)`;
    const t3Tables = yield* t3<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `;
    const linxTables = yield* linx<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `;
    assert.include(
      t3Tables.map((row) => row.name),
      "t3_probe",
    );
    assert.notInclude(
      t3Tables.map((row) => row.name),
      "linx_probe",
    );
    assert.include(
      linxTables.map((row) => row.name),
      "linx_probe",
    );
    assert.notInclude(
      linxTables.map((row) => row.name),
      "t3_probe",
    );
  }).pipe(Effect.provide(stack));
});
