// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeCrypto from "node:crypto";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
  LinxWsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Socket } from "effect/socket";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

const [originArg, projectArg, model, instance = "codex"] = process.argv.slice(2);
const credential = process.env.T3CODE_DEV_AUTH_TOKEN;
if (
  originArg === undefined ||
  projectArg === undefined ||
  !credential ||
  (projectArg !== "--snapshot-only" && !model)
) {
  throw new Error(
    "Usage: T3CODE_DEV_AUTH_TOKEN=… node scripts/linx/launch-expert.ts <loopback-origin> <project-id> <model> [provider-instance], or <loopback-origin> --snapshot-only",
  );
}
const origin = new URL(originArg);
if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) {
  throw new Error("Use the isolated local dev server; the dev credential must not leave loopback.");
}

const readTicket = HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }));
const readDescriptor = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ environmentId: EnvironmentId }),
);

class LinxDevAuthError extends Schema.TaggedError<LinxDevAuthError>()("LinxDevAuthError", {
  message: Schema.String,
}) {}

const report = await Effect.runPromise(
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(new URL("/api/auth/browser-session", origin), {
        headers: { Origin: origin.origin },
      }).pipe(HttpClientRequest.bodyJsonUnsafe({ credential })),
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        () =>
          new LinxDevAuthError({ message: "Dev sign-in failed. Check the dev server and token." }),
      ),
    );
    const { ticket } = yield* HttpClient.post(new URL("/api/auth/websocket-ticket", origin), {
      headers: { Cookie: Cookies.toCookieHeader(response.cookies), Origin: origin.origin },
    }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(readTicket),
      Effect.mapError(
        () =>
          new LinxDevAuthError({ message: "The dev session could not obtain a WebSocket ticket." }),
      ),
    );
    const socket = new URL("/ws", origin);
    socket.protocol = "ws:";
    socket.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
    socket.searchParams.set("wsTicket", ticket);
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(socket.toString())),
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(NodeWS.layerWebSocketConstructor),
      ),
    );
    const client = yield* RpcClient.make(LinxWsRpcGroup).pipe(Effect.provideContext(protocol));
    const snapshot = yield* client[WS_METHODS.linxExpertsCreateSnapshot]({
      expertId: "linx-context-verifier",
      revision: 1,
      persona:
        "When asked to verify this context, call linx_expert_context and report its snapshotId and contentHash exactly.",
      references: [],
      skillSelection: [],
      mcpGrants: [],
      connectionRevisions: {},
    });
    const snapshotReport = { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash };
    if (projectArg === "--snapshot-only" || model === undefined) return snapshotReport;
    const result = yield* client[WS_METHODS.linxThreadsLaunch]({
      clientRequestId: NodeCrypto.randomUUID(),
      snapshotId: snapshot.snapshotId,
      projectId: ProjectId.make(projectArg),
      title: "Verify frozen Expert context",
      modelSelection: { instanceId: ProviderInstanceId.make(instance), model },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        text: "Call linx_expert_context now. Report the snapshotId and contentHash directly from the tool output. Do not read files or use other tools.",
      },
    });
    const descriptor = yield* HttpClient.get(new URL("/.well-known/t3/environment", origin)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(readDescriptor),
    );
    return {
      ...snapshotReport,
      threadUrl: new URL(
        `/${encodeURIComponent(descriptor.environmentId)}/${encodeURIComponent(result.threadId)}`,
        origin,
      ).toString(),
    };
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.timeout("30 seconds")),
);
console.log(JSON.stringify(report));
