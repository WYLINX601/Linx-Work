// @effect-diagnostics nodeBuiltinImport:off - the macOS keychain is reached through /usr/bin/security.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { LinxSecretStoreError } from "../persistence/Errors.ts";

const KEYCHAIN_SERVICE = "com.linx.work.mcp";
const KEYCHAIN_REF_PREFIX = `keychain:${KEYCHAIN_SERVICE}:`;
const SECURITY_BINARY = "/usr/bin/security";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export class SecretStore extends Context.Service<
  SecretStore,
  {
    /** Stores a secret and returns an opaque reference; the value is never logged. */
    readonly put: (value: string) => Effect.Effect<string, LinxSecretStoreError>;
    readonly resolve: (reference: string) => Effect.Effect<string | null, LinxSecretStoreError>;
    readonly remove: (reference: string) => Effect.Effect<void, LinxSecretStoreError>;
  }
>()("t3/linx/secret/SecretStore") {}

class KeychainCommandError extends Schema.TaggedError<KeychainCommandError>()(
  "KeychainCommandError",
  { message: Schema.String },
) {}

const missingItem = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return message.includes("could not be found") || message.includes("The specified item");
};

const accountFromReference = (reference: string): string | null => {
  if (!reference.startsWith(KEYCHAIN_REF_PREFIX)) return null;
  const account = reference.slice(KEYCHAIN_REF_PREFIX.length);
  return /^[0-9a-f-]{36}$/.test(account) ? account : null;
};

const keychainLayer = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    yield* Effect.void;
    const put = Effect.fn("SecretStore.put")(function* (value: string) {
      const account = NodeCrypto.randomUUID();
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${encoded}\n`;
      yield* Effect.tryPromise({
        try: () =>
          (() => {
            const { promise, resolve, reject } = Promise.withResolvers<void>();
            const child = NodeChildProcess.spawn(SECURITY_BINARY, ["-i"], {
              stdio: ["pipe", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
            child.once("error", () => reject(new Error("keychain-unavailable")));
            child.once("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`keychain-write-failed:${stderr.trim().slice(0, 200)}`));
            });
            child.stdin.end(command);
            return promise;
          })(),
        catch: () => new LinxSecretStoreError({ operation: "put", category: "keychain" }),
      });
      return `${KEYCHAIN_REF_PREFIX}${account}`;
    });

    const resolve = Effect.fn("SecretStore.resolve")(function* (reference: string) {
      const account = accountFromReference(reference);
      if (account === null) return null;
      const result = yield* Effect.tryPromise({
        try: () =>
          execFile(SECURITY_BINARY, [
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            account,
            "-w",
          ]),
        catch: (error) =>
          new KeychainCommandError({
            message: error instanceof Error ? error.message : "",
          }),
      }).pipe(
        Effect.catchIf(
          (error) => missingItem(error),
          () => Effect.succeed({ stdout: "" }),
        ),
        Effect.mapError(
          () => new LinxSecretStoreError({ operation: "resolve", category: "keychain" }),
        ),
      );
      const encoded = result.stdout.trim();
      if (encoded.length === 0) return null;
      return Buffer.from(encoded, "base64").toString("utf8");
    });

    const remove = Effect.fn("SecretStore.remove")(function* (reference: string) {
      const account = accountFromReference(reference);
      if (account === null) return;
      yield* Effect.tryPromise({
        try: () =>
          execFile(SECURITY_BINARY, [
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            account,
          ]),
        catch: (error) =>
          new KeychainCommandError({
            message: error instanceof Error ? error.message : "",
          }),
      }).pipe(
        Effect.catchIf(
          (error) => missingItem(error),
          () => Effect.succeed({ stdout: "" }),
        ),
        Effect.mapError(
          () => new LinxSecretStoreError({ operation: "remove", category: "keychain" }),
        ),
      );
    });

    return SecretStore.of({ put, resolve, remove });
  }),
);

const unsupportedLayer = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    yield* Effect.void;
    const fail = (operation: "put" | "resolve" | "remove") =>
      new LinxSecretStoreError({ operation, category: "unsupported-platform" });
    const put = Effect.fn("SecretStore.unsupported.put")(function* () {
      return yield* fail("put");
    });
    const resolve = Effect.fn("SecretStore.unsupported.resolve")(function* () {
      return yield* fail("resolve");
    });
    const remove = Effect.fn("SecretStore.unsupported.remove")(function* () {
      return yield* fail("remove");
    });
    return SecretStore.of({ put, resolve, remove });
  }),
);

export const layer =
  HostProcess.Platform.defaultValue() === "darwin" && NodeFS.existsSync(SECURITY_BINARY)
    ? keychainLayer
    : unsupportedLayer;

/** Test-only backend; values stay in this process and are never persisted. */
export const layerMemory = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const secrets = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    const put = Effect.fn("SecretStore.memory.put")(function* (value: string) {
      const account = NodeCrypto.randomUUID();
      const reference = `memory:${account}`;
      yield* Ref.update(secrets, (current) => new Map(current).set(reference, value));
      return reference;
    });
    const resolve = Effect.fn("SecretStore.memory.resolve")(function* (reference: string) {
      return (yield* Ref.get(secrets)).get(reference) ?? null;
    });
    const remove = Effect.fn("SecretStore.memory.remove")(function* (reference: string) {
      yield* Ref.update(secrets, (current) => {
        const next = new Map(current);
        next.delete(reference);
        return next;
      });
    });
    return SecretStore.of({ put, resolve, remove });
  }),
);
