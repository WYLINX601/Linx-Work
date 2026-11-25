// @effect-diagnostics nodeBuiltinImport:off - fixtures write skill packages on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ExpertSnapshotService, layer as expertSnapshotLayer } from "./ExpertSnapshotService.ts";
import { ExpertDefinitionService, layer as definitionLayer } from "./ExpertDefinitionService.ts";
import { layer as linxSqliteLayer } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import { LinxResourceStore, layer as resourcesLayer } from "../persistence/LinxResourceStore.ts";
import { SkillPackageService, layer as skillPackageLayer } from "../skill/SkillPackageService.ts";

const makeTempDir = (): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linx-expert-"));

const writeSkillPackage = (root: string): void => {
  NodeFS.mkdirSync(root, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "linx-skill.json"),
    JSON.stringify({ name: "Reviewer", version: "1.0.0", entry: "SKILL.md" }),
  );
  NodeFS.writeFileSync(NodePath.join(root, "SKILL.md"), "# Reviewer\n");
};

const withServices = <A, E>(
  directory: string,
  run: () => Effect.Effect<
    A,
    E,
    ExpertDefinitionService | ExpertSnapshotService | SkillPackageService | LinxResourceStore
  >,
) => {
  const resourceDir = NodePath.join(directory, "resources");
  NodeFS.mkdirSync(resourceDir, { recursive: true });
  const resources = resourcesLayer(resourceDir);
  const skills = skillPackageLayer.pipe(Layer.provide(resources));
  const definitions = definitionLayer.pipe(
    Layer.provide(skills),
    Layer.provide(expertSnapshotLayer),
    Layer.provide(resources),
  );
  const layer = Layer.mergeAll(definitions, skills, expertSnapshotLayer, resources).pipe(
    Layer.provideMerge(linxSqliteLayer(":memory:")),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    yield* runLinxMigrations;
    return yield* run();
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
};

const baseInput = {
  title: "Code Reviewer",
  persona: "Review carefully.",
  references: [],
  skillSelection: [],
  mcpGrants: [],
};

it.effect(
  "creates revisions, rejects stale saves, and hides archived experts from selection",
  () => {
    const directory = makeTempDir();
    return withServices(directory, () =>
      Effect.gen(function* () {
        const definitions = yield* ExpertDefinitionService;
        const snapshots = yield* ExpertSnapshotService;

        const first = yield* definitions.save(baseInput);
        assert.equal(first.currentRevision, 1);
        assert.equal(first.archived, false);
        assert.equal((yield* definitions.list()).length, 1);

        const second = yield* definitions.save({
          ...baseInput,
          expertId: first.expertId,
          expectedRevision: 1,
          persona: "Review even more carefully.",
        });
        assert.equal(second.currentRevision, 2);
        assert.notEqual(second.snapshotId, first.snapshotId);
        assert.equal(second.persona, "Review even more carefully.");

        const stale = yield* Effect.flip(
          definitions.save({
            ...baseInput,
            expertId: first.expertId,
            expectedRevision: 1,
            persona: "Stale.",
          }),
        );
        assert.equal(stale._tag, "LinxRevisionConflictError");

        const archived = yield* definitions.archive(first.expertId, 2);
        assert.isTrue(archived.archived);
        assert.equal((yield* snapshots.listLatest()).length, 0);

        const blocked = yield* Effect.flip(
          definitions.save({
            ...baseInput,
            expertId: first.expertId,
            expectedRevision: 2,
          }),
        );
        assert.equal(blocked._tag, "LinxDefinitionArchivedError");
        yield* definitions.assertSelectable(first.expertId).pipe(
          Effect.flip,
          Effect.map((error) => assert.equal(error._tag, "LinxDefinitionArchivedError")),
        );
      }),
    );
  },
);

it.effect("stores a skill selection only when the frozen hash matches", () => {
  const directory = makeTempDir();
  const packageDir = NodePath.join(directory, "package");
  writeSkillPackage(packageDir);
  return withServices(directory, () =>
    Effect.gen(function* () {
      const skills = yield* SkillPackageService;
      const definitions = yield* ExpertDefinitionService;
      const installed = yield* skills.importDirectory(packageDir);
      const revision = installed.revisions[0];
      assert.isDefined(revision);

      const saved = yield* definitions.save({
        ...baseInput,
        skillSelection: [revision],
      });
      assert.equal(saved.skillSelection.length, 1);

      const error = yield* Effect.flip(
        definitions.save({
          ...baseInput,
          skillSelection: [{ ...revision, contentHash: "c".repeat(64) }],
        }),
      );
      assert.equal(error._tag, "LinxDependencyMissingError");
    }),
  );
});

it.effect("stores references only when the resource hash resolves", () => {
  const directory = makeTempDir();
  return withServices(directory, () =>
    Effect.gen(function* () {
      const resources = yield* LinxResourceStore;
      const definitions = yield* ExpertDefinitionService;
      const bytes = new TextEncoder().encode("reference body");
      const stored = yield* resources.put({ kind: "expert", bytes });

      const saved = yield* definitions.save({
        ...baseInput,
        references: [{ name: "body", relativePath: stored.relativePath, sha256: stored.sha256 }],
      });
      assert.equal(saved.references[0]?.relativePath, stored.relativePath);

      const error = yield* Effect.flip(
        definitions.save({
          ...baseInput,
          references: [{ name: "body", relativePath: stored.relativePath, sha256: "d".repeat(64) }],
        }),
      );
      assert.equal(error._tag, "LinxDependencyMissingError");
    }),
  );
});

it.effect("rejects inconsistent MCP grants", () => {
  const directory = makeTempDir();
  return withServices(directory, () =>
    Effect.gen(function* () {
      const definitions = yield* ExpertDefinitionService;
      const error = yield* Effect.flip(
        definitions.save({
          ...baseInput,
          mcpGrants: [
            { connectionId: "mcp-1", revision: 1, tools: ["search"] },
            { connectionId: "mcp-1", revision: 2, tools: ["read"] },
          ],
        }),
      );
      assert.equal(error._tag, "LinxDependencyMissingError");
    }),
  );
});
