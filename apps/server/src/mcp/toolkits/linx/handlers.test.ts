import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import { ExpertSnapshotService } from "../../../linx/expert/ExpertSnapshotService.ts";
import * as LinxStorage from "../../../linx/LinxMcpServices.ts";
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
