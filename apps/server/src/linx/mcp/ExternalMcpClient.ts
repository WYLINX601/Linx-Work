// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off globalFetchInEffect:off - MCP needs manual redirects, bounded body reads, and typed parsing.
// @effect-diagnostics nodeBuiltinImport:off - schema hashes use node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { LinxMcpTransportError } from "../persistence/Errors.ts";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOOLS = 200;
const MAX_TOOL_PAGES = 5;
const INITIALIZE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface ExternalMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly schemaHash: string;
}

export interface ExternalMcpCallResult {
  readonly text: string;
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

type TransportError = LinxMcpTransportError;

const transport = (endpoint: string, category: string) =>
  new LinxMcpTransportError({ endpoint, category });

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

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const responseJson = (contentType: string | null, text: string): string =>
  contentType?.includes("text/event-stream") === true
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("")
    : text;

const readLimited = async (response: Response): Promise<string> => {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body-too-large");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

interface RpcEnvelope {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export class ExternalMcpClient extends Context.Service<
  ExternalMcpClient,
  {
    readonly listTools: (
      endpoint: string,
    ) => Effect.Effect<ReadonlyArray<ExternalMcpTool>, TransportError>;
    readonly callTool: (input: {
      readonly endpoint: string;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
    }) => Effect.Effect<ExternalMcpCallResult, TransportError>;
    readonly forget: (endpoint: string) => Effect.Effect<void>;
  }
>()("t3/linx/mcp/ExternalMcpClient") {}

export const layer = Layer.effect(
  ExternalMcpClient,
  Effect.gen(function* () {
    const sessions = yield* Ref.make<ReadonlyMap<string, string | null>>(new Map());

    const post = Effect.fn("ExternalMcpClient.post")(function* (
      endpoint: string,
      body: unknown,
      headers: Readonly<Record<string, string>>,
      timeoutMs: number,
    ) {
      return yield* Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(endpoint, {
              method: "POST",
              headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                ...headers,
              },
              body: JSON.stringify(body),
              redirect: "manual",
              signal,
            }),
          catch: () => transport(endpoint, "network"),
        });
        if (response.status >= 300 && response.status < 400) {
          return yield* transport(endpoint, "redirect");
        }
        const text = yield* Effect.tryPromise({
          try: () => readLimited(response),
          catch: () => transport(endpoint, "response-too-large"),
        });
        return { status: response.status, headers: response.headers, text };
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((error) =>
          error._tag === "TimeoutError" ? transport(endpoint, "timeout") : error,
        ),
      );
    });

    const decodeEnvelope = (endpoint: string, text: string) =>
      Effect.try({
        try: () => JSON.parse(text) as RpcEnvelope,
        catch: () => transport(endpoint, "invalid-json"),
      });

    const openSession = Effect.fn("ExternalMcpClient.openSession")(function* (endpoint: string) {
      const initialized = yield* post(
        endpoint,
        {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "linx-workos", version: "1" },
          },
        },
        {},
        INITIALIZE_TIMEOUT_MS,
      );
      if (initialized.status === 401 || initialized.status === 403) {
        return yield* transport(endpoint, "unauthorized");
      }
      if (initialized.status !== 200) {
        return yield* transport(endpoint, `initialize-http-${initialized.status}`);
      }
      const envelope = yield* decodeEnvelope(
        endpoint,
        responseJson(initialized.headers.get("content-type"), initialized.text),
      );
      if (envelope.error !== undefined) {
        return yield* transport(endpoint, "initialize-rejected");
      }
      const sessionId = initialized.headers.get("mcp-session-id");
      yield* post(
        endpoint,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        INITIALIZE_TIMEOUT_MS,
      );
      return sessionId satisfies string | null;
    });

    const sessionFor = Effect.fn("ExternalMcpClient.sessionFor")(function* (endpoint: string) {
      const existing = (yield* Ref.get(sessions)).get(endpoint);
      if (existing !== undefined) return existing;
      const sessionId = yield* openSession(endpoint);
      yield* Ref.update(sessions, (current) => new Map(current).set(endpoint, sessionId));
      return sessionId;
    });

    const request = Effect.fn("ExternalMcpClient.request")(function* (
      endpoint: string,
      sessionId: string | null,
      id: number,
      method: string,
      params: unknown,
      timeoutMs: number,
    ) {
      const response = yield* post(
        endpoint,
        { jsonrpc: "2.0", id, method, params },
        {
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        timeoutMs,
      );
      return response;
    });

    const listTools = Effect.fn("ExternalMcpClient.listTools")(function* (endpoint: string) {
      const tools: ExternalMcpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        let sessionId = yield* sessionFor(endpoint);
        let response = yield* request(
          endpoint,
          sessionId,
          1,
          "tools/list",
          cursor === undefined ? {} : { cursor },
          REQUEST_TIMEOUT_MS,
        );
        if (response.status === 404) {
          sessionId = yield* openSession(endpoint);
          yield* Ref.update(sessions, (current) => new Map(current).set(endpoint, sessionId));
          response = yield* request(
            endpoint,
            sessionId,
            1,
            "tools/list",
            cursor === undefined ? {} : { cursor },
            REQUEST_TIMEOUT_MS,
          );
        }
        if (response.status === 401 || response.status === 403) {
          return yield* transport(endpoint, "unauthorized");
        }
        if (response.status !== 200) {
          return yield* transport(endpoint, `tools-list-http-${response.status}`);
        }
        const envelope = yield* decodeEnvelope(
          endpoint,
          responseJson(response.headers.get("content-type"), response.text),
        );
        if (envelope.error !== undefined) {
          return yield* transport(endpoint, "tools-list-rejected");
        }
        const result = asRecord(envelope.result);
        const entries = result?.tools;
        if (!Array.isArray(entries)) {
          return yield* transport(endpoint, "tools-list-shape");
        }
        for (const entry of entries) {
          const tool = asRecord(entry);
          if (tool === null) continue;
          const name = typeof tool.name === "string" ? tool.name : null;
          if (name === null || !TOOL_NAME_PATTERN.test(name)) continue;
          if (tools.some((existing) => existing.name === name)) continue;
          const description =
            typeof tool.description === "string" ? tool.description.slice(0, 4096) : "";
          const inputSchema = asRecord(tool.inputSchema) ?? { type: "object", properties: {} };
          const schemaJson = canonicalJson(inputSchema);
          if (schemaJson.length > 64 * 1024) continue;
          tools.push({ name, description, inputSchema, schemaHash: sha256(schemaJson) });
          if (tools.length >= MAX_TOOLS) break;
        }
        const next = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
        if (next === undefined || next === cursor || tools.length >= MAX_TOOLS) break;
        cursor = next;
      }
      return tools;
    });

    const callTool = Effect.fn("ExternalMcpClient.callTool")(function* (input: {
      readonly endpoint: string;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
    }) {
      let sessionId = yield* sessionFor(input.endpoint);
      const send = (session: string | null) =>
        request(
          input.endpoint,
          session,
          1,
          "tools/call",
          { name: input.tool, arguments: input.arguments },
          CALL_TIMEOUT_MS,
        );
      let response = yield* send(sessionId);
      if (response.status === 404) {
        sessionId = yield* openSession(input.endpoint);
        yield* Ref.update(sessions, (current) => new Map(current).set(input.endpoint, sessionId));
        response = yield* send(sessionId);
      }
      if (response.status === 401 || response.status === 403) {
        return yield* transport(input.endpoint, "unauthorized");
      }
      if (response.status !== 200) {
        return yield* transport(input.endpoint, `tools-call-http-${response.status}`);
      }
      const envelope = yield* decodeEnvelope(
        input.endpoint,
        responseJson(response.headers.get("content-type"), response.text),
      );
      if (envelope.error !== undefined) {
        return yield* transport(input.endpoint, "tools-call-rejected");
      }
      const result = asRecord(envelope.result);
      if (result === null) {
        return yield* transport(input.endpoint, "tools-call-shape");
      }
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((part) => {
          const record = asRecord(part);
          return record !== null && typeof record.text === "string" ? record.text : "";
        })
        .join("");
      return {
        text: text.slice(0, 256 * 1024),
        structuredContent: result.structuredContent ?? null,
        isError: result.isError === true,
      } satisfies ExternalMcpCallResult;
    });

    const forget = Effect.fn("ExternalMcpClient.forget")(function* (endpoint: string) {
      yield* Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(endpoint);
        return next;
      });
    });

    return ExternalMcpClient.of({ listTools, callTool, forget });
  }),
);
