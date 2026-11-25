import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_connections (
      connection_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK(transport IN ('streamable-http')),
      current_revision INTEGER NOT NULL,
      disabled_at TEXT,
      revoked_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_connection_revisions (
      connection_id TEXT NOT NULL REFERENCES mcp_connections(connection_id),
      revision INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, revision)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mcp_connection_revisions_hash
    ON mcp_connection_revisions(connection_id, config_hash)
  `;
});
