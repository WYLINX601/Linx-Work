import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { layer as storageLayer } from "./LinxMcpServices.ts";
import { layer as t3ThreadLauncherLayer } from "./adapters/t3/ThreadLauncher.ts";
import { layer as resourcesLayer } from "./persistence/LinxResourceStore.ts";
import { layer as launchLayer } from "./thread/LinxLaunchService.ts";

const resources = Layer.unwrap(
  Effect.map(ServerConfig, (config) => resourcesLayer(config.linxResourceDir)),
);

export const layer = Layer.merge(
  launchLayer.pipe(Layer.provide(t3ThreadLauncherLayer), Layer.provideMerge(storageLayer)),
  resources,
);
