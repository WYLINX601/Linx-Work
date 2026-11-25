import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CommandId, type LinxFailure, MessageId, ThreadId } from "@t3tools/contracts";

import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  ThreadLauncher,
  type LinxThreadLaunchOutcome,
  type LinxThreadLaunchRequest,
} from "../../thread/ThreadLauncher.ts";

const isThreadLaunchError = Schema.is(ThreadLaunch.ThreadLaunchError);
const isProviderDisabled = Schema.is(
  ThreadManagement.ThreadManagementProviderInstanceDisabledError,
);

const failure = (code: LinxFailure["code"], message: string, threadId: string): LinxFailure => ({
  code,
  message,
  threadId: ThreadId.make(threadId),
});

export const layer = Layer.effect(
  ThreadLauncher,
  Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const documents = yield* DocumentText.DocumentText;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig.ServerConfig;
    return ThreadLauncher.of({
      launch: Effect.fn("LinxT3ThreadLauncher.launch")(function* (
        request: LinxThreadLaunchRequest,
      ): Effect.fn.Return<LinxThreadLaunchOutcome, LinxFailure> {
        const result = yield* ThreadMessageIntake.launchThread({
          commandId: CommandId.make(request.commandId),
          threadId: ThreadId.make(request.threadId),
          projectId: request.input.projectId,
          title: request.input.title,
          generateTitle: false,
          titleRenamed: true,
          modelSelection: request.input.modelSelection,
          runtimeMode: request.input.runtimeMode,
          interactionMode: request.input.interactionMode,
          workspaceStrategy: request.input.workspaceStrategy,
          initialMessage: {
            messageId: MessageId.make(request.messageId),
            text: request.input.initialMessage.text,
            attachments: [],
          },
          createdBy: "user",
          creationSource: "web",
        }).pipe(
          Effect.mapError((error) =>
            failure(
              isProviderDisabled(error) ? "provider_unavailable" : "launch_failed",
              isProviderDisabled(error)
                ? "The selected provider is unavailable."
                : isThreadLaunchError(error)
                  ? `T3 launch failed during ${error.operation}.`
                  : "T3 launch failed.",
              request.threadId,
            ),
          ),
          Effect.provideService(ThreadLaunch.ThreadLaunchService, launches),
          Effect.provideService(DocumentText.DocumentText, documents),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(ServerConfig.ServerConfig, serverConfig),
        );
        return { resumed: result.resumed, runId: null };
      }),
    });
  }),
);
