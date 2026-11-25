// @effect-diagnostics globalJsonInEffect:off - stored JSON is parsed in pure helpers or guarded by Effect.try.
// @effect-diagnostics nodeBuiltinImport:off - skill import hashes and validates files from disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import type * as SqlError from "effect/sql/SqlError";

import type {
  LinxSkillPackageDetail,
  LinxSkillPackageRevision,
  LinxSkillPackageSummary,
} from "@t3tools/contracts";

import {
  LinxDependencyMissingError,
  LinxDefinitionMissingError,
  LinxLimitExceededError,
  LinxResourcePathError,
  LinxRevisionConflictError,
  LinxStorageError,
} from "../persistence/Errors.ts";
import { LinxResourceStore } from "../persistence/LinxResourceStore.ts";
import { LinxSqlClient } from "../persistence/LinxSqlite.ts";

export interface LinxSkillFile {
  readonly path: string;
  readonly sha256: string;
  readonly resourcePath: string;
  readonly bytes: number;
}

export interface LinxSkillManifest {
  readonly name: string;
  readonly version: string;
  readonly entry: string;
  readonly license: string;
  readonly dependencies: ReadonlyArray<{
    readonly packageId: string;
    readonly revision: number;
    readonly contentHash: string;
  }>;
  readonly files: ReadonlyArray<LinxSkillFile>;
}

export interface LinxSkillFileSummary {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface LinxResolvedAssembly {
  readonly assemblyJson: string;
  readonly assemblyHash: string;
}

const MANIFEST_FILE = "linx-skill.json";
const MAX_FILES = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_PATH_LENGTH = 240;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DEPENDENCY_DEPTH = 8;

const sha256 = (value: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const ManifestSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  entry: Schema.String,
  license: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        packageId: Schema.String,
        revision: Schema.Number,
        contentHash: Schema.String,
      }),
    ),
  ),
});
const decodeManifest = Schema.decodeUnknownSync(ManifestSchema);

const dependency = (id: string, category: string) =>
  new LinxDependencyMissingError({ entity: "skill", id, category });

const limit = (name: string, actual: number, maximum: number) =>
  new LinxLimitExceededError({ limit: name, actual, maximum });

const normalizeRelative = (relative: string): string | null => {
  if (relative.length === 0 || relative.length > MAX_PATH_LENGTH) return null;
  if (relative.includes("\\") || relative.includes("\0")) return null;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return relative.normalize("NFC");
};

const canonicalFiles = (files: ReadonlyArray<LinxSkillFile>) =>
  files
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));

const canonicalSkillContent = (input: {
  readonly name: string;
  readonly version: string;
  readonly entry: string;
  readonly license: string;
  readonly dependencies: LinxSkillManifest["dependencies"];
  readonly files: ReadonlyArray<LinxSkillFile>;
}): string =>
  JSON.stringify({
    name: input.name,
    version: input.version,
    entry: input.entry,
    license: input.license,
    dependencies: [...input.dependencies]
      .map((entry) => ({
        packageId: entry.packageId,
        revision: entry.revision,
        contentHash: entry.contentHash,
      }))
      .sort(
        (left, right) =>
          left.packageId.localeCompare(right.packageId) || left.revision - right.revision,
      ),
    files: canonicalFiles(input.files),
  });

const contentHashFor = (input: Parameters<typeof canonicalSkillContent>[0]): string =>
  sha256(`linx-skill/1\0${canonicalSkillContent(input)}`);

const packageIdFor = (name: string, version: string): string =>
  `skill_${sha256(`linx-skill-id/1\0${name}\0${version}`).slice(0, 24)}`;

interface SkillRow {
  readonly package_id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly manifest_json: string;
  readonly dependencies_json: string;
  readonly file_count: number;
  readonly total_bytes: number;
  readonly source: string;
  readonly created_at: string;
}

interface PackageRow {
  readonly package_id: string;
  readonly name: string;
  readonly current_revision: number;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const parseManifestJson = (row: SkillRow): LinxSkillManifest => {
  const stored = JSON.parse(row.manifest_json) as Omit<LinxSkillManifest, "dependencies">;
  const dependencies = JSON.parse(row.dependencies_json) as LinxSkillManifest["dependencies"];
  return { ...stored, dependencies };
};

const toRevision = (row: SkillRow): LinxSkillPackageRevision => {
  const manifest = parseManifestJson(row);
  return {
    packageId: row.package_id,
    revision: row.revision,
    contentHash: row.content_hash,
    name: manifest.name,
    version: manifest.version,
    entryPath: manifest.entry,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    license: manifest.license,
    source: row.source,
    createdAt: row.created_at,
  };
};

export class SkillPackageService extends Context.Service<
  SkillPackageService,
  {
    readonly importDirectory: (
      directory: string,
    ) => Effect.Effect<
      LinxSkillPackageDetail,
      | LinxDependencyMissingError
      | LinxLimitExceededError
      | LinxRevisionConflictError
      | LinxStorageError
      | LinxResourcePathError
      | PlatformError.PlatformError
      | SqlError.SqlError
    >;
    readonly list: () => Effect.Effect<
      ReadonlyArray<LinxSkillPackageSummary>,
      LinxStorageError | SqlError.SqlError
    >;
    readonly get: (
      packageId: string,
      revision?: number,
    ) => Effect.Effect<LinxSkillPackageDetail | null, LinxStorageError | SqlError.SqlError>;
    readonly archive: (
      packageId: string,
      expectedRevision: number,
    ) => Effect.Effect<
      LinxSkillPackageSummary,
      LinxDefinitionMissingError | LinxRevisionConflictError | LinxStorageError | SqlError.SqlError
    >;
    readonly resolveAssembly: (
      selection: ReadonlyArray<{
        readonly packageId: string;
        readonly revision: number;
        readonly contentHash: string;
      }>,
    ) => Effect.Effect<
      LinxResolvedAssembly,
      LinxDependencyMissingError | LinxStorageError | SqlError.SqlError
    >;
    readonly filesFor: (
      packageId: string,
      revision: number,
      contentHash: string,
    ) => Effect.Effect<
      ReadonlyArray<LinxSkillFileSummary>,
      LinxDependencyMissingError | LinxStorageError | SqlError.SqlError
    >;
    readonly readFile: (input: {
      readonly packageId: string;
      readonly revision: number;
      readonly contentHash: string;
      readonly relativePath?: string;
    }) => Effect.Effect<
      {
        readonly path: string;
        readonly content: string;
        readonly sha256: string;
        readonly bytes: number;
      },
      | LinxDependencyMissingError
      | LinxResourcePathError
      | LinxStorageError
      | PlatformError.PlatformError
      | SqlError.SqlError
    >;
  }
>()("t3/linx/skill/SkillPackageService") {}

export const layer = Layer.effect(
  SkillPackageService,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;
    const resources = yield* LinxResourceStore;

    const selectPackage = (packageId: string) =>
      sql<PackageRow>`
        SELECT package_id, name, current_revision, archived_at, created_at, updated_at
        FROM skill_packages WHERE package_id = ${packageId}
      `;

    const selectRevision = (packageId: string, revision: number) =>
      sql<SkillRow>`
        SELECT package_id, revision, content_hash, manifest_json, dependencies_json,
               file_count, total_bytes, source, created_at
        FROM skill_package_revisions
        WHERE package_id = ${packageId} AND revision = ${revision}
      `;

    const selectByHash = (packageId: string, contentHash: string) =>
      sql<SkillRow>`
        SELECT package_id, revision, content_hash, manifest_json, dependencies_json,
               file_count, total_bytes, source, created_at
        FROM skill_package_revisions
        WHERE package_id = ${packageId} AND content_hash = ${contentHash}
        ORDER BY revision DESC LIMIT 1
      `;

    const summary = (row: PackageRow, latest: SkillRow): LinxSkillPackageSummary => ({
      packageId: row.package_id,
      name: row.name,
      currentRevision: row.current_revision,
      contentHash: latest.content_hash,
      archived: row.archived_at !== null,
      updatedAt: row.updated_at,
    });

    const detail = Effect.fn("SkillPackageService.detail")(function* (packageId: string) {
      const pkg = (yield* selectPackage(packageId))[0];
      if (pkg === undefined) return null;
      const revisions = yield* sql<SkillRow>`
        SELECT package_id, revision, content_hash, manifest_json, dependencies_json,
               file_count, total_bytes, source, created_at
        FROM skill_package_revisions
        WHERE package_id = ${packageId}
        ORDER BY revision
      `;
      const current = revisions.find((row) => row.revision === pkg.current_revision);
      if (current === undefined) {
        return yield* new LinxStorageError({
          operation: "query",
          entity: "skill_package_revisions",
          category: "current-revision-missing",
        });
      }
      return {
        ...summary(pkg, current),
        revisions: revisions.map(toRevision),
      } satisfies LinxSkillPackageDetail;
    });

    const importDirectory = Effect.fn("SkillPackageService.importDirectory")(function* (
      directory: string,
    ) {
      const root = NodePath.resolve(directory);
      const rootInfo = yield* Effect.tryPromise({
        try: () => NodeFS.promises.lstat(root),
        catch: () => dependency(directory, "directory-unreadable"),
      });
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
        return yield* dependency(directory, "not-a-directory");
      }

      const manifestPath = NodePath.join(root, MANIFEST_FILE);
      const manifestInfo = yield* Effect.tryPromise({
        try: () => NodeFS.promises.lstat(manifestPath),
        catch: () => dependency(MANIFEST_FILE, "manifest-missing"),
      });
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
        return yield* dependency(MANIFEST_FILE, "manifest-not-a-file");
      }
      if (manifestInfo.size > MAX_MANIFEST_BYTES) {
        return yield* limit("manifest bytes", manifestInfo.size, MAX_MANIFEST_BYTES);
      }
      const manifestBytes = yield* Effect.tryPromise({
        try: () => NodeFS.promises.readFile(manifestPath),
        catch: () => dependency(MANIFEST_FILE, "manifest-unreadable"),
      });
      const decoded = yield* Effect.try({
        try: () => decodeManifest(JSON.parse(manifestBytes.toString("utf8"))),
        catch: () => dependency(MANIFEST_FILE, "manifest-invalid"),
      });

      const entry = normalizeRelative(decoded.entry);
      if (entry === null) return yield* dependency(decoded.entry, "entry-path-invalid");

      const files: LinxSkillFile[] = [];
      const seen = new Set<string>();
      let totalBytes = 0;

      const walk: (
        current: string,
        prefix: string,
        depth: number,
      ) => Effect.Effect<
        void,
        | LinxDependencyMissingError
        | LinxLimitExceededError
        | LinxResourcePathError
        | PlatformError.PlatformError
      > = Effect.fn("SkillPackageService.walk")(function* (
        current: string,
        prefix: string,
        depth: number,
      ) {
        if (depth > MAX_DEPTH) {
          return yield* limit("directory depth", depth, MAX_DEPTH);
        }
        const entries = yield* Effect.tryPromise({
          try: () => NodeFS.promises.readdir(current, { withFileTypes: true }),
          catch: () => dependency(prefix || ".", "directory-unreadable"),
        });
        for (const dirent of [...entries].sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          const relative = normalizeRelative(
            prefix === "" ? dirent.name : `${prefix}/${dirent.name}`,
          );
          if (relative === null) {
            return yield* dependency(`${prefix}/${dirent.name}`, "path-invalid");
          }
          const absolute = NodePath.join(current, dirent.name);
          const info = yield* Effect.tryPromise({
            try: () => NodeFS.promises.lstat(absolute),
            catch: () => dependency(relative, "unreadable"),
          });
          if (info.isSymbolicLink()) return yield* dependency(relative, "symlink");
          if (info.isDirectory()) {
            const folded = `${relative}/`.toLowerCase();
            if (seen.has(folded)) return yield* dependency(relative, "duplicate-path");
            seen.add(folded);
            yield* walk(absolute, relative, depth + 1);
            continue;
          }
          if (!info.isFile()) return yield* dependency(relative, "not-a-regular-file");
          if (relative === MANIFEST_FILE) continue;
          if (files.length >= MAX_FILES) {
            return yield* limit("file count", files.length + 1, MAX_FILES);
          }
          if (info.size > MAX_FILE_BYTES) {
            return yield* limit("file bytes", info.size, MAX_FILE_BYTES);
          }
          totalBytes += info.size;
          if (totalBytes > MAX_TOTAL_BYTES) {
            return yield* limit("total bytes", totalBytes, MAX_TOTAL_BYTES);
          }
          const folded = relative.normalize("NFC").toLowerCase();
          if (seen.has(folded)) return yield* dependency(relative, "duplicate-path");
          seen.add(folded);
          const bytes = yield* Effect.tryPromise({
            try: () => NodeFS.promises.readFile(absolute),
            catch: () => dependency(relative, "unreadable"),
          });
          const stored = yield* resources.put({ kind: "skill", bytes });
          files.push({
            path: relative,
            sha256: stored.sha256,
            resourcePath: stored.relativePath,
            bytes: bytes.byteLength,
          });
        }
      });

      yield* walk(root, "", 0);

      if (!files.some((file) => file.path === entry)) {
        return yield* dependency(entry, "entry-missing");
      }

      const dependencies = [...(decoded.dependencies ?? [])]
        .map((entryDependency) => ({
          packageId: entryDependency.packageId,
          revision: entryDependency.revision,
          contentHash: entryDependency.contentHash,
        }))
        .sort(
          (left, right) =>
            left.packageId.localeCompare(right.packageId) || left.revision - right.revision,
        );
      const packageId = packageIdFor(decoded.name, decoded.version);
      for (const entryDependency of dependencies) {
        if (entryDependency.packageId === packageId) {
          return yield* dependency(packageId, "dependency-cycle");
        }
        const row = (yield* selectRevision(entryDependency.packageId, entryDependency.revision))[0];
        if (row === undefined || row.content_hash !== entryDependency.contentHash) {
          return yield* dependency(entryDependency.packageId, "dependency-unresolved");
        }
        yield* assertNoCycle(entryDependency.packageId, packageId, 1);
      }

      const license = decoded.license ?? "";
      const manifest: LinxSkillManifest = {
        name: decoded.name,
        version: decoded.version,
        entry,
        license,
        dependencies,
        files,
      };
      const contentHash = contentHashFor(manifest);
      const source = "directory";

      const existing = (yield* selectByHash(packageId, contentHash))[0];
      if (existing !== undefined) {
        const current = yield* detail(packageId);
        if (current !== null) return current;
      }

      const manifestJson = JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        entry: manifest.entry,
        license: manifest.license,
        files: manifest.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          resourcePath: file.resourcePath,
          bytes: file.bytes,
        })),
      });

      yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          const existingPackage = (yield* selectPackage(packageId))[0];
          if (existingPackage === undefined) {
            yield* sql`
              INSERT INTO skill_packages
                (package_id, name, current_revision, archived_at, created_at, updated_at)
              VALUES (${packageId}, ${manifest.name}, 1, NULL, ${now}, ${now})
              ON CONFLICT(package_id) DO NOTHING
            `;
          }
          const rows = yield* sql<{ readonly revision: number }>`
            SELECT COALESCE(MAX(revision), 0) + 1 AS revision
            FROM skill_package_revisions WHERE package_id = ${packageId}
          `;
          const revision = rows[0]?.revision;
          if (revision === undefined) {
            return yield* new LinxStorageError({
              operation: "query",
              entity: "skill_package_revisions",
              category: "next-revision-missing",
            });
          }
          yield* sql`
            INSERT INTO skill_package_revisions
              (package_id, revision, content_hash, manifest_json, dependencies_json,
               file_count, total_bytes, source, created_at)
            VALUES
              (${packageId}, ${revision}, ${contentHash}, ${manifestJson},
               ${JSON.stringify(dependencies)}, ${files.length}, ${totalBytes}, ${source}, ${now})
          `;
          yield* sql`
            UPDATE skill_packages
            SET current_revision = ${revision}, updated_at = ${now}
            WHERE package_id = ${packageId}
          `;
        }),
      );

      const created = yield* detail(packageId);
      if (created === null) {
        return yield* new LinxStorageError({
          operation: "read",
          entity: "skill_packages",
          category: "missing-after-insert",
        });
      }
      return created;
    });

    const assertNoCycle: (
      packageId: string,
      target: string,
      depth: number,
    ) => Effect.Effect<void, LinxDependencyMissingError | SqlError.SqlError> = Effect.fn(
      "SkillPackageService.assertNoCycle",
    )(function* (packageId: string, target: string, depth: number) {
      if (depth > MAX_DEPENDENCY_DEPTH) {
        return yield* dependency(packageId, "dependency-depth");
      }
      const rows = yield* sql<{ readonly dependencies_json: string }>`
          SELECT dependencies_json FROM skill_package_revisions
          WHERE package_id = ${packageId}
          ORDER BY revision DESC LIMIT 1
        `;
      const raw = rows[0]?.dependencies_json;
      if (raw === undefined) return;
      const dependencies = JSON.parse(raw) as LinxSkillManifest["dependencies"];
      for (const entry of dependencies) {
        if (entry.packageId === target) {
          return yield* dependency(target, "dependency-cycle");
        }
        yield* assertNoCycle(entry.packageId, target, depth + 1);
      }
    });

    const list = Effect.fn("SkillPackageService.list")(function* () {
      const rows = yield* sql<PackageRow & { readonly content_hash: string }>`
        SELECT p.package_id, p.name, p.current_revision, p.archived_at, p.created_at, p.updated_at,
               r.content_hash
        FROM skill_packages AS p
        INNER JOIN skill_package_revisions AS r
          ON r.package_id = p.package_id AND r.revision = p.current_revision
        ORDER BY p.name, p.package_id
      `;
      return rows.map((row) => ({
        packageId: row.package_id,
        name: row.name,
        currentRevision: row.current_revision,
        contentHash: row.content_hash,
        archived: row.archived_at !== null,
        updatedAt: row.updated_at,
      }));
    });

    const get = Effect.fn("SkillPackageService.get")(function* (
      packageId: string,
      revision?: number,
    ) {
      if (revision === undefined) return yield* detail(packageId);
      const row = (yield* selectRevision(packageId, revision))[0];
      if (row === undefined) return null;
      const pkg = (yield* selectPackage(packageId))[0];
      if (pkg === undefined) return null;
      return { ...summary(pkg, row), revisions: [toRevision(row)] };
    });

    const archive = Effect.fn("SkillPackageService.archive")(function* (
      packageId: string,
      expectedRevision: number,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* sql<{ readonly revision: number }>`
        UPDATE skill_packages
        SET archived_at = ${now}, updated_at = ${now}
        WHERE package_id = ${packageId} AND current_revision = ${expectedRevision}
        RETURNING current_revision AS revision
      `;
      if (updated.length === 0) {
        const pkg = (yield* selectPackage(packageId))[0];
        if (pkg === undefined) {
          return yield* new LinxDefinitionMissingError({
            entity: "skill package",
            id: packageId,
          });
        }
        return yield* new LinxRevisionConflictError({
          entity: "skill package",
          expectedRevision,
          actualRevision: pkg.current_revision,
        });
      }
      const current = yield* detail(packageId);
      if (current === null) {
        return yield* new LinxStorageError({
          operation: "read",
          entity: "skill_packages",
          category: "missing-after-archive",
        });
      }
      return current;
    });

    const resolveAssembly = Effect.fn("SkillPackageService.resolveAssembly")(function* (
      selection: ReadonlyArray<{
        readonly packageId: string;
        readonly revision: number;
        readonly contentHash: string;
      }>,
    ) {
      const packages: Array<{
        packageId: string;
        revision: number;
        contentHash: string;
        name: string;
        version: string;
        entryPath: string;
        files: ReadonlyArray<LinxSkillFile>;
      }> = [];
      for (const choice of [...selection].sort(
        (left, right) =>
          left.packageId.localeCompare(right.packageId) || left.revision - right.revision,
      )) {
        const row = (yield* selectRevision(choice.packageId, choice.revision))[0];
        if (row === undefined) {
          return yield* dependency(choice.packageId, "skill-revision-missing");
        }
        if (row.content_hash !== choice.contentHash) {
          return yield* dependency(choice.packageId, "skill-hash-mismatch");
        }
        const manifest = parseManifestJson(row);
        packages.push({
          packageId: row.package_id,
          revision: row.revision,
          contentHash: row.content_hash,
          name: manifest.name,
          version: manifest.version,
          entryPath: manifest.entry,
          files: manifest.files,
        });
      }
      const assemblyJson = JSON.stringify({ version: 1, packages });
      return {
        assemblyJson,
        assemblyHash: sha256(`linx-assembly/1\0${assemblyJson}`),
      } satisfies LinxResolvedAssembly;
    });

    const selectVerifiedManifest = Effect.fn("SkillPackageService.selectVerifiedManifest")(
      function* (packageId: string, revision: number, contentHash: string) {
        const row = (yield* selectRevision(packageId, revision))[0];
        if (row === undefined) {
          return yield* dependency(packageId, "skill-revision-missing");
        }
        if (row.content_hash !== contentHash) {
          return yield* dependency(packageId, "skill-hash-mismatch");
        }
        return parseManifestJson(row);
      },
    );

    const filesFor = Effect.fn("SkillPackageService.filesFor")(function* (
      packageId: string,
      revision: number,
      contentHash: string,
    ) {
      const manifest = yield* selectVerifiedManifest(packageId, revision, contentHash);
      return manifest.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
      }));
    });

    const readFile = Effect.fn("SkillPackageService.readFile")(function* (input: {
      readonly packageId: string;
      readonly revision: number;
      readonly contentHash: string;
      readonly relativePath?: string;
    }) {
      const manifest = yield* selectVerifiedManifest(
        input.packageId,
        input.revision,
        input.contentHash,
      );
      const path = input.relativePath ?? manifest.entry;
      const file = manifest.files.find((entry) => entry.path === path);
      if (file === undefined) {
        return yield* dependency(path, "file-not-in-package");
      }
      if (file.bytes > 256 * 1024) {
        return yield* dependency(path, "file-too-large-to-read");
      }
      const bytes = yield* resources.read(file.resourcePath);
      if (sha256(bytes) !== file.sha256) {
        return yield* dependency(path, "file-hash-mismatch");
      }
      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => dependency(path, "not-text"),
      });
      return { path: file.path, content, sha256: file.sha256, bytes: file.bytes };
    });

    return SkillPackageService.of({
      importDirectory,
      list,
      get,
      archive,
      resolveAssembly,
      filesFor,
      readFile,
    });
  }),
);
