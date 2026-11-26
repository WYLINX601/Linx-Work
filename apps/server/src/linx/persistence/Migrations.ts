import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration001 from "./Migrations/001_Initial.ts";
import Migration002 from "./Migrations/002_ExpertDefinitionsSkills.ts";
import Migration003 from "./Migrations/003_McpConnections.ts";
import Migration004 from "./Migrations/004_McpConnectionAuth.ts";
import Migration005 from "./Migrations/005_Suites.ts";
import Migration006 from "./Migrations/006_SuiteDelegationRecovery.ts";
import { LinxSqlClient } from "./LinxSqlite.ts";

const migrations = Migrator.fromRecord({
  "001_Initial": Migration001,
  "002_ExpertDefinitionsSkills": Migration002,
  "003_McpConnections": Migration003,
  "004_McpConnectionAuth": Migration004,
  "005_Suites": Migration005,
  "006_SuiteDelegationRecovery": Migration006,
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
