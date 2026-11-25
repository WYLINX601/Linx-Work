import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS suite_definitions (
      suite_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS suite_revisions (
      suite_id TEXT NOT NULL REFERENCES suite_definitions(suite_id),
      revision INTEGER NOT NULL,
      lead_expert_id TEXT NOT NULL,
      lead_expert_revision INTEGER NOT NULL,
      members_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (suite_id, revision)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS suite_snapshots (
      suite_snapshot_id TEXT PRIMARY KEY,
      suite_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(suite_id, revision, content_hash)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS suite_delegations (
      idempotency_key TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      member_key TEXT NOT NULL,
      expected_child_thread_id TEXT NOT NULL UNIQUE,
      member_snapshot_id TEXT NOT NULL,
      suite_snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','sent','failed','completed')),
      t3_task_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(parent_thread_id, client_request_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_suite_delegations_parent_state
    ON suite_delegations(parent_thread_id, state)
  `;
});
