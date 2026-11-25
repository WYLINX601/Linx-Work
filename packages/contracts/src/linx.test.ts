import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { LinxLaunchThreadInput } from "./linx.ts";
import { LinxWsRpcGroup, WS_METHODS, WsRpcGroup } from "./rpc.ts";

it("registers the Linx RPCs on the native WebSocket group", () => {
  for (const method of [
    WS_METHODS.linxExpertsCreateSnapshot,
    WS_METHODS.linxThreadsLaunch,
    WS_METHODS.linxExpertsList,
    WS_METHODS.linxThreadsGetBinding,
  ]) {
    expect(WsRpcGroup.requests.get(method)).toBeDefined();
    expect(WsRpcGroup.requests.get(method)?.payloadSchema).toBe(
      LinxWsRpcGroup.requests.get(method)?.payloadSchema,
    );
  }
});

it("does not accept a client-specified launch identity", () => {
  const input = {
    clientRequestId: "request",
    snapshotId: "snapshot",
    projectId: "project",
    title: "Test",
    modelSelection: { instanceId: "codex", model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: "Hello" },
  };
  const decode = Schema.decodeUnknownSync(LinxLaunchThreadInput);
  expect(decode(input)).toEqual(input);
  expect(decode({ ...input, threadId: "forged", commandId: "forged" })).toEqual(input);
  expect(decode({ ...input, initialMessage: { text: "Hello", messageId: "forged" } })).toEqual(
    input,
  );
});
