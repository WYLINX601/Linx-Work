// @effect-diagnostics nodeBuiltinImport:off - the test runs a real local MCP endpoint.
import * as NodeHttp from "node:http";

import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import { ExpertSnapshotService } from "../../../linx/expert/ExpertSnapshotService.ts";
import * as LinxStorage from "../../../linx/LinxMcpServices.ts";
import { McpConnectionService } from "../../../linx/mcp/McpConnectionService.ts";
import * as SecretStore from "../../../linx/secret/SecretStore.ts";
import { layer as linxSqliteLayer, LinxSqlClient } from "../../../linx/persistence/LinxSqlite.ts";
import { ThreadBindingRepository } from "../../../linx/thread/ThreadBindingRepository.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type { McpThreadInvocationScope } from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

it.effect(
  "uses only the authenticated thread binding and hides the tool from outside clients",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("linx-test");
      const scope = (id: string): McpThreadInvocationScope => ({
        environmentId,
        requestNamespace: id,
        thread: {
          threadId: ThreadId.make(id),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: id,
          subagent: id.startsWith("child"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      });
      const snapshots = yield* ExpertSnapshotService;
      const bindings = yield* ThreadBindingRepository;
      const stored = new Map<string, string>();
      for (const id of ["parent", "child-a", "child-b"]) {
        const snapshot = yield* snapshots.create({
          expertId: id,
          revision: 1,
          persona: id,
          references: [],
          skillSelection: [],
          mcpGrants: [],
          connectionRevisions: {},
        });
        stored.set(id, snapshot.snapshotId);
        yield* bindings.bindAndEnqueue({
          idempotencyKey: id,
          requestHash: id,
          kind: "launch",
          commandId: id,
          threadId: id,
          projectId: "project",
          snapshotId: snapshot.snapshotId,
          ...(id.startsWith("child") ? { parentThreadId: "parent" } : {}),
        });
      }
      yield* Layer.build(
        HttpRouter.serve(
          McpHttpServer.layerMcpTransport(McpHttpServer.layerLinxExpertContextToolkit).pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(liveThreadsLayer),
            Layer.provide(
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: (token) => Effect.succeed(token === "outside" ? undefined : scope(token)),
              }),
            ),
            Layer.provide(
              Layer.succeed(McpHttpServer.McpClientAuthenticator)({
                authenticate: () =>
                  Effect.succeed({
                    ...scope("outside"),
                    thread: undefined,
                    client: { access: "full-access", sessionId: "outside", label: "outside" },
                  }),
              }),
            ),
          ),
          { disableListenLog: true, disableLogger: true },
        ),
      );
      const http = yield* HttpClient.HttpClient;
      const call = Effect.fn("LinxContextTest.call")(function* (
        id: string,
        method: string,
        params: object,
      ) {
        const headers = {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${id}`,
        };
        const initialize = yield* http.post("/mcp", {
          headers,
          body: HttpBody.jsonUnsafe({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "linx-test", version: "1" },
            },
          }),
        });
        const response = yield* http.post("/mcp", {
          headers: {
            ...headers,
            "mcp-session-id": initialize.headers["mcp-session-id"]!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", id: 2, method, params }),
        });
        return (yield* response.json) as {
          result?: {
            tools?: ReadonlyArray<{ name: string }>;
            structuredContent?: { snapshotId: string; persona: string };
            isError?: boolean;
          };
          error?: unknown;
        };
      });
      const tool = "linx_expert_context";
      for (const id of ["parent", "child-a", "child-b"]) {
        const result = yield* call(id, "tools/call", { name: tool, arguments: {} });
        expect(result).toMatchObject({
          result: { structuredContent: { snapshotId: stored.get(id), persona: id } },
        });
      }
      const forged = yield* call("child-a", "tools/call", {
        name: tool,
        arguments: { threadId: "parent" },
      });
      expect(forged.error).toMatchObject({ code: -32602 });
      for (const id of ["unbound", "child-unbound"]) {
        const result = yield* call(id, "tools/call", { name: tool, arguments: {} });
        expect(result.result?.isError).toBe(true);
        expect(result.result?.structuredContent).toBeUndefined();
      }
      const listed = yield* call("outside", "tools/list", {});
      expect(listed.result?.tools?.map(({ name }) => name)).not.toContain(tool);
      const direct = yield* call("outside", "tools/call", { name: tool, arguments: {} });
      expect(direct.error !== undefined || direct.result?.isError === true).toBe(true);

      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const sql = yield* LinxSqlClient;
        yield* sql`
          UPDATE expert_snapshots
          SET content_json = '{"persona":"tampered"}'
          WHERE snapshot_id = ${stored.get("child-b")!}
        `;
      }).pipe(Effect.provide(linxSqliteLayer(config.linxDbPath)));
      const tampered = yield* call("child-b", "tools/call", { name: tool, arguments: {} });
      expect(tampered.result?.isError).toBe(true);
      expect(tampered.result?.structuredContent).toBeUndefined();
    }).pipe(
      Effect.provide(
        LinxStorage.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "linx-context-http-" }),
          ),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    ),
);

it.effect("lists and calls only the MCP tools granted to the authenticated thread", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("linx-mcp-test");
    const scope = (id: string): McpThreadInvocationScope => ({
      environmentId,
      requestNamespace: id,
      thread: {
        threadId: ThreadId.make(id),
        providerInstanceId: ProviderInstanceId.make("claude"),
        providerSessionId: id,
        subagent: false,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    });
    const tools = [
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
    const started = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          const ready = Promise.withResolvers<{ endpoint: string }>();
          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                id?: number;
                method?: string;
                params?: { arguments?: { text?: unknown } };
              };
              const reply = (payload: unknown) => {
                response.writeHead(200, {
                  "content-type": "application/json",
                  "mcp-session-id": "session-1",
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
                const text = body.params?.arguments?.text;
                reply({
                  jsonrpc: "2.0",
                  id: body.id,
                  result: {
                    content: [{ type: "text", text: String(text ?? "") }],
                    structuredContent: { echoed: text ?? null },
                    isError: false,
                  },
                });
                return;
              }
              reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
            });
          });
          server.once("error", ready.reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              ready.reject(new Error("no port"));
              return;
            }
            ready.resolve({ endpoint: `http://127.0.0.1:${address.port}/mcp` });
          });
          return ready.promise.then((value) => ({ ...value, server }));
        },
        catch: () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The mock MCP server did not start.",
          }),
      }),
      ({ server }) =>
        Effect.promise(
          () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        ),
    );

    const connections = yield* McpConnectionService;
    const created = yield* connections.save({
      name: "Test MCP",
      endpoint: started.endpoint,
      authMode: "none",
    });
    const snapshots = yield* ExpertSnapshotService;
    const bindings = yield* ThreadBindingRepository;
    const snapshot = yield* snapshots.create({
      expertId: "mcp-expert",
      revision: 1,
      persona: "Use the granted MCP tool.",
      references: [],
      skillSelection: [],
      mcpGrants: [{ connectionId: created.connectionId, revision: 1, tools: ["echo"] }],
      connectionRevisions: { [created.connectionId]: 1 },
    });
    yield* bindings.bindAndEnqueue({
      idempotencyKey: "mcp-parent",
      requestHash: "mcp-parent",
      kind: "launch",
      commandId: "mcp-parent",
      threadId: "mcp-parent",
      projectId: "project",
      snapshotId: snapshot.snapshotId,
    });

    yield* Layer.build(
      HttpRouter.serve(
        McpHttpServer.layerMcpTransport(McpHttpServer.layerLinxMcpToolkit).pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(liveThreadsLayer),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) => Effect.succeed(token === "outside" ? undefined : scope(token)),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator)({
              authenticate: () =>
                Effect.succeed({
                  ...scope("outside"),
                  thread: undefined,
                  client: { access: "full-access", sessionId: "outside", label: "outside" },
                }),
            }),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ),
    );
    const http = yield* HttpClient.HttpClient;
    const call = Effect.fn("LinxMcpTest.call")(function* (
      id: string,
      method: string,
      params: object,
    ) {
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${id}`,
      };
      const initialize = yield* http.post("/mcp", {
        headers,
        body: HttpBody.jsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "linx-test", version: "1" },
          },
        }),
      });
      const response = yield* http.post("/mcp", {
        headers: {
          ...headers,
          "mcp-session-id": initialize.headers["mcp-session-id"]!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", id: 2, method, params }),
      });
      return (yield* response.json) as {
        result?: {
          structuredContent?: {
            connections?: ReadonlyArray<{ tools: ReadonlyArray<{ name: string }> }>;
            tool?: string;
            text?: string;
          };
          isError?: boolean;
        };
        error?: unknown;
      };
    });

    const listed = yield* call("mcp-parent", "tools/call", {
      name: "linx_mcp_list_tools",
      arguments: {},
    });
    expect(listed.result?.structuredContent?.connections?.[0]?.tools).toEqual([
      { name: "echo", description: "Echo the text back." },
    ]);

    const echoed = yield* call("mcp-parent", "tools/call", {
      name: "linx_mcp_call",
      arguments: { connectionId: created.connectionId, tool: "echo", arguments: { text: "hi" } },
    });
    expect(echoed.result?.structuredContent).toMatchObject({
      tool: "echo",
      text: "hi",
      isError: false,
    });

    const invalid = yield* call("mcp-parent", "tools/call", {
      name: "linx_mcp_call",
      arguments: { connectionId: created.connectionId, tool: "echo", arguments: { text: 1 } },
    });
    expect(invalid.result?.isError).toBe(true);

    const ungranted = yield* call("mcp-parent", "tools/call", {
      name: "linx_mcp_call",
      arguments: { connectionId: "other", tool: "echo", arguments: { text: "hi" } },
    });
    expect(ungranted.result?.isError).toBe(true);
  }).pipe(
    Effect.provide(
      LinxStorage.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "linx-mcp-http-" })),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    ),
  ),
);

it.effect("discards credential echoes and fails closed after the connection is disabled", () =>
  Effect.gen(function* () {
    const token = "credential-42";
    const environmentId = EnvironmentId.make("linx-mcp-auth-test");
    const scope = (id: string): McpThreadInvocationScope => ({
      environmentId,
      requestNamespace: id,
      thread: {
        threadId: ThreadId.make(id),
        providerInstanceId: ProviderInstanceId.make("claude"),
        providerSessionId: id,
        subagent: false,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    });
    const tools = [
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
      {
        name: "leak",
        description: "Return the credential.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    const started = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          const ready = Promise.withResolvers<{ endpoint: string }>();
          const server = NodeHttp.createServer((request, response) => {
            if (request.headers.authorization !== `Bearer ${token}`) {
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
              const reply = (payload: unknown) => {
                response.writeHead(200, {
                  "content-type": "application/json",
                  "mcp-session-id": "session-auth",
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
                    serverInfo: { name: "auth-mcp", version: "1" },
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
                const text =
                  body.params?.name === "leak" ? token : String(body.params?.arguments?.text ?? "");
                reply({
                  jsonrpc: "2.0",
                  id: body.id,
                  result: {
                    content: [{ type: "text", text }],
                    structuredContent: { value: text },
                    isError: false,
                  },
                });
                return;
              }
              reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown" } });
            });
          });
          server.once("error", ready.reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              ready.reject(new Error("no port"));
              return;
            }
            ready.resolve({ endpoint: `http://127.0.0.1:${address.port}/mcp` });
          });
          return ready.promise.then((value) => ({ ...value, server }));
        },
        catch: () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The mock MCP server did not start.",
          }),
      }),
      ({ server }) =>
        Effect.promise(
          () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        ),
    );

    const connections = yield* McpConnectionService;
    const created = yield* connections.save({
      name: "Auth MCP",
      endpoint: started.endpoint,
      authMode: "bearer",
      bearerToken: token,
    });
    const snapshots = yield* ExpertSnapshotService;
    const bindings = yield* ThreadBindingRepository;
    const snapshot = yield* snapshots.create({
      expertId: "auth-expert",
      revision: 1,
      persona: "Use the granted tools.",
      references: [],
      skillSelection: [],
      mcpGrants: [{ connectionId: created.connectionId, revision: 1, tools: ["echo", "leak"] }],
      connectionRevisions: { [created.connectionId]: 1 },
    });
    yield* bindings.bindAndEnqueue({
      idempotencyKey: "auth-parent",
      requestHash: "auth-parent",
      kind: "launch",
      commandId: "auth-parent",
      threadId: "auth-parent",
      projectId: "project",
      snapshotId: snapshot.snapshotId,
    });

    yield* Layer.build(
      HttpRouter.serve(
        McpHttpServer.layerMcpTransport(McpHttpServer.layerLinxMcpToolkit).pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(liveThreadsLayer),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (value) => Effect.succeed(value === "outside" ? undefined : scope(value)),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator)({
              authenticate: () =>
                Effect.succeed({
                  ...scope("outside"),
                  thread: undefined,
                  client: { access: "full-access", sessionId: "outside", label: "outside" },
                }),
            }),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ),
    );
    const http = yield* HttpClient.HttpClient;
    const call = Effect.fn("LinxMcpAuthTest.call")(function* (method: string, params: object) {
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: "Bearer auth-parent",
      };
      const initialize = yield* http.post("/mcp", {
        headers,
        body: HttpBody.jsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "linx-test", version: "1" },
          },
        }),
      });
      const response = yield* http.post("/mcp", {
        headers: {
          ...headers,
          "mcp-session-id": initialize.headers["mcp-session-id"]!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", id: 2, method, params }),
      });
      return (yield* response.json) as {
        result?: { structuredContent?: { text?: string }; isError?: boolean };
        error?: unknown;
      };
    });

    const leaked = yield* call("tools/call", {
      name: "linx_mcp_call",
      arguments: { connectionId: created.connectionId, tool: "leak", arguments: {} },
    });
    expect(leaked.result?.isError).toBe(true);
    expect(JSON.stringify(leaked.result?.structuredContent ?? {})).not.toContain(token);

    const echoed = yield* call("tools/call", {
      name: "linx_mcp_call",
      arguments: { connectionId: created.connectionId, tool: "echo", arguments: { text: "ok" } },
    });
    expect(echoed.result?.structuredContent?.text).toBe("ok");

    yield* connections.disable(created.connectionId, 1);
    const revoked = yield* call("tools/call", {
      name: "linx_mcp_call",
      arguments: { connectionId: created.connectionId, tool: "echo", arguments: { text: "ok" } },
    });
    expect(revoked.result?.isError).toBe(true);
  }).pipe(
    Effect.provide(
      LinxStorage.layerWithSecrets(SecretStore.layerMemory).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "linx-mcp-auth-http-" }),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    ),
  ),
);
