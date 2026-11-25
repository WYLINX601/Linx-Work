import { launchLinxThread } from "@t3tools/client-runtime/operations";
import {
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const linxExperts = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:experts",
  tag: WS_METHODS.linxExpertsList,
  staleTimeMs: 0,
});

export const linxThreadBinding = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:binding",
  tag: WS_METHODS.linxThreadsGetBinding,
  staleTimeMs: 0,
});

export const launchExpertThread = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:launch",
  execute: launchLinxThread,
});
