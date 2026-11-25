// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - endpoint checks resolve DNS and JSON holds our own tool catalog.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlError from "effect/sql/SqlError";

import type {
  LinxMcpConnectionDetail,
  LinxMcpConnectionSummary,
  LinxMcpTool,
  LinxSaveMcpConnectionInput,
  LinxTestMcpConnectionInput,
} from "@t3tools/contracts";

import {
  LinxDependencyMissingError,
  LinxDefinitionMissingError,
  LinxMcpTransportError,
  LinxRevisionConflictError,
  LinxSecretStoreError,
  LinxStorageError,
} from "../persistence/Errors.ts";
import { LinxSqlClient } from "../persistence/LinxSqlite.ts";
import { SecretStore } from "../secret/SecretStore.ts";
import { ExternalMcpClient, type ExternalMcpTool } from "./ExternalMcpClient.ts";

interface ConnectionRow {
  readonly connection_id: string;
  readonly name: string;
  readonly current_revision: number;
  readonly disabled_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionRow {
  readonly connection_id: string;
  readonly revision: number;
  readonly endpoint: string;
  readonly config_hash: string;
  readonly tools_json: string;
  readonly auth_kind: "none" | "bearer";
  readonly secret_ref: string | null;
  readonly created_at: string;
}

export interface ResolvedMcpConnection {
  readonly connectionId: string;
  readonly name: string;
  readonly revision: number;
  readonly endpoint: string;
  readonly authKind: "none" | "bearer";
  readonly secretRef: string | null;
  readonly disabled: boolean;
  readonly tools: ReadonlyArray<ExternalMcpTool>;
}

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "[::1]";

const isPrivateV4 = (address: string): boolean => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const isPrivateV6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return true;
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped !== null && isPrivateV4(mapped[1]!);
};

const isPrivateAddress = (address: string): boolean =>
  address.includes(":") ? isPrivateV6(address) : isPrivateV4(address);

const validateMcpEndpoint = Effect.fn("validateMcpEndpoint")(function* (raw: string) {
  const failure = (category: string) =>
    Effect.fail(new LinxMcpTransportError({ endpoint: raw, category }));
  const url = yield* Effect.try({
    try: () => new URL(raw),
    catch: () => new LinxMcpTransportError({ endpoint: raw, category: "invalid-url" }),
  });
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return yield* failure("unsupported-protocol");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return yield* failure("credentials-in-url");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return yield* failure("query-not-supported");
  }
  if (url.pathname.length > 512) return yield* failure("path-too-long");
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    return yield* failure("http-requires-loopback");
  }
  if (!loopback) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = yield* Effect.tryPromise({
      try: () => NodeDnsPromises.lookup(host, { all: true }),
      catch: () => new LinxMcpTransportError({ endpoint: raw, category: "dns" }),
    });
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      return yield* failure("private-address");
    }
  }
  const path = url.pathname.length === 0 ? "/" : url.pathname.replace(/\/+$/, "") || "/";
  return `${url.protocol}//${url.host}${path}`;
});

const toTools = (row: RevisionRow): ReadonlyArray<ExternalMcpTool> =>
  JSON.parse(row.tools_json) as ReadonlyArray<ExternalMcpTool>;

const toContractTools = (tools: ReadonlyArray<ExternalMcpTool>): ReadonlyArray<LinxMcpTool> =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schemaHash: tool.schemaHash,
  }));

const summarize = (row: ConnectionRow, revision: RevisionRow): LinxMcpConnectionSummary => ({
  connectionId: row.connection_id,
  name: row.name,
  endpoint: revision.endpoint,
  authKind: revision.auth_kind,
  currentRevision: row.current_revision,
  disabled: row.disabled_at !== null,
  updatedAt: row.updated_at,
  toolCount: toTools(revision).length,
});

const detailFrom = (row: ConnectionRow, revision: RevisionRow): LinxMcpConnectionDetail => ({
  ...summarize(row, revision),
  tools: toContractTools(toTools(revision)),
});

const configHashFor = (
  endpoint: string,
  tools: ReadonlyArray<ExternalMcpTool>,
  authKind: "none" | "bearer",
  token: string | undefined,
): string =>
  sha256(
    canonicalJson({
      endpoint,
      authKind,
      secretHash: token === undefined ? null : sha256(token),
      tools: tools.map((tool) => ({ name: tool.name, schemaHash: tool.schemaHash })),
    }),
  );

export class McpConnectionService extends Context.Service<
  McpConnectionService,
  {
    readonly test: (
      input: LinxTestMcpConnectionInput,
    ) => Effect.Effect<
      { readonly endpoint: string; readonly tools: ReadonlyArray<LinxMcpTool> },
      LinxMcpTransportError | LinxDependencyMissingError | LinxSecretStoreError
    >;
    readonly save: (
      input: LinxSaveMcpConnectionInput,
    ) => Effect.Effect<
      LinxMcpConnectionDetail,
      | LinxDefinitionMissingError
      | LinxDependencyMissingError
      | LinxRevisionConflictError
      | LinxMcpTransportError
      | LinxSecretStoreError
      | LinxStorageError
      | SqlError.SqlError
    >;
    readonly list: () => Effect.Effect<
      ReadonlyArray<LinxMcpConnectionSummary>,
      LinxStorageError | SqlError.SqlError
    >;
    readonly get: (
      connectionId: string,
    ) => Effect.Effect<LinxMcpConnectionDetail | null, LinxStorageError | SqlError.SqlError>;
    readonly disable: (
      connectionId: string,
      expectedRevision: number,
    ) => Effect.Effect<
      LinxMcpConnectionSummary,
      LinxDefinitionMissingError | LinxRevisionConflictError | LinxStorageError | SqlError.SqlError
    >;
    readonly resolveRevision: (
      connectionId: string,
      revision: number,
    ) => Effect.Effect<ResolvedMcpConnection | null, LinxStorageError | SqlError.SqlError>;
  }
>()("t3/linx/mcp/McpConnectionService") {}

export const layer = Layer.effect(
  McpConnectionService,
  Effect.gen(function* () {
    const sql = yield* LinxSqlClient;
    const client = yield* ExternalMcpClient;
    const secrets = yield* SecretStore;

    const selectConnection = (connectionId: string) =>
      sql<ConnectionRow>`
        SELECT connection_id, name, current_revision, disabled_at, created_at, updated_at
        FROM mcp_connections WHERE connection_id = ${connectionId}
      `;

    const selectRevision = (connectionId: string, revision: number) =>
      sql<RevisionRow>`
        SELECT connection_id, revision, endpoint, config_hash, tools_json, auth_kind,
               secret_ref, created_at
        FROM mcp_connection_revisions
        WHERE connection_id = ${connectionId} AND revision = ${revision}
      `;

    const authFor = Effect.fn("McpConnectionService.authFor")(function* (
      input: LinxSaveMcpConnectionInput,
      current: RevisionRow | undefined,
    ) {
      const mode = input.authMode;
      if (mode === "none") {
        return {
          authKind: "none" as const,
          secretRef: null,
          token: undefined,
          createdRef: null,
        };
      }
      if (mode === "keep") {
        if (current !== undefined && current.auth_kind === "none") {
          return {
            authKind: "none" as const,
            secretRef: null,
            token: undefined,
            createdRef: null,
          };
        }
        if (
          current === undefined ||
          current.auth_kind !== "bearer" ||
          current.secret_ref === null
        ) {
          return yield* new LinxDependencyMissingError({
            entity: "mcp connection",
            id: input.connectionId ?? "new",
            category: "no-token-to-keep",
          });
        }
        const token = yield* secrets.resolve(current.secret_ref).pipe(
          Effect.mapError(
            () =>
              new LinxDependencyMissingError({
                entity: "mcp secret",
                id: current.secret_ref ?? "unknown",
                category: "secret-store",
              }),
          ),
        );
        if (token === null) {
          return yield* new LinxDependencyMissingError({
            entity: "mcp secret",
            id: current.secret_ref,
            category: "missing",
          });
        }
        return {
          authKind: "bearer" as const,
          secretRef: current.secret_ref,
          token,
          createdRef: null,
        };
      }
      if (input.bearerToken === undefined) {
        return yield* new LinxDependencyMissingError({
          entity: "mcp connection",
          id: input.connectionId ?? "new",
          category: "bearer-token-required",
        });
      }
      if (current?.auth_kind === "bearer" && current.secret_ref !== null) {
        const existing = yield* secrets
          .resolve(current.secret_ref)
          .pipe(Effect.orElseSucceed(() => null));
        if (existing === input.bearerToken) {
          return {
            authKind: "bearer" as const,
            secretRef: current.secret_ref,
            token: existing,
            createdRef: null,
          };
        }
      }
      const reference = yield* secrets.put(input.bearerToken);
      return {
        authKind: "bearer" as const,
        secretRef: reference,
        token: input.bearerToken,
        createdRef: reference,
      };
    });

    const test = Effect.fn("McpConnectionService.test")(function* (
      input: LinxTestMcpConnectionInput,
    ) {
      const endpoint = yield* validateMcpEndpoint(input.endpoint);
      const authMode = input.authMode ?? "none";
      if (authMode === "bearer" && input.bearerToken === undefined) {
        return yield* new LinxDependencyMissingError({
          entity: "mcp connection",
          id: "test",
          category: "bearer-token-required",
        });
      }
      const tools = yield* client.listTools(endpoint, input.bearerToken);
      return { endpoint, tools: toContractTools(tools) };
    });

    const save = Effect.fn("McpConnectionService.save")(function* (
      input: LinxSaveMcpConnectionInput,
    ) {
      const endpoint = yield* validateMcpEndpoint(input.endpoint);
      const name = input.name.trim();
      const existing =
        input.connectionId === undefined
          ? undefined
          : (yield* selectConnection(input.connectionId))[0];
      if (input.connectionId !== undefined && existing === undefined) {
        return yield* new LinxDefinitionMissingError({
          entity: "mcp connection",
          id: input.connectionId,
        });
      }
      const currentRevision =
        existing === undefined
          ? undefined
          : (yield* selectRevision(existing.connection_id, existing.current_revision))[0];
      if (input.connectionId !== undefined && currentRevision === undefined) {
        return yield* new LinxStorageError({
          operation: "query",
          entity: "mcp_connection_revisions",
          category: "current-revision-missing",
        });
      }
      if (
        existing !== undefined &&
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.current_revision
      ) {
        return yield* new LinxRevisionConflictError({
          entity: "mcp connection",
          expectedRevision: input.expectedRevision,
          actualRevision: existing.current_revision,
        });
      }

      const auth = yield* authFor(input, currentRevision);
      const catalog = yield* client.listTools(endpoint, auth.token).pipe(
        Effect.mapError((error) => error),
        Effect.tapError(() =>
          auth.createdRef === null
            ? Effect.void
            : secrets.remove(auth.createdRef).pipe(Effect.ignore),
        ),
      );
      const configHash = configHashFor(endpoint, catalog, auth.authKind, auth.token);
      const toolsJson = JSON.stringify(catalog);

      if (existing === undefined) {
        const connectionId = `mcp_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
        const outcome = yield* Effect.result(
          sql.withTransaction(
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
                INSERT INTO mcp_connections
                  (connection_id, name, transport, current_revision, disabled_at,
                   revoked_generation, created_at, updated_at)
                VALUES (${connectionId}, ${name}, 'streamable-http', 1, NULL, 0, ${now}, ${now})
              `;
              yield* sql`
                INSERT INTO mcp_connection_revisions
                  (connection_id, revision, endpoint, config_hash, tools_json, auth_kind,
                   secret_ref, created_at)
                VALUES (${connectionId}, 1, ${endpoint}, ${configHash}, ${toolsJson},
                        ${auth.authKind}, ${auth.secretRef}, ${now})
              `;
              const row = (yield* selectConnection(connectionId))[0];
              const revision = (yield* selectRevision(connectionId, 1))[0];
              if (row === undefined || revision === undefined) {
                return yield* new LinxStorageError({
                  operation: "read",
                  entity: "mcp_connections",
                  category: "missing-after-insert",
                });
              }
              return detailFrom(row, revision);
            }),
          ),
        );
        if (outcome._tag === "Failure") {
          if (auth.createdRef !== null) {
            yield* secrets.remove(auth.createdRef).pipe(Effect.ignore);
          }
          return yield* outcome.failure;
        }
        return outcome.success;
      }

      const connectionId = existing.connection_id;
      const previousRevision = currentRevision!;
      const outcome = yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = (yield* selectConnection(connectionId))[0];
            if (row === undefined) {
              return yield* new LinxDefinitionMissingError({
                entity: "mcp connection",
                id: connectionId,
              });
            }
            if (row.current_revision !== previousRevision.revision) {
              return yield* new LinxRevisionConflictError({
                entity: "mcp connection",
                expectedRevision: previousRevision.revision,
                actualRevision: row.current_revision,
              });
            }
            const now = DateTime.formatIso(yield* DateTime.now);
            if (previousRevision.config_hash === configHash) {
              yield* sql`
                UPDATE mcp_connections
                SET name = ${name}, disabled_at = NULL, updated_at = ${now}
                WHERE connection_id = ${connectionId}
              `;
              const fresh = (yield* selectConnection(connectionId))[0];
              if (fresh === undefined) {
                return yield* new LinxStorageError({
                  operation: "read",
                  entity: "mcp_connections",
                  category: "missing-after-update",
                });
              }
              return detailFrom(fresh, previousRevision);
            }
            const nextRevision = row.current_revision + 1;
            yield* sql`
              INSERT INTO mcp_connection_revisions
                (connection_id, revision, endpoint, config_hash, tools_json, auth_kind,
                 secret_ref, created_at)
              VALUES (${connectionId}, ${nextRevision}, ${endpoint}, ${configHash},
                      ${toolsJson}, ${auth.authKind}, ${auth.secretRef}, ${now})
            `;
            const updated = yield* sql<{ readonly revision: number }>`
              UPDATE mcp_connections
              SET name = ${name}, current_revision = ${nextRevision}, disabled_at = NULL,
                  updated_at = ${now}
              WHERE connection_id = ${connectionId} AND current_revision = ${row.current_revision}
              RETURNING current_revision AS revision
            `;
            if (updated.length === 0) {
              return yield* new LinxRevisionConflictError({
                entity: "mcp connection",
                expectedRevision: row.current_revision,
                actualRevision: row.current_revision,
              });
            }
            const fresh = (yield* selectConnection(connectionId))[0];
            const revision = (yield* selectRevision(connectionId, nextRevision))[0];
            if (fresh === undefined || revision === undefined) {
              return yield* new LinxStorageError({
                operation: "read",
                entity: "mcp_connections",
                category: "missing-after-update",
              });
            }
            return detailFrom(fresh, revision);
          }),
        ),
      );
      if (outcome._tag === "Failure") {
        if (auth.createdRef !== null) {
          yield* secrets.remove(auth.createdRef).pipe(Effect.ignore);
        }
        return yield* outcome.failure;
      }
      const oldSecret =
        previousRevision.auth_kind === "bearer" ? previousRevision.secret_ref : null;
      if (oldSecret !== null && oldSecret !== auth.secretRef) {
        yield* secrets.remove(oldSecret).pipe(Effect.ignore);
      }
      yield* client.forget(previousRevision.endpoint);
      yield* client.forget(endpoint);
      return outcome.success;
    });

    const list = Effect.fn("McpConnectionService.list")(function* () {
      const rows = yield* sql<
        ConnectionRow & {
          readonly endpoint: string;
          readonly auth_kind: "none" | "bearer";
          readonly tools_json: string;
        }
      >`
        SELECT c.connection_id, c.name, c.current_revision, c.disabled_at, c.created_at,
               c.updated_at, r.endpoint, r.auth_kind, r.tools_json
        FROM mcp_connections AS c
        INNER JOIN mcp_connection_revisions AS r
          ON r.connection_id = c.connection_id AND r.revision = c.current_revision
        ORDER BY c.name, c.connection_id
      `;
      return rows.map((row) => ({
        connectionId: row.connection_id,
        name: row.name,
        endpoint: row.endpoint,
        authKind: row.auth_kind,
        currentRevision: row.current_revision,
        disabled: row.disabled_at !== null,
        updatedAt: row.updated_at,
        toolCount: (JSON.parse(row.tools_json) as ReadonlyArray<unknown>).length,
      }));
    });

    const get = Effect.fn("McpConnectionService.get")(function* (connectionId: string) {
      const row = (yield* selectConnection(connectionId))[0];
      if (row === undefined) return null;
      const revision = (yield* selectRevision(connectionId, row.current_revision))[0];
      if (revision === undefined) {
        return yield* new LinxStorageError({
          operation: "query",
          entity: "mcp_connection_revisions",
          category: "current-revision-missing",
        });
      }
      return detailFrom(row, revision);
    });

    const disable = Effect.fn("McpConnectionService.disable")(function* (
      connectionId: string,
      expectedRevision: number,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* sql<{ readonly revision: number }>`
        UPDATE mcp_connections
        SET disabled_at = ${now}, updated_at = ${now},
            revoked_generation = revoked_generation + 1
        WHERE connection_id = ${connectionId} AND current_revision = ${expectedRevision}
        RETURNING current_revision AS revision
      `;
      if (updated.length === 0) {
        const row = (yield* selectConnection(connectionId))[0];
        if (row === undefined) {
          return yield* new LinxDefinitionMissingError({
            entity: "mcp connection",
            id: connectionId,
          });
        }
        return yield* new LinxRevisionConflictError({
          entity: "mcp connection",
          expectedRevision,
          actualRevision: row.current_revision,
        });
      }
      const row = (yield* selectConnection(connectionId))[0];
      const revision = (yield* selectRevision(connectionId, expectedRevision))[0];
      if (row === undefined || revision === undefined) {
        return yield* new LinxStorageError({
          operation: "read",
          entity: "mcp_connections",
          category: "missing-after-disable",
        });
      }
      yield* client.forget(revision.endpoint);
      if (revision.secret_ref !== null) {
        yield* secrets.remove(revision.secret_ref).pipe(Effect.ignore);
      }
      return summarize(row, revision);
    });

    const resolveRevision = Effect.fn("McpConnectionService.resolveRevision")(function* (
      connectionId: string,
      revision: number,
    ) {
      const row = (yield* selectConnection(connectionId))[0];
      if (row === undefined) return null;
      const selected = (yield* selectRevision(connectionId, revision))[0];
      if (selected === undefined) return null;
      return {
        connectionId: row.connection_id,
        name: row.name,
        revision: selected.revision,
        endpoint: selected.endpoint,
        authKind: selected.auth_kind,
        secretRef: selected.secret_ref,
        disabled: row.disabled_at !== null,
        tools: toTools(selected),
      } satisfies ResolvedMcpConnection;
    });

    return McpConnectionService.of({
      test,
      save,
      list,
      get,
      disable,
      resolveRevision,
    });
  }),
);
