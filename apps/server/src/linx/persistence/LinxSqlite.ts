import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

/** A Linx-owned database connection. Never provide this as the global T3 `SqlClient`. */
export class LinxSqlClient extends Context.Service<LinxSqlClient, SqlClient.SqlClient>()(
  "t3/linx/persistence/LinxSqlite/LinxSqlClient",
) {}

const configure = Effect.gen(function* () {
  const sql = yield* LinxSqlClient;
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  yield* sql`PRAGMA synchronous = NORMAL;`;
});

export const layer = (dbPath: string) =>
  Layer.effect(
    LinxSqlClient,
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient;
      yield* Effect.provideService(configure, LinxSqlClient, client);
      return client;
    }),
  ).pipe(
    Layer.provide(
      NodeSqliteClient.layer({
        filename: dbPath,
        readerWorker: true,
        writerWorker: true,
        spanAttributes: {
          "db.name": "linx.sqlite",
          "service.name": "linx-server",
        },
      }),
    ),
  );
