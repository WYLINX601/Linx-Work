import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE suite_delegations ADD COLUMN parent_run_id TEXT`;
  yield* sql`ALTER TABLE suite_delegations ADD COLUMN t3_run_id TEXT`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN request_version INTEGER`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN request_json TEXT`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN execution_hash TEXT`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN dispatch_started_at INTEGER`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN lease_token TEXT`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN lease_expires_at INTEGER`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN next_attempt_at INTEGER`;
  yield* sql`ALTER TABLE linx_outbox ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`;

  // SQLite retains the legacy NUL-delimited text, but node:sqlite truncates it
  // when reading rows. Encode both parts independently and keep the native
  // command and child IDs unchanged.
  yield* sql`
    UPDATE linx_outbox AS o
    SET idempotency_key = 'suite-delegate:' || lower(hex(d.parent_thread_id))
      || ':' || lower(hex(d.client_request_id))
    FROM suite_delegations AS d
    WHERE o.kind = 'suite-delegate' AND o.idempotency_key = d.idempotency_key
  `;
  yield* sql`
    UPDATE suite_delegations
    SET idempotency_key = 'suite-delegate:' || lower(hex(parent_thread_id))
      || ':' || lower(hex(client_request_id))
  `;

  // The old send path could mark an uncertain response failed. Recover its
  // native identifiers if present, but never resubmit an unversioned request.
  yield* sql`UPDATE suite_delegations SET state = 'pending' WHERE state = 'failed'`;
  yield* sql`
    UPDATE linx_outbox
    SET state = CASE WHEN state = 'failed' THEN 'pending' ELSE state END, next_attempt_at = 0
    WHERE kind = 'suite-delegate'
      AND idempotency_key IN (
        SELECT idempotency_key FROM suite_delegations WHERE state IN ('pending', 'sent')
      )
  `;
  yield* sql`
    CREATE INDEX idx_linx_suite_delegation_recovery
    ON linx_outbox(next_attempt_at, idempotency_key)
    WHERE kind = 'suite-delegate' AND next_attempt_at IS NOT NULL
  `;
});
