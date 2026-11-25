// @effect-diagnostics nodeBuiltinImport:off - test fixtures use node builtins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as resourceStoreLayer, LinxResourceStore } from "./LinxResourceStore.ts";

const withStore = <A, E>(run: (root: string) => Effect.Effect<A, E, LinxResourceStore>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linx-resources-"));
  return run(root).pipe(
    Effect.provide(resourceStoreLayer(root).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
};

it.effect("stores content by hash and reads it back idempotently", () =>
  withStore((root) =>
    Effect.gen(function* () {
      const store = yield* LinxResourceStore;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const first = yield* store.put({ kind: "expert", bytes, extension: ".bin" });
      const second = yield* store.put({ kind: "expert", bytes, extension: ".bin" });
      assert.equal(first.sha256, second.sha256);
      assert.equal(first.relativePath, second.relativePath);
      assert.match(first.relativePath, /^expert\/[0-9a-f]{2}\/[0-9a-f]{64}\.bin$/);
      assert.deepEqual(yield* store.read(first.relativePath), bytes);
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, first.relativePath)));
      const mode = NodeFS.statSync(NodePath.join(root, first.relativePath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }),
  ),
);

it.effect("rejects kind and path escapes", () =>
  withStore(() =>
    Effect.gen(function* () {
      const store = yield* LinxResourceStore;
      const badKind = yield* Effect.flip(store.put({ kind: "../escape", bytes: new Uint8Array() }));
      assert.equal(badKind._tag, "LinxResourcePathError");
      const traversal = yield* Effect.flip(store.read("../outside"));
      assert.equal(traversal._tag, "LinxResourcePathError");
      const absolute = yield* Effect.flip(store.read("/etc/passwd"));
      assert.equal(absolute._tag, "LinxResourcePathError");
    }),
  ),
);

it.effect("rejects a symlink at the content path", () =>
  withStore((root) =>
    Effect.gen(function* () {
      const store = yield* LinxResourceStore;
      const bytes = new Uint8Array([9, 9, 9]);
      const stored = yield* store.put({ kind: "expert", bytes });
      const target = NodePath.join(root, stored.relativePath);
      const outside = NodePath.join(root, "outside");
      NodeFS.writeFileSync(outside, bytes);
      NodeFS.rmSync(target);
      NodeFS.symlinkSync(outside, target);
      const error = yield* Effect.flip(store.read(stored.relativePath));
      assert.equal(error._tag, "LinxResourcePathError");
    }),
  ),
);

it.effect("rejects bytes that no longer match the stored hash", () =>
  withStore((root) =>
    Effect.gen(function* () {
      const store = yield* LinxResourceStore;
      const stored = yield* store.put({ kind: "expert", bytes: new Uint8Array([1]) });
      NodeFS.writeFileSync(NodePath.join(root, stored.relativePath), new Uint8Array([2]));
      const error = yield* Effect.flip(store.read(stored.relativePath));
      assert.equal(error._tag, "LinxResourcePathError");
    }),
  ),
);
