// @effect-diagnostics nodeBuiltinImport:off - the test runs a real local MCP endpoint.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { layer as linxSqliteLayer } from "../persistence/LinxSqlite.ts";
import { runLinxMigrations } from "../persistence/Migrations.ts";
import { SecretStore, layerMemory as secretStoreMemory } from "../secret/SecretStore.ts";
import { ExternalMcpClient, layer as externalMcpLayer } from "./ExternalMcpClient.ts";
import { McpConnectionService, layer as connectionLayer } from "./McpConnectionService.ts";

class MockServerStartError extends Schema.TaggedError<MockServerStartError>()(
  "MockServerStartError",
  { cause: Schema.Defect() },
) {}

const ECHO_TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const startServer = (
  tools: ReadonlyArray<unknown>,
  options: { readonly acceptedTokens?: ReadonlyArray<string> } = {},
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => {
        const { promise, resolve, reject } = Promise.withResolvers<{
          endpoint: string;
          close: () => Promise<void>;
          calls: () => number;
        }>();
        {
          let calls = 0;
          const server = NodeHttp.createServer((request, response) => {
            if (
              options.acceptedTokens !== undefined &&
              !options.acceptedTokens.includes(
                (request.headers.authorization ?? "").replace(/^Bearer /, ""),
              )
            ) {
              response.writeHead(401).end();
              return;
            }
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                id?: number;
                method?: string;
                params?: { name?: string; arguments?: { text?: string } };
              };
              const reply = (payload: unknown, session = true) => {
                response.writeHead(200, {
                  "content-type": "application/json",
                  ...(session ? { "mcp-session-id": "session-1" } : {}),
                });
                response.end(JSON.stringify(payload));
              };
              if (body.method === "initialize") {
                reply({
                  jsonrpc: "2.0",
                  id: body.id,
                  result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "test-mcp", version: "1" },
                  },
                });
                return;
              }
              if (body.method === "notifications/initialized") {
                response.writeHead(202).end();
                return;
              }
              if (body.method === "tools/list") {
                reply({ jsonrpc: "2.0", id: body.id, result: { tools } });
                return;
              }
              if (body.method === "tools/call") {
                calls += 1;
                reply({
                  jsonrpc: "2.0",
                  id: body.id,
                  result: {
                    content: [{ type: "text", text: body.params?.arguments?.text ?? "" }],
                    structuredContent: { echoed: body.params?.arguments?.text ?? "" },
                    isError: false,
                  },
                });
                return;
              }
              reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
            });
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("no port"));
              return;
            }
            resolve({
              endpoint: `http://127.0.0.1:${address.port}/mcp`,
              close: () => {
                const closed = Promise.withResolvers<void>();
                server.close(() => closed.resolve());
                return closed.promise;
              },
              calls: () => calls,
            });
          });
        }
        return promise;
      },
      catch: (cause) => new MockServerStartError({ cause }),
    }),
    (server) => Effect.promise(() => server.close()),
  );

const withService = <A, E>(
  run: () => Effect.Effect<A, E, McpConnectionService | ExternalMcpClient | SecretStore>,
) =>
  Effect.gen(function* () {
    yield* runLinxMigrations;
    return yield* run();
  }).pipe(
    Effect.provide(
      Layer.merge(
        connectionLayer.pipe(
          Layer.provideMerge(externalMcpLayer),
          Layer.provideMerge(secretStoreMemory),
        ),
        Layer.merge(externalMcpLayer, secretStoreMemory),
      ).pipe(Layer.provideMerge(linxSqliteLayer(":memory:")), Layer.provide(NodeServices.layer)),
    ),
  );

it.live("saves a frozen tool catalog, revises it, and disables it", () =>
  Effect.gen(function* () {
    const server = yield* startServer(ECHO_TOOLS);
    return yield* withService(() =>
      Effect.gen(function* () {
        const connections = yield* McpConnectionService;
        const tested = yield* connections.test({ endpoint: server.endpoint });
        assert.deepEqual(
          tested.tools.map((tool) => tool.name),
          ["echo"],
        );

        const created = yield* connections.save({
          name: "Test MCP",
          endpoint: server.endpoint,
          authMode: "none",
        });
        assert.equal(created.currentRevision, 1);
        assert.equal(created.tools.length, 1);
        assert.equal(created.disabled, false);

        const renamed = yield* connections.save({
          connectionId: created.connectionId,
          expectedRevision: 1,
          name: "Renamed MCP",
          endpoint: server.endpoint,
          authMode: "keep",
        });
        assert.equal(renamed.currentRevision, 1);
        assert.equal(renamed.name, "Renamed MCP");

        const disabled = yield* connections.disable(created.connectionId, 1);
        assert.equal(disabled.disabled, true);
        const resolved = yield* connections.resolveRevision(created.connectionId, 1);
        assert.equal(resolved?.disabled, true);
        assert.equal(resolved?.tools[0]?.name, "echo");
      }),
    );
  }).pipe(Effect.scoped),
);

it.live("does not expand frozen read-only grants and revokes them for every revision", () =>
  Effect.gen(function* () {
    const server = yield* startServer(ECHO_TOOLS);
    return yield* withService(() =>
      Effect.gen(function* () {
        const connections = yield* McpConnectionService;
        const input = { name: "Test MCP", endpoint: server.endpoint, authMode: "none" } as const;
        const prior = yield* connections.save(input);
        const classified = yield* connections.save({
          ...input,
          connectionId: prior.connectionId,
          expectedRevision: prior.currentRevision,
          readOnlyTools: ["echo"],
        });
        assert.equal(classified.currentRevision, 2);
        assert.deepEqual(
          (yield* connections.resolveRevision(prior.connectionId, 1))?.readOnlyTools,
          [],
        );
        assert.deepEqual(
          (yield* connections.resolveRevision(prior.connectionId, 2))?.readOnlyTools,
          ["echo"],
        );
        yield* connections.save({
          ...input,
          connectionId: prior.connectionId,
          expectedRevision: classified.currentRevision,
          readOnlyTools: [],
        });
        assert.deepEqual(
          (yield* connections.resolveRevision(prior.connectionId, 2))?.readOnlyTools,
          [],
        );
      }),
    );
  }).pipe(Effect.scoped),
);

it.live("rejects non-loopback http and credentials in the endpoint", () =>
  withService(() =>
    Effect.gen(function* () {
      const connections = yield* McpConnectionService;
      const plain = yield* Effect.flip(connections.test({ endpoint: "http://example.com/mcp" }));
      assert.equal(plain._tag, "LinxMcpTransportError");
      assert.equal(plain.category, "http-requires-loopback");
      const credentials = yield* Effect.flip(
        connections.test({ endpoint: "http://user:pass@127.0.0.1:9/mcp" }),
      );
      assert.equal(credentials.category, "credentials-in-url");
    }),
  ),
);

it.live("resolves a frozen revision and reads its endpoint", () =>
  Effect.gen(function* () {
    const server = yield* startServer(ECHO_TOOLS);
    return yield* withService(() =>
      Effect.gen(function* () {
        const connections = yield* McpConnectionService;
        const created = yield* connections.save({
          name: "Test MCP",
          endpoint: server.endpoint,
          authMode: "none",
        });
        const resolved = yield* connections.resolveRevision(created.connectionId, 1);
        assert.equal(resolved?.endpoint, server.endpoint);
        assert.equal(resolved?.tools[0]?.schemaHash.length, 64);
        const missing = yield* connections.resolveRevision(created.connectionId, 9);
        assert.equal(missing, null);
      }),
    );
  }).pipe(Effect.scoped),
);

it.live("stores only a bearer reference, rotates it, and deletes it on disable", () =>
  Effect.gen(function* () {
    const token = "linex-test-token-42";
    const server = yield* startServer(ECHO_TOOLS, {
      acceptedTokens: [token, "linex-test-token-43"],
    });
    return yield* withService(() =>
      Effect.gen(function* () {
        const connections = yield* McpConnectionService;
        const secrets = yield* SecretStore;
        const created = yield* connections.save({
          name: "Auth MCP",
          endpoint: server.endpoint,
          authMode: "bearer",
          bearerToken: token,
        });
        assert.equal(created.authKind, "bearer");
        const first = yield* connections.resolveRevision(created.connectionId, 1);
        assert.equal(first?.authKind, "bearer");
        assert.notEqual(first?.secretRef, null);
        assert.equal(yield* secrets.resolve(first!.secretRef!), token);

        const same = yield* connections.save({
          connectionId: created.connectionId,
          expectedRevision: 1,
          name: "Auth MCP",
          endpoint: server.endpoint,
          authMode: "bearer",
          bearerToken: token,
        });
        assert.equal(same.currentRevision, 1);

        const rotated = yield* connections.save({
          connectionId: created.connectionId,
          expectedRevision: 1,
          name: "Auth MCP",
          endpoint: server.endpoint,
          authMode: "bearer",
          bearerToken: "linex-test-token-43",
        });
        assert.equal(rotated.currentRevision, 2);
        assert.equal(yield* secrets.resolve(first!.secretRef!), null);

        const second = yield* connections.resolveRevision(created.connectionId, 2);
        assert.equal(yield* secrets.resolve(second!.secretRef!), "linex-test-token-43");
        yield* connections.disable(created.connectionId, 2);
        assert.equal(yield* secrets.resolve(second!.secretRef!), null);
      }),
    );
  }).pipe(Effect.scoped),
);
