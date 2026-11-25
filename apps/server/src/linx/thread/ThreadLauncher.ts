import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { LinxFailure, LinxLaunchThreadInput } from "@t3tools/contracts";

export interface LinxThreadLaunchRequest {
  readonly commandId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly input: LinxLaunchThreadInput;
}

export interface LinxThreadLaunchOutcome {
  readonly resumed: boolean;
  readonly runId: string | null;
}

/** The only T3 launch dependency allowed outside `adapters/t3`. */
export class ThreadLauncher extends Context.Service<
  ThreadLauncher,
  {
    readonly launch: (
      request: LinxThreadLaunchRequest,
    ) => Effect.Effect<LinxThreadLaunchOutcome, LinxFailure>;
  }
>()("t3/linx/thread/ThreadLauncher") {}
