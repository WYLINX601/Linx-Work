// @effect-diagnostics nodeBuiltinImport:off - test temp dirs and modes use node builtins.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { deriveServerPaths, ensureServerDirectories } from "../../config.ts";

it.effect("keeps production and development Linx state under stateDir", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linx-paths-"));
  return Effect.gen(function* () {
    const production = yield* deriveServerPaths(baseDir, undefined);
    const development = yield* deriveServerPaths(baseDir, new URL("http://localhost:5734"));
    yield* ensureServerDirectories(production);

    assert.equal(production.linxDbPath, NodePath.join(baseDir, "userdata", "linx.sqlite"));
    assert.equal(production.linxResourceDir, NodePath.join(baseDir, "userdata", "linx-resources"));
    assert.equal(development.linxDbPath, NodePath.join(baseDir, "dev", "linx.sqlite"));
    assert.equal(NodeFS.statSync(production.linxResourceDir).mode & 0o777, 0o700);
    assert.isTrue(NodeFS.statSync(production.linxResourceDir).isDirectory());
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});
