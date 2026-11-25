// @effect-diagnostics nodeBuiltinImport:off - resource storage owns fsync and atomic link semantics.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { LinxResourcePathError } from "./Errors.ts";

const KIND_PATTERN = /^[a-z0-9-]+$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;
const RELATIVE_PATH_PATTERN =
  /^([a-z0-9-]+)\/([0-9a-f]{2})\/([0-9a-f]{64})(?:\.([a-z0-9]{1,10}))?$/;

type ResourceError = LinxResourcePathError | PlatformError.PlatformError;

export class LinxResourceStore extends Context.Service<
  LinxResourceStore,
  {
    readonly put: (input: {
      readonly kind: string;
      readonly bytes: Uint8Array;
      readonly extension?: string;
    }) => Effect.Effect<{ readonly relativePath: string; readonly sha256: string }, ResourceError>;
    readonly read: (relativePath: string) => Effect.Effect<Uint8Array, ResourceError>;
  }
>()("t3/linx/persistence/LinxResourceStore") {}

const failPath = (operation: "put" | "read", category: string) =>
  new LinxResourcePathError({ operation, category });

const resolveInside = (root: string, relativePath: string): string | null => {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\")
  ) {
    return null;
  }
  const absolute = NodePath.resolve(root, relativePath);
  return absolute.startsWith(`${root}${NodePath.sep}`) ? absolute : null;
};

const sha256 = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const fsyncFile = (filePath: string): void => {
  const descriptor = NodeFS.openSync(filePath, "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
};

export const layer = (resourceDir: string) =>
  Layer.effect(
    LinxResourceStore,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = NodePath.resolve(resourceDir);

      const assertDirectory = (directory: string, operation: "put" | "read") =>
        Effect.try({
          try: () => NodeFS.lstatSync(directory).isDirectory(),
          catch: () => failPath(operation, "missing-directory"),
        }).pipe(
          Effect.flatMap((valid) =>
            valid ? Effect.void : Effect.fail(failPath(operation, "not-a-directory")),
          ),
        );

      const put = Effect.fn("LinxResourceStore.put")(function* (input: {
        readonly kind: string;
        readonly bytes: Uint8Array;
        readonly extension?: string;
      }) {
        if (!KIND_PATTERN.test(input.kind)) return yield* failPath("put", "invalid-kind");
        const extension = input.extension?.replace(/^\./, "").toLowerCase();
        if (extension !== undefined && !EXTENSION_PATTERN.test(extension)) {
          return yield* failPath("put", "invalid-extension");
        }
        const hash = sha256(input.bytes);
        const suffix = extension === undefined ? "" : `.${extension}`;
        const relativePath = `${input.kind}/${hash.slice(0, 2)}/${hash}${suffix}`;
        const absolute = resolveInside(root, relativePath);
        if (absolute === null) return yield* failPath("put", "path-escape");

        yield* assertDirectory(root, "put");
        const kindDir = path.join(root, input.kind);
        const shardDir = path.dirname(absolute);
        for (const directory of [kindDir, shardDir]) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* assertDirectory(directory, "put");
        }
        if (yield* fileSystem.exists(absolute)) {
          yield* read(relativePath);
          return { relativePath, sha256: hash };
        }

        const partPath = `${absolute}.${NodeCrypto.randomUUID()}.part`;
        const write = Effect.gen(function* () {
          yield* fileSystem.writeFile(partPath, input.bytes, { mode: 0o600 });
          yield* Effect.try({
            try: () => fsyncFile(partPath),
            catch: () => failPath("put", "fsync-failed"),
          });
          const linked = yield* fileSystem.link(partPath, absolute).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!linked) yield* read(relativePath);
          return { relativePath, sha256: hash };
        });
        return yield* write.pipe(
          Effect.ensuring(fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore)),
        );
      });

      const read = Effect.fn("LinxResourceStore.read")(function* (relativePath: string) {
        const match = RELATIVE_PATH_PATTERN.exec(relativePath);
        if (match === null) return yield* failPath("read", "invalid-path");
        if (match[2] !== match[3]?.slice(0, 2)) return yield* failPath("read", "invalid-path");
        const absolute = resolveInside(root, relativePath);
        if (absolute === null) return yield* failPath("read", "path-escape");

        const info = yield* Effect.try({
          try: () => NodeFS.lstatSync(absolute),
          catch: () => failPath("read", "missing"),
        });
        if (info.isSymbolicLink()) return yield* failPath("read", "symlink");
        if (!info.isFile()) return yield* failPath("read", "not-a-file");

        yield* assertDirectory(root, "read");
        const realRoot = yield* Effect.try({
          try: () => NodeFS.realpathSync(root),
          catch: () => failPath("read", "root-unreadable"),
        });
        const realFile = yield* Effect.try({
          try: () => NodeFS.realpathSync(absolute),
          catch: () => failPath("read", "missing"),
        });
        if (realFile !== NodePath.resolve(realRoot, relativePath)) {
          return yield* failPath("read", "symlink");
        }

        const bytes = yield* Effect.tryPromise({
          try: () => NodeFS.promises.readFile(absolute),
          catch: () => failPath("read", "missing"),
        });
        if (sha256(bytes) !== match[3]) return yield* failPath("read", "hash-mismatch");
        return bytes;
      });

      return LinxResourceStore.of({ put, read });
    }),
  );
