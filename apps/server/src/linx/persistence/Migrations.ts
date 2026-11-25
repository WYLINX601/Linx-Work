import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration001 from "./Migrations/001_Initial.ts";
import { LinxSqlClient } from "./LinxSqlite.ts";

const migrations = Migrator.fromRecord({
  "001_Initial": Migration001,
});

const run = Migrator.make({});

export const runLinxMigrations = Effect.gen(function* () {
  const client = yield* LinxSqlClient;
  return yield* Effect.provideService(
    run({ loader: migrations, table: "linx_migrations" }),
    SqlClient.SqlClient,
    client,
  );
});
