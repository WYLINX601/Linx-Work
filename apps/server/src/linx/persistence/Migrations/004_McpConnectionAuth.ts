import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE mcp_connection_revisions ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'none'
  `;
  yield* sql`
    ALTER TABLE mcp_connection_revisions ADD COLUMN secret_ref TEXT
  `;
});
