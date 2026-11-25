import {
  archiveLinxExpert,
  archiveLinxSkill,
  archiveLinxSuite,
  launchLinxSuite,
  saveLinxSuite,
  disableLinxConnection,
  importLinxSkill,
  launchLinxThread,
  saveLinxConnection,
  saveLinxExpert,
  testLinxConnection,
} from "@t3tools/client-runtime/operations";
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

export const linxExpertDefinitions = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:expert-definitions",
  tag: WS_METHODS.linxExpertsListDefinitions,
  staleTimeMs: 0,
});

export const linxExpertDefinition = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:expert-definition",
  tag: WS_METHODS.linxExpertsGetDefinition,
  staleTimeMs: 0,
});

export const linxSkillPackages = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:skill-packages",
  tag: WS_METHODS.linxSkillsList,
  staleTimeMs: 0,
});

export const linxSuites = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:suites",
  tag: WS_METHODS.linxSuitesList,
  staleTimeMs: 0,
});

export const linxSuiteDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:suite",
  tag: WS_METHODS.linxSuitesGet,
  staleTimeMs: 0,
});

export const linxMcpConnections = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:mcp-connections",
  tag: WS_METHODS.linxConnectionsList,
  staleTimeMs: 0,
});

export const linxMcpConnection = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "web:linx:mcp-connection",
  tag: WS_METHODS.linxConnectionsGet,
  staleTimeMs: 0,
});

export const launchSuiteThread = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:launch-suite",
  execute: launchLinxSuite,
});

export const saveSuite = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:save-suite",
  execute: saveLinxSuite,
});

export const archiveSuite = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:archive-suite",
  execute: archiveLinxSuite,
});

export const launchExpertThread = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:launch",
  execute: launchLinxThread,
});

export const saveExpert = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:save-expert",
  execute: saveLinxExpert,
});

export const archiveExpert = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:archive-expert",
  execute: archiveLinxExpert,
});

export const importSkill = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:import-skill",
  execute: importLinxSkill,
});

export const archiveSkill = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:archive-skill",
  execute: archiveLinxSkill,
});

export const saveConnection = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:save-connection",
  execute: saveLinxConnection,
});

export const testConnection = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:test-connection",
  execute: testLinxConnection,
});

export const disableConnection = createEnvironmentCommand(connectionAtomRuntime, {
  label: "web:linx:disable-connection",
  execute: disableLinxConnection,
});
