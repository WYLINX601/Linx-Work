import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS expert_definitions (
      expert_id TEXT PRIMARY KEY,
      current_revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS expert_revisions (
      expert_id TEXT NOT NULL REFERENCES expert_definitions(expert_id),
      revision INTEGER NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES expert_snapshots(snapshot_id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (expert_id, revision)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_packages (
      package_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_package_revisions (
      package_id TEXT NOT NULL REFERENCES skill_packages(package_id),
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (package_id, revision)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_skill_package_revisions_hash
    ON skill_package_revisions(package_id, content_hash)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS run_skill_assemblies (
      t3_run_id TEXT PRIMARY KEY,
      t3_thread_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES expert_snapshots(snapshot_id),
      assembly_json TEXT NOT NULL,
      assembly_hash TEXT NOT NULL,
      continuation_of_run_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_run_skill_assemblies_thread
    ON run_skill_assemblies(t3_thread_id)
  `;

  // Every P1 snapshot becomes a readable revision. Its id and hash stay untouched.
  yield* sql`
    INSERT INTO expert_definitions
      (expert_id, current_revision, title, archived_at, created_at, updated_at)
    SELECT expert_id, MAX(revision), expert_id, NULL, MIN(created_at), MAX(created_at)
    FROM expert_snapshots
    GROUP BY expert_id
    ON CONFLICT(expert_id) DO NOTHING
  `;

  yield* sql`
    INSERT INTO expert_revisions (expert_id, revision, snapshot_id, created_at)
    SELECT expert_id, revision, snapshot_id, created_at
    FROM expert_snapshots
    ORDER BY expert_id, revision
    ON CONFLICT(expert_id, revision) DO NOTHING
  `;
});
