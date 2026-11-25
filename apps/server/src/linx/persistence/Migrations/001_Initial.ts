import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS expert_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      expert_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(expert_id, revision)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_expert_bindings (
      t3_thread_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES expert_snapshots(snapshot_id),
      t3_project_id TEXT NOT NULL,
      t3_run_id TEXT,
      parent_thread_id TEXT,
      suite_snapshot_id TEXT,
      member_key TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS linx_outbox (
      idempotency_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      t3_thread_id TEXT NOT NULL,
      t3_project_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linx_bindings_snapshot
    ON thread_expert_bindings(snapshot_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_linx_outbox_state_updated
    ON linx_outbox(state, updated_at)
  `;
});
