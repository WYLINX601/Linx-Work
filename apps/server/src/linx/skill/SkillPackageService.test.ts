// @effect-diagnostics nodeBuiltinImport:off - fixtures write skill packages on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as linxSqliteLayer } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import { layer as resourcesLayer } from "../persistence/LinxResourceStore.ts";
import { SkillPackageService, layer as skillPackageLayer } from "./SkillPackageService.ts";

const makeTempDir = (prefix: string): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));

const writePackage = (
  root: string,
  options: {
    readonly manifest?: Record<string, unknown>;
    readonly files: Record<string, string>;
  },
): void => {
  NodeFS.mkdirSync(root, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "linx-skill.json"),
    JSON.stringify({
      name: "Reviewer",
      version: "1.0.0",
      entry: "SKILL.md",
      ...options.manifest,
    }),
  );
  for (const [path, contents] of Object.entries(options.files)) {
    const absolute = NodePath.join(root, path);
    NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
    NodeFS.writeFileSync(absolute, contents);
  }
};

const withService = <A, E>(
  directory: string,
  run: () => Effect.Effect<A, E, SkillPackageService>,
) => {
  const resourceDir = NodePath.join(directory, "resources");
  NodeFS.mkdirSync(resourceDir, { recursive: true });
  const resources = resourcesLayer(resourceDir);
  const layer = Layer.merge(skillPackageLayer.pipe(Layer.provide(resources)), resources).pipe(
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

it.effect(
  "imports a skill package, records one immutable revision, and re-imports idempotently",
  () => {
    const directory = makeTempDir("linx-skill-");
    const packageDir = NodePath.join(directory, "package");
    writePackage(packageDir, {
      files: { "SKILL.md": "# Reviewer\n", "notes/tone.md": "Be direct.\n" },
    });
    return withService(directory, () =>
      Effect.gen(function* () {
        const skills = yield* SkillPackageService;
        const first = yield* skills.importDirectory(packageDir);
        assert.equal(first.currentRevision, 1);
        assert.equal(first.name, "Reviewer");
        assert.equal(first.revisions[0]?.fileCount, 2);
        assert.equal(first.revisions[0]?.entryPath, "SKILL.md");

        const second = yield* skills.importDirectory(packageDir);
        assert.equal(second.packageId, first.packageId);
        assert.equal(second.revisions.length, 1);
        assert.equal(second.revisions[0]?.contentHash, first.revisions[0]?.contentHash);
        assert.equal((yield* skills.list()).length, 1);
      }),
    );
  },
);

it.effect("publishes a new revision only when package content changes", () => {
  const directory = makeTempDir("linx-skill-");
  const packageDir = NodePath.join(directory, "package");
  writePackage(packageDir, { files: { "SKILL.md": "# Reviewer\n" } });
  return withService(directory, () =>
    Effect.gen(function* () {
      const skills = yield* SkillPackageService;
      const first = yield* skills.importDirectory(packageDir);
      NodeFS.writeFileSync(NodePath.join(packageDir, "SKILL.md"), "# Reviewer v2\n");
      const second = yield* skills.importDirectory(packageDir);
      assert.equal(second.packageId, first.packageId);
      assert.equal(second.currentRevision, 2);
      assert.equal(second.revisions.length, 2);
      assert.notEqual(second.revisions[1]?.contentHash, first.revisions[0]?.contentHash);
    }),
  );
});

it.effect("rejects symlinks and missing entry files", () => {
  const directory = makeTempDir("linx-skill-");
  const packageDir = NodePath.join(directory, "package");
  const outside = NodePath.join(directory, "outside.md");
  NodeFS.writeFileSync(outside, "outside");
  writePackage(packageDir, {
    manifest: { entry: "missing.md" },
    files: { "SKILL.md": "# Reviewer\n" },
  });
  NodeFS.symlinkSync(outside, NodePath.join(packageDir, "linked.md"));
  return withService(directory, () =>
    Effect.gen(function* () {
      const skills = yield* SkillPackageService;
      const error = yield* Effect.flip(skills.importDirectory(packageDir));
      assert.equal(error._tag, "LinxDependencyMissingError");
    }),
  );
});

it.effect("rejects a dependency whose recorded hash does not match", () => {
  const directory = makeTempDir("linx-skill-");
  const packageDir = NodePath.join(directory, "package");
  writePackage(packageDir, {
    manifest: {
      dependencies: [{ packageId: "skill_missing", revision: 1, contentHash: "a".repeat(64) }],
    },
    files: { "SKILL.md": "# Reviewer\n" },
  });
  return withService(directory, () =>
    Effect.gen(function* () {
      const skills = yield* SkillPackageService;
      const error = yield* Effect.flip(skills.importDirectory(packageDir));
      assert.equal(error._tag, "LinxDependencyMissingError");
    }),
  );
});

it.effect("resolves a frozen assembly and rejects a hash mismatch", () => {
  const directory = makeTempDir("linx-skill-");
  const packageDir = NodePath.join(directory, "package");
  writePackage(packageDir, { files: { "SKILL.md": "# Reviewer\n" } });
  return withService(directory, () =>
    Effect.gen(function* () {
      const skills = yield* SkillPackageService;
      const imported = yield* skills.importDirectory(packageDir);
      const revision = imported.revisions[0];
      assert.isDefined(revision);
      const assembly = yield* skills.resolveAssembly([revision]);
      assert.equal(assembly.assemblyJson.includes("SKILL.md"), true);
      const error = yield* Effect.flip(
        skills.resolveAssembly([{ ...revision, contentHash: "b".repeat(64) }]),
      );
      assert.equal(error._tag, "LinxDependencyMissingError");
    }),
  );
});

it.effect("archives with a revision check and keeps the content readable", () => {
  const directory = makeTempDir("linx-skill-");
  const packageDir = NodePath.join(directory, "package");
  writePackage(packageDir, { files: { "SKILL.md": "# Reviewer\n" } });
  return withService(directory, () =>
    Effect.gen(function* () {
      const skills = yield* SkillPackageService;
      const imported = yield* skills.importDirectory(packageDir);
      const archived = yield* skills.archive(imported.packageId, imported.currentRevision);
      assert.isTrue(archived.archived);
      const conflict = yield* Effect.flip(skills.archive(imported.packageId, 99));
      assert.equal(conflict._tag, "LinxRevisionConflictError");
      const stored = yield* skills.get(imported.packageId);
      assert.equal(stored?.revisions.length, 1);
    }),
  );
});

it.effect("reads the entry or a named file and rejects paths outside the frozen package", () => {
  const directory = makeTempDir("linx-skill-");
  const packageDir = NodePath.join(directory, "package");
  writePackage(packageDir, {
    files: { "SKILL.md": "# Reviewer\n", "notes/tone.md": "Be direct.\n" },
  });
  return withService(directory, () =>
    Effect.gen(function* () {
      const skills = yield* SkillPackageService;
      const imported = yield* skills.importDirectory(packageDir);
      const revision = imported.revisions[0];
      assert.isDefined(revision);
      const entry = yield* skills.readFile(revision);
      assert.equal(entry.path, "SKILL.md");
      assert.equal(entry.content, "# Reviewer\n");
      const named = yield* skills.readFile({ ...revision, relativePath: "notes/tone.md" });
      assert.equal(named.content, "Be direct.\n");
      const missing = yield* Effect.flip(
        skills.readFile({ ...revision, relativePath: "../outside.md" }),
      );
      assert.equal(missing._tag, "LinxDependencyMissingError");
      const wrongHash = yield* Effect.flip(
        skills.readFile({ ...revision, contentHash: "e".repeat(64) }),
      );
      assert.equal(wrongHash._tag, "LinxDependencyMissingError");
    }),
  );
});
