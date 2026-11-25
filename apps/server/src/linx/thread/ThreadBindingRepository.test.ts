import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LinxSqlClient, layer as linxSqliteLayer } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import { layer as bindingLayer, ThreadBindingRepository } from "./ThreadBindingRepository.ts";

const input = {
  idempotencyKey: "linx:launch:abc",
  kind: "launch",
  requestHash: "hash-1",
  commandId: "linx:launch:abc",
  threadId: "linx:launch:abc",
  projectId: "project-1",
  snapshotId: "snap_1",
} as const;

const withRepository = <A, E>(
  run: () => Effect.Effect<A, E, ThreadBindingRepository | LinxSqlClient>,
) =>
  Effect.gen(function* () {
    yield* runLinxMigrations;
    const sql = yield* LinxSqlClient;
    yield* sql`
      INSERT INTO expert_snapshots
        (snapshot_id, expert_id, revision, content_json, content_hash, created_at)
      VALUES ('snap_1', 'expert-1', 1, '{}', ${"a".repeat(64)}, '2026-01-01T00:00:00.000Z')
    `;
    return yield* run();
  }).pipe(
    Effect.provide(
      bindingLayer.pipe(
        Layer.provideMerge(linxSqliteLayer(":memory:")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("commits the binding and the outbox together and resumes by key", () =>
  withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* ThreadBindingRepository;
      const first = yield* repository.bindAndEnqueue(input);
      assert.isFalse(first.resumed);
      assert.equal(first.binding.threadId, input.threadId);
      assert.equal(first.outbox.state, "pending");
      const second = yield* repository.bindAndEnqueue(input);
      assert.isTrue(second.resumed);
      assert.equal(second.binding.threadId, input.threadId);
    }),
  ),
);

it.effect("rejects the same key with a different request hash", () =>
  withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* ThreadBindingRepository;
      yield* repository.bindAndEnqueue(input);
      const error = yield* Effect.flip(
        repository.bindAndEnqueue({ ...input, requestHash: "hash-2" }),
      );
      assert.equal(error._tag, "LinxIdempotencyConflictError");
    }),
  ),
);

it.effect("rolls back the binding when the command id is already used", () =>
  withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* ThreadBindingRepository;
      yield* repository.bindAndEnqueue(input);
      yield* Effect.flip(
        repository.bindAndEnqueue({
          ...input,
          idempotencyKey: "linx:launch:other",
          threadId: "linx:launch:other",
        }),
      );
      assert.isNull(yield* repository.getBinding("linx:launch:other"));
      assert.isNull(yield* repository.getOutbox("linx:launch:other"));
    }),
  ),
);

it.effect("updates sent and failed outbox states without touching the binding", () =>
  withRepository(() =>
    Effect.gen(function* () {
      const repository = yield* ThreadBindingRepository;
      yield* repository.bindAndEnqueue(input);
      yield* repository.markSent(input.idempotencyKey, "run-1");
      const sent = yield* repository.getOutbox(input.idempotencyKey);
      assert.equal(sent?.state, "sent");
      assert.equal((yield* repository.getBinding(input.threadId))?.runId, "run-1");
      yield* repository.markFailed(input.idempotencyKey, "timeout", 2);
      const failed = yield* repository.getOutbox(input.idempotencyKey);
      assert.equal(failed?.state, "failed");
      assert.equal(failed?.attempts, 2);
      assert.equal(failed?.lastError, "timeout");
    }),
  ),
);
